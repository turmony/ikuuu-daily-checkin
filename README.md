# iKuuu 每日签到 · Cloudflare

使用 Cloudflare Worker + SQLite Durable Object + Alarm，每天北京时间 **08:17** 执行。管理页面使用免费的 `workers.dev` 地址；通知通过现有 126 邮箱的 SMTP 发送，无需购买域名。

当前管理入口：https://ikuuu-daily-checkin.turmony.workers.dev

## 执行规则

- 每日首次尝试失败后，分别等待 **10、30、100 分钟**；最多四次，等待时间从前一次失败算起。
- HTTP 429 时遵守 `Retry-After`，取它与既定等待时间的较大值；重试不跨北京时间午夜。
- 明确的登录失效立即停止签到尝试并通知。HTTP 403、验证码页、超时不能直接判定 Cookie 失效。
- 当天最终失败发送邮件，保留失败记录；次日仍按日程执行。手动立即运行或暂停恢复不能重置当天同一 Cookie 的尝试预算。
- 更新不同 Cookie 后，若当天未签到立即恢复；当天已成功则保留成功状态。相同 Cookie 不会重置尝试次数。
- Cookie 的 `expire_in` 到期前 24 小时安排独立提醒，是否失效仍以实际登录验证为准。
- 成功先持久化，再单独刷新剩余流量；流量读取失败不会重复签到。
- 邮件最多发送四次，失败后等待 **1、5、30 分钟**。邮件重试与签到重试独立。

## 域名发现

网络、域名或服务端错误后的第二次签到尝试，可查询一次 `https://ikuuu.win/`。当前发布页在混淆 JavaScript 中保存域名，使用有预算限制的 Acorn 静态解析器提取日期、主要域名和备用域名，不执行网站 JavaScript。

发布页的在线指示不能证明网站可用。候选域名须先通过不带 Cookie 的登录页验证，再验证账号；失败时保留上次域名。页面结构变化会安全失败。无需向 `find@ikuuu.pro` 发信，也无需 IMAP 或入站邮件。

## 本地与部署

需要 Node.js 22+，使用现有 Wrangler 登录账号：

```powershell
npm ci
npm test
npm run check
npx wrangler login
npm run deploy
```

修改 `wrangler.jsonc` 中的 `account_id`、Worker 名称、`ADMIN_URL` 和收件地址以部署到其他账号。

创建已被 Git 忽略的 `smtp.local.json`：

```json
{
  "host": "smtp.126.com",
  "port": 465,
  "user": "user@example.com",
  "password": "在本地填写邮箱 SMTP 授权码"
}
```

然后上传凭证：

```powershell
node scripts/upload-secrets.mjs
```

首次上传会生成 `.migration-secrets.json`，保存 `ADMIN_TOKEN` 和 `COOKIE_ENCRYPTION_KEY`。已有文件不会自动替换密钥。上传脚本通过标准输入传给 Wrangler，仅输出密钥名称。SMTP 当前仅支持 **465 隐式 TLS + AUTH LOGIN**。

在 `.migration-secrets.json` 中设置 `WORKER_URL`，或通过环境变量 `WORKER_URL`、`ADMIN_TOKEN` 运行 CLI。当前机器的文件已完成配置。管理页面的管理令牌取自该文件的 `ADMIN_TOKEN` 字段，令牌不会保存到浏览器。

```powershell
node scripts/control.mjs status
node scripts/control.mjs test-email
# 首次迁移：在提交 Cookie 前导入最新 GitHub 状态；有凭证后不能覆盖迁移状态。
node scripts/control.mjs initialize .wrangler/migration-state.json
# 完整 Cookie 存入被忽略的 ikuuu-cookie.txt，再提交：
node scripts/control.mjs cookie
node scripts/control.mjs run
node scripts/control.mjs pause
node scripts/control.mjs resume
```

若直连 `workers.dev` 失败，使用现有网络代理。当前本机 Node 24 可读取代理环境变量，例如在同一 PowerShell 会话设置：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NODE_USE_ENV_PROXY = '1'
node scripts/control.mjs status
```

代理端口以实际配置为准；这些设置仅影响本地请求。Cloudflare Alarm 独立运行，无需本机保持开机。

## 凭证保护

- SMTP 授权码、管理令牌和 Cookie 不提交 Git；`smtp.local.json`、`.migration-secrets.json`、`ikuuu-cookie.txt`、`.dev.vars` 已被忽略。
- SMTP 授权码存于 Cloudflare Secret，网站管理接口不会返回它。运行时必须读取它才能认证。
- Cookie 在对象存储中使用 AES-GCM 加密，密钥为 Cloudflare Secret；页面和日志不返回 Cookie。
- 本地配置仍为明文，当前机器已限制 SMTP 和密钥文件的 NTFS 权限。不要同步到公开云盘、截图或贴到聊天中。
- 保管 `.migration-secrets.json` 的私密备份；丢失或更换加密密钥后须重新提交 Cookie。撤销邮箱授权码后需更新本地文件并重新上传。
- 管理令牌等同管理密码。更换令牌需先更新本地密钥文件，再运行上传脚本。

## 存储、测试与边界

单账号固定对象名 `primary-account`，状态通过 SQLite 后端的 KV API 持久化，状态写入与 Alarm 设置在同一事务中。一个 Alarm 总是指向最早待办任务。运行、更新和邮件任务在对象内串行执行；外部请求前持久化中断恢复任务。

近期签到与通知记录保留 90 天，事件保留最近 200 条。Tests 包含 Node 纯函数与 SMTP 协议测试，以及真实 Workers 运行时的 SQLite、RPC、Alarm、对象隔离、对象驱逐、域名静态解析和鉴权测试。

- Alarm 可因平台维护或故障延迟，不能保证秒级准点。
- SMTP 返回接受不等于最终投递；本次迁移测试已由用户确认在 126 收到。
- HTTP POST 后进程崩溃可能导致无法确定是否成功；中断后按既定退避恢复，网站返回已签到视为成功。SMTP 接受后崩溃也可能造成重复通知，不承诺端到端恰好一次。
- 免费额度与账号其他应用共享；本项目日常用量较低，未购买域名或启用付费邮件服务。
- GitHub 只做代码托管和 CI，不再定时签到。旧 workflow 已禁用并删除，新的 `Cloudflare checks` 验证代码。部署当前使用 Wrangler，不依赖 GitHub Secret。

迁移细节见 [方案与实施记录](docs/cloudflare-migration-plan.md)，域名实测证据见 [域名验证记录](docs/cloudflare-domain-probe-results.md)。
