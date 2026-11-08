import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDirective, buildReminder, parseSpec, progress } from '../lib/policy.js'

test('off 不产出任何施压文本（防御：防止 off 被拼进提示词）', () => {
  const off = parseSpec('off')
  assert.equal(off.ok, true)
  assert.equal(buildDirective(off.spec, 0), '')
  assert.equal(buildDirective(off.spec, 9), '')
  assert.equal(buildReminder(off.spec, 0), '')
  assert.equal(buildReminder(off.spec, 5), '')
  // 未配置（undefined）同样不该有文本
  assert.equal(buildDirective(undefined, 0), '')
  assert.equal(buildReminder(undefined, 0), '')
})

test('上限语义：2-3 封顶到 3，2-2 与 <3 在超限后是「不达标且已超限」', () => {
  const r = (s, n) => progress(parseSpec(s).spec, n)
  assert.deepEqual(
    [r('2-3', 2).met, r('2-3', 3).met, r('2-3', 4).met, r('2-3', 4).exhausted],
    [true, true, false, true],
  )
  // 陷阱：写成 2-2（等价于「恰好 2 个」）时，派到 3 个就变成既未达标又已超限
  assert.deepEqual(
    [r('2-2', 2).met, r('2-2', 3).met, r('2-2', 3).exhausted],
    [true, false, true],
  )
  assert.deepEqual(
    [r('<3', 2).met, r('<3', 3).met, r('<3', 3).exhausted],
    [true, false, true],
  )
  // >=n 永远不算超限（所以在没有上限约束时不能指望它封顶）
  assert.deepEqual(
    [r('>=2', 9).met, r('>=2', 9).exhausted],
    [true, false],
  )
})
