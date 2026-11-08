import assert from 'node:assert/strict'
import test from 'node:test'

import { createCounters } from '../lib/counters.js'

/** 假时钟：clock 可传入 createCounters，advance 手动推进时间。 */
function fakeClock(start = 1_000) {
  const state = { now: start }
  return {
    clock: () => state.now,
    advance(ms) {
      state.now += ms
    },
  }
}

const SID = 'session-abc-123'

test('默认配置：settleMs 为 5000，非法 settleMs 回落', () => {
  const defaults = createCounters()
  assert.equal(defaults.settleMs, 5000)
  // 未暴露 clock，用行为验证：刚 noteStart 后结算倒计时接近一个整窗口。
  defaults.noteStart(SID, 'child-1')
  const remaining = defaults.settleIn(SID)
  assert.ok(remaining > 4000 && remaining <= 5000, 'settleIn 应接近 5000，实际 ' + remaining)

  const custom = createCounters({ settleMs: 2000 })
  assert.equal(custom.settleMs, 2000)
  assert.equal(createCounters({ settleMs: 0 }).settleMs, 5000, '0 非法应回落 5000')
  assert.equal(createCounters({ settleMs: -1 }).settleMs, 5000, '负数非法应回落 5000')
})

test('noteStart 按 childId 去重', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart(SID, 'child-a')
  const again = counters.noteStart(SID, 'child-a')
  assert.deepEqual(again, { used: 1, window: 1, total: 1 }, '同一 childId 不应重复计数')

  const other = counters.noteStart(SID, 'child-b')
  assert.deepEqual(other, { used: 2, window: 2, total: 2 })
  assert.equal(counters.used(SID), 2)
  assert.equal(counters.total(SID), 2)
})

test('窗口结算后 windowCount 归零但 used/total 不变', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart(SID, 'child-a')
  counters.noteStart(SID, 'child-b')
  assert.equal(counters.windowCount(SID), 2)
  assert.equal(counters.used(SID), 2)

  clock.advance(5000)
  assert.equal(counters.windowCount(SID), 0, '限流口径应结算归零')
  assert.equal(counters.used(SID), 2, '达标口径不随窗口结算变化')
  assert.equal(counters.total(SID), 2, 'total 永不清零')
})

test('未到 settleMs 时窗口不结算', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart(SID, 'child-a')
  clock.advance(4999)
  assert.equal(counters.windowCount(SID), 1)
  assert.equal(counters.settle(SID), 0, '4999ms 时不该剪掉任何条目')
})

test('settleIn 倒计时：窗口值 → 递减 → 0', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart(SID, 'child-a')
  assert.equal(counters.settleIn(SID), 5000)
  clock.advance(2000)
  assert.equal(counters.settleIn(SID), 3000)
  clock.advance(3001)
  assert.equal(counters.settleIn(SID), 0, '超过 settleMs 后应为 0')
  assert.equal(counters.settleIn('never-seen'), 0, '未知会话为 0')
})

test('resetRequest 清 window/request/corrections/metInTurn，保留 total', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart(SID, 'child-a')
  counters.noteCorrection(SID)
  counters.markMet(SID)
  assert.equal(counters.corrections(SID), 1)
  assert.equal(counters.metInTurn(SID), true)

  counters.resetRequest(SID)
  assert.equal(counters.windowCount(SID), 0)
  assert.equal(counters.used(SID), 0)
  assert.equal(counters.corrections(SID), 0)
  assert.equal(counters.metInTurn(SID), false)
  assert.equal(counters.total(SID), 1, 'total 应保留')
  assert.equal(counters.entryOf(SID).sessionCorrections, 1, 'resetRequest 不动 sessionCorrections')

  // 未知会话调用不应抛错
  assert.doesNotThrow(() => counters.resetRequest('never-seen'))
  assert.equal(counters.has('never-seen'), false)
})

test('canCorrect：默认 true、达到 maxCorrections 为 false、maxSessionCorrections 独立生效', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  assert.equal(counters.canCorrect('never-seen', 3), true, '未知会话返回 true')

  counters.noteCorrection(SID)
  assert.equal(counters.canCorrect(SID, 3), true, '未达上限仍可拦回')
  counters.noteCorrection(SID)
  counters.noteCorrection(SID)
  assert.equal(counters.corrections(SID), 3)
  assert.equal(counters.canCorrect(SID, 3), false, 'corrections 达到 maxCorrections')

  const other = createCounters({ clock: clock.clock, settleMs: 5000 })
  other.noteCorrection('s2')
  assert.equal(other.canCorrect('s2', 100, 2), true)
  assert.equal(other.canCorrect('s2', 100, 1), false, 'sessionCorrections 达上限应 false')
})

test('noteCorrection 同时累加 corrections 与 sessionCorrections', () => {
  const counters = createCounters()
  assert.deepEqual(counters.noteCorrection(SID), { corrections: 1, sessionCorrections: 1 })
  assert.deepEqual(counters.noteCorrection(SID), { corrections: 2, sessionCorrections: 2 })
  assert.equal(counters.corrections(SID), 2)
  assert.equal(counters.entryOf(SID).sessionCorrections, 2)
})

test('settleAll 跨会话结算并返回总条数', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart('s1', 'a')
  counters.noteStart('s1', 'b')
  counters.noteStart('s2', 'c')

  assert.equal(counters.settleAll(), 0, '未到点不剪')
  clock.advance(5000)
  assert.equal(counters.settleAll(), 3)
  assert.equal(counters.settleAll(), 0, '重复结算为 0')
  assert.equal(counters.used('s1'), 2, 'settleAll 不动达标口径')
})

test('snapshot 结构完整且与各查询一致', () => {
  const clock = fakeClock()
  const counters = createCounters({ clock: clock.clock, settleMs: 5000 })

  counters.noteStart('s1', 'a')
  counters.noteStart('s2', 'b')
  counters.noteStart('s2', 'c')

  const snap = counters.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['counts', 'settleIn', 'totals', 'used'])
  assert.deepEqual(Object.keys(snap.counts).sort(), ['s1', 's2'])
  for (const sessionId of ['s1', 's2']) {
    for (const field of ['counts', 'used', 'totals', 'settleIn']) {
      assert.equal(typeof snap[field][sessionId], 'number', field + ' 缺少 ' + sessionId)
    }
    assert.equal(snap.counts[sessionId], counters.windowCount(sessionId))
    assert.equal(snap.used[sessionId], counters.used(sessionId))
    assert.equal(snap.totals[sessionId], counters.total(sessionId))
    assert.equal(snap.settleIn[sessionId], counters.settleIn(sessionId))
  }
  assert.equal(snap.counts.s2, 2)
  assert.equal(snap.used.s2, 2)
  assert.equal(snap.totals.s2, 2)
  assert.equal(snap.settleIn.s1, 5000)
})

test('forget 后 has=false 且各项归零', () => {
  const counters = createCounters()
  counters.noteStart(SID, 'child-a')
  assert.equal(counters.has(SID), true)

  counters.forget(SID)
  assert.equal(counters.has(SID), false)
  assert.equal(counters.used(SID), 0)
  assert.equal(counters.windowCount(SID), 0)
  assert.equal(counters.total(SID), 0)
  assert.deepEqual(counters.sessions(), [])
})

test('noteAttempt / attempts 累计尝试次数', () => {
  const counters = createCounters()
  assert.equal(counters.attempts(SID), 0)
  assert.equal(counters.noteAttempt(SID), 1)
  assert.equal(counters.noteAttempt(SID), 2)
  assert.equal(counters.attempts(SID), 2)
})

test('markMet / metInTurn 与 entryOf 结构', () => {
  const counters = createCounters()
  assert.equal(counters.metInTurn(SID), false)
  counters.markMet(SID)
  assert.equal(counters.metInTurn(SID), true)
  assert.equal(counters.metInTurn('never-seen'), false)

  const entry = counters.entryOf(SID)
  for (const field of ['window', 'request', 'total', 'attempts', 'corrections', 'sessionCorrections', 'metInTurn']) {
    assert.ok(field in entry, 'entry 缺少字段 ' + field)
  }
  assert.equal(entry.metInTurn, true)
  assert.equal(entry.corrections, 0)
  assert.equal(entry.sessionCorrections, 0)

  assert.deepEqual(counters.sessions().sort(), [SID])
})
