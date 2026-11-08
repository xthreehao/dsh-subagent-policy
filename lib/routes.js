/**
 * 管理面路由：GET /state、POST /set、POST /clear。
 *
 * 全部走 createRoute 统一预检（loopback + 方法 + body + sessionId 校验），
 * 避免三段 handler 各抄一遍样板。鉴权逻辑与 dsh-hidden-session 同源：
 * 自建 /api 路由宿主不做鉴权，必须自己校验 loopback + Host + Origin + sec-fetch-site。
 */

import { describeSpec, parseSpec, renderSpec } from './policy.js'
import { errorText, readJsonBody, rejectUnlessAllowed, writeJson } from './http.js'
import { API_PREFIX } from './settings.js'
import { isValidSessionId } from './store.js'

/**
 * @param {object} deps
 * @param {ReturnType<import('./runtime.js').createRuntime>} deps.runtime
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @returns {Array<{method: 'GET'|'POST', path: string, handler: Function}>}
 */
export function createRoutes({ runtime, store }) {
  return [
    { method: 'GET', path: API_PREFIX + '/state', handler: () => reply(200, runtime.stateReport()) },
    { method: 'POST', path: API_PREFIX + '/set', handler: setHandler(store) },
    { method: 'POST', path: API_PREFIX + '/clear', handler: clearHandler(store) },
  ]
}

/** 提交策略：{ sessionId, spec } → 落盘并回显规范化后的 spec 与中文描述。 */
function setHandler(store) {
  return async (body) => {
    const sessionId = readSessionId(body)
    const parsed = parseSpec(body?.spec)
    if (parsed.ok !== true) {
      return reply(400, { ok: false, error: parsed.error, ...describeError(parsed) })
    }
    store.setSpec(sessionId, parsed.spec)
    return reply(200, {
      ok: true,
      sessionId,
      spec: renderSpec(parsed.spec),
      description: describeSpec(parsed.spec),
    })
  }
}

/** 清掉本会话的策略，回到 config.defaultSpec。 */
function clearHandler(store) {
  return async (body) => {
    const sessionId = readSessionId(body)
    store.clearSession(sessionId)
    return reply(200, { ok: true, sessionId })
  }
}

/** handler 统一返回 {status, payload}，由 createRoute 负责写响应。 */
function reply(status, payload) {
  return { status, payload }
}

function describeError(parsed) {
  return {
    errorCode: parsed.error,
    message: ERROR_TEXT[parsed.error] ?? '约束写法无法识别',
  }
}

/** parseSpec 的错误码 → 用户能看懂的话（客户端直接显示 message）。 */
const ERROR_TEXT = Object.freeze({
  empty: '请输入约束，例如 2、>=2、<4、2-4、any 或 off',
  'out-of-range': '数字必须在 0 到 64 之间',
  'inverted-range': '区间起点不能大于终点，例如应写 2-4',
  unrecognized: '约束写法无法识别，例如 2、>=2、<4、2-4、any 或 off',
})

/** sessionId 必须能和 agent.id / session.id 对上，否则计数永远查不到。 */
function readSessionId(body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (isValidSessionId(sessionId) === false) {
    const err = new Error('invalid sessionId')
    err.status = 400
    err.code = 'bad-session-id'
    throw err
  }
  return sessionId
}

/**
 * 把路由挂到宿主 webServer 上。
 * 每条单独 try/catch：重复安装会撞 "duplicate exact route"，不能因此拖垮整个插件。
 */
export function mountRoutes(scope, server, routes, log) {
  if (Array.isArray(routes) === false || routes.length === 0) return 0
  let mounted = 0
  for (const route of routes) {
    try {
      scope.effect(
        () => server.register({
          kind: 'exact',
          path: route.path,
          handler: createRoute(route, log),
        }),
        'dsh-subagent-policy: route ' + route.path,
      )
      mounted += 1
    } catch (err) {
      log?.warn?.('[dsh-subagent-policy] 注册路由 ' + route.path + ' 失败：' + errorText(err))
    }
  }
  return mounted
}

/** 单个路由的完整处理链（预检 → 读 body → handler → 写响应）。 */
export function createRoute(route, log) {
  return async (req, res) => {
    if (rejectUnlessAllowed(req, res, route.method) === true) return
    let body
    if (route.method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (err) {
        writeJson(res, 400, { ok: false, error: 'bad-json', message: errorText(err) })
        return
      }
    }
    try {
      const result = await route.handler(body)
      writeJson(res, result.status, result.payload)
    } catch (err) {
      const status = Number.isSafeInteger(err?.status) ? err.status : 500
      if (status >= 500) log?.warn?.('[dsh-subagent-policy] ' + route.path + ' 处理失败：' + errorText(err))
      writeJson(res, status, { ok: false, error: err?.code ?? 'internal', message: errorText(err) })
    }
  }
}
