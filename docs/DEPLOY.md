# 部署与更新

## 1. 准备自己拥有的服务

- GitHub 仓库：Fork 或 **Use this template**。默认分支使用 `main`；若改名，请同步修改 workflow 的 `push.branches` 和部署条件。
- Garmin Personal API Key：从 [Garmin 官方入口](https://developer.garmin.com/gc-developer-program/personal/personal-api/) 按账号资格申请/生成。中国区账号选择 `cn`，全球区选择 `global`。两者不能互换；本项目不代办资格。
- Cloudflare 账号：在 **Workers & Pages** 设置自己的 `workers.dev` 子域名，并记录 Account ID。
- OAuth KV：在 **Storage & databases → KV** 创建一个 namespace，例如 `garmin-personal-oauth`，记录其 ID。只创建一次；以后部署继续使用同一个 ID，否则现有授权和客户端注册会丢失。

## 2. 创建限权 Cloudflare API Token

在 Cloudflare **My Profile → API Tokens → Create Token** 创建 Custom Token，限制到准备部署的账号：

| 权限 | 用途 |
|---|---|
| Account → Workers Scripts → Edit | 发布 Worker 和 Worker Secrets |
| Account → Workers KV Storage → Edit | 访问部署所绑定的 OAuth KV |
| Account → Account Settings → Read | Wrangler 获取账号信息 |

默认使用 `workers.dev`，不需要 Zone/DNS 权限。若使用自定义域名，先在 Cloudflare 将域名路由绑定到该 Worker；代码不会替你修改 DNS 或现有域名。API Token 的适用权限仍以 Cloudflare 当前控制台为准。

不要使用 Global API Key，不要把本机 Wrangler OAuth 登录 token 放入 GitHub。API Token 设置到期时间后，记得更新 Secret 并运行部署。该权限范围可以影响账号内其他 Worker；专用账号可以缩小影响面。

## 3. 填写 GitHub Secrets 与 Variables

进入自己的仓库 **Settings → Secrets and variables → Actions**。

### Secrets 标签

| Secret | 必填 | 说明 |
|---|---|---|
| `GARMIN_PERSONAL_API_KEY` | 是 | Garmin 生成的 `GCDC_…` Personal API Key |
| `OWNER_LOGIN_KEY` | 是 | 独立随机授权口令，32–256 位 base64url 或十六进制字符；保存到密码管理器 |
| `CLOUDFLARE_API_TOKEN` | 是 | 上一步的部署 Token |
| `MCP_ACCESS_TOKEN` | 否 | 只在启用静态 Bearer 时需要，独立随机生成，不复用授权口令 |

可以用密码管理器生成 48 位随机字母数字口令。不要把口令写到代码、Issue、workflow 输入框或普通 Variables。GitHub 保存后无法读回，自己保留在密码管理器中。

### Variables 标签

| Variable | 必填 | 示例 / 默认值 |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 自己的 32 位账号 ID |
| `OAUTH_KV_ID` | 是 | 自己的 32 位 KV namespace ID |
| `WORKER_NAME` | 是 | `my-garmin-mcp`；3–63 位小写字母、数字、连字符，以字母开头，不以连字符结尾 |
| `PUBLIC_ORIGIN` | 是 | `https://my-garmin-mcp.YOUR-SUBDOMAIN.workers.dev`，不带 `/mcp`，不得包含查询参数 |
| `DEPLOY_ENABLED` | 是 | `true` 才执行部署；否则仅运行检查 |
| `GARMIN_REGION` | 否 | `cn`（默认）或 `global` |
| `AUTH_VERSION` | 否 | `1`（默认），需要让全部旧 OAuth 授权失效时递增 |
| `ENABLE_STATIC_TOKEN` | 否 | `false`（默认）；其他客户端需要 Bearer 时设 `true` |

为了保护生产 Secrets，可额外创建 `production` Environment，添加人工审核和仅允许 `main` 部署的分支规则。也可以将 Secrets 放到该 Environment 下。`DEPLOY_ENABLED` 保留为 repository Variable，因为它决定部署 job 是否启动。

## 4. 运行部署

1. 打开 Actions；Fork 首次使用时启用 workflows。
2. 选择 **Check and deploy → Run workflow → main**。
3. `check` 运行类型检查、Workers/OAuth 测试、部署脚本测试、公开文件扫描、依赖审计和构建。
4. `deploy` 使用 GitHub Secrets，将代码和 Worker Secrets 一起发布。密钥不会进入普通 Worker vars 或仓库。
5. 自动验证公开发现文档和未授权请求的 401。打开 `PUBLIC_ORIGIN`，首页会显示可复制的连接信息。

不要把 Actions 自动通过理解为 Garmin Key 已验真。第一次实际连接后让客户端先调用 `garmin_status`，然后读取一个你确定有记录的日期，才能确认数据链路。

## 5. 连接 ChatGPT

在 ChatGPT 自定义 MCP / 插件入口填入首页显示的 `/mcp` 地址，认证选择 **OAuth**，使用 **CIMD** 或自动注册，Client ID 和 Client Secret 留空。授权页输入 `OWNER_LOGIN_KEY`，确认返回域名为 `chatgpt.com` 后同意。

OAuth 客户端的 Secret 与本项目的 GitHub Secrets 不是一回事。无需把 Garmin Key 填进 ChatGPT。若界面没有自定义 MCP 入口，检查账号/工作区是否开放该功能；具体界面见 [OpenAI 官方文档](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

## 其他 MCP 客户端

OAuth 回调目前仅允许已知 ChatGPT 路径，没有承诺兼容所有客户端 OAuth。支持远程 Streamable HTTP 和自定义请求头的 WorkBuddy 等客户端可使用独立 Bearer：

1. GitHub 添加 Secret `MCP_ACCESS_TOKEN`，设 Variable `ENABLE_STATIC_TOKEN=true`，重新运行部署。
2. MCP URL 使用自己的 `https://…/mcp`。
3. 请求头使用 `Authorization: Bearer <独立 MCP_ACCESS_TOKEN>`。
4. [JSON 示例](../examples/workbuddy.remote-mcp.json) 中的变量展开方式取决于客户端；有些客户端需要在其安全凭据界面填写，不会自动展开 `${…}`。

启用后这个 Token 可以独立读取主人的数据，默认没有过期时间。无需 Bearer 时将 `ENABLE_STATIC_TOKEN=false` 并重新部署；即使旧 Secret 仍保留在 Cloudflare 中，访问也会被禁用。

Responses API 的调用方可参考 [示例](../examples/openai.responses.mjs)，由自己的服务安全保存 Token，保留工具调用审批。

## 更新代码、Key 与撤销授权

- **更新代码：** 审查上游变更后 Sync fork / 合并到 `main`。检查通过后自动部署。不建议对包含 Secrets 的仓库自动合并未知上游变更。
- **更新 Garmin Key：** 修改 GitHub Secret `GARMIN_PERSONAL_API_KEY`，再手动 Run workflow。**修改 Secret 本身不触发 GitHub Actions。** 不需要修改源码，也不必同时手动改 Cloudflare Secret。
- **更新授权口令：** 修改 `OWNER_LOGIN_KEY` 并运行部署。这只影响新授权，不撤销已签发的 OAuth 令牌。
- **让所有旧 OAuth 授权失效：** 将 `AUTH_VERSION` 从 `1` 改成 `2`，然后递增，部署后重新连接。不要恢复旧版本号，否则旧凭据可能重新被接受。静态 Token 另行禁用或轮换。
- **切换 Garmin 账号：** 新 Key、授权口令、静态 Token 一起更新，递增 `AUTH_VERSION` 后再部署，避免原客户端读取新账号。
- **回滚代码：** 优先在 GitHub revert 相关提交后重新部署，保留当前 Secrets、KV ID 和递增后的授权版本。Cloudflare 历史版本回滚可能恢复旧 Secrets/vars；尤其不能恢复已撤销的 `AUTH_VERSION`。发生泄露时先禁用 Worker 路由。

## 排错

| 现象 | 检查 |
|---|---|
| `deploy` 显示 skipped | Repository Variable `DEPLOY_ENABLED=true`，且当前分支是 main |
| 配置校验失败 | Account/KV ID、Worker 名、HTTPS origin 和域名中的 Worker 名是否匹配 |
| Cloudflare 认证失败 | 专用 API Token 权限、适用账号和有效期；不要填 Garmin Key |
| 首页可以打开，但 `/mcp` 401 | 直接匿名访问的正常结果；需客户端 OAuth 或启用的 Bearer |
| `/mcp` 503 | 必需 Secrets、区域、授权版本或启用的静态 Token 未正确配置 |
| OAuth 授权页 401 | 使用个人授权口令，不是 Garmin Key |
| 429 | 依照 Retry-After 等待；授权接口按 IP 限流，MCP 按部署主人限流 |
| `GARMIN_AUTH` | Garmin Key 无效/到期，或 cn/global 与账号不匹配 |
| `GARMIN_TLS` / 526 | Worker 到佳明上游 TLS 故障；不要关闭证书校验 |
| 没有某天数据 | 确认手表已同步、日期和设备能力；缺数据不能当作零 |

排错时只分享工具名称、HTTP 状态和错误代号。不要上传原始 OAuth 回调 URL、日志、请求头或健康响应。
