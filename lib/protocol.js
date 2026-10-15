/**
 * QQ 开放平台机器人（v2）协议常量。
 *
 * 所有与官方接口有关的字面量都集中在这里，协议细节变动时只改这一个文件。
 * 依据 https://bot.q.qq.com/wiki/develop/api-v2/ ：2026-08-10 起全部接口统一到
 * `api.bot.qq.com`，`api.sgroup.qq.com` / `bots.qq.com` / 沙箱域名均为历史域名。
 * @module dsh-plugin-qq-bot/protocol
 */

/** OpenAPI 根地址（生产与「沙箱」共用；新版群/单聊机器人没有沙箱域名）。 */
export const DEFAULT_API_BASE = 'https://api.bot.qq.com'

/**
 * 获取 app access token 的路径（拼在 apiBase 之后）。
 *
 * 已用无效 appId 实测（2026-10-14）：`api.bot.qq.com` 与老域名 `bots.qq.com`
 * 都提供该接口，且都返回 HTTP 200 + `{"code":10004,"message":"机器人不存在"}`，
 * 所以按 body 里的 `code` 判成败是必须的。
 */
export const TOKEN_PATH = '/app/getAppAccessToken'

/**
 * 凭据类错误码：命中时补一句「检查 AppID / AppSecret」，避免无限重连时日志难读。
 * 10004 机器人不存在 / 100007 appid invalid / 100016 invalid appid or secret /
 * 100006 未知错误 / 11253 应用无该接口权限。
 */
export const AUTH_ERROR_CODES = new Set([10004, 100006, 100007, 100016, 11253])

/** 获取带分片信息的 WSS 接入点。 */
export const GATEWAY_PATH = '/gateway/bot'

/**
 * 覆盖「群聊@机器人」与「单聊」两类消息事件的 intent 位。
 * 1 << 25 —— 官方文档的 GROUP_AND_C2C_EVENT。
 */
export const INTENT_GROUP_AND_C2C = 1 << 25

/** 「频道」消息事件（PUBLIC_GUILD_MESSAGES），与群/单聊互不影响。 */
export const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30

/**
 * 默认 intents：群 + 单聊。官方 websocket 文档页的示例值 513 是频道私域，
 * 直接照抄会被服务端以 4013/4014 断开。
 */
export const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C

/** Authorization 头的前缀，格式是 `QQBot <access_token>`（QQBot 后一个空格）。 */
export const AUTH_PREFIX = 'QQBot'

/** WebSocket 操作码。 */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

/** 需要处理的派发事件名。 */
export const EVENT = {
  /** 单聊（私聊）消息。 */
  C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
  /** 群聊中 @机器人 的消息（也可能含群全量消息，若群主已开启）。 */
  GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  /** 群全量消息（群主开启「接收所有消息」后下发）。 */
  GROUP_MESSAGE_CREATE: 'GROUP_MESSAGE_CREATE',
  /** 文字子频道中 @机器人 的消息。 */
  AT_MESSAGE_CREATE: 'AT_MESSAGE_CREATE',
  READY: 'READY',
  RESUMED: 'RESUMED',
}

/**
 * 被动回复的时效窗口（毫秒）——群聊 5 分钟。
 * 留 30 秒余量：超过就直接改走主动消息，省一次必然失败的请求。
 */
export const PASSIVE_WINDOW_GROUP_MS = 270_000

/** 被动回复的时效窗口（毫秒）——单聊 60 分钟。 */
export const PASSIVE_WINDOW_C2C_MS = 3_300_000

/**
 * 被动回复的时效窗口（毫秒）——子频道 5 分钟。
 * 子频道接口只认 `msg_id`，没有 `msg_seq`，也没有条数上限的概念。
 */
export const PASSIVE_WINDOW_CHANNEL_MS = 270_000

/** 同一个 msg_id 在群聊里允许的最大回复条数。 */
export const PASSIVE_LIMIT_GROUP = 5

/** 同一个 msg_id 在单聊里允许的最大回复条数。 */
export const PASSIVE_LIMIT_C2C = 4

/**
 * 判定「被动回复已过期/已用尽」的错误码：收到这些码时改用主动消息重投一次。
 * 来自官方错误表：40034005 回复消息 msg_id 已过期、304103 消息 ID 已过期、
 * 304027 MSG_EXPIRE、40034128 被动回复时间或次数超限、40034024 msg_id 无效。
 */
export const EXPIRED_MSG_ID_CODES = new Set([40034005, 304103, 304027, 40034128, 40034024])

/** 消息长度超限的错误码：收到后按更小的分片重试。 */
export const TOO_LONG_CODES = new Set([40054007, 40054018])

/** WebSocket 关闭码语义（官方错误表）。 */
export const CLOSE_CODE = {
  /** 连接过期 —— 可以 resume。 */
  SESSION_TIMEOUT: 4009,
  /** 机器人已下架，禁止重连。 */
  BOT_OFFLINE: 4914,
  /** 机器人已封禁，禁止重连。 */
  BOT_BANNED: 4915,
}

/** 不可重连的关闭码。 */
export const FATAL_CLOSE_CODES = new Set([CLOSE_CODE.BOT_OFFLINE, CLOSE_CODE.BOT_BANNED])
