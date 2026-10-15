/**
 * DSH 桥接层：把一个 QQ 会话（单聊 openid / 群 group_openid）映射到一个 DSH Session，
 * 投递用户消息并把这一轮的最终回答取回来。
 *
 * 实现只依赖 Host 上公开的 `sessionController` 服务：
 * `create`（幂等创建/收养）→ `resolveAgent`（激活并拿到 live Agent）→
 * `prompt`（投递用户消息）。等待轮次结束靠轮询该 Session 的持久事件日志，
 * 与官方 headless 包 `@deepseek-ai/dsh-headless` 的取答复方式一致。
 *
 * @module dsh-plugin-qq-bot/bridge
 */

import { randomUUID } from 'node:crypto'

/** DSH Session id 前缀，用来和普通会话区分。 */
export const QQ_SESSION_PREFIX = 'session-qq-'

/**
 * 由通道键算出稳定的 Session id：同一个 QQ 用户/群永远落到同一个 DSH 会话，
 * 因此不需要额外维护映射表，DSH 自身的会话持久化就是映射。
 * @param {string} kind 通道类型（`c2c` / `group` / `channel`）。
 * @param {string} target openid / group_openid。
 * @returns {string} DSH Session id。
 */
export function sessionIdFor(kind, target) {
  const safe = `${kind}-${target}`.replace(/[^A-Za-z0-9_-]/g, '')
  return `${QQ_SESSION_PREFIX}${safe}`
}

/** 等待若干毫秒。 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 汇总从 `firstSeq` 开始的一轮对话：取最后一个非空 assistant 文本块，以及 turn/end 的原因。
 * 逻辑与 `@deepseek-ai/dsh-headless` 的 summarize 对齐（先看到 turn/start 才开始统计，
 * 因此不会把上一轮的残留算进来）。
 * @param {any} session live Session 对象（`seq` / `eventAt`）。
 * @param {number} firstSeq 轮次开始前的日志序号。
 * @returns {{ text: string, reason: any }} 文本与结束原因；未结束时 reason 为 undefined。
 */
export function summarizeTurn(session, firstSeq) {
  let started = false
  let text = ''
  let reason
  const length = Number(session.seq)
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data?.reason
  }
  return { text, reason }
}

/** 把一轮结束原因翻译成中文描述（用于日志与兜底回复）。 */
export function describeReason(reason) {
  if (reason === undefined) return '未知（超时未结束）'
  switch (reason.kind) {
    case 'completed':
      return '正常完成'
    case 'max-tokens':
      return '达到输出上限'
    case 'aborted':
      return `被中断（${reason.reason?.kind ?? 'unknown'}）`
    case 'blocked':
      return '被阻止'
    case 'error':
      return `出错（${reason.error?.code ?? 'error'}: ${reason.error?.message ?? ''}）`
    case 'interrupted':
      return '被打断'
    case 'forked':
      return '被分叉'
    default:
      return String(reason.kind ?? reason)
  }
}

/**
 * 创建桥接器。
 * @param {object} options 桥接选项。
 * @param {any} options.controller `sessionController` 服务。
 * @param {(level: string, message: string) => void} options.log 日志回调。
 * @param {string} options.agentPreset 新会话使用的 Agent 预设 id。
 * @param {string} options.workspace 新会话的工作目录（绝对路径）。
 * @param {number} options.maxWaitMs 单轮最长等待时间。
 * @param {number} [options.pollMs] 轮询间隔。
 * @param {AbortSignal} [options.signal] 投递 prompt 时传给 `sessionController` 的取消信号（必传项，缺省则用永不中止的信号）。
 * @returns {{ ask: (kind: string, target: string, text: string) => Promise<{ text: string, reason: any, sessionId: string }>, activeCount: () => number }} 桥接器。
 */
export function createBridge(options) {
  const { controller, log, agentPreset, workspace, maxWaitMs } = options
  const pollMs = options.pollMs ?? 250
  /**
   * `sessionController.prompt(request, signal)` 的 signal **不能省**：
   * 它是 `@Remote` 门面，第一行就是 `signal.throwIfAborted()`（没有 ?. 兜底），
   * 少传一个就会报 `Cannot read properties of undefined (reading 'throwIfAborted')`。
   * 这里保证永远传一个真实的 AbortSignal。
   */
  const signal = options.signal ?? new AbortController().signal
  /** 每个通道键一条串行链，保证同一个会话不会并发投递。 */
  const chains = new Map()

  /** 幂等拿到一个可用的 Session：先 create（已存在时会收养），失败则直接当已存在处理。 */
  async function ensureSession(sessionId) {
    try {
      await controller.create({
        sessionId,
        cwd: workspace,
        ...(agentPreset ? { agentPreset } : {}),
      })
    } catch (error) {
      // 已存在（例如工作目录与创建时不同）、或并发创建 —— 直接交给 resolveAgent 恢复。
      log('debug', `create(${sessionId}) 未生效，改为按已存在会话恢复：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 拿到 live Agent；resolveAgent 会按需恢复冷会话。 */
  async function requireAgent(sessionId) {
    const result = await controller.resolveAgent(sessionId)
    if (result?.error !== undefined) {
      throw new Error(`无法激活会话 ${sessionId}：${result.error?.code ?? JSON.stringify(result.error)}`)
    }
    if (result?.agent === undefined) throw new Error(`无法激活会话 ${sessionId}：resolveAgent 没有返回 agent`)
    return result.agent
  }

  /** 投递一轮并等到 turn/end。 */
  async function runTurn(kind, target, text) {
    const sessionId = sessionIdFor(kind, target)
    await ensureSession(sessionId)
    const agent = await requireAgent(sessionId)
    const firstSeq = Number(agent.session.seq)

    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      signal,
    )

    const deadline = Date.now() + maxWaitMs
    for (;;) {
      const summary = summarizeTurn(agent.session, firstSeq)
      if (summary.reason !== undefined) return { ...summary, sessionId }
      if (Date.now() >= deadline) {
        const partial = summarizeTurn(agent.session, firstSeq)
        return { ...partial, sessionId, timedOut: true }
      }
      await delay(pollMs)
    }
  }

  return {
    /**
     * 向某个通道键投递一条用户消息，返回这一轮的回答。
     * 同一通道键上的多次调用会串行执行。
     * @param {string} kind 通道类型。
     * @param {string} target openid / group_openid。
     * @param {string} text 用户消息文本。
     * @returns {Promise<{ text: string, reason: any, sessionId: string, timedOut?: boolean, waitedMs: number }>} 轮次结果。
     */
    ask(kind, target, text) {
      const key = sessionIdFor(kind, target)
      const startedAt = Date.now()
      const previous = chains.get(key) ?? Promise.resolve()
      const task = previous.then(
        () => runTurn(kind, target, text),
        () => runTurn(kind, target, text),
      )
      const settled = task.then(
        (value) => ({ ...value, waitedMs: Date.now() - startedAt }),
        (error) => {
          chains.delete(key)
          throw error
        },
      )
      chains.set(key, settled.then(() => undefined, () => undefined))
      return settled
    },
    /** 当前还在排队的通道数（用于状态展示）。 */
    activeCount() {
      return chains.size
    },
  }
}
