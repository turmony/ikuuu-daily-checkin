# iKuuu 每日签到

GitHub Actions 每天北京时间 08:17 触发一次，调度延迟也会正常签到。当天已由工具完成时直接结束；网站返回“今日已签到”也视为成功。每次尝试先验证 Cookie，再签到。Cookie 明确失效时立即停止重试并发送失败邮件；其他失败依次等待 10、30、100 分钟重试，最多尝试四次。最终失败发送一封通知邮件并以失败状态结束；邮件发送失败会记录在日志和 Job Summary 中。工作流最长运行 180 分钟。

签到完成后检查 Cookie 的 `expire_in`，第一次进入到期前 24 小时内时发送提醒。每天检查一次无法保证在到期前发送提醒。运行结果在 Actions 的 Job Summary 中显示今日领取量和首页剩余流量。

当前域名在三次退避重试后仍无法访问时，工作流尝试一次域名恢复：从配置的邮箱向 `find@ikuuu.pro` 发信，等待自动回复，从回复中提取 `https://ikuuu.<后缀>` 链接，验证候选网站和登录状态后，把新域名记录在 `.github/ikuuu-state.json`，再尝试签到。恢复失败则发送最终失败通知。目前已实测同一 Cookie 能在 `ikuuu.top` 和 `ikuuu.pw` 使用。新域名的可用性仍以实际验证为准。

## 配置

建议使用**私有仓库**。在 Settings → Secrets and variables → Actions 中设置：

| Secret | 用途 |
| --- | --- |
| `IKUUU_COOKIE` | 登录后 `/user` 请求的完整 Cookie 值，不含 `Cookie:` 前缀 |
| `MAIL_USER` | 发件及收件邮箱（默认使用 Gmail） |
| `MAIL_APP_PASSWORD` | 邮箱应用专用密码，用于 SMTP 和 IMAP |
| `NOTIFY_TO` | 可选；提醒收件地址，默认是 `MAIL_USER` |

默认邮件服务器为 Gmail 的 `smtp.gmail.com:465` 和 `imap.gmail.com:993`。使用其他邮箱时，设置 Actions Variables `SMTP_HOST`、`SMTP_PORT`、`IMAP_HOST`、`IMAP_PORT`。若自动回复实际发件地址不是 `find@ikuuu.pro`，将其设置为 `FIND_REPLY_FROM`。邮箱必须支持 SMTP 发信和 IMAP 收信。

在 Actions 页面手动运行一次 `iKuuu daily checkin`，确认 Job Summary。Cookie 过期后，重新登录并更新 `IKUUU_COOKIE`；当前 Remember Me 会话的 `expire_in` 约为 7 天，工具不会自动绕过网站验证码重新登录。

## 本地运行

仓库根目录的 `ikuuu-cookie.txt` 为本地 Cookie 文件，已在 `.gitignore` 中排除。安装 Node.js 22 后运行：

```text
npm ci
npm test
$env:FORCE_CHECKIN='true'; npm run run
```

本地运行可以验证签到和剩余流量；到期邮件与域名自动回复还需配置邮箱环境变量。不要把 Cookie、邮箱应用密码写入仓库或日志。

## 已知边界

- GitHub 定时任务可能延迟或跳过；启动后不限制签到小时。到期提醒在每日成功检查发现进入 24 小时窗口时发送，无法保证提前收到。
- 当天已经签到时，网站只返回“已签到”，不会再提供本次领取量；报告会标为“未知”。
- 自动回复里的新域名只有在匹配 `ikuuu.<后缀>`、网站可访问且现有 Cookie 能登录后才会启用。对邮件来源的校验依赖配置的发件地址与邮箱服务，仍应保护邮箱账号。
- 状态文件只保存域名、签到日期和提醒标记，不保存 Cookie 或邮箱凭证。
