#!/usr/bin/env node
/**
 * QQ ↔ DSH 链路体检工具。
 *
 * 读两处事实来源，判断这条链路走到哪一步了：
 *   1. `<DSH_HOME>/qq-bot-state.json` —— 插件自己写的通道状态；
 *   2. `<DSH_HOME>/sessions/**\/session-qq-*\/session.v4.jsonl.zstd` —— DSH 侧真实的会话日志。
 *
 * 用法：node tools/check.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const stateFile = join(dshHome, 'qq-bot-state.json')
const sessionsRoot = join(dshHome, 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const ok = (text) => `✅ ${text}`
const bad = (text) => `❌ ${text}`
const info = (text) => `   ${text}`
const stamp = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

/** 依次解压一个「多帧拼接」的 zstd 文件（DSH 的会话日志就是这么追加的）。 */
function decodeSessionLog(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (ZSTD_MAGIC.every((byte, k) => buffer[i + k] === byte)) starts.push(i)
  }
  if (starts.length === 0) return []
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const chunk = buffer.subarray(starts[k], starts[k + 1] ?? buffer.length)
    try {
      text += zlib.zstdDecompressSync(chunk).toString('utf8')
    } catch {
      /* 单帧坏掉不影响其它帧 */
    }
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* 截断的最后一行忽略 */
    }
  }
  return records
}

/** 找到所有 QQ 会话目录，按最近修改排序。 */
function findQqSessions() {
  if (!existsSync(sessionsRoot)) return []
  const found = []
  for (const workspace of readdirSync(sessionsRoot)) {
    const workspacePath = join(sessionsRoot, workspace)
    let entries
    try {
      entries = readdirSync(workspacePath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('session-qq-')) continue
      const dir = join(workspacePath, entry)
      try {
        const files = readdirSync(dir).filter((name) => name.startsWith('session.') && name.endsWith('.zstd'))
        for (const file of files) {
          const full = join(dir, file)
          found.push({ dir, file: full, mtime: statSync(full).mtimeMs, id: entry, workspace })
        }
      } catch {
        /* 忽略读不到的目录 */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

/** 从会话事件里抽出「最后一条用户消息 / 最后一条助手文本 / 最后一轮结果」。 */
function summarize(records) {
  let userText = ''
  let assistantText = ''
  let reason
  let turns = 0
  for (const record of records) {
    if (record.type === 'turn/start') turns += 1
    if (record.type === 'user/message') {
      const text = (record.data?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text !== '') userText = text
    }
    if (record.type === 'assistant/message') {
      const text = (record.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text !== '') assistantText = text
    }
    if (record.type === 'turn/end') reason = record.data?.reason
  }
  return { userText, assistantText, reason, turns }
}

console.log('=== 1. 插件状态 ===')
if (!existsSync(stateFile)) {
  console.log(bad(`找不到 ${stateFile} —— 插件还没被加载过（或状态文件没写成）。`))
} else {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const healthy = state.status === 'ready'
  console.log(healthy ? ok(`通道状态：${state.status}`) : bad(`通道状态：${state.status}`))
  console.log(
    state.codeVersion
      ? info(`运行代码版本：${state.codeVersion}`)
      : bad('运行代码版本：未知 —— 当前进程加载的是旧模块，改完代码需要重启应用才会生效'),
  )
  console.log(info(`AppID：${state.appId ?? '(未配置)'}    凭据来源：${state.credentialSource ?? '-'}`))
  console.log(info(`工作目录：${state.workspace ?? '-'}    Agent 预设：${state.agentPreset ?? '-'}`))
  console.log(info(`挂载于：${stamp(state.startedAt)}    最后更新：${stamp(state.updatedAt)}`))
  if (state.lastTarget) console.log(info(`最近一条消息来自：${state.lastTarget}`))
  if (state.lastSessionId) console.log(info(`对应 DSH 会话：${state.lastSessionId}`))
  if (state.lastSummary) console.log(info(`最近一轮结果：${state.lastSummary}`))
  if (state.lastError) console.log(bad(`最近一次错误：${state.lastError}`))
  const events = state.events ?? []
  if (events.length > 0) {
    console.log(info('最近事件：'))
    for (const entry of events.slice(-6)) console.log(info(`  ${stamp(entry.at)}  ${entry.message}`))
  }
}

console.log('\n=== 2. DSH 侧的真实会话 ===')
const sessions = findQqSessions()
if (sessions.length === 0) {
  console.log(info('还没有任何 session-qq-* 会话 —— 说明 QQ 消息还没真正走到 DSH。'))
  console.log(info('（在 QQ 里给机器人发一条消息后重跑本工具。）'))
} else {
  console.log(info(`找到 ${sessions.length} 个 QQ 会话，最新：${sessions[0].id}`))
  const records = decodeSessionLog(sessions[0].file)
  const summary = summarize(records)
  console.log(info(`事件数：${records.length}    轮次：${summary.turns}`))
  console.log(info(`最后一条用户消息：${summary.userText.slice(0, 120) || '(无)'}`))
  console.log(info(`最后一条助手回答：${summary.assistantText.slice(0, 200) || '(无)'}`))
  console.log(info(`最后结束原因：${summary.reason ? JSON.stringify(summary.reason) : '(该轮还没结束)'}`))
}

console.log('\n=== 3. 结论 ===')
if (!existsSync(stateFile)) {
  console.log(bad('插件没加载：检查 profile 是否包含 dsh-plugin-qq-bot，以及应用是否重启过。'))
} else {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (state.status !== 'ready') {
    console.log(bad(`通道未就绪（${state.status}）：看上面的最近事件找原因。`))
  } else if (!state.codeVersion) {
    console.log(bad('通道已连上，但跑的还是旧代码 —— 需要重启一次 DeepSeek Harness。'))
  } else if (state.lastError) {
    console.log(bad('最近一次处理失败：看上面的错误，修好后重发一条消息。'))
  } else if (sessions.length === 0) {
    console.log(info('通道 OK，但还没收到过 QQ 消息 —— 去 QQ 里发一条试试。'))
  } else {
    const summary = summarize(decodeSessionLog(sessions[0].file))
    if (summary.assistantText !== '') console.log(ok('链路完整：QQ 消息已进 DSH 并产出了回答。'))
    else console.log(info('消息已进 DSH，但该轮还没产出文本回答（可能仍在处理）。'))
  }
}
