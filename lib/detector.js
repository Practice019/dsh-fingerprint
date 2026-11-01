/**
 * lib/detector.js —— `lmfpd-sdk` 封装层（唯一所有者：W2）
 * =============================================================================
 * 职责：把「加载参考库 + 取参考库元数据 + 取评分器」收敛成一个进程内单例。
 *
 * 三条硬性设计约束（来自契约 §4.1）：
 *   1) 单例 + 懒加载 + 并发去重：多个调用同时进来只允许触发一次 `loadDetector()`。
 *      官方文档明确说「加载要解析约 4.5 MB 的检测参数，比一次评分慢得多」，所以绝不允许每次调用重新加载。
 *   2) 所有失败必须被捕获，转成 `detectorStatus().error` 的可读字符串，
 *      **不得让异常穿透到 HTTP handler**（所以我这里的公开函数都不抛）。
 *   3) 失败后必须能重试：绝不把 rejected 的 promise 永久缓存。
 *
 * 关于 `bankModelCount` / `getBankModels()` 的实现说明（重要）：
 *   `lmfpd-sdk@0.2.0` 的 `Detector` 只公开 `builtAt` / `analyze` / `detect`，
 *   参考库的模型表存在真正的私有字段 `#data`（运行时不可访问），**没有公开访问器**。
 *   但 SDK 的磁盘缓存文件格式是稳定的：
 *       [4 字节 uint32 LE 长度][bundle.json 原文][zstd 压缩的 detector]
 *   而 `bundle.json` 里就带着模型表：
 *       { built_at, models: [{ id, display_name, family, family_name, response_count }], ... }
 *   所以本模块在加载成功后**直接读缓存文件的包头**拿模型表 —— 零额外网络请求、
 *   数据全部来自 SDK 自己写的文件，不做任何编造。读不到就返回 null / []。
 *
 * 代理提示：Node 下要让 `lmfpd` 的数据下载遵循 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，
 *   必须把环境变量 `NODE_USE_ENV_PROXY=1` 设上，否则 SDK 的 fetch 不走代理。
 *   （Bun 不需要这个开关。）
 *
 * 调用约定（给 W1 / W3）：
 *   - 先 `await getDetector()`（或 `warmup()`）；`detector` 为 null 表示加载失败，
 *     可读原因在 `detectorStatus().error` 与返回值的 `error` 字段里。**调用方必须先判空**。
 *   - `analyze()` 是**同步**函数（与 SDK 的 `Detector#analyze` 同签名），
 *     它用的是已加载的单例，所以**理想情况下**要在 `getDetector()` 之后调用。
 *
 * 导入期预热（重要，为兼容 W3 的现有调用形态）：
 *   W3 的 `lib/probe.js` 在 `ensureDetector()` 里只做 `await import('./detector.js')`，
 *   然后绑定 `parseNumbers / generateChallenges / analyze` 三个导出 —— 它**不调用**
 *   `getDetector()`。而 `analyze()` 是同步的，必须有已加载的单例，否则会抛错。
 *   为了让「导入 → 若干秒的模型请求 → 同步 analyze()」这条真实链路能直接工作，
 *   本模块在**导入时后台预热一次**（不阻塞导入、不抛错、失败仍可被后续调用重试）。
 *   真实链路里 3 个模型请求要跑好几秒，而热缓存加载只要几十毫秒，所以窗口足够。
 *
 *   设环境变量 `DSH_FINGERPRINT_NO_PREWARM=1` 可关闭预热（给需要确定性「未加载」态的测试用）。
 *   推荐的确定性写法仍然是：调用方自己 `await getDetector()`。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  loadDetector,
  generateChallenges as sdkGenerateChallenges,
  parseNumbers as sdkParseNumbers,
} from 'lmfpd-sdk'

/** 覆盖缓存文件路径的环境变量名。 */
const ENV_CACHE_PATH = 'DSH_FINGERPRINT_LMFPD_CACHE'

/** 设为 `1` 时关闭导入期预热（仅供需要确定性「未加载」态的测试使用）。 */
const ENV_NO_PREWARM = 'DSH_FINGERPRINT_NO_PREWARM'

/**
 * 复刻 `lmfpd-sdk` 内部的 `cacheRoot()` 算法，保证默认缓存路径与 SDK 自己算出来的完全一致：
 *   XDG_CACHE_HOME 优先；macOS 用 ~/Library/Caches；Windows 用 %LOCALAPPDATA%；
 *   其余平台用 ~/.cache。再拼上 `lmfpd/data.bin`。
 */
function defaultCachePath() {
  const home = homedir()
  const xdg = process.env.XDG_CACHE_HOME
  const root =
    typeof xdg === 'string' && xdg.length > 0
      ? xdg
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : process.platform === 'win32'
          ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
          : path.join(home, '.cache')
  return path.join(root, 'lmfpd', 'data.bin')
}

/**
 * 解析**本次调用生效**的缓存路径。
 * 注意：这是按调用求值的，所以测试可以在同一个模块实例上换路径再重试；
 * 导出常量 `CACHE_PATH` 则是导入那一刻的快照（正常运行中两者相同）。
 */
function resolveCachePath() {
  const override = process.env[ENV_CACHE_PATH]
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override.trim())
  }
  return defaultCachePath()
}

/**
 * 默认缓存文件路径（导入时求值）。
 * Windows 上即 `%LOCALAPPDATA%\lmfpd\data.bin`。
 */
export const CACHE_PATH = resolveCachePath()

/** 进程内单例状态。`detector` 为 null 即未就绪。 */
const state = {
  detector: null,
  builtAt: null,
  bankModelCount: null,
  bankModels: [],
  error: null,
  loadedCachePath: null,
}

/** 进行中的加载（并发去重用）。 */
let inflight = null
let inflightKey = null

/** 把任意异常整理成一行可读字符串。 */
function readableError(error) {
  let raw
  if (error instanceof Error) {
    raw = error.message === '' ? error.name : error.message
    const cause = error.cause
    if (cause instanceof Error && cause.message !== '' && !raw.includes(cause.message)) {
      raw = `${raw}（原因：${cause.message}）`
    }
  } else {
    raw = String(error)
  }
  return `lmfpd 参考数据加载失败：${raw}`
}

/**
 * 读缓存文件包头里的 `bundle.json`。
 * 文件布局由 SDK 的 `writeCache()` 决定：[u32le 长度][bundle.json][detector]。
 * 任何异常都吞掉并返回 null —— 这只是「锦上添花」的元数据，不该影响主流程。
 */
async function readBankFromCache(cachePath) {
  try {
    const bytes = await readFile(cachePath)
    if (bytes.length <= 4) return null
    const length = bytes.readUInt32LE(0)
    if (!Number.isSafeInteger(length) || length <= 0 || 4 + length > bytes.length) return null
    const bundle = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))
    if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.models)) return null
    return bundle
  } catch {
    return null
  }
}

/** 把 `bundle.models` 归一化成契约要求的 `{id, displayName, family, familyName}[]`。 */
function normalizeBankModels(bundle) {
  if (bundle === null) return []
  return bundle.models
    .filter(
      (model) =>
        model !== null &&
        typeof model === 'object' &&
        typeof model.id === 'string' &&
        model.id.length > 0,
    )
    .map((model) => ({
      id: model.id,
      // 取不到 display_name 就退回 id，绝不留空、绝不编造。
      displayName:
        typeof model.display_name === 'string' && model.display_name.length > 0
          ? model.display_name
          : model.id,
      family: typeof model.family === 'string' ? model.family : '',
      familyName: typeof model.family_name === 'string' ? model.family_name : '',
    }))
}

/** 返回给调用方的快照（detector 可能是 null，调用方必须判空）。 */
function snapshot() {
  return {
    detector: state.detector,
    builtAt: state.builtAt,
    bankModelCount: state.bankModelCount,
    error: state.error,
  }
}

/**
 * 真正执行一次加载。**这个函数不会抛**：所有异常都被转成 `state.error`。
 * @param {{force: boolean, source: string|undefined}} request
 */
async function loadOnce(request) {
  const cachePath = resolveCachePath()
  const options = { cache: cachePath }
  // `source` 只是给测试/离线场景留的注入口；常规调用不传，走 SDK 的默认数据源。
  if (request.source !== undefined) options.source = request.source
  // `force` 让 SDK 的缓存 ttl 检查不影响我们：我们只在内存里丢弃单例，不删磁盘缓存。
  try {
    const detector = await loadDetector(options)
    const bundle = await readBankFromCache(cachePath)

    state.detector = detector
    state.builtAt =
      typeof detector?.builtAt === 'string' && detector.builtAt.length > 0
        ? detector.builtAt
        : typeof bundle?.built_at === 'string' && bundle.built_at.length > 0
          ? bundle.built_at
          : null
    state.bankModels = normalizeBankModels(bundle)
    state.bankModelCount = bundle === null ? null : state.bankModels.length
    state.error = null
    state.loadedCachePath = cachePath
    return snapshot()
  } catch (error) {
    state.detector = null
    state.builtAt = null
    state.bankModels = []
    state.bankModelCount = null
    state.error = readableError(error)
    state.loadedCachePath = cachePath
    return snapshot()
  }
}

/**
 * 取单例检测器（懒加载）。
 *
 * - 已就绪且非 force 且未指定 source → 直接返回缓存快照，零 I/O。
 * - 同一时刻的多个调用共用同一个 in-flight promise（并发去重）。
 * - 失败**不抛**：返回 `{detector: null, builtAt: null, bankModelCount: null, error: "<可读原因>"}`，
 *   并且 `detectorStatus().error` 同步有值。下一次调用会重新尝试加载。
 *
 * @param {{force?: boolean, source?: string}} [options]
 *   `force`  为 true 时丢弃单例重新加载一次。
 *   `source` 仅供测试/离线：单个非 http(s) 字符串会被 SDK 当作本地参考库目录。
 * @returns {Promise<{detector: object|null, builtAt: string|null, bankModelCount: number|null, error: string|null}>}
 */
export async function getDetector(options = {}) {
  const force = options.force === true
  const source = options.source === undefined ? undefined : String(options.source)
  const isDefaultLoad = !force && source === undefined
  const key = `${force ? 'F' : 'N'}|${source === undefined ? '*' : source}`

  // 1) 单例命中
  if (isDefaultLoad && state.detector !== null) return snapshot()

  // 2) 并发去重：同 key，或任意一个进行中的「默认加载」都能被默认调用复用
  if (inflight !== null && (inflightKey === key || (isDefaultLoad && inflightKey === 'N|*'))) {
    return inflight
  }

  // 3) 发起新加载；loadOnce 永不 reject，所以这里不会缓存「被拒绝的 promise」
  const started = loadOnce({ force, source })
  let tracked
  tracked = started.finally(() => {
    if (inflight === tracked) {
      inflight = null
      inflightKey = null
    }
  })
  inflight = tracked
  inflightKey = key
  return tracked
}

/**
 * 同步返回当前状态。**不做任何 I/O**，所以可以随便调。
 * `cachePath` 报的是「本次加载实际用的路径」；从未加载过时给出生效路径。
 * @returns {{ready: boolean, builtAt: string|null, bankModelCount: number|null, cachePath: string, error: string|null}}
 */
export function detectorStatus() {
  return {
    ready: state.detector !== null,
    builtAt: state.builtAt,
    bankModelCount: state.bankModelCount,
    cachePath: state.loadedCachePath ?? resolveCachePath(),
    error: state.error,
  }
}

/**
 * 取参考库里的候选模型表。
 * 未加载时先触发一次懒加载；加载失败或缓存读不到时返回 `[]`（绝不抛）。
 * @returns {Promise<Array<{id: string, displayName: string, family: string, familyName: string}>>}
 */
export async function getBankModels() {
  if (state.bankModels.length === 0) {
    const result = await getDetector()
    // 失败时 result.detector 为 null，state.bankModels 仍是 []，直接返回空表。
    if (result.detector === null) return []
  }
  // 返回浅拷贝，避免调用方改到模块内部状态
  return state.bankModels.map((model) => ({ ...model }))
}

/**
 * 预热：显式触发一次加载，供 `/fingerprint/detector/refresh` 之类的入口使用。
 * @returns {Promise<{builtAt: string|null, bankModelCount: number|null, error: string|null}>}
 */
export async function warmup() {
  const result = await getDetector()
  return {
    builtAt: result.builtAt,
    bankModelCount: result.bankModelCount,
    error: result.error,
  }
}

/** 直接 re-export SDK 的挑战生成器（每道挑战随机语言，`expected_count` 在 292–332 且互不相同）。 */
export const generateChallenges = sdkGenerateChallenges

/** 直接 re-export SDK 的整数解析器（返回回答里最长的一段 1–355 整数段）。 */
export const parseNumbers = sdkParseNumbers

/**
 * 用**已加载的单例**给回答评分。
 *
 * 说明：`lmfpd-sdk` 本身没有顶层 `analyze` 导出（它是 `Detector` 的实例方法），
 * 契约 §4.1 要求本模块导出一个 `analyze`，所以这里做成同步包装：
 * 与 SDK 的 `Detector#analyze(outputs, {strict})` 同签名、同返回值。
 * 因此**必须先 `await getDetector()` / `warmup()`**。`await` 一个同步返回值也是合法的，
 * 所以调用方写 `await analyze(...)` 同样能工作。
 *
 * @param {Array<{text: string, expected_count: number}>} outputs 一到三条回答
 * @param {{strict?: boolean}} [options]
 * @returns {object} SDK 的 `Analysis`
 */
export function analyze(outputs, options = {}) {
  if (state.detector === null) {
    throw new Error(
      'lmfpd 检测器尚未加载：请先 await getDetector() 或 warmup()，成功后再调用 analyze()。' +
        (state.error === null ? '' : `上次加载失败：${state.error}`),
    )
  }
  return state.detector.analyze(outputs, options)
}

// ─────────────────────────────────────────────────────────────────────────────
// 导入期预热（内部行为，不新增导出）
// ─────────────────────────────────────────────────────────────────────────────
// 见文件头「导入期预热」一节：W3 的 probe.js 只 await import 本模块，不调用
// getDetector()，而 analyze() 是同步的。这里后台预热一次，让那条真实链路能工作。
// getDetector() 本身不 reject，`.catch` 只是双保险；预热失败不影响任何导出。
if (process.env[ENV_NO_PREWARM] !== '1') {
  void getDetector().catch(() => {})
}
