/**
 * 纯内存计数：没有 cordis、没有文件、没有文案。
 *
 * 两套口径（v0.2.1 起，别合并，合并必出死循环）：
 *   - window（限流）：`settleMs` 滑动窗口内的派发数，只给 tools.guard「别再派了」用。
 *   - request（达标）：**本条用户消息**内派出的派发数，只在真人发新消息时清零；
 *     达标判定、提示词、拦回、徽标全看它。用窗口做达标口径会让模型每 5 秒被逼一轮。
 * 另加 total（本会话累计，只展示）与 corrections（拦回次数上限）。
 */

export function createCounters(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  const settleMs = Number.isFinite(options.settleMs) && options.settleMs > 0 ? options.settleMs : 5000

  /** @type {Map<string, {window: Map<string, number>, request: Set<string>, total: Set<string>, attempts: number, corrections: number, sessionCorrections: number, metInTurn: boolean}>} */
  const entries = new Map()

  function entryOf(sessionId) {
    let entry = entries.get(sessionId)
    if (entry === undefined) {
      entry = {
        window: new Map(),
        request: new Set(),
        total: new Set(),
        attempts: 0,
        corrections: 0,
        sessionCorrections: 0,
        metInTurn: false,
      }
      entries.set(sessionId, entry)
    }
    return entry
  }

  /** 把滑出窗口的条目剪掉；返回剪掉几条。只动 window，不碰 request/corrections。 */
  function settle(sessionId) {
    const entry = entries.get(sessionId)
    if (entry === undefined) return 0
    const now = clock()
    let dropped = 0
    for (const [id, at] of entry.window) {
      if (now - at >= settleMs) {
        entry.window.delete(id)
        dropped += 1
      }
    }
    return dropped
  }

  /** 给所有会话结算一次（定时器用，顺带防 Map 无限增长）。 */
  function settleAll() {
    let dropped = 0
    for (const sessionId of entries.keys()) dropped += settle(sessionId)
    return dropped
  }

  /** 记一次子代理启动。childId 天然去重（Set/Map 键）。 */
  function noteStart(sessionId, childId) {
    const entry = entryOf(sessionId)
    const id = String(childId)
    entry.window.set(id, clock())
    entry.request.add(id)
    entry.total.add(id)
    return { used: entry.request.size, window: entry.window.size, total: entry.total.size }
  }

  /** 记一次委派「尝试」（含被拒的），只用于面板展示。 */
  function noteAttempt(sessionId) {
    const entry = entryOf(sessionId)
    entry.attempts += 1
    return entry.attempts
  }

  /** 本条用户消息是否已经达标过（达标后即使窗口结算也不该再拦回）。 */
  function markMet(sessionId) {
    entryOf(sessionId).metInTurn = true
  }

  function metInTurn(sessionId) {
    return entries.get(sessionId)?.metInTurn === true
  }

  /** 真人发来新消息：这一轮从头算。 */
  function resetRequest(sessionId) {
    const entry = entries.get(sessionId)
    if (entry === undefined) return
    entry.window.clear()
    entry.request.clear()
    entry.corrections = 0
    entry.metInTurn = false
  }

  /** 限流口径：窗口内已派几个（读之前先结算）。 */
  function windowCount(sessionId) {
    settle(sessionId)
    return entries.get(sessionId)?.window.size ?? 0
  }

  /** 达标口径：本条用户消息内已派几个。 */
  function used(sessionId) {
    return entries.get(sessionId)?.request.size ?? 0
  }

  /** 本会话累计派了几个（只展示）。 */
  function total(sessionId) {
    return entries.get(sessionId)?.total.size ?? 0
  }

  /** 距窗口结算还有多少毫秒（0 = 已到点或没东西可结算）。 */
  function settleIn(sessionId) {
    const entry = entries.get(sessionId)
    if (entry === undefined || entry.window.size === 0) return 0
    const now = clock()
    let oldest = now
    for (const at of entry.window.values()) {
      if (at < oldest) oldest = at
    }
    return Math.max(0, settleMs - (now - oldest))
  }

  function corrections(sessionId) {
    return entries.get(sessionId)?.corrections ?? 0
  }

  function canCorrect(sessionId, maxCorrections, maxSessionCorrections = Number.POSITIVE_INFINITY) {
    const entry = entries.get(sessionId)
    if (entry === undefined) return true
    return entry.corrections < maxCorrections && entry.sessionCorrections < maxSessionCorrections
  }

  function noteCorrection(sessionId) {
    const entry = entryOf(sessionId)
    entry.corrections += 1
    entry.sessionCorrections += 1
    return { corrections: entry.corrections, sessionCorrections: entry.sessionCorrections }
  }

  function attempts(sessionId) {
    return entries.get(sessionId)?.attempts ?? 0
  }

  function has(sessionId) {
    return entries.has(sessionId)
  }

  function forget(sessionId) {
    entries.delete(sessionId)
  }

  /** 管理面 /state 的计数字段。 */
  function snapshot() {
    const counts = {}
    const usedMap = {}
    const totals = {}
    const settleInMap = {}
    for (const sessionId of entries.keys()) {
      counts[sessionId] = windowCount(sessionId)
      usedMap[sessionId] = used(sessionId)
      totals[sessionId] = total(sessionId)
      settleInMap[sessionId] = settleIn(sessionId)
    }
    return { counts, used: usedMap, totals, settleIn: settleInMap }
  }

  return {
    entryOf,
    settle,
    settleAll,
    noteStart,
    noteAttempt,
    markMet,
    metInTurn,
    resetRequest,
    windowCount,
    used,
    total,
    settleIn,
    corrections,
    canCorrect,
    noteCorrection,
    attempts,
    has,
    forget,
    snapshot,
    sessions: () => [...entries.keys()],
    settleMs,
  }
}
