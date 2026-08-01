import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';
const TAG_SYNC_TIMEOUT_SECONDS = 600;
const TAG_SYNC_POLL_INTERVAL_SECONDS = 10;
const ASSET_UPLOAD_MAX_ATTEMPTS = 3;
const ASSET_UPLOAD_RETRY_DELAY_SECONDS = 10;
const ASSET_UPLOAD_CHUNK_SIZE = 1024 * 1024;
const ASSET_UPLOAD_IDLE_TIMEOUT_SECONDS = 300;
const ASSET_UPLOAD_TOTAL_TIMEOUT_SECONDS = 20 * 60;
const ASSET_UPLOAD_PROGRESS_INTERVAL_SECONDS = 15;

/** 读取必填环境变量。 */
function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

/** 编码 AtomGit API 路径参数。 */
function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

/** 等待指定时长。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 将字节数格式化为便于阅读的 MiB。 */
function formatFileSize(bytes) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MiB`;
}

/** 将上传速度格式化为便于阅读的单位。 */
function formatTransferRate(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MiB/s`;
  }
  return `${(value / 1024).toFixed(1)} KiB/s`;
}

/** 根据 Release 附件扩展名补充上传内容类型。 */
function contentTypeFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'application/x-yaml';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

/** 不改变 AtomGit 返回的请求头名称，仅按大小写不敏感规则设置值。 */
function setRequestHeader(headers, name, value) {
  const existingName = Object.keys(headers)
    .find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  headers[existingName || name] = String(value);
}

/** 判断请求头是否已由 AtomGit 预签名接口提供。 */
function hasRequestHeader(headers, name) {
  return Object.keys(headers)
    .some((headerName) => headerName.toLowerCase() === name.toLowerCase());
}

/** 展开错误及其 cause，便于定位底层网络错误。 */
function formatError(error) {
  const messages = [];
  let current = error;
  while (current) {
    const message = current?.message || String(current);
    const code = current?.code ? ` (${current.code})` : '';
    messages.push(`${message}${code}`);
    current = current?.cause;
  }
  return messages.join(' <- ');
}

/** 读取 GitHub Release 元数据。 */
async function readGithubRelease(releaseJsonPath, tagName) {
  const raw = await fs.readFile(releaseJsonPath, 'utf-8');
  const release = JSON.parse(raw);
  if (!release.tagName && !release.tag_name) {
    release.tagName = tagName;
  }
  return release;
}

/** 获取需要同步的全部 GitHub Release 附件。 */
async function listAssetFiles(assetsDir) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(assetsDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (files.length === 0) {
    throw new Error(`No release assets found in ${assetsDir}.`);
  }
  return files;
}

/** 调用 AtomGit Release API 并统一处理响应。 */
async function atomGitRequest({
  owner,
  repo,
  token,
  apiPath,
  method = 'GET',
  query = null,
  body = null,
  allow404 = false,
}) {
  const url = new URL(
    `${ATOMGIT_API_BASE_URL}/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${apiPath}`,
  );
  url.searchParams.set('access_token', token);
  for (const [name, value] of Object.entries(query || {})) {
    url.searchParams.set(name, String(value));
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'yibiao-release-sync',
  };
  const options = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (allow404 && response.status === 404) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof data === 'object'
      ? data?.message || data?.error || data?.msg
      : data;
    throw new Error(
      `AtomGit API ${method} ${apiPath} failed: ${response.status} ${message || response.statusText}`,
    );
  }
  return data;
}

/** 检查 AtomGit 镜像中是否已有目标 tag。 */
async function hasAtomGitTag({ owner, repo, token, tagName }) {
  for (let page = 1; page <= 10; page += 1) {
    const tags = await atomGitRequest({
      owner,
      repo,
      token,
      apiPath: '/tags',
      query: { page, per_page: 100 },
    });
    if (!Array.isArray(tags) || tags.length === 0) {
      return false;
    }
    if (tags.some((tag) => tag?.name === tagName)) {
      return true;
    }
    if (tags.length < 100) {
      return false;
    }
  }
  return false;
}

/** 等待仓库镜像完成目标 tag 同步。 */
async function waitForAtomGitTag({ owner, repo, token, tagName }) {
  const deadline = Date.now() + TAG_SYNC_TIMEOUT_SECONDS * 1000;
  while (Date.now() <= deadline) {
    if (await hasAtomGitTag({ owner, repo, token, tagName })) {
      console.log(`AtomGit tag is ready: ${tagName}`);
      return;
    }
    console.log(`Waiting for AtomGit tag: ${tagName}`);
    await sleep(TAG_SYNC_POLL_INTERVAL_SECONDS * 1000);
  }
  throw new Error(`AtomGit tag ${tagName} was not found after ${TAG_SYNC_TIMEOUT_SECONDS} seconds.`);
}

/** 根据 tag 查询已有 AtomGit Release。 */
async function getAtomGitReleaseByTag({ owner, repo, token, tagName }) {
  return atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
    allow404: true,
  });
}

/** 创建新的 AtomGit Release。 */
async function createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const release = await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: '/releases',
    method: 'POST',
    body: {
      tag_name: tagName,
      name,
      body,
      release_status: releaseStatus,
    },
  });
  console.log(`Created AtomGit Release: ${tagName}`);
  return release;
}

/** 更新已有 AtomGit Release。 */
async function updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const release = await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
    method: 'PATCH',
    body: {
      name,
      body,
      release_status: releaseStatus,
    },
  });
  console.log(`Updated AtomGit Release: ${tagName}`);
  return release;
}

/** 创建或更新 Release，并保留更新前的附件清单。 */
async function publishAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus }) {
  const existingRelease = await getAtomGitReleaseByTag({ owner, repo, token, tagName });
  if (existingRelease) {
    await updateAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
    return existingRelease;
  }
  await createAtomGitRelease({ owner, repo, token, tagName, name, body, releaseStatus });
  return null;
}

/** 删除需要被本次同步覆盖的同名旧附件。 */
async function deleteReplacedAssets({ owner, repo, token, tagName, existingRelease, assetFiles }) {
  const targetNames = new Set(assetFiles.map((filePath) => path.basename(filePath)));
  const replacedAssets = (existingRelease?.assets || [])
    .filter((asset) => targetNames.has(String(asset?.name || '')));

  for (const asset of replacedAssets) {
    if (asset.id === undefined || asset.id === null) {
      throw new Error(`AtomGit attachment ${asset.name} does not contain an id.`);
    }
    await atomGitRequest({
      owner,
      repo,
      token,
      apiPath: `/releases/${encodePathSegment(tagName)}/attach_files/${encodePathSegment(asset.id)}`,
      method: 'DELETE',
    });
    console.log(`Deleted existing AtomGit attachment: ${asset.name}`);
  }
}

/** 通过原生 HTTPS 分块上传文件，并限制连接空闲及单次上传时长。 */
function uploadFileByHttps({ uploadUrl, uploadHeaders, filePath, fileSize }) {
  const target = new URL(uploadUrl);
  if (target.protocol !== 'https:') {
    throw new Error(`Unsupported AtomGit upload protocol: ${target.protocol}`);
  }
  const fileName = path.basename(filePath);
  const headers = {};
  for (const [name, value] of Object.entries(uploadHeaders || {})) {
    headers[name] = Array.isArray(value) ? value.join(',') : String(value);
  }
  if (!hasRequestHeader(headers, 'Content-Type')) {
    setRequestHeader(headers, 'Content-Type', contentTypeFromFileName(fileName));
  }
  setRequestHeader(headers, 'Content-Length', fileSize);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let uploadedBytes = 0;
    let lastLoggedBytes = 0;
    let lastLoggedAt = startedAt;
    let uploadFinished = false;
    let settled = false;

    const fileStream = createReadStream(filePath, { highWaterMark: ASSET_UPLOAD_CHUNK_SIZE });
    const request = httpsRequest(target, {
      method: 'PUT',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('error', fail);
      response.on('aborted', () => {
        const error = new Error(`AtomGit upload response was aborted for ${fileName}.`);
        error.code = 'ATOMGIT_UPLOAD_RESPONSE_ABORTED';
        fail(error);
      });
      response.on('end', () => {
        succeed({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const progressTimer = setInterval(() => {
      const now = Date.now();
      if (uploadFinished) {
        const waitingSeconds = Math.round((now - lastLoggedAt) / 1000);
        console.log(
          `Waiting for AtomGit upload response: ${fileName}, ${waitingSeconds}s since file transfer completed.`,
        );
        return;
      }

      const intervalSeconds = Math.max((now - lastLoggedAt) / 1000, 0.001);
      const intervalBytes = uploadedBytes - lastLoggedBytes;
      const percent = fileSize > 0 ? uploadedBytes * 100 / fileSize : 100;
      console.log(
        `AtomGit upload progress: ${fileName} ${formatFileSize(uploadedBytes)}/${formatFileSize(fileSize)} `
        + `(${percent.toFixed(1)}%), ${formatTransferRate(intervalBytes / intervalSeconds)}.`,
      );
      lastLoggedBytes = uploadedBytes;
      lastLoggedAt = now;
    }, ASSET_UPLOAD_PROGRESS_INTERVAL_SECONDS * 1000);

    const totalTimeout = setTimeout(() => {
      const error = new Error(
        `AtomGit upload exceeded ${ASSET_UPLOAD_TOTAL_TIMEOUT_SECONDS} seconds for ${fileName}.`,
      );
      error.code = 'ATOMGIT_UPLOAD_TOTAL_TIMEOUT';
      request.destroy(error);
    }, ASSET_UPLOAD_TOTAL_TIMEOUT_SECONDS * 1000);

    /** 清理单次上传使用的计时器。 */
    function cleanup() {
      clearInterval(progressTimer);
      clearTimeout(totalTimeout);
    }

    /** 结束本次上传并返回响应。 */
    function succeed(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    /** 终止文件读取并返回可重试错误。 */
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      fileStream.destroy();
      reject(error);
    }

    request.setTimeout(ASSET_UPLOAD_IDLE_TIMEOUT_SECONDS * 1000, () => {
      const error = new Error(
        `AtomGit upload was idle for ${ASSET_UPLOAD_IDLE_TIMEOUT_SECONDS} seconds: ${fileName}.`,
      );
      error.code = 'ATOMGIT_UPLOAD_IDLE_TIMEOUT';
      request.destroy(error);
    });
    request.on('error', fail);
    request.on('finish', () => {
      uploadFinished = true;
      lastLoggedAt = Date.now();
      console.log(
        `Finished sending AtomGit attachment: ${fileName} in `
        + `${((lastLoggedAt - startedAt) / 1000).toFixed(1)}s; waiting for response.`,
      );
    });

    fileStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
    });
    fileStream.on('error', (error) => request.destroy(error));
    fileStream.pipe(request);
  });
}

/** 使用 AtomGit 返回的预签名地址上传单个附件。 */
async function uploadAsset({ owner, repo, token, tagName, filePath }) {
  const fileName = path.basename(filePath);
  const { size: fileSize } = await fs.stat(filePath);

  for (let attempt = 1; attempt <= ASSET_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    console.log(
      `Uploading AtomGit attachment: ${fileName} (${formatFileSize(fileSize)}), attempt ${attempt}/${ASSET_UPLOAD_MAX_ATTEMPTS}.`,
    );

    try {
      const upload = await atomGitRequest({
        owner,
        repo,
        token,
        apiPath: `/releases/${encodePathSegment(tagName)}/upload_url`,
        query: { file_name: fileName },
      });

      if (!upload?.url) {
        throw new Error(`AtomGit did not return an upload URL for ${fileName}.`);
      }

      const response = await uploadFileByHttps({
        uploadUrl: upload.url,
        uploadHeaders: upload.headers,
        filePath,
        fileSize,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `AtomGit attachment upload failed: ${response.status} ${response.text || response.statusText}`,
        );
      }

      console.log(`Uploaded AtomGit attachment: ${fileName}`);
      return;
    } catch (error) {
      console.error(`AtomGit attachment upload error for ${fileName}: ${formatError(error)}`);
      if (attempt === ASSET_UPLOAD_MAX_ATTEMPTS) {
        throw new Error(`Failed to upload AtomGit attachment after ${attempt} attempts: ${fileName}`, {
          cause: error,
        });
      }
      await sleep(ASSET_UPLOAD_RETRY_DELAY_SECONDS * attempt * 1000);
    }
  }
}

/** 执行完整的 AtomGit Release 同步。 */
async function main() {
  const token = requireEnv('ATOMGIT_ACCESS_TOKEN');
  const owner = requireEnv('ATOMGIT_OWNER');
  const repo = requireEnv('ATOMGIT_REPO');
  const tagName = requireEnv('TAG_NAME');
  const assetsDir = requireEnv('RELEASE_ASSETS_DIR');
  const releaseJsonPath = requireEnv('GITHUB_RELEASE_JSON');

  const githubRelease = await readGithubRelease(releaseJsonPath, tagName);
  const assetFiles = await listAssetFiles(assetsDir);
  const releaseName = String(githubRelease.name || githubRelease.tagName || tagName);
  const releaseBody = String(githubRelease.body || '');
  const releaseStatus = githubRelease.isPrerelease ? 'pre' : 'latest';

  await waitForAtomGitTag({ owner, repo, token, tagName });
  const existingRelease = await publishAtomGitRelease({
    owner,
    repo,
    token,
    tagName,
    name: releaseName,
    body: releaseBody,
    releaseStatus,
  });
  await deleteReplacedAssets({ owner, repo, token, tagName, existingRelease, assetFiles });

  console.log(`Uploading ${assetFiles.length} AtomGit Release attachments.`);
  for (const filePath of assetFiles) {
    await uploadAsset({ owner, repo, token, tagName, filePath });
  }

  console.log(`AtomGit Release published: ${owner}/${repo}@${tagName}`);
}

main().catch((error) => {
  console.error(error?.stack || formatError(error));
  if (error?.cause) {
    console.error(`Caused by: ${formatError(error.cause)}`);
  }
  process.exit(1);
});
