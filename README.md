# iKuuu 每日签到

基于 Cloudflare Workers、SQLite Durable Objects 和 Alarm 的每日签到服务。支持持久化调度、失败退避、Cookie 更新恢复以及 SMTP 邮件通知，无需自有域名或常驻服务器。

## 功能

- 每天北京时间 **08:17** 自动签到。
- 首次失败后依次等待 **10、30、100 分钟**，最多四次尝试。
- Cookie 明确失效时停止签到并通知；更新后恢复当天未完成的任务。
- 到期前 24 小时提醒，签到成功后记录领取量和剩余流量。
- 从 `https://ikuuu.win/` 发现并验证候选域名。
- SMTP 通知独立重试，管理页面支持密码登录、恢复码重置、查询状态、更新 Cookie、暂停和恢复。
- GitHub CI 检查与 Cloudflare Workers Builds 自动部署。

## 环境要求

- Node.js **22 或更新版本**、npm 和 Git。
- Cloudflare 账号及可用的 Workers、SQLite Durable Objects 额度。
- 支持 **465 端口、隐式 TLS、AUTH LOGIN** 的 SMTP 邮箱及授权码。

Worker 可使用 Cloudflare 提供的 `workers.dev` 地址。SMTP 使用已有邮箱服务，无需配置 Cloudflare Email Routing。

## 快速开始

### 1. 安装与检查

克隆仓库，在项目根目录执行：

```sh
npm ci
npm run build
npx wrangler login
```

`npm run build` 运行所有测试并检查 Worker 构建；不会部署或调用真实签到接口。

### 2. 部署 Worker

按需要调整 `wrangler.jsonc` 的 Worker 名称，然后执行：

```sh
npm run deploy
```

记录 Wrangler 输出的 HTTPS 地址。配置中的 Worker 名称必须与 Cloudflare Dashboard 中的名称一致。

### 3. 配置邮件与密钥

在项目根目录创建 `smtp.local.json`，使用自己的邮箱配置替换示例：

```json
{
  "host": "smtp.example.com",
  "port": 465,
  "user": "sender@example.com",
  "password": "your-smtp-app-password",
  "to": "recipient@example.com"
}
```

`to` 可省略，默认发送到发件邮箱。`password` 应使用邮箱服务提供的 SMTP 授权码。

```sh
node scripts/upload-secrets.mjs
```

首次执行生成本地 `.migration-secrets.json`，保存恢复码（沿用配置名 `ADMIN_TOKEN`）和 Cookie 加密密钥。已有密钥不会自动替换。

在该文件中加入 `WORKER_URL`，指向上一步的部署地址，再执行一次上传脚本，使通知邮件包含管理入口。示例结构如下，保留生成的真实密钥：

```json
{
  "ADMIN_TOKEN": "generated-admin-token",
  "COOKIE_ENCRYPTION_KEY": "generated-base64-key",
  "WORKER_URL": "https://your-worker.your-subdomain.workers.dev"
}
```

上传脚本通过标准输入写入 Cloudflare Secrets。个人邮箱、授权码和部署地址无需写进仓库。

### 4. 设置登录密码

打开部署地址，使用 `.migration-secrets.json` 中的 `ADMIN_TOKEN` 作为恢复码，首次设置 **6–128 个字符**的密码，再用密码登录。原有部署的管理令牌自动成为恢复码，不再用于日常登录。

忘记密码时，可在登录页面展开恢复入口，用恢复码设置新密码。已登录时可在管理页面输入当前密码修改密码。**修改或重置完成后，所有设备的已登录会话立即失效，需要重新登录；后台签到和邮件调度继续运行。**

CLI 用户也可以交互设置和登录，密码输入不会回显原文：

```sh
node scripts/control.mjs recover
node scripts/control.mjs login
```

恢复码请单独妥善保管；服务不会通过页面显示它。密码只保存带随机盐的派生摘要，结合服务端 Secret 保护。会话最长 7 天，每次管理请求都会检查有效性；网页使用 Secure、HttpOnly、SameSite Cookie。

### 5. 验证并启用签到

```sh
node scripts/control.mjs test-email
node scripts/control.mjs status
```

确认收件箱收到测试邮件，再将网站登录后的完整 Cookie 保存至项目根目录的 `ikuuu-cookie.txt`，执行：

```sh
node scripts/control.mjs cookie
```

也可在已登录的管理页面更新 Cookie。当天尚未签到时会立即执行；以后按照日程运行。

## 配置说明

| 配置 | 存放位置 | 用途 |
| --- | --- | --- |
| Worker 名称、对象绑定、默认域名 | `wrangler.jsonc` | 通用部署配置 |
| `SMTP_HOST`、`SMTP_PORT` | Cloudflare Secret | SMTP 服务器与 TLS 端口 |
| `MAIL_USER`、`MAIL_APP_PASSWORD` | Cloudflare Secret | 发件邮箱及授权码 |
| `NOTIFY_TO` | Cloudflare Secret | 通知收件邮箱 |
| `ADMIN_TOKEN` | Cloudflare Secret | 首次设密及忘记密码时的恢复码 |
| `COOKIE_ENCRYPTION_KEY` | Cloudflare Secret | 32 字节 AES-GCM 密钥的 Base64 |
| `ADMIN_URL` | Cloudflare Secret，可选 | 邮件中的管理入口 |
| Cookie | Durable Object 加密存储 | 网站登录凭证 |
| 密码摘要、会话版本与会话摘要 | Durable Object 的独立认证记录 | 日常登录、会话撤销 |

本地文件仅作为配置来源，不会自动随 Git 推送到云端。修改邮箱或授权码后，重新执行上传脚本。保持 Cookie 加密密钥稳定；丢失或更换后需重新提交 Cookie。

## 自动部署：Workers Builds

在 Cloudflare Dashboard 打开目标 Worker → **Settings → Builds → Connect**，安装 GitHub App 并授权目标仓库，使用以下设置：

| 设置 | 值 |
| --- | --- |
| 生产分支 | `main` |
| 根目录 | `/` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Node.js 版本 | `22`（构建变量 `NODE_VERSION`） |
| Preview builds | 关闭 |

Workers Builds 自动安装依赖，然后运行测试和构建检查；成功后部署生产 Worker。构建失败会保留上一部署。SMTP、恢复码和 Cookie 加密密钥仅保留在运行时 Secrets，不要复制到构建环境。

推送至 `main` 后，在 Dashboard 的 Builds 页面核对提交哈希、构建日志和部署结果。GitHub 的 `Cloudflare checks` 同时检查代码；正式签到由 Durable Object Alarm 调度。

## 运行与维护

CLI 从 `.migration-secrets.json` 读取部署地址和恢复码，从已被 Git 忽略的 `.admin-session.json` 读取登录会话。首次使用、会话到期或密码变更后须执行 `login`。恢复码仅在 `recover` 命令中使用，不可替代会话访问管理接口。

无交互终端时，可临时设置 `ADMIN_PASSWORD`（登录 / 当前密码）、`ADMIN_NEW_PASSWORD`（新密码）环境变量；不要把密码作为命令参数或写入仓库。

| 命令 | 用途 |
| --- | --- |
| `node scripts/control.mjs auth-status` | 查看是否已设置密码 |
| `node scripts/control.mjs login` | 用密码登录并保存本地会话 |
| `node scripts/control.mjs logout` | 注销当前会话 |
| `node scripts/control.mjs recover` | 用恢复码首次设密或重置密码 |
| `node scripts/control.mjs change-password` | 修改密码并撤销全部会话 |
| `node scripts/control.mjs status` | 查看调度、签到与通知状态 |
| `node scripts/control.mjs cookie` | 提交本地 Cookie 文件 |
| `node scripts/control.mjs run` | 请求当天签到，不重置预算 |
| `node scripts/control.mjs pause` | 暂停签到 |
| `node scripts/control.mjs resume` | 恢复签到，保留尝试次数 |
| `node scripts/control.mjs test-email` | 发送测试通知 |
| `npm run deploy` | 手动部署代码 |

从旧实现迁移时，在提交 Cookie **之前**用 `initialize` 导入最新非敏感状态；有凭证后不能覆盖迁移状态。详见 [迁移与架构说明](docs/cloudflare-migration-plan.md)。

### 执行与重试规则

- HTTP 429 遵守 `Retry-After`，等待时间取其与固定退避的较大值；重试不跨北京时间午夜。
- HTTP 403、浏览器挑战、网络失败不会直接判定 Cookie 失效。
- 当天最终失败保留记录并发信，次日仍按日程执行。相同 Cookie、手动运行或暂停恢复不会重置预算。
- 更新不同 Cookie 会启动新凭证版本；当天已签到时不会再次签到。
- 邮件临时失败后等待 **1、5、30 分钟**，最多四次；认证或地址永久错误结束通知任务。
- 剩余流量刷新独立于签到成功状态，读取失败不会重复签到。

### 网络代理

本地无法直连 Cloudflare 时，可使用已有代理。支持环境代理的 Node.js 版本可设置 `HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1`；地址以自己的网络配置为准。本地网络或关机不影响云端 Alarm。

## 安全与限制

- `smtp.local.json`、`.migration-secrets.json`、`.admin-session.json`、`ikuuu-cookie.txt`、`.dev.vars` 已被 Git 忽略。本地凭证与会话应限制文件权限并私密保管。
- 管理接口不返回邮箱授权码、Cookie、密码摘要或恢复码；Cookie 使用 AES-GCM 加密，SMTP 连接使用 TLS。页面不将密码或恢复码写入浏览器存储，会话 Cookie 不可被 JavaScript 读取。
- 同一来源连续 5 次密码或恢复码验证失败后，限制该验证入口 10 分钟。更换 Cloudflare 中的恢复码后须用新恢复码重置密码，Cookie 加密密钥应保持稳定。
- 状态和 Alarm 在同一 SQLite 存储事务中保存；对象串行处理更新、签到与通知。签到和邮件记录保留 90 天，事件保留最近 200 条。
- Alarm 可能因平台维护延迟。外部请求与本地状态不能原子提交，进程中断可能导致重复请求或通知，不承诺端到端恰好一次。
- SMTP 接受不代表最终送达。域名发布页解析依赖当前结构，变化时保留已验证域名。
- Cloudflare 免费额度与账号其他应用共享，以官方计费与限额为准。

## 开发与验证

```sh
npm run test:core
npm run test:runtime
npm run check
```

测试覆盖纯函数、SMTP 协议、真实 Workers 运行时的 SQLite、Alarm、对象驱逐与隔离、密码与恢复码、全部会话撤销、后台调度隔离、退避和域名解析。无需在测试中配置真实邮箱、Cookie 或日常密码。

相关文档：[架构与迁移](docs/cloudflare-migration-plan.md) · [域名实测记录](docs/cloudflare-domain-probe-results.md) · [Workers Builds 官方说明](https://developers.cloudflare.com/workers/ci-cd/builds/)。
