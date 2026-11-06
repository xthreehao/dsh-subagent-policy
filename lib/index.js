/**
 * dsh-subagent-policy —— 宿主半。
 *
 * 目标：让「每个对话」单独设置「必须使用子代理」以及数量约束，并真的把它变成约束：
 *
 *   1. 每会话策略持久化在 $DSH_HOME/storages/dsh-subagent-policy.json（按 sessionId 分键、原子写）。
 *   2. 会话每次请求的系统提示里都带一条该会话专属的强制指令（agent scope 的 prompt section，
 *      text 是函数 → 每 step 重新求值，运行中改策略立刻生效）。
 *   3. 计数：在 agent scope 上订阅 `subagent/start`，`info.id`（子会话 id）天然去重。
 *   4. 强制：`agent/turn-stopping` 里若未达标，用 `agent.steer(createUserMessage(...))`
 *      往 next-step 收件箱塞一条提醒 —— 这是官方唯一的「不让回合结束」通路
 *      （agent-loop 只在收件箱为空时才 break）。带 maxCorrections 上限防止无限续命。
 *   5. 可选硬门：`tools.guard()`。默认只拦「超出上限的继续派发」，避免挡住正常工具。
 *   6. 管理面：/api/dsh-subagent-policy/{state,set,clear}，回环 + 同源校验（照抄 dsh-hidden-session）。
 *
 * 已知边界（官方就不支持，别硬做）：
 *   - 没有 finish/stop 校验钩子，只能用 turn-stopping + steer 让回合多跑一步；
 *   - 无法阻止 abort / max-tokens / error 结束；
 *   - 不能强制模型调用某个具体工具；
 *   - `subagent/start` 的 payload 没有 parent 字段，父归属完全靠 scoped dispatch，
 *     所以必须在 agent.ctx 上订阅（本文件就是这么做的）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  buildDirective,
  buildReminder,
  describeSpec,
  parseSpec,
  progress,
  renderSpec,
} from './policy.js'

/** 插件名（Cordis 行名 / 日志前缀）。 */
export const name = 'dsh-subagent-policy'

/**
 * 硬依赖为空。
 * 核心能力（prompt section、回合拦回、工具闸门）不需要任何服务；管理面路由只在 webServer
 * 存在时挂载。systemPrompt / tools / agents 也全都用 ctx.get() 惰性取，缺了只是少一层能力。
 *
 * 这样 headless / tui 这类没有 webServer 的 profile 里，「强制子代理」依旧生效，
 * 只是没有浏览器设置面板（策略仍可通过 config.defaultSpec 指定）。
 * 注：本机 cordis 的 Inject 类型不支持 { required, optional }，故 route 延迟到
 * inject(['webServer'], cb) 里挂（dsh/node_modules/@deepseek-ai/cordis/src/registry.ts:176）。
 */
export const inject = []

/** 管理面路由前缀。 */
const API_PREFIX = '/api/dsh-subagent-policy'

/** 状态文件 schema 版本。 */
const STORE_VERSION = 1

/** 请求体上限（只传 spec 字符串）。 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** 会话 id 白名单（DSH 会话 id 是 UUID，可能带前缀）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 默认策略：不限制。 */
const DEFAULT_SPEC = 'off'

/** 单个会话最多被「拦回」几次（防止无限续命）。 */
const MAX_CORRECTIONS_DEFAULT = 3

/** 一次委派 = 下列任一工具被调用（部署分层会换名字，所以用集合而不是写死一个）。 */
const DELEGATION_TOOLS_DEFAULT = [
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'workflow',
]

/** 提示词 section 名：全局唯一，且允许被 agent scope 同名覆盖。 */
const SECTION_NAME = 'subagent-policy:session'

/** 已 apply 过的宿主上下文（防止 bundle + patch 双份装载导致双倍行为）。 */
const appliedContexts = new WeakSet()

// ─────────────────────────────────────────────────────────── 状态文件

/** DSH home：优先 $DSH_HOME（沙箱隔离就靠它），否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 状态文件路径。 */
function storePath() {
  return join(dshHome(), 'storages', 'dsh-subagent-policy.json')
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

/** 把一条记录收敛成「规范 spec 字符串」。解析失败的记录直接丢弃。 */
function normalizeEntry(entry) {
  if (entry === undefined || entry === null) return undefined
  const raw = typeof entry === 'string' ? entry : entry.spec
  const parsed = parseSpec(raw)
  if (parsed.ok === false) return undefined
  const updatedAt = typeof entry === 'object' && typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
  return { spec: renderSpec(parsed.spec), updatedAt }
}

/** 读取整份状态：{ version, defaultSpec, bySession: { [sessionId]: { spec, updatedAt } } }。 */
function loadState() {
  const raw = readJsonFile(storePath())
  const bySession = {}
  if (raw !== undefined && raw !== null && typeof raw.bySession === 'object' && raw.bySession !== null) {
    for (const [sessionId, entry] of Object.entries(raw.bySession)) {
      if (SESSION_ID_PATTERN.test(sessionId) === false) continue
      const normalized = normalizeEntry(entry)
      if (normalized === undefined) continue
      bySession[sessionId] = normalized
    }
  }
  const defaultParsed = parseSpec(raw !== undefined && raw !== null ? raw.defaultSpec : undefined)
  const defaultSpec = defaultParsed.ok === true ? renderSpec(defaultParsed.spec) : DEFAULT_SPEC
  return { version: STORE_VERSION, defaultSpec, bySession }
}

/** 持久化一份新状态并返回它。 */
function saveState(state) {
  const next = {
    version: STORE_VERSION,
    defaultSpec: renderSpec(parseSpec(state.defaultSpec).spec ?? { enabled: false }),
    bySession: state.bySession ?? {},
    updatedAt: Date.now(),
  }
  writeJsonFile(storePath(), next)
  return next
}

// ─────────────────────────────────────────────────────────── HTTP 工具

/** 回环地址 + 浏览器同源标记（与 DSH 官方插件同一套判定）。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 读取 JSON 请求体；超限或非法时返回 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** source.summary 的上限（与 dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
const SUMMARY_MAX_CHARS = 120

/** 官方的 createUserMessage（拿不到就用等价的普通对象）。 */
let createUserMessageFactory = null
let createUserMessageLoaded = null

/** 惰性加载 @deepseek-ai/dsh-llm/message：解析不到也不该让插件挂掉。 */
function loadMessageFactory() {
  if (createUserMessageLoaded === null) {
    createUserMessageLoaded = import('@deepseek-ai/dsh-llm/message').then((mod) => {
      if (typeof mod.createUserMessage === 'function') createUserMessageFactory = mod.createUserMessage
    }).catch(() => { /* 退回内置构造 */ })
  }
  return createUserMessageLoaded
}

/** 构造一条 user 角色消息（steer 进 next-step 收件箱用）。 */
function makeUserMessage(text, summary) {
  const bounded = summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : summary.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
  const input = {
    content: [{ type: 'text', text }],
    // form:'notice' 是 load-bearing：否则派生历史会把它渲染成真人 prompt
    // （对照 dsh-repeat-tool-reminder 的 REMINDER_SOURCE，lib/index.js:2235-2245）
    source: { kind: 'subagent-policy', form: 'notice', summary: bounded },
  }
  if (createUserMessageFactory !== null) return createUserMessageFactory(input)
  return { ...input, id: randomUUID(), role: 'user' }
}

// ─────────────────────────────────────────────────────────── 插件主体

/**
 * @param {object} ctx - cordis 宿主上下文（webServer 可选，缺了就不挂管理面路由）。
 * @param {object} [config]
 * @param {string} [config.defaultSpec] - 没有单独设置过的会话用这个策略（默认 'off'）。
 * @param {number} [config.maxCorrections] - 单会话最多拦回几次（默认 3）。
 * @param {boolean} [config.toolGate] - 硬门：未达标时拒绝非委派工具（默认 false）。
 * @param {string[]} [config.delegationTools] - 算作「一次委派」的工具名。
 */
export function apply(ctx, config = {}) {
  // 幂等：cordis.patch.yml 的 insert 是无条件 append（不去重），bundle 与 profile patch 同时生效
  // 时会 apply 两次。若不拦住，会得到双份 turn-stopping 提醒、双份 tools.guard、重复路由。
  if (appliedContexts.has(ctx)) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 已在当前上下文装载过，跳过重复 apply（检查 bundle 与 patch 是否都启用了本插件）')
    return
  }
  appliedContexts.add(ctx)

  const settings = {
    defaultSpec: typeof config.defaultSpec === 'string' ? config.defaultSpec : DEFAULT_SPEC,
    maxCorrections: Number.isInteger(config.maxCorrections) && config.maxCorrections >= 0
      ? config.maxCorrections
      : MAX_CORRECTIONS_DEFAULT,
    toolGate: config.toolGate === true,
    delegationTools: Array.isArray(config.delegationTools) && config.delegationTools.length > 0
      ? config.delegationTools.filter((item) => typeof item === 'string')
      : DELEGATION_TOOLS_DEFAULT.slice(),
  }
  const delegationSet = new Set(settings.delegationTools)

  /** sessionId -> { children: Set<string>, attempts: number, corrections: number } */
  const counters = new Map()
  /** 已经挂过 prompt section / 事件订阅的 agent id。 */
  const attached = new Set()

  function counterOf(sessionId) {
    let entry = counters.get(sessionId)
    if (entry === undefined) {
      entry = { children: new Set(), attempts: 0, corrections: 0 }
      counters.set(sessionId, entry)
    }
    return entry
  }

  /** 该会话生效的策略（spec 对象）。 */
  function specFor(sessionId) {
    const state = loadState()
    const entry = state.bySession[sessionId]
    const parsed = parseSpec(entry !== undefined ? entry.spec : state.defaultSpec)
    return parsed.ok === true ? parsed.spec : { enabled: false, op: 'off', n: 0, raw: 'off' }
  }

  /** 该会话当前计数。 */
  function countFor(sessionId) {
    const entry = counters.get(sessionId)
    return entry === undefined ? 0 : entry.children.size
  }

  // ── 1) 每个 agent：注入 per-session 强制指令 + 订阅子代理计数 ────────────
  function attach(agent) {
    if (agent === undefined || agent === null) return
    const sessionId = String(agent.id)
    if (attached.has(sessionId)) return
    attached.add(sessionId)
    counterOf(sessionId)

    // 计数：info.id 是子会话 SessionId，天然去重；父归属靠 scoped dispatch（在 agent.ctx 上订阅）
    try {
      agent.ctx.on('subagent/start', (info) => {
        const id = info !== null && typeof info === 'object' && typeof info.id === 'string'
          ? info.id
          : 'anonymous:' + randomUUID()
        counterOf(sessionId).children.add(id)
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 subagent/start 失败：' + String(err))
    }

    // 提示词 section：text 是函数 → 每 step 重新求值，策略改动立刻生效
    const systemPrompt = agent.ctx.systemPrompt ?? ctx.get('systemPrompt')
    if (systemPrompt === undefined || systemPrompt === null) return
    try {
      const base = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('TEAM_POLICY')
        : 600
      const order = Number.isFinite(base) ? base + 1 : 601
      agent.ctx.effect(
        () => systemPrompt.section({
          name: SECTION_NAME,
          order,
          text: () => {
            const spec = specFor(sessionId)
            // 空字符串会被 renderPrompt 丢弃，所以「没开策略」不占上下文
            if (spec.enabled === false) return ''
            return buildDirective(spec, countFor(sessionId))
          },
        }),
        'dsh-subagent-policy: section',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 注册提示词 section 失败：' + String(err))
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
  })

  // 热加载时已经存在的会话也要补挂
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
      for (const agent of agents.list()) attach(agent)
    }
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 枚举既有 agent 失败：' + String(err))
  }

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined || agent === null) return
    attached.delete(String(agent.id))
  })

  // 委派尝试计数（含被拒的调用），只用于界面展示
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    const agent = exec?.agent
    if (agent === undefined || agent === null) return downstream
    if (delegationSet.has(exec.name) === false) return downstream
    counterOf(String(agent.id)).attempts += 1
    return downstream
  })

  // 回合边界重置「拦回次数」，做到「每回合最多拦 N 次」
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const entry = counters.get(sessionId)
    if (entry !== undefined) entry.corrections = 0
  })

  // ── 2) 强制：回合即将结束时校验，未达标就 steer 出下一 step ──────────────
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent === undefined || agent === null) return
    if (signal?.aborted === true) return
    const sessionId = String(agent.id)
    const spec = specFor(sessionId)
    if (spec.enabled === false) return
    const entry = counterOf(sessionId)
    const state = progress(spec, entry.children.size)
    if (state.met === true) return
    if (entry.corrections >= settings.maxCorrections) return
    entry.corrections += 1
    try {
      await loadMessageFactory()
      agent.steer(makeUserMessage(
        buildReminder(spec, entry.children.size),
        describeSpec(spec) + ' ' + state.have + '/' + renderSpec(spec),
      ))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] steer 失败：' + String(err))
    }
  })

  // ── 3) 可选硬门：超出上限继续派发 / 未达标就跑别的工具 ───────────────────
  const tools = ctx.get('tools')
  if (tools !== undefined && tools !== null && typeof tools.guard === 'function') {
    try {
      tools.guard((exec) => {
        const agent = exec?.agent
        if (agent === undefined || agent === null) return undefined
        const sessionId = String(agent.id)
        const spec = specFor(sessionId)
        if (spec.enabled === false) return undefined
        const have = countFor(sessionId)
        const state = progress(spec, have)
        if (state.exhausted === true && delegationSet.has(exec.name)) {
          return '[dsh-subagent-policy] 本会话子代理数量已达上限（' + renderSpec(spec)
            + '，已用 ' + have + ' 个），不要再派发新的子代理，请汇总已有结果作答。'
        }
        if (settings.toolGate === true && state.met === false && delegationSet.has(exec.name) === false) {
          return '[dsh-subagent-policy] 本会话要求必须先委派：请先调用子代理工具补齐数量（'
            + describeSpec(spec) + '，已用 ' + have + ' 个），再使用其它工具。'
        }
        return undefined
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 注册 tools.guard 失败：' + String(err))
    }
  }

  // ── 4) 管理面 REST ────────────────────────────────────────────────────
  const routes = [
    {
      kind: 'exact',
      path: API_PREFIX + '/state',
      handler: (req, res) => {
        if (isLoopbackRequest(req) === false) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed: ' + req.method })
          return
        }
        try {
          const state = loadState()
          const counts = {}
          const specs = {}
          const directives = {}
          for (const [sessionId, entry] of counters.entries()) {
            counts[sessionId] = entry.children.size
          }
          for (const [sessionId, entry] of Object.entries(state.bySession)) {
            specs[sessionId] = entry.spec
            // 与运行时提示词 section 用的是同一个函数，所以这里看到的就是模型实际收到的指令
            const spec = specFor(sessionId)
            if (spec.enabled === false) continue
            const have = countFor(sessionId)
            directives[sessionId] = {
              spec: renderSpec(spec),
              have,
              met: progress(spec, have).met,
              text: buildDirective(spec, have),
            }
          }
          writeJson(res, 200, {
            version: STORE_VERSION,
            defaultSpec: state.defaultSpec,
            maxCorrections: settings.maxCorrections,
            toolGate: settings.toolGate,
            delegationTools: settings.delegationTools,
            bySession: specs,
            counts,
            directives,
          })
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/set',
      handler: async (req, res) => {
        if (isLoopbackRequest(req) === false) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed: ' + req.method })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (SESSION_ID_PATTERN.test(sessionId) === false) {
          writeJson(res, 400, { error: 'sessionId (string) is required' })
          return
        }
        const parsed = parseSpec(body.spec)
        if (parsed.ok === false) {
          writeJson(res, 400, { error: 'invalid spec: ' + parsed.error, errorCode: parsed.error })
          return
        }
        try {
          const state = loadState()
          const spec = renderSpec(parsed.spec)
          if (spec === settings.defaultSpec) delete state.bySession[sessionId]
          else state.bySession[sessionId] = { spec, updatedAt: Date.now() }
          saveState(state)
          writeJson(res, 200, {
            ok: true,
            sessionId,
            spec,
            description: describeSpec(parsed.spec),
          })
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/clear',
      handler: async (req, res) => {
        if (isLoopbackRequest(req) === false) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed: ' + req.method })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (SESSION_ID_PATTERN.test(sessionId) === false) {
          writeJson(res, 400, { error: 'sessionId (string) is required' })
          return
        }
        try {
          const state = loadState()
          delete state.bySession[sessionId]
          saveState(state)
          writeJson(res, 200, { ok: true, sessionId })
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
  ]

  // 逐条 try/catch：insert 是无条件 append（不去重），双份实例会撞 "duplicate exact route"，
  // 宁可少注册一条，也不能让启动/热重载失败。
  // 注意：真实 cordis 里未声明的服务**不能**用 `ctx.foo` 取（会抛
  // `Error: cannot get property "webServer" without inject`），未声明时只能用 ctx.get()。
  function registerRoutes(scope, server) {
    if (server === undefined || server === null || typeof server.register !== 'function') return
    scope.effect(
      () => {
        const disposers = []
        for (const route of routes) {
          try {
            disposers.push(server.register(route))
          } catch (err) {
            ctx.logger?.warn?.('[dsh-subagent-policy] 跳过重复路由 ' + route.path + '：'
              + (err instanceof Error ? err.message : String(err)))
          }
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-subagent-policy: routes',
    )
  }

  const directServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (directServer !== undefined && directServer !== null) {
    registerRoutes(ctx, directServer)
  } else if (typeof ctx.inject === 'function') {
    // webServer 还没就绪（或该 profile 根本没有）：等服务出现再挂路由，不影响强制逻辑。
    try {
      ctx.inject(['webServer'], (scope) => {
        registerRoutes(scope, scope.webServer)
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] webServer 延迟挂载失败：'
        + (err instanceof Error ? err.message : String(err)))
    }
  } else {
    ctx.logger?.warn?.('[dsh-subagent-policy] 当前宿主没有 webServer 服务，管理面路由未注册（强制逻辑照常生效）')
  }
}
