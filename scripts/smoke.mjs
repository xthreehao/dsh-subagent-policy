/**
 * smoke.mjs —— 假宿主集成冒烟：不启动 DSH，用最小 cordis 仿真跑宿主半的关键路径。
 *
 * 覆盖：
 *   1. 加载插件（真实 import lib/index.js），确认 exports.apply/inject/name。
 *   2. agent/created → 注册 per-agent 提示词 section（text 为函数，随策略变化）。
 *   3. turn-stopping 未达标 → agent.steer 被调用一次，且带 notice source。
 *   4. subagent/start 计数 → 达标后不再 steer；同 id 重复不重复计数。
 *   5. 超上限 → tools.guard 拒绝继续派发。
 *   6. REST /state、/set（合法/非法 spec）、回环与同源拒绝。
 *
 * 用法：node scripts/smoke.mjs（全部通过时打印 PASS 并以 0 退出）
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 状态文件写到临时 DSH_HOME，绝不碰真实 ~/.dsh
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-subagent-policy-smoke-'))
process.env.DSH_HOME = sandbox

const plugin = await import('../lib/index.js')

let failures = 0
/** 顺序执行一个用例；用例可以是同步或 async（必须 await，否则后续用例会抢跑）。 */
async function check(label, fn) {
  try {
    await fn()
    console.log('  ✓ ' + label)
  } catch (err) {
    failures += 1
    console.log('  ✗ ' + label + '\n      ' + (err instanceof Error ? err.message : String(err)))
  }
}

// ───────────────────────────────────────────────────────── 假 cordis 宿主

function createHost(options = {}) {
  /** 事件名 -> 监听器[] */
  const listeners = new Map()
  const routes = new Map()
  const effects = []
  const guards = []

  /** 每个 agent scope 一份 section 表（真实 DSH 里 section 是按 scope 隔离的）。 */
  const systemPromptSections = new Map()
  function makeSystemPrompt(sections = systemPromptSections) {
    return {
      getSectionOrder: () => 600,
      section(spec) {
        sections.set(spec.name, spec)
        return () => sections.delete(spec.name)
      },
    }
  }
  const systemPrompt = makeSystemPrompt()

  const tools = { guard: (fn) => { guards.push(fn) } }

  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate exact route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  function makeCtx() {
    const scope = {
      logger: { info() {}, warn() {}, error() {} },
      effect(fn) {
        effects.push(fn())
      },
      on(event, fn) {
        const bucket = listeners.get(event) ?? []
        bucket.push(fn)
        listeners.set(event, bucket)
        return () => {}
      },
      get(service) {
        if (service === 'systemPrompt') return systemPrompt
        if (service === 'tools') return tools
        if (service === 'agents') return { list: () => [] }
        if (service === 'webServer') return webServerFor(scope)
        return undefined
      },
      // cordis 的延迟装载：等服务就绪后回调（这里假定 webServer 立刻可用）。
      inject(deps, callback) {
        if (deps.includes('webServer')) {
          // 注入后的 scope 才允许属性访问（真实 cordis 语义）。
          const injected = {
            logger: scope.logger,
            effect: scope.effect,
            on: scope.on,
            get: (service) => (service === 'webServer' ? webServer : scope.get(service)),
            webServer,
          }
          callback(injected)
        }
      },
    }
    if (options.exposeWebServer === false) {
      // 复刻真实 cordis：未声明 inject 时读 ctx.webServer 直接抛错。
      Object.defineProperty(scope, 'webServer', {
        configurable: true,
        get() {
          throw new Error('cannot get property "webServer" without inject')
        },
      })
    } else {
      scope.webServer = webServer
    }
    return scope
  }

  function webServerFor() {
    return options.exposeWebServer === false ? undefined : webServer
  }

  const ctx = makeCtx()
  const host = {
    ctx,
    routes,
    guards,
    systemPromptSections,
    /** 触发事件并等待所有监听器（含 async）完成。 */
    async emit(event, ...args) {
      const bucket = (listeners.get(event) ?? []).slice()
      const results = []
      for (const fn of bucket) results.push(await fn(...args))
      return results
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    /**
     * 造一个假 agent（含它自己的 agent.ctx 与独立的 section 表）。
     * @param {string} id
     * @param {{subagentDepth?: number}} [opts] 传 subagentDepth ≥1 表示这是子代理会话
     */
    makeAgent(id, opts = {}) {
      const steered = []
      const agentListenerMap = new Map()
      const sections = new Map()
      const ownSystemPrompt = makeSystemPrompt(sections)
      const agentCtx = {
        logger: ctx.logger,
        effect(fn) { effects.push(fn()) },
        systemPrompt: ownSystemPrompt,
        on(event, fn) {
          const bucket = agentListenerMap.get(event) ?? []
          bucket.push(fn)
          agentListenerMap.set(event, bucket)
          return () => {}
        },
        get(service) {
          if (service === 'systemPrompt') return ownSystemPrompt
          if (service === 'tools') return tools
          return undefined
        },
      }
      const agent = {
        id,
        ctx: agentCtx,
        // 与真实宿主同形：顶层 agent 没有 subagentDepth，子代理有
        options: opts.subagentDepth === undefined ? {} : { subagentDepth: opts.subagentDepth },
        session: { id, header: {} },
        sections,
        steer: (message) => { steered.push(message) },
        steered,
        /** 在 agent scope 上派发事件（模拟 scoped dispatch）。 */
        listenerCount: (event) => (agentListenerMap.get(event) ?? []).length,
        async emit(event, ...args) {
          const bucket = (agentListenerMap.get(event) ?? []).slice()
          const results = []
          for (const fn of bucket) results.push(await fn(...args))
          return results
        },
      }
      return agent
    },
  }
  return host
}

// ───────────────────────────────────────────────────────── 假 req/res

function makeReq({ method = 'GET', body, headers = {} } = {}) {
  const merged = {
    host: '127.0.0.1:57321',
    'sec-fetch-site': 'same-origin',
    ...headers,
  }
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: merged,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
    __options: options,
  }
}

const options = {}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body += chunk
      else if (chunk !== undefined) res.body += chunk.toString('utf8')
    },
  }
  return res
}

async function call(host, path, reqOptions) {
  const route = host.routes.get(path)
  assert.ok(route !== undefined, '没有注册路由 ' + path)
  const res = makeRes()
  await route.handler(makeReq(reqOptions), res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, json, headers: res.headers }
}

const API = '/api/dsh-subagent-policy'

// ───────────────────────────────────────────────────────── 用例

console.log('dsh-subagent-policy 宿主半冒烟')

await check('导出形状', () => {
  assert.equal(plugin.name, 'dsh-subagent-policy')
  assert.deepEqual(plugin.inject, [], '不硬依赖任何服务：无 webServer 的 profile 也要能生效')
  assert.equal(typeof plugin.apply, 'function')
})

const host = createHost()
plugin.apply(host.ctx, { maxCorrections: 2 })

await check('注册三条 REST 路由', () => {
  assert.deepEqual([...host.routes.keys()].sort(), [
    API + '/clear',
    API + '/set',
    API + '/state',
  ])
})

await check('重复 apply 幂等（不重复注册路由/监听器）', () => {
  const guardBefore = host.guards.length
  const listenerBefore = host.listenerCount('session/event')
  plugin.apply(host.ctx, {})
  assert.equal(host.routes.size, 3, '路由数不该变')
  assert.equal(host.guards.length, guardBefore, 'guard 不该重复注册')
  assert.equal(host.listenerCount('session/event'), listenerBefore, '监听器不该重复注册')
})

const SESSION = 'smoke-session-1'
const agent = host.makeAgent(SESSION)

await check('/set 写入策略', async () => {
  const result = await call(host, API + '/set', {
    method: 'POST',
    body: { sessionId: SESSION, spec: '>=2' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.spec, '>=2')
})

await check('/set 拒绝非法 spec', async () => {
  const result = await call(host, API + '/set', {
    method: 'POST',
    body: { sessionId: SESSION, spec: '>=2-3' },
  })
  assert.equal(result.status, 400)
  assert.ok(typeof result.json.errorCode === 'string')
})

await check('/set 拒绝跨站请求', async () => {
  const result = await call(host, API + '/set', {
    method: 'POST',
    body: { sessionId: SESSION, spec: 'any' },
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(result.status, 403)
})

await check('agent/created 注册了 per-agent 提示词 section 与 subagent/start 订阅', async () => {
  await host.emit('agent/created', { agent })
  assert.ok(agent.sections.has('subagent-policy:session'), '缺 section')
})

await check('section text 随策略求值（≥2 且已用 0 个 → 有内容）', () => {
  const section = agent.sections.get('subagent-policy:session')
  const text = section.text()
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0, 'section 应非空')
  assert.ok(text.indexOf('2') >= 0, 'section 应提到数量 2')
})

await check('turn-stopping 未达标 → steer 一次，且是 notice', async () => {
  await agent.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, 1, 'steer 次数')
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'subagent-policy')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.content[0].type, 'text')
})

await check('回归：turn-stopping 监听器挂在 agent scope（payload 无 agent 字段）', async () => {
  // 真载荷只有 { turn, signal }（dsh-agent-loop/lib/index.js:1001-1004）。
  // 曾经在根 ctx 上解构 `{ agent }` → agent 永远 undefined → 完全不拦。
  assert.equal(agent.listenerCount('agent/turn-stopping'), 1, 'agent scope 上应有且只有一个监听器')
  assert.equal(host.listenerCount('agent/turn-stopping'), 0, '根 ctx 不该再挂一个永远空转的监听器')
  // 旧写法（带 agent 字段的根派发）不该额外生效
  const before = agent.steered.length
  await host.emit('agent/turn-stopping', { agent, turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, before, '根派发不该再触发 steer')
})

await check('subagent/start 计数去重，达标后不再 steer', async () => {
  await agent.emit('subagent/start', { id: 'child-a' })
  await agent.emit('subagent/start', { id: 'child-a' })
  await agent.emit('subagent/start', { id: 'child-b' })
  const before = agent.steered.length
  await agent.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, before, '达标后不该再 steer')
})

await check('/state 反映策略与计数', async () => {
  const result = await call(host, API + '/state')
  assert.equal(result.status, 200)
  assert.equal(result.json.bySession[SESSION], '>=2')
  assert.equal(result.json.counts[SESSION], 2)
  const directive = result.json.directives[SESSION]
  assert.ok(directive !== undefined, '应有 directives')
  assert.equal(directive.met, true)
  assert.ok(directive.text.length > 0, 'directive 文本不该为空')
})

await check('maxCorrections 生效：未达标最多拦 2 次后放行', async () => {
  const other = host.makeAgent('smoke-session-2')
  await host.emit('agent/created', { agent: other })
  await call(host, API + '/set', { method: 'POST', body: { sessionId: 'smoke-session-2', spec: 'any' } })
  for (let i = 0; i < 5; i++) {
    await other.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  }
  assert.equal(other.steered.length, 2, 'steer 次数应等于 maxCorrections')
})

await check('tools.guard 拦截超上限的继续派发', async () => {
  assert.equal(host.guards.length, 1, '应注册一个 guard')
  const guard = host.guards[0]
  await call(host, API + '/set', { method: 'POST', body: { sessionId: SESSION, spec: '=1' } })
  const reason = guard({ name: 'subagent', agent: { id: SESSION } })
  assert.equal(typeof reason, 'string', '超上限应返回拒绝理由')
  assert.equal(guard({ name: 'read_file', agent: { id: SESSION } }), undefined, '普通工具不该被拦')
})

await check('用户发新消息（user/message）会立刻清窗口与拦回次数', async () => {
  const guard = host.guards[0]
  // 上一轮已经用掉 2 个，spec 此刻是 =1 → 窗口内超上限，拦住
  const blocked = guard({ name: 'subagent', agent: { id: SESSION } })
  assert.equal(typeof blocked, 'string', '窗口内超上限应被拦')
  assert.ok(blocked.indexOf('结算窗口') >= 0, '拒绝理由应说明按结算窗口算')

  // 用户发新消息 → session/event {type:'user/message'}（真实路径：派发在 agent scope 上）
  await agent.emit('session/event', { id: SESSION }, { type: 'user/message', data: { message: {}, source: { kind: 'user' } } })

  assert.equal(guard({ name: 'subagent', agent: { id: SESSION } }), undefined, '新请求应重新放行')
  const before = agent.steered.length
  await agent.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, before + 1, '新请求未达标应再次 steer（拦回次数已归零）')

  const state = await call(host, API + '/state')
  assert.equal(state.json.counts[SESSION], 0, '窗口计数应归零')
  assert.equal(state.json.totals[SESSION], 2, '累计计数应保留')
})

await check('turn/start 是每 step 都会触发的，不能当用户消息信号', async () => {
  const before = agent.steered.length
  // 先把这一轮"用满"：=1 且已派 2 个
  await agent.emit('subagent/start', { id: 'again-1' })
  await agent.emit('subagent/start', { id: 'again-2' })
  // 模拟 agent-loop 每个 drive 循环都发的 turn/start
  await agent.emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: 3 } })
  // 若 turn/start 被当作用户消息，窗口会被清空 → counts 归零；正解是保持不变
  const state = await call(host, API + '/state')
  assert.equal(state.json.counts[SESSION], 2, 'turn/start 不该清窗口')
  assert.equal(agent.steered.length, before, 'turn/start 不该引发新的拦回')
  // 收尾：清掉策略，避免影响后续用例
  await call(host, API + '/set', { method: 'POST', body: { sessionId: SESSION, spec: 'off' } })
})

await check('trailing：策略 off 时 section 为空（不占上下文）', async () => {
  await call(host, API + '/set', { method: 'POST', body: { sessionId: SESSION, spec: 'off' } })
  const section = agent.sections.get('subagent-policy:session')
  assert.equal(section.text(), '')
})

await check('子代理会话不被强制（否则会自乘出子代理树）', async () => {
  await call(host, API + '/set', { method: 'POST', body: { sessionId: SESSION, spec: 'any' } })

  // 子代理会话：delegationDepth ≥ 1
  const child = host.makeAgent('child-session-1', { subagentDepth: 1 })
  await host.emit('agent/created', { agent: child })

  assert.equal(child.sections.get('subagent-policy:session'), undefined, '子代理会话不该注入策略 section')
  await child.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(child.steered.length, 0, '子代理会话不该被拦回')

  const guard = host.guards[0]
  assert.equal(
    guard({ name: 'subagent', agent: child }),
    undefined,
    '子代理会话不该被数量上限拦住（它自己的子代理是合法递归，由 maxDepth 管）',
  )
  // 顶层会话仍被强制（=any 已达标 → 放行；用超上限场景验证它确实在被管）
  assert.equal(guard({ name: 'subagent', agent: { id: SESSION, options: {}, session: { id: SESSION, header: {} } } }), undefined)
})

await check('结算窗口：每 5 秒结算一次（过期自动清零、可再次派发）', async () => {
  const w = createHost()
  let fakeNow = 1_000_000
  plugin.apply(w.ctx, { settleSeconds: 5, maxCorrections: 2, clock: () => fakeNow })
  const a = w.makeAgent('win-session')
  await w.emit('agent/created', { agent: a })
  await call(w, API + '/set', { method: 'POST', body: { sessionId: 'win-session', spec: '=1' } })

  // 同一时刻派出 2 个 → 超过 =1 的上限
  await a.emit('subagent/start', { id: 'child-1' })
  await a.emit('subagent/start', { id: 'child-2' })

  const s1 = await call(w, API + '/state')
  assert.equal(s1.json.settleSeconds, 5, '/state 应报告结算窗口秒数')
  assert.equal(s1.json.counts['win-session'], 2, '窗口内应计 2')
  assert.ok(s1.json.settleIn['win-session'] > 0, 'settleIn 应给出距结算的剩余毫秒')
  assert.equal(typeof w.guards[0]({ name: 'subagent', agent: a }), 'string', '窗口内超上限应被拦')

  // 4.9 秒：还在同一个结算窗口内
  fakeNow += 4900
  assert.equal((await call(w, API + '/state')).json.counts['win-session'], 2, '未到 5 秒不应结算')
  assert.equal(typeof w.guards[0]({ name: 'subagent', agent: a }), 'string', '未到点仍然拦住')

  // 5.1 秒：结算，配额自动恢复
  fakeNow += 200
  assert.equal((await call(w, API + '/state')).json.counts['win-session'], 0, '过窗口应清零')
  // 徽标口径（used）不随窗口清零：否则用户会看到「明明派了 2 个，徽标却显示 0」
  assert.equal((await call(w, API + '/state')).json.used['win-session'], 2, '本条消息的已用数不该被窗口结算清掉')
  assert.equal(w.guards[0]({ name: 'subagent', agent: a }), undefined, '结算后应重新允许派发')
  assert.equal((await call(w, API + '/state')).json.totals['win-session'], 2, '累计数不清零')
})

await check('窗口结算不会把「已达标」的回合重新逼一遍', async () => {
  const w = createHost()
  let fakeNow = 2_000_000
  plugin.apply(w.ctx, { settleSeconds: 5, clock: () => fakeNow })
  const a = w.makeAgent('met-session')
  await w.emit('agent/created', { agent: a })
  await call(w, API + '/set', { method: 'POST', body: { sessionId: 'met-session', spec: '=2' } })

  await a.emit('subagent/start', { id: 'c1' })
  await a.emit('subagent/start', { id: 'c2' })
  fakeNow += 6000 // 5 秒窗口结算 → 计数归零
  assert.equal((await call(w, API + '/state')).json.counts['met-session'], 0, '窗口应已结算')

  const before = a.steered.length
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, before, '本回合已达标过，结算后不该再拦（否则每 5 秒又逼一轮）')

  await a.emit('session/event', { id: 'met-session' }, { type: 'user/message', data: { message: {}, source: { kind: 'user' } } })
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, before + 1, '新请求（用户新消息）应重新强制')
})

await check('回归：自己 steer 的消息不能被当成用户输入（否则 5 秒窗口死循环）', async () => {
  const w = createHost()
  let fakeNow = 3_000_000
  plugin.apply(w.ctx, { settleSeconds: 5, clock: () => fakeNow })
  const a = w.makeAgent('own-msg-session')
  await w.emit('agent/created', { agent: a })
  await call(w, API + '/set', { method: 'POST', body: { sessionId: 'own-msg-session', spec: '=1' } })

  // 先达标，再让窗口结算归零（真实轨迹里就是这一步之后被无限重逼）
  await a.emit('subagent/start', { id: 'own-c1' })
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, 0, '已达标不该 steer')
  fakeNow += 6000
  assert.equal((await call(w, API + '/state')).json.counts['own-msg-session'], 0, '窗口应已结算')

  const justBefore = a.steered.length
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, justBefore, '结算后不该重逼（已达标过）')

  // 子代理回报（agent-message/relay）与运行时快照都不是「用户新请求」，不能复位
  await a.emit('session/event', { id: 'own-msg-session' }, { type: 'user/message', data: { id: 'relay-1', source: { kind: 'agent-message', form: 'relay' } } })
  await a.emit('session/event', { id: 'own-msg-session' }, { type: 'user/message', data: { id: 'ctx-1', source: { kind: 'runtime-context', form: 'snapshot' } } })
  assert.equal((await call(w, API + '/state')).json.counts['own-msg-session'], 0, '窗口已被结算，不该被这些事件改动')
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, justBefore, '子代理回报/运行时快照不该复位「已达标」')

  // 造一条"我们自己注入的提醒"，看它被 append 成 user/message 后会不会被误判
  const forced = w.makeAgent('own-msg-session-2')
  await w.emit('agent/created', { agent: forced })
  await call(w, API + '/set', { method: 'POST', body: { sessionId: 'own-msg-session-2', spec: '=1' } })
  await forced.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(forced.steered.length, 1, '未达标应 steer 一次')
  const own = forced.steered[0]
  assert.equal(typeof own.id, 'string', 'steer 出去的消息应带 id（重放判据用）')

  // ① 原样重放（agent-loop 就是这么把它 append 成 user/message 的）
  // ② 只有 source.kind、没有 id ③ 只有 form:'notice'
  // 每轮「先重放自己的提醒，再 turn-stopping」：若真的被当成用户消息，拦回次数会被清零，
  // 于是永远拦不完；正确实现应该在第 3 次（maxCorrections）之后停下。
  for (let i = 0; i < 6; i += 1) {
    await forced.emit('session/event', { id: 'own-msg-session-2' }, { type: 'user/message', data: own })
    await forced.emit('session/event', { id: 'own-msg-session-2' }, { type: 'user/message', data: { source: { kind: 'subagent-policy' } } })
    await forced.emit('session/event', { id: 'own-msg-session-2' }, { type: 'user/message', data: { source: { form: 'notice' } } })
    await forced.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  }
  assert.equal(forced.steered.length, 3, '自己的提醒不该清拦回次数（应停在 maxCorrections=3，而不是无限拦）')

  // 真用户消息仍然要能复位
  await a.emit('session/event', { id: 'own-msg-session' }, { type: 'user/message', data: { id: 'real-user-1', source: { kind: 'user' } } })
  const before = a.steered.length
  await a.emit('agent/turn-stopping', { turn: {}, signal: { aborted: false } })
  assert.equal(a.steered.length, before + 1, '真用户新消息应重新强制')
})

await check('无 webServer 的 profile：延迟装载后仍挂上管理面路由', () => {
  const headless = createHost({ exposeWebServer: false })
  plugin.apply(headless.ctx, {})
  const missing = [API + '/state', API + '/set', API + '/clear'].filter((p) => !headless.routes.has(p))
  assert.equal(missing.length, 0, '未挂上的路由：' + missing.join(','))
})

// 收尾
try {
  rmSync(sandbox, { recursive: true, force: true })
} catch { /* 临时目录清不掉也不影响结论 */ }

if (failures > 0) {
  console.log('\nFAIL：' + failures + ' 个用例未通过')
  process.exit(1)
}
console.log('\nPASS：全部用例通过')
