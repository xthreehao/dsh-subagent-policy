/**
 * 结构化诊断快照：把「插件到底挂到哪些会话上、数到了谁、拦了几次」写成一个 JSON 文件。
 *
 * 为什么需要：打包后的宿主拿不到 stdout，管理面又要 token，一旦用户报「徽标显示 0」
 * 就没有任何证据可看。诊断文件放在 storages 目录下，随时能被外部读取。
 * 上限都写死在这儿（环形缓冲），永远不会无限增长；写盘去抖 1 秒。
 */

import { existsSync, readFileSync } from 'node:fs'

const NOTE_LIMIT = 40
const AGENT_LIMIT = 32
const COUNT_LIMIT = 60
const TURN_LIMIT = 20

function pushRing(list, item, limit) {
  list.push(item)
  if (list.length > limit) list.splice(0, list.length - limit)
}

/**
 * @param {object} options
 * @param {{writeDiag: (diag: object) => void, diagPath: () => string}} options.store
 * @param {string} [options.version] - 插件版本，方便确认跑的是哪份代码
 * @param {number} [options.flushDelayMs] - 写盘去抖
 */
export function createDiag(options) {
  const store = options.store
  const version = typeof options.version === 'string'
    ? options.version
    : (typeof options.version === 'number' ? String(options.version) : 'unknown')
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? options.flushDelayMs : 1000

  const state = {
    plugin: 'dsh-subagent-policy',
    version,
    startedAt: new Date().toISOString(),
    agents: {},
    counted: [],
    turns: [],
    notes: [],
  }

  let timer = null
  let dirty = false

  function flush() {
    timer = null
    if (dirty === false) return
    dirty = false
    store.writeDiag(state)
  }

  function schedule() {
    dirty = true
    if (timer !== null) return
    timer = setTimeout(flush, flushDelayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    /** 一条自由文本事件（环形）。 */
    note(text) {
      pushRing(state.notes, { at: new Date().toISOString(), text: String(text) }, NOTE_LIMIT)
      schedule()
    },
    /** 某个 agent 被挂上（或明确跳过）。 */
    agent(sessionId, info) {
      const id = String(sessionId)
      if (Object.keys(state.agents).length >= AGENT_LIMIT && state.agents[id] === undefined) return
      state.agents[id] = { ...info, at: new Date().toISOString() }
      schedule()
    },
    /** 一次子代理计数（父会话 / 子会话 / 归属来源）。 */
    counted(parentSessionId, childId, via) {
      pushRing(state.counted, {
        at: new Date().toISOString(),
        parent: String(parentSessionId),
        child: String(childId),
        via: String(via),
      }, COUNT_LIMIT)
      // 计数是「徽标显示 0」的核心证据：立刻落盘，别让去抖卡在进程退出前
      dirty = true
      flush()
    },
    /** 一次 turn-stopping 判定（拦 / 放 / 为什么）。 */
    turn(sessionId, info) {
      pushRing(state.turns, { at: new Date().toISOString(), session: String(sessionId), ...info }, TURN_LIMIT)
      dirty = true
      flush()
    },
    flush,
    path: () => store.diagPath(),
  }
}

/** 读回一份诊断快照（外部排障用；坏文件返回 undefined）。 */
export function readDiagFile(path) {
  if (typeof path !== 'string' || existsSync(path) === false) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
