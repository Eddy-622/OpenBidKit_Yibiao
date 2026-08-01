# AtomGit Release 单文件中转测试

该 Worker 用于验证 `Cloudflare R2 -> Cloudflare Worker -> AtomGit Release` 大文件上传链路，只上传手动指定的一份现有 R2 对象，不执行客户端打包，也不遍历其他 Release 附件。

## GitHub 配置

运行 `.github/workflows/sync-existing-atomgit-release.yml` 的 `r2_single_asset` 模式前，需要增加以下 Actions Secret：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署 Worker、读取 Workers 子域名；需要 Workers Scripts 编辑和 R2 绑定权限 |

工作流复用已有配置：

- Secret `R2_ACCOUNT_ID`：作为 Cloudflare Account ID。
- Secret `ATOMGIT_ACCESS_TOKEN`：部署为 Worker Secret，仅用于调用 AtomGit API。
- `release-sync/worker/wrangler.jsonc` 中的 `ATOMGIT_OWNER`、`ATOMGIT_REPO`：目标 AtomGit 仓库。
- R2 Bucket `openbidkit`，对象目录默认为 `release/`。

工作流每次执行都会生成新的临时 Worker 调用令牌，部署 Worker 后只调用一次 `/upload`。默认测试文件为 `release/Yibiao-2.23.10-mac-arm64.dmg`。

Worker 使用 `FixedLengthStream` 保持准确的 `Content-Length`，全程流式转发，不把安装包读入 Worker 内存。成功响应会返回 Worker 机房、AtomGit 上传域名、总耗时和平均速度。
