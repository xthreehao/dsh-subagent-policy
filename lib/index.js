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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
 * 排障开关：设 DSH_SUBPOLICY_DEBUG=<文件路径> 时，把关键事件追加写进该文件。
 * headless / 打包运行的宿主拿不到日志，这是唯一能看到「到底有没有跑到」的办法。
 */
const DEBUG_FILE = typeof process !== 'undefined' && process.env !== undefined
  ? process.env.DSH_SUBPOLICY_DEBUG
  : undefined

function dbg(...parts) {
  if (DEBUG_FILE === undefined || DEBUG_FILE === '') return
  try {
    appendFileSync(DEBUG_FILE, new Date().toISOString() + ' ' + parts.join(' ') + '\n')
  } catch {
    /* 排障失败不影响主流程 */
  }
}

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

/** 跨回合拦回总上限 = maxCorrections × 该系数（即使结算窗口没结算也不会无限续命）。 */
const SESSION_CORRECTION_FACTOR = 4

/** 结算窗口默认 5 秒：窗口内派出的子代理才计入配额，滑出窗口自动清零。 */
const SETTLE_SECONDS_DEFAULT = 5
const SETTLE_SECONDS_MIN = 1
const SETTLE_SECONDS_MAX = 3600

/** 把 config.settleSeconds 收敛成合法的毫秒窗口。 */
function resolveSettleMs(config) {
  const raw = config.settleSeconds
  const seconds = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(SETTLE_SECONDS_MAX, Math.max(SETTLE_SECONDS_MIN, Math.round(raw)))
    : SETTLE_SECONDS_DEFAULT
  return seconds * 1000
}

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

/**
 * 读取整份状态：{ version, defaultSpec, bySession: { [sessionId]: { spec, updatedAt } } }。
 * @param {string} [fallbackSpec] - 文件里没有 defaultSpec 时用它（来自 config.defaultSpec）。
 */
function loadState(fallbackSpec = DEFAULT_SPEC) {
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
  const defaultParsed = parseSpec(raw !== undefined && raw !== null ? raw.defaultSpec : fallbackSpec)
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

/**
 * 我们自己 steer 出去的消息 id。
 *
 * 为什么需要：agent-loop 会把 steer 的消息当作 next-step 的 `decision.messages` 重新
 * `append("user/message", message)` 一次（`dsh-agent-loop/lib/index.js:1067-1073`），
 * 于是在 session 事件流里「本插件注入的提醒」和「用户真输入」几乎是同一种事件。
 * 若把它当成「用户发新消息」去清窗口/清拦回次数，5 秒窗口一到就无限重逼（实测死循环）。
 * id 是最可靠的判据：source 可能被上层改写/补字段，而 message 对象是原样 append 的。
 */
const ownMessageIds = new Set()
const OWN_MESSAGE_ID_LIMIT = 512

function rememberOwnMessage(message) {
  const id = message?.id
  if (typeof id !== 'string') return
  if (ownMessageIds.size >= OWN_MESSAGE_ID_LIMIT) ownMessageIds.clear()
  ownMessageIds.add(id)
}

// ─────────────────────────────────────────────────────────── 插件主体

/**
 * @param {object} ctx - cordis 宿主上下文（webServer 可选，缺了就不挂管理面路由）。
 * @param {object} [config]
 * @param {string} [config.defaultSpec] - 没有单独设置过的会话用这个策略（默认 'off'）。
 * @param {number} [config.maxCorrections] - 单会话最多拦回几次（默认 3）。
 * @param {boolean} [config.toolGate] - 硬门：未达标时拒绝非委派工具（默认 false）。
 * @param {string[]} [config.delegationTools] - 算作「一次委派」的工具名。
 * @param {boolean} [config.applyToSubagents] - 也强制子代理会话（默认 false）。
 * @param {number} [config.settleSeconds] - 结算窗口秒数（默认 5）：窗口内派的子代理才算数，过期自动清零。
 * @param {() => number} [config.clock] - 测试用时钟（默认 Date.now）。
 */
export function apply(ctx, config = {}) {
  // 幂等：cordis.patch.yml 的 insert 是无条件 append（不去重），bundle 与 profile patch 同时生效
  // 时会 apply 两次。若不拦住，会得到双份 turn-stopping 提醒、双份 tools.guard、重复路由。
  if (appliedContexts.has(ctx)) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 已在当前上下文装载过，跳过重复 apply（检查 bundle 与 patch 是否都启用了本插件）')
    return
  }
  appliedContexts.add(ctx)
  dbg('apply defaultSpec=' + (typeof config.defaultSpec === 'string' ? config.defaultSpec : DEFAULT_SPEC))

  const settings = {
    defaultSpec: typeof config.defaultSpec === 'string' ? config.defaultSpec : DEFAULT_SPEC,
    maxCorrections: Number.isInteger(config.maxCorrections) && config.maxCorrections >= 0
      ? config.maxCorrections
      : MAX_CORRECTIONS_DEFAULT,
    toolGate: config.toolGate === true,
    applyToSubagents: config.applyToSubagents === true,
    /** 结算窗口（毫秒）：窗口内派出的子代理才算数，滑出窗口即自动清零。 */
    settleMs: resolveSettleMs(config),
    clock: typeof config.clock === 'function' ? config.clock : Date.now,
    delegationTools: Array.isArray(config.delegationTools) && config.delegationTools.length > 0
      ? config.delegationTools.filter((item) => typeof item === 'string')
      : DELEGATION_TOOLS_DEFAULT.slice(),
  }
  const delegationSet = new Set(settings.delegationTools)

  /**
   * sessionId -> {
   *   window: Map<string, number>,  // 结算窗口内派出的子会话 id -> 派出时刻(ms)。判定/上限只看这个
   *   total: Set<string>,           // 本会话累计（面板展示用，不参与判定）
   *   attempts: number,             // 委派尝试次数（含被拒的）
   *   corrections: number,          // 本窗口已拦回次数
   *   sessionCorrections: number,   // 本会话累计拦回次数（硬上限，防无限续命）
   *   metInTurn: boolean,           // 本回合是否已达标过一次（窗口结算不影响它）
   * }
   */
  const counters = new Map()
  /** 已经挂过 prompt section / 事件订阅的 agent id。 */
  const attached = new Set()
  /** 被观测到的子代理会话 id（subagent/start 报过），用于兜底排除。 */
  const subagentSessions = new Set()

  function counterOf(sessionId) {
    let entry = counters.get(sessionId)
    if (entry === undefined) {
      entry = {
        // 5 秒结算窗口：只用于「派发限流」（窗口内不许超上限）
        window: new Map(),
        // 本条用户请求内派过的子代理：达标判定用它，窗口结算不清零
        request: new Set(),
        total: new Set(),
        attempts: 0,
        corrections: 0,
        sessionCorrections: 0,
        metInTurn: false,
      }
      counters.set(sessionId, entry)
    }
    return entry
  }

  /**
   * 结算：把滑出窗口的条目丢掉（配额每 settleMs 结算一次）。
   * @returns {number} 本次结算清掉的条数
   */
  function settleEntry(entry) {
    const now = settings.clock()
    let dropped = 0
    for (const [id, at] of entry.window) {
      if (now - at >= settings.settleMs) {
        entry.window.delete(id)
        dropped += 1
      }
    }
    // 结算只剪窗口条目；拦回次数属于「这一轮用户请求」，不随窗口重置
    return dropped
  }

  /**
   * 该 agent 的委派深度：0 = 用户直接对话的顶层会话，≥1 = 别处派出来的子代理。
   * 口径同官方 delegationDepthOf（dsh-subagent/lib/index.js:111-115）：
   * `max(session.header.delegationDepth, options.subagentDepth)`。
   */
  function delegationDepth(agent) {
    const header = agent?.session?.header ?? {}
    const fromHeader = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
    const fromOptions = Number.isSafeInteger(agent?.options?.subagentDepth) ? agent.options.subagentDepth : 0
    return Math.max(fromHeader, fromOptions)
  }

  /**
   * 策略是否作用于这个 agent。
   * 默认只作用于顶层会话：否则子代理也会被要求「必须再派子代理」，
   * 一个简单问题就能自乘出一棵子代理树（实测会爆出几十个会话、几十次拦回）。
   */
  function policyAppliesTo(agent) {
    if (settings.applyToSubagents === true) return true
    if (delegationDepth(agent) > 0) return false
    // 兜底：某些宿主不写 delegationDepth，但 subagent/start 报过这个 id
    return subagentSessions.has(String(agent?.id ?? '')) === false
  }

  /** 该会话生效的策略（spec 对象）。 */
  function specFor(sessionId) {
    const state = loadState(settings.defaultSpec)
    const entry = state.bySession[sessionId]
    const parsed = parseSpec(entry !== undefined ? entry.spec : state.defaultSpec)
    return parsed.ok === true ? parsed.spec : { enabled: false, op: 'off', n: 0, raw: 'off' }
  }

  /**
   * 结算窗口内已用子代理数 —— 判定依据。
   * 「每 5 秒结算一次」：窗口滑出去的条目在这里被剪掉，所以配额用完最多卡 5 秒。
   */
  function countFor(sessionId) {
    const entry = counters.get(sessionId)
    if (entry === undefined) return 0
    settleEntry(entry)
    return entry.window.size
  }

  /**
   * 本条用户请求内已派出的子代理数 —— **达标判定与徽标都用它**。
   * 只在用户发下一条真消息时清零；5 秒窗口结算不影响它（否则 5 秒一到就以为没派过，无限重逼）。
   */
  function usedFor(sessionId) {
    const entry = counters.get(sessionId)
    return entry === undefined ? 0 : entry.request.size
  }

  /** 本会话累计已用子代理数 —— 只用于面板展示。 */
  function totalFor(sessionId) {
    const entry = counters.get(sessionId)
    return entry === undefined ? 0 : entry.total.size
  }

  /** 面板用：还剩多久本窗口才结算（毫秒，0 = 已到点）。 */
  function settleInFor(sessionId) {
    const entry = counters.get(sessionId)
    if (entry === undefined || entry.window.size === 0) return 0
    const now = settings.clock()
    let oldest = now
    let seen = false
    for (const at of entry.window.values()) {
      if (seen === false || at < oldest) { oldest = at; seen = true }
    }
    return Math.max(0, settings.settleMs - (now - oldest))
  }

  // ── 1) 每个 agent：注入 per-session 强制指令 + 订阅子代理计数 ────────────
  function attach(agent) {
    if (agent === undefined || agent === null) return
    const sessionId = String(agent.id)
    if (attached.has(sessionId)) return
    attached.add(sessionId)
    counterOf(sessionId)
    dbg('attach session=' + sessionId + ' hasCtxOn=' + (typeof agent.ctx?.on) + ' hasSteer=' + (typeof agent.steer))

    // 计数：info.id 是子会话 SessionId，天然去重；父归属靠 scoped dispatch（在 agent.ctx 上订阅）
    try {
      agent.ctx.on('subagent/start', (info) => {
        const id = info !== null && typeof info === 'object' && typeof info.id === 'string'
          ? info.id
          : 'anonymous:' + randomUUID()
        if (typeof info?.id === 'string') subagentSessions.add(info.id)
        const entry = counterOf(sessionId)
        entry.window.set(id, settings.clock())
        entry.request.add(id)
        entry.total.add(id)
        // 本条请求已经达标过一次 → 窗口即使结算归零也不再继续逼（否则每个窗口都会再派一轮）
        if (progress(specFor(sessionId), entry.request.size).met === true) entry.metInTurn = true
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 subagent/start 失败：' + String(err))
    }

    // 子代理会话只做计数，不注入指令、不拦回（否则会自乘出子代理树）
    if (policyAppliesTo(agent) === false) {
      dbg('attach skip-enforcement session=' + sessionId + ' depth=' + delegationDepth(agent))
      return
    }

    // 回合即将结束 → 未达标就拦回（用闭包捕获 agent，payload 里没有 agent）
    try {
      agent.ctx.effect(
        () => agent.ctx.on('agent/turn-stopping', (payload) => enforceTurnStopping(agent, payload)),
        'dsh-subagent-policy: turn-stopping',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 agent/turn-stopping 失败：' + String(err))
    }

    // 回合边界：新回合重置配额（agent scope 版，保证一定收到）
    try {
      agent.ctx.effect(
        () => agent.ctx.on('session/event', (session, event) => resetTurn(String(session?.id ?? sessionId), event)),
        'dsh-subagent-policy: turn-reset',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 session/event 失败：' + String(err))
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
            return buildDirective(spec, usedFor(sessionId), { windowLabel: windowLabel() })
          },
        }),
        'dsh-subagent-policy: section',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 注册提示词 section 失败：' + String(err))
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    dbg('agent/created id=' + (agent !== null && typeof agent === 'object' ? agent.id : String(agent)))
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

  // 回合边界：新回合也顺手清一次窗口（用户发新消息时不必等 5 秒）。
  // 真正的配额结算靠 5 秒滑动窗口：配额一旦用满，最多卡一个窗口就自动清零，
  // 既不会"用完就再也开不出来"，也不会因为"已满足"而永久停止强制。
  ctx.on('session/event', (session, event) => resetTurn(String(session?.id ?? ''), event))

  // 定时结算：每 settleMs 结算一次，顺带清掉窗口里过期条目，避免 Map 无限增长。
  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        const now = settings.clock()
        for (const [sessionId, entry] of counters) {
          const dropped = settleEntry(entry)
          if (dropped > 0) dbg('settle session=' + sessionId + ' dropped=' + dropped + ' at=' + now)
        }
      }, settings.settleMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'dsh-subagent-policy: settle-timer')
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 注册结算定时器失败：' + String(err))
  }

  // ── 2) 强制：回合即将结束时校验，未达标就 steer 出下一 step ──────────────
  // ⚠️ 必须在 **agent scope** 上订阅：真实载荷只有 `{ turn, signal }`
  //    （dsh-agent-loop/lib/index.js:1001-1004），**没有 agent 字段**。
  //    曾经在根 ctx 上按 `{ agent }` 解构，于是 agent === undefined → 静默 return，
  //    表现就是「策略显示 ≥1、计数 0，但模型该被拦的时候完全没被拦」。
  async function enforceTurnStopping(agent, payload) {
    if (agent === undefined || agent === null) return
    if (payload?.signal?.aborted === true) return
    if (policyAppliesTo(agent) === false) return
    const sessionId = String(agent.id)
    const spec = specFor(sessionId)
    const entry = counterOf(sessionId)
    const have = usedFor(sessionId)
    dbg('turn-stopping session=' + sessionId + ' spec=' + renderSpec(spec) + ' enabled=' + spec.enabled
      + ' used=' + have + ' window=' + countFor(sessionId) + ' corrections=' + entry.corrections)
    if (spec.enabled === false) return
    const state = progress(spec, have)
    if (state.met === true) {
      entry.metInTurn = true
      return
    }
    // 本回合已经满足过一次：哪怕窗口结算把计数清零，也不再拦回（下一条用户消息才重新强制）
    if (entry.metInTurn === true) return
    if (entry.corrections >= settings.maxCorrections) return
    // 硬上限：即使结算窗口异常不推进，也不会无限续命
    if (entry.sessionCorrections >= settings.maxCorrections * SESSION_CORRECTION_FACTOR) return
    entry.corrections += 1
    entry.sessionCorrections += 1
    try {
      await loadMessageFactory()
      const message = makeUserMessage(
        buildReminder(spec, have, { windowLabel: windowLabel() }),
        describeSpec(spec) + ' ' + state.have + '/' + renderSpec(spec),
      )
      rememberOwnMessage(message)
      agent.steer(message)
      dbg('steered session=' + sessionId)
    } catch (err) {
      dbg('steer FAILED session=' + sessionId + ' err=' + String(err))
      ctx.logger?.warn?.('[dsh-subagent-policy] steer 失败：' + String(err))
    }
  }

  /** 给文案用的窗口描述，例如「每 5 秒」。 */
  function windowLabel() {
    const seconds = settings.settleMs / 1000
    return '每 ' + (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' 秒'
  }

  /**
   * 用户真发了一条消息 → 清窗口、拦回次数、达标标记（这一轮从头算）。
   *
   * ⚠️ 不能用 `turn/start`：agent-loop 的 `turn()` 是**每个 drive 循环**都调一次
   * （`dsh-agent-loop/lib/index.js:938-949` 里 `session.append("turn/start", { turn })`），
   * 我们自己 steer 出来的续跑也会触发它。用它当"用户发消息"信号会让 5 秒窗口里的强制
   * 变成死循环（实测：模型每 5~7 秒被逼派两个子代理，无限重复）。
   * 正确信号是 `user/message`，且要排除我们自己注入的 notice（source.form === 'notice'）。
   */
  function resetTurn(sessionId, event) {
    if (event?.type !== 'user/message') return
    const data = event.data
    const source = data?.source
    const kind = source?.kind
    // 只有「真人输入」（source.kind === 'user'）才算新请求。会话里的 user/message 有七八种来源：
    //   user / runtime-context(snapshot) / skill-catalog(catalog) / agent-message(relay) /
    //   subagent-settled(notice) / subagent-policy(notice，我们自己的) …
    // 子代理回报是 agent-message，若把它也当新请求，每派完一轮就复位一次 → 无限重逼。
    const own = (typeof data?.id === 'string' && ownMessageIds.has(data.id) === true)
      || kind === 'subagent-policy'
      || source?.form === 'notice'
      || kind !== 'user'
    if (DEBUG_FILE !== undefined) {
      const text = typeof data?.content?.[0]?.text === 'string' ? data.content[0].text : ''
      dbg('user-message session=' + sessionId + ' own=' + own + ' kind=' + String(kind)
        + ' text=' + safeJson(text.slice(0, 60)))
    }
    if (own) return
    const entry = counters.get(sessionId)
    if (entry === undefined) return
    entry.window.clear()
    entry.request.clear()
    entry.corrections = 0
    entry.metInTurn = false
  }

  /** 排障用：把 source 之类小对象压成一行（循环/超长都能扛）。 */
  function safeJson(value) {
    try {
      const text = JSON.stringify(value)
      if (text === undefined) return String(value)
      return text.length <= 300 ? text : text.slice(0, 300) + '…'
    } catch {
      return '<unserializable>'
    }
  }

  // ── 3) 可选硬门：超出上限继续派发 / 未达标就跑别的工具 ───────────────────
  const tools = ctx.get('tools')
  if (tools !== undefined && tools !== null && typeof tools.guard === 'function') {
    try {
      tools.guard((exec) => {
        const agent = exec?.agent
        if (agent === undefined || agent === null) return undefined
        if (policyAppliesTo(agent) === false) return undefined
        const sessionId = String(agent.id)
        const spec = specFor(sessionId)
        if (spec.enabled === false) return undefined
        const have = countFor(sessionId)
        const state = progress(spec, have)
        if (state.exhausted === true && delegationSet.has(exec.name)) {
          return '[dsh-subagent-policy] 本结算窗口内子代理数量已达上限（' + renderSpec(spec)
            + '，窗口内已用 ' + have + ' 个），本窗口内不要再派发新的子代理，请汇总已有结果作答；'
            + '配额' + windowLabel() + '结算一次，到点后自动恢复。'
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
          const state = loadState(settings.defaultSpec)
          const counts = {}
          const used = {}
          const totals = {}
          const settleIn = {}
          const specs = {}
          const directives = {}
          for (const [sessionId, entry] of counters.entries()) {
            // counts = 5 秒结算窗口内已派（限流口径）；used = 本条用户请求内已派（达标口径）
            counts[sessionId] = countFor(sessionId)
            used[sessionId] = entry.request.size
            totals[sessionId] = entry.total.size
            settleIn[sessionId] = settleInFor(sessionId)
          }
          for (const [sessionId, entry] of Object.entries(state.bySession)) {
            specs[sessionId] = entry.spec
            // 与运行时提示词 section 用的是同一个函数，所以这里看到的就是模型实际收到的指令
            const spec = specFor(sessionId)
            if (spec.enabled === false) continue
            const have = usedFor(sessionId)
            directives[sessionId] = {
              spec: renderSpec(spec),
              have,
              met: progress(spec, have).met,
              text: buildDirective(spec, have, { windowLabel: windowLabel() }),
            }
          }
          writeJson(res, 200, {
            version: STORE_VERSION,
            defaultSpec: state.defaultSpec,
            maxCorrections: settings.maxCorrections,
            toolGate: settings.toolGate,
            applyToSubagents: settings.applyToSubagents,
            settleSeconds: settings.settleMs / 1000,
            delegationTools: settings.delegationTools,
            bySession: specs,
            counts,
            used,
            totals,
            settleIn,
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
          const state = loadState(settings.defaultSpec)
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
          const state = loadState(settings.defaultSpec)
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
