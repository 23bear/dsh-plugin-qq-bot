import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessage, stripMentionPrefix } from '../lib/qq-client.js'
import { DEFAULT_INTENTS, INTENT_GROUP_AND_C2C, INTENT_PUBLIC_GUILD_MESSAGES } from '../lib/protocol.js'

test('intents: 默认值覆盖群聊@与单聊', () => {
  assert.equal(INTENT_GROUP_AND_C2C, 33554432)
  assert.equal(INTENT_PUBLIC_GUILD_MESSAGES, 1073741824)
  assert.equal(DEFAULT_INTENTS, INTENT_GROUP_AND_C2C)
  // 官方 websocket 文档页的示例值 513 只覆盖频道私域，不能拿来做默认。
  assert.notEqual(DEFAULT_INTENTS, 513)
})

test('stripMentionPrefix: 去空白并剥离残留的 @ 标签', () => {
  assert.equal(stripMentionPrefix(' /今日天气 '), '/今日天气')
  assert.equal(stripMentionPrefix('<@!12345> 你好'), '你好')
  assert.equal(stripMentionPrefix('<@12345>你好'), '你好')
  assert.equal(stripMentionPrefix(undefined), '')
})

test('normalizeMessage: 单聊', () => {
  const message = normalizeMessage({
    id: 'EVENT1',
    op: 0,
    s: 9,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'MSG1',
      content: ' 你好 ',
      timestamp: '2026-10-14T12:00:00+08:00',
      author: { user_openid: 'U1', username: '小明' },
    },
  })
  assert.equal(message.kind, 'c2c')
  assert.equal(message.target, 'U1')
  assert.equal(message.msgId, 'MSG1')
  assert.equal(message.eventId, 'EVENT1')
  assert.equal(message.content, '你好')
  assert.equal(message.authorName, '小明')
})

test('normalizeMessage: 群聊用 group_openid 作目标', () => {
  const message = normalizeMessage({
    id: 'EVENT2',
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MSG2', group_openid: 'G1', content: '<@!99> 帮我看下', author: { member_openid: 'M1' } },
  })
  assert.equal(message.kind, 'group')
  assert.equal(message.target, 'G1')
  assert.equal(message.authorId, 'M1')
  assert.equal(message.content, '帮我看下')
})

test('normalizeMessage: 群全量消息也走群通道', () => {
  const message = normalizeMessage({
    id: 'EVENT3',
    t: 'GROUP_MESSAGE_CREATE',
    d: { id: 'MSG3', group_openid: 'G2', content: 'hi', author: { member_openid: 'M2' } },
  })
  assert.equal(message.kind, 'group')
  assert.equal(message.target, 'G2')
})

test('normalizeMessage: 频道消息', () => {
  const message = normalizeMessage({
    id: 'EVENT4',
    t: 'AT_MESSAGE_CREATE',
    d: { id: 'MSG4', channel_id: 'C1', content: 'hi', author: { id: 'A1' } },
  })
  assert.equal(message.kind, 'channel')
  assert.equal(message.target, 'C1')
  assert.equal(message.content, 'hi')
})

test('normalizeMessage: 不认识的事件与缺关键字段都返回 null', () => {
  assert.equal(normalizeMessage({ t: 'READY', d: {} }), null)
  assert.equal(normalizeMessage({ t: 'C2C_MESSAGE_CREATE', d: { id: 'X', author: {} } }), null)
  assert.equal(normalizeMessage({ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'X', content: 'a' } }), null)
  assert.equal(normalizeMessage(undefined), null)
})
