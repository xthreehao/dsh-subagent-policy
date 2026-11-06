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
    /** 造一个假 agent（含它自己的 agent.ctx 与独立的 section 表）。 */
    makeAgent(id) {
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
        sections,
        steer: (message) => { steered.push(message) },
        steered,
        /** 在 agent scope 上派发事件（模拟 scoped dispatch）。 */
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
  const listenerBefore = host.listenerCount('agent/turn-stopping')
  plugin.apply(host.ctx, {})
  assert.equal(host.routes.size, 3, '路由数不该变')
  assert.equal(host.guards.length, guardBefore, 'guard 不该重复注册')
  assert.equal(host.listenerCount('agent/turn-stopping'), listenerBefore, '监听器不该重复注册')
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
  await host.emit('agent/turn-stopping', { agent, turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, 1, 'steer 次数')
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'subagent-policy')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.content[0].type, 'text')
})

await check('subagent/start 计数去重，达标后不再 steer', async () => {
  await agent.emit('subagent/start', { id: 'child-a' })
  await agent.emit('subagent/start', { id: 'child-a' })
  await agent.emit('subagent/start', { id: 'child-b' })
  const before = agent.steered.length
  await host.emit('agent/turn-stopping', { agent, turn: {}, signal: { aborted: false } })
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
    await host.emit('agent/turn-stopping', { agent: other, turn: {}, signal: { aborted: false } })
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

await check('回合边界：turn/start 重置本回合配额（用完还能再派）', async () => {
  const guard = host.guards[0]
  // 上一回合已经用掉 2 个，spec 此刻是 =1 → 本回合超上限，拦住
  const blocked = guard({ name: 'subagent', agent: { id: SESSION } })
  assert.equal(typeof blocked, 'string', '本回合超上限应被拦')
  assert.ok(blocked.indexOf('本回合') >= 0, '拒绝理由应说明按回合结算')

  // 用户发新消息 → turn/start
  await host.emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: 't2' } })

  assert.equal(guard({ name: 'subagent', agent: { id: SESSION } }), undefined, '新回合应重新放行')
  const before = agent.steered.length
  await host.emit('agent/turn-stopping', { agent, turn: {}, signal: { aborted: false } })
  assert.equal(agent.steered.length, before + 1, '新回合未达标应再次 steer（拦回次数已归零）')

  const state = await call(host, API + '/state')
  assert.equal(state.json.counts[SESSION], 0, '本回合计数应归零')
  assert.equal(state.json.totals[SESSION], 2, '累计计数应保留')
})

await check('trailing：策略 off 时 section 为空（不占上下文）', async () => {
  await call(host, API + '/set', { method: 'POST', body: { sessionId: SESSION, spec: 'off' } })
  const section = agent.sections.get('subagent-policy:session')
  assert.equal(section.text(), '')
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
