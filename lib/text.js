/**
 * 文本分片与清洗工具。
 * @module dsh-plugin-qq-bot/text
 */

/**
 * 按「段落 → 换行 → 句末标点 → 硬切」的优先级把长文本切成不超过 limit 的片段。
 *
 * QQ 官方文档没有给出 `content` 的数值上限，只给了「消息长度超限」错误码
 * （40054007 / 40054018），所以这里按保守上限切，并在收到该错误时可以再缩小。
 *
 * @param {string} text 原始文本。
 * @param {number} limit 单片最大字符数（按 UTF-16 码元计，和 QQ 的计数一致）。
 * @returns {string[]} 至少一片；空输入返回空数组。
 */
export function splitText(text, limit) {
  const source = String(text ?? '')
  if (source.trim() === '') return []
  const max = Math.max(1, Math.floor(limit))
  if (source.length <= max) return [source]

  const pieces = []
  let rest = source
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = -1
    // 优先在段落边界切，其次换行，再次句末标点/空格。
    for (const pattern of [/\n\s*\n/g, /\n/g, /[。！？!?；;]\s*/g, /[,，、\s]/g]) {
      let match
      while ((match = pattern.exec(window)) !== null) {
        const end = match.index + match[0].length
        if (end > max * 0.5) cut = cut === -1 ? end : cut
      }
      if (cut > max * 0.5) break
    }
    if (cut <= 0) cut = max
    pieces.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest !== '') pieces.push(rest)
  return pieces.filter((piece) => piece !== '')
}

/**
 * 把一条 DSH 回答整理成适合 QQ 文本消息的内容。
 *
 * 目前只做保守处理：统一换行、去掉首尾空白、去掉会干扰阅读的零宽字符。
 * DSH 的回答经常是 Markdown；QQ 文本消息会原样显示，这里不强行转换，
 * 以免把代码块里的内容改坏。
 *
 * @param {string} text 原始回答。
 * @returns {string} 适合发送的文本。
 */
export function normalizeReply(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim()
}
