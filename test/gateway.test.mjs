import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QqApiError, QqBotClient, normalizeMessage } from '../lib/qq-client.js'
import { DEFAULT_API_BASE, INTENT_GROUP_AND_C2C } from '../lib/protocol.js'

/** 可脚本化的假 WebSocket。 */
class FakeWebSocket {
  static instances = []

  static reset() {
    FakeWebSocket.instances = []
  }

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

  last() {
    return this.sent[this.sent.length - 1]
  }
}

/** 造一个按 path 分发的假 fetch。 */
function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const record = { url, path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: undefined }
    if (typeof init.body === 'string' && init.body !== '') record.body = JSON.parse(init.body)
    calls.push(record)
    const route = routes[path]
    const result = typeof route === 'function' ? route(record) : route
    if (result === undefined) return respond(404, { message: 'not found' })
    return respond(result.status ?? 200, result.body)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function respond(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    headers: { get: () => undefined },
  }
}

const tokenOk = { body: { access_token: 'tok-1', expires_in: '7200' } }
const gatewayOk = { body: { url: 'wss://api.bot.qq.com/websocket', shards: 1 } }

/** 造一个已经完成 token + gateway + Hello 的客户端。 */
async function connectedClient(extraRoutes = {}) {
  FakeWebSocket.reset()
  const fetchImpl = makeFetch({
    '/app/getAppAccessToken': tokenOk,
    '/gateway/bot': gatewayOk,
    ...extraRoutes,
  })
  const client = new QqBotClient({
    appId: 'APPID',
    clientSecret: 'SECRET',
    fetchImpl,
    webSocketImpl: FakeWebSocket,
  })
  const statuses = []
  client.on('status', (status) => statuses.push(status))
  await client.start()
  const socket = FakeWebSocket.instances.at(-1)
  socket.serverSend({ op: 10, d: { heartbeat_interval: 45_000 } })
  return { client, fetchImpl, socket, statuses }
}

test('token 与网关请求：路径、请求体、Authorization 头', async () => {
  const { client, fetchImpl, socket } = await connectedClient()
  try {
    const tokenCall = fetchImpl.calls.find((call) => call.path === '/app/getAppAccessToken')
    assert.deepEqual(tokenCall.body, { appId: 'APPID', clientSecret: 'SECRET' })
    assert.equal(tokenCall.method, 'POST')

    const gatewayCall = fetchImpl.calls.find((call) => call.path === '/gateway/bot')
    assert.equal(gatewayCall.headers.Authorization, 'QQBot tok-1')

    assert.equal(socket.url, 'wss://api.bot.qq.com/websocket')
    assert.equal(DEFAULT_API_BASE, 'https://api.bot.qq.com')
  } finally {
    client.stop()
  }
})

test('Identify：token 前缀、intents、shard、properties', async () => {
  const { client, socket } = await connectedClient()
  try {
    const identify = socket.sent.find((frame) => frame.op === 2)
    assert.ok(identify, '应该发出 op 2 Identify')
    assert.equal(identify.d.token, 'QQBot tok-1')
    assert.equal(identify.d.intents, INTENT_GROUP_AND_C2C)
    assert.deepEqual(identify.d.shard, [0, 1])
    assert.ok(identify.d.properties)
  } finally {
    client.stop()
  }
})

test('READY 之后进入 ready，派发消息事件', async () => {
  const { client, socket, statuses } = await connectedClient()
  try {
    const messages = []
    client.on('message', (message) => messages.push(message))
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: { username: 'bot' } } })
    assert.equal(client.sessionId, 'sess-1')
    assert.equal(statuses.at(-1).state, 'ready')

    socket.serverSend({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENT1',
      d: { id: 'MSG1', content: ' 你好 ', author: { user_openid: 'U1' } },
    })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].kind, 'c2c')
    assert.equal(messages[0].target, 'U1')
    assert.equal(messages[0].content, '你好')
    assert.equal(client.lastSeq, 2)
  } finally {
    client.stop()
  }
})

test('心跳按 Hello 给的周期发送，首帧 d 为 null', async () => {
  FakeWebSocket.reset()
  const fetchImpl = makeFetch({ '/app/getAppAccessToken': tokenOk, '/gateway/bot': gatewayOk })
  const client = new QqBotClient({ appId: 'A', clientSecret: 'S', fetchImpl, webSocketImpl: FakeWebSocket })
  try {
    await client.start()
    const socket = FakeWebSocket.instances.at(-1)
    socket.serverSend({ op: 10, d: { heartbeat_interval: 20 } })
    await new Promise((resolve) => setTimeout(resolve, 70))
    const beats = socket.sent.filter((frame) => frame.op === 1)
    assert.ok(beats.length >= 2, `应该发出心跳，实际 ${beats.length}`)
    assert.equal(beats[0].d, null)
  } finally {
    client.stop()
  }
})

test('回复：单聊/群聊路径与 msg_seq 递增', async () => {
  const { client, fetchImpl, socket } = await connectedClient({
    '/v2/users/U1/messages': { body: { id: 'x' } },
    '/v2/groups/G1/messages': { body: { id: 'y' } },
  })
  try {
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: {} } })
    const c2c = normalizeMessage({ id: 'E1', t: 'C2C_MESSAGE_CREATE', d: { id: 'M1', content: 'a', author: { user_openid: 'U1' } } })
    const group = normalizeMessage({ id: 'E2', t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'M2', content: 'b', group_openid: 'G1', author: { member_openid: 'M9' } } })

    const first = await client.reply(c2c, '第一条')
    assert.deepEqual(first, { mode: 'passive', seq: 1 })
    const second = await client.reply(c2c, '第二条')
    assert.deepEqual(second, { mode: 'passive', seq: 2 })
    await client.reply(group, '群消息')

    const sends = fetchImpl.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/v2/'))
    assert.equal(sends[0].path, '/v2/users/U1/messages')
    assert.deepEqual(sends[0].body, { content: '第一条', msg_type: 0, msg_id: 'M1', msg_seq: 1 })
    assert.deepEqual(sends[1].body, { content: '第二条', msg_type: 0, msg_id: 'M1', msg_seq: 2 })
    assert.equal(sends[2].path, '/v2/groups/G1/messages')
    assert.deepEqual(sends[2].body, { content: '群消息', msg_type: 0, msg_id: 'M2', msg_seq: 1 })
    for (const send of sends) assert.equal(send.headers.Authorization, 'QQBot tok-1')
  } finally {
    client.stop()
  }
})

test('被动回复被拒时退回主动消息（不带 msg_id/msg_seq）', async () => {
  let passiveRejected = false
  const { client, socket } = await connectedClient({
    '/v2/users/U1/messages': (call) => {
      if (call.body.msg_id !== undefined && !passiveRejected) {
        passiveRejected = true
        return { body: { err_code: 40034005, message: '回复消息msg_id已过期', trace_id: 't1' } }
      }
      return { body: { id: 'sent' } }
    },
  })
  try {
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: {} } })
    const c2c = normalizeMessage({ id: 'E1', t: 'C2C_MESSAGE_CREATE', d: { id: 'M1', content: 'a', author: { user_openid: 'U1' } } })
    const outcome = await client.reply(c2c, '内容')
    assert.deepEqual(outcome, { mode: 'active' })
  } finally {
    client.stop()
  }
})

test('群聊超过 5 次被动回复后自动改主动消息', async () => {
  const { client, socket } = await connectedClient({ '/v2/groups/G1/messages': { body: {} } })
  try {
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: {} } })
    const group = normalizeMessage({ id: 'E', t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'M1', content: 'a', group_openid: 'G1', author: {} } })
    const seqs = []
    for (let i = 0; i < 7; i++) seqs.push((await client.reply(group, `第 ${i} 条`)).seq)
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, undefined, undefined])
  } finally {
    client.stop()
  }
})

test('token 接口失败时按 body.code 判定（HTTP 仍是 200）', async () => {
  FakeWebSocket.reset()
  const fetchImpl = makeFetch({ '/app/getAppAccessToken': { body: { code: 100007, message: 'appid invalid' } } })
  const client = new QqBotClient({ appId: 'BAD', clientSecret: 'BAD', fetchImpl, webSocketImpl: FakeWebSocket })
  await assert.rejects(() => client.ensureToken(), (error) => {
    assert.ok(error instanceof QqApiError)
    assert.equal(error.code, 100007)
    return true
  })
})

test('token 会被缓存，不会每个请求都去换', async () => {
  const { client, fetchImpl, socket } = await connectedClient({
    '/gateway/bot': gatewayOk,
    '/v2/users/U1/messages': { body: { id: 'x' } },
  })
  try {
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: {} } })
    const c2c = normalizeMessage({ id: 'E', t: 'C2C_MESSAGE_CREATE', d: { id: 'M1', content: 'a', author: { user_openid: 'U1' } } })
    await client.reply(c2c, 'x')
    await client.reply(c2c, 'y')
    const tokenCalls = fetchImpl.calls.filter((call) => call.path === '/app/getAppAccessToken')
    assert.equal(tokenCalls.length, 1)
  } finally {
    client.stop()
  }
})

test('stop() 之后不再重连', async () => {
  const { client } = await connectedClient()
  client.stop()
  assert.equal(client.stopping, true)
  assert.equal(client.socket, undefined)
  assert.equal(FakeWebSocket.instances.length, 1)
})

test('子频道回复：只带 content + msg_id，没有 msg_seq / msg_type', async () => {
  const { client, fetchImpl, socket } = await connectedClient({ '/channels/C1/messages': { body: { id: 'x' } } })
  try {
    socket.serverSend({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: {} } })
    const channel = normalizeMessage({ id: 'E', t: 'AT_MESSAGE_CREATE', d: { id: 'M1', channel_id: 'C1', content: 'hi', author: { id: 'A1' } } })
    const outcome = await client.reply(channel, '回答')
    assert.deepEqual(outcome, { mode: 'passive' })

    const send = fetchImpl.calls.find((call) => call.path === '/channels/C1/messages')
    assert.deepEqual(send.body, { content: '回答', msg_id: 'M1' })
  } finally {
    client.stop()
  }
})

test('子频道超出 5 分钟窗口时改发主动消息', async () => {
  const { client, fetchImpl } = await connectedClient({ '/channels/C1/messages': { body: {} } })
  try {
    const stale = {
      eventId: '',
      msgId: 'M1',
      kind: 'channel',
      target: 'C1',
      content: 'hi',
      authorId: 'A1',
      authorName: '',
      timestamp: '',
      receivedAt: Date.now() - 10 * 60 * 1000,
      raw: {},
    }
    const outcome = await client.reply(stale, '回答')
    assert.deepEqual(outcome, { mode: 'active' })
    const send = fetchImpl.calls.find((call) => call.path === '/channels/C1/messages')
    assert.deepEqual(send.body, { content: '回答' })
  } finally {
    client.stop()
  }
})

test('凭据错误时给出可读提示，且不会去连 WebSocket', async () => {
  FakeWebSocket.reset()
  const fetchImpl = makeFetch({ '/app/getAppAccessToken': { body: { code: 10004, message: '机器人不存在' } } })
  const client = new QqBotClient({ appId: 'A', clientSecret: 'S', fetchImpl, webSocketImpl: FakeWebSocket })
  const logs = []
  client.on('log', (entry) => logs.push(entry))
  try {
    await client.start()
    const failure = logs.find((entry) => entry.level === 'error')
    assert.ok(failure, '应该记录一条 error')
    assert.match(failure.message, /AppID/)
    assert.match(failure.message, /机器人不存在/)
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    client.stop()
  }
})
