/**
 * dsh-subagent-policy 装配层。
 *
 * 这里只做「接线」，具体逻辑在：
 *   settings.js  配置归一化     store.js    策略持久化
 *   counters.js  计数与结算     runtime.js  三条腿（提示词 / 拦回 / 限流）
 *   routes.js    管理面 HTTP    diag.js     排障快照     http.js  安全预检
 *
 * 对外契约（scripts/smoke.mjs 与真实宿主都依赖，别改）：
 *   export const name = 'dsh-subagent-policy'
 *   export const inject = []            ← webServer / agents 都是可选服务，延迟装载
 *   export function apply(ctx, config)
 */

import { createCounters } from './counters.js'
import { dbg, debugEnabled } from './debug.js'
import { createDiag } from './diag.js'
import { createRuntime } from './runtime.js'
import { createRoutes, mountRoutes } from './routes.js'
import { PLUGIN_NAME, STORE_VERSION, resolveSettings } from './settings.js'
import { createStore } from './store.js'

export const name = PLUGIN_NAME

/**
 * 不声明任何必需服务：headless / tui 这类 profile 没有 webServer，
 * 但「强制子代理」本身不依赖它，声明成必需会让整个插件在这些 profile 里装不上。
 */
export const inject = []

/**
 * 幂等保护：cordis.patch.yml 的 `insert` 无条件追加、不去重，
 * profile patch 与 bundle 同时启用时 apply 会被调用两次 → 双份提醒、双份 guard、
 * 以及 duplicated exact route 报错。同一个 ctx 只装配一次。
 */
const appliedContexts = new WeakSet()

/**
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - profile 里 `insert[].config`
 */
export function apply(ctx, config) {
  if (appliedContexts.has(ctx) === true) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 当前上下文已装配过，跳过重复 apply')
    return
  }
  appliedContexts.add(ctx)

  const settings = resolveSettings(config)
  const store = createStore({ defaultSpec: settings.defaultSpec })
  const counters = createCounters({ clock: settings.clock, settleMs: settings.settleMs })
  const diag = createDiag({ store, version: STORE_VERSION })
  const runtime = createRuntime({ ctx, settings, store, counters, diag, debug: dbg })

  dbg('apply settleMs=' + settings.settleMs + ' defaultSpec=' + settings.defaultSpec
    + ' maxCorrections=' + settings.maxCorrections + ' debug=' + debugEnabled)

  // ① 计数兜底：根上下文收全部 subagent/start，按 ownership 归属到父会话
  runtime.installGlobalCounting()

  // ② agent 生命周期：新会话挂上，老会话枚举补挂（插件晚于会话创建加载时靠这个）
  watchAgents(ctx, runtime)

  // ③ 回合边界兜底（agent scope 里也挂了，这里防漏）
  try {
    ctx.on('session/event', (session, event) => runtime.resetFromEvent(String(session?.id ?? ''), event))
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 订阅根 session/event 失败：' + String(err))
  }

  // ④ 结算定时器：窗口过期的条目每 settleMs 清一次
  installSettleTimer(ctx, counters, settings)

  // ⑤ 可选硬门
  runtime.installGuard()

  // ⑥ 管理面（有 webServer 才有）
  mountManagement(ctx, runtime, store)
}

/**
 * 订阅 agent 生命周期。
 * `agent/created` 载荷是 `{ agent, source, signal }`（dsh-agent/lib/index.js:581-585）。
 */
function watchAgents(ctx, runtime) {
  const onCreated = (payload) => runtime.attach(payload?.agent ?? payload)
  const onDisposed = (payload) => runtime.detach(payload?.agent ?? payload)
  try {
    ctx.on('agent/created', onCreated)
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 订阅 agent/created 失败：' + String(err))
  }
  try {
    ctx.on('agent/disposed', onDisposed)
  } catch {
    /* 某些宿主没有 disposed 事件，无害 */
  }

  // agents 服务在 apply 时往往还没就绪（Electron 启动顺序），用 inject 延迟到就绪再枚举
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['agents'], (scope) => {
      const attached = runtime.attachAll()
      dbg('agents ready, attachAll=' + attached)
      try {
        scope.effect(
          () => scope.agents.on?.('agent/created', onCreated),
          'dsh-subagent-policy: agents-created',
        )
      } catch {
        /* 已经靠根 ctx 收到了，重复订阅失败无所谓 */
      }
    })
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 等待 agents 服务失败：' + String(err))
  }
}

/** 每 settleMs 清一次过期计数条目（unref，别把进程钉住）。 */
function installSettleTimer(ctx, counters, settings) {
  try {
    ctx.effect(
      () => {
        const timer = setInterval(() => {
          const dropped = counters.settleAll()
          if (dropped > 0) dbg('settle dropped=' + dropped)
        }, settings.settleMs)
        timer?.unref?.()
        return () => clearInterval(timer)
      },
      'dsh-subagent-policy: settle-timer',
    )
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 安装结算定时器失败：' + String(err))
  }
}

/**
 * 挂管理面。webServer 是可选服务：
 * 未声明 inject 时 `ctx.webServer` 会直接抛 "cannot get property"，只能用 ctx.get()。
 */
function mountManagement(ctx, runtime, store) {
  const routes = createRoutes({ runtime, store })
  let direct
  try {
    direct = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  } catch {
    direct = undefined
  }
  if (direct !== undefined && direct !== null) {
    mountRoutes(ctx, direct, routes, ctx.logger)
    return
  }
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('[dsh-subagent-policy] 没有 webServer，管理面不可用（强制逻辑照常工作）')
    return
  }
  try {
    ctx.inject(['webServer'], (scope) => {
      mountRoutes(scope, scope.webServer, routes, ctx.logger)
    })
  } catch (err) {
    ctx.logger?.warn?.('[dsh-subagent-policy] 等待 webServer 失败：' + String(err))
  }
}
