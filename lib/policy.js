/**
 * dsh-subagent-policy —— 纯逻辑层：子代理约束规格（spec）的解析、规范化与判定。
 *
 * 这一层刻意不 import 任何 DSH / Node / React 模块，宿主半与测试共用，
 * 因此规格文法是唯一真相：客户端只负责把用户输入的字符串交给宿主校验。
 *
 * 支持的写法（大小写不敏感，允许全角符号与前后空白）：
 *   off | none | 关闭 | 不用        -> 关闭约束
 *   any | 必须 | *                  -> 至少 1 个（必须用子代理）
 *   3 | =3 | ==3                    -> 恰好 3 个
 *   >2 | >=2 | 全角 ＞＝2           -> 多于 / 不少于 2 个
 *   <4 | <=4 | 全角 ＜＝4           -> 少于 / 不多于 4 个
 *   2-4 | 2..4 | 2~4 | 2至4         -> 2 到 4 个（含端点）
 *
 * 数字一律为 0..64 的整数；eq 0 等价于关闭。
 */

/** 允许的最大子代理数量上限，防止误输入 >999999 这类无意义约束。 */
export const MAX_COUNT = 64

/** 规格对象：{ enabled, op, n, m?, raw } */
export const OPS = Object.freeze(['eq', 'gt', 'gte', 'lt', 'lte', 'range', 'any'])

/** 全角 -> 半角，并压缩空白。 */
function normalizeText(input) {
  if (typeof input !== 'string') return ''
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\u2265\u2267]/g, '>=')
    .replace(/[\u2264\u2266]/g, '<=')
    .replace(/\u3000/g, ' ')
    .trim()
}

/** 解析一个整数计数，越界或非整数返回 undefined。 */
function parseCount(text) {
  if (!/^\d{1,6}$/.test(text)) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) return undefined
  return n
}

/**
 * 解析用户输入为规格对象。
 * @param {unknown} input 用户输入（字符串）
 * @returns {{ ok: true, spec: object } | { ok: false, error: string }}
 */
export function parseSpec(input) {
  const text = normalizeText(input)
  if (text === '') return { ok: false, error: 'empty' }

  const lower = text.toLowerCase()

  if (lower === 'off' || lower === 'none' || text === '关闭' || text === '不用' || lower === 'false') {
    return { ok: true, spec: { enabled: false, op: 'off', n: 0, raw: 'off' } }
  }
  if (lower === 'any' || text === '必须' || text === '*' || text === '是' || lower === 'on') {
    return { ok: true, spec: { enabled: true, op: 'any', n: 1, raw: 'any' } }
  }

  // 区间：2-4 / 2..4 / 2~4 / 2至4
  const rangeMatch = /^(\d{1,6})\s*(?:-|\.\.|~|至|到)\s*(\d{1,6})$/.exec(text)
  if (rangeMatch) {
    const lo = parseCount(rangeMatch[1])
    const hi = parseCount(rangeMatch[2])
    if (lo === undefined || hi === undefined) return { ok: false, error: 'out-of-range' }
    if (lo > hi) return { ok: false, error: 'inverted-range' }
    return { ok: true, spec: { enabled: true, op: 'range', n: lo, m: hi, raw: `${lo}-${hi}` } }
  }

  // 带比较符：>=2 / >2 / <=4 / <4 / =3（含 Unicode 大于等于号）
  const cmpMatch = /^(>=|=>|>|<[=]?|=<|==|=)\s*(\d{1,6})$/.exec(text)
  if (cmpMatch) {
    const opText = cmpMatch[1]
    const n = parseCount(cmpMatch[2])
    if (n === undefined) return { ok: false, error: 'out-of-range' }
    const op = opText === '>' ? 'gt'
      : (opText === '>=' || opText === '=>') ? 'gte'
        : opText === '<' ? 'lt'
          : (opText === '<=' || opText === '=<') ? 'lte'
            : 'eq'
    // 中文输入法常打的 U+2265 / U+2264 已在 normalizeText 里归一为 >= / <=
    if (op === 'eq' && n === 0) return { ok: true, spec: { enabled: false, op: 'off', n: 0, raw: 'off' } }
    return { ok: true, spec: { enabled: true, op, n, raw: renderSpec({ op, n }) } }
  }

  // 裸数字：恰好 n 个
  if (/^\d{1,6}$/.test(text)) {
    const bare = parseCount(text)
    if (bare === undefined) return { ok: false, error: 'out-of-range' }
    if (bare === 0) return { ok: true, spec: { enabled: false, op: 'off', n: 0, raw: 'off' } }
    return { ok: true, spec: { enabled: true, op: 'eq', n: bare, raw: String(bare) } }
  }

  return { ok: false, error: 'unrecognized' }
}

/** 把规格渲染成规范文案（用于 UI 与提示词）。 */
export function renderSpec(spec) {
  if (!spec || spec.enabled === false) return 'off'
  switch (spec.op) {
    case 'any': return 'any'
    case 'eq': return `=${spec.n}`
    case 'gt': return `>${spec.n}`
    case 'gte': return `>=${spec.n}`
    case 'lt': return `<${spec.n}`
    case 'lte': return `<=${spec.n}`
    case 'range': return `${spec.n}-${spec.m}`
    default: return 'off'
  }
}

/** 人类可读的中文描述，用于提示词与界面。 */
export function describeSpec(spec) {
  if (!spec || spec.enabled === false) return '不限制'
  switch (spec.op) {
    case 'any': return '必须使用子代理（≥1）'
    case 'eq': return `恰好 ${spec.n} 个`
    case 'gt': return `多于 ${spec.n} 个`
    case 'gte': return `不少于 ${spec.n} 个`
    case 'lt': return `少于 ${spec.n} 个`
    case 'lte': return `不多于 ${spec.n} 个`
    case 'range': return `${spec.n} 到 ${spec.m} 个`
    default: return '不限制'
  }
}

/** 是否满足约束。count 为本次会话已发生的子代理调用次数。 */
export function isSatisfied(spec, count) {
  if (!spec || spec.enabled === false) return true
  const c = Number.isFinite(count) ? count : 0
  switch (spec.op) {
    case 'any': return c >= 1
    case 'eq': return c === spec.n
    case 'gt': return c > spec.n
    case 'gte': return c >= spec.n
    case 'lt': return c < spec.n
    case 'lte': return c <= spec.n
    case 'range': return c >= spec.n && c <= spec.m
    default: return true
  }
}

/**
 * 判定当前进度：还差多少、是否已到/超上限。
 * @returns {{ met: boolean, have: number, need: string, remaining: number, exhausted: boolean }}
 */
export function progress(spec, count) {
  const have = Number.isFinite(count) ? count : 0
  const met = isSatisfied(spec, have)
  if (!spec || spec.enabled === false) {
    return { met: true, have, need: 'off', remaining: 0, exhausted: false }
  }
  let remaining = 0
  let exhausted = false
  switch (spec.op) {
    case 'any': remaining = Math.max(0, 1 - have); break
    case 'eq': remaining = Math.max(0, spec.n - have); exhausted = have >= spec.n; break
    case 'gt': remaining = Math.max(0, spec.n + 1 - have); exhausted = have > spec.n; break
    case 'gte': remaining = Math.max(0, spec.n - have); break
    case 'lt': remaining = 0; exhausted = have >= spec.n; break
    case 'lte': exhausted = have > spec.n; break
    case 'range':
      remaining = Math.max(0, spec.n - have)
      exhausted = have > spec.m
      break
    default: break
  }
  return { met, have, need: renderSpec(spec), remaining, exhausted }
}

/** 给模型看的一段强制指令。 */
export function buildDirective(spec, count, opts = {}) {
  const p = progress(spec, count)
  const human = describeSpec(spec)
  const strict = opts.strict !== false
  const window = opts.windowLabel ?? '每 5 秒'
  const lines = [
    '[子代理策略 · 本会话强制]',
    `本会话要求：必须使用子代理（teammate/subagent）完成任务，数量约束：${human}（规格 ${renderSpec(spec)}）。`,
    `本条消息已使用：${p.have} 次（派够即停，不会再重复逼；并发限流窗口${window}）。`,
  ]
  if (!p.met) {
    lines.push(
      `当前未满足约束，还差 ${p.remaining} 次。`
      + '在满足之前不要给出最终答复：继续调用子代理工具（spawn_teammate / subagent / subagent_fork）。',
    )
  } else if (p.exhausted) {
    lines.push('已达到上限，不要再新增子代理；把已有子代理的结果汇总后给出最终答复。')
  } else {
    lines.push('约束已满足，可以汇总结果给出最终答复。')
  }
  if (strict) {
    lines.push(
      '硬性要求：不得以“任务太简单”“不需要拆分”为理由跳过子代理；'
      + '拆不出子任务时，也要至少派一个子代理做独立核验（复核结论、检查边界、补充反例）。',
    )
  }
  return lines.join('\n')
}

/**
 * 合成一次未达标提醒，塞回对话让模型继续。
 * @param {object} spec
 * @param {number} count
 * @param {{windowLabel?: string}} [opts]
 */
export function buildReminder(spec, count, opts = {}) {
  const p = progress(spec, count)
  const human = describeSpec(spec)
  const window = opts.windowLabel ?? '每 5 秒'
  return [
    `[子代理策略拦截] 本会话要求“必须使用子代理”，约束：${human}（规格 ${renderSpec(spec)}）。`,
    `本条消息目前已使用 ${p.have} 次，还差 ${p.remaining} 次（派够就停，不必再多派；并发限流窗口${window}）。`,
    '本轮回复被拦截：请立刻调用子代理工具补齐数量，然后再给出最终答复。'
    + '如果认为无法拆分，也必须派一个子代理做独立核验（复核结论 / 检查边界条件 / 补充反例）。',
  ].join('\n')
}
