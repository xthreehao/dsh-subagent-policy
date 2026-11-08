/**
 * 状态持久化：$DSH_HOME/storages/dsh-subagent-policy.json（每会话策略）+ 可选的诊断文件。
 *
 * 这里只管「读写 + 规范化」，不知道 agent / HTTP 的存在，方便单测（换 DSH_HOME 即可）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { parseSpec, renderSpec } from './policy.js'
import { DEFAULT_SPEC, SESSION_ID_PATTERN, STORE_VERSION } from './settings.js'

/** DSH home：优先 $DSH_HOME（沙箱隔离就靠它），否则 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 会话 id 是否合法（防止把任意字符串当键写进状态文件）。 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** 安全读 JSON；任何异常都退化为 undefined。 */
function readJsonFile(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 JSON（tmp + rename），目录按需创建。 */
function writeJsonFile(filePath, data) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = filePath + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}

/** 把一条记录收敛成「规范 spec 字符串」；解析失败的记录直接丢弃。 */
function normalizeEntry(entry) {
  if (entry === undefined || entry === null) return undefined
  const raw = typeof entry === 'string' ? entry : entry.spec
  const parsed = parseSpec(raw)
  if (parsed.ok === false) return undefined
  const updatedAt = typeof entry === 'object' && typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
  return { spec: renderSpec(parsed.spec), updatedAt }
}

/**
 * @param {object} [options]
 * @param {string} [options.defaultSpec] - 文件里没有 defaultSpec 时的兜底（来自 config）。
 * @param {string} [options.home] - 覆盖 DSH home（测试用）。
 */
export function createStore(options = {}) {
  // config.defaultSpec 显式写了就以它为准：否则状态文件里遗留的 defaultSpec
  // 会把 profile 里的 config 永久盖掉（踩过：patch 里写 '=2'，跑起来一直是 off）。
  const explicitDefault = typeof options.defaultSpec === 'string' && options.defaultSpec.length > 0
  const fallbackDefault = explicitDefault ? options.defaultSpec : DEFAULT_SPEC
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : undefined

  function filePath() {
    return join(home ?? dshHome(), 'storages', 'dsh-subagent-policy.json')
  }

  /** 诊断/排障文件：单独一个文件，绝不污染用户可见的策略文件。 */
  function diagPath() {
    return join(home ?? dshHome(), 'storages', 'dsh-subagent-policy.diag.json')
  }

  /**
   * 读取整份状态：{ version, defaultSpec, bySession: { [sessionId]: { spec, updatedAt } } }。
   * @returns {{version:number, defaultSpec:string, bySession:Object}}
   */
  function load() {
    const raw = readJsonFile(filePath())
    const bySession = {}
    if (raw !== undefined && raw !== null && typeof raw.bySession === 'object' && raw.bySession !== null) {
      for (const [sessionId, entry] of Object.entries(raw.bySession)) {
        if (isValidSessionId(sessionId) === false) continue
        const normalized = normalizeEntry(entry)
        if (normalized === undefined) continue
        bySession[sessionId] = normalized
      }
    }
    // 显式 config.defaultSpec 优先；没写时才认文件里留下的值（兼容老状态文件）
    const source = explicitDefault
      ? fallbackDefault
      : (raw !== undefined && raw !== null ? raw.defaultSpec : fallbackDefault)
    const defaultParsed = parseSpec(source)
    const defaultSpec = defaultParsed.ok === true ? renderSpec(defaultParsed.spec) : DEFAULT_SPEC
    return { version: STORE_VERSION, defaultSpec, bySession }
  }

  /** 持久化一份新状态并返回落盘后的内容。 */
  function save(state) {
    const parsed = parseSpec(state?.defaultSpec)
    const next = {
      version: STORE_VERSION,
      defaultSpec: parsed.ok === true ? renderSpec(parsed.spec) : DEFAULT_SPEC,
      bySession: state?.bySession ?? {},
      updatedAt: Date.now(),
    }
    writeJsonFile(filePath(), next)
    return next
  }

  /** 某会话生效的规范 spec 字符串（没单独设置过就是 defaultSpec）。 */
  function resolveSpec(sessionId) {
    const state = load()
    const entry = state.bySession[sessionId]
    return entry !== undefined ? entry.spec : state.defaultSpec
  }

  /**
   * 设置某会话策略。
   * @param {string} sessionId
   * @param {object} spec - parseSpec() 解析成功的 spec 对象。
   * @returns {string} 落盘后的规范 spec 字符串
   */
  function setSpec(sessionId, spec) {
    const state = load()
    const rendered = renderSpec(spec)
    if (rendered === state.defaultSpec) delete state.bySession[sessionId]
    else state.bySession[sessionId] = { spec: rendered, updatedAt: Date.now() }
    save(state)
    return rendered
  }

  /** 清掉某会话的单独设置（回落到 defaultSpec）。 */
  function clearSession(sessionId) {
    const state = load()
    delete state.bySession[sessionId]
    save(state)
  }

  /** 写诊断快照（失败静默：排障不能影响主流程）。 */
  function writeDiag(diag) {
    try {
      writeJsonFile(diagPath(), { ...diag, updatedAt: new Date().toISOString() })
    } catch {
      /* ignore */
    }
  }

  return { filePath, diagPath, load, save, resolveSpec, setSpec, clearSession, writeDiag }
}
