import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, dshHome, isValidSessionId } from '../lib/store.js'
import { parseSpec } from '../lib/policy.js'

/** 每个 test 一个临时 home，finally 里清理，绝不碰真实 ~/.dsh。 */
function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-subagent-policy-store-'))
}

function drop(home) {
  rmSync(home, { recursive: true, force: true })
}

test('dshHome 优先 $DSH_HOME，否则 ~/.dsh', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\fake\\dsh-home'
    assert.equal(dshHome(), 'C:\\fake\\dsh-home')

    process.env.DSH_HOME = ''
    assert.equal(dshHome(), join(homedir(), '.dsh'), '空串应回落 homedir')

    delete process.env.DSH_HOME
    assert.equal(dshHome(), join(homedir(), '.dsh'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('isValidSessionId 只接受白名单字符', () => {
  for (const good of ['session-abc-123', 'abc', 'a.b_c-d', 'A1', 'x'.repeat(128)]) {
    assert.equal(isValidSessionId(good), true, 'should accept: ' + good)
  }
  for (const bad of ['bad id!', '有中文', 'a/b', '', 'x'.repeat(129), 'a b', 'tab\there', null, undefined, 42, {}, []]) {
    assert.equal(isValidSessionId(bad), false, 'should reject: ' + String(bad))
  }
})

test('filePath / diagPath 指向 home 下的 storages', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home })
    assert.equal(store.filePath(), join(home, 'storages', 'dsh-subagent-policy.json'))
    assert.equal(store.diagPath(), join(home, 'storages', 'dsh-subagent-policy.diag.json'))
  } finally {
    drop(home)
  }
})

test('文件不存在时 load 返回默认状态', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home })
    assert.equal(existsSync(store.filePath()), false)
    const state = store.load()
    assert.equal(state.version, 1)
    assert.equal(state.defaultSpec, 'off', '不传 defaultSpec 应回落 off')
    assert.deepEqual(state.bySession, {})

    assert.equal(createStore({ home, defaultSpec: '=2' }).load().defaultSpec, '=2', '应取 fallback')
    const parsed = parseSpec('2')
    assert.equal(parsed.ok, true)
    assert.equal(parseSpec('=2').spec.op, 'eq')
  } finally {
    drop(home)
  }
})

test('save → load 往返并自动建目录', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home })
    const saved = store.save({
      defaultSpec: '>=2',
      bySession: { 'session-abc-123': { spec: '=3', updatedAt: 111 } },
    })
    assert.equal(saved.version, 1)
    assert.equal(saved.defaultSpec, '>=2')
    assert.equal(typeof saved.updatedAt, 'number')

    assert.equal(existsSync(join(home, 'storages')), true, 'storages 目录应自动创建')
    assert.equal(existsSync(store.filePath()), true)

    const loaded = store.load()
    assert.equal(loaded.version, 1)
    assert.equal(loaded.defaultSpec, '>=2')
    assert.deepEqual(loaded.bySession, { 'session-abc-123': { spec: '=3', updatedAt: 111 } })

    // 落盘内容确实是 JSON
    const onDisk = JSON.parse(readFileSync(store.filePath(), 'utf8'))
    assert.equal(onDisk.defaultSpec, '>=2')
  } finally {
    drop(home)
  }
})

test('非法 JSON 文件退化为默认状态', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home, defaultSpec: '=4' })
    store.save({ defaultSpec: '=2', bySession: { 'ok-1': { spec: '=2', updatedAt: 1 } } })
    writeFileSync(store.filePath(), 'this is not json {{', 'utf8')

    const state = store.load()
    assert.deepEqual(state.bySession, {})
    assert.equal(state.defaultSpec, '=4', '坏文件应回落 createStore 的 defaultSpec')
    assert.equal(state.version, 1)
  } finally {
    drop(home)
  }
})

test('load 丢弃非法 sessionId 与解析失败的条目', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home })
    store.save({ defaultSpec: 'off', bySession: {} })
    writeFileSync(store.filePath(), JSON.stringify({
      version: 1,
      defaultSpec: 'off',
      bySession: {
        'bad id!': { spec: '=2', updatedAt: 1 },
        'ok-1': { spec: '=2', updatedAt: 2 },
        'ok-2': { spec: 'bogus', updatedAt: 3 },
        'ok-3': { spec: 'off' },
      },
    }), 'utf8')

    const state = store.load()
    assert.deepEqual(Object.keys(state.bySession).sort(), ['ok-1', 'ok-3'])
    assert.deepEqual(state.bySession['ok-1'], { spec: '=2', updatedAt: 2 })
    assert.deepEqual(state.bySession['ok-3'], { spec: 'off', updatedAt: 0 }, '缺 updatedAt 补 0')
  } finally {
    drop(home)
  }
})

test('setSpec 落盘并返回规范字符串', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home, defaultSpec: 'off' })
    const parsed = parseSpec('2')
    assert.equal(parsed.ok, true)
    assert.equal(store.setSpec('session-abc-123', parsed.spec), '=2')

    const state = store.load()
    assert.equal(state.bySession['session-abc-123'].spec, '=2')
    assert.equal(typeof state.bySession['session-abc-123'].updatedAt, 'number')
    assert.equal(store.resolveSpec('session-abc-123'), '=2')
  } finally {
    drop(home)
  }
})

test('setSpec 等于 defaultSpec 时不写 bySession', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home, defaultSpec: '=2' })
    const eq = parseSpec('2')
    assert.equal(eq.ok, true)
    assert.equal(store.setSpec('session-abc-123', eq.spec), '=2')
    assert.equal(Object.prototype.hasOwnProperty.call(store.load().bySession, 'session-abc-123'), false)

    // 先设成非默认，再设回默认 —— 该键应被删掉
    const three = parseSpec('=3')
    assert.equal(store.setSpec('session-abc-123', three.spec), '=3')
    assert.equal(store.resolveSpec('session-abc-123'), '=3')

    assert.equal(store.setSpec('session-abc-123', eq.spec), '=2')
    assert.equal(Object.prototype.hasOwnProperty.call(store.load().bySession, 'session-abc-123'), false)
    assert.equal(store.resolveSpec('session-abc-123'), '=2', '应回落到 defaultSpec')
  } finally {
    drop(home)
  }
})

test('resolveSpec 无单独设置时回落 defaultSpec', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home, defaultSpec: '>=2' })
    assert.equal(store.resolveSpec('never-seen'), '>=2')

    const any = parseSpec('any')
    store.setSpec('session-abc-123', any.spec)
    assert.equal(store.resolveSpec('session-abc-123'), 'any')
    assert.equal(store.resolveSpec('other-session'), '>=2', '别的会话仍走默认')
  } finally {
    drop(home)
  }
})

test('clearSession 删掉单独设置', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home, defaultSpec: 'off' })
    const three = parseSpec('=3')
    store.setSpec('session-abc-123', three.spec)
    assert.equal(store.resolveSpec('session-abc-123'), '=3')

    store.clearSession('session-abc-123')
    assert.equal(store.resolveSpec('session-abc-123'), 'off')
    assert.deepEqual(store.load().bySession, {})
    assert.doesNotThrow(() => store.clearSession('never-seen'))
  } finally {
    drop(home)
  }
})

test('writeDiag 写入 diagPath 且带 updatedAt', () => {
  const home = tmpHome()
  try {
    const store = createStore({ home })
    store.writeDiag({ phase: 'turn', count: 2 })

    assert.equal(existsSync(store.diagPath()), true)
    const raw = JSON.parse(readFileSync(store.diagPath(), 'utf8'))
    assert.equal(raw.phase, 'turn')
    assert.equal(raw.count, 2)
    assert.equal(typeof raw.updatedAt, 'string')
    assert.equal(Number.isNaN(Date.parse(raw.updatedAt)), false, 'updatedAt 应是可解析的时间')
    assert.equal(existsSync(store.filePath()), false, '诊断文件不应污染策略文件')
  } finally {
    drop(home)
  }
})

test('writeDiag 失败静默', () => {
  const home = tmpHome()
  try {
    const blocker = join(home, 'blocker.txt')
    writeFileSync(blocker, 'x', 'utf8')
    const store = createStore({ home: blocker })
    assert.doesNotThrow(() => store.writeDiag({ a: 1 }))
    assert.equal(existsSync(store.diagPath()), false)
  } finally {
    drop(home)
  }
})
