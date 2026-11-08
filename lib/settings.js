/**
 * 配置解析与常量。
 *
 * 所有「魔法数字」只在这里出现一次：插件主体、路由、文案都从 settings 读，
 * 避免同一个默认值在 5 个文件里各写一遍（改一处漏四处）。
 */

/** 插件名（cordis 行名 / 日志前缀）。 */
export const PLUGIN_NAME = 'dsh-subagent-policy'

/** 管理面路由前缀。 */
export const API_PREFIX = '/api/dsh-subagent-policy'

/** 状态文件 schema 版本。 */
export const STORE_VERSION = 1

/** 请求体上限（管理面只传短 JSON）。 */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** 会话 id 白名单（DSH 会话 id 是 UUID，可能带 `session-` 之类前缀）。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 默认策略：不限制。 */
export const DEFAULT_SPEC = 'off'

/** 单条用户消息最多被「拦回」几次（防止无限续命）。 */
export const MAX_CORRECTIONS_DEFAULT = 3

/** 跨回合拦回硬上限 = maxCorrections × 该系数。 */
export const SESSION_CORRECTION_FACTOR = 4

/** 结算窗口默认 5 秒：窗口内派出的子代理才计入「限流」配额。 */
export const SETTLE_SECONDS_DEFAULT = 5
export const SETTLE_SECONDS_MIN = 1
export const SETTLE_SECONDS_MAX = 3600

/** 一次委派 = 下列任一工具被调用（部署分层会换名字，所以用集合而不是写死一个）。 */
export const DELEGATION_TOOLS_DEFAULT = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']

/** 提示词 section 名：全局唯一，且允许被 agent scope 同名覆盖。 */
export const SECTION_NAME = 'subagent-policy:session'

/** steer 消息的 source.kind —— 用来把「我们自己的提醒」和真人输入区分开。 */
export const MESSAGE_SOURCE_KIND = 'subagent-policy'

/** 自己注入消息 id 的记上限（超出就整体清空，够用且不会无限长）。 */
export const OWN_MESSAGE_ID_LIMIT = 512

/** source.summary 的上限（与 dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
export const SUMMARY_MAX_CHARS = 120

/** 把 config.settleSeconds 收敛成合法的毫秒窗口。 */
export function resolveSettleMs(config) {
  const raw = config?.settleSeconds
  const seconds = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(SETTLE_SECONDS_MAX, Math.max(SETTLE_SECONDS_MIN, Math.round(raw)))
    : SETTLE_SECONDS_DEFAULT
  return seconds * 1000
}

/**
 * 把宿主传入的 config 收敛成一份不可变的运行时配置。
 * @param {object} [config]
 * @returns {Readonly<object>} settings
 */
export function resolveSettings(config = {}) {
  const maxCorrections = Number.isInteger(config.maxCorrections) && config.maxCorrections >= 0
    ? config.maxCorrections
    : MAX_CORRECTIONS_DEFAULT
  const delegationTools = Array.isArray(config.delegationTools) && config.delegationTools.length > 0
    ? config.delegationTools.filter((item) => typeof item === 'string')
    : DELEGATION_TOOLS_DEFAULT.slice()
  return Object.freeze({
    defaultSpec: typeof config.defaultSpec === 'string' ? config.defaultSpec : DEFAULT_SPEC,
    maxCorrections,
    maxSessionCorrections: maxCorrections * SESSION_CORRECTION_FACTOR,
    toolGate: config.toolGate === true,
    applyToSubagents: config.applyToSubagents === true,
    settleMs: resolveSettleMs(config),
    clock: typeof config.clock === 'function' ? config.clock : Date.now,
    delegationTools: Object.freeze(delegationTools),
    delegationSet: new Set(delegationTools),
  })
}

/** 给文案用的窗口描述，例如「每 5 秒」。 */
export function windowLabel(settings) {
  const seconds = settings.settleMs / 1000
  return '每 ' + (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' 秒'
}
