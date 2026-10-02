# 自动登录与 Cookie 更新

用户在 Cloudflare 手动添加 `IKUUU_EMAIL` 和 `IKUUU_PASSWORD` Secrets 后，现有 Worker / SQLite Durable Object / Alarm 承担 Cookie 更新，无需新增服务器或定时服务。网站账户与管理页面账户独立。

## 使用方式

1. 部署包含此功能的代码。
2. 在目标 Worker 的 Settings → Variables and Secrets 中添加两个网站账户 Secret，保存并部署。
3. 登录管理页面，点击“自动登录并更新 Cookie”。CLI 可执行 `node scripts/control.mjs renew-cookie`。
4. 刷新状态，核对“最近自动更新”、Cookie 到期标记及登录提示。网站要求验证时，手动登录网站完成验证后提交 Cookie。

仅添加 Secret 不会唤醒休眠对象。首次读取管理状态会安排首次登录，已有 Cookie 时安排到期前 24 小时更新。已有日常 Alarm 的对象会在后续调度时识别配置。如果改正账户或密码后仍显示停止状态，使用更新按钮重新启动。

移除任一网站账户 Secret 即关闭自动登录，继续使用现有 Cookie 与手动更新流程。暂停签到同时暂停自动登录。

## 登录接口证据与限制

2026-10-02 读取公开页面 `https://ikuuu.top/auth/login`，解码 `originBody` 后核对其 `buildLoginRequest` / `handleLoginResponse`：

- 请求：`POST /auth/login`，表单编码。
- 密码阶段字段：`host`、`phase=password`、`email`、`passwd`、`remember_me=on`、`pageLoadedAt`。
- 新版登录成功：`phase=authenticated`；兼容没有 `phase` 的旧版 `ret=1`。
- 二次验证阶段：`totp`、`email_code`、`reverse_email_verify`。
- 当前页面包含极验 V4，前端要求 `Captcha.isReady()` 并提交 `captcha_result`。

程序只尝试普通密码登录，不构造验证码结果，也不自动提交邮箱验证码或二次验证。是否允许普通密码请求成功由网站服务端决定；**无法仅凭账户密码承诺全自动登录**。服务端要求验证时进入 `manual_required` 并通知；其他密码登录拒绝进入 `invalid_credentials`，都停止自动重试。

登录前先读取登录页面及临时会话 Cookie，POST 使用同一会话，收集多个 `Set-Cookie`，再访问 `/user` 验证账户页。只有验证成功、有合法 `expire_in` 且剩余有效期超过 24 小时的新 Cookie 才替换原凭证，避免错误响应或短有效期造成连续登录。

公开页面抓取证据保存在已忽略的 `.firecrawl/ikuuu-autologin.html` 和 `.firecrawl/ikuuu-autologin-decoded.html`。本次没有使用真实网站账户登录，实际登录成功仍需用户配置 Secrets 后核对管理状态。

## 调度与恢复

- 凭证首次缺失：安排立即登录，成功后启动当天未完成的签到。
- 正常凭证：以 `expire_in - 24 小时` 安排登录。
- 签到明确要求重新登录：阻止继续使用失效 Cookie，把尚未开始的到期更新任务提前到当前时间；已有失败退避仍保留。
- 登录失败：保留旧 Cookie，仍有效时继续使用；独立于签到的登录预算最多四次，网络、限流、服务故障退避 10、30、100 分钟，遵守更长的 `Retry-After`。
- 临时故障耗尽预算：发邮件，等待 24 小时再开启下一轮登录。密码或验证问题立即停止，等待人工处理。
- 网站日常响应更新 Cookie：合并 `Set-Cookie` 并加密存储，更新到期任务；不重置签到预算。
- 自动重新登录：递增凭证版本，但迁移当天签到记录和尝试次数；当天已成功不会重签，同一天已耗尽预算也不会因为自动更新而重新开始。

登录任务、尝试次数、执行中断恢复时间与状态同现有调度一起事务保存。对象驱逐不丢任务；中断执行进入退避，不立即重发登录请求。Alarm 与管理操作使用现有串行队列。外部登录与本地保存不能原子提交，不承诺登录请求恰好一次。

新 Cookie 继续使用现有 AES-GCM 密钥加密。账户密码只从运行时 Secret 读取，不写入调度状态、页面响应或日志。网站返回的自由文本不会直接显示为登录错误，防止接口回显账户凭证。

## 验证

Workers 运行时测试覆盖首次自动登录、提前失效恢复、当天成功与耗尽预算、独立登录退避、验证码与错误密码停止、旧凭证保留、短有效期保护、暂停、中断恢复、对象驱逐、被动 Cookie 更新，以及表单协议和多个 `Set-Cookie` 的解析。

测试使用模拟网站响应，不会向网站发送真实登录、签到请求或邮件。项目统一检查使用 `npm run build`，包含全部测试及 Worker dry-run 构建。
