import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReply, splitText } from '../lib/text.js'

test('splitText: 短文本原样返回', () => {
  assert.deepEqual(splitText('你好', 100), ['你好'])
})

test('splitText: 空输入返回空数组', () => {
  assert.deepEqual(splitText('   \n ', 100), [])
  assert.deepEqual(splitText('', 100), [])
  assert.deepEqual(splitText(undefined, 100), [])
})

test('splitText: 每片都不超过上限且内容不丢', () => {
  const source = Array.from({ length: 40 }, (_, i) => `第 ${i} 段的内容，用来把长度撑起来。`).join('\n\n')
  const pieces = splitText(source, 120)
  assert.ok(pieces.length > 1, '应该被切成多片')
  for (const piece of pieces) assert.ok(piece.length <= 120, `片段超长：${piece.length}`)
  const joined = pieces.join('')
  const normalize = (s) => s.replace(/\s+/g, '')
  assert.equal(normalize(joined), normalize(source))
})

test('splitText: 优先在段落边界切', () => {
  const source = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}`
  const pieces = splitText(source, 60)
  assert.deepEqual(pieces, ['a'.repeat(50), 'b'.repeat(50)])
})

test('splitText: 没有可切点时硬切', () => {
  const source = 'x'.repeat(25)
  const pieces = splitText(source, 10)
  assert.deepEqual(pieces, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

test('splitText: limit 小于 1 时按 1 处理', () => {
  assert.deepEqual(splitText('abc', 0), ['a', 'b', 'c'])
})

test('normalizeReply: 统一换行并去零宽字符', () => {
  assert.equal(normalizeReply('  a\r\nb\u200bc  '), 'a\nbc')
})
