# Cloudflare 原生 fetch 域名发布页实测

测试日期：2026-10-02。此次测试只读取公开页面，未携带 Cookie、未登录、未调用签到接口、未发送邮件。

## 方法

使用 Wrangler 4.146.0 的 `deploy --temporary` 部署临时 Worker。由 Firecrawl 请求探针入口，实际目标网站请求和静态解析均在该 Worker 内执行。Firecrawl 在这里仅用于获取探针的 JSON 结果，不负责渲染或解析目标域名发布页。

Worker 原生 `fetch` 使用 `redirect: manual` 和 20 秒超时。响应原文以 Base64 返回并保存，避免抓取工具将 JSON 内嵌 HTML 当成页面再次处理。最后在同一 Worker 内部署 Acorn AST 静态解析器验证数据提取；解析器不使用 eval、Function 或执行浏览器页面处理函数。

临时入口在本地直接访问时出现挑战页面和错误 1042，改由抓取服务访问成功。这是访问探针入口时观察到的现象，不能据此认定目标网站拒绝 Worker；随后探针返回了目标网站请求的真实结果。

## 结果

Cloudflare 执行节点：IAD。

| 目标 | HTTP 状态 | 请求耗时 | 结果 |
| --- | --- | --- | --- |
| https://ikuuu.win/ | 200 | 最终提取测试 2177 ms | 原始响应 90864 个字符，成功静态解析发布日期及域名 |
| https://ikuuu.top/auth/login | 200 | 约 2.3–2.6 秒 | 解码网站 originBody 后包含密码输入框和 Login，没有挑战页特征 |
| https://ikuuu.pw/auth/login | 200 | 2164 ms | 返回 HTML；未进一步测试登录或签到 |

最终解析结果于北京时间 12:42:30（UTC 04:42:30）取得：

```json
{
  "updatedAt": "2026-09-11",
  "domains": [
    { "host": "ikuuu.top", "url": "https://ikuuu.top/", "role": "主要域名" },
    { "host": "ikuuu.pw", "url": "https://ikuuu.pw/", "role": "备用域名 1" }
  ]
}
```

## 迁移影响和边界

1. 已验证 Cloudflare Worker 原生 fetch 可以读取该发布页，并且可以在 Worker 内从原始响应提取当前域名数据。
2. 原始响应中没有完整的明文候选域名；域名数据在混淆 JavaScript 中。简单匹配 href 或 `ikuuu.<后缀>` 会失败。当前解析器针对本次脚本结构；发布者更换混淆算法或符号后需要适配。
3. 正式实现应优先支持未来可能出现的明文/结构化数据，再兼容已知混淆结构；未知结构拒绝切换，保留上次成功域名和原始响应摘要，进入退避和用户通知。
4. 页面“在线”检测仅依赖浏览器 no-cors HEAD 请求是否抛异常，没有验证 HTTP 成功状态；正式程序必须从 Cloudflare 实际验证候选站点和 Cookie 登录。
5. 因而可以用发布页发现域名替换向 find@ikuuu.pro 发信及等待自动回复。Cloudflare 原生邮件仍需要自有域名；本项目后续选择已有 126 邮箱的 SMTP 发信，避免购买域名，具体实施见迁移记录。
6. 实测覆盖一个节点、一个时段和当前页面版本，不证明永久可访问，也没有验证账号 Cookie、正式免费账号的资源消耗或 Durable Object 内的完整流程。

## 保存的证据和代码

- `.firecrawl/cf-worker-static-parser-verified.json`：最终 Worker 输出。
- `.firecrawl/ikuuu-win-origin.html`：Worker 读取的原始 HTML。
- `.firecrawl/cf-verified-top-result.json` 和 `cf-verified-pw-result.json`：候选网站请求结果。
- `.firecrawl/cloudflare-probe/worker.js`、`parser.js`：探针与有预算限制的静态解析原型。

这些原始测试材料位于已忽略的 `.firecrawl` 目录；探针测试当时未更改正式签到代码，测试结束已删除临时 Worker。后续迁移将发布页 HTML（清理行尾空白）保存为 `test/fixtures/ikuuu-win-20260911.html`，并使用同一解析方法完成正式实现。
