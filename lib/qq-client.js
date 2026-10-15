/**
 * QQ 开放平台机器人 v2 客户端：token 管理 + WSS 长连接 + 发消息 REST。
 *
 * 只依赖全局 `fetch` 与 `WebSocket`（Electron 44 / Node 24 都自带），不引第三方 SDK；
 * 两者都可以通过构造参数注入，便于用假网关做离线测试。
 *
 * 协议依据见 ./protocol.js 顶部注释。
 * @module dsh-plugin-qq-bot/qq-client
 */

import { EventEmitter } from 'node:events'
import {
  AUTH_ERROR_CODES,
  AUTH_PREFIX,
  DEFAULT_API_BASE,
  DEFAULT_INTENTS,
  EVENT,
  FATAL_CLOSE_CODES,
  GATEWAY_PATH,
  OP,
  PASSIVE_LIMIT_C2C,
  PASSIVE_LIMIT_GROUP,
  PASSIVE_WINDOW_C2C_MS,
  PASSIVE_WINDOW_CHANNEL_MS,
  PASSIVE_WINDOW_GROUP_MS,
  TOKEN_PATH,
} from './protocol.js'

/** 一次 REST 调用失败时抛出的错误，带官方错误码。 */
export class QqApiError extends Error {
  /**
   * @param {string} message 服务端 message 或本地描述。
   * @param {{ code?: number, status?: number, path?: string, traceId?: string }} [details] 错误细节。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'QqApiError'
    this.code = details.code
    this.status = details.status
    this.path = details.path
    this.traceId = details.traceId
  }
}

/** 把 `200`/`201` 这类「HTTP 成功但 body 里带 err_code」的响应也当成失败。 */
function isSuccessStatus(status) {
  return status >= 200 && status < 300
}

/** `expires_in` 官方给的是字符串，这里宽松解析。 */
function parseExpiresIn(value, fallback = 7200) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 剥掉历史上残留的 `<@!123>` 形式的 @ 前缀；官方现在已自动去除。 */
export function stripMentionPrefix(content) {
  return String(content ?? '')
    .replace(/^<@!?\d+>\s*/, '')
    .trim()
}

/**
 * 把一条 QQ 事件归一化成通道消息。
 * @param {{ id?: string, t?: string, d?: Record<string, any> }} envelope 原始 envelope。
 * @returns {null | { eventId: string, msgId: string, kind: 'c2c' | 'group' | 'channel', target: string, content: string, authorId: string, authorName: string, timestamp: string, receivedAt: number, raw: Record<string, any> }} 归一化消息；不认识的事件返回 null。
 */
export function normalizeMessage(envelope) {
  const type = envelope?.t
  const d = envelope?.d ?? {}
  const author = d.author ?? {}
  const receivedAt = Date.now()

  if (type === EVENT.C2C_MESSAGE_CREATE) {
    const target = String(author.user_openid ?? d.user_openid ?? author.id ?? '')
    if (!target) return null
    return {
      eventId: String(envelope.id ?? ''),
      msgId: String(d.id ?? ''),
      kind: 'c2c',
      target,
      content: stripMentionPrefix(d.content),
      authorId: target,
      authorName: String(author.username ?? ''),
      timestamp: String(d.timestamp ?? ''),
      receivedAt,
      raw: d,
    }
  }

  if (type === EVENT.GROUP_AT_MESSAGE_CREATE || type === EVENT.GROUP_MESSAGE_CREATE) {
    const target = String(d.group_openid ?? '')
    if (!target) return null
    return {
      eventId: String(envelope.id ?? ''),
      msgId: String(d.id ?? ''),
      kind: 'group',
      target,
      content: stripMentionPrefix(d.content),
      authorId: String(author.member_openid ?? author.id ?? ''),
      authorName: String(author.username ?? ''),
      timestamp: String(d.timestamp ?? ''),
      receivedAt,
      raw: d,
    }
  }

  if (type === EVENT.AT_MESSAGE_CREATE) {
    const target = String(d.channel_id ?? '')
    if (!target) return null
    return {
      eventId: String(envelope.id ?? ''),
      msgId: String(d.id ?? ''),
      kind: 'channel',
      target,
      content: String(d.content ?? '').trim(),
      authorId: String(author.id ?? ''),
      authorName: String(author.username ?? ''),
      timestamp: String(d.timestamp ?? ''),
      receivedAt,
      raw: d,
    }
  }

  return null
}

/**
 * QQ 机器人客户端。
 *
 * 事件：
 * - `message`：收到一条可处理的消息（normalizeMessage 的结果）。
 * - `status`：连接状态变化 `{ state, detail? }`。
 * - `log`：`{ level, message }`，由插件转发到 ctx.logger。
 */
export class QqBotClient extends EventEmitter {
  /**
   * @param {object} options 客户端选项。
   * @param {string} options.appId 机器人 AppID。
   * @param {string} options.clientSecret 机器人 AppSecret（客户端密钥）。
   * @param {string} [options.apiBase] OpenAPI 根地址，默认官方地址。
   * @param {number} [options.intents] 订阅的 intent 位。
   * @param {number} [options.shardId] 分片序号，默认 0。
   * @param {number} [options.shardCount] 分片总数，默认 1。
   * @param {AbortSignal} [options.signal] 生命周期信号，abort 后停止重连。
   * @param {typeof fetch} [options.fetchImpl] 注入的 fetch（测试用）。
   * @param {typeof WebSocket} [options.webSocketImpl] 注入的 WebSocket（测试用）。
   */
  constructor(options) {
    super()
    this.appId = options.appId
    this.clientSecret = options.clientSecret
    this.apiBase = options.apiBase || DEFAULT_API_BASE
    this.intents = Number.isFinite(options.intents) ? options.intents : DEFAULT_INTENTS
    this.shard = [options.shardId ?? 0, options.shardCount ?? 1]
    this.signal = options.signal
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.webSocketImpl = options.webSocketImpl ?? globalThis.WebSocket

    /** @type {{ token: string, expiresAt: number } | undefined} */
    this.token = undefined
    /** @type {WebSocket | undefined} */
    this.socket = undefined
    this.sessionId = ''
    this.lastSeq = null
    this.closed = false
    this.stopping = false
    this.reconnectAttempts = 0
    this.heartbeatTimer = undefined
    this.heartbeatIntervalMs = 45_000
    /** 每个 msg_id 已经用掉的被动回复次数。 */
    this.replyCounters = new Map()
    /** 主动消息回退次数，用于日志。 */
    this.activeFallbacks = 0
    this.#status('idle')
  }

  #status(state, detail) {
    this.emit('status', { state, detail })
  }

  #log(level, message) {
    this.emit('log', { level, message })
  }

  /** Authorization 头的值：`QQBot <access_token>`。 */
  #authHeader() {
    return `${AUTH_PREFIX} ${this.token?.token ?? ''}`
  }

  /** 取（并缓存）app access token；过期前 5 分钟自动续期。 */
  async ensureToken() {
    if (this.token !== undefined && this.token.expiresAt - Date.now() > 300_000) return this.token.token
    const response = await this.fetchImpl(`${this.apiBase}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      signal: this.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new QqApiError(`获取 access_token 失败：响应不是 JSON（HTTP ${response.status}）`, { status: response.status })
    }
    // 这个接口失败时 HTTP 也是 200，必须看 body.code。
    if (body.code !== undefined && body.code !== 0) {
      throw new QqApiError(`获取 access_token 失败：${body.message ?? body.code}`, {
        code: Number(body.code),
        status: response.status,
      })
    }
    if (!body.access_token) {
      throw new QqApiError(`获取 access_token 失败：响应缺少 access_token`, { status: response.status })
    }
    const ttl = parseExpiresIn(body.expires_in)
    this.token = { token: String(body.access_token), expiresAt: Date.now() + ttl * 1000 }
    this.#log('info', `access_token 已获取，有效期 ${ttl}s`)
    return this.token.token
  }

  /** 一次 OpenAPI 调用；非 2xx 或 body 带 err_code 时抛 QqApiError。 */
  async api(path, init = {}) {
    await this.ensureToken()
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: this.#authHeader(),
        'Content-Type': 'application/json; charset=utf-8',
        ...(init.headers ?? {}),
      },
      signal: this.signal,
    })
    const text = await response.text()
    let body
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = { message: text.slice(0, 500) }
      }
    }
    if (body?.err_code !== undefined && body.err_code !== 0) {
      throw new QqApiError(body.message ?? `OpenAPI 错误 ${body.err_code}`, {
        code: Number(body.err_code),
        status: response.status,
        path,
        traceId: body.trace_id ?? response.headers?.get?.('X-Tps-trace-ID') ?? undefined,
      })
    }
    if (!isSuccessStatus(response.status)) {
      throw new QqApiError(body?.message ?? `OpenAPI HTTP ${response.status}`, {
        status: response.status,
        path,
        traceId: body?.trace_id ?? undefined,
      })
    }
    return body
  }

  /** 拉取 WSS 接入点。 */
  async getGatewayUrl() {
    const body = await this.api(GATEWAY_PATH)
    if (typeof body?.url !== 'string' || body.url === '') throw new QqApiError('gateway/bot 响应缺少 url')
    if (Number.isFinite(body.shards)) this.shard = [this.shard[0], body.shards]
    return body.url
  }

  /** 建立连接（会自动重连，直到 stop() 或 signal abort）。 */
  async start() {
    if (this.stopping || this.signal?.aborted) return
    try {
      const url = await this.getGatewayUrl()
      this.#status('connecting', url)
      const socket = new this.webSocketImpl(url)
      this.socket = socket
      socket.addEventListener('message', (event) => this.#onFrame(event.data))
      socket.addEventListener('close', (event) => this.#onClose(event))
      socket.addEventListener('error', () => this.#log('warn', 'WebSocket 报错'))
    } catch (error) {
      const hint =
        error instanceof QqApiError && error.code !== undefined && AUTH_ERROR_CODES.has(error.code)
          ? '（这通常是 AppID / AppSecret 不对，或机器人在平台上还没启用）'
          : ''
      this.#log('error', `连接失败${hint}：${error instanceof Error ? error.message : String(error)}`)
      this.#scheduleReconnect()
    }
  }

  /** 主动断开并停止重连。 */
  stop() {
    this.stopping = true
    this.#clearHeartbeat()
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close(1000, 'plugin disposed')
    } catch {
      /* 关闭失败无所谓，进程会回收 */
    }
  }

  #onClose(event) {
    this.#clearHeartbeat()
    this.socket = undefined
    const code = event?.code ?? 1006
    this.#status('closed', code)
    if (this.stopping) return
    if (FATAL_CLOSE_CODES.has(code)) {
      this.#log('error', `WebSocket 被服务端关闭（${code}），不再重连`)
      this.stopping = true
      return
    }
    if (code === 4914 || code === 4915) return
    // 4009 = 连接过期，官方允许 resume；其余按「重新 identify」处理，
    // 但保留 session 让第一次 resume 尝试仍可能成功。
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.stopping || this.signal?.aborted) return
    this.reconnectAttempts += 1
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 6))
    const delay = Math.round(base * (0.7 + Math.random() * 0.6))
    this.#status('reconnecting', { attempt: this.reconnectAttempts, delay })
    const timer = setTimeout(() => {
      void this.start()
    }, delay)
    timer.unref?.()
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  #send(payload) {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  /** 处理一帧服务端数据。 */
  #onFrame(raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      this.#log('warn', '收到无法解析的 WebSocket 帧')
      return
    }
    switch (frame.op) {
      case OP.HELLO: {
        this.heartbeatIntervalMs = Number(frame.d?.heartbeat_interval) > 0 ? Number(frame.d.heartbeat_interval) : 45_000
        if (this.sessionId !== '' && this.lastSeq !== null) {
          this.#send({ op: OP.RESUME, d: { token: `${AUTH_PREFIX} ${this.token?.token ?? ''}`, session_id: this.sessionId, seq: this.lastSeq } })
        } else {
          this.#send({
            op: OP.IDENTIFY,
            d: {
              token: `${AUTH_PREFIX} ${this.token?.token ?? ''}`,
              intents: this.intents,
              shard: this.shard,
              properties: { $os: process.platform, $browser: 'dsh-plugin-qq-bot', $device: 'dsh-plugin-qq-bot' },
            },
          })
        }
        this.#clearHeartbeat()
        this.heartbeatTimer = setInterval(() => {
          this.#send({ op: OP.HEARTBEAT, d: this.lastSeq })
        }, this.heartbeatIntervalMs)
        this.heartbeatTimer.unref?.()
        return
      }
      case OP.HEARTBEAT_ACK:
        return
      case OP.RECONNECT: {
        // 服务端要求重连；保留 session 以便 resume。
        const socket = this.socket
        this.socket = undefined
        this.#clearHeartbeat()
        try {
          socket?.close(4000, 'server requested reconnect')
        } catch {
          /* ignore */
        }
        this.#scheduleReconnect()
        return
      }
      case OP.INVALID_SESSION: {
        this.#log('warn', 'session 失效，丢弃后重新 identify')
        this.sessionId = ''
        this.lastSeq = null
        return
      }
      case OP.DISPATCH: {
        if (typeof frame.s === 'number') this.lastSeq = frame.s
        if (frame.t === EVENT.READY) {
          this.sessionId = String(frame.d?.session_id ?? '')
          this.reconnectAttempts = 0
          this.#status('ready', { sessionId: this.sessionId, user: frame.d?.user?.username })
          return
        }
        if (frame.t === EVENT.RESUMED) {
          this.reconnectAttempts = 0
          this.#status('ready', { resumed: true })
          return
        }
        const message = normalizeMessage(frame)
        if (message !== null) this.emit('message', message)
        return
      }
      default:
        return
    }
  }

  /**
   * 这条回复能不能走被动回复，以及要带的 `msg_id`/`msg_seq`。
   *
   * 单聊：60 分钟内、最多 4 条；群聊：5 分钟内、最多 5 条，`msg_seq` 递增。
   * 子频道：接口只认 `msg_id`，没有 `msg_seq`，所以只判窗口。
   * @param {ReturnType<typeof normalizeMessage>} message 原消息。
   * @returns {{ msgId: string, seq?: number } | undefined} 被动回复方案；`undefined` 表示改走主动消息。
   */
  #passivePlan(message) {
    if (message.msgId === '') return undefined
    const age = Date.now() - message.receivedAt
    if (message.kind === 'channel') {
      return age <= PASSIVE_WINDOW_CHANNEL_MS ? { msgId: message.msgId } : undefined
    }
    const window = message.kind === 'c2c' ? PASSIVE_WINDOW_C2C_MS : PASSIVE_WINDOW_GROUP_MS
    if (age > window) return undefined
    const limit = message.kind === 'c2c' ? PASSIVE_LIMIT_C2C : PASSIVE_LIMIT_GROUP
    const used = this.replyCounters.get(message.msgId) ?? 0
    if (used >= limit) return undefined
    const next = used + 1
    this.replyCounters.set(message.msgId, next)
    if (this.replyCounters.size > 512) {
      const oldest = this.replyCounters.keys().next().value
      this.replyCounters.delete(oldest)
    }
    return { msgId: message.msgId, seq: next }
  }

  /** 目标路径：群用 group_openid，单聊用 user_openid，子频道用 channel_id。 */
  #messagePath(message) {
    if (message.kind === 'group') return `/v2/groups/${encodeURIComponent(message.target)}/messages`
    if (message.kind === 'c2c') return `/v2/users/${encodeURIComponent(message.target)}/messages`
    if (message.kind === 'channel') return `/channels/${encodeURIComponent(message.target)}/messages`
    throw new QqApiError(`不支持的会话类型：${message.kind}`)
  }

  /**
   * 回复一条消息：优先被动回复，窗口/次数用尽或服务端说过期时退回主动消息。
   * @param {ReturnType<typeof normalizeMessage>} message 原消息。
   * @param {string} content 文本内容。
   * @returns {Promise<{ mode: 'passive' | 'active', seq?: number }>} 实际使用的投递方式。
   */
  async reply(message, content) {
    if (message === null) throw new QqApiError('reply 需要一条已归一化的消息')
    const plan = this.#passivePlan(message)
    try {
      return await this.#sendContent(message, content, plan)
    } catch (error) {
      if (plan !== undefined && error instanceof QqApiError && error.code !== undefined && this.#isPassiveExpiry(error.code)) {
        this.#log('warn', `被动回复被拒（${error.code}），改发主动消息`)
        return await this.#sendContent(message, content, undefined)
      }
      throw error
    }
  }

  #isPassiveExpiry(code) {
    return (
      code === 40034005 ||
      code === 304103 ||
      code === 304027 ||
      code === 40034128 ||
      code === 40034024 ||
      code === 40054005
    )
  }

  /**
   * 真正发出一次消息。
   * @param {ReturnType<typeof normalizeMessage>} message 原消息。
   * @param {string} content 文本。
   * @param {{ msgId: string, seq?: number } | undefined} plan 被动回复方案；`undefined` 走主动消息。
   * @returns {Promise<{ mode: 'passive' | 'active', seq?: number }>} 投递结果。
   */
  async #sendContent(message, content, plan) {
    const path = this.#messagePath(message)
    // 子频道接口的 body 只有 content/msg_id/image，不接受 msg_type。
    const body = message.kind === 'channel' ? { content } : { content, msg_type: 0 }
    if (plan !== undefined) {
      body.msg_id = plan.msgId
      if (plan.seq !== undefined) body.msg_seq = plan.seq
    } else {
      this.activeFallbacks += 1
    }
    await this.api(path, { method: 'POST', body: JSON.stringify(body) })
    if (plan === undefined) return { mode: 'active' }
    return plan.seq === undefined ? { mode: 'passive' } : { mode: 'passive', seq: plan.seq }
  }
}
