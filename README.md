# dsh-subagent-policy

给 DeepSeek Harness（DSH）加一条**按会话生效**的硬规矩：**这个对话必须用子代理**，并且可以规定数量
（`=3`、`>2`、`<=4`、`2-5` 之类）。

- 每个会话各设各的，互不影响；
- 策略写进该会话的**系统提示**（每次请求都带），不是一次性的叮嘱；
- 回合结束时若没达标，宿主会把这一回合**接着跑下去**并提醒模型补派子代理（有次数上限，不会无限续命）；
- 超过上限还想再派，`tools.guard` 直接拒绝并回一条理由给模型；
- 输入框左侧有一个徽标，点开就能改，实时生效。

实测环境：DSH **0.2.1-rc.2**（Electron 桌面运行时，`E:\dsh\resources\app.asar`），
Node 24，profile 走自建 `DSH_HOME` 沙箱（全程没有碰本机 `~/.dsh` 和正在跑的 55934 实例）。

> **EN (short)** — A per-session "you must delegate to subagents" policy plugin for
> [DeepSeek Harness](https://github.com/deepseek-ai). Set a quota per conversation
> (`=n` / `>n` / `>=n` / `<n` / `<=n` / `a-b`); the host injects it into that
> conversation's system prompt every step, refuses to let the turn end while the
> quota is unmet (bounded number of nudges), and can hard-block further delegation
> past the cap. UI: a `⑃` badge on the left of the composer. Install = a junction
> under `<profile>/node_modules` plus one `insert` entry in `cordis.patch.yml`.
> No build step, zero runtime dependencies. Tested on DSH 0.2.1-rc.2.

---

## 0. 从 GitHub 装

```powershell
# 1) clone 到任意位置（本机已有一份：F:\code\dsh插件\dsh-subagent-policy）
git clone https://github.com/xthreehao/dsh-subagent-policy.git
# 2) 让 profile 能按名字解析到这个包
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction "$p\node_modules\dsh-subagent-policy" -Target '<clone 路径>' | Out-Null
# 3) 把第 2 节的 insert 七行追加到 $p\cordis.patch.yml，刷新页面
```


## 1. 语法

| 写法 | 含义 |
| --- | --- |
| `off` / `none` / `关闭` / `不用` / `0` | 不限制（默认） |
| `any` / `必须` / `*` / `on` | 至少 1 个（只要用了子代理就行） |
| `3` 或 `=3` | 恰好 3 个 |
| `>2` | 多于 2 个（至少 3） |
| `>=2` / `≥2` | 不少于 2 个 |
| `<3` | 少于 3 个（0~2） |
| `<=3` / `≤3` | 不多于 3 个（0~3） |
| `2-5` / `2..5` / `2~5` / `2至5` / `2到5` | 2 到 5 个 |

细节：

- 全角字符自动归一（`＞＝２` = `>=2`，`≧`/`≦` 也认）；
- 单个会话上限 64（`MAX_COUNT`），超出报 `out-of-range`；`5-2` 这种反向区间报 `inverted-range`；
- 认不出的写法报 `unrecognized`，界面上直接回显，不会静默失败。

## 2. 安装

包体必须**按名字可解析**：`<profile>/node_modules/<包名>` 指向本仓库（junction 即可，改代码原地生效）。
然后二选一：

**路径 A：profile 的 patch 层（热重载，无需重启）**

在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: subagent-policy
      name: dsh-subagent-policy
```

**路径 B：bundle（分发用，需重启）**

把包名加进 `<profile>/package.json` 的 `dsh.profile.bundles`，靠本包自带的 `cordis.patch.yml` 插入行。
**不要同时用 A 和 B**：`insert` 是无条件 append、不去重。万一真装了两份，插件自身做了幂等保护
（同一个上下文第二次 `apply` 直接跳过并打一条 warn）。

`lib/index.js`（宿主半）改动要**重启宿主**；`lib/client.js`（浏览器半）改动会被宿主 500ms 的
stat 轮询原地热换。

沙箱里已经这么装好了（可复制的完整命令见下面第 6 节）。

## 3. 用

打开任意会话 → 输入框左侧出现 `⑃` 徽标：

- 徽标文字 = 本会话策略（`–` 表示不限制，`≥1` 表示 `any`，其余显示规范写法），后面的小数字 = 本会话已用子代理数；
- 点开有 7 个预设（不限制 / ≥1 / =2 / =3 / >2 / <3 / 1-3）和一个自由输入框（`>=2`、`<4`、`1-3`、`off` 都行）；
- 选完立刻写服务端，无需重启，下一 step 的系统提示就变了（提示词 section 的 `text` 是函数，每 step 求值）。

## 4. 它是怎么"强制"的（以及为什么只能这么做）

三条腿，缺一条就变成"建议"：

1. **提示词**：`agent.ctx.effect(...)` 在 **agent scope** 注册 section `subagent-policy:session`，
   `order = getSectionOrder('TEAM_POLICY') + 1`。策略关闭时 `text()` 返回空串，DSH 会丢掉空 section，
   所以不开策略的会话**不占一点上下文**。
2. **回合不许提前结束**：订阅 `agent/turn-stopping`（serial），未达标就 `agent.steer(createUserMessage(...))`。
   agent-loop 的判定是"收件箱里有新消息就继续"（`dsh-agent-loop/lib/index.js:1000-1007`），
   这是官方唯一能让回合多跑一步的通路。提醒消息 `source.form = 'notice'`，不会被渲染成真人提问。
   每回合最多拦 `maxCorrections`（默认 3）次，防止无限续命；`signal.aborted` 时不动手。
3. **硬门**：`ctx.tools.guard()`（单调，返回字符串即拒绝）。默认只拦"已经超上限还要再派"；
   打开 `toolGate: true` 后，未达标时连普通工具也拦，逼模型先派子代理。

计数用 `agent.ctx.on('subagent/start')` 的 `info.id`（子会话 id，天然去重）。**必须在 agent scope 上订阅**：
事件 payload 没有 parent 字段，父会话归属完全靠 scoped dispatch。

### 两套计数：达标配额 vs 限流窗口（v0.2.1 修的语义）

v0.2.0 把「配额」整个做成 5 秒滑动窗口，结果是**明明派够了、5 秒一过又重新逼**，模型被拖成
每 5~7 秒派两个子代理的永动机（模型自己在 reasoning 里都说 "the window keeps resetting"）。
v0.2.1 拆成两套，各管一件事：

| 计数 | 范围 | 用途 | 何时清零 |
|---|---|---|---|
| `used`（**达标口径**） | 本条用户消息内派出的子代理 | 决定 `turn-stopping` 是否拦回、徽标显示几 | 用户发下一条**真消息**（`source.kind === 'user'`） |
| `counts`（限流口径） | 最近 `settleSeconds`（默认 5 秒）内派出 | `tools.guard` 拒绝超额继续派发 | 滑出窗口自动清 |
| `totals` | 本会话累计 | 面板/排障 | 永不清 |

- **派够就停**：`used` 达到约束后 `metInTurn` 置位，之后 `turn-stopping` 一律直接放行——
  窗口怎么结算都不会再逼，直到用户发下一条消息。
- **徽标不再显示 0**：徽标读 `used`（`/state.used`），所以「派了 2 个」就稳定显示 2，不会 5 秒后归零。

> ⚠️ 两个死循环坑，都已修：
> 1. **不能用 `turn/start` 当"用户发消息"信号**：agent-loop 的 `turn()` 每个 drive 循环都 append 一次
>    （`dsh-agent-loop/lib/index.js:938-949`），我们 steer 出来的续跑也会触发 → 每轮重新武装。
> 2. **不能把所有 `user/message` 都当用户输入**：会话里还有 `runtime-context`(snapshot)、
>    `skill-catalog`(catalog)、`agent-message`(relay，子代理回报)、`subagent-settled`(notice)、
>    `subagent-policy`(notice，我们自己的)。子代理一回报就复位 = 每派一轮重新逼一轮。
>    判据必须收窄到 `source.kind === 'user'`，再加一层「自己 steer 出去的消息 id」黑名单兜底。

`/state` 因此有四组数：`used`（本条消息内，达标口径，徽标用）、`counts`（当前限流窗口内）、
`totals`（本会话累计）、`settleIn`（距离本窗口结算还剩多少毫秒）。另有硬上限 `maxCorrections × 4` 兜底，
窗口异常不推进也不会无限续命。

### 只作用于顶层会话（v0.1.2 修的重要边界）

策略**只对用户直接对话的会话生效**，对子代理会话不生效（只计数、不注入指令、不拦回）。

原因很实际：`defaultSpec` 会对每个 session 生效，如果子代理会话也被要求「必须派子代理」，子代理就会去派孙代理，
一次简单提问就能自乘出一棵子代理树（实测：一个问题跑了 3 分钟、几十个会话、每个会话拦回 3 次）。

判定口径与官方 `delegationDepthOf` 一致：`max(session.header.delegationDepth, options.subagentDepth) > 0` 即为子代理会话
（`dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:111-115`），另用 `subagent/start` 报过的 id 兜底。
想让子代理也被强制，显式开 `applyToSubagents: true`——**强烈不建议**，递归深度只能靠 `dsh-subagent` 的 `maxDepth` 兜。

### 明确做不到

- 没有 finish/stop 校验钩子，无法在"模型给出最终答复"那一刻否决它——只能把回合续一步；
- 无法阻止 abort / max-tokens / error 结束回合；
- 不能强制模型调用**某个具体**工具，只能用提示词 + 工具门逼它走到那一步；
- `agent/pre-step` 返回 `{kind:'reject'}` 是**结束**回合，方向相反，别用。

## 5. 配置

`cordis.patch.yml` 里可带 config：

```yaml
- insert:
    - id: subagent-policy
      name: dsh-subagent-policy
      config:
        defaultSpec: 'off'          # 没单独设置的会话用这个策略
        maxCorrections: 3           # 单条消息最多拦回几次（派够就停，不会无限续命）
        settleSeconds: 5            # 并发限流窗口（秒）：同一个 5 秒窗口内不许超上限派发
        toolGate: false             # true = 未达标时连普通工具也拒
        applyToSubagents: false     # true = 子代理会话也被强制（默认关，否则会自乘成树）
        delegationTools:            # 算作"一次委派"的工具名（部署分层会换名）
          - subagent
          - subagent_fork
          - spawn_teammate
          - workflow
```

基础层是 `subagent` / `subagent_fork` / `workflow`，Teams 层（`@deepseek-ai/dsh-experimental-agent-team-profile`）
会换成 `spawn_teammate` 等，所以做成可配置集合而不是写死。

没有浏览器半的 profile（`headless`、`tui`）里插件照样强制：此时没有输入框徽标，
策略靠 `defaultSpec` 定；例如 `dsh --profile headless --patch .\sandbox\patch-headless.yml "run the tests"`，
patch 里写 `config: { defaultSpec: '=2' }`。注意插件包是**按 profile 目录**解析的，
每个 profile 的 `node_modules` 下都要有同名 junction（不是全局装一次）。

## 6. 隔离环境实测（可复现）

本机跑法（**不碰** `~/.dsh`，也不碰正在跑的 55934 实例）：

```powershell
# 端口随便挑一个空的；DSH_HOME 决定 profile 与状态文件的根目录
$env:DSH_HOME = 'F:\code\dsh插件\sandbox\home'
& 'E:\dsh\DeepSeek Harness.exe' `
  'E:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' `
  --profile subagenttest --port 57321 --no-open
```

装插件（热重载，不重启）：

```powershell
$p = "$env:DSH_HOME\profiles\subagenttest"
New-Item -ItemType Directory -Force "$p\node_modules" | Out-Null
New-Item -ItemType Junction "$p\node_modules\dsh-subagent-policy" -Target 'F:\code\dsh插件\dsh-subagent-policy'
# 再把第 2 节的 insert 三行写进 $p\cordis.patch.yml
```

验证过的证据（2026-11-06，0.2.1-rc.2）：

| 项目 | 结果 |
| --- | --- |
| 宿主半装载 | `GET /api/dsh-subagent-policy/state` → 200，返回 `defaultSpec/maxCorrections/delegationTools/bySession/counts/used/totals/settleIn/directives` |
| 浏览器半装载 | 页面 HTML 的插件 bundle 清单里出现 `dsh-subagent-policy/client.js`，取回合并 bundle（1.93 MB）含 `subagent-policy.control` / `conversation.input.left` |
| 写入与持久化 | `POST /set {sessionId:'e2e-demo-session', spec:'>=2'}` → 200；落盘到 `<DSH_HOME>/storages/dsh-subagent-policy.json` |
| 提示词实际内容 | `directives['e2e-demo-session'].text` 与该会话 section 用的是**同一个函数**，内容为"必须使用子代理…恰好 2 个…本条消息已使用：0 次（派够即停，不会再重复逼；并发限流窗口每 5 秒）…" |
| 重启后仍在 | 重启实例后 `GET /state` 仍返回 `bySession['e2e-demo-session'] = '>=2'`（状态文件持久化），启动日志无 `entry did not activate` |
| 本机污染 | `~/.dsh` 下没有 `dsh-subagent-policy.json`；真实实例进程未重启 |
| 真实回合（headless，`defaultSpec: '=2'`） | **收敛验证（v0.2.1）**：一句「回答：2+2=？只输出数字。」，16 秒结束，模型派 2 个子代理后直接答 `4`；debug 轨迹只有两条 `turn-stopping … used=2 window=0 corrections=0`（`used=2` 达标、`corrections=0` 说明一次都没拦），无 `steered` 行 → **不再出现 v0.2.0 那种每 5 秒重逼的永动机**。两个子代理会话均为 `attach skip-enforcement depth=1`（不自乘） |
| 早前回合（headless，12*13 / 27+58） | 模型派了 2 个子代理并汇总（156 / 85）；`turn-stopping spec==2 have=2`（达标，未拦回） |

安全面：管理路由自带回环 + Host + Origin + `sec-fetch-site` 四件套校验（照抄 `dsh-hidden-session`），
`sessionId` 走 `/^[A-Za-z0-9._-]{1,128}$/`，请求体上限 64 KB，状态文件 `0600` 原子写。

### 关于 webServer（踩坑记录）

`export const inject = []`：本插件**不硬依赖任何服务**。core（section / 拦回 / 闸门）不需要 webServer，
所以 headless、tui 这类 profile 里照样生效，只是没有浏览器设置面板（用 `config.defaultSpec` 定策略）。
管理面路由按两条路挂：

```js
const directServer = ctx.get('webServer')          // 未声明 inject 时只能用 get()
if (directServer) registerRoutes(ctx, directServer)
else ctx.inject(['webServer'], (scope) => registerRoutes(scope, scope.webServer))  // 延迟装载
```

两个真实踩坑：

1. **未声明 `inject` 时读 `ctx.webServer` 会抛** `Error: cannot get property "webServer" without inject`
   （cordis 的 Proxy 语义），必须走 `ctx.get('webServer')`；只有 `inject([...], cb)` 回调里的 scope 才能直接点属性。
2. 本机 cordis 的 `Inject` 类型只有 `(keyof M)[]` 或 name→config map，**不支持** `{ required, optional }`
   （`dsh/node_modules/@deepseek-ai/cordis/src/registry.ts:19`），所以只能靠 `ctx.inject()` 延迟挂。

## 7. 测试

```powershell
cd F:\code\dsh插件\dsh-subagent-policy
npm test          # 三件套：纯逻辑 + 宿主半 + 浏览器半
```

- `test/policy.test.mjs`：语法解析/渲染/进度/提醒文案，10 组 `node:test`；
- `scripts/smoke.mjs`：假 cordis 宿主跑真 `lib/index.js`——路由注册、跨站拒绝、per-agent section、
  `turn-stopping → steer`、计数去重、`maxCorrections` 上限、`tools.guard` 拦截、重复 apply 幂等、
  无 webServer profile 的延迟挂载（假宿主同样复刻"读未声明属性即抛"的语义）；
- `scripts/client-smoke.mjs`：假 `window.__ModuleLoader__` + 最小 React 仿真跑真 `lib/client.js`——
  slot 注册（`conversation.input.left` / `subagent-policy.control`）、`hooks.subagentPolicy` 契约、
  徽标与弹层渲染。

（Windows 上 `node --test` 必须显式给文件名，`node --test test\` 会 MODULE_NOT_FOUND。）

## 8. 卸载

删掉 `cordis.patch.yml` 里的三行 + `node_modules` 下的 junction（走路径 B 的还要删 bundle 条目），
重启宿主。状态文件 `<DSH_HOME>/storages/dsh-subagent-policy.json` 可留可删。

## 9. 文件

```
lib/policy.js   纯逻辑：语法解析 / 渲染 / 进度判定 / 指令与提醒文案（无宿主依赖，可单测）
lib/index.js    宿主半：状态持久化、per-agent prompt section、计数、turn-stopping 续命、tools.guard、REST
lib/client.js   浏览器半：输入框徽标 + 设置弹层（免构建，只用 loader 给的 react）
cordis.patch.yml 插入行（bundle 路径用）
test/ scripts/  单测与两半的冒烟
```
