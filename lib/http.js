/**
 * 管理面用到的 HTTP 小工具。
 *
 * 官方给的 exact route **不做任何鉴权**（`dsh-host-webserver` 只是把 path 交给插件），
 * 所以四件套必须自己校验：回环地址、Host、Origin、sec-fetch-site。
 * 判定逻辑照抄官方插件 dsh-hidden-session 的做法（lib/index.js:110-130）。
 */

import { MAX_JSON_BODY_BYTES } from './settings.js'

/** 回环地址 + 浏览器同源标记。 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应（禁缓存、禁 referrer）。 */
export function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 读取 JSON 请求体；超限或非法时返回 undefined。 */
export async function readJsonBody(req) {
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

/**
 * 统一预检：回环 + 方法。返回 true 表示已被拒（响应已写）。
 * 三个 handler 各自重复五段样板是本文件存在的唯一原因。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} expectedMethod
 */
export function rejectUnlessAllowed(req, res, expectedMethod) {
  if (isLoopbackRequest(req) === false) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return true
  }
  if (req.method !== expectedMethod) {
    writeJson(res, 405, { error: 'method not allowed: ' + String(req.method) })
    return true
  }
  return false
}

/** 把异常压成一行可读文本。 */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
