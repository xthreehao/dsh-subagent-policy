import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDirective,
  buildReminder,
  describeSpec,
  isSatisfied,
  parseSpec,
  progress,
  renderSpec,
} from '../lib/policy.js'

const ok = (text) => {
  const r = parseSpec(text)
  assert.equal(r.ok, true, 'should parse: ' + text)
  return r.spec
}

const bad = (text) => {
  const r = parseSpec(text)
  assert.equal(r.ok, false, 'should reject: ' + text)
  return r.error
}

test('关闭类写法', () => {
  for (const text of ['off', 'OFF', 'none', '关闭', '不用', '0', '=0']) {
    const spec = ok(text)
    assert.equal(spec.enabled, false, text)
    assert.equal(renderSpec(spec), 'off')
  }
})

test('必须用子代理（any）', () => {
  for (const text of ['any', '*', '必须', 'on']) {
    const spec = ok(text)
    assert.equal(spec.enabled, true)
    assert.equal(spec.op, 'any')
    assert.equal(isSatisfied(spec, 0), false)
    assert.equal(isSatisfied(spec, 1), true)
    assert.equal(isSatisfied(spec, 5), true)
  }
})

test('裸数字 = 恰好 n 个', () => {
  assert.equal(renderSpec(ok('3')), '=3')
  assert.equal(isSatisfied(ok('3'), 2), false)
  assert.equal(isSatisfied(ok('3'), 3), true)
  assert.equal(isSatisfied(ok('3'), 4), false)
})

test('大于 / 不小于', () => {
  assert.equal(renderSpec(ok('>2')), '>2')
  assert.equal(isSatisfied(ok('>2'), 2), false)
  assert.equal(isSatisfied(ok('>2'), 3), true)
  for (const text of ['>=2', '≥2', '=>2']) assert.equal(renderSpec(ok(text)), '>=2', text)
  assert.equal(isSatisfied(ok('>=2'), 2), true)
  assert.equal(isSatisfied(ok('>=2'), 1), false)
})

test('小于 / 不大于', () => {
  assert.equal(renderSpec(ok('<4')), '<4')
  assert.equal(isSatisfied(ok('<4'), 3), true)
  assert.equal(isSatisfied(ok('<4'), 4), false)
  for (const text of ['<=4', '≤4', '=<4']) assert.equal(renderSpec(ok(text)), '<=4', text)
  assert.equal(isSatisfied(ok('<=4'), 4), true)
})

test('区间写法', () => {
  for (const text of ['2-4', '2..4', '2~4']) assert.equal(renderSpec(ok(text)), '2-4', text)
  const spec = ok('2-4')
  assert.equal(spec.op, 'range')
  assert.equal(isSatisfied(spec, 1), false)
  assert.equal(isSatisfied(spec, 2), true)
  assert.equal(isSatisfied(spec, 4), true)
  assert.equal(isSatisfied(spec, 5), false)
  assert.equal(bad('4-2'), 'inverted-range')
})

test('全角与空白归一', () => {
  assert.equal(renderSpec(ok('  ＞＝ 2  ')), '>=2')
  assert.equal(renderSpec(ok('３')), '=3')
  assert.equal(renderSpec(ok('  ≥ ２ ')), '>=2')
})

test('越界与非法输入', () => {
  assert.equal(bad(''), 'empty')
  assert.equal(bad('abc'), 'unrecognized')
  assert.equal(bad('65'), 'out-of-range')
  assert.equal(bad('>1000'), 'out-of-range')
  assert.equal(bad('2.5'), 'unrecognized')
  assert.equal(bad(-1), 'empty')
})

test('progress 给出剩余与超限', () => {
  const gte = ok('>=3')
  assert.deepEqual(progress(gte, 1), { met: false, have: 1, need: '>=3', remaining: 2, exhausted: false })
  assert.deepEqual(progress(gte, 3), { met: true, have: 3, need: '>=3', remaining: 0, exhausted: false })

  const eq = ok('2')
  assert.equal(progress(eq, 2).exhausted, true)
  assert.equal(progress(eq, 1).remaining, 1)

  const lt = ok('<2')
  assert.equal(progress(lt, 1).met, true)
  assert.equal(progress(lt, 1).exhausted, false)
  assert.equal(progress(lt, 2).exhausted, true)

  const range = ok('2-4')
  assert.equal(progress(range, 1).remaining, 1)
  assert.equal(progress(range, 4).met, true)
  assert.equal(progress(range, 5).exhausted, true)
})

test('提示词与拦截文案包含关键信息', () => {
  const spec = ok('>=2')
  const directive = buildDirective(spec, 1)
  assert.match(directive, /子代理策略/)
  assert.match(directive, />=2/)
  assert.match(directive, /还差 1 次/)

  const done = buildDirective(spec, 2)
  assert.match(done, /约束已满足/)

  const reminder = buildReminder(spec, 0)
  assert.match(reminder, /拦截/)
  assert.match(reminder, /还差 2 次/)

  assert.equal(describeSpec(ok('2-4')), '2 到 4 个')
  assert.equal(describeSpec(ok('any')), '至少 1 个（必须用子代理）')
})
