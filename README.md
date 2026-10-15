# dsh-plugin-qq-bot

把 **QQ 官方机器人**（q.qq.com 开放平台）接成 DeepSeek Harness 的一个输入通道：
在 QQ 群里 @机器人 或在私聊里发消息 → DSH 用对应会话处理 → 回答回到 QQ。

一个 QQ 用户 / 一个 QQ 群固定对应一个 DSH Session（id 形如 `session-qq-c2c-<openid>`、
`session-qq-group-<group_openid>`），所以多轮上下文由 DSH 自己的会话持久化维护，
插件不额外维护映射表；在 GUI 里能直接看到并归档这些会话。

## 一、先在 QQ 侧准备

1. 打开 <https://q.qq.com>，用 QQ 号登录「QQ 开放平台」，创建**机器人**应用（个人主体也能建）。
2. 在「开发设置」里拿到 **AppID** 和 **AppSecret（客户端密钥）**。
3. 在「功能配置」里开启 **单聊**（私聊）和 / 或 **群聊** 场景。群聊场景需要在
   「沙箱配置」里把你自己的测试群加进去（新版群/单聊机器人没有沙箱域名，
   管理员账号本身就是测试账号，直接用真实环境）。
4. 群聊场景下，机器人需要被拉进群；测试期建议只把小号/测试群加进去。

> 官方文档：<https://bot.q.qq.com/wiki/develop/api-v2/>

## 二、把凭据交给插件

三种方式，按优先级：**插件配置 → 环境变量 → 凭据文件**。

推荐第三种（不把密钥写进 profile 补丁）：

```jsonc
// ~/.dsh/qq-bot.json
{
  "appId": "你的 AppID",
  "clientSecret": "你的 AppSecret"
}
```

或设环境变量 `DSH_QQ_APP_ID` / `DSH_QQ_CLIENT_SECRET`。
也可以在 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: qq-bot
  name: dsh-plugin-qq-bot
  config:
    appId: "..."
    clientSecret: "..."
```

**凭据文件会被轮询**：补上或修改 `~/.dsh/qq-bot.json` 后，插件在几秒内自动连上网关，
**不需要重启 DeepSeek Harness**（`credentialsPollMs` 控制轮询间隔）。
只有改动插件**配置项**（`cordis.patch.yml` 里的 `config:`）才需要重启。

## 三、配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件只写状态文件、不连网关 |
| `appId` / `clientSecret` | `""` | 留空则走环境变量 / 凭据文件 |
| `apiBase` | `https://api.bot.qq.com` | 官方接口根地址（2026-08-10 起统一域名） |
| `intents` | `33554432` | `1<<25`，同时覆盖群聊@与单聊 |
| `agentPreset` | `standard` | 这些会话使用的 Agent 预设（也是平台默认预设） |
| `workspace` | `~/.dsh/qq-bot-workspace` | 会话工作目录；想让它操作某个项目就指过去 |
| `allowOpenIds` | `[]` | 只响应这些 openid / group_openid；留空不限制 |
| `replyChunkChars` | `1500` | 单条消息最大字符数，超出分片发送 |
| `maxWaitMs` | `900000` | 单轮最长等待；超时先把已有内容发出去 |
| `ackAfterMs` | `12000` | 超过这么久还没答就先回一句「正在处理」；`0` 关闭 |
| `ackText` | `收到，正在处理…` | 上面那句的文案 |
| `credentialsFile` | `~/.dsh/qq-bot.json` | 凭据文件路径 |
| `credentialsPollMs` | `5000` | 轮询凭据文件内容变化的间隔（毫秒） |

## 四、怎么确认它跑起来了

状态会写到 `~/.dsh/qq-bot-state.json`：

```jsonc
{
  "status": "ready",          // starting / connecting / ready / closed / reconnecting / missing-credentials
  "lastMessageAt": 1760000000000,
  "lastSessionId": "session-qq-c2c-XXXXXXXX",
  "lastSummary": "[正常完成，12.3s]",
  "events": [ { "at": 1760000000000, "message": "info: access_token 已获取，有效期 7200s" } ]
}
```

- `missing-credentials` → 凭据没被读到；补上文件后插件会**自动**重试，不用重启。
- `closed` / `reconnecting` 反复出现 → 看 `events` 里的日志：
  - 日志里带 `（这通常是 AppID / AppSecret 不对…）` 或 `机器人不存在` → 凭据或平台配置问题。
  - 服务端以 4013/4014 断开 → `intents` 没权限（群 + 单聊要 `33554432`）。
  - 先出现 `access_token 已获取` 再断开 → 凭据没问题，检查平台上的场景/群配置。

> 已实测（2026-10-14）：`api.bot.qq.com` 同时提供 access_token 与 OpenAPI；用无效
> AppID 请求 token 会返回 **HTTP 200** + `{"code":10004,"message":"机器人不存在"}`，
> 所以判定成败必须看 body 里的 `code`（插件已按此实现）。

## 五、行为细节

- **被动回复优先**：群里 5 分钟内、单聊 60 分钟内，用收到的那条消息的 `msg_id`
  回复（群里最多 5 条、单聊最多 4 条，`msg_seq` 递增）。超出窗口或次数后自动改走普通消息。
- **同一个会话串行**：同一个 QQ 用户/群的多条消息排队处理，不会互相打断；
  不同会话并行。
- **超时保护**：单轮超过 `maxWaitMs` 会把当前已有的文本先发出去，并在末尾标注超时。
- **回复末尾会附一行状态**，例如 `[正常完成，12.3s]`，方便知道这轮是怎么结束的。
- **两条本地指令**（不占用 DSH 轮次，用来快速确认链路通不通）：
  - `/ping` → 回 `pong ✅` 加网关状态、凭据来源、本会话 id
  - `/help` → 回一段使用说明

## 六、开发与测试

```bash
# 单元测试（不需要 DSH、不需要网络）
node --test
```

测试覆盖：文本分片、事件归一化、桥接投递顺序与串行、以及用一个假 WebSocket +
假 fetch 跑完整的「Hello → Identify → READY → 收消息 → 被动回复 → 过期回退主动消息」链路。

## 七、写 DSH 插件时踩到的两个坑

这两条都是**真实联调时才暴露**的，跟 QQ 无关，任何 DSH 插件都可能遇到。

**1. `sessionController.prompt(request, signal)` 的 `signal` 不能省。**
它的 `@Remote` 门面第一行是 `signal.throwIfAborted()`，且**没有 `?.` 兜底**：

```js
prompt(request, signal) {
  signal.throwIfAborted();
  return this.commands.prompt(request);
}
```

少传第二个参数就报 `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。
官方服务契约里只写 `prompt(request, signal)`，看不出哪个参数可省 —— 实测 `create` 和
`resolveAgent` 都不需要 signal，只有 `prompt` 需要。
本插件在测试里用一个「复刻真实契约」的假 `sessionController` 看住这一点。

**2. 改完插件代码，重新挂载**不**等于加载新代码。**
ESM 模块按 URL 缓存，`dsh plugin add` 重新装、或把 bundle 关掉再打开，插件会重新
`apply()`（状态文件里的挂载时间会变），但**跑的还是缓存住的旧模块**。只有重启
DSH 进程才会真正换代码。

插件为此在状态文件里写了 `codeVersion`；`node tools/check.mjs` 会直接告诉你当前
进程跑的是哪一版，缺失就说明还是旧模块。

## 八、许可

MIT
