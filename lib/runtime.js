/**
 * 运行时：把「策略」变成「模型真的被逼着用子代理」。
 *
 * 三条腿（缺一条都会翻车，每条都踩过坑）：
 *   1. 提示词：agent scope 的 systemPrompt section，text 是函数 → 每 step 求值，改策略立刻生效。
 *   2. 拦回：`agent/turn-stopping` 上若未达标就 `agent.steer(...)` 塞一条提醒进 next-step 收件箱
 *      —— agent-loop 只在收件箱为空时才真正结束回合（dsh-agent-loop/lib/index.js:1000-1007）。
 *      ⚠️ 该事件载荷只有 `{ turn, signal }`，**没有 agent**，所以只能在 agent scope 上订阅。
 *   3. 限流：`tools.guard()` 拒绝「窗口内已经派够还继续派」的委派工具调用。
 *
 * 计数的归属问题：`subagent/start` 的载荷也没有 parent，官方靠 scoped dispatch 投递。
 * 只信 scoped dispatch 会漏（宿主 boot 顺序 / 热重载都可能让 agent 没被挂上），
 * 所以这里双保险：agent scope 订阅 + 根上下文订阅后用 `agents.isOwnedBy(childId, agent)` 归属。
 */

import { buildDirective, buildReminder, describeSpec, parseSpec, progress, renderSpec } from './policy.js'
import {
  loadMessageFactory,
  isRealUserMessage,
  makeUserMessage,
  rememberOwnMessage,
} from './message.js'
import { SECTION_NAME, windowLabel } from './settings.js'

/** 记「哪些会话是子代理」的上限（只用于 depth 兜底判定）。 */
const MAX_TRACKED_CHILD_SESSIONS = 1024

/** 没有策略时返回的对象（避免到处判空）。 */
const OFF_SPEC = Object.freeze({ enabled: false, op: 'off', n: 0, raw: 'off' })

/**
 * @param {object} deps
 * @param {object} deps.ctx - 根上下文
 * @param {object} deps.settings - resolveSettings() 的结果
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./counters.js').createCounters>} deps.counters
 * @param {ReturnType<import('./diag.js').createDiag>} [deps.diag]
 * @param {(text: string) => void} [deps.debug] - DSH_SUBPOLICY_DEBUG 文件日志
 */
export function createRuntime(deps) {
  const { ctx, settings, store, counters } = deps
  const diag = deps.diag
  const debug = typeof deps.debug === 'function' ? deps.debug : () => {}

  /** 已经挂过 section / 事件订阅的 agent id。 */
  const attached = new Set()
  /** subagent/start 报过的子会话 id（depth 兜底：某些宿主不写 delegationDepth）。 */
  const childSessions = new Set()

  /** 取可选服务：未声明的服务不能点属性（cordis 会抛），只能 ctx.get()。 */
  function service(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /** 某会话生效的策略（spec 对象）。 */
  function specFor(sessionId) {
    const parsed = parseSpec(store.resolveSpec(sessionId))
    return parsed.ok === true ? parsed.spec : OFF_SPEC
  }

  /**
   * 该 agent 的委派深度：0 = 用户直接对话的顶层会话，≥1 = 别处派出来的子代理。
   * 口径同官方 delegationDepthOf（dsh-subagent/lib/index.js:111-115）。
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
   * 一个简单问题就能自乘出一棵子代理树（实测爆出几十个会话）。
   */
  function policyAppliesTo(agent) {
    if (settings.applyToSubagents === true) return true
    if (delegationDepth(agent) > 0) return false
    return childSessions.has(String(agent?.id ?? '')) === false
  }

  /** 记一次子代理启动（幂等：同一 childId 只算一次）。 */
  function noteStart(parentSessionId, childId, via) {
    const before = counters.used(parentSessionId)
    counters.noteStart(parentSessionId, childId)
    if (counters.used(parentSessionId) === before) return
    if (childSessions.size >= MAX_TRACKED_CHILD_SESSIONS) childSessions.clear()
    childSessions.add(String(childId))
    diag?.counted(parentSessionId, childId, via)
    // 本条用户消息已经达标过 → 记下来，窗口结算后不再重新逼
    if (progress(specFor(parentSessionId), counters.used(parentSessionId)).met === true) {
      counters.markMet(parentSessionId)
    }
  }

  /** 用运行时的父子关系反查「这个子会话是谁派出来的」。 */
  function ownersOf(childId) {
    const agents = service('agents')
    if (agents === undefined || agents === null) return []
    if (typeof agents.list !== 'function' || typeof agents.isOwnedBy !== 'function') return []
    const owners = []
    for (const agent of agents.list()) {
      try {
        if (agents.isOwnedBy(childId, agent) === true) owners.push(String(agent.id))
      } catch {
        /* 单个 agent 查询失败不影响其它 */
      }
    }
    return owners
  }

  /** 根上下文的全量订阅：任何子代理启动都会到这里，按 ownership 归属到父会话。 */
  function installGlobalCounting() {
    ctx.on('subagent/start', (info) => {
      const childId = info !== null && typeof info === 'object' && typeof info.id === 'string' ? info.id : undefined
      if (childId === undefined) return
      if (childSessions.size >= MAX_TRACKED_CHILD_SESSIONS) childSessions.clear()
      childSessions.add(childId)
      for (const parentSessionId of ownersOf(childId)) noteStart(parentSessionId, childId, 'owner')
    })
  }

  /** 挂到一个 agent 上：计数、拦回、回合边界、提示词 section。 */
  function attach(agent) {
    if (agent === undefined || agent === null) return
    const sessionId = String(agent.id)
    if (attached.has(sessionId)) return
    attached.add(sessionId)
    counters.entryOf(sessionId)
    const depth = delegationDepth(agent)
    debug('attach session=' + sessionId + ' depth=' + depth
      + ' hasCtxOn=' + (typeof agent.ctx?.on) + ' hasSteer=' + (typeof agent.steer))

    // ① 计数（scoped dispatch 的精确归属；根上下文那条是兜底）
    try {
      agent.ctx.on('subagent/start', (info) => {
        const childId = info !== null && typeof info === 'object' && typeof info.id === 'string'
          ? info.id
          : undefined
        if (childId === undefined) return
        noteStart(sessionId, childId, 'scope')
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 subagent/start 失败：' + String(err))
    }

    diag?.agent(sessionId, {
      depth,
      enforced: policyAppliesTo(agent),
      spec: renderSpec(specFor(sessionId)),
    })

    // 子代理会话只做计数，不注入指令、不拦回（否则会自乘出子代理树）
    if (policyAppliesTo(agent) === false) {
      debug('attach skip-enforcement session=' + sessionId + ' depth=' + depth)
      return
    }

    // ② 拦回：载荷里没有 agent，用闭包捕获
    try {
      agent.ctx.effect(
        () => agent.ctx.on('agent/turn-stopping', (payload) => enforceTurnStopping(agent, payload)),
        'dsh-subagent-policy: turn-stopping',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 agent/turn-stopping 失败：' + String(err))
    }

    // ③ 回合边界：真人发新消息 → 这一轮配额从头算
    try {
      agent.ctx.effect(
        () => agent.ctx.on('session/event', (session, event) => resetFromEvent(String(session?.id ?? sessionId), event)),
        'dsh-subagent-policy: user-message',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 session/event 失败：' + String(err))
    }

    // ④ 提示词 section
    installSection(agent, sessionId)
  }

  function installSection(agent, sessionId) {
    const systemPrompt = agent.ctx.systemPrompt ?? service('systemPrompt')
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
            return buildDirective(spec, counters.used(sessionId), { windowLabel: windowLabel(settings) })
          },
        }),
        'dsh-subagent-policy: section',
      )
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 注册提示词 section 失败：' + String(err))
    }
  }

  /** 把当前所有活着的 agent 挂一遍（热重载 / 插件晚于会话创建加载时靠它）。 */
  function attachAll() {
    const agents = service('agents')
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return 0
    let count = 0
    try {
      for (const agent of agents.list()) {
        attach(agent)
        count += 1
      }
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 枚举既有 agent 失败：' + String(err))
    }
    return count
  }

  /**
   * 回合即将结束：未达标就 steer 一条提醒，让模型继续下一步。
   * 载荷只有 `{ turn, signal }`（dsh-agent-loop/lib/index.js:1000-1007），别指望里面带 agent。
   */
  async function enforceTurnStopping(agent, payload) {
    if (agent === undefined || agent === null) return
    if (payload?.signal?.aborted === true) return
    if (policyAppliesTo(agent) === false) return
    const sessionId = String(agent.id)
    const spec = specFor(sessionId)
    const have = counters.used(sessionId)
    const verdict = {
      spec: renderSpec(spec),
      enabled: spec.enabled,
      used: have,
      window: counters.windowCount(sessionId),
      corrections: counters.corrections(sessionId),
      metInTurn: counters.metInTurn(sessionId),
    }
    debug('turn-stopping session=' + sessionId + ' ' + JSON.stringify(verdict))
    if (spec.enabled === false) {
      diag?.turn(sessionId, { ...verdict, action: 'off' })
      return
    }
    if (progress(spec, have).met === true) {
      counters.markMet(sessionId)
      diag?.turn(sessionId, { ...verdict, action: 'met' })
      return
    }
    // 本条用户消息已经满足过：哪怕窗口结算把计数清零，也不再拦回
    if (counters.metInTurn(sessionId)) {
      diag?.turn(sessionId, { ...verdict, action: 'already-met' })
      return
    }
    if (counters.canCorrect(sessionId, settings.maxCorrections, settings.maxSessionCorrections) === false) {
      diag?.turn(sessionId, { ...verdict, action: 'limit' })
      return
    }
    counters.noteCorrection(sessionId)
    try {
      await loadMessageFactory()
      const message = makeUserMessage(
        buildReminder(spec, have, { windowLabel: windowLabel(settings) }),
        describeSpec(spec) + ' ' + progress(spec, have).have + '/' + renderSpec(spec),
      )
      rememberOwnMessage(message)
      agent.steer(message)
      debug('steered session=' + sessionId + ' used=' + have)
      diag?.turn(sessionId, { ...verdict, action: 'steer' })
    } catch (err) {
      debug('steer FAILED session=' + sessionId + ' err=' + String(err))
      diag?.turn(sessionId, { ...verdict, action: 'steer-failed' })
      ctx.logger?.warn?.('[dsh-subagent-policy] steer 失败：' + String(err))
    }
  }

  /**
   * 会话事件流里的「真人发新消息」→ 这一轮从头算。
   * ⚠️ 不能用 `turn/start`：agent-loop 每个 drive 循环都 append 一次（:938-949），
   * 我们自己 steer 的续跑也会触发，用它当信号会变成「每 5 秒重逼一轮」的死循环。
   */
  function resetFromEvent(sessionId, event) {
    if (event?.type !== 'user/message') return
    if (isRealUserMessage(event.data) === false) return
    counters.resetRequest(sessionId)
    debug('reset session=' + sessionId)
  }

  /** 可选硬门：窗口内派够了还继续派 → 拒绝；toolGate 打开时未达标先不许用别的工具。 */
  function installGuard() {
    const tools = service('tools')
    if (tools === undefined || tools === null || typeof tools.guard !== 'function') return false
    try {
      tools.guard((exec) => {
        const agent = exec?.agent
        if (agent === undefined || agent === null) return undefined
        if (policyAppliesTo(agent) === false) return undefined
        const sessionId = String(agent.id)
        const spec = specFor(sessionId)
        if (spec.enabled === false) return undefined
        const isDelegation = settings.delegationSet.has(exec.name)
        const windowUsed = counters.windowCount(sessionId)
        if (isDelegation && progress(spec, windowUsed).exhausted === true) {
          return '[dsh-subagent-policy] 结算窗口内子代理数量已达上限（' + renderSpec(spec)
            + '，窗口内已用 ' + windowUsed + ' 个），本窗口内不要再派发新的子代理，请汇总已有结果作答；'
            + '配额' + windowLabel(settings) + '结算一次，到点后自动恢复。'
        }
        if (settings.toolGate === true && isDelegation === false
          && progress(spec, counters.used(sessionId)).met === false) {
          return '[dsh-subagent-policy] 本会话要求必须先委派：请先调用子代理工具补齐数量（'
            + describeSpec(spec) + '，本条消息已用 ' + counters.used(sessionId) + ' 个），再使用其它工具。'
        }
        return undefined
      })
    } catch (err) {
      ctx.logger?.warn?.('[dsh-subagent-policy] 注册 tools.guard 失败：' + String(err))
      return false
    }
    return true
  }

  /** 管理面 /state 的完整响应体。 */
  function stateReport() {
    const state = store.load()
    const counts = counters.snapshot()
    const specs = {}
    const directives = {}
    for (const [sessionId, entry] of Object.entries(state.bySession)) {
      specs[sessionId] = entry.spec
      const spec = specFor(sessionId)
      if (spec.enabled === false) continue
      const have = counters.used(sessionId)
      directives[sessionId] = {
        spec: renderSpec(spec),
        have,
        met: progress(spec, have).met,
        // 与运行时 section 调的是同一个函数 → 这里看到的就是模型实际收到的指令
        text: buildDirective(spec, have, { windowLabel: windowLabel(settings) }),
      }
    }
    return {
      version: 1,
      defaultSpec: state.defaultSpec,
      maxCorrections: settings.maxCorrections,
      toolGate: settings.toolGate,
      applyToSubagents: settings.applyToSubagents,
      settleSeconds: settings.settleMs / 1000,
      delegationTools: [...settings.delegationTools],
      bySession: specs,
      counts: counts.counts,
      used: counts.used,
      totals: counts.totals,
      settleIn: counts.settleIn,
      directives,
      // 排障：插件挂了哪些会话（徽标显示 0 时先看这里有没有本会话）
      agents: [...attached].slice(0, 32),
    }
  }

  /** agent 销毁：解掉挂载记录（计数留在 counters 里，展示口径不变）。 */
  function detach(agent) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return
    attached.delete(sessionId)
  }

  return {
    attach,
    attachAll,
    detach,
    specFor,
    delegationDepth,
    policyAppliesTo,
    noteStart,
    installGlobalCounting,
    enforceTurnStopping,
    resetFromEvent,
    installGuard,
    stateReport,
    attachedSessions: () => [...attached],
  }
}
