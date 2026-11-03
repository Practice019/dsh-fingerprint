# dsh-fingerprint 设计与验证记录

> 本文档是一个 AI 多代理协作过程的**原始记录**，不是写给新用户的使用手册（使用请看仓库根目录 README.md）。
> 它记录了 43 个章节（§0–§42）的设计决策、**每一次判断的证据**、以及被推翻的判断。
> 机器相关路径已替换为占位符（`<plugin-dir>`、`$DSH_HOME`、`<DSH-install>` 等）；
> 操作者私有的 provider / 模型 / 凭据 ref 名也已替换为通用代称（`provider-a`、`example/text-image`、`API_KEY_A` 等）。

## 术语表

- **主脑**：调度者，负责拆解任务、冻结接口契约、裁决分歧、验收产物。它不写代码。
- **W1–W7 / H1**：7 个持久工作代理（不是一次性任务）。各自拥有固定文件，跨任务复用。
- **§NN**：本文档的章节号，代表一次冻结或裁决。
- **冻结 / 冻结哈希**：记录一批文件的 SHA256 前缀，用它在事后证明“审计期间没人偷改文件”。
- **中和实验（变异测试）**：把修复临时改回旧行为，验证「恰好对应的测试变红」。用来证明测试不是空转。
- **反例验伪**：拿一个**已知不合格**的输入（如已装的第三方插件）跑同一个检查器，证明它**能红**。

> 正文是**按时间顺序**写下的原始记录：前半部分（§0–§8）最初是发给工作代理的接口契约，
> 后半部分（§9 起）是逐轮的裁决、核对回执与修复记录。
> **后续条款覆盖先前条款**，被推翻的判断一律保留原文并标注更正 —— 这是本文档刻意保留的部分。
> 本快照封版于 §42.6，**此后契约继续增长也不跟随**。

---

> 本文件是 6 路并发实现的唯一真相源。任何与本文件冲突的实现一律视为缺陷。
> 改动需求必须先回报主脑（主脑 = 调度者，详见文首术语表），由主脑改本文件后广播。

## 0. 目标

DSH Web UI 左侧栏新增面板入口「**指纹检测**」（order 40，排在 Purge 之后）。
点开是整页：勾选 DSH 已配置的模型 → 设轮次 → 跑 LM Fingerpoint Detection（`lmfpd-sdk`）→ 出排名表。

## 1. 身份常量

| 项 | 值 |
|---|---|
| 插件目录 | `<plugin-dir>/` |
| 包名 | `dsh-fingerprint` |
| 版本 | `0.1.0` |
| cordis patch insert id | `fingerprint` |
| panellist id / main key | `dsh-fingerprint` |
| 侧栏 order | `40` |
| 侧栏标签 | `指纹检测` |
| HTTP 前缀 | `/fingerprint` |

## 2. 已核实事实（实现时按此，不要再自行探索）

### 2.1 侧栏与页面槽位
- `sidebar.panellist`：`kind:"list", scope:"root"`。**registerOptions 只有三个字段：`id`(必填,string) / `order`(可选,number,默认0,升序) / `label`(可选,`string|()=>string`)**。
- 注册第二参数 = **React 组件**，宿主传 props `{ size:number, active:boolean }`；宿主不替你画图标。
- `main`：`kind:"keyed", scope:"root"`，**registerOptions 只有 `key`(必填,string)**；`key` 必须等于某个 panellist 的 `id`，否则点行抛 `main panel "<id>" is not registered`。
- 页面 props = `{...kit, ...injected, ...slotInjected.props, ...contextual}`；kit 含 `usePanelInfo/useSessions/useWorkspaces/useResource/useRemoteAccess/useSessionStatus/useSessionRetainInfo/useSessionAccess`；注册带 `locale` 时额外给 `t`。
- `inject` 必须是 **thunk**（`inject: () => ({...})`）。
- 真实 order 参照：plugins=0、skill-mcp-panel=1、schedules=10、purge=30。
- 新 id 默认已钉住，会直接出现在列表里。

### 2.2 客户端束（硬约束）
- **单文件 classic script，禁止 `import` / `export` 语法**（宿主用 `<script async>` 加载）。
- 必须包裹为：
```js
window.__ModuleLoader__.load({
  id: "dsh-fingerprint",
  factory: (require) => {
    const bundleModule = { exports: {} };
    Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    /* ... */
    bundleModule.exports.apply = apply;
    bundleModule.exports.inject = inject;
    return bundleModule.exports;
  }
});
```
- **外壳种子词只有 11 个**，只有这些能 `require`：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`
  → `@deepseek-ai/dsh-client-ui-primitives` / `-ui-slots` **磁盘上不存在**，是外壳种子，不要试图安装。
- 客户端入口**只认** `package.json` 的 `exports["./client"]`（字符串或 `{default:string}`），不看 `main`。
- `dsh.client.platform` 必须**严格等于** `"web"`。
- **`dsh.client.inject` 一律省略**（可选字段）。理由：我们只依赖 11 个外壳种子词，不依赖任何宿主图行；`inject` 只用于"先到依赖"，写错反而引入不确定性。
- **注意区分两个 inject**：`package.json` 的 `dsh.client.inject` 是**客户端图模块名**（省略）；`client.js` 里 `module.exports.inject` 是 **cordis 服务名**（必需，例如 `['slots']`）。
- 宿主投递路径 `/plugins/dsh-fingerprint/client.js`。

### 2.3 UI 原语可用清单（`@deepseek-ai/dsh-client-ui-primitives`，共 290 导出）
- **有**：`Button` `Checkbox` `Switch` `Input` `InlineEditor` `SegmentedControl` `SegmentedTabs` `Menu` `MenuGroup` `MenuItemButton` `MenuSurface` `Modal` `Toast` `Tooltip` `HoverCard` `Pill` `Tag` `StateDot` `TextShimmer` `DisclosureRow` `JsonTree` `JsonBlock` `CodeBlock` `MarkdownText` `StateDot`，约 150 个 `Icon*OutlineRegular|Medium` 图标，工具函数 `writeClipboard` `relativeTime` `useAnchoredPosition` `useModalLayer` `DEFAULT_*_MAX_LINES`。
- **没有**：`Table` `Select` `Progress` `Tabs` `Radio` `Textarea` `Notice` `Badge` `Card` `Divider` `Spinner` `Skeleton`。
  → **表格与进度条自己用 `<table>` / `<div>` + 内联样式画**，颜色用 CSS 变量 `var(--dsw-alias-*, fallback)`。
- 已证实 props：`Button {variant,className,onClick,children,"aria-label"}`；`Checkbox {label,checked,disabled,onChange:(checked)=>…}`；`Switch {checked,label,disabled,title,onChange}`；`Input`（原生 input 属性）；`SegmentedControl {id,label,value,disabled,options:[{value,label,disabled,title}]}`；`Tooltip {label,shortcutKeys,delayMs,side,disabled,children}`；`Toast {text,icon,holdMs,anchor,onDone}`。
- **图标取不到时必须回退内置 SVG，绝不渲染 `undefined`**（否则 React 抛错、宿主 retire 整格）。

### 2.4 宿主侧（服务端）API
- 服务名：`llm` / `settings` / `credentials` / `configEditor`。`inject = ['llm','settings']`，`credentials`/`webServer` 用 `ctx.get()` 可选取。
- `ctx.llm.listProviders()` → `[{id,name}]`（仅已注册）
- `ctx.llm.listConfigurableProviders()` → `[{provider,displayName,settingsNs,settingsPath,declared?,defaultBaseURL?,baseURLEnv?,nativeAuth?,error?}]`
- `ctx.llm.listModels(provider)` → `Promise<[{provider,id,name,description?,inputModalities?}]>`
- `ctx.settings.describe()` → `[{ns, schema, revision, value, base, user, ...}]`，`value` 为已解析值
- `await ctx.credentials.resolve(ref)` → `{value, source}` | `undefined`
- 无 credentials 时回退：`ctx.get('launchEnvironment').get(ref)?.value`
- `ctx.llm.stream({provider, model, messages, maxTokens, temperature, reasoningEffort, sessionId, signal})` → async 分片流，末尾必有 `finish` 分片

### 2.5 致命陷阱（必须绕开）
**pi-ai 的 `listModels` 在无 key 时返回 `[]`**（`MISSING_CREDENTIAL` → `return []`）。
⇒ **模型列表必须以 settings 里的 `models` 数组为主来源**，`ctx.llm.listModels()` 只作补充。
（本机 `provider-b` 指向 `http://127.0.0.1:7860/v1`，很可能没在跑；若只用 `listModels` 它会凭空消失。）

### 2.6 密钥边界
明文 key **只能在宿主侧取到**；前端 `credentials.describe()` 只回 `{configured,source?,writable}`。
⇒ 一切模型调用与指纹逻辑都在宿主侧，前端只做 UI + `fetch`。

### 2.7 传输层选择（**不用 typert remote**）
手写 `TypertRemoteService` + `@Remote` 装饰器在本机**无先例、未实测**。改用：
```js
ctx.get('webServer').register({ kind: 'prefix', path: '/fingerprint', handler })
```
先自证服务键：打印 `typeof ctx.get('webServer')?.register`。若不可用，退路见 §7。

## 3. 文件所有权（**严禁跨文件修改**）

> 下表出现的 `W1`–`W7` 是 7 个持久工作代理的代号（`W1` = 工作代理 1），它不是一次性任务；详见文首术语表。

| 文件 | 唯一所有者 |
|---|---|
| `package.json` `cordis.patch.yml` `lib/index.js` | W1 |
| `client.js` | W6 |
| `lib/detector.js` `test/detector.test.mjs` | W2 |
| `lib/probe.js` `test/probe.test.mjs` | W3 |
| `lib/aggregate.js` `test/aggregate.test.mjs` | W5 |
| `tools/selfcheck.mjs` `README.md` | W4 |

## 4. 模块接口（冻结）

### 4.1 `lib/detector.js`（W2）
```js
export const CACHE_PATH                                   // string
export async function getDetector(opts)                   // {force?:boolean} → {detector, builtAt, bankModelCount}
export function detectorStatus()                          // → {ready, builtAt, bankModelCount, cachePath, error}
export async function getBankModels()                     // → [{id, displayName, family, familyName}]
export async function warmup()                            // → {builtAt, bankModelCount}
export { generateChallenges, analyze, parseNumbers }      // 直接 re-export lmfpd-sdk
```
- 单例 + 懒加载，禁止每次调用重新 `loadDetector()`。
- `loadDetector()` 首次会下载约 3.6 MB 参考数据，缓存 `%LOCALAPPDATA%\lmfpd\data.bin`。
- 所有失败必须转成可读 `error`，不得让异常穿透到 HTTP handler。

### 4.2 `lib/probe.js`（W3）
```js
export const MIN_ABSOLUTE = 80
export const MIN_RATIO = 0.55
export const OK_END_REASONS = ['stop', 'end_turn', 'completed']
export function minimumNumbers(expectedCount)              // → max(80, ceil(expectedCount*0.55))
export function assessSample({ rawText, expectedCount, strict })
//  → { state:'complete'|'truncated'|'failed', text, rawText, count, expectedCount, error }
export async function runChallenge({ challenge, send, strict, signal, onProgress })
//  send: (prompt, { signal, onDelta }) => Promise<{ text, endReason }>
//  → { challengeId, prompt, expectedCount, state, text, rawText, count, firstByteMs, error }
export async function runRound({ count, strict, signal, send, onSample })
//  → { challenges, samples, analysis, error }
```
规则（照抄官方文档）：
- 有效回答至少 `max(80, ceil(expectedCount × 0.55))` 个 1–355 的整数。
- 非严格模式：流式收满 `expectedCount` 个整数即停 → `truncated`；JSON 超长部分截掉 → `truncated`。
- 严格模式：不截断，且要求 3 条全部有效。
- 结束原因必须 ∈ `OK_END_REASONS`；拒答/内容过滤/未完成 → `failed`。
- 先读 `dsh-llm` 的分片词表把 `{text, endReason, firstByteMs}` 从 `ctx.llm.stream()` 正确提取出来，把提取逻辑写成可注入的 `send`。

### 4.3 `lib/aggregate.js`（W5）
```js
export function aggregateRounds(rounds)   // rounds: [{ analysis, error }]
// → { decision, prediction, predictionName, family, familyName,
//     validRounds, totalRounds, agreement, confidence, stability,
//     ranking: [{model, displayName, family, familyName, score, probability, votes, meanRank}],
//     perRound: [{index, decision, prediction, predictionName, probability}] }
```
规则：
- 有效回合 = `analysis && analysis.decision === 'scored' && analysis.prediction`
- 胜者 = 有效回合 top1 得票最多者；平票按 `ranking` 平均 score 高者
- `agreement = winnerVotes / validRounds`（validRounds=0 时为 `null`）
- `confidence = median(有效回合的 numeric probability)`（无则 `null`）
- `stability`：validRounds < 2 → `'inconclusive'`；`agreement >= 2/3` → `'stable'`；否则 `'unstable'`
- `decision`：validRounds=0 → `'unscorable'`；validRounds<totalRounds → `'partial'`；否则 `'scored'`
- **必须纯函数、零 I/O、可离线单测。**

## 5. HTTP 契约（前缀 `/fingerprint`，全部返回 JSON）

统一失败体：`{"ok":false,"error":{"code":"...","message":"..."}}`，HTTP 200。未知路由 404。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fingerprint/status` | `{ok:true, detector:{ready,builtAt,bankModelCount,cachePath}}` |
| GET | `/fingerprint/targets` | 见下 |
| POST | `/fingerprint/run` | body `{targets:[{provider,model}], rounds, count, parallel, strict, timeoutSec, gapSec}` → `{ok:true,runId}`；已有运行中任务 → `{ok:false,error:{code:'BUSY'}}` |
| GET | `/fingerprint/run/<runId>` | 状态快照 |
| GET | `/fingerprint/run/<runId>/events` | SSE，每 500ms 或状态变化推 `data: <snapshot>`，结束推 `event: done` |
| POST | `/fingerprint/cancel` | body `{runId}` → `{ok:true}` |
| GET | `/fingerprint/run/<runId>/export` | 完整原始数据（challenges / samples / analysis / aggregate） |
| POST | `/fingerprint/detector/refresh` | 强制重载 detector → `{ok:true,builtAt,bankModelCount}` |

`/fingerprint/targets` 返回体：
```json
{ "ok": true,
  "detector": { "ready": true, "builtAt": "2026-10-24T03:33:06Z", "bankModelCount": 42 },
  "providers": [
    { "provider": "provider-a", "displayName": "provider-a", "active": true,
      "api": "openai-completions", "baseURL": "http://<provider-host>:7863/v1",
      "credentialRef": "API_KEY_A", "credentialAvailable": true,
      "dormant": false, "error": null,
      "models": [ { "id": "example/text-image", "name": "example/text-image",
                    "source": "config", "contextWindow": 1048576, "maxTokens": 384000,
                    "input": ["text","image"] } ] } ] }
```
`source` ∈ `"config"`（settings 里的 models）| `"catalog"`（`listModels` 补充）。

运行快照：
```json
{ "ok": true, "runId": "r-1", "phase": "running|done|cancelled|failed",
  "startedAt": 1762000000000, "finishedAt": null,
  "options": { "rounds": 3, "count": 3, "parallel": 2, "strict": false },
  "tasks": [ { "provider":"provider-a", "model":"example/...", "round": 2, "totalRounds": 3,
               "state":"queued|waiting|streaming|complete|truncated|failed",
               "count": 287, "expectedCount": 300, "firstByteMs": 412, "error": null } ],
  "results": [ { "provider":"provider-a", "model":"example/...", "aggregate": { /* §4.3 结构 */ } } ] }
```

## 6. 环境事实

| 项 | 值 |
|---|---|
| DSH 运行时版本 | `0.2.1-rc.3` |
| 可用 CLI | `<DSH-install>/resources/runtime/cli/bin/dsh.cmd`（**必须用这条真实路径**；`resources\app\runtime\...` 那条是坏的，cmd 不解析 junction） |
| Node / pnpm | node 24.21.0；pnpm 11.28.5（在 `resources\app\runtime\primary-runtime\dependencies\`） |
| profile 目录 | `$DSH_HOME/profiles/desktop/` |
| 侧栏插件样例 | `...\node_modules\dsh-skill-mcp-panel\`（**正确模板**）、`...\node_modules\dsh-purge-community\` |
| ⚠️ 反例 | `$DSH_HOME/local-plugins/dsh-cwd-compat/` 在 desktop 里**未挂载**（无 `dsh.bundle`、不在 bundles），**不要照抄** |

## 7. 降级路径（仅当主路径失败）

- `ctx.get('webServer')` 不可用 → 换回 typert remote：`class X extends TypertRemoteService` + `super(ctx,'fingerprint')` + 手工 `bindTypertRemote`。
- `ctx.settings.describe()` 对第三方插件不可调 → `ctx.get('configEditor').configuration()`。
- 两者都失败 → 直接读 `ctx.loader.entries()` 兜底，并把失败原因写进 `/fingerprint/status`。

**任何降级都必须先回报主脑，不得静默改道。**

## 8. 通用约束

- 只改自己所有权内的文件。
- 不引入除 `lmfpd-sdk` 外的任何新依赖。
- ESM（服务端）；客户端束必须是 classic script。
- 所有注释用中文；代码标识符保持英文。
- 产出后必须给出**可复现的验证命令**与**实际输出**。
- 禁止执行任何会重启 DSH / 关闭 Electron 的操作。

---

## 9. 主脑裁决（增补，效力等同正文）

### 9.1 §4.3 输出结构以 W5 实现为准（补充契约）
`aggregateRounds` 实际输出（比 §4.3 多一个 `totalRounds`，且 `perRound` 多一个 `error`）：
```js
{ decision, prediction, predictionName, family, familyName,
  validRounds, totalRounds, agreement, confidence, stability,
  ranking: [{model, displayName, family, familyName, score, probability, votes, meanRank}],
  perRound: [{index, decision, prediction, predictionName, probability, error}] }
```

### 9.2 裁决 1：无胜者时顶层 `prediction` 用 `null`（不是空串）
- **顶层** `prediction / predictionName / family / familyName` 无胜者时一律 `null`。
- **`perRound[].prediction`** 保持 SDK 原样透传（官方在无排名时给空字符串 `''`）。
- ⇒ **前端（W6）必须把 `null` / `''` / `undefined` 一律视为「无排名」**，不得只判 `''`。

### 9.3 裁决 2：`totalRounds` 保留（brief 覆盖契约，已在此确认）

### 9.4 裁决 3：`agreement` / `confidence` 只统计**有效回合**（确认不变）
理由：`partial` / `not_model` / `unscorable` 回合**根本没有排名**，把它们计入分母会把「模型拒答」和「模型给出不同答案」混为一谈。
数据不会丢失——`validRounds` 与 `totalRounds` 同时输出，`decision` 已表达缺失程度。
**契约 §4.3 不变，W5 实现不需改动。**

### 9.5 确定性链（W5 已实现，固化为契约）
- 胜者决胜：`votes` 降序 → 平均 `score` 降序（`null` 视为 -∞） → `model` id 字典序升序
- `ranking` 排序：`votes` 降序 → `meanRank` 升序（`null` 视为 +∞） → `model` id 字典序升序
- 中位数：滤掉非有限值 → 升序 → 奇数取正中，偶数取中间两项算术平均，空集 `null`
- **两条排序链不是同一条，这是有意为之，不得"统一"**

### 9.6 联调对接点（给 W7）

> `W7` = 工作代理 7（负责 HTTP 层 `lib/index.js`），详见文首术语表。
`lib/index.js` 的 HTTP 层必须：
```js
import { aggregateRounds } from './aggregate.js'
// results: targets.map(t => ({ provider: t.provider, model: t.model,
//                              aggregate: aggregateRounds(roundsOf(t)) }))
```
`roundsOf(t)` = 该 `(provider,model)` 的每回合 `{ analysis, error }`，`analysis` 来自 `lib/probe.js` 的 `runRound()`。

---

## 10. ⚠️ 词表映射（修正 §4.2 / 更正 §4.2 的 OK_END_REASONS 归属）

**§4.2 的 `OK_END_REASONS = ['stop','end_turn','completed']` 是 lmfpd 词表**（`detect` 走 HTTP 时跨 API 归一用的），**不是 DSH 词表**。
我们走 A1（`ctx.llm.stream()`），DSH 的终止分片是 **tagged union，判别字段是 `kind`**：

```ts
{ kind:'stop' } | { kind:'tool-calls' } | { kind:'max-tokens' }
| { kind:'aborted'; failure:LlmFailure } | { kind:'error'; failure:LlmFailure }
```
证据：`dsh-llm/lib/typert.host.js:356`；失败分片生成见 `dsh-llm/lib/index.js:2401-2414`。

⇒ **`send` 适配器（W7 实现于 `lib/index.js`）必须做显式映射**：

| DSH `finish.reason.kind` | → 传给 probe 的 `endReason` | 判定 |
|---|---|---|
| `stop` | `'stop'` | ✅ 正常结束 |
| `max-tokens` | `'length'` | ❌ 除非非严格模式已收满 `expectedCount`（由 probe 判 `truncated`） |
| `tool-calls` | `'tool_calls'` | ❌ |
| `error` | `'error'` | ❌，须把 `failure.message` 带进 `sample.error` |
| `aborted` | 外部取消 → 取消；我们主动早停 → 按 `truncated` | — |

### 10.1 其余 stream 使用要点（W3 已取证）
- 正文**只累加 `type === 'text-delta'` 的 `chunk.text`**；**必须排除 `reasoning-delta`**（那是思考过程，不是回答）。证据：`dsh-llm/lib/typert.host.js:572`、`lib/types/assembler.js:34-83`
- 判别字段是 `chunk.type`，取值：`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`
- **`firstByteMs` 没有原生字段** —— `StreamChunk` 联合类型里无任何时间戳；只能由 send 侧自记首个 `text-delta` 到达时刻
- `GenerateOptions = { provider, model, messages, reasoningEffort?, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`；`messages` 用 `RequestUserInput`（`{role:'user', content}`）最省事，不需要持久 Message 的 `id`。证据：`typert.host.js:360,532`
- 流未给 finish 分片时，`BlockAssembler.finish` 默认 `{kind:'stop'}`（`lib/types/assembler.js:170-173`）

### 10.2 追加验收（W7 必须过）
`lib/index.js` 的 send 适配器必须有单测：**mock 一条 stream，断言 5 种 `finish.reason.kind` 全部被正确映射**，并断言 `reasoning-delta` 的内容**不进入正文**。

### 10.3 批准 W3 的附加导出
`ensureDetector()` / `bindDetector(binding)`（懒加载 + 可注入绑定）与 `assessSample` 额外返回的 `rawCount`/`minimum` —— 均为**附加**，不冲突，批准。

---

## 11. 主脑增补（W2 回执）

### 11.1 §4.1 更正：`analyze` **不是** `lmfpd-sdk` 的模块级导出
实测 SDK 顶层导出只有：`DEFAULT_DATA_URLS`、`Detector`、`buildRequest`、`generateChallenges`、`loadDetector`、`parseNumbers`、`requestSample`
（`node_modules\lmfpd-sdk\index.js:1998-2006`）—— **`analyze` 是 `Detector` 的实例方法**。
⇒ `lib/detector.js` 导出的是**同步包装** `analyze(outputs, options)`，同签名同返回值，内部用已加载的单例。
⇒ **同步是刻意选择**：`await` 一个同步返回值合法，所以调用方写 `analyze(...)` 或 `await analyze(...)` 都能工作。

### 11.2 调用约定（W7 必读，必须遵守）
`getDetector()` **失败时不抛异常**，返回：
```js
{ detector: null, builtAt: null, bankModelCount: null, error: "lmfpd 参考数据加载失败：<原文>" }
```
⇒ 调用方**必须先判 `detector === null`**，并把 `detectorStatus().error` 映射成 §5 的统一失败体
`{ ok:false, error:{ code:"DETECTOR_UNAVAILABLE", message } }`。
⇒ **永远不要不判空就 `detector.analyze(...)`**，否则 `Cannot read properties of null`。

### 11.3 §4.2 补丁（W3 必做，一行）
`lib/probe.js` 的 `ensureDetector()` 目前只 `import('./detector.js')` + 绑定三个导出，**从不调用 `getDetector()`**；
而 `runRound` 里是**同步** `analyze(...)` → 单例未加载时**每一轮都失败**成 `error: '评分失败：…'`，外部表现为「检测器坏了」。
⇒ `ensureDetector()` 必须在绑定校验**之前**加一行：
```js
await mod.getDetector()   // §4.1：必须先加载单例，同步 analyze() 才可用
```
（W2 已在 `detector.js` 加了导入期后台预热作为冗余保险；两者不冲突，两条都要。）

### 11.4 参考库实测事实（W7 / 验收用）
| 项 | 实测值 |
|---|---|
| `bankModelCount` | **64**（不是文档举例的 42）；首条 `claude-haiku-4.5` |
| `builtAt` | `2026-10-27T05:02:50.758637+00:00` |
| 首次加载 | ~2.5 s，下载 4.46 MB |
| 缓存文件 | `%LOCALAPPDATA%\lmfpd\data.bin` = 4,675,223 B；二次加载 ~82 ms |
| 环境变量 | `DSH_FINGERPRINT_LMFPD_CACHE` 覆盖缓存路径；`DSH_FINGERPRINT_NO_PREWARM=1` 关闭导入期预热（仅测试用） |

### 11.5 ⚠️ 验收方式的重要约束
用**离线合成数据**（随机数 / 排序整数）喂 `analyze`，**永远得不到 `scored`** —— 会被 SDK 的 sequence-check 判为：
```
decision=not_model  prediction=""  probability=null  results=0
evidence: "Consecutive numbers change differently from the language-model replies in the reference bank."
```
这是 SDK **正确工作**，不是缺陷。
⇒ **W7 端到端验收必须用真实模型回复**（走 `ctx.llm.stream()`）；纯离线只能覆盖 `not_model` / `unscorable`。
⇒ 同时确认 W5 口径自洽：`not_model` 时 `prediction === ''`（falsy）→ 被 §4.3 的「有效回合」条件正确排除。

### 11.6 已知无害副产品
`node_modules\.package-lock.json`（npm 内部文件，位于 node_modules 内）—— 保留，不清理。

---

## 12. 主脑增补（W1 冒烟实测 + W4 校验回执）

### 12.1 三个未验证前提 —— **已实测，全部通过，无需任何降级**
| 前提 | 实测结果 | 结论 |
|---|---|---|
| `ctx.settings.describe()` 第三方插件能否调 | `true`，**23 个 ns**（含 `llm-pi-ai` / `llm-deepseek` / `llm-deepseek-account` / `agent-default-model`） | **不降级**，`listTargets` 走主路径 |
| `ctx.get('webServer')?.register` | `typeof === 'function'`，ctor = `WebServer` | **不降级**，传输层走 §2.7 主路径 |
| provider 枚举 | `listProviders()` = `["deepseek-official","deepseek-account","provider-a","provider-b"]` | 与验收预期**完全一致** ✔ |

`configurableProviderIds` 共 **45** = 4 个已注册 + **41 个休眠目录项**（pi-ai 目录里 openai/anthropic/google/… 全为 `declared:true` 未注册）。
冒烟 `runs=7`，`errors={}`（零异常）。重组合实测耗时 **约 8 秒**，app 健康未重启。

### 12.2 webServer 落地 idiom（W7 必用，别自己发明）
```js
ctx.inject(['webServer'], (host) => {
  host.effect(() => host.webServer.register({ kind: 'prefix', path: '/fingerprint', handler }))
})
```
- `kind` 只有 `'exact'` / `'prefix'`；重复 `(kind, path)` 抛 `duplicate route`
- **`register` 返回 disposer**，必须包在 `host.effect(...)` 里
- `prefix` 为最长前缀优先（不会误吞他人路径）
- **端口就是 2418**（实测第三方路由在该端口返回 200）
- ⚠️ 不要在 `apply()` 里同步读 `ctx.webServer`，会拿到 `undefined`——必须用上面的 inject idiom

### 12.3 ⚠️ 安全硬要求（W7 必须实现，不得跳过）
裸 `webServer` registry **不继承 DSH Connection 的认证**（`@liustack/modsearch/dsh/index.js:888-896` 注释明确）。实测 `GET /` 返回 **401**，而插件路由绕过了这层。
⇒ `/fingerprint/*` 若不设防，**本机任意进程都能调 `/fingerprint/run`**，等于花用户的钱打模型。
⇒ W7 **必须**自带访问控制，参照 `dsh-purge-community/lib/index.js` 的 `allowPluginRequest` 政策。最低要求：
1. 只接受 `GET` / `POST`
2. 校验 `Host` 指向回环（`127.0.0.1:2418` / `localhost:2418`）
3. 校验 `Origin` / `Referer` 与 Host 同源
4. 限制请求体大小（例如 64 KB）
5. 回报里必须写明**采用的判据 + 残余风险**（诚实说明这挡不住能伪造 header 的本机进程）

### 12.4 `lib/targets.js` 冻结接口（W5 所有；W7 只可调用、不可修改）
```js
export async function listTargets(ctx)   // → { providers: [...] }
export function invalidateTargets()      // 清缓存（可选）
```
```js
providers[] = {
  provider, displayName,
  active,                 // false ⇒ 休眠（无适配器，不可检测）
  dormant,                // = !active，显式冗余字段，供前端直接用
  api, baseURL, credentialRef, credentialAvailable,
  error,                  // 该 provider 的配置诊断
  models: [ { id, name, source: 'config'|'catalog', contextWindow, maxTokens, input } ]
}
```
- **模型主来源 = settings 的 `models` 数组**（§2.5 陷阱：pi-ai 无 key 时 `listModels` 返回 `[]`）
- `ctx.llm.listModels()` **仅作 `source:'catalog'` 补充**，且必须 `try/catch`；**只对 `active === true` 的 provider 尝试**
- `credentialRef` = profile 的 `apiKeyEnv`；缺失时 `deriveKeyRef(provider)` = `<PROVIDER>_API_KEY`（非字母数字→`_`）
- `credentialAvailable`：`ctx.get('credentials')?.resolve(ref)?.value`，回退 `ctx.get('launchEnvironment')?.get(ref)?.value`
- **只回布尔，绝不把明文 key 放进任何返回体**

### 12.5 UI 休眠项处理（W6）
`/targets` 会返回 **45 个** provider，其中 41 个是休眠目录项。UI 必须：
- 已注册的 4 个（`active:true`）正常展示、可勾选
- 休眠项收进一个**默认折叠**的「未启用（41）」分组，**复选框禁用**，注明「该 provider 未启用适配器，无法检测」
否则页面上会白列出 41 行不可用的东西。

### 12.6 环境校准
`engines.node >= 22`；系统 PATH 上的 node 实测 **v24.15.0**，DSH 自带运行时清单写 24.21.0 —— 两者都满足，§6 的 24.21.0 指自带运行时。

### 12.7 文件所有权增补
- `.smoke.json` 归 **W1** 所有，属**开发期诊断产物**（主脑一次性授权），每次 `runSmoke()` 覆盖写。
- `tools/selfcheck.mjs` **必须忽略**它；它不进 `package.json` 的 `files`。
- 交付前必须重跑 `node tools/selfcheck.mjs`（W4 的 PASS 是**快照**，W1/W6 当时仍在写入）。

### 12.8 冻结：运行快照与 export 体形状（W7 必须产出，W6 已按此兼容）

**`GET /fingerprint/run/<runId>` →**
```json
{ "ok": true, "runId": "r-1", "phase": "running|done|cancelled|failed",
  "startedAt": 0, "finishedAt": null,
  "options": { "rounds":3, "count":3, "parallel":2, "strict":false, "timeoutSec":120, "gapSec":0 },
  "error": null,
  "tasks":   [ { "provider":"provider-a", "model":"x", "round":2, "totalRounds":3,
                 "state":"queued|waiting|streaming|complete|truncated|failed",
                 "count":287, "expectedCount":300, "firstByteMs":412, "error":null } ],
  "results": [ { "provider":"provider-a", "model":"x", "aggregate": { /* §9.1 结构 */ } } ] }
```
- **`error: string | null`** —— **run 级**致命原因（`phase==='failed'` 时非空），是**人类可读字符串**，不是对象。
  ⚠️ 不要与 §5 的**请求级**统一失败体 `{ok:false,error:{code,message}}` 混淆，两者层次不同。
- `tasks[]` **没有 per-task 时间戳** —— 前端不得展示「开始时间」（W6 会删掉那一列）。

**`GET /fingerprint/run/<runId>/export` →**
```json
{ "ok": true, "runId": "r-1", "phase": "done",
  "startedAt": 0, "finishedAt": 0, "options": { },
  "targets": [ { "provider": "provider-a", "model": "x",
                 "rounds": [ { "challenges": [ ], "samples": [ ], "analysis": { }, "error": null } ],
                 "aggregate": { } } ] }
```
- **`targets[]` 是权威形状**，W6 已按此实现，W7 照此产出即可（不要再发明 `runs[]` / `items[]`）。

### 12.9 客户端 `module.exports.inject` 冻结
```js
module.exports.inject = ['slots', 'locale']
```
`locale` 是必需的 —— `main` 注册带 `locale: NS`，宿主在 entry 带 `locale` 时才会向页面注入 `t()`。

### 12.10 W4 校验器语义裁决（保持现状）
- **C4 保持现状**：声明结构性错误 → FAIL；声明合规但目标文件尚未落盘 → SKIP。不改。
- **C13 保持现状**：接受 `export function apply` 的等价形式。不改。
- Node 版本差异已记入 §12.6。

---

## 13. lmfpd-sdk 缓存/数据源语义 —— **写测试时必须遵守**（主脑已逐行复核）

> 起因：主脑曾要求 W3 用「`DSH_FINGERPRINT_LMFPD_CACHE` 指向不存在路径」来构造加载失败路径。
> **该指令是错的**，被 W3 用源码证伪，主脑已逐行核对确认。以下为更正后的事实。

`node_modules/lmfpd-sdk/index.js`：

| 行 | 行为 |
|---|---|
| `1848-1853` | `readDir()`：读不到文件 → **确定性抛** `Cannot read <path>.` |
| `1857-1867` | `readCache()`：整体 `catch { return; }` → 缓存读不到**静默返回 `undefined`**，不抛 |
| `1868-1879` | `writeCache()`：自动 `mkdir(dirname, {recursive:true})`，失败被 `catch` 吞掉（只清 staging） |
| `1886-1913` | `refresh()`：所有来源都失败才抛 `lmfpd: cannot download reference data from …` |
| `1916-1917` | **单个非 `http(s)` 来源 → 直接 `return readDir(source)`，完全不联网** |
| `1918-1920` | 缓存未命中 → **回落去 `refresh()` 联网下载** |

### 结论（硬规则）
1. **缓存层永不抛错**。打 `cache` 路径构造失败路径 = 得到「有网就绿、断网才红」的 flaky 测试。**禁止这么做。**
2. 要构造**确定性、零网络**的失败路径，必须打 **`source`**：
   ```js
   await ensureDetector({ source: '<不存在的本地目录>' })   // → 确定性抛 Cannot read …
   ```
3. 真实数据来源目录需同时含 `unified_bank.json` 与检测参数文件。

### 13.1 W3 裁决（两条均**接受**）
1. **接受**把「cache 路径」触发点替换为「`source` 路径」触发点 —— 主脑原指令基于错误假设。
2. **批准** `ensureDetector(options)` 的附加可选参数：透传给 `getDetector(options)`，默认 `{}`，既有调用点（`runChallenge` / `runRound`）行为不变。
   ⇒ §4.2 的 `ensureDetector()` 签名更正为 **`ensureDetector(options?)`**。

### 13.2 反证验证纪律（W3 已示范，作为团队标准）
W3 把该行临时中和成 `loaded = { detector: {} }` 重跑 → **恰好对应的 3 条变红、其余 22 条全绿**，随后原样还原。
⇒ **凡新增"防御性"测试，必须做一次中和实验证明它不是空转。** 只报 `pass` 不算证据。

---

## 14. W-targets 裁决与 `lib/targets.js` 增补（主脑）

### 14.1 批准项
- 附加导出 **`deriveKeyRef`**（沿用 §10.3 先例）。
- §12.4 签名不变。顺序确定性、错误隔离两层、缓存按 ctx 引用隔离 —— 全部认可。
- catalog 来源行的 `contextWindow` / `maxTokens` 为 `null`（`listModels()` 确实不公布这两字段）。

### 14.2 ⚠️ `credentialRef` 解析链更正（W5 必须改）
W5 指出 `deriveKeyRef` 兜底可能猜错 env 名：`deepseek-official` → `DEEPSEEK_OFFICIAL_API_KEY`，而实际约定是 `DEEPSEEK_API_KEY`。
**官方内置 Models 页的做法**（`dsh-client-ui-settings-models/lib/client.js:1379, 1404-1407`）是把 `entry.nativeAuth?.env` 里的 ref 也纳入探测。
⇒ `credentialRef` 解析链改为**按序探测**：
1. `profile.apiKeyEnv` ← 首选，正常配置走这条
2. `entry.nativeAuth?.env[]` 中的每一个
3. `deriveKeyRef(provider)` ← 最后兜底
返回**第一个命中的 ref**；都没命中则返回 `deriveKeyRef(provider)` 的结果，并在 `credentialRefSource` 字段标 `'guessed'`（命中时标 `'profile'` / `'nativeAuth'`）。

### 14.3 `credentialAvailable` 改为**三态**（W5 必须改）
`true` | `false` | **`null`**
- **`null` = 无法判定**，用于 OAuth / 账号路由（例如 `deepseek-account`，其凭据不来自 env ref）
- 判定：`entry.nativeAuth?.oauth === true` 且前两级 ref 均未命中 → `null`
- **UI 契约（W6）**：`null` 显示为「**凭据由账号提供**」，**不得显示成「未配置」**

### 14.4 `/fingerprint/targets` 必须刷新缓存（W7）
handler 内**先调 `invalidateTargets()`，再 `listTargets(ctx)`** —— 用户点「刷新」必须拿到当前配置。
代价：每次多一次 `settings.describe()`，可接受。

### 14.5 `null` 渲染规则（W6）
以下字段可能为 `null`，**必须渲染成 `—`，不得显示成 `0` 或 `undefined`**：

| 字段 | 何时为 null |
|---|---|
| `models[].input` | 模态未知（与 SDK `inputModalities` 语义一致） |
| `models[].contextWindow` / `models[].maxTokens` | catalog 来源的行 |
| `credentialAvailable` | 见 §14.3（OAuth 账号路由） |
| `aggregate.agreement` / `aggregate.confidence` | 有效回合为 0（§9.4） |

### 14.6 性能结论
45 个 provider 时只有 4 个 active 会触发联网 `listModels`（`Promise.all` 并发），41 个休眠项零网络。无需额外限流。

---

## 15. 真机验收实测（主脑亲测，非转述）+ 三项裁决

### 15.1 端到端实测结果（**这才是"完成"的证据**）
主脑直接请求 `http://127.0.0.1:2418/fingerprint/*`（无 `Origin` 的回环请求被访问控制放行）：

```
GET /fingerprint/status  → 200 {"ok":true,"detector":{"ready":true,"builtAt":"2026-10-27T13:02:50.758637+08:00","bankModelCount":64,"cachePath":"%LOCALAPPDATA%\\lmfpd\\data.bin"}}
GET /fingerprint/targets → 200  providers 总数 45，active 4 = deepseek-official, deepseek-account, provider-a, provider-b
```

| provider | models | credentialRef | available | refSource |
|---|---|---|---|---|
| `deepseek-official` | 2 | **`DEEPSEEK_API_KEY`** | `false` | `profile` |
| `deepseek-account` | 2 | `DEEPSEEK_ACCOUNT_API_KEY` | `false` | `guessed` |
| `provider-a` | 3 | `API_KEY_A` | `true` | `profile` |
| `provider-b` | 1 | `API_KEY_B` | `true` | `profile` |

**§14.2 的修复被活证据证实**：`deepseek-official` 解析出 `DEEPSEEK_API_KEY`（正确约定值），而非兜底会猜的 `DEEPSEEK_OFFICIAL_API_KEY`。

真实模型链路（W7 实测）：`provider-a / acme/text-large` → `decision=scored`、`prediction=example-v1-flash-0101`、`probability=0.9096`；3 个样本 `complete 322/322` / `truncated 323/323` / `complete 319/319`，35.2 s。

### 15.2 ⚠️ 真机数据暴露的缺陷：`deepseek-account` 假阴性（W5 必须修）
实测 `deepseek-account`：`refSource=guessed`、`available=false`，**但它的 `models` 有 2 条且 `source='catalog'`**。
⇒ `catalog` 来源意味着 `listModels()` **真的返回了模型** ⇒ **这条路由的凭据是通的**（pi-ai 在无凭据时返回 `[]`）。
⇒ 现在被报成「未配置」，按 §14.5 会被 UI **置灰禁用** —— 挡掉一个可用 provider。

**同时回答了 W5 的未决 4**：真实数据里 `nativeAuth.oauth !== true`（严格布尔判定），所以 `null` 分支**在真实环境下永不触发**，判据写错了。

**更正后的判定规则（W5 必须实现）**：
```js
const accountRouted = Boolean(entry.nativeAuth?.oauth)   // 用 truthy，不用 === true
const catalogHasModels = catalogRows.length > 0          // listModels 真的返回了模型 = 凭据可用

credentialAvailable =
  source === 'guessed'
    ? (accountRouted || catalogHasModels ? null : false)  // 无法判定 ≠ 未配置
    : (await hasCredential(ref) ? true : false)           // profile/nativeAuth 是确定 ref
```
- `source === 'profile' | 'nativeAuth'` ⇒ 拿到确定 ref，正常判 `true`/`false`
- `source === 'guessed'` 且（账号路由 **或** catalog 有模型）⇒ **`null`（无法判定）**，UI 显示「凭据由账号/其他机制提供」
- `source === 'guessed'` 且两者都不成立 ⇒ `false`

### 15.3 W5 其余裁决
- **未决 1「命中」语义**：**确认** —— 指「该级提供了 ref 名字」，不是「该 ref 能 resolve 出值」。你的理由成立（否则探测需带 I/O 且顺序失去意义）。
- **未决 2**：`credentialRef` / `credentialRefSource` 在 provider 级异常路径退化为 `null` —— **接受**，属错误路径合法退化。已要求 W6 容错 `null`。
- **未决 3**：确认与 §14.3 一致（两个正交维度），但**判定式的具体形式被 §15.2 更正**。

### 15.4 W7 裁决
- **未决 6 —— `/targets` 保持静态 import `./targets.js`**。理由：**fail-fast**。若 `targets.js` 坏了，插件在加载期就失败、在「设置→插件清单」里显示 `failed`，比"`/status` 还能用但列表永远空"更容易发现。且 `targets.js` 有 16 条测试守着。
- **未决 1 —— 动 `profiles\desktop\cordis.patch.yml` 予以追认**（追加 3 行 YAML 注释，均为触发重组合所需，无组合副作用；已用 app-boot 同款 `JSON_SCHEMA` 复验）。但**下不为例**：以后改 profile 必须先报备。
- **未决 2 —— W4 的「`package.json.bak-fingerprint` 不存在」是误报**，该文件实际存在（684 B）。W4 的检查路径有缺陷，交付前需复核。

### 15.5 争议澄清：W7 误报「W3 的 §11.3 补丁未落盘」
W7 报告 `lib/probe.js` 里 0 处 `getDetector`。**主脑实测：5 处，含 `L139: loaded = await mod.getDetector(options);`，且 probe 单测 25/25 全绿。**
⇒ W7 的结论**错误**（大概率在补丁落盘前（05:23:05）取样）。W3 的补丁**在盘上**。
⇒ W7 在 `/run` 里的前置判空是**无害冗余**，保留。
⇒ **教训（团队标准）**：两个 agent 结论矛盾时，**两边都不能信，必须主脑实测裁定**。

---

## 16. 主脑实测：凭据形状与 `nativeAuth`（回答 W5 的第 2 / 4 问）

### 16.1 `deepseek-official` 的 `available=false` 是**正确**的，无 bug
主脑**只读键名、不打印任何值**地检查了 `$DSH_HOME/.credentials.yaml`（大小略）：
- **`DEEPSEEK_API_KEY` 出现行数 = 0** ⇒ 该 key 确实未配置
- 库中实际存在的 ref 名：3 个 key ref，后缀各不相同（记作 `API_KEY_A` / `API_KEY_B` / `API_KEY_C`）
- 另有三条 OAuth 形状记录：`client-connection/<session>`、`<provider>/device`、`<provider>/default`（含 `token` / `issuer`）

⇒ 这同时解释了为什么只有 `provider-a` / `provider-b` 能跑真实检测（它们的 ref 有值），以及 `deepseek-official` 报 `false` 属实。**不是 `hasCredential` 的缺陷。**

### 16.2 W5 的 Q2 假设被**证实**：`nativeAuth` 在本机是 `undefined`
主脑 grep 了 `dsh-deepseek-account`、`dsh-deepseek-account-platform`、`dsh-llm-deepseek-account` 三个包 → **`nativeAuth` 字面量 0 命中**。
⇒ `deepseek-account` 的 `nativeAuth` 为 `undefined` ⇒ `Boolean(undefined) === false` ⇒ **`accountRouted` 在本机是死代码**。
⇒ `credentialAvailable` 从 `false` 变 `null`，**完全由 `catalogHasModels` 这一半推出**（它的 2 条模型 `source='catalog'`）。
⇒ 印证 W5 的判断：**`15(b)` 那条「仅靠 catalog 也必须 null」的隔离用例才是真正的守门人。**
⇒ `accountRouted` **保留**（别的 provider / 别的机器可能命中），但**不得作为本机行为的解释依据**。

### 16.3 W5 的 Q3 补充规则（休眠项的旁证缺失）
`catalogHasModels` 只对 `active === true` 成立（§12.4 规定只对 active 问 catalog）。
⇒ 一个**休眠**的账号路由 provider，若 `oauth` 非真值且无 catalog，会落到 `false`。
⇒ **UI 备注（补 §14.5）**：休眠 provider 的「未检测到凭据」措辞应弱化，因为其凭据状态**无法通过 catalog 旁证**，本就不可靠。休眠项已被分组禁用，实际影响小。

---

## 17. §14.5 修订 + W6 裁决（主脑）

### 17.1 ⚠️ §14.5 的 `input` 一行**更正**（主脑原表格与派发消息自相矛盾，以本条为准）
| 字段 | `null` 时的渲染 |
|---|---|
| `models[].input` | **「输入: 未知」**（文字，不是 `—`）—— 模态未知是**语义上不同**的状态，不是数值缺席 |
| `models[].contextWindow` / `maxTokens` | `—`（数值缺席） |
| `credentialAvailable` | 「凭据由账号/其他机制提供」且**不置灰** |
| `aggregate.agreement` / `confidence` | `—` |
| （全局） | 渲染树文本**不得出现字面量 `undefined`** |

W6 按派发消息实现「输入: 未知」，**正确**，契约表格的错误由主脑承担。

### 17.2 W6 其余裁决（均**确认**）
1. **「未启用（N）」的 N = provider 数**（不是模型数）—— 确认。
2. **「全选」= 当前筛选范围内的可选行**（搜索时只勾匹配项）—— 确认，这是过滤列表的行业标准行为；**休眠项与无凭据项永不进入选择集**。
3. **`credentialRefSource` 用正向判定**（只认 `'profile'` / `'nativeAuth'` 两个确定值，其余 `null`/`undefined`/未知一律走弱化措辞）—— 确认。一个出错 provider 不能拖垮整页。
4. **宿主 `DisclosureRow` 折叠时是否仍渲染 children 未证实** —— **不作为阻塞项**。两种情况下功能均正确（最多多 41 行全 disabled 的 DOM），仅影响 DOM 体积。
5. `gapSec` 固定发 0 —— 已批准（§12.8）。
6. 冒烟 harness 已从 `%TEMP%` 删除 —— 不必收进 `tools/`（W4 的校验器已覆盖装载层）。

### 17.3 真机视觉验收清单（主脑无法代做，需操作者确认）
`/plugins/*` 与 `/` 受 DSH 认证保护（实测 `/` → 401），主脑无法从进程外读取页面 DOM。请人工确认：
1. 侧栏出现「**指纹检测**」，位置在 Purge 之后
2. 点开后：45 个 provider → **41 个收进默认折叠的「未启用（41）」分组**，4 个在主列表
3. `deepseek-account` **不置灰**且显示「凭据由账号/其他机制提供」；`deepseek-official` 置灰显示「未配置凭据，无法运行」
4. catalog 行显示「输入: 未知 / 上下文 — · 输出 —」（不得出现 `0` 或 `undefined`）

---

## 18. V-A 回执：真机接口一致性（61 字段穷举）

### 18.1 结论
- 客户端读取的 **61 个字段路径**穷举核对：**60 吻合**、1 项无害不一致。
- 三个最易出事的「null 是否存活」检查点全部通过**字面 null** 验证：`credentialAvailable`、`models[].input`、`error` / `firstByteMs`。
- **两层 `error` 未混用**：run 级是裸 `string|null`；请求级是 `{code,message}`。
- SSE 帧格式**字节级**确认：`data: {json}\n\n` + `event: done\ndata: {}\n\n`。
- 错误端点一律 **HTTP 200 + `{ok:false,error:{code,message}}`**，仅未知路由 404 ⇒ 客户端只对 404/405/501 判 `unready`，**不会误报「接口未就绪」**。
- `task.state` 6 值、`phase` 4 值、`options.*` 5 键、`tasks[]` 9 字段、`aggregate.ranking[]` 8 字段 —— 与客户端分支**逐条一致**。
- **零模型额度消耗**（用不存在的 provider 触发 `NO_ADAPTER`，3 ms 失败，`count=0`、`firstByteMs=null`、`rawText=""`）。

### 18.2 ⚠️ §9.2 措辞**更正**（主脑原表述不完整）
`perRound[]` 的 `decision` / `prediction` / `predictionName`：
- **`analysis === null`**（回合级错误，如「无有效样本」）⇒ **一律 `null`**
- **`analysis` 存在但无排名**（`partial` / `not_model`）⇒ 透传 SDK 原值，此时可能是 `''`

⇒ §9.2 原文「保持 SDK 原样透传」只覆盖第二种情形，现更正为上述两条。
⇒ 客户端用 `pickText()` 把 `null`/`undefined`/`''` 一视同仁，**两侧自洽，无需改码**。

### 18.3 已知无害项（记录，不在冻结期内改码）
| # | 内容 | 影响 |
|---|---|---|
| F1 | `client.js:1767` 读 `aggregate.error`，但 `lib/aggregate.js` 不产出该键 | **无害死读取**（`textOf(undefined)` → `—`；同处优先用来自 `tasks[].error` 的 `errorByTarget`） |
| F3 | `ranking[]` 8 字段为**静态核对**（为省额度未跑真实模型） | 待最终验收用一次真实运行补齐 |
| F4 | `credentialRefSource: null` 分支**未被真机数据覆盖**（实际只出现 `profile`/`nativeAuth`/`guessed`） | 代码路径安全 |
| F5 | `export` 内命名风格并存：`challenges[].expected_count`（snake）vs `samples[].expectedCount`（camel） | 客户端不读 `challenges`，无影响 |

### 18.4 修复政策（冻结期纪律）
**冻结期内不改代码。** 6 路验证全部回执后，把缺陷**合并成一次修复 pass**，再重新冻结 + 重验。
理由：每次改动都会让在飞的验证结论失效。
**例外**：出现会让插件不可用的缺陷 → 立即修并立即重验。

---

## 19. V-E 回执：取样层对照官方文档（8 条主核对 + 10 项偏差）

### 19.1 一致项（主干完全一致）
- **①门槛** `max(80, ceil(ec×0.55))` 与 SDK `index.js:413` **逐位相同**（连浮点行为一致）
- **②整数解析** 直接依赖 SDK，**无自研解析器**，无语义差异
- **③截断三规则**全中：早停 / 超长截断 / 严格不截断
- **④结束原因** 白名单逐字一致；两层映射完整（DSH 5 值 → lmfpd 3 值）；未知 kind → `'error'`
- **⑤官方两条错误串逐字一致**（`No valid samples…` / `Strict mode requires 3/3…`）
- **⑥`analyze` 同步包装**正确，未加载时**抛**而非静默返回错结果
- **⑦加载器** 单例 + 懒加载 + **不缓存 rejected promise**；调用方判空齐备
- **⑧没踩「用 cache 构造失败路径」的坑**（测试文件里有注释级证据，与 §13 一致）

**V-E 的精确有理数对照（高价值副产品）**：扫 `ec ∈ 1..100000`，JS 浮点口径在 **2758 个** ec 上与精确 `ceil(ec×55/100)` 差 1（如 `180 → JS 100 / 精确 99`）；但**挑战区间 292–332 内差 0 个**，且 SDK 自身同口径 ⇒ 无影响。

### 19.2 主脑裁决：**修**（进入合并修复 pass）
| # | 内容 | 归属 | 理由 |
|---|---|---|---|
| **D1** | **结束原因豁免判据用错维度**。SDK：`truncated = !final \|\| numbers.length > expected_count`（`:483`），豁免为 `if (!truncated && …)`（`:671`）。而 `probe.js` 只认 `truncatedEarly`（仅流式早停置真）⇒ 一个**读完的、整数超过 `expected_count`、结束原因 `max-tokens`** 的回答，官方判 `truncated`（**接受**），我们判 `failed`（**丢弃**） | `lib/probe.js` | **影响结果质量**：丢可用样本 → 有效回合变少 → 更易落成 `partial`/`unscorable` |
| **D3** | `strict` 要求 `count=3`，两层都无前置校验，用户白等一轮 | `lib/index.js` 入参校验 | 官方配置校验串含 `strict requires count 3.` |
| **D4** | `/run` 的 `parallel` 被 `MAX_PARALLEL=2` 夹住，而 UI 给 1–3 ⇒ **用户选 3 被静默降为 2** | `lib/index.js` | 上下限必须一致 |
| **D2** | 全系统缺 `cancelled` 态（作者自己的注释都写了它该存在）；取消被标成 `failed` + 「无有效样本」，**措辞误导** | probe.js + index.js + client.js + §5 | 官方 Sample 表明确有 `cancelled` |

### 19.3 主脑裁决：**不改**（记录为已知偏差）
| # | 内容 | 理由 |
|---|---|---|
| D5 | 两条官方错误串未复刻 | 我们的中文串更具体；官方那两条对应不同失败模式 |
| D6 | 截断文本拼接分隔符（`,` vs 空格） | 对 `parseNumbers` 语义等价，官方未规定 |
| D7 | 早停解析是否剥尾部数字 | 最终判定不受影响，官方未规定 |
| D8 | 本地目录模式下 `bankModelCount=null` | 仅离线/测试模式，不影响生产 |
| D9 | `runRound` 不转发 `onProgress` | 上层自维护 task 状态（§15.1 已实测） |
| D10 | 导入期预热是副作用 | `DSH_FINGERPRINT_NO_PREWARM=1` 可关，§11.4 已记录 |
| F1 | `client.js` 死读 `aggregate.error` | 无害；**改它会让 `client.js` 的验证结论失效**，收益不抵成本 |

### 19.4 ⚠️ `parallel` 语义澄清（§5 补充，易误读）
本项目 `parallel` 与官方**同名不同义**：
- **官方** `parallel` = 一次 `detect` 内**同一轮挑战之间**的并发（1–3，≤ `count`）
- **本项目** `parallel` = **跨目标（provider × model）并发**
- 本项目**轮内**并发固定为全并发（= `count` ≤ 3），**等价于官方 `parallel = count`**
⇒ 实际在飞请求数可达 `parallel × count`（3×3=9），这是**有意设计**，不是 bug。

---

## 20. V-C / V-D 回执与**合并修复 pass 清单**

### 20.1 V-C（HTTP 层）关键结论
✅ 通过项：**§11.2 判空无遗漏**｜**§12.8 形状逐条正确**｜§10 词表 5/5 且未知 kind 分支保守｜**`reasoning-delta` 无任何泄漏路径**｜**SSE 无内存泄漏且已结束的 run 立即补发 `event: done`**｜**BUSY 无 TOCTOU**（`startRun` 全同步无 await）｜**AbortSignal 确实透传到 `ctx.llm.stream`**｜请求体上限**在读满之前**生效｜DNS rebinding **被 Host 检查有效挡住**。

**绕过矩阵 20 个向量全部实测**（含 5 个诚实标注的"测试假象"）。

### 20.2 V-D（targets / aggregate）关键结论 —— CONDITIONAL PASS
✅ **53 条行为断言通过**：§2.5 陷阱**真被绕开**（`listModels=[]` 时 config 模型仍在）｜§14.2 三级链优先级正确｜§15.2 三态**真机复核 `deepseek-account=null`**｜**§2.6 密钥零泄漏且有「两层保险」**（哨兵 + 两级中和实验，任一层移除立即泄漏 ⇒ 结论敏感非恒真）｜§9 两条排序链**确实不同未被"统一"**｜确定性 **100/100 一致且键序无关**｜缓存按 ctx 引用隔离**不可能串味**。

### 20.3 ⚠️ 合并修复清单（冻结结束后**一次性**执行）
| # | 缺陷 | 文件 | 来源 | 级别 |
|---|---|---|---|---|
| **FIX-1** | 重复 target ⇒ task 永久 `queued` + `rounds` 共享 + `totalRounds` 翻倍。修法：`parseRunOptions` 按 `targetKey` **去重**；`run.tasks` 按 target 索引取，不用 `find` | `lib/index.js` | V-C | 🔴 |
| **FIX-2** | 超限体 ⇒ 连接重置（违反 §5 统一失败体）；兜底 catch 无 `headersSent` 检查；`void handle(...)` 无 `.catch()` | `lib/index.js` | V-C | 🟠 |
| **FIX-3** | 同源校验放宽到「两侧皆回环」⇒ **端口不校验**（本机任意端口页面可驱动 `/run`）。保留 `localhost↔127.0.0.1` 等价，**加回端口一致性** | `lib/index.js` | V-C | 🟠 |
| **FIX-4** | `/cancel` 在 `abort()` 后立即读 `run.phase` ⇒ **必返回 `'running'`** | `lib/index.js` | V-C | 🟡 |
| **FIX-5** | `sleep()` 不检查初始 `aborted` ⇒ 取消后可卡满 `gapSec`（≤120s） | `lib/index.js` | V-C | 🟡 |
| **FIX-6** | `strict` 要求 `count=3` 两层都无前置校验 | `lib/index.js` | V-E | 🟡 |
| **FIX-7** | `MAX_PARALLEL=2` 而 UI 给 1–3 ⇒ **选 3 被静默降为 2** | `lib/index.js` | V-E | 🟡 |
| **FIX-8** | SSE 无背压（忽略 `write()` 返回值）｜`notify` 直迭代 Set 而 `finally` 用副本｜回环白名单过严（应含 `127.0.0.0/8` 与 `::ffff:127.0.0.1`） | `lib/index.js` | V-C | ⚪ |
| **FIX-9** | 结束原因豁免判据用错维度（详见 §19.2 D1）—— 改为 `!(truncatedEarly \|\| assessed.state === 'truncated')` | `lib/probe.js` | V-E | 🟠 |
| **FIX-10** | `guessed` 分支**假阴性**：`settings.describe()` 瞬时失败 或 `listModels` 抛错 ⇒ 旁证全丢 ⇒ 可用 provider 被报 `false` 并置灰。修法：`guessed` 分支补一次 `hasCredential(ref)`；并新增 `settingsOk` / `catalogState`（`'ok'\|'error'\|'skipped'`），`!settingsOk` 或 `catalogState==='error'` ⇒ `null` | `lib/targets.js` | V-D | 🟠 |
| **FIX-11** | 「永不抛」漏洞：`text()` 对被抛对象的 `toString` 再抛时逃逸；descriptor 扫描循环缺 try（与相邻循环不对称） | `lib/targets.js` | V-D | ⚪ |
| **FIX-12** | 缓存命中返回**共享引用**（未冻结） | `lib/targets.js` | V-D | ⚪ |

### 20.4 裁决：**不改**（记录为已知偏差）
- **V-E D2（`cancelled` 态）**：**不实现该状态**。理由：run 级 `phase` 已是 `cancelled`；跨 4 个文件 + 契约的改动收益不抵风险。改为**修掉 `probe.js:17` 那条误导性注释**（它声称「取消时为 cancelled」而代码从未产出），并在契约明确记录「本项目不产出 `cancelled`，取消计入 `failed`」。
- **V-D 缺陷 1（perRound 空串）**：`aggregate.js:92-93` 把 `''` 归一化成 `null`。**保留代码**（让聚合层用统一的 `null` 表示"无排名"更清晰），**改契约 §9.2**：perRound 的 `decision`/`prediction`/`predictionName` 在**无排名时一律 `null`**（无论是 `analysis` 为空还是 SDK 给 `''`）。
  ⚠️ 这**推翻 V-A §18.2 的说法**（它以为 `''` 会透传）。以本条为准。
- V-C D6/D10、V-E D5–D8、V-A F1/F5：见 §18.3 / §19.3，维持不改。

### 20.5 ✅ 修复 pass **不触碰 `client.js`** —— 这是刻意的
- V-E D2 的 `cancelled` 态不实现 ⇒ client 无需改
- V-C 的 4 项 HTTP 缺陷全在服务端
- `parallel` 只改服务端上限（UI 本来就说 1–3）
⇒ **`client.js` 在整个修复 pass 中保持不变**（哈希 `563726D5B405A1E3`），因此 **V-B 对 `client.js` 的验证结论在修复后仍然有效**。

---

## 21. V-B 回执：`client.js` 对抗性审查

### 21.1 硬约束 5/5 独立复验通过
- **① classic script**：`vm.createContext` + `new vm.Script().runInContext()` **实跑** + 剥注释后正则扫 ESM → 双证通过
- **② 白名单**：正则穷举 `require(` **全部出现**（含动态 / 拼接 / 模板串）→ **只有 3 处**，全字面量、全命中；`dynamicRequire=[]`
- **③ 槽位契约**：**从宿主源码重新推导** —— `syncPanels()` 只读 `id`/`order`/`label`（`dsh-client-ui-sidebar/lib/client.js:567-575`），`order:40` 合规、`label` thunk 正确；`main.key === id` 的抛点在 `dsh-client-ui-layout/lib/client.js:469`；`inject` 是 cordis 服务名
- **④ 图标兜底**：**9 组敌意 props 实测**（`NaN`/`Infinity`/字符串/负数…）→ 9/9 返回合法 svg，**构造上不可能 undefined**（纯内置 SVG）
- **⑤ 空值渲染**：自建 mini renderer 真渲染 + 文本扫描 → 三场景 `undefined|NaN|Infinity` **0 命中**；`agreement=1 → 100.0%`、`validRounds=0 → 0`（**0 未被 falsy 吃掉**）

### 21.2 🎯 V-B 结清两个悬案
1. **§17.2.4「`DisclosureRow` 折叠时是否仍渲染 children」→ 证伪**：宿主末行 `{open && children}` ⇒ 折叠**不渲染**，不会多出 41 行 DOM。
2. **`t` prop 重叠风险 → 证伪**：宿主 `assertNoPropOverlap` 的 4 个调用点标签全是 `factory '…'`，而我们是 **entry 路径**（`slots.inject` + `register`）⇒ `{...kit, ...injected}` **无重叠校验**；且有生产反证（`dsh-skill-mcp-panel/lib/client.js:4576-4599` 同写法）。

### 21.3 ⚠️ 真缺陷（进入修复 pass）
| # | 缺陷 | 行号 | 级别 |
|---|---|---|---|
| **D1** | **`PageBoundary` 是死代码**：声明在 `L1180`，注册处 `L2459-2469` 直接把 `FingerprintPage` 交给槽位，**从未挂载边界**（全文出现次数 = **1**，仅声明行）。渲染期异常冒泡到宿主 `SlotErrorBoundary` → 渲染**无任何说明的空格子** `<div data-slot-error="main">` | L1180 / L2459 | 🟠 **可诊断性退化** |
| **D2** | `toggleDetail` 在 `setExpanded` 的 **updater 内执行副作用**（`void loadDetail()`）→ updater 被调两次即发两次 `/export`；守卫读闭包旧值，两次同步调用都通过。**违反 React「updater 必须纯」** | L1500-1508 | 🟡 |
| D3 | `feedMode` 进过 SSE 就再也回不到「轮询」⇒ 通道标签恒显示 SSE，**诊断误导** | L1013 / L1005 / L2015 | ⚪ |
| D4 | 「已选 n / total」可能 n > total（n 取全量、total 取过滤后） | L2054 | ⚪ |
| D5 | `shutdown` 参数写死 `"done"`，取消/失败也显示「已结束」 | L998 / L1036 | ⚪ |
| D7 | `Input` 的 `style` 落在内层 `<input>` 而非 wrapper `<span>`（结构已从宿主源码证实；视觉后果未证实） | L2115 等 | ⚪ |

⚠️ **W6 的自述与代码不符**：它曾说「整页包在 `PageBoundary` 里，渲染异常不会冒泡到宿主 retire 整格」。**D1 是铁证**（全文仅 1 次出现）。

### 21.4 D6 结清（非缺陷）
V-C 已实测 `tasks[]` 为**每目标一条**（2 targets → 2 tasks，`round` 就地更新）⇒ `errorByTarget` 每轮重建，**不会残留历史轮次错误**。V-B 的 D6 不可复现。

### 21.5 🔄 修复 pass 修订：**必须触碰 `client.js`**（推翻 §20.5）
V-B 在 `client.js` 里找到 D1/D2 两处真缺陷 ⇒ 「不碰 client.js 以保住 V-B 结论」的策略**自我否定**。
⇒ **新策略**：修 `client.js`，并在修复后对 `client.js` 做**针对性重验**（验 D1/D2 是否真被修好）。
⇒ 其余三个文件照原计划。

### 21.6 V-B 证伪的历史高发 bug（记录，避免后人重复怀疑）
搜索污染折叠状态｜折叠仍渲染 children｜`t` prop 重叠｜数组下标 key 错行｜`0` 被 falsy 吃掉｜`perRound[].index → 第 NaN 轮`。
外加一条**不可复现**的硬化项：`interpolate`（`L487` 缺 `name in params` 守卫，宿主 `translate` 有）—— 核了全部 11 处 `tt()` 调用参数都传齐 ⇒ 不可复现，**顺手加守卫**。

---

## 22. 全 6 路验证收口 + 修复 pass 最终清单

### 22.1 ⚠️ 主脑纠错：`package.json.bak-fingerprint` **不是** W4 的误报
主脑曾在 §15.4 断言「W4 的『不存在』是误报」。**该断言错误**，现更正：
V-F 用 NTFS **创建时间**证明：备份创建于 **05:16:08.968**，而它的探针跑在 **~05:12** —— 当时 `Test-Path` 与 `Get-ChildItem -Force` **两种独立方法一致**给出「不存在」，旁证是 `package.json` 当时仍为 **684 B**（05:16:14 才变 792 B）。
⇒ W4 说"不存在"是**事实**；W7 后来说它存在也是**事实**。两者测的是不同时刻。
⇒ **真正的缺陷是方法论**：把别人文件的**一次时间点采样**硬编码成交付物里的**结论**。W4 已自认并修复（新增 `R1` 现场判定，双向验证通过）。
⇒ **教训（团队标准）**：**跨时刻的观察不得写成结论**。凡"某文件存在 / 不存在"的断言，**必须带采集时刻**。

### 22.2 全 6 路验证收口
| 验证 | 结论 |
|---|---|
| **V-A** 接口一致性 | 61 字段，**60 吻合**；1 处无损死读取 |
| **V-B** `client.js` | 硬约束 **5/5 独立复验通过**；真缺陷 2 处（D1 死边界、D2 updater 副作用）；**证伪 6 条历史高发 bug**；**结清 2 个悬案** |
| **V-C** HTTP 层 | 判空无遗漏、形状逐条正确、SSE 无泄漏、BUSY 无 TOCTOU、abort 真透传；**20 个绕过向量实测**；真缺陷 4 项（1🔴 + 3🟠/🟡） |
| **V-D** targets/aggregate | **53 条断言通过**；**密钥零泄漏且双层保险经两级中和验证**；真缺陷 3 项 |
| **V-E** probe/detector | 8 条主核对主干一致（①④ **逐位/逐字**）；真缺陷 1 项（影响**结果质量**）+ 3 项中低 |
| **V-F** 校验器 | **25/25 PASS + 82/82 测试**；**冻结完整性 9/9 MATCH**；反例验伪 FAIL 9；`--self-test` 48 断言证明 6 项槽位检查**无死代码** |

⇒ **关键结论：6 路均声明只读，冻结哈希 9/9 一致 —— 审计期间无人静默改动文件。**

### 22.3 文件所有权补全（V-F 缺陷 1）
- `tools/live-probe.mjs` 归属 **W7**（一次性真机驱动脚本）⇒ `tools/` 不再是 W4 独占
- 冻结基线补全：`test/send.test.mjs`、`test/targets.test.mjs`、`tools/live-probe.mjs`、`.smoke.json`

### 22.4 其他裁决（V-F）
1. **README.md 双重身份** —— 确认是**授权改动**（主脑同轮既把它写进基线又指示修改，属主脑不严谨）。冻结核对只针对**非 W4 文件**。
2. **S4 追到字典值** —— **批准**：S4 目前只判形式，「指纹检测」这个标签值本身未被程序校验。
3. **R1 保持 FAIL** —— 回滚就绪性是交付条件之一。
4. **交付三连** —— 批准列入：`node tools\selfcheck.mjs` + `node tools\selfcheck.mjs --self-test` + `node --test`。

### 22.5 修复 pass 最终清单（5 路并发）
| 任务 | 文件 | 项 |
|---|---|---|
| **FIX-A** | `lib/index.js` | FIX-1 重复 target 去重 + tasks 按索引取 / FIX-2 超限体返回 §5 失败体 + `headersSent` 检查 + `void handle().catch()` / FIX-3 **端口一致性** / FIX-4 `/cancel` 过时 phase / FIX-5 `sleep()` 初始 aborted / FIX-6 strict 前置校验 / FIX-7 `MAX_PARALLEL` 2→3 / FIX-8 SSE 背压 + `notify` 副本 + 回环白名单放宽到 `127/8` 与 `::ffff:` |
| **FIX-B** | `lib/probe.js` | FIX-9 豁免判据维度（`truncatedEarly \|\| assessed.state==='truncated'`） + 修掉 L17 那条声称 `cancelled` 存在的误导注释 |
| **FIX-C** | `lib/targets.js` | FIX-10 `guessed` 假阴性（补 `hasCredential` + `settingsOk`/`catalogState`）/ FIX-11 两处"永不抛"漏洞 / FIX-12 缓存返回值冻结 |
| **FIX-D** | `client.js` | **D1 挂载 `PageBoundary`**（最重要）/ D2 `loadDetail` 移出 updater / D3 `feedMode` 可回退 poll / D4 计数自洽 / D5 `shutdown` 参数 / D7 `Input` style 落到 wrapper / 硬化：`Number.isFinite` 统一 + `interpolate` 补守卫 |
| **FIX-E** | `tools/selfcheck.mjs` + `README.md` | S4 追到 ZH 字典校验「指纹检测」/ 交付三连写入 README |

**修复后必做**：重新冻结 → 对 `client.js`（FIX-D）与 `lib/index.js`（FIX-A）做**针对性重验** → 跑交付三连。

---

## 23. FIX-B 回执 + 两条重要洞察

### 23.1 FIX-9 已修并验证
- 判据从一维放宽为两维。W3 **独立复验**了 SDK `:480-484` / `:671`，确认三个细节：**两维**、**`>` 而非 `>=`**、**严格模式下从不置位**
- 中和实验：**恰好 2 条**新用例变红、29 条全绿 ⇒ 既非空转、也未过度放宽
- 新增 6 条用例（含 `>` vs `>=` 边界、`stop` 回归、流式路径 `fix9-f`）
- **全量 109/109**（较基线 82 增长，含各 fixer 新增用例）

### 23.2 ⚠️ 洞察 1：第二维的**真实可达性**（W3 主动挖出，主脑采纳）
W3 尝试用**流式**构造 FIX-9 场景**失败**：早停守卫是 `parse(buffer).length >= expectedCount`，任何**真正超长**的流式回答在流完前必然跨过阈值 ⇒ `truncatedEarly` 先置真 ⇒ **第一维就已豁免，第二维用不上**。

⇒ 第二维真正 load-bearing 的窗口只有两个：
1. **非流式送达**（JSON 一次性响应 / `send` 不回调 `onDelta`）
2. **末段不足 16 字符**：`REPARSE_MIN_GROWTH = 16` 的重解析节流**跳过那次解析** ⇒ 早停不触发 ⇒ 只能靠第二维兜住

窗口 2 在 ~300 整数 / ~1050 字符规模下，命中量级约 **1% 每轮**，多轮跑会真实发生。

⇒ **主脑裁决：修，并保留。** 这正是「静默降低有效回合数」的典型 —— 触发率低到不会被发现，但持续存在。
⇒ **`fix9-f` 必须保留**：它是唯一固定窗口 2 的用例；中和后与 `fix9-a` 一起变红是**正确的**（W3 主动申报了这处与主脑预期的偏差，比预期更强，批准）。

### 23.3 ⚠️ 洞察 2：并发编辑会让全量测试出现**假失败**（主脑并行派发造成）
W3 跑全量时出现 3 条失败：`FIX-2`（W7 的 `lib/index.js`）×2 与 `FIX-11 #21`（W5 的 `lib/targets.js:402`）—— 当时 `index.js` / `targets.js` / `client.js` 正被并发写入（05:50:41–05:50:51）。
⇒ **这是主脑并行派发的预期噪声，不是回归。**
⇒ **团队规则**：修复 pass 期间，**全量 `node --test` 的结果只作参考**；**所有写入者停下后必须重跑一次干净的交付三连**，那次才是判定依据。
⇒ 因此各 fixer 附「全量结果」时**必须标注当时的并发状态**。

### 23.4 其他
- `lib/probe.js` 行号位移：判据现 `:455`、豁免备注 `:474`
- FIX-B2 注释已更正，并在**文件头新增「两维判据」一节**（含 SDK 行号、两维对应物、误丢样本的后果），防后人退回一维

---

## 24. FIX-C 回执 + 一处**必须**转给 W6 的 UI 准确性修正

### 24.1 三处修复完成
- **FIX-10**：`catalogModels` 改为返回 `{rows, state}`（**异常不再静默吞成 `[]`**）；`buildTargets` 新增 `settingsOk`（`describe()` 显式 try + `Array.isArray` 校验）；`buildProvider` 判定链改为四级
- **FIX-11**：`text()` 整体包 try（返回 `'[不可字符串化的错误对象]'`）+ descriptor 扫描循环补 try（与相邻两循环对称）⇒ 模块自述的「**本函数永不抛异常**」**现在才真正成立**
- **FIX-12**：新增 `freezeTargets()`，冻结 `顶层 → providers → provider 行 → models → model 行`
- **5 次变异，每次只打中它守护的用例，无附带损伤**。特别地：变异 A **没有**让用例 20 变红是**正确**的（20 靠 `catalogHasModels` / `hasCredential` 独立成立）

### 24.2 真机三元组与期望**逐字一致**
| provider | models | credentialRef | credentialAvailable | refSource | settingsOk | catalogState |
|---|---|---|---|---|---|---|
| `deepseek-official` | 2 | `DEEPSEEK_API_KEY` | **`false`** | `profile` | `true` | `ok` |
| `deepseek-account` | 2 | `DEEPSEEK_ACCOUNT_API_KEY` | **`null`** | `guessed` | `true` | `ok` |
| `provider-a` | 3 | `API_KEY_A` | **`true`** | `profile` | `true` | `ok` |
| `provider-b` | 1 | `API_KEY_B` | **`true`** | `profile` | `true` | `ok` |

`/status` 200、`bankModelCount=64`、providers 45 / active 4 未变。

### 24.3 ⚠️ 裁决：新字段名**批准**，且**必须转给 W6**（FIX-C 未决 2）
`credentialAvailable === null` 现在有**三种成因**，而 §17.1 的文案只准确覆盖前两种：

| 成因 | 「凭据由账号/其他机制提供」是否准确 |
|---|---|
| 账号路由 `accountRouted` | ✅ 准确 |
| catalog 有模型 `catalogHasModels` | ✅ 尚可（确实由其他机制提供） |
| **旁证丢失 `!settingsOk \|\| catalogState === 'error'`** | ❌ **不准确** —— 这是**本机临时故障**，不是"凭据由别处提供" |

⇒ **新增第 4 种文案**：`settingsOk === false \|\| catalogState === 'error'` ⇒ 「**暂时无法判定（本机设置/目录查询异常）**」
⇒ 若不细分，settings 抖动时 UI 会显示一句**听起来确定但实际是错的**话。
⇒ 字段名批准：**`settingsOk`**（boolean）/ **`catalogState`**（`'ok'|'error'|'skipped'|null`），均**每 provider 一行**，`null` = 未计算（provider 级异常路径）
⇒ **兼容性**：两字段缺失时（旧形状）按"未知"处理、退回原文案，**不得报错**
⇒ V-A 的 61 字段清点是**客户端读取面**，客户端本来不读这两个键 ⇒ 新增字段无破坏性

### 24.4 其他裁决
- `freezeTargets` 冻结到两层：当前 `lib/index.js` 只透传、不原地修改 ⇒ 无影响
- **团队标准（新）**：用例 21 里显式加了 `assert.throws(() => String(unstringifiable))` 作为**前提断言** —— 夹具失效时会立刻报出真正原因，而不是静默地"恰好通过"。
  ⇒ **凡使用"对抗性夹具"的用例，必须先断言夹具本身确实具备对抗性。**
- 备份现有 3 个（`-fingerprint` / `-2` / `-3`），交付前统一清理

---

## 25. FIX-E 回执 + 裁决

### 25.1 S7 值校验已落地
追值链：`label thunk "() => t(\"nav\")"` → 字典键 `nav` → 按 panellist 的 `locale: NS` 选中第 1 处 `locale.register` → **`ZH.nav = "指纹检测"` = 契约 §1 ✔**
抽取器兼容面（每条都有夹具）：冒号属性 / **ES6 简写** / 内联对象 / 多跳（`en: enTable()` → `return EN`）/ 一文件多套字典（按 `locale:` 选对表）/ 无 `register` 时回退 `const ZH` 约定。任一步取不到 → **FAIL**（不 SKIP），并点名断在哪一环。
**值完全来自 `client.js` 内部**，不依赖宿主 / settings / 远端。

### 25.2 ⚠️ FIX-E 自己发现并修掉一个真缺陷（**团队标准**）
反例插件用 **ES6 简写** `{ zh, en }`；第一版抽取器只认 `key: value` ⇒ S7 红了但**理由不对**（报「字典未取到」）。
⇒ 这不只是反例问题：**我们自己的 `client.js` 若改用简写就会误报 FAIL**。
⇒ FIX-E 原话：**「『检查器能红』这条我不满足于'红了就行'，红必须红在正确的判据上。」**
⇒ 修后反例红得正确：`zh.navCombined = "Skill / MCP" ≠ "指纹检测"`。
⇒ **团队标准（新）**：**反例验伪必须同时核对"红的理由"**，只看"是否红"不足以证明检查器有效。

### 25.3 裁决
1. **「扩到 7 项」口径** —— **批准** FIX-E 的做法：S1–S6（形式 / 一致性）+ **S7（值）** = 7 项，**18 夹具 × 7 = 126 断言**。比字面理解更好。
2. **`en` 字典缺键 = FAIL** —— **批准保持 FAIL**。两个字典都由我们控制，缺键是真实疏漏，修复成本近零。
3. **命名空间择优的边界** —— 单条 `locale.register` 内合并多语言 / 多命名空间的形状会让抽取失败并 FAIL。**接受为已知限制**（当前双方代码都不是这种形状）。
4. **哈希核对** —— 本轮**不做**（正确）。修复 pass 收尾后由主脑统一重跑。

### 25.4 §22.1 的教训已被下游主动复用（记录）
FIX-E 在 README 里**不再写死测试条数**（82 → 109 会漂移），只写「判定标准就是 `fail 0`」，并把条数标注为「本轮实测」。原话：「我上一轮正是因为把一次采样写成结论才犯错，不该在文档里重犯。」
⇒ 它同时把中间态观察明确标为「**采样（不是结论，带采集时刻）**」。

### 25.5 交付三连已写入 README
| # | 命令 | 判定标准 |
|---|---|---|
| ① | `node tools\selfcheck.mjs` | `FAIL 0`（本轮 26 PASS） |
| ② | `node tools\selfcheck.mjs --self-test` | `断言不符 0 处；不可达项 0 项`（126 断言） |
| ③ | `node --test` | `ℹ fail 0`（本轮 109/109） |

### 25.6 反例结果
`dsh-skill-mcp-panel` → **PASS 15 / FAIL 10 / SKIP 1**，退出码 1。S1 / S3 / S5 / **S7** 红且**理由均正确**。
S2 / S4 / S6 在该插件上 PASS 属**语义正确**；它们能红由 **126 个夹具断言**独立证明。

---

## 26. FIX-D 回执 + 裁决

### 26.1 全部 8 项 + §24.3 第 4 种文案落地
| # | 改动 |
|---|---|
| **D1** | 新增 `FingerprintPanel`(L1262) = `PageBoundary > FingerprintPage`；注册处改交它(L2540)；导出供复验 |
| **D2** | `toggleDetail` 改为先读 `expanded[key]` 算 `nowOpen`，再分别 `setExpanded` / `void loadDetail()`（L1571）⇒ updater 变纯；**另加 `detailInFlight` ref 守卫**(L1544-1561) |
| **D3** | `startPoll` 无条件切 `"poll"`（L1056），SSE 恢复时再切回 ⇒ **双向可回退** |
| **D4** | 新增 `allSelectableRows`(L1447)，计数分母改用它(L2120) |
| **D5** | `shutdown(phase)` 传真实终态(L1039)；新增 `feedCancelled`/`feedFailed` + 标签分支(L2081) |
| **D7** | 新增 `NumberField`(L688)：宽度落在显式 wrapper `<span>`，内层只给 `width:100%` |
| 硬化1 | `meanRank`/`score` 改 `Number.isFinite`(L1941-1942) |
| 硬化2 | `interpolate` 加 `hasOwnProperty` 守卫 + `null`/`undefined` 不替换(L494) |
| **§24.3** | `credentialState` 返回 `{kind,tone,text,blocking}`；null 拆两支(L804)；临时故障用 warn 色 chip；**全部正向判定**，字段缺失一律保守回退 |

自检：ESM 扫描 0 命中｜`vm.Script` classic 解析 OK（112152 B / 2558 行）｜require 3/3 命中白名单｜伪宿主冒烟 **27 组合全 ALL PASS，累计 894 条断言**｜四态断言 6 条全 PASS。

### 26.2 ⚠️ FIX-D **主动认错**（记录为团队标准）
它明确写下：**「D1 我的自述是错的」**，并复述了 V-B 的取证。
⇒ **团队标准（新）**：**自述与代码不符时，必须以代码为准，并在回报里显式认错。** 隐藏错误自述比错误本身更贵。

### 26.3 D1 的端到端验收（**方法值得记录**）
用**敌意 props** 构造渲染期真抛错：`{ get t() { throw new Error('boom: hostile props getter') } }`
关键在**该访问点在页面自身 try/catch 之外** ⇒ 是渲染期**真**抛，而非结构性替代。
```
对照：不经边界时确实抛出（异常冒泡到宿主）
挂载边界后不再抛
渲染出 pageCrash 文案 + 错误原文 'boom: hostile props getter' + 堆栈，非空元素
stderr: dsh-fingerprint: page crashed Error: boom: …   ← componentDidCatch 真被调用
```
⇒ 这是「边界真的挂上了」的**充分证据**。

### 26.4 裁决
1. **D2 的 `detailInFlight` ref 守卫** —— **批准，非越权**。理由成立：仅把 `loadDetail()` 移出 updater **仍挡不住两次同步调用**（闭包守卫两次都通过）。V-B 给的是必要条件，ref 是充分条件。
2. **D7 视觉后果未证实** —— 接受，留待真机目视（逻辑上「布局不会塌」）。
3. **D3 事件流切换未真跑** —— 接受。标签映射已断言、`startPoll` 改动已源码级确认；真机断网可验。
4. **`settingsOk`/`catalogState` 位置** —— **确认是每 provider 一行**（W5 的真机三元组表即按 provider 列出）。W6 读法正确。
5. **新增 3 个导出**（`PageBoundary` / `FingerprintPanel` / `interpolate`）—— **批准保留**。它们是测试缝，**不影响宿主契约**（宿主只用 `apply` / `inject`）；且 D1 的端到端验收依赖它们。
6. 临时 harness 不必收进 `tools/`。

### 26.5 现状
`client.js` 107314 → **112152 B / 2557 行**。**仅剩 FIX-A（`lib/index.js`）在跑。**

---

## 27. V-B2 回执 + N1 裁决（**契约缺陷，非代码缺陷**）

### 27.1 修复全部独立复验通过 —— **需再修 0 处**
哈希核对 **MATCH**（112152 B / `C509182FF09E59E4`，mtime 05:55:17）。

| 项 | 复验结论 |
|---|---|
| **D1** | **充分证据，非结构性替代**：对照组真抛（`boom: hostile props getter`）→ 实验组不抛 + 渲染出 `pageCrash` 文案 + 错误原文 + 堆栈 + **`componentDidCatch` 真被调用** ✅ |
| **D2** | updater 已纯（源码正则确认无 `loadDetail`）+ 连点两次 → `/export` 请求数 = **1** ✅ 证实了 §26.4 裁决 1 的分析（ref 守卫才是充分条件） |
| **四态文案** | **5/5 断言到实际渲染文本**；**含正对照**（`false`+`profile` → 置灰）⇒ 证明"未置灰"的断言**不是空转**；额外确认 transient 用 warn 色 chip ✅ |
| **真机跨边界** | `settingsOk` 全 `true` 且类型集合 = `boolean`；`catalogState` 取值集合 = `{ok, skipped}`（在枚举内）；**把真机 payload 喂进客户端渲染** ⇒ `deepseek-account` → 「凭据由账号/其他机制提供」（**不是**「暂时无法判定」），全场无「暂时无法判定」✅ |
| **6 类历史 bug** | 无复活 ✅ |
| **硬约束** | `require(` 仍**仅 3 处**全在白名单、无动态形式；classic 解析通过 ✅ |

### 27.2 ⚠️ N1 裁决：**接受现状**
**N1**：「未启用（41）」分组在真机上**永不渲染**。
**根因（主脑的设计矛盾）**：§2.5/§12.4 规定「模型主来源 = settings 的 `models`」，而真机 **41 个休眠 provider 的 `models` 全是空数组**（长度分布 `{"0": 41}`）⇒ 客户端按「行」组织 ⇒ 休眠 provider 产出 **0 行** ⇒ 无物可分组。
⇒ W6 的实现在**合成夹具**下正确（能渲染「未启用（1）」+ 原因 + 禁用），但**该路径在生产中不可达**；W6 的 45-provider 冒烟用的是带 models 的合成数据，故未暴露。

**裁决：(a) 接受。**
- 休眠 provider **本无模型可检测**，不列行比列 41 行 disabled 噪声更干净
- §12.5 的原始要求**不可实现**（主脑把「provider 计数」当成了「行计数」）

**契约更正**：
- §12.5 / §17.3 措辞改为：**「休眠 provider 不产生行；若某休眠 provider 恰有 `models`，其行收进默认折叠分组且复选框禁用」**
- **§17.3 人工验收清单第 2 条作废**（见 §27.3）

**可选改进（记为未来项，非缺陷）**：在 active 分组下方加一行汇总「另有 41 个未启用的 provider（无模型可检测）」，让用户知道目录被完整读取。
**本轮不做** —— 收益是提示性的，代价是再动 `client.js` 并使 V-B2 的验证失效。

### 27.3 ⚠️ 主脑对操作者的**错误指引作废**
主脑此前在回复里让操作者核对「41 个收进『未启用（41）』分组」—— **该指引基于错误预期**。
真机正确行为：**只显示 4 个 active provider 的 8 行，休眠项不显示。**
⇒ 若操作者反馈"没看到那个分组"，**那是正确的**，不是缺陷。

### 27.4 契约笔误
§26.1 的「2558 行」应为 **2557**（§26.5 写对），不影响代码。

### 27.5 未证实项（V-B2 诚实标注，保留）
- **D3 运行时行为**：`startPoll` 无条件切 `"poll"`(L1056)、SSE 恢复切回 `"sse"`(L1070) —— **源码级确认**；桩里 `EventSource`/`useEffect` 是空实现，**未真跑**
- **D7 视觉后果**：结构确认（wrapper 持宽度、inner 100%、无残留 88px 落在 Input 上），**真机目视未做**
- **`componentDidCatch` 的 console 输出在真机 Electron 里是否可见**：只在桩里捕获到
- **`ranking[]` 8 字段**：至今只有**静态核对**（未跑真实模型以省额度）—— 待最终验收补齐

---

## 28. 操作者真机反馈：两个缺陷（P1 主脑设计失误 + P2 死局）

### 28.1 P1 —— 轮次被串行，`parallel` 的**作用域错了**（主脑设计失误）
**现象**（操作者实测）：1 个模型 × 轮次 3、`parallel=2` ⇒ 页面显示「第 1/3 轮 streaming、第 2/3 轮 queued、第 3/3 轮 queued」。

**代码证据**：
```js
lib/index.js:511  const queue = run.targets.slice();    // 队列单位是「target」，不是「轮」
lib/index.js:512  const workerCount = Math.min(run.options.parallel, queue.length)
```
⇒ 只选 **1 个模型** ⇒ `queue.length === 1` ⇒ `workerCount = 1` ⇒ 那唯一 worker 把该目标的 3 轮**顺序**跑完。
⇒ 根因：§19.4 把 `parallel` 定义为「**跨目标**并发」。多模型时合理，但**单模型多轮**场景下并发数恒为 1 —— 与操作者直觉冲突。

### 28.2 裁决：**改成轮级并发**
- 队列从 `targets` 展平为 **`(target × round)` 任务项**；`parallel` 语义改为「**同时在跑的轮次数**」（1–3）
- 每轮内部仍 `count` 个挑战全并发（不变）
- **§19.4 的「跨目标并发」定义作废**，改为「跨 `(目标 × 轮次)` 并发」
- 客户端默认并发数 **2 → 3**
- ⇒ 1 模型 × 3 轮 + `parallel=3` ⇒ **3 轮真并发**；在飞 HTTP 请求数 = `parallel × count`（默认 3×3 = 9）

### 28.3 P2 —— BUSY 是**死局**（比 P1 严重）
**现象**：重复点击开始 → `接口调用失败 / 宿主侧已有运行中的任务（BUSY）`，且**看不到那个正在跑的任务**。

**代码证据**：
```js
lib/index.js:572  failure('BUSY', `已有运行中任务：${activeRunId}`)   // runId 只在自由文本里，非结构化
lib/index.js:269  let activeRunId = null;                            // 仅宿主内存，无端点暴露
client.js:1518    if (result.code === "BUSY") setActionError(...)    // 只弹通用文案，不做 runId 恢复
client.js:1380    const [runId, setRunId] = useState(null)           // 不持久化，重载即永久丢失
```
⇒ **操作者被硬卡住**：不能开新任务（BUSY），也看不到旧任务（无 runId、无查询端点）。只能等完成或重启应用。

**裁决：必须修。**
- **宿主**：`/status` 暴露 `activeRunId`（`string|null`）；**并**让 `BUSY` 响应体带结构化 `error.runId`
- **客户端**：挂载时从 `/status` 恢复 `activeRunId` → 自动接上并订阅 SSE；`BUSY` 时同样自动重连；**持续显示「运行中」横幅**（含取消 / 导出），不依赖"是否刚点过开始"
- **附带**：`/cancel` 空 body 已默认指向 `activeRunId`（`lib/index.js:768`）—— 保留该行为，并在 UI 里让"取消"始终可点

### 28.4 归属
P1 与 P2 都只落在两个文件：`lib/index.js`（W7）+ `client.js`（W6）。

---

## 29. 新需求：检测历史（「检查过的模型记录」）

### 29.1 目标
把每次检测的结果落盘，页面上可浏览「**哪些模型被检查过、结果如何**」。

### 29.2 存储（冻结）
| 项 | 取值 |
|---|---|
| 路径 | `%LOCALAPPDATA%\dsh-fingerprint\history.jsonl`（环境变量 **`DSH_FINGERPRINT_HISTORY`** 可覆盖） |
| 格式 | **JSONL**，一行一条 **`(run, target)`** 结果（便于按模型过滤） |
| 写入时机 | run 进**终态**时（`done` / `cancelled` / `failed`）一次性追加该 run 的全部目标 |
| 保留策略 | 滚动上限 **500 条**；超出或文件 > 1 MB 时裁剪，只保留最新 500 |
| **明确不记** | API key、`samples[].rawText` 全文、`challenges` 全文（太大 —— 那是 `/export` 的职责） |

### 29.3 单条记录形状（**冻结**）
```js
{
  v: 1,
  ts: "2026-11-02T06:30:00.000Z",        // ISO
  runId: "r-7",
  provider: "provider-a",
  model: "example/text-image",
  decision: "scored",                    // §9.1 的 4 值
  prediction: "example-v1-flash-0101",
  predictionName: "Example V1 Flash",
  family: "deepseek",
  familyName: "DeepSeek",
  probability: 0.9096,                   // 可为 null
  agreement: 1,                          // 可为 null
  stability: "stable",                   // stable | unstable | inconclusive
  validRounds: 3,
  totalRounds: 3,
  options: { rounds: 3, count: 3, parallel: 3, strict: false },
  error: null                            // run 级失败原因（字符串）或 null
}
```

### 29.4 `lib/history.js` 冻结接口（**新文件，可立即并行开工**）
```js
export const HISTORY_PATH
export async function appendRecords(records)                     // 追加一批（原子写）
export async function readHistory({ limit, provider, model })    // → 最新在前
export async function clearHistory()                             // → 清理条数
export async function historyStats()                             // → { count, path, oldest, newest }
export async function aggregateByModel()                         // → 按模型聚合（见 29.5 第 3 条）
```
硬要求：
- **纯 Node，零 DSH 依赖**（可对临时目录单测）
- **永不抛**：任何失败转成返回体里的可读 `error` 字段
- 写入必须**原子**（临时文件 + rename，或单次 `appendFile`），避免并发写坏
- 读不到 / 文件不存在 → 返回**空列表**，不是错误

### 29.5 HTTP 路由（**W7 在 FIX-G1 之后接**）
| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/fingerprint/history?limit=50&provider=&model=` | `{ok:true, records:[...], stats:{count,path,oldest,newest}}` |
| POST | `/fingerprint/history/clear` | `{ok:true, removed:N}` |
| GET | `/fingerprint/history/models` | `[{provider, model, lastTs, runs, lastDecision, lastPrediction, lastProbability, lastStability}]` |

### 29.6 UI（**W6 在 FIX-G2 之后接**）
- 页面顶部加「**检测 / 历史**」分段控件（用 `SegmentedTabs`）
- 历史页：按模型聚合表（模型 / 最近检测 / 次数 / 最近 top1 / 置信度 / 稳定）+ 「展开明细」看最近 N 条 + 按模型筛选 + 「清空历史」
- 空历史 → 显示「还没有检测记录」
- `null` 一律渲染 `—`（§14.5 / §17.1 不变）

### 29.7 归属与顺序（**不撞车**）
| 部分 | 属主 | 时机 |
|---|---|---|
| `lib/history.js` + `test/history.test.mjs` | 空闲成员（新文件） | **立即** |
| `lib/index.js` 3 条路由 + 终态写入 | W7 | FIX-G1 之后 |
| `client.js` 历史页 | W6 | FIX-G2 之后 |

---

## 30. 后台运行与「多任务」—— 主脑设计裁决

### 30.1 现状澄清：「后台运行」**已经是**现有行为
run 跑在**宿主进程**里，不在页面里。**关掉面板 / 切到别的面板 / 刷新页面都不会中断它。**
⇒ P2 的病根**不是**"会中断"，而是"**看不见**"。这块**不需要新机制**，需要的是 P2 那套「随时接上」的入口（已派 FIX-G）。

### 30.2 「多个任务」—— **裁决：不做多个并发 run，改做「单运行 + 队列」**
**理由**：
- **并发翻倍会打爆配额**：单个 run 的在飞请求数 = `parallel × count`（默认 3×3 = 9）。两个并发 run = **18**，远超官方 `detect` 的上限（3）。
- 用户真正的需求通常不是"两个 run 互相抢"，而是「**活排上，别让我盯着**」。队列正好满足后者，且不引入配额风险。
- **附带收益**：队列一旦做了，`BUSY` 死局**自然消失**（`POST /run` 永远受理）。

**设计（冻结）**
- `POST /run` **永远受理**，返回 `{ runId, state: 'running' | 'queued' }` —— **不再返回 BUSY**
- 队列 **FIFO**；当前 run 进终态后**自动启动**下一个
- `GET /fingerprint/status` → 增加 `{ activeRunId: string|null, queuedRunIds: string[], queueLength: number }`
- `POST /cancel`（body 可带 `runId`）：
  - 取消**运行中**的 → 立即中止，并自动启动队列下一个
  - 指定**排队中**的 → 只从队列移除
  - 空 body → 作用于 `activeRunId`（保持现有行为）
- **上限**：队列最多 **5** 个待跑（超出 → `QUEUE_FULL`）；内存保留已完成 run 最近 5 个（沿用 `MAX_KEPT_RUNS`）
- **重启语义**：未完成的 run **不持久化**（在飞请求已随进程消失）。历史只记已进终态的 run；被中断的可选记一条 `error:'interrupted by restart'`（**可选，不强制**）

### 30.3 「随时查看」的可见性强化
1. **P2 那套**（`/status.activeRunId` + 自动接上）—— 已派
2. **侧栏标签显示后台活动**：`label` 是 thunk，理论上可动态。**但宿主只在 locale 变化或 slot 列表变化时重投影**（`dsh-client-ui-sidebar/lib/client.js:583` 订阅的是 `slots` 变化）⇒ 要动态需**重新注册**该条目。
   ⇒ **记为探测项**：W6 验一次「用同一 id 重新 `register` 是否让宿主重读 label」。**可行就做**（运行中显示 `指纹检测 ●`），**不可行就跳过**，**不许为此改动宿主契约**。
3. 历史页（§29）

### 30.4 顺序
| 阶段 | 内容 | 归属 | 依赖 |
|---|---|---|---|
| 进行中 | FIX-G1（轮级并发 + activeRunId + BUSY 带 runId） | W7 | — |
| 进行中 | FIX-G2（默认并发 3 + 自动接上 + 运行横幅） | W6 | — |
| **立即** | `lib/history.js` + 单测（**新文件**） | 空闲成员 | 无 |
| 之后 | history 3 路由 + 终态写入 + **运行队列** | W7 | FIX-G1 |
| 之后 | 历史页 + 队列 UI + 侧栏标签探测 | W6 | FIX-G2 |

---

## 31. H1 回执 + 裁决（`lib/history.js`）

> `H1` = 工作代理 8（`lib/history.js` 的唯一所有者），详见文首术语表。

### 31.1 完成情况
**12/12 用例 + 3 次中和实验**（每次只打中它守护的用例）。**真实 `%LOCALAPPDATA%` 全程未被触碰**（`Test-Path` 验证为 False），测试全在临时目录。
- **白名单式规范化**：`sanitizeRecord()` 只保留 §29.3 的 17 键，`rawText` / `challenges` / `samples` / `apiKey` 一律丢弃（用哨兵字符串验证）
- **原子写**：追加走单次 `appendFile`（O_APPEND）；裁剪走「写临时文件 → `rename`」
- `HISTORY_PATH` 实测 = `%LOCALAPPDATA%\dsh-fingerprint\history.jsonl`，与 §29.2 **逐字一致**

### 31.2 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | 数组/数字返回的失败通道退化为 `[]` / `0`，原因由 `historyStats().error` 统一暴露 | **确认**。**追加要求**：W7 的 `/history` 路由**必须**在响应体里带上 `stats.error`，否则 UI 无法区分「空历史」与「读失败」 |
| 2 | `skippedLines` 只计解析失败 / 缺 `provider`·`model`，**空行不计** | **确认**（JSONL 允许空行） |
| 3 | 体积裁剪：条数 < 500 但 > 1 MB 时，纯 `slice(-500)` **一条都不删** ⇒ 体积永久超标 | **批准其加强**：按「最新往旧累加，同时受 **500 条**与 **1 MB** 双上限约束，至少保留 1 条」。条数超限时行为与契约字面**完全一致**，仅体积超限时额外回退 |
| 4 | `HISTORY_PATH` 是加载时快照，函数内部每次重读 env | **确认维持**。实际生效路径以 `historyStats().path` 为准（W7 用它） |
| 5 | 并发写：多 run 终态同时追加可能交错；`clearHistory` 的 `rename` 与 append 也可能竞态 | **要求加进程内串行队列** —— 见 §31.3 |
| 6 | Windows：父级是文件时 `ENOENT` 与「文件不存在」**不可区分** ⇒ 坏路径静默表现为「空历史」 | **要求补定向检测** —— 见 §31.3 |

### 31.3 追加小修（W5，2 处，同一文件）
1. **进程内串行队列**：`appendRecords` / `clearHistory` / 裁剪**三者串行化**（模块级 promise 链）。
   理由：不只是多 run 终态 —— **`clearHistory` 的「写临时文件 → rename」与 append 的 O_APPEND 也可能竞态丢数据**。
2. **坏路径定向检测**：`readFile` 拿到 `ENOENT` 时，再 `stat` 一次**父目录** —— 若父目录**存在但不是目录**（是文件），则**报 error**，而不是当成「首次运行」。
   ⚠️ 父目录**不存在**仍是正常的「首次运行」状态（首次写会创建），**不得报错**。
   用例 7 要把这个盲区钉住。

---

## 32. FIX-G1 回执（P1 已修、P2 已修）

### 32.1 P1 —— **轮级并发落地，操作者的问题不复现**
- 新增 `buildRunItems(run)`：队列展平为 `[{target, round, task}]`；`task` 仍从 **`taskIndex.get(taskKeyFor(target, round))`** 取 —— **保留 FIX-1 的索引成果，未退回 `find()`**
- 新增 `runPool(items, workerCount, worker, shouldStop)`：固定并发池，返回 `{started, peak}`
- `executeRun` 改用 `runPool`；旧的「按 target 的 queue + `min(parallel, targets.length)`」整体删除
- ⚠️ **另修一处隐藏问题**：轮次记账从 `push` 改为**固定槽位** `list[round - 1] = …`。因为轮次并发后 `push` 会让**完成顺序决定数组顺序**，`perRound[].index` 就不再是轮号

**真机证据（严格度量：只把 `waiting|streaming` 计为「在跑」）**
| 配置 | 峰值在跑 | peak 时刻 |
|---|---|---|
| 1 模型 × 3 轮 + `parallel=3` | **3** | 1:streaming 2:streaming 3:streaming |
| 1 模型 × 3 轮 + `parallel=2` | **2** | 1:streaming 2:streaming 3:queued |
| 1 模型 × 2 轮 + `parallel=1` | **1** | 1:streaming 2:queued |

⇒ **操作者看到的「1 streaming + 2 queued」已不复现**；`parallel=1` 仍严格顺序。

⚠️ **W7 主动披露一次自己的度量错误**：第一版脚本把「已完成（complete/truncated）」也算作"在跑"，导致 `parallel=1` 被误读成峰值 2。
⇒ **团队标准（新）**：**并发度量必须先定义清楚「在跑」的口径**（本项目 = `waiting | streaming`）。

### 32.2 P2 —— 死局已解
- `failure(code, message, extra)`：支持附带结构化字段，且 `{...(extra ?? {}), code, message}` 保证 **extra 覆盖不了 `code`/`message`**；其它失败体形状不变（有断言）
- `GET /status` 增加 `activeRunId`（`string|null`）
- BUSY 带结构化 `error.runId`
- `/cancel` 空 body 默认指向 `activeRunId` 的行为**保留**（有意）

**真机证据**：起始 `null` → 运行中 `"r-1"` → 第二次 POST 得 `{runId:"r-1",code:"BUSY",…}` → 用该 runId `GET /run/r-1` **200 phase=done**（证明可用，非自由文本）→ 结束后回 `null`。

### 32.3 契约补正（W7 未决 1）：`gapSec` 语义已变形
轮级并发后，原「轮与轮之间的间隔」不再良定义，现为「**相邻派发之间的间隔**」。客户端固定发 `0`，实际不生效。
⇒ §1 / §5 的措辞按此更正。

### 32.4 契约补正（W7 未决 2）：**被取消的运行会产生「空轮次槽」**
轮级并发 + 固定槽位记账 ⇒ 取消时未派发的轮次在 `export.targets[].rounds[]` 里是**空洞**（`undefined` / `null`）。
`aggregateRounds` 把空洞当无效回合 ⇒ 该目标 `decision = 'partial'`。
⇒ **主脑裁决：接受。** 这比"悄悄少算"更诚实。
⇒ **硬要求（W6 第二波必须做）**：渲染 `rounds[]` 时**必须容忍空洞** —— 跳过 `null`/`undefined` 槽位，**不得崩、不得渲染成「第 NaN 轮」**。

### 32.5 其它
- 全量测试 109 → **127/127**；`lib/index.js` 39700 → **43018 B / 1081 行**
- 备份 `-5`（3404 B），未覆盖已有备份
- W7 未决 4 的观察正确：`test/history.test.mjs` 当时正被 H1 补丁改写，**2 个瞬时失败属跨时刻采样**、不是稳定缺陷（它**带上了采集时刻 06:28:57** ⇒ §22.1 的规矩生效）
- 新增导出（`failure` / `routeStatus` / `buildRunItems` / `runPool`）均为**纯新增**，不影响 cordis 的 `name` / `inject` / `apply`

---

## 33. FIX-G2 回执（P1 + P2 全部落地）

### 33.1 改动
**P1**
- `PARALLEL.def` **2 → 3**
- `parallelHint` 改为「1–3，默认 3；**同时在跑的轮次数**（跨「目标 × 轮次」）」—— **旧「跨目标」说法已彻底移除**
- 「预计」行改**双口径**：`预计总请求 N 次（X 模型 × Y 轮 × Z 挑战）；在飞请求数 ≈ 并发 P × 每轮挑战 Z`

**P2**
- `serverActiveRunIdRef`（**用 ref，不占 hook 顺序**）+ 统一入口 `attachRun`
- **挂载 effect**：本地无 runId 时接管 `/status.activeRunId`（**不抢用户正在查看的任务**）
- **空闲轮询**：无 runId 时每 **4 s** 探一次 `/status`；探测失败静默
- **BUSY 重连**：`error.runId` → 回退 `/status.activeRunId` → 接上并提示「**已接上正在运行的任务**」；两条都拿不到才退回原报错
- **运行中横幅**：`有 runId && 非终态` ⇒ 显示 runId / phase / 数据通道 + **取消** + **导出 JSON**，不依赖"是否刚点过开始"
- 兼容：`pickRunId` 只认**非空字符串**；缺失 / null / 非字符串一律 → `null` → 走旧行为，**不报错**

`client.js` 112152 → **119621 B / 2698 行**。

### 33.2 ⚠️ 方法论升级：harness v3 → **v4**（已批准）
**v3 是渲染桩、`useEffect` 不执行** ⇒ 无法验"挂载/订阅"链路 —— 这正是 §26.4 裁决 3「D3 运行时行为未证实」的**根因**。
**v4 实现真 hooks + effects + 重渲染 + 可编排 fetch + EventSource 记录器** ⇒ **16/16 组合、196 条断言**，6 条新断言（挂载接上 / null 不接 / 缺字段不崩 / BUSY 接上 / 回退 / 默认并发 3）**全部实跑通过**。

**裁决**：
1. **v4 harness 落进 `tools/client-smoke.mjs`**（W6 重建一份）—— 目前项目**没有客户端回归 harness**，只有 selfcheck 的静态检查 + 槽位语义检查；这份补上运行时那一层。
2. **补 D3 场景**（`FakeEventSource.emitError()` 已支持）—— 这是目前唯一还欠的客户端运行时证据。
3. **文件所有权表更新**：`tools/client-smoke.mjs` 归 **W6**。

### 33.3 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | §29 历史页不在本轮范围 | **确认归属 W6**（下一波），对接 §29.5 冻结路由形状，并容忍「接口未就绪」 |
| 2 | 两半侧不同步窗口 | **接受**（设计内降级；"有该字段"与"没有该字段"两条路径都已验） |
| 3 | 客户端不持久化 runId | **确认维持**：`/status` 恢复已覆盖刷新场景，不需要 localStorage |
| 4 | 「在飞请求数」是近似下界 | **采纳精确封顶**：`min(parallel, 目标 × 轮次) × count` |
| 5 | `actionNote` 单槽位 | 低优先，可不动 |
| 6 | v4 无 D3 场景 | **批准补**（见 §33.2） |
| 7 | harness 收进 `tools/` | **批准**（见 §33.2） |

---

## 34. H1 补丁回执

### 34.1 两处小修完成
- **串行队列**：模块级 `writeChain` + `enqueue(task, fallback)`。`appendRecords` / `clearHistory` 拆成「对外包装 + `*Inner`」，两者经 `enqueue` ⇒ 连带 `trimTo` **三者互斥**。`then(safe, safe)` + 链自身收敛为 resolved ⇒ **一环失败不污染后续**。**读操作不入队**（否则读会被写阻塞；`appendFile` 与 `rename` 本身原子，读到的永远是完整文件）。
- **坏路径定向检测**：`diagnoseMissingFile(path)` 三分支与裁决**逐条对应** —— 父级是文件 → 报 error；父目录尚未创建（`ENOENT`）→ `null`（首次运行）；父目录不可用 → 报 error。
- `lib/history.js` 16070 → **20256 B / 467 行**；测试 12 → **15 条**（新增 11 / 11b / 12）

### 34.2 ⚠️ 两条团队标准（新增，**重要**）

**标准 A：并行缺陷的中和实验天生是概率性的 —— 不能「一次没红」就下结论。**
中和 1 首次**未能复现**：原用例（3×10 条 + 1 clear）的 `appendFile` 窗口太小，`clear` 的 `rename` 插不进去，**5 次采样全绿**。
⇒ 它**放大竞态窗口**（240 条 × 3 KB ≈ 750 KB，**仍在 1 MB 裁剪线之下**，不触发裁剪、不变量保持简单）后重测：**5 次采样 3 次复现，且每次都只有用例 11 红**。
⇒ 原话：「这是**概率性竞态**，不是确定性的……**不能因为一次没红就宣称用例无效**」。**采纳。**

**标准 B：夹具缺陷与实现缺陷要分清。**
用例 11 首次红时报 `出现未知 runId：C-30` —— **是它自己夹具的 bug**（`known` 集合用 `1..10` 为三个批次统一构造，而 B/C 实际是 `11..20` / `21..30`），**不是实现缺陷**。已按区间配对修正并主动认错（§25.2）。

### 34.3 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | 用例 11 的竞态检测是概率性的（~60% 命中）；要确定性需**改接口**加「写生命周期钩子」 | **不做**。理由：该用例**无假失败**（队列在位时永远全绿），只是"有时能抓到"，已是有效回归护栏；为测试注入点扩大冻结接口，收益不抵 |
| 2 | `writeChain` 单条全局链，不按路径分链 | **确认维持**。宿主只会有一个历史文件；按路径分链是为不存在的场景加复杂度 |
| 3 | `enqueue` fallback 里的 `resolveHistoryPath()` 不可能抛 | **确认**，双保险不失效 |
| 4 | 用例 7 故意不断言 `stats.error`（由用例 12 覆盖），避免两个用例耦合 | **确认**，这个解耦是对的 |

### 34.4 隔离验证
真实 `%LOCALAPPDATA%\dsh-fingerprint` 仍**不存在**（`Test-Path` = False）；`%TEMP%` 无残留 ⇒ **测试全程不碰生产数据**。
用例 12 的**对照组**（防把"正常"误判成"坏"）：父级是文件 → 报 error ✓；父目录尚未创建 → `error === null` ✓；父目录存在但文件未建 → `error === null` ✓；**父目录不存在时写入必须成功**（自动 mkdir）✓

---

## 35. H2 回执 + 契约更正（**3 处，其中 2 处影响 W6**）

### 35.1 ⚠️ 更正 1：§29.5 的 `/history/models` 形状写错了
§29.5 原文字面写「返回 `[{provider,…}]`」，而 H2 指令要求 `{ok:true, models:[...], stats:{...}}` —— 后者与其它路由的 `{ok,…}` 习惯一致，**以 H2 为准**。
⇒ **§29.5 该行更正为**：
```
| GET | /fingerprint/history/models | {ok:true, models:[{provider,model,lastTs,runs,lastDecision,lastPrediction,lastProbability,lastStability}], stats:{count,path,oldest,newest,skippedLines,error}} |
```

### 35.2 ⚠️ 更正 2：`/history/models` **也带 `stats`**（§31.2 的适用面扩大）
理由同 §31.2：`aggregateByModel()` 失败时退化为 `[]`，**没有 `stats.error` 就分不清「空」与「读失败」**。

### 35.3 ⚠️ 更正 3：**`stats.count` 是文件总量，与过滤无关**
真机实测：`GET /history?provider=nope` → `records=0` 但 `stats.count=1`。
⇒ **W6 注意**：`stats.count` **不是**「过滤后的条数」；过滤后的条数应取 **`records.length`**。
⇒ 否则 UI 会出现「筛了一个不存在的模型，却仍显示 共 1 条」这种自相矛盾的计数。

### 35.4 团队标准（新增）：测 **header 类防线**，必须先证明客户端**真的发出了那个头**
H2 自曝两个「验证脚本 bug」（不是代码 bug）：
1. 第一版 live 脚本的 `api()` **把 `headers` 参数丢了** ⇒ 请求根本没带 `Origin` ⇒ 「evil.example → 200」是**假阳性**
2. **Node 的 `fetch` 无法设置 `Host`**（Fetch 规范的 forbidden header）⇒ 「Host: example.com → 200」也是**假阳性**

⇒ 改用 PowerShell（能改 `Host`）与修正后的 helper 复测，**两项都是 403**。
⇒ **标准**：**测 header 类防线，必须先用 `-v` / 回显证明你的客户端真的发出了那个头**；否则"放行"结论完全无效。
⇒ 与 §32.1 的「并发度量必须先定义在跑口径」同源 —— **先证明观测手段有效，再下结论。**

### 35.5 H2 完成情况
- **终态落盘**：新增纯函数 `buildHistoryRecords(run)`（以 **`run.targets`** 为准 ⇒ **取消/失败的 run 也每目标一条**）+ `persistRunHistory(ctx, run, append)`（整段 try/catch；**注入抛错也只 `warn`，绝不抛**）⇒ **写历史失败不可能影响 run 终态**
- **三条路由**全部走既有 `authorize`；`limit` 钳制 1–200 默认 50，**非法值走默认不报错**
- **真机 `history.jsonl` 实存 1 行**：17 键齐全、`options` 只 4 键、**无任何 key / 明文 / rawText**
- **访问控制真机复测**（用能真正改 `Host` 的客户端）：`Host: example.com` → **403**；异端口 `Origin` → **403**；`cross-site` → **403**；`DELETE` → **405**；`GET /history/clear` → **404**
- 中和实验：**baseline 4/4 绿、中和段 3/3 红**（A 写历史失败不影响终态；B `stats.error` 透出）
- `test/index.test.mjs` **29/29**；备份 `-6`，未覆盖已有

⚠️ 真机那条记录是 **1 模型 × 1 轮 × count=1**（只花 **1 次请求**），`decision=unscorable` 是**预期**（单条挑战不足以评分，§11.5），**不是"写入坏了"**。
⇒ **该记录保留、不清空** —— 正好让操作者在历史页看到有内容。
（H2 询问是否要真机验 `POST /history/clear`：**不做**。离线已覆盖 `removed` 计数与清空后状态；真机清掉反而会拿走操作者用来目视验收的那条记录。）

---

## 36. W6 第二波回执 + 裁决

### 36.1 完成情况
- `client.js` 141203 → **144631 B / 3178 行**；新建 **`tools/client-smoke.mjs`（53961 B）**
- **历史页**：`SegmentedTabs`（取不到 primitives 时降级为按钮组）/ 聚合表 / 懒加载明细 / 搜索过滤 / **清空二次确认** / 空历史 / 路由 404 明确状态
- **更正 2/3 落地**：`stats.count` 只用于「历史文件共 N 条记录」这一**总量口径**；列表条数一律用 `records.length` / `filtered.length`；两条路由的 `stats.error` 都显式提示；**读失败时不再显示「还没有检测记录」、明细区也不谎报「暂无明细」**
- **容忍空洞**：新增 `safeList()`，覆盖 `rounds[]` / `samples[]` / `perRound[]` / `ranking[]` / `tasks[]` / `results[]`；`perRound` 缺 `index` 时退回**数组位置**编号 ⇒ **绝无「第 NaN 轮」、绝不空指针**
- **在飞数精确封顶**：`min(parallel, 目标×轮次) × count`（旧近似会显示 9，正确是 3）
- **冒烟 20 场景 × 2 模式 = 40 次运行，683 断言，0 失败，exit 0**；`--help` 与退出码约定齐备

### 36.2 ⚠️ 新断言逼出的 3 个真缺陷（**本轮最有价值的部分**）
| # | 缺陷 | 后果 |
|---|---|---|
| 1 | **`jsx("div", {...}, jsx(DisclosureRow, …))` 写法错误** —— `jsx` 第三参数是 **key**，不是 children | 历史明细块渲染成**空 div**（「展开了但什么都没显示」）。已修 + **全局正则扫查确认其余 0 处同类错误** |
| 2 | **SSE `onopen` 未处理** | 首条消息到达前通道标签一直停在「连接中」，而数据已走 SSE ⇒ **诊断误导** |
| 3 | `collapse` 字典键缺失 | UI 泄漏原始 key 「collapse」给用户。已补 zh/en |

⇒ **值得记**：这 3 个都是**加新断言逼出来的**，不是重构发现的。与 §23.2「加字段的人才能看见那个洞」同源 —— **观测面变大，缺陷才现形。**

### 36.3 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | `stats.count` 只做「文件总量」口径；要显示「筛选命中总数」需服务端支持 | **不做**。列表顶部显示「最近 N 条」即可；为锦上添花加服务端参数不划算 |
| 2 | 历史模型列表与 provider 清单是两套；搜索框匹配串已含 provider | **确认** |
| 3 | `/history/models` 双收（外壳版 + 裸数组兜底） | **确认**（向后兼容无害） |
| 4 | `checkP` 把 primitives 缺失时的**跳过记为 PASS** ⇒ **683 这个数字被虚高** | **要求改**：跳过单列 **SKIP**，不计入 PASS。理由：这份 harness 将来要当回归闸门，**SKIP 若伪装成 PASS，SKIP 增多将不可见** —— 这正是本项目一路在防的「虚高」 |
| 5 | 真机历史页未验证（用逐字复制的记录做夹具） | **接受**，待操作者目视 |
| 6 | `clear` 只有二次确认、无 30s 撤销 | **不做**。确认弹窗已足够；30s 撤销需服务端支持，过度设计 |

---

## 37. W6 收尾回执 —— SKIP 单列 + 三道防虚高闸门

### 37.1 ⚠️ 契约数字更正：**「683 断言」是虚高的**
旧口径把 SKIP 计入 PASS。真实拆分：
```
present : PASS 342 / SKIP 0 / FAIL 0
absent  : PASS 337 / SKIP 5 / FAIL 0
两模式  : PASS 679 / SKIP 5 / FAIL 0
```
⇒ **§33.2 / §36.2 里的「683 断言」更正为 679 PASS + 5 SKIP。**
⇒ absent 的 5 条 SKIP = `dormant45` 4 条（45 复选框 / 子树 41 条 / 全禁用 / 全选按钮）+ `detailToggle` 1 条（折叠行默认收起）。

### 37.2 ⚠️ W6 自己找到**同类第二处**「静默消失的断言」
`detailToggle` 里的**内联条件跳过**：`if (found.open !== undefined) check('D2 折叠行默认为收起', …)` —— **既不计 PASS 也不计 SKIP，直接消失**。
⇒ 已改为 `checkP`，现在 absent 模式记 1 条 SKIP。
⇒ 它的自定位很准：这属于「我先前只发现了 `checkP` 那一批」—— **同一病根的另一处形态**。

### 37.3 ⚠️ 它主动加了 2 道闸门（**批准，并作为团队标准**）
| 闸门 | 判据 | 防什么 |
|---|---|---|
| **守恒** | `present(PASS) == absent(PASS + SKIP)`，不等即 exit 1 | 出现「既没通过也没跳过」的**静默丢失断言** |
| **断言数下限** `ASSERTION_FLOOR` | 每场景 present 至少 N 条，低于即 exit 1；**未登记下限的新场景也判失败** | 防「整条断言被删、两模式一起变少、守恒仍成立」的**静默少测** |

**三道闸门都做了活体验证**（`%TEMP%` 副本注入违规，仓库文件未污染、验完即删）：
```
闸门1 SKIP-in-present：注入「present 也跳过」→ 不变式失败 exit=1 ✓
闸门2 守恒：把 checkP 改回内联 if → present 17 ≠ absent 16+0 → exit=1 ✓
闸门3 下限：整条删除 D2 断言 → present 16 < 下限 17 → exit=1 ✓
正常路径（未注入）：679 / 5 / 0 → exit=0 ✓
```
⇒ **团队标准（新）**：**「防虚高」必须有独立闸门，不能只靠人眼。数字自证比人盯可靠。**

### 37.4 裁决
1. `ASSERTION_FLOOR` 手工维护（**加断言不用调**，只在下限**高于**实际时才报；**删/改断言必须调**）—— **确认**，注释已写明维护约定
2. 守恒闸门只在**两模式都跑**时判定（单跑时自动跳过，闸门 1/3 仍生效）—— **确认**
3. 新场景未登记下限即失败（逼着登记）—— **确认**
4. `--verbose` 只打印 SKIP 明细 —— **确认**，够用
5. 真机未验证 —— **接受**，待操作者目视

---

## 38. W4 最终收口回执

### 38.1 ⚠️ 文件计数更正：**22 个，不是 21**
主脑给的清单是「20 项冻结表 + `README.md` = 21」，**实测插件目录（除 `node_modules`）共 22 个文件** —— 差的那个是 **`.smoke.json`**。
⇒ **裁决：按 22 列全。**
⇒ `.smoke.json` **不进冻结表**（它每次 `runSmoke()` 覆盖写，与冻结语义直接冲突），但**文档必须显式列出**它（否则后人会以为它无主）。
⇒ W4 用**程序化覆盖核对**（枚举实际文件 → 逐个检查 basename 是否出现在 README）验证：**22/22 全覆盖，无遗漏**。

### 38.2 三道负向实验（W4 用**自己的**注入手法，未照抄 W6）
| # | 注入手法（W4 自创） | 结果 | 关键旁证 |
|---|---|---|---|
| **①** 守恒闸门 | 插入一条**只在 `primitives-absent` 存在**的断言 ⇒ 两模式断言总数不等 | **exit 1**，理由正确 | **`FAIL 0`** —— 这类缺陷对普通 PASS/FAIL 计数**完全不可见**。全量复跑 **20/20 场景全部点名**，且 `PASS 699`（正常 679）—— 天真的"全绿"读者会看到 **PASS 反而多了 20**、FAIL 仍是 0 |
| **②** 下限闸门 | 让 `attach` 的 3 条断言在**两模式对称地不计数** | **exit 1**，理由正确 | `present 14 === absent 14 + 0` ⇒ **守恒闸门静默通过**；`FAIL 0` ⇒ PASS/FAIL 计数也看不见。**这正是下限闸门存在的唯一理由** |
| **③** 正常路径 | 无注入 | **exit 0** | 副本输出与原件**逐字一致**（先证明副本等价） |

**独立性矩阵**
| 实验 | 守恒闸门 | 下限闸门 | 普通 FAIL 计数 | 退出码 |
|---|---|---|---|---|
| ① | **红** | 通过 | 0（看不见） | **1** |
| ② | 通过 | **红** | 0（看不见） | **1** |
| ③ | 通过 | 通过 | 0 | **0** |

⇒ **两道闸门各自覆盖对方抓不到的那一类**；都真的会红、红的理由正确。
⇒ 这满足「用**不同手法**证明闸门本身有效」，而不是「它的注入能被它自己抓到」。

### 38.3 实验后冻结仍完整
专门复核被实验的文件：`tools/client-smoke.mjs` = 60363 B / `E9B399CC4690865C` → **MATCH（原件未动）**。
**20 项核对，不一致 0 项 → 20/20 全 MATCH。**
临时副本在 `%TEMP%\w4-gate-neg-*`，已按「绝对路径 + 前缀」双重确认后删除；插件目录扫描 `neg|pristine|.bak|tmp` → **无残留**。

### 38.4 最终四连（全部 exit 0）
```
① PASS 26 / FAIL 0 / SKIP 0
② 断言不符 0 处；不可达项 0 项（18 夹具 × 7 项 = 126 断言）
③ client-smoke: PASS 679 / SKIP 5 / FAIL 0
④ tests 137 / pass 137 / fail 0
```

### 38.5 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | 计数按 22 还是 21 | **按 22** —— 确认 |
| 2 | NEG-2 用「不计数」而非「真删一行」 | **接受**（触发同一判据 `present.passes < floor`） |
| 3 | `ASSERTION_FLOOR` 的 20 个下限只验证了 `attach` | **批准补全场景验证**（20 场景各注入 1 条对称消失断言，一次跑完） |
| 4 | 把负向实验固化成可复跑脚本 | **不做**（新建文件 + 属主 + 冻结决策，属「测测试的测试」）；**改为在 README 写一节复跑手法**，供后人重做 |
| 5 | 团队标准（新） | **验证"防虚高的闸门"时，必须证明它在"PASS 数反而增加"和"FAIL 为 0"两种表象下仍能红** —— 因为这两者正是虚高的伪装 |

---

## 39. 开源化：PUB-1 回执 + `engines.dsh` 预发布陷阱裁决

### 39.1 发布元数据已落地
`package.json` 1281 B：移除 `private` ✔；新增 `license:"MIT"` / `author:"Practice019"` / `repository` / `homepage` / `bugs` / 7 个 `keywords` / `files`；`engines` 加 `dsh`。
`LICENSE` 1068 B：标准 MIT 原文（未改写条款），`Copyright (c) 2026 Practice019`。
`.gitignore` 263 B：含 `node_modules/`、**`.smoke.json`**（开发期诊断产物）、`*.log`、`*.bak*`、`.DS_Store`、`Thumbs.db`。
冻结值保持不动：`name`/`version 0.1.0`/`type`/`main`/`exports` 三键/`dsh.bundle.patch`/`dsh.client.platform`/`dependencies`；**`dsh.client.inject` 仍省略**；**未加任何 `@deepseek-ai/dsh*` peer**（声明了 `engines.dsh` 后 peer 会被整体忽略，是死配置）。

秘密扫描（三文件 × 五类模式：本机用户名、盘符绝对路径、GitHub PAT 前缀、OpenAI key 前缀、token 字样）：**命中 0** ✔

### 39.2 ⚠️ `engines.dsh` 的预发布陷阱（PUB-1 自己测出，**必须让用户知道**）
实测矩阵（真实 semver）：
| range | 0.2.1-rc.3 | 0.2.1 | 0.2.2-rc.1 | 0.2.5-rc.1 | 0.2.9 | 0.3.0 |
|---|---|---|---|---|---|---|
| `>=0.2.1-rc.2 <0.3.0`（**本实现**） | ✔ | ✔ | **✖** | **✖** | ✔ | ✖ |
| `... \|\| >=0.2.2-rc.1 <0.3.0` | ✔ | ✔ | ✔ | **✖** | ✔ | ✖ |
| `>=0.2.1-rc.2`（无上界） | ✔ | ✔ | **✖** | **✖** | ✔ | ✖ |
| `>=0.2.1-rc.2 <0.3.0-0` | ✔ | ✔ | **✖** | **✖** | ✔ | ✖ |

**根因**：semver 规定「带预发布的版本只有在范围里存在**同 `[major,minor,patch]` 元组且自身带预发布**的比较器时才可能被满足」。`0.2.2-rc.1` 的元组是 `0.2.2`，范围里没有该元组的比较器 ⇒ 不满足。
⇒ **单条 range 无法表达「任意 0.2.x 预发布」**（已实测 4 种写法）。
⇒ **这是生态共病**：本机已装且正常的 `@ayanehana/dsh-reasoning-effort` 用**同一个 range**；`dsh-skill-mcp-panel` 的 peer 同样踩此规则。

### 39.3 裁决：**保留该范围**，但 README **必须**写清两件事
1. **维护义务**：DSH 每发一个新 RC，必须同步更新 `engines.dsh`；否则插件会被**明确 skip + 警告**。
2. **逃生口**：DSH 自带按 `name@version` 加白名单的子命令（取证 `dsh-plugin-manager` 的 `plugin-BiveYA7h.js:16-30`）：
   ```
   dsh plugin --profile <profile> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk
   dsh plugin --profile <profile> version-exemptions
   dsh plugin --profile <profile> revoke-version <pkg>@<ver>
   ```
   ⚠️ **要求 W4 先用 `dsh plugin --help` 核对该语法再写进 README**（这是转述证据，必须自己验一遍）；对不上就如实标注。

### 39.4 其他裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | `engines.dsh` 对未来的预发布不放行 | **保留范围 + 文档化**（见 §39.3）。不采用"无上界"（会放行 `0.3.0`，风险更大） |
| 2 | `dsh.install` **无任何运行时消费者**（6 个包 grep `preferred|tarball` → 0 命中，唯一实例是 `dsh-purge-community`） | **保留**。理由：它**不影响任何加载行为**（不像 `engines`/`peers`），生态里最知名的插件也这么写，属人类/市场可读元数据。**在契约记录"无运行时消费者"这一事实**，以免后人误以为它在起作用 |
| 3 | `private` 移除后 `npm publish` 不再被阻止 | **知悉**。本轮**只做 GitHub**，不做任何 npm 操作 |
| 4 | PUB-1 未跑 `selfcheck` | **正确**：它此刻正被 W4 改写，且不在其所有权内 |

### 39.5 团队标准（新）
**发布一个字段前，必须证明它有消费者。** 若证明"无消费者"却仍要写，必须在文档里记录这一事实与保留理由（本条即 §39.4 第 2 项的做法）。

---

## 40. 开源化：PUB-3 回执（`docs/DESIGN.md`）+ 裁决

### 40.1 交付物与保真证明
`<plugin-dir>/docs/DESIGN.md` → **118,436 B / 1591 行**（正文 1572 + 导言 19 + 术语表）。契约原件**未被写入**。

**保真证明方式（值得记）**：把输入正文按**同一套 26 条规则重放**，与输出正文**逐字节比对**：
```
期望正文 116937 B ／ 实际正文 116937 B  → ✅ 逐字节完全一致
H2: 40 / 40  ✅ 同名同序        H3: 156 / 156  ✅ 同名同序
```
⇒ 这比"我没有删东西"强得多 —— 它是**可复现的证明**，而非自述。
⇒ **团队标准（新）**：**声称"只做了形式转换、没改内容"时，必须给可复现的重放比对，不能只给保证。**

### 40.2 ⚠️ PUB-3 自主扩大的脱敏范围（**批准**）
| # | 发现 | 处置 | 裁决 |
|---|---|---|---|
| **a** | 第 181 行 `/targets` 示例含 **`http://<provider-host>:7863/v1`** —— 操作者**私有公网网关地址**。主脑的替换表只覆盖盘符路径，**未提 IP** | 替换为 `http://<provider-host>:7863/v1` | **批准**。这是真正的泄漏，主脑的表有边界，PUB-3 按"开源前该收口"的**意图**做了正确推断 |
| **b** | 32+ 位十六进制串 1 处（§37.5 的 `client.js` 冻结 sha256）。它**先验证了性质**（上下文是冻结确认 → 文件完整性哈希，非凭据），替换为占位符，**并在回报里给出完整原值，未掩盖** | 占位符 `<client.js 冻结时的 SHA256>` | **维持占位符**。理由：该哈希随每次编辑变化、对外部读者无意义，且属于**本地冻结的验证产物**而非设计内容；更重要的是 —— **"32+ hex 一律为 0"是简单可审计的规则，为它开例外会削弱审计性**。规则简单 > 个案最优 |
| **c** | §39.1 的**扫描模式串字面量** （本机用户名 \| 盘符绝对路径 \| GitHub PAT 前缀 \| OpenAI key 前缀 \| token 字样） 自身同时命中 4 项禁止项（自指悖论） | 改写为语义等价的描述（"五类模式：本机用户名、盘符绝对路径、GitHub PAT 前缀、OpenAI key 前缀、token 字样"） | **批准**。这是清零的必要条件，且语义完整保留 |

### 40.3 事实更正（**批准**）
导言原稿写「记录了 **38 个阶段**」，实际为 **§0–§39 共 40 个 H2 章节**。PUB-3 改为「40 个章节（§0–§39）」并单独报备。
⇒ **主脑笔误，PUB-3 正确。**（主脑长期口头沿用"38 节"是习惯性说法。）
（另：`## 术语表` 为新增 H2，故输出文件 H2 实测 41 = 40 正文 + 1 新增，与 PUB-3 报的 40 口径一致。）

### 40.4 其他裁决
| # | 项 | 裁决 |
|---|---|---|
| 1 | `profiles/desktop` 保留未替换 | **确认** —— profile 名不是个人信息，且主脑已给明确例外 |
| 2 | 首次扫描 base64 规则报 1 处，人工确认为**误报**（DSH kit API 名称列表含 `/` 被正则误吞） | **确认**。正确处置：标注误报，**不为迎合规则去改无辜内容** |
| 3 | `调度账本` 在原契约中 0 命中，故无处加括注 | **确认** —— 该词只出现在主脑的对话回复里，不在契约正文 |
| 4 | 重建脚本落在系统临时目录 `%TEMP%`（非插件目录内） | **知悉**。它在插件目录之外，**不会被 git 收录**，无需清理 |
| 5 | 输出正文相对契约有 19 行偏移 | **确认** —— 跨文件引用一律以 **§号** 为准 |

### 40.5 版本钉定
`DESIGN.md` 钉定于契约 `sha256 = <当时契约的 SHA256>`。
主脑已实测核对：**契约当前哈希与该钉定值一致** ⇒ DESIGN.md **未过期**，且 §39 内容已包含。
⇒ **纪律**：此后若再往契约追写，必须重跑 PUB-3 的纯函数重建流程，否则 `docs/DESIGN.md` 会静默落后。

---

## 41. 开源化：PUB-2 回执 + 裁决

### 41.1 README 已面向他人重写
- **机器字符串归零**（自证）：本机用户名 / 盘符绝对路径 / GitHub PAT 前缀 / OpenAI key 前缀 / Authorization 头字样，及追加的 5 类变体（正斜杠盘符路径 / 用户级 AppData 目录名 / 安装盘前缀 / 工作区目录名 / 插件目录名）—— **两文件合计 0 命中**
- 占位符：`<DSH_HOME>`×9、`<plugin-dir>`×7、`<profile>`×13、`%LOCALAPPDATA%`×3
- **安装优先级反转**：① 官方 `dsh plugin --profile <profile> add github:Practice019/dsh-fingerprint`（经 `operations.js:558-559` → `reconcile` → `:116-117` 自动写入 `dsh.profile.bundles`）；② junction 手装（本地开发）
- **profile 差异成表**：非 `desktop` → CLI 直接可用；**`desktop` 由 Electron 独占管理，普通 CLI 入口直接拒绝**（`dsh/lib/bin.js:36-38` 原话引用），首选 Web UI 侧栏「插件」页
- 所有权表**去掉内部代号**，改为职责描述；括注「内部协作代号曾为 W1–W7 / H1」
- 状态行只用可验证事实（`tests: 137 passing` / `selfcheck: 28 checks` / `license: MIT` / `0.1.0`），**未加无法验证的徽章**
- **两处发布语义反转**：① 已知风险里「**不要**声明 `engines.dsh`」→「**必须**声明且范围须覆盖运行时」；② 排错新增 `skipping profile bundle "dsh-fingerprint"` → 指向预发布陷阱与逃生口

### 41.2 ⚠️ 文件计数第三次更正：**磁盘 25 个 / 入库 24 个**
W4 报 25（含 `.smoke.json`），主脑清点报 24（排除 `.smoke.json`）。**两个都对，分母不同**：
- **磁盘实存 25 个**（含 `.smoke.json`）
- **入库 24 个**（`.smoke.json` 被 `.gitignore` 排除）
⇒ **交付说明必须写明两个数字**，避免混淆。

### 41.3 ⚠️ 主脑的指令前提是错的（W4 纠正）
主脑要求「逐条核对 **18 个夹具**的期望值，因为 C7 语义反转了」。
⇒ **实测：那 18 个槽位夹具（S1–S7）从来没有覆盖过 C7** —— 它们喂合成 `client.js` 源码、只走 `judgeSlots()`；C7 一直是**从真实 `package.json` 求值**的，**没有任何夹具覆盖**。
⇒ 「原应 FAIL 的夹具现在应 PASS」这个情况**不存在**；S1–S7 一个都不用改（复跑：126 断言，0 不符）。
⇒ W4 的正确处置：**新增夹具组**让新逻辑有红绿覆盖：
| 组 | 夹具 | 项 | 断言 | 结果 |
|---|---|---|---|---|
| S1–S7（未改动） | 18 | 7 | 126 | 全过 |
| **C7/X5/X6（新增）** | **19** | **3** | **57** | 全过 |
| 合计 | **37** | **10** | **183** | `断言不符 0 处；不可达项 0 项` |

⇒ **团队标准（新）**：**新增/反转的检查逻辑必须自带夹具才有红绿覆盖**；改语义前先核实「原夹具到底覆不覆盖它」，**不要假设**。

### 41.4 ⚠️ W4 用第一手证据纠正了主脑的转述错误
主脑给的逃生口命令是 `... revoke-version <pkg>@<ver>`（**缺** `--dsh-version`）。
⇒ W4 的取证方式：`dsh plugin --help` **不记录**这些 DSH 自有子命令，于是改从**二进制自己的校验报错**里取 usage —— 校验发生在读写任何文件**之前**，**零副作用**（已核对：profile 文件数 21→21、无残留 `package.json.lock`、未创建 `compatibility.json`）。
实测原文：
```
dsh plugin allow-version <package@version> --dsh-version <exact> --accept-risk
dsh plugin revoke-version <package@version> --dsh-version <exact>     ← --dsh-version 必需
dsh plugin version-exemptions
```
⇒ **主脑转述错误已由实测纠正**；`version-exemptions` 会走 `withFileLock`（有副作用），W4 **正确地没有执行**。
⇒ **团队标准（新）**：**CLI 语法必须取自二进制自身输出的 usage，不得采信转述**；取 usage 时优先选「校验在副作用之前」的形式。

### 41.5 全仓库秘密扫描（W4 主动扩大，**逐条查清**）
| 命中 | 性质 |
|---|---|
| `test/targets.test.mjs` 的 `<key-prefix>` | **合成哨兵值** `<合成哨兵字符串>`（37 字符），用于断言 key **绝不进入 JSON 输出**（同文件断言 `includes(SECRET) === false`）⇒ 非真 key |
| `test/history.test.mjs` 的 `<key-prefix>` | 长度 3，实为 `runId: 'r-secret'` 里的片段 |
| `apiKey` / `token` / `secret` | 全是**字段名 / 循环变量 / 测试常量** |
| `.smoke.json` 的 `<本机用户名>` + 绝对路径 | 已被 `.gitignore` 忽略，且不在 `files` ⇒ **不会进仓库** |
| `docs/DESIGN.md` 的 `local-plugins` | 实为 `$DSH_HOME/local-plugins/...` —— **占位符形式** |

⇒ **仓库对 GitHub 发布洁净。**

### 41.6 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | 冻结已破坏，需重新冻结 | **确认**（发布后按新状态重算） |
| 2 | W4 未读 `docs/DESIGN.md` 内容，提议做面向外部读者的可读性/敏感信息复核 | **不做**。理由：PUB-3 已完成脱敏（含其自主扩大的 IP 收口）+ 内容保真重放证明，W4 又做了全仓秘密扫描；对 118 KB 文档叠第三轮审查收益递减。**记为残余项**（§42.4） |
| 3 | C7 的 `RUNTIME_VERSION_AT_CAPTURE = '0.2.1-rc.3'` 是硬编码 —— DSH 升级后会**判错**（不是「过时提示」） | **要求改成动态读取 + 硬编码兜底** —— 见 §41.7 |
| 4 | `dsh.install` 的「无运行时消费者」是转述、未独立复核 | **接受**。措辞已写成可证伪（「当前没有」），符合 §39.5 |
| 5 | `version` 保持 `0.1.0` | **确认**（X1 依赖它） |

### 41.7 追加小修（W4，最后一处代码改动）
C7 的判定对象改为**动态读取**：优先从已装 DSH 读取真实运行时版本（W1 已证明可行：读 `@deepseek-ai/dsh/package.json` 的 `version`），读不到时**回落到硬编码常量**，并在输出里**注明用的是哪一路**。
⇒ 理由：硬编码常量会让 C7 在 DSH 升级后给出**错误结论** —— 这正是本项目一路在防的「判错」。
⇒ README 同步补一句：该常量需随 DSH 升级维护（若走动态路径则自动）。

---

## 42. 开源化：PUB-4 回执 + 出版快照封版声明

### 42.1 C7 三级取值已落地
`tools/selfcheck.mjs` 83992 → **117392 B**；`README.md` 33892 → **35593 B**。
三级：`--dsh-version`（最高）> 动态读取 > 回落常量；**每一路都在输出里标注「来源」**。
新增 `--dsh-pkg <path>`（**超出规格，已批准** —— 见 §42.3 第 1 项）。
夹具 37 → **52**；断言 183 → **231**；三组全过、`断言不符 0 处；不可达项 0 项`。

**反例注入（主脑要求的）**：`--dsh-version 0.3.0` → C7 **FAIL**，红的理由是 **`<0.3.0 未通过`**（范围不覆盖），**不是**「读不到」 ⇒ 证明新参数**真的接进了判定链**，而不只是被解析。

### 42.2 ⚠️ W4 第三次纠正主脑：**动态路在本机不会自动命中**
主脑告诉它「W1 已验证可行：读 `@deepseek-ai/dsh/package.json`」。W4 实测：
- `profile/node_modules/@deepseek-ai/` 只有 `cosmokit` / `dsh-brand` / `dsh-typert-protocol` / `schemastery` —— **没有 `dsh`**
- 那四个是**实体目录**（`LinkType` 为空），**不是指向安装树的链接** ⇒ 无法顺兄弟目录找到
- 向上逐级（pluginDir/profileDir 各 4 层）、`DSH_HOME/node_modules`、`.pnpm` —— **全部没有**

⇒ W1 当初读到版本，**是因为主脑给了它安装树的绝对路径**，而非 profile 侧可解析。**主脑把一次"带绝对路径的一次性取证"转述成了"可解析的常规能力"，误导了 W4。**
⇒ **实际状态：默认（不加参数）永远走回落常量。**

### 42.3 裁决
| # | 问题 | 裁决 |
|---|---|---|
| 1 | `--dsh-pkg` 超出规格 | **批准**。没有它本机动态路 100% 不命中，"动态读取"这一路就形同虚设 |
| 2 | 动态路对普通用户不自动生效 ⇒ "自动维护"承诺落空 | **接受现实，不做 DSH 侧改动**。权威的兼容性判定本来就在 **DSH 加载时**（`pluginCompatibilityWarning`）；C7 只是**仓库自检的便利检查**。处置：① 输出标注「来源」；② 两个逃生口 `--dsh-version` / `--dsh-pkg`（含三个环境变量）；③ README 明写「看到『来源：硬编码常量』就是在回落」。**不新增 `DSH_RUNTIME_VERSION` 之类 DSH 侧改动** —— 越界且非必要 |
| 3 | `RUNTIME_VERSION_AT_CAPTURE` 仍需人工维护；可考虑缓存到 `DSH_HOME` | **维持只读约定，不写文件**。工具不应为了自动更新而在用户目录留痕 |
| 4 | 未读 `docs/DESIGN.md` | **确认**（它是出版快照，中间态落后是预期内的） |
| 5 | README 写成表格 + 两条命令，而非"严格一句话" | **批准**。信息完整优先于字数 |

### 42.4 ⚠️ W4 新增两类断言（**批准，值得记**）
它指出「**只看 PASS/FAIL 测不出这次要证明的东西**」，于是补：
- **证据断言（9 条）**：断言 C7 输出里**真的出现**了「判定对象 = …（来源：…）」那行、三个来源标签、`可能已过时`、`采集时刻 2026-11-02` 等字样
- **来源标签断言（3 条）+ 路径可达性**：断言 explicit / dynamic / fallback **三路都真的被走到**

⇒ **团队标准（新）**：**当一次改动的产出物是「给人看的诊断信息」时，必须断言那段信息真的出现 —— 只断言退出码 / PASS 数测不出它。**

### 42.5 局部完整性对照（冻结已破的情况下仍做了）
W4 用**自己上一轮记录的值**逐项比对 20 项：只有两个文件变化 —— `tools/selfcheck.mjs`（它，本轮授权）与 `package.json`（W1，上一轮）；其余 **18 项逐字节未变**，mtime 亦印证。
⇒ **团队标准（新）**：**冻结期间发生授权改动时，「用自己上一轮的记录做局部比对」仍能证明自己只动了授权范围内的文件。**

### 42.6 出版快照封版声明
⇒ `docs/DESIGN.md` = **本契约在出版时刻的快照**（将含 §0–§42）。
⇒ **此后契约若继续增长，DESIGN.md 不再跟随、也不需要重建** —— 这不再是"落后"，而是**设计快照与开发日志的正常分工**。
⇒ **本节即快照的最后一节。**

### 37.5 `client.js` 冻结确认
```
bytes = 144631   lines = 3177   mtime = 2026-11-02 06:43:20
sha256 = <client.js 冻结时的 SHA256>
```
⇒ mtime **早于**本轮 harness 改动（06:45–06:50）⇒ **本轮未再修改**。

---

## 附录：本文档的时间边界（必读）

> 本节写于文档封版之后，只为外部读者补一个时间坐标；**上文任何内容都未改动**。

### 1. 它是快照，不是现状

本文档覆盖设计契约的 **§0–§42**，成文于某一个时点。**此后的全部设计与裁决都不在本文档内。**

### 2. 配套契约在哪、覆盖到哪

真正的工作契约是一份**未随本仓库发布**的记录（维护在开发者的工作目录中），**且在本文档成文之后仍在继续增长** —— 所以**不要把它当成有终点的文档**。下面列出 **§43–§65** 的节标题（**只列标题**，内容涵盖发布后修订、X7 私有标识自检、运行中侧车与中断恢复、`probabilityStatus` 与 OD-1、`origin` 维度等）：

- **§43** 发布后独立验收（PUB-8）：**推翻主脑的核心结论 + 2 项阻断**
- **§44** 发布后修订（一）：`engines.dsh` 范围裁决 + **C7 同病**
- **§45** 发布后修订（二）：PUB-10 回执（`docs/DESIGN.md` 标识符脱敏）
- **§46** 发布后修订（三）：PUB-11 回执 —— **同类泄漏扩散到另外 3 个测试文件** + 扫描工具交叉验证
- **§47** 发布后修订（四）：收口 + H2 噪声定性 + 「扫描→替换→再扫描」
- **§48** 收口前硬闸门：**第四次「范围不足」** + 一处裁决反转
- **§49** **统一占位词表（冻结）** —— 全仓唯一版本
- **§50** 发布后修订（六）：PUB-16/17/18 回执 —— 词表统一 + 自动化那道闸门
- **§51** PUB-19 回执：**X7「本仓库不含私有标识」** —— 那道四次失败的手工闸门已自动化
- **§52** PUB-20 回执：README 同步 X7 + **文档被自己的检查抓到**
- **§53** PUB-21 回执：发布后独立复验 —— **两个阻断已解除**，但发现 5 个非阻断缺陷
- **§54** PUB-22 回执 + 公网逐项复核 —— **收工**
- **§55** 操作者报障：一条历史记录"消失" ⇒ 定位到**两个真实设计缺口** + 冻结修复接口
- **§56** FIX-A1 回执（`lib/history.js` 侧车）+ 两条团队标准
- **§57** 团队标准（新增）：**完整性校验必须以哈希为判据，字节数只能作辅助信号**
- **§58** FIX-A2 回执（`lib/index.js` 接线）+ **修复已生效的实证** + 裁决
- **§59** 收口闸门 + **主脑第六次「观测手段不合格」** + 占位名残留裁决
- **§60** FIX-A 收尾：README 终稿 + 主脑误查目录 + 回滚点核实
- **§61** 🔍 `probability` 系统性为 null 的根因：**不是我们的 bug，但我们把解释丢掉了**
- **§62** 🔴 OD-1（真 bug）：`—` 有**两个**原因，第二个是我们读错了字段名
- **§63** OPT-2 回执：记录 18 键贯通 + OD-1 影响面 + 主脑第 8 类观测问题
- **§64** 目标轮次 1：OPT-5（`ranking[]` 真机验证）+ OPT-6（`origin` 维度）
- **§65** OPT-5 回执：`ranking[]` 真机取证 —— 三个真发现 + 一个必须记的行为边界

### 3. ⚠️ 最要紧：别把本文档里的数值当成现状

本文档中**所有具体数值**（字节数、行号、SHA256、测试条数、场景数……）**都是它成文那一刻的采样，不是当前值**。

- 典型例子：**§37.5 写的 `client.js` = 144631 B / 3177 行** —— 那是**当时**的值，**现在已是另一个数**。
- ⇒ 要判断现状，请看仓库里的**当前文件**；**不要引用本文档里的数字**。

### 4. 为什么保留旧措辞而不改写

本文档的定位是**原始记录**。为了"跟新"而回头改写它，会让记录变成"如今的样子"，**反而削弱它的证据价值**。

⇒ **凡本文档与现行代码冲突，一律以代码为准。**（这是明确裁决，不是偏好。）

### 5. 术语表在哪

**文首的 `## 术语表`** 定义了文中出现的内部协作代号：`主脑`、`W1`–`W7`、`H1`、`§NN`、`冻结哈希`、`中和实验`、`反例验伪`。这些代号是**协作过程的标识**（谁在做、怎么验证），**对使用者没有意义** —— 不理解它们也不影响读懂结论。

### 6. 读它时该有的预期

本文档是**设计与验证过程的记录**（我们怎么想、怎么证伪、错在哪、被谁推翻），**不是使用手册**；安装、配置与日常使用请看仓库根目录的 **`README.md`**。
