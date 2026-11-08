/**
 * 排障日志。
 *
 * 打包运行的宿主（headless / Electron）拿不到 stdout，想知道「插件到底有没有跑到」只能落文件：
 * 设 `DSH_SUBPOLICY_DEBUG=<文件路径>` 即把关键事件追加进去；没设时全是空操作。
 */

import { appendFileSync } from 'node:fs'

const target = typeof process?.env?.DSH_SUBPOLICY_DEBUG === 'string'
  ? process.env.DSH_SUBPOLICY_DEBUG
  : ''

/** 是否开启了排障日志。 */
export const debugEnabled = target.length > 0

/**
 * 追加一行排障日志。写文件失败绝不影响主流程。
 * @param {...unknown} parts
 */
export function dbg(...parts) {
  if (debugEnabled === false) return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch {
    /* 排障失败不影响主流程 */
  }
}

/**
 * 把任意值压成一行短 JSON（循环引用、超长都能扛），用于日志里看对象。
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string}
 */
export function shortJson(value, limit = 300) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length <= limit ? text : text.slice(0, limit) + '…'
  } catch {
    return '<unserializable>'
  }
}
