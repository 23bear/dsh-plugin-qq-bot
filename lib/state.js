/**
 * 运行状态落盘：把通道的连接状态、最近事件、最近错误写到一个 JSON 文件，
 * 方便在 GUI 之外确认插件是否真的跑起来了（腾讯侧出问题时也不用翻日志）。
 * @module dsh-plugin-qq-bot/state
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 只保留最近多少条事件。 */
const EVENT_KEEP = 30

/**
 * 创建一个状态写入器。
 * @param {string} file 目标文件路径。
 * @param {(level: string, message: string) => void} [log] 写盘失败时的日志回调。
 * @returns {{ set: (patch: Record<string, unknown>) => void, note: (message: string) => void, file: string, snapshot: Record<string, unknown> }} 写入器。
 */
export function createStateWriter(file, log) {
  let state = {
    plugin: 'dsh-plugin-qq-bot',
    startedAt: Date.now(),
    status: 'starting',
    events: [],
  }

  const flush = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      log?.('warn', `写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    /** 合并一批字段并落盘。 */
    set(patch) {
      state = { ...state, ...patch, updatedAt: Date.now() }
      flush()
    },
    /** 追加一条事件并落盘。 */
    note(message) {
      state = {
        ...state,
        updatedAt: Date.now(),
        events: [...state.events.slice(-(EVENT_KEEP - 1)), { at: Date.now(), message }],
      }
      flush()
    },
    /** 状态文件路径。 */
    get file() {
      return file
    },
    /** 当前快照（不落盘）。 */
    get snapshot() {
      return state
    },
  }
}
