/**
 * client-smoke.mjs —— 浏览器半的契约冒烟：不用真浏览器，用最小 React/loader 仿真跑 lib/client.js。
 *
 * 覆盖：
 *   1. 模块通过 window.__ModuleLoader__.load 注册，id 正确，exports.apply 存在。
 *   2. apply() 在 `conversation.input.left` 上注册条目，id/order/label 正确。
 *   3. register 的 inject(sessionId) 返回 hooks.subagentPolicy（renderer 会把它转成
 *      props.useSubagentPolicy），且快照随 /state 更新。
 *   4. 组件能渲染出徽标（默认关闭时显示 '–'，有策略时显示规范 spec + 已用数量）。
 *
 * 用法：node scripts/client-smoke.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('  ✓ ' + label)
  } catch (err) {
    failures += 1
    console.log('  ✗ ' + label + '\n      ' + (err instanceof Error ? err.message : String(err)))
  }
}

// ───────────────────────────────────────────────── 最小 React 仿真

function createReactStub() {
  const hooks = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (value) => {
        if (Array.isArray(value)) { value.forEach(push); return }
        if (value === null || value === undefined || value === false) return
        flat.push(value)
      }
      push(children)
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }
      return [hooks[index], set]
    },
    /** 每次渲染前把游标归零（模拟一次 render）。 */
    __resetCursor() { cursor = 0 },
    __hooks: hooks,
  }
  return React
}

/** 把渲染结果摊平成文本，便于断言。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

function findByType(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === type) return node
  return findByType(node.children, type)
}

// ───────────────────────────────────────────────── 装载 client.js

const React = createReactStub()
const registrations = []
let loadArg

let statePayload = { defaultSpec: 'off', bySession: {}, counts: {} }

globalThis.window = globalThis
// node 24 的 navigator 只有 getter，用 defineProperty 覆盖语言（client.js 只读 language）
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true,
})
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => {
    if (String(url).indexOf('/state') >= 0) return statePayload
    return { ok: true }
  },
})
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

globalThis.__ModuleLoader__ = {
  load(arg) { loadArg = arg },
}

// 执行（client.js 是 IIFE，直接求值即可）
new Function('window', 'navigator', source)(globalThis, globalThis.navigator)

console.log('dsh-subagent-policy 浏览器半冒烟')

await check('通过 __ModuleLoader__.load 注册，id/ factory 正确', () => {
  assert.ok(loadArg !== undefined, '没有调用 load()')
  assert.equal(loadArg.id, 'dsh-subagent-policy')
  assert.equal(typeof loadArg.factory, 'function')
})

const exportsObject = loadArg.factory((id) => {
  assert.equal(id, 'react', '只允许 require("react")')
  return React
})

await check('导出 apply/inject', () => {
  assert.equal(typeof exportsObject.apply, 'function')
  assert.deepEqual(exportsObject.inject, ['slots'])
})

const disposed = []
const ctx = {
  slots: {
    inject(name, factory) {
      assert.equal(name, 'conversation.input.left')
      registrations.push({ name, registration: factory() })
      return () => disposed.push(name)
    },
    register(options, component) {
      return { options, component }
    },
  },
  effect(fn) { return fn() },
}

exportsObject.apply(ctx)

await check('在 conversation.input.left 注册条目（id/order/label）', () => {
  assert.equal(registrations.length, 1)
  const { registration } = registrations[0]
  assert.equal(registration.options.name, 'conversation.input.left')
  assert.equal(registration.options.id, 'subagent-policy.control')
  assert.equal(typeof registration.options.order, 'number')
  assert.equal(typeof registration.options.label, 'function')
  assert.equal(registration.options.label(), '子代理策略')
  assert.equal(typeof registration.component, 'function')
})

const { registration } = registrations[0]

await check('inject(sessionId) 返回 hooks.subagentPolicy（稳定快照 + subscribe）', () => {
  const injected = registration.options.inject('session-abc')
  assert.ok(injected.hooks !== undefined, '缺 hooks')
  const source = injected.hooks.subagentPolicy
  assert.equal(typeof source.getSnapshot, 'function')
  assert.equal(typeof source.subscribe, 'function')
  const first = source.getSnapshot()
  assert.deepEqual(first, { spec: 'off', count: 0 })
  assert.equal(source.getSnapshot(), first, '相同状态应返回同一引用（避免无谓重渲染）')
})

// 等首次 /state 落地（异步），避免与后续断言抢跑
await new Promise((resolve) => setTimeout(resolve, 10))

await check('组件渲染徽标（关闭态显示 –，策略态显示 spec 与数量）', async () => {
  // 关闭态：沿用真实 source（此时服务端 /state 为空）
  const closedSource = registration.options.inject('session-abc').hooks.subagentPolicy
  const closedTree = renderComponent(registration.component, closedSource)
  const closedText = textOf(closedTree)
  assert.equal(closedTree.type, 'button', '关闭时只有触发按钮')
  assert.ok(closedText.indexOf('–') >= 0, '关闭态应显示 –，实际：' + closedText)

  // 有策略：换成固定快照的 source，渲染出 spec 与已用数量
  const liveSource = {
    getSnapshot: () => ({ spec: '>=2', count: 1 }),
    subscribe: () => () => {},
  }
  const badgeTree = renderComponent(registration.component, liveSource)
  const badgeText = textOf(badgeTree)
  assert.ok(badgeText.indexOf('>=2') >= 0, '应显示 spec，实际：' + badgeText)
  assert.ok(badgeText.indexOf('1') >= 0, '应显示已用数量，实际：' + badgeText)
  assert.equal(badgeTree.props['aria-haspopup'], 'dialog')
  assert.ok(String(badgeTree.props.title).indexOf('不少于 2 个') >= 0, 'title 应说明策略，实际：' + badgeTree.props.title)
  assert.ok(String(badgeTree.props.title).indexOf('已用 1 个') >= 0, 'title 应含已用数量')
})

await check('点开徽标渲染弹层（预设 + 自定义输入）', () => {
  const liveSource = {
    getSnapshot: () => ({ spec: 'off', count: 0 }),
    subscribe: () => () => {},
  }
  const badgeTree = renderComponent(registration.component, liveSource)
  // 模拟一次点击：React stub 的 setState 会写到持久 hooks，重渲染即可看到 open 态
  badgeTree.props.onClick()
  const popover = renderComponent(registration.component, liveSource)
  assert.equal(popover.type, 'div', '打开后应是定位容器')
  const buttons = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'button') buttons.push(node)
    collect(node.children)
  }
  collect(popover)
  // 7 个预设 + 1 个「应用」+ 1 个触发按钮
  assert.equal(buttons.length, 9, '按钮数应为 7 预设 + 应用 + 触发，实际 ' + buttons.length)
  const input = findByType(popover, 'input')
  assert.ok(input !== undefined, '应有自定义输入框')
  assert.ok(String(popover.children.map(textOf).join(' ')).indexOf('常用') >= 0, '弹层应有预设分组标题')
})

function renderComponent(component, source) {
  React.__resetCursor()
  return component({
    sessionId: 'session-abc',
    useSubagentPolicy: (selector) => selector(source.getSnapshot()),
  })
}

globalThis.setInterval = realSetInterval

if (failures > 0) {
  console.log('\nFAIL：' + failures + ' 个用例未通过')
  process.exit(1)
}
console.log('\nPASS：全部用例通过')
