# Cloudflare Durable Object 迁移方案与实施记录

日期：2026-10-02。已采用无自有域名方案：Cloudflare Worker + SQLite Durable Object + Alarm + 126 SMTP。GitHub 保留源码和 CI，正式签到不再依赖 GitHub 定时工作流。

## 1. 架构

```mermaid
flowchart LR
    User[管理页面或本地 CLI] --> Worker[Worker 鉴权接口]
    Worker --> Object[单账号 Durable Object / SQLite]
    Alarm[持久化 Alarm] --> Object
    Object --> Site[iKuuu 账号与签到接口]
    Object --> Domain[ikuuu.win 域名发布页]
    Object --> SMTP[126 SMTP / TLS 465]
    SMTP --> Inbox[user@example.com]
    Object --> Alarm
```

管理页面：https://your-worker.your-subdomain.workers.dev。无需购买域名或配置 Email Routing。因域名发布页已实测可获取主要和备用域名，不保留查询域名的邮件收发，也不配置 IMAP。

SQLite Durable Objects 支持 Workers 免费计划。单账号每天少量 HTTP、存储及 Alarm 调用适合现有免费额度，额度仍与同账号其他应用共享。SMTP 使用已有邮箱账号。

## 2. 调度与退避

北京时间 08:17 首次尝试。普通失败后依次等待 10、30、100 分钟，最多四次。例如请求耗时忽略不计时，连续失败对应约 08:17、08:27、08:57、10:37。使用 Alarm 等待，不持续占用运行实例。

HTTP 429 的 Retry-After 只能延长等待，不能缩短上述间隔。重试截止于当天午夜，最终失败将本日任务置为失败并通知。次日任务独立，仍按 08:17 执行。没有为固定退避添加随机抖动，保留用户确认的时间方案。

Cookie 明确失效时阻止签到，不继续耗尽四次；网络失败、HTTP 403 和浏览器挑战不能作为 Cookie 失效证据。更新不同 Cookie 后验证并递增版本，清除旧凭证的签到和到期任务；当天未签到立即启动新版本任务。相同 Cookie、手动运行和暂停恢复均不重置同版本尝试预算。

到期提醒独立安排在 expire_in 前 24 小时。expire_in 是网站标记，不取代实际登录状态判断。失败通知、失效通知和恢复通知分别去重。当天成功后更新 Cookie 不会再次签到。

后续增加可选的账户自动登录：配置 `IKUUU_EMAIL` / `IKUUU_PASSWORD` Secrets 后，到期前 24 小时尝试换新，明确失效时安排恢复；自动更新迁移当天签到次数，不重置已耗尽预算。登录具有独立退避与失败通知，遇到验证码或二次验证停止自动尝试；未配置账户时沿用上述手动流程。接口证据、配置与限制见 [自动登录与 Cookie 更新](automatic-cookie-renewal.md)。

## 3. 状态、并发和中断恢复

一个实体账号对应一个固定对象，默认名 primary-account。通过 Durable Object RPC 管理。一个持久化 state 包含 encrypted credentials、daily runs、jobs、notices、domain publication、events；使用 SQLite 后端的 KV API。

每次保存将 state 与最早任务对应的 Alarm 放入同一存储事务。只有一个位置决定 Alarm，避免签到、邮件、到期任务相互覆盖。任务在外部请求前持久化四分钟恢复期限；重启发现执行中的签到时将该次尝试记为中断，并按照既定退避继续，不立即免费重放 POST。

Promise 队列串行化管理接口与 Alarm，跨网络等待也保持账号操作顺序。成功先持久化，再独立读取剩余流量。邮件失败不会重新触发签到。运行记录与通知保留 90 天，事件最多 200 条。

平台 Alarm 是至少一次执行，网站 POST 和 SMTP 投递无法与本地事务原子提交。网站返回今日已签到视为成功；SMTP 已接受后不会因连接关闭失败而重发，但若接受后尚未写入状态就崩溃，仍可能重复通知。

## 4. 域名发现

正常签到使用缓存域名。第二次尝试遇到网络、域名或服务端错误时，至多查询一次 ikuuu.win。当前原始 HTML 包含混淆数据；Acorn 仅静态求值允许的节点，有大小和运算预算限制，不使用 eval、Function 或浏览器执行。

实测发布更新时间为 2026-09-11，主要 ikuuu.top，备用 ikuuu.pw。发布页在线指示使用 no-cors 请求，不能当作真实 HTTP 健康证明。候选域名先不携带 Cookie 验证登录页，再验证账号；仅接受 ikuuu.<后缀> 的 HTTPS 地址，不自动携带 Cookie 跟随重定向。

页面混淆方式变更时解析失败，保留已验证域名，并继续原重试预算。此解析器需要随发布页结构维护，不承诺永远兼容。

## 5. SMTP 与凭证安全

通知通过 Cloudflare TCP sockets 连接 smtp.126.com:465，secureTransport=on，使用 AUTH LOGIN。发件和收件均为 user@example.com。用户在本机填写 126 SMTP 授权码，迁移过程不需要聊天传输密码。

邮件最多四次尝试，临时错误后等待 1、5、30 分钟。SMTP 4xx 和连接失败可重试；认证或地址等 5xx 记为永久失败，管理页面显示失败。响应中只保留阶段和状态码，不记录服务器原文、用户名认证载荷或授权码。

SMTP Secret 通过 Wrangler 标准输入上传。Cookie 使用 AES-GCM 加密。原管理令牌仅作恢复码，用于首次设置密码或重置；恢复码验证使用固定长度 SHA-256 摘要的 timingSafeEqual 比较。日常密码使用随机盐、PBKDF2 和服务端 Secret 派生摘要，不保存明文。

认证数据保存于独立的 auth 记录，包含密码摘要、会话版本、会话摘要和失败计数；不会改动签到 state 或 Alarm。密码修改或恢复码重置在一次存储写入中递增版本并清空全部会话。会话最长 7 天，每个管理动作在对象的串行队列中先检查有效性，再执行动作，避免鉴权缓存和检查后改密的竞态。网页使用 Secure、HttpOnly、SameSite Cookie，CLI 使用同样可撤销的会话。恢复码不能直接访问管理接口。

本地 SMTP 与密钥文件被 Git 忽略，并在当前 Windows 机器限制 NTFS 访问权限。它们仍为本地明文；Cloudflare 运行时也必须读取授权码。由此不能声称零泄露风险。撤销授权码可终止旧凭证使用。

## 6. 切换实施与验证

1. 阅读 Cloudflare 官方技能和当前运行时文档，验证 SQLite 事务与 Alarm。
2. 完成 Worker、DO、SMTP、管理页面、CLI 和真实运行时测试；部署到已授权的永久账号。
3. 使用独立测试邮件任务从 Cloudflare 发信。126 SMTP 首次认证投递成功，用户已确认收件。
4. 从 GitHub 在线获取最新状态：currentDomain=ikuuu.top，lastCheckinDate=2026-10-01。
5. 确认没有旧工作流正在运行，导入状态并安全提交本地 Cookie，停用旧 GitHub 调度。停用请求遇到一次网络中断，经本机已有代理重试成功，旧工作流状态最终核对为 disabled_manually。
6. 2026-10-02 云端首次签到成功，领取 1796 MB，剩余 41.08 GB。下次签到已持久化为 2026-10-03 08:17 北京时间。
7. 删除旧 checkin workflow 与 Node/IMAP 入口，添加 Cloudflare checks CI；提交并推送迁移代码。部署验证和 CI 结果见最终迁移说明。

本机直连 workers.dev 出现 DNS 与连接异常，使用已有系统代理 本机代理地址 后管理接口正常。本地网络情况不影响 Cloudflare 侧 Alarm。Wrangler 日志和 Traces 已启用。

## 7. 回滚与维护

如需临时停用，管理接口执行 pause；暂停保留凭证和已完成记录，发送通知任务仍独立运行。部署上一 Worker 版本不会删除 SQLite 数据。避免同时启用两个签到调度器。

旧 GitHub 实现可从迁移前提交 af15728 恢复；恢复前须暂停 Cloudflare、同步最后成功日期并核对邮箱配置。新实现使用 126 SMTP，旧实现默认 Gmail 且包含 IMAP 查询，不应直接复用而不核对。

邮箱授权码轮换：撤销旧授权码，编辑 smtp.local.json，再运行 node scripts/upload-secrets.mjs。日常密码在管理页面修改，忘记密码用原管理令牌恢复；两种操作都会注销全部登录会话，后台调度保持运行。若更换 Secret ADMIN_TOKEN，须使用新恢复码重置密码。保持 COOKIE_ENCRYPTION_KEY 稳定，丢失加密密钥后重新提交 Cookie。

## 官方资料

- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [TCP sockets 与端口限制](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Workers Vitest 集成](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [测试 Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
