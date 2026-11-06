/**
 * dsh-subagent-policy —— 浏览器侧（Client half）。
 *
 * 由 DSH 客户端 Module Loader 动态加载（package.json 的 dsh.client + exports "./client"）。
 * 免构建的普通 JS：只用 loader 提供的 react，不依赖任何 npm 运行时包。
 *
 * 能力：在输入框工具条左侧（官方 slot `conversation.input.left`，当前零占用）放一个
 * 「子代理策略」徽标，点开即可为**当前会话**单独设置约束：
 *   off / 必须 ≥1 / 恰好 n / >n / >=n / <n / <=n / a-b，也支持自由输入。
 * 徽标同时显示本会话已用子代理数量，超限或未达标时变色。
 *
 * 每会话状态来自宿主半的 /api/dsh-subagent-policy/state（fetch 带 same-origin cookie），
 * 写入 /set。sessionId 直接取自 slot 的标准 props（scope=session 的条目必带），
 * 因此不需要（也不应该）自己去猜「当前会话」。
 */

(function () {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-subagent-policy',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = require('react')
      var h = React.createElement

      var API_BASE = '/api/dsh-subagent-policy'
      var SLOT_NAME = 'conversation.input.left'
      var SLOT_ID = 'subagent-policy.control'
      var POLL_MS = 5000

      // ------------------------------------------------------------- 文案

      var zh = (typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        && navigator.language.toLowerCase().indexOf('zh') === 0)

      var DICT = zh
        ? {
          label: '子代理策略',
          title: function (desc, have) { return '本会话子代理策略：' + desc + '（已用 ' + have + ' 个）' },
          off: '不限制',
          any: '必须使用子代理（≥1）',
          eq: function (n) { return '恰好 ' + n + ' 个' },
          gt: function (n) { return '多于 ' + n + ' 个' },
          gte: function (n) { return '不少于 ' + n + ' 个' },
          lt: function (n) { return '少于 ' + n + ' 个' },
          lte: function (n) { return '不多于 ' + n + ' 个' },
          range: function (a, b) { return a + ' 到 ' + b + ' 个' },
          used: function (n) { return '已用 ' + n },
          custom: '自定义…',
          customHint: '例：>=2、=3、>1、<4、1-3、off',
          apply: '应用',
          cancel: '取消',
          invalid: '写法无法识别',
          failed: '保存失败：',
          presets: '常用',
          note: '未达标时宿主会拦截本回合并提醒模型继续派子代理；超上限会拒绝继续派发。',
        }
        : {
          label: 'Subagents',
          title: function (desc, have) { return 'Subagent policy for this session: ' + desc + ' (used ' + have + ')' },
          off: 'No constraint',
          any: 'Must delegate (≥1)',
          eq: function (n) { return 'Exactly ' + n },
          gt: function (n) { return 'More than ' + n },
          gte: function (n) { return 'At least ' + n },
          lt: function (n) { return 'Fewer than ' + n },
          lte: function (n) { return 'At most ' + n },
          range: function (a, b) { return a + ' to ' + b },
          used: function (n) { return 'used ' + n },
          custom: 'Custom…',
          customHint: 'e.g. >=2, =3, >1, <4, 1-3, off',
          apply: 'Apply',
          cancel: 'Cancel',
          invalid: 'Unrecognised syntax',
          failed: 'Save failed: ',
          presets: 'Presets',
          note: 'When unmet, the host re-enters the turn with a reminder; past the cap it refuses new subagents.',
        }

      /** 把规范 spec 字符串翻译成人话。 */
      function describe(spec) {
        if (typeof spec !== 'string' || spec === '' || spec === 'off') return DICT.off
        var m
        if (spec === 'any') return DICT.any
        if ((m = /^=(\d+)$/.exec(spec))) return DICT.eq(Number(m[1]))
        if ((m = /^>=(\d+)$/.exec(spec))) return DICT.gte(Number(m[1]))
        if ((m = /^>(\d+)$/.exec(spec))) return DICT.gt(Number(m[1]))
        if ((m = /^<=(\d+)$/.exec(spec))) return DICT.lte(Number(m[1]))
        if ((m = /^<(\d+)$/.exec(spec))) return DICT.lt(Number(m[1]))
        if ((m = /^(\d+)-(\d+)$/.exec(spec))) return DICT.range(Number(m[1]), Number(m[2]))
        return spec
      }

      // ------------------------------------------------------------- 精简 store

      function createStore(initial) {
        var listeners = []
        var state = initial
        return {
          get: function () { return state },
          set: function (next) {
            state = next
            var snapshot = listeners.slice()
            for (var i = 0; i < snapshot.length; i++) {
              try { snapshot[i]() } catch (e) { /* 单个订阅者异常不影响其它 */ }
            }
          },
          subscribe: function (fn) {
            listeners.push(fn)
            return function () {
              var index = listeners.indexOf(fn)
              if (index >= 0) listeners.splice(index, 1)
            }
          },
        }
      }

      /** { ready, bySession: {id: spec}, counts: {id: n}, defaultSpec } */
      var store = createStore({ ready: false, bySession: {}, counts: {}, defaultSpec: 'off' })

      /** 每个会话一份稳定快照（renderer 的 selector hook 需要引用稳定）。 */
      var snapshots = new Map()

      function snapshotFor(sessionId) {
        var state = store.get()
        var spec = state.bySession[sessionId] || state.defaultSpec || 'off'
        var count = typeof state.counts[sessionId] === 'number' ? state.counts[sessionId] : 0
        var prev = snapshots.get(sessionId)
        if (prev !== undefined && prev.spec === spec && prev.count === count) return prev
        var next = { spec: spec, count: count }
        snapshots.set(sessionId, next)
        return next
      }

      var sources = new Map()
      function sourceFor(sessionId) {
        var key = String(sessionId)
        if (sources.has(key) === false) {
          sources.set(key, {
            getSnapshot: function () { return snapshotFor(key) },
            subscribe: function (fn) { return store.subscribe(fn) },
          })
        }
        return sources.get(key)
      }

      // ------------------------------------------------------------- HTTP

      function request(path, body) {
        var options = { credentials: 'same-origin', headers: {} }
        if (body !== undefined) {
          options.method = 'POST'
          options.headers['content-type'] = 'application/json'
          options.body = JSON.stringify(body)
        }
        return fetch(API_BASE + path, options).then(function (response) {
          return response.json().catch(function () { return {} }).then(function (payload) {
            if (response.ok === false) {
              var error = new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
              error.code = payload && payload.errorCode ? payload.errorCode : undefined
              throw error
            }
            return payload
          })
        })
      }

      function loadState() {
        return request('/state').then(function (payload) {
          store.set({
            ready: true,
            bySession: payload.bySession || {},
            counts: payload.counts || {},
            defaultSpec: payload.defaultSpec || 'off',
          })
        }).catch(function () {
          // 宿主半不可用：徽标退化为只读，不影响输入框本身
          store.set({ ready: true, bySession: {}, counts: {}, defaultSpec: 'off' })
        })
      }

      function saveSpec(sessionId, spec) {
        return request('/set', { sessionId: String(sessionId), spec: spec }).then(function () {
          return loadState()
        })
      }

      // ------------------------------------------------------------- 组件

      var PRESETS = [
        { spec: 'off' },
        { spec: 'any' },
        { spec: '=2' },
        { spec: '=3' },
        { spec: '>2' },
        { spec: '<3' },
        { spec: '1-3' },
      ]

      function SubagentPolicyControl(props) {
        var sessionId = props.sessionId
        var snapshot = props.useSubagentPolicy(function (value) { return value })
        var spec = snapshot && snapshot.spec ? snapshot.spec : 'off'
        var count = snapshot && typeof snapshot.count === 'number' ? snapshot.count : 0
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var draftState = React.useState('')
        var draft = draftState[0]
        var setDraft = draftState[1]
        var errorState = React.useState('')
        var error = errorState[0]
        var setError = errorState[1]

        var active = spec !== 'off'
        var badge = active ? (spec === 'any' ? '≥1' : spec) : '–'

        function commit(next) {
          setError('')
          saveSpec(sessionId, next).then(function () {
            setOpen(false)
            setDraft('')
          }).catch(function (err) {
            setError((err && err.message) || DICT.invalid)
          })
        }

        var button = h('button', {
          key: 'trigger',
          type: 'button',
          title: DICT.title(describe(spec), count),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          // 不抢输入框焦点，弹出时也不触发发消息
          onMouseDown: function (event) { event.preventDefault() },
          onClick: function () { setOpen(!open); setError('') },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 24,
            padding: '0 6px',
            background: 'none',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            font: 'inherit',
            lineHeight: '24px',
            whiteSpace: 'nowrap',
          },
        }, [
          h('span', { key: 'icon', 'aria-hidden': true, style: { fontSize: 12, opacity: 0.9 } }, '⑃'),
          h('span', { key: 'spec', style: { fontSize: 11 } }, badge),
          h('span', {
            key: 'count',
            style: {
              fontSize: 10,
              padding: '0 4px',
              borderRadius: 4,
              background: 'var(--dsw-alias-fill-l2, rgba(0,0,0,.06))',
              opacity: active ? 1 : 0.6,
            },
          }, String(count)),
        ])

        if (open === false) return button

        var itemStyle = {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          font: 'inherit',
          color: 'var(--dsw-alias-label-primary)',
          background: 'transparent',
        }

        var menu = h('div', {
          key: 'menu',
          role: 'dialog',
          'aria-label': DICT.label,
          style: {
            position: 'absolute',
            bottom: 30,
            left: 0,
            zIndex: 40,
            width: 260,
            padding: 6,
            background: 'var(--dsw-alias-bg-elevated, #fff)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.14)',
            fontSize: 12,
          },
        }, [
          h('div', {
            key: 'presets',
            style: { padding: '2px 8px 4px', opacity: 0.6, fontSize: 11 },
          }, DICT.presets),
        ].concat(PRESETS.map(function (preset) {
          var selected = preset.spec === spec
          return h('button', {
            key: 'preset-' + preset.spec,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            onClick: function () { commit(preset.spec) },
            style: Object.assign({}, itemStyle, {
              background: selected ? 'var(--dsw-alias-fill-l2, rgba(0,0,0,.06))' : 'transparent',
            }),
          }, describe(preset.spec))
        })).concat([
          h('div', {
            key: 'sep',
            style: {
              height: 1,
              margin: '6px 4px',
              background: 'var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
            },
          }),
          h('div', { key: 'customLabel', style: { padding: '2px 8px 4px', opacity: 0.6, fontSize: 11 } }, DICT.custom),
          h('div', { key: 'customRow', style: { display: 'flex', gap: 4, padding: '0 4px 4px' } }, [
            h('input', {
              key: 'input',
              type: 'text',
              value: draft,
              placeholder: DICT.customHint,
              'aria-label': DICT.customHint,
              spellCheck: false,
              onMouseDown: function (event) { event.stopPropagation() },
              onChange: function (event) { setDraft(event.target.value); setError('') },
              onKeyDown: function (event) {
                if (event.key === 'Enter') { event.preventDefault(); commit(draft) }
                if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
              },
              style: {
                flex: 1,
                minWidth: 0,
                height: 26,
                padding: '0 6px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-l0, transparent)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
              },
            }),
            h('button', {
              key: 'apply',
              type: 'button',
              disabled: draft.trim() === '',
              onClick: function () { commit(draft) },
              style: Object.assign({}, itemStyle, {
                width: 'auto',
                padding: '0 8px',
                height: 26,
                background: 'var(--dsw-alias-fill-l2, rgba(0,0,0,.06))',
                opacity: draft.trim() === '' ? 0.5 : 1,
              }),
            }, DICT.apply),
          ]),
          error !== ''
            ? h('div', {
              key: 'error',
              role: 'alert',
              style: { padding: '4px 8px', color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 11 },
            }, (error.code === 'unrecognized' ? DICT.invalid : error.message))
            : null,
          h('div', {
            key: 'note',
            style: { padding: '6px 8px 2px', opacity: 0.6, fontSize: 10, lineHeight: 1.4 },
          }, DICT.note),
        ]))

        return h('div', {
          style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
        }, [button, menu])
      }

      // ------------------------------------------------------------- apply

      function apply(ctx) {
        loadState()
        var timer = null
        if (typeof setInterval === 'function') {
          // 计数在宿主内存里，定期拉一次即可（切会话 remount 不影响）
          timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            loadState()
          }, POLL_MS)
        }

        var disposeSlot = null
        if (ctx && ctx.slots) {
          disposeSlot = ctx.slots.inject(SLOT_NAME, function () {
            return ctx.slots.register({
              name: SLOT_NAME,
              id: SLOT_ID,
              order: 100,
              label: function () { return DICT.label },
              inject: function (sessionId) {
                return {
                  // hooks 会被 renderer 转成 useSubagentPolicy(selector)
                  hooks: { subagentPolicy: sourceFor(sessionId) },
                }
              },
            }, SubagentPolicyControl)
          })
        }

        var dispose = function () {
          if (timer !== null) { try { clearInterval(timer) } catch (e) { /* 忽略 */ } }
          if (typeof disposeSlot === 'function') { try { disposeSlot() } catch (e) { /* 忽略 */ } }
        }
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return dispose }, 'dsh-subagent-policy: ui')
        }
      }

      exports.apply = apply
      exports.inject = ['slots']
      exports.default = { apply: apply, inject: ['slots'] }

      return module.exports
    },
  })
})()
