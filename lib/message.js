/**
 * 消息构造与「谁发的」判定。
 *
 * 两个坑都在这里收口：
 *   1. steer 出去的消息必须带 `source.form = 'notice'`，否则派生历史会把它渲染成真人 prompt
 *      （对照官方 dsh-repeat-tool-reminder 的 REMINDER_SOURCE，lib/index.js:2235-2245）。
 *   2. agent-loop 会把 steer 的消息原样 `append("user/message", message)` 再进一次事件流
 *      （dsh-agent-loop/lib/index.js:1067-1073），所以「我们自己发的提醒」和「真人输入」
 *      在事件层几乎同形。判据必须收紧到 `source.kind === 'user'`，并用消息 id 兜底。
 */

import { randomUUID } from 'node:crypto'

import {
  MESSAGE_SOURCE_KIND,
  OWN_MESSAGE_ID_LIMIT,
  SUMMARY_MAX_CHARS,
} from './settings.js'

/** 官方的 createUserMessage（拿不到就用等价的普通对象）。 */
let createUserMessage = null
let loading = null

/**
 * 惰性加载 @deepseek-ai/dsh-llm/message。
 * 解析不到（比如被裁剪的宿主）也不该让插件挂掉，退回普通对象即可。
 */
export function loadMessageFactory() {
  if (loading === null) {
    loading = import('@deepseek-ai/dsh-llm/message')
      .then((mod) => {
        if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage
      })
      .catch(() => { /* 退回内置构造 */ })
  }
  return loading
}

/** source.summary 截断（别超过上下文摘要上限）。 */
export function boundSummary(summary) {
  const text = typeof summary === 'string' ? summary : ''
  return text.length <= SUMMARY_MAX_CHARS ? text : text.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
}

/**
 * 构造一条 user 角色消息（用于 steer 进 next-step 收件箱）。
 * @param {string} text
 * @param {string} summary - 一行摘要，会按 SUMMARY_MAX_CHARS 截断
 */
export function makeUserMessage(text, summary) {
  const input = {
    content: [{ type: 'text', text }],
    source: { kind: MESSAGE_SOURCE_KIND, form: 'notice', summary: boundSummary(summary) },
  }
  if (createUserMessage !== null) return createUserMessage(input)
  return { ...input, id: randomUUID(), role: 'user' }
}

/** 我们自己 steer 出去的消息 id（有上限，超了整体清空够用）。 */
const ownMessageIds = new Set()

export function rememberOwnMessage(message) {
  const id = message?.id
  if (typeof id !== 'string') return
  if (ownMessageIds.size >= OWN_MESSAGE_ID_LIMIT) ownMessageIds.clear()
  ownMessageIds.add(id)
}

export function isOwnMessageId(id) {
  return typeof id === 'string' && ownMessageIds.has(id)
}

/**
 * 会话里的 `user/message` 事件到底是不是「真人又发了一条消息」。
 *
 * 一个会话里的 user/message 至少有这些来源：
 *   user（真人）/ runtime-context(snapshot) / skill-catalog(catalog) /
 *   agent-message(relay，子代理回报) / subagent-settled(notice) / subagent-policy(notice，我们自己)
 * 只有 `source.kind === 'user'` 才算新请求 —— 否则「子代理一回报就复位配额」，
 * 表现就是模型每派完一轮又被逼一轮，永远收不了尾。
 */
export function isRealUserMessage(data) {
  if (data === undefined || data === null) return false
  if (isOwnMessageId(data.id)) return false
  const source = data.source
  if (source === undefined || source === null) return false
  if (source.kind !== 'user') return false
  if (source.form === 'notice') return false
  return true
}
