/**
 * lib/targets.js —— 目标清单（provider × model）组装（契约 §12.4，负责人 W5）
 *
 * 这是页面上那棵「勾选树」的唯一数据源：把 DSH 里已配置的 provider 与其模型
 * 组装成前端可直接渲染的清单。
 *
 * 三条硬约束：
 *   1. §2.5 陷阱 —— **模型主来源是 settings 的 `models` 数组，不是 `listModels()`**。
 *      pi-ai 在无 key 时 `listModels` 直接返回 `[]`（MISSING_CREDENTIAL → return []），
 *      只靠它会让本机指向 `http://127.0.0.1:7860/v1` 的 provider 凭空消失。
 *      `listModels()` 仅作 `source:'catalog'` 补充，且**只对 active provider 尝试**。
 *   2. §2.6 密钥边界 —— 明文 key 只在宿主侧取到，**绝不允许进入任何返回体**；
 *      本模块对外只暴露三态 `credentialAvailable`（true / false / null，见 §14.3 / §15.2）。
 *   3. 错误隔离 —— 任何单个 provider 出错（settings 缺 ns、profile 形状怪、
 *      credential 解析抛错、目录字段是抛错 getter）都不得让整个 `listTargets` 抛异常，
 *      该 provider 记 `error` 字符串，其余照常返回。
 *      FIX-11 起，`text()` 自身与 descriptor 扫描循环也已补齐，这条自述才真正成立。
 *   4. FIX-10 —— 「无法判定」与「未配置」必须分开：`credentialAvailable` 是三态，
 *      settings 快照取不到、catalog 问不通时一律 `null`（旁证丢失 ≠ 用户没配 key）。
 */

/** 缓存有效期：只做 5 秒短缓存（用户随时会改配置，不能做长期缓存）。 */
const CACHE_TTL_MS = 5000

/** 模块级短缓存：同时记住 ctx 引用，避免不同上下文之间串味。 */
let cache = null

/** 清空目标清单缓存。用户改完配置后可由 HTTP 层主动调用。 */
export function invalidateTargets() {
  cache = null
}

/**
 * 由 provider id 推导凭据引用名（契约 §12.4）：
 * 非字母数字一律转 `_`，整体大写，后缀 `_API_KEY`。
 * @param provider provider id，例如 `acme` / `deepseek-official`
 * @returns 例如 `ACME_API_KEY` / `DEEPSEEK_OFFICIAL_API_KEY`
 */
export function deriveKeyRef(provider) {
  const normalized = String(provider).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return `${normalized}_API_KEY`
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 只接受非空字符串；其余（含空串）归为 null。 */
function toNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 只接受正整数，其余归为 null。 */
function toPositiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/** 归一化输入模态数组；未知返回 null（§10：缺省表示未知）。 */
function normalizeInput(value) {
  if (!Array.isArray(value)) return null
  const modalities = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) modalities.push(item)
  }
  return modalities.length > 0 ? modalities : null
}

/**
 * 把任意抛错转成一行可读文本。
 * **本函数自身永不抛**（FIX-11）：被抛对象可能实现了抛错的 `toString` /
 * `Symbol.toPrimitive`，或是 getter 抛错的 Proxy —— 那时 `String(error)` 会再抛，
 * 异常将逃出 `buildProvider` → `Promise.all` 拒绝 → `listTargets` 抛出，
 * 直接违反本模块「永不抛异常」的自述。
 */
function text(error) {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
  } catch {
    return '[不可字符串化的错误对象]'
  }
}

/**
 * 安全调用一个可能缺失 / 抛错的服务方法。
 * 服务不存在、方法不存在、方法抛错，一律退化为空数组。
 */
async function safeArray(fn) {
  try {
    const value = await fn()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

// ── settings 侧 ─────────────────────────────────────────────────────────────

/**
 * 按 `settingsNs` + `settingsPath` 从 settings 快照里下钻出 provider 的 profile 对象。
 * - pi-ai：`settingsPath = ["providers", provider]`
 * - llm-deepseek：`settingsPath = []`（section 根就是 profile）
 * 任一环节缺失或形状不对，一律返回 null（视为「没有配置块」，不是错误）。
 */
function resolveProfile(descriptorByNs, settingsNs, settingsPath) {
  if (settingsNs === null) return null
  const descriptor = descriptorByNs.get(settingsNs)
  if (descriptor === undefined) return null

  let node = descriptor.value
  const path = Array.isArray(settingsPath) ? settingsPath : []
  for (const key of path) {
    if (node === null || typeof node !== 'object') return null
    node = node[key]
  }
  return node !== null && typeof node === 'object' ? node : null
}

/** 从 profile 的 `models` 数组构造 config 侧模型行。 */
function configModels(profile) {
  const rows = []
  const raw = profile !== null && Array.isArray(profile.models) ? profile.models : []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = toNonEmptyString(item.id)
    if (id === null) continue
    rows.push({
      id,
      name: toNonEmptyString(item.name) ?? id,
      source: 'config',
      contextWindow: toPositiveInt(item.contextWindow),
      maxTokens: toPositiveInt(item.maxTokens),
      input: normalizeInput(item.input),
    })
  }
  return rows
}

// ── catalog 侧 ──────────────────────────────────────────────────────────────

/**
 * 向适配器询问目录（`listModels`）。
 * ⚠️ 它**会真的联网** `GET /models`，且无 key 时返回 `[]`，必须 try/catch。
 * 只在 active provider 上调用（由调用方保证）。
 *
 * FIX-10：返回 `{ rows, state }` 而**不再是裸数组** ——
 * 「问不通」（`state:'error'`）与「问通了但没有」（`rows:[]` + `state:'ok'`）必须区分。
 * 旧实现把异常静默吞成 `[]`，于是 catalog 旁证丢失被误读成「未配置」，把可用 provider 置灰。
 *
 * @returns {Promise<{rows: object[], state: 'ok'|'error'|'skipped'}>}
 *          `skipped` = 未尝试（ctx 不可用 / 服务缺失 / 休眠项由调用方跳过）
 */
async function catalogModels(ctx, provider) {
  if (ctx === null || ctx === undefined) return { rows: [], state: 'skipped' }
  const llm = typeof ctx.llm === 'object' && ctx.llm !== null ? ctx.llm : null
  if (llm === null || typeof llm.listModels !== 'function') return { rows: [], state: 'skipped' }

  let listed
  try {
    listed = await llm.listModels(provider)
  } catch {
    // FIX-10：异常必须被记为 error，不能静默降级成「空目录」。
    return { rows: [], state: 'error' }
  }
  if (!Array.isArray(listed)) return { rows: [], state: 'error' }

  const rows = []
  for (const item of listed) {
    if (item === null || typeof item !== 'object') continue
    const id = toNonEmptyString(item.id)
    if (id === null) continue
    rows.push({
      id,
      name: toNonEmptyString(item.name) ?? id,
      source: 'catalog',
      // catalog 只公布身份与模态，没有上下文窗口 / 输出上限信息。
      contextWindow: null,
      maxTokens: null,
      input: normalizeInput(item.inputModalities),
    })
  }
  // 走到这里说明适配器确实答了话：rows 为空是「真的没有」，不是「问不通」。
  return { rows, state: 'ok' }
}

/** config 优先、按 id 去重合并。 */
function mergeModels(configRows, catalogRows) {
  const byId = new Map()
  for (const row of configRows) byId.set(row.id, row)
  for (const row of catalogRows) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return [...byId.values()]
}

// ── 凭据引用解析（§14.2）──────────────────────────────────────────────────

/**
 * 按序探测该 provider 的凭据引用，返回**第一个命中**者（契约 §14.2）。
 *
 * 起因：`deriveKeyRef` 兜底会把 `deepseek-official` 猜成 `DEEPSEEK_OFFICIAL_API_KEY`，
 * 而实际约定是 `DEEPSEEK_API_KEY`，会让 UI 误报「未配置」。
 * 官方内置 Models 页的做法（`dsh-client-ui-settings-models/lib/client.js:1379,1404-1407`）
 * 是把 `entry.nativeAuth?.env` 里的 ref 也纳入探测。探测顺序：
 *
 *   1. `profile.apiKeyEnv`        ← 首选，正常配置走这条        → 'profile'
 *   2. `entry.nativeAuth?.env[]`  ← 逐个探测                   → 'nativeAuth'
 *   3. `deriveKeyRef(provider)`   ← 最后兜底（猜的）            → 'guessed'
 *
 * @returns {{ ref: string, source: 'profile'|'nativeAuth'|'guessed' }}
 */
function resolveCredentialRef(profile, directory, provider) {
  const fromProfile = toNonEmptyString(profile?.apiKeyEnv)
  if (fromProfile !== null) return { ref: fromProfile, source: 'profile' }

  const nativeAuth = directory?.nativeAuth
  const envList =
    nativeAuth !== null && typeof nativeAuth === 'object' && Array.isArray(nativeAuth.env) ? nativeAuth.env : []
  for (const item of envList) {
    const ref = toNonEmptyString(item)
    if (ref !== null) return { ref, source: 'nativeAuth' }
  }

  return { ref: deriveKeyRef(provider), source: 'guessed' }
}

// ── 凭据可用性（只回布尔 / null）───────────────────────────────────────────

/**
 * 判断某个凭据引用当前是否有值。
 * 主路径 `ctx.credentials.resolve(ref)`，回退 `ctx.get('launchEnvironment').get(ref)`。
 * **只返回布尔** —— 任何情况下都不把值透出，这是 §2.6 的硬边界。
 */
async function hasCredential(ctx, ref) {
  if (ref === null) return false

  const getService = (key) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    } catch {
      return undefined
    }
  }

  const credentials = getService('credentials')
  if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return true
    } catch {
      // 解析失败按「不可用」处理，继续走回退路径。
    }
  }

  const launchEnvironment = getService('launchEnvironment')
  if (
    launchEnvironment !== null &&
    launchEnvironment !== undefined &&
    typeof launchEnvironment.get === 'function'
  ) {
    try {
      const hit = launchEnvironment.get(ref)
      if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return true
    } catch {
      // 同上
    }
  }

  return false
}

// ── 单个 provider ──────────────────────────────────────────────────────────

/**
 * 组装单个 provider 行。
 * 本函数**不允许抛出**：任何异常都在内部转成 `error` 字段。
 * @param {boolean} settingsOk FIX-10：settings 快照是否成功取到；false ⇒ 所有 profile 丢失、旁证不可信
 */
async function buildProvider(ctx, slot, descriptorByNs, settingsOk) {
  const provider = slot.provider
  const active = slot.active

  const base = {
    provider,
    displayName: provider,
    active,
    dormant: !active,
    api: null,
    baseURL: null,
    credentialRef: null,
    /** 该 ref 是怎么来的：'profile' | 'nativeAuth' | 'guessed'（§14.2）。 */
    credentialRefSource: null,
    /** true | false | null（null = 无法判定，见 §14.3 / §15.2 / §20.3）。 */
    credentialAvailable: false,
    /** FIX-10：settings 快照本身是否取到；false ⇒ 旁证丢失，不得据此判「未配置」。 */
    settingsOk: false,
    /** FIX-10：catalog 询问结果：'ok' | 'error' | 'skipped' | null（null = 未计算，provider 级异常）。 */
    catalogState: null,
    error: null,
    models: [],
  }

  try {
    // 目录条目 / 已注册路由的字段读取全部推迟到这里 —— 目录字段可能是抛错 getter，
    // 提前读会在扫描阶段炸掉整个 listTargets。
    const directory = slot.directoryEntry
    const registered = slot.registeredEntry

    const displayName =
      toNonEmptyString(directory?.displayName) ?? toNonEmptyString(registered?.name) ?? provider

    const profile = resolveProfile(
      descriptorByNs,
      toNonEmptyString(directory?.settingsNs),
      directory?.settingsPath,
    )

    const api = toNonEmptyString(profile?.api)
    const baseURL = toNonEmptyString(profile?.baseURL) ?? toNonEmptyString(directory?.defaultBaseURL)

    // §14.2：按序探测 credentialRef，并记录它的来源（前端据此判断这个 ref 是确定的还是猜的）。
    const credential = resolveCredentialRef(profile, directory, provider)
    // §15.2：账号路由用 **truthy** 判定 —— 真机实测里 `nativeAuth.oauth` 不是严格布尔 true，
    // 用 `=== true` 会让 null 分支在真实环境下永不触发。
    const accountRouted = Boolean(directory?.nativeAuth?.oauth)

    const configRows = configModels(profile)
    // §12.4：只对 active provider 尝试 catalog（休眠项没有适配器，问了也没意义）。
    const catalogProbe = active ? await catalogModels(ctx, provider) : { rows: [], state: 'skipped' }
    const catalogRows = catalogProbe.rows
    const catalogState = catalogProbe.state
    // §15.2：catalog 真有模型 ⇒ `listModels()` 真的返回了东西 ⇒ 这条路由的凭据是通的
    //（pi-ai 在无凭据时直接返回 `[]`）。这是 `deepseek-account` 假阴性修复的关键证据。
    const catalogHasModels = catalogRows.length > 0

    // 凭据可用性最后算：前面任何一步失败都不该影响它。
    let credentialAvailable = false
    try {
      if (credential.source === 'guessed') {
        // ref 只能靠猜时，「探测不到值」不足以断定未配置 —— 逐级区分「无法判定」与「真未配置」。
        if (accountRouted || catalogHasModels) {
          // 账号路由，或 catalog 已证明凭据可用（§15.2）。
          credentialAvailable = null
        } else if (!settingsOk || catalogState === 'error') {
          // FIX-10：旁证本身丢了（settings 瞬时故障 / catalog 问不通）⇒ 同样无法判定。
          credentialAvailable = null
        } else {
          // FIX-10：旁证齐备，但猜的 ref 居然真能 resolve ⇒ 那就是有凭据。
          credentialAvailable = (await hasCredential(ctx, credential.ref)) ? true : false
        }
      } else {
        // profile / nativeAuth 给出的是确定 ref，正常判 true / false。
        credentialAvailable = (await hasCredential(ctx, credential.ref)) ? true : false
      }
    } catch {
      credentialAvailable = false
    }

    return {
      ...base,
      displayName,
      api,
      baseURL,
      credentialRef: credential.ref,
      credentialRefSource: credential.source,
      credentialAvailable,
      settingsOk,
      catalogState,
      // 配置诊断优先透出目录自带的 error，其次才是我们捕获到的处理异常。
      error: toNonEmptyString(directory?.error) ?? null,
      models: mergeModels(configRows, catalogRows),
    }
  } catch (error) {
    return { ...base, error: `处理该 provider 时出错：${text(error)}` }
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 组装完整目标清单（不走缓存）。 */
async function buildTargets(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return { providers: [] }

  const directory = await safeArray(() => ctx.llm?.listConfigurableProviders())
  const registered = await safeArray(() => ctx.llm?.listProviders())

  // FIX-10：必须区分「settings 快照取到了但为空」与「settings 快照根本取不到」。
  // 后者会让所有 profile 丢失、全体退化成 guessed ref —— 此时绝不能判「未配置」。
  let descriptors = []
  let settingsOk = false
  try {
    const raw = await ctx.settings?.describe()
    descriptors = Array.isArray(raw) ? raw : []
    settingsOk = Array.isArray(raw)
  } catch {
    descriptors = []
    settingsOk = false
  }

  const descriptorByNs = new Map()
  for (const descriptor of descriptors) {
    // FIX-11：单条 descriptor 抛错（例如 ns 是抛错 getter）不得影响整体 ——
    // 与相邻的 directory / registered 扫描循环保持对称。
    try {
      if (descriptor === null || typeof descriptor !== 'object') continue
      const ns = toNonEmptyString(descriptor.ns)
      if (ns !== null && !descriptorByNs.has(ns)) descriptorByNs.set(ns, descriptor)
    } catch {
      // 跳过这一条，继续处理其余 descriptor。
    }
  }

  // 扫描阶段只认 provider 身份（目录优先，保持确定性顺序）；
  // 其余字段一律推迟到 buildProvider 里读，保证 getter 抛错也能被隔离。
  const slots = []
  const slotByProvider = new Map()

  const ensureSlot = (provider) => {
    let slot = slotByProvider.get(provider)
    if (slot === undefined) {
      slot = { provider, active: false, directoryEntry: null, registeredEntry: null }
      slotByProvider.set(provider, slot)
      slots.push(slot)
    }
    return slot
  }

  for (const entry of directory) {
    let provider = null
    try {
      provider = toNonEmptyString(entry?.provider)
    } catch {
      provider = null
    }
    if (provider === null) continue
    ensureSlot(provider).directoryEntry = entry
  }

  const activeIds = new Set()
  for (const entry of registered) {
    let id = null
    try {
      id = toNonEmptyString(entry?.id)
    } catch {
      id = null
    }
    if (id === null) continue
    activeIds.add(id)
    ensureSlot(id).registeredEntry = entry
  }

  for (const slot of slots) slot.active = activeIds.has(slot.provider)

  // 并行组装：只有 active provider 会触发联网 listModels，并行才不会串行等待。
  const providers = await Promise.all(
    slots.map((slot) => buildProvider(ctx, slot, descriptorByNs, settingsOk)),
  )

  return { providers }
}

/**
 * FIX-12：冻结缓存返回值，防止调用方原地修改污染后续 5 秒内的所有命中。
 * 只冻到 provider / model 两层 —— 这正是调用方可能改到的深度，且不递归进未知结构。
 * 冻结纯属防御措施，失败不影响本次返回值的正确性，故整体包 try。
 */
function freezeTargets(value) {
  try {
    if (value === null || typeof value !== 'object') return value
    Object.freeze(value)
    const providers = value.providers
    if (!Array.isArray(providers)) return value
    Object.freeze(providers)
    for (const provider of providers) {
      if (provider === null || typeof provider !== 'object') continue
      Object.freeze(provider)
      const models = provider.models
      if (!Array.isArray(models)) continue
      Object.freeze(models)
      for (const model of models) {
        if (model !== null && typeof model === 'object') Object.freeze(model)
      }
    }
  } catch {
    // 冻结失败不影响正确性。
  }
  return value
}

/**
 * 列出可供页面勾选的目标（契约 §12.4）。
 *
 * @param ctx cordis 插件上下文（需要 llm / settings；credentials / launchEnvironment 可选取）
 * @returns `{ providers: [{ provider, displayName, active, dormant, api, baseURL,
 *            credentialRef, credentialRefSource, credentialAvailable,
 *            settingsOk, catalogState, error, models }] }`
 *          - `credentialRefSource`：`'profile' | 'nativeAuth' | 'guessed'`（§14.2）
 *          - `credentialAvailable`：`true | false | null`，`null` = 无法判定（§14.3 / §15.2 / §20.3）
 *          - `settingsOk`：settings 快照是否取到（FIX-10）
 *          - `catalogState`：`'ok' | 'error' | 'skipped' | null`（FIX-10）
 *
 * 本函数**永不抛异常**：服务不可用、单个 provider 出错都退化为带 `error` 的空结果。
 */
export async function listTargets(ctx) {
  const now = Date.now()
  // ctx 引用相同才算命中缓存，避免不同上下文之间串味。
  if (cache !== null && cache.ctx === ctx && now - cache.at < CACHE_TTL_MS) return cache.value

  // FIX-12：冻结后再缓存并返回，命中缓存的调用方拿到的是同一份只读对象。
  const value = freezeTargets(await buildTargets(ctx))
  cache = { at: Date.now(), ctx, value }
  return value
}
