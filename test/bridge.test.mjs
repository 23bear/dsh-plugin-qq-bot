import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge, describeReason, sessionIdFor, summarizeTurn } from '../lib/bridge.js'

class FakeSession {
  constructor() {
    this.events = []
  }

  get seq() {
    return this.events.length
  }

  eventAt(seq) {
    return this.events[seq]
  }

  push(type, data) {
    this.events.push({ type, data })
  }
}

/** 造一个假的 sessionController。`behaviour(session, request)` 负责生成本轮事件。 */
function makeController(behaviour) {
  const sessions = new Map()
  const calls = []
  return {
    calls,
    sessions,
    async create(request) {
      calls.push({ kind: 'create', request, at: Date.now() })
      if (!sessions.has(request.sessionId)) sessions.set(request.sessionId, new FakeSession())
    },
    async resolveAgent(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) return { error: { code: 'session/not-found' } }
      return { agent: { id: sessionId, session } }
    },
    async prompt(request, signal) {
      // 复刻真实 `@Remote` 门面的契约：它第一行就是 `signal.throwIfAborted()`（没有 ?.）。
      // 少传 signal 会抛 TypeError —— 曾经正是这个 bug 让线上第一条消息失败。
      signal.throwIfAborted()
      calls.push({ kind: 'prompt', request, signal, at: Date.now() })
      behaviour(sessions.get(request.sessionId), request)
    },
  }
}

/** 一轮「正常完成」的事件序列。 */
function completeTurn(session, text, delayMs = 20) {
  session.push('turn/start', { turn: 1 })
  session.push('user/message', { role: 'user', content: [] })
  setTimeout(() => {
    session.push('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: `中间${text}` }] },
    })
    session.push('assistant/message', {
      turn: 1,
      step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
    session.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }, delayMs).unref?.()
}

test('sessionIdFor: 同一目标稳定且与普通会话区分', () => {
  assert.equal(sessionIdFor('c2c', 'U1'), 'session-qq-c2c-U1')
  assert.equal(sessionIdFor('c2c', 'U1'), sessionIdFor('c2c', 'U1'))
  assert.notEqual(sessionIdFor('c2c', 'U1'), sessionIdFor('group', 'U1'))
  assert.equal(sessionIdFor('group', 'G/1..x'), 'session-qq-group-G1x')
})

test('summarizeTurn: 取本轮最后一个文本块，忽略 turn/start 之前的内容', () => {
  const session = new FakeSession()
  session.push('assistant/message', { message: { content: [{ type: 'text', text: '上一轮的残留' }] } })
  const firstSeq = session.seq
  session.push('turn/start', { turn: 2 })
  session.push('assistant/message', { message: { content: [{ type: 'text', text: '第一段' }] } })
  session.push('assistant/message', { message: { content: [{ type: 'reasoning', text: '只想不算' }] } })
  session.push('assistant/message', { message: { content: [{ type: 'text', text: '最终答案' }] } })
  session.push('turn/end', { reason: { kind: 'completed' } })

  const summary = summarizeTurn(session, firstSeq)
  assert.equal(summary.text, '最终答案')
  assert.deepEqual(summary.reason, { kind: 'completed' })
})

test('summarizeTurn: 未结束时 reason 为 undefined', () => {
  const session = new FakeSession()
  session.push('turn/start', { turn: 1 })
  session.push('assistant/message', { message: { content: [{ type: 'text', text: '还没说完' }] } })
  assert.deepEqual(summarizeTurn(session, 0), { text: '还没说完', reason: undefined })
})

test('bridge: create → resolveAgent → prompt 的顺序正确，回答能取回', async () => {
  const controller = makeController((session, request) => completeTurn(session, `答：${request.content[0].text}`))
  const bridge = createBridge({ controller, log: () => {}, agentPreset: 'standard', workspace: 'C:/ws', maxWaitMs: 5000, pollMs: 5 })

  const outcome = await bridge.ask('c2c', 'U1', '你好')
  assert.equal(outcome.sessionId, 'session-qq-c2c-U1')
  assert.equal(outcome.text, '答：你好')
  assert.equal(outcome.reason.kind, 'completed')
  assert.equal(outcome.timedOut, undefined)

  assert.deepEqual(
    controller.calls.map((call) => call.kind),
    ['create', 'prompt'],
  )
  const create = controller.calls[0].request
  assert.equal(create.sessionId, 'session-qq-c2c-U1')
  assert.equal(create.cwd, 'C:/ws')
  assert.equal(create.agentPreset, 'standard')
  const prompt = controller.calls[1].request
  assert.equal(prompt.sessionId, 'session-qq-c2c-U1')
  assert.equal(prompt.mode, 'queue')
  assert.deepEqual(prompt.content, [{ type: 'text', text: '你好' }])
  assert.ok(typeof prompt.requestId === 'string' && prompt.requestId.length > 10)
  // `sessionController.prompt` 的第二个参数是必传的 AbortSignal。
  assert.equal(typeof controller.calls[1].signal?.throwIfAborted, 'function')
})

test('bridge: create 抛错时仍能用已有会话继续', async () => {
  const controller = makeController((session) => completeTurn(session, 'ok'))
  controller.create = async () => {
    throw new Error('session already exists elsewhere')
  }
  controller.sessions.set('session-qq-c2c-U1', new FakeSession())
  const logs = []
  const bridge = createBridge({
    controller,
    log: (level, message) => logs.push([level, message]),
    agentPreset: '',
    workspace: 'C:/ws',
    maxWaitMs: 5000,
    pollMs: 5,
  })
  const outcome = await bridge.ask('c2c', 'U1', 'hi')
  assert.equal(outcome.text, 'ok')
  assert.ok(logs.some(([level]) => level === 'debug'))
})

test('bridge: resolveAgent 解析不到会话时抛错', async () => {
  const controller = makeController(() => {})
  // 覆盖 create，模拟「会话既建不出来、也恢复不了」。
  controller.create = async () => {}
  const bridge = createBridge({ controller, log: () => {}, agentPreset: '', workspace: 'C:/ws', maxWaitMs: 100, pollMs: 5 })
  await assert.rejects(() => bridge.ask('c2c', 'missing', 'hi'), /无法激活会话/)
})

test('bridge: 同一通道串行、不同通道并行', async () => {
  const timeline = []
  const controller = makeController((session, request) => {
    timeline.push(`turn:${request.content[0].text}`)
    completeTurn(session, request.content[0].text, 40)
  })
  const bridge = createBridge({ controller, log: () => {}, agentPreset: '', workspace: 'C:/ws', maxWaitMs: 5000, pollMs: 5 })

  await Promise.all([bridge.ask('c2c', 'U1', 'A'), bridge.ask('c2c', 'U1', 'B'), bridge.ask('c2c', 'U2', 'C')])
  // U1 的两轮必须一前一后；U2 不受影响（C 可能夹在中间）。
  assert.deepEqual(
    timeline.filter((entry) => entry !== 'turn:C'),
    ['turn:A', 'turn:B'],
  )
})

test('bridge: 超时返回已有内容并带 timedOut', async () => {
  const controller = makeController((session) => {
    session.push('turn/start', { turn: 1 })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '半截话' }] } })
    // 故意不发 turn/end
  })
  const bridge = createBridge({ controller, log: () => {}, agentPreset: '', workspace: 'C:/ws', maxWaitMs: 60, pollMs: 5 })
  const outcome = await bridge.ask('c2c', 'U1', 'hi')
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.text, '半截话')
})

test('describeReason: 覆盖所有结束原因', () => {
  assert.match(describeReason({ kind: 'completed' }), /正常/)
  assert.match(describeReason({ kind: 'error', error: { code: 'X', message: 'boom' } }), /boom/)
  assert.match(describeReason({ kind: 'aborted', reason: { kind: 'user' } }), /user/)
  assert.match(describeReason(undefined), /超时/)
})
