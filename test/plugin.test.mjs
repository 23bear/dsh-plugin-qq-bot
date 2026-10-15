/**
 * 插件入口的离线端到端测试：用假 WebSocket + 假 fetch + 假 sessionController
 * 驱动真正的 lib/index.js，跑通「收消息 → 投递 DSH → 取回答 → 回 QQ」。
 *
 * `@deepseek-ai/schemastery` 在 DSH 之外不可解析，这里用 resolve hook 兜底成一个
 * 极简 shim；在 profile 里跑时会正常解析到真包。
 */

import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHIM_SOURCE = `
const chain = () => {
  const node = {}
  node.default = () => node
  node.optional = () => node
  node.description = () => node
  return node
}
const z = {
  string: chain,
  number: chain,
  boolean: chain,
  natural: chain,
  array: chain,
  any: chain,
  object: (shape) => shape,
}
export default z
`
const SHIM_URL = `data:text/javascript,${encodeURIComponent(SHIM_SOURCE)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== '@deepseek-ai/schemastery') return nextResolve(specifier, context)
    try {
      return nextResolve(specifier, context)
    } catch {
      return { url: SHIM_URL, shortCircuit: true }
    }
  },
})

/** 假的 WebSocket，行为和 test/gateway.test.mjs 里的一致。 */
class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 1
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  serverSend(payload) {
    this.emit('message', { data: JSON.stringify(payload) })
  }
}

function respond(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    headers: { get: () => undefined },
  }
}

/** 假 fetch：token、网关、以及把发出的消息记录到 `sent`。 */
function installFakeFetch(sent) {
  return async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === '/app/getAppAccessToken') return respond(200, { access_token: 'tok', expires_in: '7200' })
    if (path === '/gateway/bot') return respond(200, { url: 'wss://example.invalid/websocket', shards: 1 })
    if (path.startsWith('/v2/') || path.startsWith('/channels/')) {
      sent.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      return respond(200, { id: 'sent' })
    }
    return respond(404, { err_code: 404, message: 'not found' })
  }
}

/** 假 Session：事件数组 + seq/eventAt。 */
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

/** 假 sessionController：prompt 之后立刻产生一轮「正常完成」。 */
function makeSessionController() {
  const sessions = new Map()
  const calls = []
  return {
    calls,
    sessions,
    async create(request) {
      calls.push(['create', request.sessionId])
      if (!sessions.has(request.sessionId)) sessions.set(request.sessionId, new FakeSession())
    },
    async resolveAgent(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) return { error: { code: 'session/not-found' } }
      return { agent: { id: sessionId, session } }
    },
    async prompt(request, signal) {
      // 复刻真实 `@Remote` 门面：signal 是必传的，缺了就抛 TypeError。
      signal.throwIfAborted()
      calls.push(['prompt', request.sessionId])
      const session = sessions.get(request.sessionId)
      const text = request.content[0].text
      session.push('turn/start', { turn: 1 })
      setTimeout(() => {
        session.push('assistant/message', { message: { content: [{ type: 'text', text: `收到：${text}` }] } })
        session.push('turn/end', { reason: { kind: 'completed' } })
      }, 10).unref?.()
    },
  }
}

/** 假 Cordis 上下文。 */
function makeCtx(controller) {
  const logs = { info: [], warn: [], error: [], debug: [] }
  const effectDisposers = []
  return {
    logs,
    effectDisposers,
    sessionController: controller,
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
      debug: (message) => logs.debug.push(message),
    },
    effect(callback) {
      const disposer = callback()
      effectDisposers.push(disposer)
      return disposer
    },
  }
}

/** 等到条件成立（轮询）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'qq-bot-test-'))
  process.env.DSH_HOME = home
  return home
}

test('没有凭据时：插件加载但不连网关，并写出状态文件', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const plugin = await import('../lib/index.js')
  const ctx = makeCtx(makeSessionController())

  try {
    plugin.apply(ctx, { credentialsPollMs: 200 })
    const stateFile = join(home, 'qq-bot-state.json')
    assert.ok(existsSync(stateFile), '应该写出状态文件')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.status, 'missing-credentials')
    assert.ok(ctx.logs.warn.some((line) => line.includes('缺少 appId/clientSecret')))
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('凭据后补：补上文件后自动连网关，改凭据后自动换连接（无需重启）', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const sent = []
  globalThis.fetch = installFakeFetch(sent)
  globalThis.WebSocket = FakeWebSocket

  const plugin = await import('../lib/index.js')
  const controller = makeSessionController()
  const ctx = makeCtx(controller)

  try {
    plugin.apply(ctx, { credentialsPollMs: 200 })
    assert.equal(FakeWebSocket.instances.length, 0, '一开始没有凭据，不该连网关')

    // 后补凭据文件 → 插件应当自己起来。
    writeFileSync(join(home, 'qq-bot.json'), JSON.stringify({ appId: 'APPID', clientSecret: 'SECRET' }), 'utf8')
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 1, 4000), '补上凭据后应自动连网关')

    const first = FakeWebSocket.instances[0]
    first.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    first.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's1' } })

    // 换一组凭据 → 旧连接关闭，新连接建立。
    writeFileSync(join(home, 'qq-bot.json'), JSON.stringify({ appId: 'APPID2', clientSecret: 'SECRET2' }), 'utf8')
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 2, 4000), '改凭据后应重建连接')
    assert.equal(first.readyState, 3, '旧连接应被关闭')

    const second = FakeWebSocket.instances[1]
    second.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    second.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's2' } })
    second.serverSend({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENT9',
      d: { id: 'MSG9', content: '还好吗', author: { user_openid: 'U9' } },
    })

    assert.ok(await waitFor(() => sent.length >= 1, 3000), '新连接也要能正常收发')
    assert.equal(sent[0].path, '/v2/users/U9/messages')
    assert.match(sent[0].body.content, /收到：还好吗/)
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('有凭据时：接到 QQ 消息后投递 DSH 并把回答发回 QQ', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const sent = []
  globalThis.fetch = installFakeFetch(sent)
  globalThis.WebSocket = FakeWebSocket

  const plugin = await import('../lib/index.js')
  const controller = makeSessionController()
  const ctx = makeCtx(controller)

  try {
    plugin.apply(ctx, { appId: 'APPID', clientSecret: 'SECRET', ackAfterMs: 0 })
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 1), '应该建立 WebSocket 连接')

    const socket = FakeWebSocket.instances[0]
    assert.equal(socket.url, 'wss://example.invalid/websocket')
    socket.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: { username: 'bot' } } })

    socket.serverSend({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENT1',
      d: { id: 'MSG1', content: ' 你好 ', author: { user_openid: 'U1' } },
    })

    assert.ok(await waitFor(() => sent.length >= 1), '应该把回答发回 QQ')
    const reply = sent[0]
    assert.equal(reply.path, '/v2/users/U1/messages')
    assert.equal(reply.body.msg_id, 'MSG1')
    assert.equal(reply.body.msg_seq, 1)
    assert.match(reply.body.content, /收到：你好/)
    assert.match(reply.body.content, /正常完成/)

    // DSH 侧确实建了会话并投递了同一条消息。
    assert.deepEqual(controller.calls, [
      ['create', 'session-qq-c2c-U1'],
      ['prompt', 'session-qq-c2c-U1'],
    ])

    const state = JSON.parse(readFileSync(join(home, 'qq-bot-state.json'), 'utf8'))
    assert.equal(state.status, 'ready')
    assert.equal(state.lastSessionId, 'session-qq-c2c-U1')
    assert.equal(state.busy, false)
    assert.ok(state.events.some((entry) => entry.message.includes('access_token 已获取')))
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('无文本回答时给出兜底文案', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const sent = []
  globalThis.fetch = installFakeFetch(sent)
  globalThis.WebSocket = FakeWebSocket

  const plugin = await import('../lib/index.js')
  const controller = makeSessionController()
  // 让这一轮只产生工具调用、没有任何文本块。
  controller.prompt = async (request, signal) => {
    signal.throwIfAborted()
    const session = controller.sessions.get(request.sessionId)
    session.push('turn/start', { turn: 1 })
    setTimeout(() => {
      session.push('assistant/message', { message: { content: [{ type: 'reasoning', text: '只想了' }] } })
      session.push('turn/end', { reason: { kind: 'max-tokens' } })
    }, 10).unref?.()
  }
  const ctx = makeCtx(controller)

  try {
    plugin.apply(ctx, { appId: 'APPID', clientSecret: 'SECRET', ackAfterMs: 0 })
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 1))
    const socket = FakeWebSocket.instances[0]
    socket.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's' } })
    socket.serverSend({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      id: 'EVENT2',
      d: { id: 'MSG2', content: '在吗', group_openid: 'G1', author: { member_openid: 'M1' } },
    })

    assert.ok(await waitFor(() => sent.length >= 1))
    assert.equal(sent[0].path, '/v2/groups/G1/messages')
    assert.match(sent[0].body.content, /没有产生文本回答/)
    assert.match(sent[0].body.content, /达到输出上限/)
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('本地指令 /ping 直接回复通道状态，不占用 DSH 轮次', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const sent = []
  globalThis.fetch = installFakeFetch(sent)
  globalThis.WebSocket = FakeWebSocket

  const plugin = await import('../lib/index.js')
  const controller = makeSessionController()
  const ctx = makeCtx(controller)

  try {
    plugin.apply(ctx, { appId: 'APPID', clientSecret: 'SECRET', ackAfterMs: 0, credentialsPollMs: 200 })
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 1))
    const socket = FakeWebSocket.instances[0]
    socket.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's' } })
    socket.serverSend({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENTP',
      d: { id: 'MSGP', content: '/ping', author: { user_openid: 'UP' } },
    })

    assert.ok(await waitFor(() => sent.length >= 1), '应该立刻回复')
    assert.match(sent[0].body.content, /pong/)
    assert.match(sent[0].body.content, /session-qq-c2c-UP/)
    assert.equal(controller.calls.length, 0, '不该创建会话或投递 prompt')
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('白名单外的来源被忽略', async () => {
  const home = setupHome()
  FakeWebSocket.instances = []
  const sent = []
  globalThis.fetch = installFakeFetch(sent)
  globalThis.WebSocket = FakeWebSocket

  const plugin = await import('../lib/index.js')
  const controller = makeSessionController()
  const ctx = makeCtx(controller)

  try {
    plugin.apply(ctx, { appId: 'APPID', clientSecret: 'SECRET', allowOpenIds: ['U-OTHER'], ackAfterMs: 0 })
    assert.ok(await waitFor(() => FakeWebSocket.instances.length === 1))
    const socket = FakeWebSocket.instances[0]
    socket.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's' } })
    socket.serverSend({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENT3',
      d: { id: 'MSG3', content: 'hi', author: { user_openid: 'U1' } },
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(sent.length, 0)
    assert.equal(controller.calls.length, 0)
    assert.ok(ctx.logs.info.some((line) => line.includes('忽略未授权来源')))
  } finally {
    for (const disposer of ctx.effectDisposers) disposer?.()
    rmSync(home, { recursive: true, force: true })
  }
})
