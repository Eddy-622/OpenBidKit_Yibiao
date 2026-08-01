const ATOMGIT_API_BASE_URL = 'https://api.atomgit.com/api/v5';

/** 返回 JSON 响应。 */
function json(value, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

/** 编码 AtomGit API 路径参数。 */
function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

/** 规范化 R2 Release 目录前缀。 */
function normalizePrefix(value) {
  return String(value || 'release').trim().replace(/^\/+|\/+$/g, '');
}

/** 根据附件扩展名确定上传内容类型。 */
function contentTypeFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'application/x-yaml';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

/** 校验外部测试请求中的 tag 和单个文件名。 */
function parseUploadInput(value) {
  const tagName = String(value?.tag_name || '').trim();
  const fileName = String(value?.file_name || '').trim();
  if (!/^[0-9A-Za-z._-]{1,100}$/.test(tagName)) {
    throw new Error('tag_name is invalid.');
  }
  if (!fileName || fileName.length > 255 || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) {
    throw new Error('file_name is invalid.');
  }
  return { tagName, fileName };
}

/** 调用 AtomGit API 并统一处理响应。 */
async function atomGitRequest({ owner, repo, token, apiPath, method = 'GET', query = null }) {
  const url = new URL(
    `${ATOMGIT_API_BASE_URL}/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${apiPath}`,
  );
  for (const [name, value] of Object.entries(query || {})) {
    url.searchParams.set(name, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'openbidkit-atomgit-release-worker',
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object'
      ? data?.message || data?.error || data?.msg
      : data;
    throw new Error(
      `AtomGit API ${method} ${apiPath} failed: ${response.status} ${message || response.statusText}`,
    );
  }
  return data;
}

/** 删除目标 Release 中已有的同名附件。 */
async function deleteExistingAsset({ owner, repo, token, tagName, fileName }) {
  const release = await atomGitRequest({
    owner,
    repo,
    token,
    apiPath: `/releases/${encodePathSegment(tagName)}`,
  });
  const assets = (release?.assets || []).filter((asset) => String(asset?.name || '') === fileName);
  for (const asset of assets) {
    if (asset.id === undefined || asset.id === null) {
      throw new Error(`AtomGit attachment ${fileName} does not contain an id.`);
    }
    await atomGitRequest({
      owner,
      repo,
      token,
      apiPath: `/releases/${encodePathSegment(tagName)}/attach_files/${encodePathSegment(asset.id)}`,
      method: 'DELETE',
    });
  }
  return assets.length;
}

/** 获取 AtomGit 单文件预签名上传地址和请求头。 */
async function getUploadTarget({ owner, repo, token, tagName, fileName }) {
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
  return upload;
}

/** 将 R2 对象以固定长度流式上传到 AtomGit 预签名地址。 */
async function uploadR2Object({ object, fileName, upload }) {
  const uploadUrl = new URL(upload.url);
  if (uploadUrl.protocol !== 'https:') {
    throw new Error(`Unsupported AtomGit upload protocol: ${uploadUrl.protocol}`);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(upload.headers || {})) {
    if (name.toLowerCase() === 'content-length') continue;
    headers.set(name, Array.isArray(value) ? value.join(',') : String(value));
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', object.httpMetadata?.contentType || contentTypeFromFileName(fileName));
  }

  const { readable, writable } = new FixedLengthStream(object.size);
  const startedAt = Date.now();
  const streamPromise = object.body.pipeTo(writable).then(
    () => {
      const result = { ok: true, durationMs: Date.now() - startedAt };
      console.log('[atomgit-release-test] upload stream settled', result);
      return result;
    },
    (error) => {
      const result = {
        ok: false,
        durationMs: Date.now() - startedAt,
        message: error?.message || String(error),
      };
      console.error('[atomgit-release-test] upload stream settled', result);
      return result;
    },
  );
  const fetchPromise = fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body: readable,
  }).then(
    (response) => {
      const result = {
        ok: true,
        durationMs: Date.now() - startedAt,
        status: response.status,
        response,
      };
      console.log('[atomgit-release-test] upload fetch settled', {
        ok: result.ok,
        durationMs: result.durationMs,
        status: result.status,
      });
      return result;
    },
    (error) => {
      const result = {
        ok: false,
        durationMs: Date.now() - startedAt,
        message: error?.message || String(error),
      };
      console.error('[atomgit-release-test] upload fetch settled', result);
      return result;
    },
  );
  const [fetchResult, streamResult] = await Promise.all([fetchPromise, streamPromise]);
  const diagnostics = {
    fetch: fetchResult.ok
      ? { ok: true, durationMs: fetchResult.durationMs, status: fetchResult.status }
      : fetchResult,
    stream: streamResult,
  };

  if (!fetchResult.ok) {
    const error = new Error(`AtomGit attachment upload connection failed: ${fetchResult.message}`);
    error.uploadDiagnostics = diagnostics;
    throw error;
  }

  const response = fetchResult.response;
  const responseText = await response.text();
  if (!response.ok) {
    const error = new Error(
      `AtomGit attachment upload failed: ${response.status} ${responseText || response.statusText}`,
    );
    error.uploadDiagnostics = diagnostics;
    throw error;
  }
  return { status: response.status, uploadHost: uploadUrl.hostname, diagnostics };
}

/** 执行一次指定 R2 对象到 AtomGit Release 的上传测试。 */
async function handleUpload(request, env) {
  if (!env.ATOMGIT_ACCESS_TOKEN) {
    return json({ ok: false, message: 'ATOMGIT_ACCESS_TOKEN is not configured.' }, { status: 500 });
  }
  const authorization = request.headers.get('Authorization') || '';
  if (authorization !== `Bearer ${env.ATOMGIT_ACCESS_TOKEN}`) {
    const hasBearerPrefix = authorization.startsWith('Bearer ');
    return json({
      ok: false,
      message: 'unauthorized',
      authorizationPresent: Boolean(authorization),
      hasBearerPrefix,
      providedTokenLength: hasBearerPrefix ? authorization.slice(7).length : 0,
      expectedTokenLength: String(env.ATOMGIT_ACCESS_TOKEN).length,
    }, { status: 401 });
  }

  let input;
  try {
    input = parseUploadInput(await request.json());
  } catch (error) {
    return json({ ok: false, message: error?.message || String(error) }, { status: 400 });
  }

  const owner = String(env.ATOMGIT_OWNER || '').trim();
  const repo = String(env.ATOMGIT_REPO || '').trim();
  const prefix = normalizePrefix(env.R2_RELEASE_PREFIX);
  const objectKey = prefix ? `${prefix}/${input.fileName}` : input.fileName;
  const object = await env.RELEASE_BUCKET.get(objectKey);
  if (!object) {
    return json({ ok: false, message: `R2 object not found: ${objectKey}` }, { status: 404 });
  }

  const startedAt = Date.now();
  console.log('[atomgit-release-test] upload started', {
    tagName: input.tagName,
    fileName: input.fileName,
    objectKey,
    size: object.size,
    colo: request.cf?.colo || '',
  });

  let stage = 'delete_existing_asset';
  let uploadHost = '';
  try {
    const deletedAssets = await deleteExistingAsset({
      owner,
      repo,
      token: env.ATOMGIT_ACCESS_TOKEN,
      tagName: input.tagName,
      fileName: input.fileName,
    });
    stage = 'get_upload_target';
    const upload = await getUploadTarget({
      owner,
      repo,
      token: env.ATOMGIT_ACCESS_TOKEN,
      tagName: input.tagName,
      fileName: input.fileName,
    });
    uploadHost = new URL(upload.url).hostname;
    stage = 'upload_object';
    const result = await uploadR2Object({ object, fileName: input.fileName, upload });
    const durationMs = Date.now() - startedAt;
    const averageMiBPerSecond = durationMs > 0
      ? object.size / 1024 / 1024 / (durationMs / 1000)
      : 0;
    const response = {
      ok: true,
      tagName: input.tagName,
      fileName: input.fileName,
      objectKey,
      size: object.size,
      deletedAssets,
      workerColo: request.cf?.colo || '',
      uploadHost: result.uploadHost,
      uploadStatus: result.status,
      uploadDiagnostics: result.diagnostics,
      durationMs,
      averageMiBPerSecond: Number(averageMiBPerSecond.toFixed(2)),
    };
    console.log('[atomgit-release-test] upload completed', response);
    return json(response);
  } catch (error) {
    const response = {
      ok: false,
      tagName: input.tagName,
      fileName: input.fileName,
      objectKey,
      size: object.size,
      workerColo: request.cf?.colo || '',
      stage,
      uploadHost,
      durationMs: Date.now() - startedAt,
      message: error?.message || String(error),
      uploadDiagnostics: error?.uploadDiagnostics || null,
    };
    console.error('[atomgit-release-test] upload failed', response);
    return json(response, { status: 502 });
  }
}

export default {
  /** 提供健康检查和单文件上传测试接口。 */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'openbidkit-atomgit-release-test' });
    }
    if (request.method === 'POST' && url.pathname === '/upload') {
      return handleUpload(request, env);
    }
    return json({ ok: false, message: 'not found' }, { status: 404 });
  },
};
