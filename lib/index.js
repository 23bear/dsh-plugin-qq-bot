/**
 * dsh-plugin-qq-bot — 把 QQ 官方机器人接成 DSH 的一个输入通道。
 *
 * 数据流：QQ 消息 → WSS 网关 → 归一化 → DSH Session（一个 QQ 用户/群固定一个会话）
 * → 轮次结束 → 分片发回 QQ。
 *
 * 配置见本文件的 Config；凭据可以写在配置里，也可以用环境变量或
 * `~/.dsh/qq-bot.json`（推荐，避免把密钥写进 profile 补丁）。
 * @module dsh-plugin-qq-bot
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { QqApiError, QqBotClient } from './qq-client.js'
import { createBridge, describeReason, sessionIdFor } from './bridge.js'
import { normalizeReply, splitText } from './text.js'
import { createStateWriter } from './state.js'
import { DEFAULT_API_BASE, DEFAULT_INTENTS } from './protocol.js'

/** Cordis 插件名。 */
export const name = 'qq-bot'

/**
 * 代码版本标记：写进状态文件，用来确认「当前跑着的到底是哪一版代码」。
 * ESM 模块按 URL 缓存，改完安装目录里的文件不保证已加载的进程会用新代码。
 */
export const CODE_VERSION = '2026-10-15-signal-fix'

/** 插件激活所需的服务：没有 sessionController 就无法把消息送进 DSH。 */
export const inject = ['sessionController']

/** 配置默认值：schema 与运行期归一化共用同一份，避免两处漂移。 */
export const CONFIG_DEFAULTS = {
  /** 机器人 AppID。留空则尝试环境变量 / 凭据文件。 */
  appId: '',
  /** 机器人 AppSecret（客户端密钥）。留空则尝试环境变量 / 凭据文件。 */
  clientSecret: '',
  /** 是否启用通道。 */
  enabled: true,
  /** OpenAPI 根地址，一般不用改。 */
  apiBase: DEFAULT_API_BASE,
  /** 订阅的 intents 位；默认「群聊@ + 单聊」。 */
  intents: DEFAULT_INTENTS,
  /** 新会话使用的 Agent 预设 id。 */
  agentPreset: 'standard',
  /** 新会话的工作目录；留空则用 `<DSH_HOME>/qq-bot-workspace`。 */
  workspace: '',
  /** 只响应这些 openid / group_openid；留空表示不限制。 */
  allowOpenIds: [],
  /** 单条 QQ 消息的最大字符数；超出会分片。 */
  replyChunkChars: 1500,
  /** 单轮最长等待毫秒数；超时会把已有内容先发出去。 */
  maxWaitMs: 900_000,
  /** 处理超过这么久还没结束时，先回一句「正在处理」；0 表示不提示。 */
  ackAfterMs: 12_000,
  /** 「正在处理」提示文案。 */
  ackText: '收到，正在处理，可能需要一点时间…',
  /** 凭据文件路径；留空则用 `<DSH_HOME>/qq-bot.json`。 */
  credentialsFile: '',
  /** 轮询凭据文件内容变化的间隔（毫秒）；补上凭据后自动生效，无需重启 DSH。 */
  credentialsPollMs: 5000,
}

/** 插件配置。 */
export const Config = z.object({
  appId: z.string().default(CONFIG_DEFAULTS.appId),
  clientSecret: z.string().default(CONFIG_DEFAULTS.clientSecret),
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled),
  apiBase: z.string().default(CONFIG_DEFAULTS.apiBase),
  intents: z.number().default(CONFIG_DEFAULTS.intents),
  agentPreset: z.string().default(CONFIG_DEFAULTS.agentPreset),
  workspace: z.string().default(CONFIG_DEFAULTS.workspace),
  allowOpenIds: z.array(z.string()).default(CONFIG_DEFAULTS.allowOpenIds),
  replyChunkChars: z.number().default(CONFIG_DEFAULTS.replyChunkChars),
  maxWaitMs: z.number().default(CONFIG_DEFAULTS.maxWaitMs),
  ackAfterMs: z.number().default(CONFIG_DEFAULTS.ackAfterMs),
  ackText: z.string().default(CONFIG_DEFAULTS.ackText),
  credentialsFile: z.string().default(CONFIG_DEFAULTS.credentialsFile),
  credentialsPollMs: z.number().default(CONFIG_DEFAULTS.credentialsPollMs),
})

/**
 * 把传入的配置补全成可直接使用的形状。
 *
 * 正常情况下 loader 会用 schema 物化默认值，但「只给了一部分字段」的调用方
 * （例如 `dsh --patch` 覆盖、或手工 `ctx.plugin`）也应当能正常工作；
 * 而且 `replyChunkChars` 之类的数值一旦是 undefined 会让分片逻辑失去上界，
 * 所以这里必须兜住。
 * @param {any} raw 原始配置。
 * @returns {typeof CONFIG_DEFAULTS} 补全后的配置。
 */
export function normalizeConfig(raw) {
  const config = { ...CONFIG_DEFAULTS, ...(raw ?? {}) }
  const number = (value, fallback, min) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
  }
  config.replyChunkChars = number(config.replyChunkChars, CONFIG_DEFAULTS.replyChunkChars, 100)
  config.maxWaitMs = number(config.maxWaitMs, CONFIG_DEFAULTS.maxWaitMs, 1000)
  config.ackAfterMs = number(config.ackAfterMs, CONFIG_DEFAULTS.ackAfterMs, 0)
  config.credentialsPollMs = number(config.credentialsPollMs, CONFIG_DEFAULTS.credentialsPollMs, 200)
  config.intents = number(config.intents, CONFIG_DEFAULTS.intents, 1)
  config.allowOpenIds = Array.isArray(config.allowOpenIds) ? config.allowOpenIds.map(String) : []
  config.enabled = config.enabled !== false
  return config
}

/** DSH 主目录。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 从磁盘读凭据文件；文件不存在或不可解析时返回空对象。 */
function readCredentialsFile(path) {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 按「显式配置 → 环境变量 → 凭据文件」的顺序解析 AppID 与密钥。
 * @param {any} config 插件配置。
 * @returns {{ appId: string, clientSecret: string, source: string }} 解析结果。
 */
export function resolveCredentials(config) {
  const file = config.credentialsFile || join(dshHome(), 'qq-bot.json')
  const fromFile = readCredentialsFile(file)
  const appId = config.appId || process.env.DSH_QQ_APP_ID || fromFile.appId || ''
  const clientSecret = config.clientSecret || process.env.DSH_QQ_CLIENT_SECRET || fromFile.clientSecret || ''
  let source = 'config'
  if (!config.appId && process.env.DSH_QQ_APP_ID) source = 'env'
  else if (!config.appId && fromFile.appId) source = 'file'
  return { appId, clientSecret, source }
}

/** 解析工作目录，必要时创建。 */
function resolveWorkspace(config, log) {
  const target = config.workspace || join(dshHome(), 'qq-bot-workspace')
  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
  } catch (error) {
    log('warn', `无法创建工作目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
  }
  return target
}

/** 连接成功后从网关拿到的机器人信息（仅用于日志）。 */
function describeClientError(error) {
  if (error instanceof QqApiError) {
    const parts = [error.message]
    if (error.code !== undefined) parts.push(`code=${error.code}`)
    if (error.status !== undefined) parts.push(`http=${error.status}`)
    if (error.traceId !== undefined) parts.push(`trace=${error.traceId}`)
    return parts.join(' ')
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 挂载插件。
 * @param {any} ctx Cordis 上下文。
 * @param {any} config 已校验的配置。
 */
export function apply(ctx, config) {
  /** @param {string} level @param {string} message */
  const log = (level, message) => {
    const sink = typeof ctx.logger[level] === 'function' ? ctx.logger[level].bind(ctx.logger) : ctx.logger.info.bind(ctx.logger)
    sink(`qq-bot: ${message}`)
  }

  const state = createStateWriter(join(dshHome(), 'qq-bot-state.json'), log)
  const settings = normalizeConfig(config)

  if (!settings.enabled) {
    log('info', '已配置为禁用，跳过')
    state.set({ status: 'disabled' })
    return
  }

  const workspace = resolveWorkspace(settings, log)
  const bridge = createBridge({
    controller: ctx.sessionController,
    log,
    agentPreset: settings.agentPreset,
    workspace,
    maxWaitMs: settings.maxWaitMs,
  })

  const allowed = new Set(settings.allowOpenIds)
  /** 已经处理过的 msg_id，用于忽略重复投递。 */
  const seen = new Set()
  /** @type {{ controller: AbortController, client: QqBotClient, credentials: { appId: string, clientSecret: string, source: string } } | null} */
  let active = null

  state.set({
    status: 'starting',
    codeVersion: CODE_VERSION,
    workspace,
    agentPreset: settings.agentPreset,
    apiBase: settings.apiBase,
    intents: settings.intents,
  })

  /**
   * 处理一条入站消息。
   * @param {QqBotClient} client 收到消息的那个通道。
   * @param {any} message 归一化后的消息。
   */
  async function handleMessage(client, message) {
    if (message.msgId !== '') {
      if (seen.has(message.msgId)) return
      seen.add(message.msgId)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }
    if (allowed.size > 0 && !allowed.has(message.target) && !allowed.has(message.authorId)) {
      log('info', `忽略未授权来源 ${message.kind}:${message.target}`)
      return
    }
    if (message.content.trim() === '') {
      await client.reply(message, '（消息内容为空）').catch((error) => log('warn', `回复失败：${describeClientError(error)}`))
      return
    }

    const sessionId = sessionIdFor(message.kind, message.target)

    // 两条本地指令：不占用 DSH 轮次，专门用来确认「消息到底有没有到我这儿」。
    const command = message.content.trim().toLowerCase()
    if (command === '/ping' || command === '/help') {
      const snapshot = state.snapshot
      const lines =
        command === '/ping'
          ? [
              'pong ✅',
              `网关状态：${snapshot.status ?? 'unknown'}${active === null ? '（通道未启动）' : ''}`,
              `凭据：${snapshot.appId ? `已配置（${snapshot.credentialSource}）` : '未配置'}`,
              `本会话：${sessionId}`,
              `工作目录：${workspace}`,
              `预设：${settings.agentPreset}`,
            ]
          : [
              '在 QQ 里直接发消息，内容会交给 DSH 处理；每个 QQ 用户 / 每个群各自对应一个独立会话。',
              '',
              '可用指令：',
              '/ping —— 看通道状态',
              '/help —— 看这段说明',
            ]
      log('info', `本地指令 ${command} ← ${message.kind}:${message.target}`)
      await client.reply(message, lines.join('\n')).catch((error) => log('warn', `回复失败：${describeClientError(error)}`))
      return
    }

    log('info', `${message.kind}:${message.target} → ${sessionId}：${message.content.slice(0, 80)}`)
    state.set({ lastMessageAt: Date.now(), lastTarget: `${message.kind}:${message.target}`, lastSessionId: sessionId, busy: true })

    let ackTimer
    if (settings.ackAfterMs > 0) {
      ackTimer = setTimeout(() => {
        client.reply(message, settings.ackText).catch(() => {})
      }, settings.ackAfterMs)
      ackTimer.unref?.()
    }

    try {
      const outcome = await bridge.ask(message.kind, message.target, message.content)
      clearTimeout(ackTimer)
      const text = normalizeReply(outcome.text)
      const summary = `[${describeReason(outcome.reason)}${outcome.timedOut ? '，等待超时' : ''}，${(outcome.waitedMs / 1000).toFixed(1)}s]`
      const body = text === '' ? `（本轮没有产生文本回答）${summary}` : `${text}\n\n${summary}`
      const chunks = splitText(body, settings.replyChunkChars)
      for (const chunk of chunks) await client.reply(message, chunk)
      log('info', `${sessionId} 回复完成：${summary}`)
      state.set({ busy: false, lastReplyAt: Date.now(), lastSummary: summary, lastReplyChars: body.length })
    } catch (error) {
      clearTimeout(ackTimer)
      const detail = error instanceof Error ? error.stack ?? error.message : String(error)
      log('error', `处理 ${sessionId} 失败：${detail}`)
      state.set({ busy: false, lastError: detail, lastErrorAt: Date.now() })
      await client
        .reply(message, `处理失败：${error instanceof Error ? error.message : String(error)}`)
        .catch((replyError) => log('warn', `失败回执也发不出去：${describeClientError(replyError)}`))
    }
  }

  /**
   * 用一组凭据启动通道。
   * @param {{ appId: string, clientSecret: string, source: string }} credentials 已解析的凭据。
   */
  function startChannel(credentials) {
    const controller = new AbortController()
    const client = new QqBotClient({
      appId: credentials.appId,
      clientSecret: credentials.clientSecret,
      apiBase: settings.apiBase,
      intents: settings.intents,
      signal: controller.signal,
    })
    active = { controller, client, credentials }

    client.on('log', ({ level, message }) => {
      log(level, message)
      state.note(`${level}: ${message}`)
    })
    client.on('status', ({ state: connectionState, detail }) => {
      state.set({ status: connectionState, lastDetail: detail ?? null })
      if (connectionState === 'ready') {
        log('info', `已连接到 QQ 网关${detail?.resumed ? '（会话已恢复）' : ''}`)
        return
      }
      if (connectionState === 'connecting' || connectionState === 'reconnecting') log('info', `网关状态：${connectionState}`)
      else if (connectionState === 'closed') {
        log('warn', `网关已断开：${typeof detail === 'object' ? JSON.stringify(detail) : detail}`)
      }
    })
    client.on('message', (message) => {
      void handleMessage(client, message)
    })

    log('info', `凭据来源：${credentials.source}；工作目录：${workspace}`)
    state.note(`凭据来源：${credentials.source}；工作目录：${workspace}`)
    state.set({ appId: credentials.appId, credentialSource: credentials.source })
    void client.start()
  }

  /**
   * 停掉当前通道。
   * @param {string} reason 停止原因（写日志用）。
   */
  function stopChannel(reason) {
    if (active === null) return
    const { controller, client } = active
    active = null
    controller.abort()
    client.stop()
    log('info', `通道已停止（${reason}）`)
  }

  /**
   * 读一次凭据，按需启动 / 重启通道。
   *
   * 凭据在插件挂载时未必就绪，所以不能像以前那样「没有就 return」；
   * 这里做成可重复调用，由下面的轮询驱动。
   */
  function reconcile() {
    const credentials = resolveCredentials(settings)
    if (credentials.appId === '' || credentials.clientSecret === '') {
      stopChannel('凭据缺失')
      log(
        'warn',
        '缺少 appId/clientSecret，通道未启动。请在插件配置、环境变量（DSH_QQ_APP_ID / DSH_QQ_CLIENT_SECRET）或 ~/.dsh/qq-bot.json 中提供；补上后插件会自动生效，无需重启。',
      )
      state.set({ status: 'missing-credentials', credentialSource: credentials.source })
      return
    }
    const unchanged =
      active !== null && active.credentials.appId === credentials.appId && active.credentials.clientSecret === credentials.clientSecret
    if (unchanged) return
    if (active !== null) stopChannel('凭据已更新')
    startChannel(credentials)
  }

  // 凭据文件可以后补或更换：轮询内容变化，省掉「改凭据就得重启 DSH」。
  const credentialsFile = settings.credentialsFile || join(dshHome(), 'qq-bot.json')
  /** @type {string | null} */
  let credentialsSignature = null
  function pollCredentials() {
    let signature = ''
    try {
      signature = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : ''
    } catch (error) {
      log('debug', `读取凭据文件失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (signature === credentialsSignature) return
    credentialsSignature = signature
    reconcile()
  }

  ctx.effect(() => {
    pollCredentials()
    const timer = setInterval(pollCredentials, settings.credentialsPollMs)
    timer.unref?.()
    log('info', '插件已加载，等待 QQ 网关连接')
    state.note(`插件已加载（凭据文件：${credentialsFile}）`)
    return () => {
      clearInterval(timer)
      stopChannel('插件卸载')
      state.set({ status: 'stopped' })
    }
  }, 'qq-bot.gateway')
}
