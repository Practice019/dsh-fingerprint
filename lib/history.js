/**
 * lib/history.js —— 检测历史存储（契约 §29，负责人 W5）
 *
 * 把每次 run 进终态时每个目标的检测结果落盘成 JSONL，供页面浏览
 * 「哪些模型被检查过、结果如何」。
 *
 * 硬约束（§29.4）：
 *   1. **纯 Node，零 DSH 依赖** —— 不 import 任何 `lib/` 内的东西、不碰 `ctx`，可对临时目录单测。
 *   2. **永不抛** —— 目录不可写、文件损坏、权限、磁盘满一律转成返回体里的可读 `error` 字段，
 *      函数本身不 reject。（`readHistory` / `aggregateByModel` 返回数组、`clearHistory` 返回数字，
 *      这三个的失败一律退化为空值，原因由 `historyStats().error` 统一暴露。）
 *   3. 写入原子 —— 追加走单次 `appendFile`；裁剪走「写临时文件 → rename」；
 *      且所有写操作经**进程内串行队列**（§31.3），避免 append 与 clear 的 rename 竞态。
 *   4. 读不到 / 文件不存在 → 返回空列表，**不是错误**（首次运行就是这种状态）；
 *      但「父级是文件」这类坏路径会被**定向检测**出来并报 error
 *      （Windows 上它与 ENOENT 不可区分，见 `diagnoseMissingFile`）。
 *   5. 损坏行跳过 —— 单行解析失败只跳过该行并在 stats 里报 `skippedLines`，不整文件报废。
 *   6. **明确不记** API key、`samples[].rawText` 全文、`challenges` 全文（那是 `/export` 的职责）。
 *      ⇒ 用**白名单**式 `sanitizeRecord()` 强制只保留 §29.3 的字段，多余键一律丢弃。
 *
 * ⚠️ 路径解析：`HISTORY_PATH` 是**模块加载时**冻结的常量（供文档/参考）；
 * 所有函数内部每次调用都重新走 `resolveHistoryPath()` 读 `process.env.DSH_FINGERPRINT_HISTORY`，
 * 因此运行期改环境变量可切换目标文件（单测正是靠这一点指到临时目录）。
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 滚动上限：超过就只保留最新这么多条（§29.2）。 */
const MAX_RECORDS = 500

/** 体积上限：超过就裁剪（§29.2）。 */
const MAX_BYTES = 1024 * 1024

/** 记录版本号（§29.3）。 */
const RECORD_VERSION = 1

// ── 路径 ────────────────────────────────────────────────────────────────────

/**
 * 解析当前生效的历史文件路径：`DSH_FINGERPRINT_HISTORY` 优先，
 * 否则 `%LOCALAPPDATA%\dsh-fingerprint\history.jsonl`（非 Windows 回退到 `~/.local/share`）。
 */
function resolveHistoryPath() {
  const override = process.env.DSH_FINGERPRINT_HISTORY
  if (typeof override === 'string' && override.length > 0) return override
  const base =
    typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.length > 0
      ? process.env.LOCALAPPDATA
      : join(homedir(), '.local', 'share')
  return join(base, 'dsh-fingerprint', 'history.jsonl')
}

/** 契约 §29.4 的导出常量（模块加载时的取值；实际读写见上方说明）。 */
export const HISTORY_PATH = resolveHistoryPath()

// ── 基础工具（全部自带兜底，绝不抛）────────────────────────────────────────

/** 把任意抛错转成一行可读文本；本函数自身永不抛。 */
function text(error) {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
  } catch {
    return '[不可字符串化的错误对象]'
  }
}

/** 只接受非空字符串；其余归为 null。 */
function toNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 只接受有限数值；其余归为 null。 */
function toFiniteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 只接受非负整数；其余归为 null。 */
function toNonNegativeIntOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 只接受正整数；其余归为 null（`limit` 用）。 */
function toPositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 只保留 §29.3 的 options 四键。 */
function sanitizeOptions(value) {
  if (value === null || typeof value !== 'object') return null
  return {
    rounds: toNonNegativeIntOrNull(value.rounds),
    count: toNonNegativeIntOrNull(value.count),
    parallel: toNonNegativeIntOrNull(value.parallel),
    strict: value.strict === true,
  }
}

/**
 * 白名单式规范化：**只**保留 §29.3 的 17 个键，任何多余字段（rawText / challenges / apiKey…）
 * 一律被丢弃。`provider` / `model` 缺失视为不可用记录，返回 null。
 *
 * @param input 原始记录
 * @param {{fillTs: boolean}} options `fillTs=true`（写入路径）时缺失 `ts` 补当前时间；
 *        `false`（读取路径）时保持 null，避免给历史记录伪造时间戳。
 */
function sanitizeRecord(input, { fillTs }) {
  if (input === null || typeof input !== 'object') return null
  const provider = toNonEmptyString(input.provider)
  const model = toNonEmptyString(input.model)
  if (provider === null || model === null) return null

  return {
    v: RECORD_VERSION,
    ts: toNonEmptyString(input.ts) ?? (fillTs ? new Date().toISOString() : null),
    runId: toNonEmptyString(input.runId),
    provider,
    model,
    decision: toNonEmptyString(input.decision),
    prediction: toNonEmptyString(input.prediction),
    predictionName: toNonEmptyString(input.predictionName),
    family: toNonEmptyString(input.family),
    familyName: toNonEmptyString(input.familyName),
    probability: toFiniteOrNull(input.probability),
    agreement: toFiniteOrNull(input.agreement),
    stability: toNonEmptyString(input.stability),
    validRounds: toNonNegativeIntOrNull(input.validRounds),
    totalRounds: toNonNegativeIntOrNull(input.totalRounds),
    options: sanitizeOptions(input.options),
    error: toNonEmptyString(input.error),
  }
}

// ── 读取 ────────────────────────────────────────────────────────────────────

/**
 * 解析 JSONL 文本。
 * **空行合法**（不计入 `skippedLines`）；解析失败或字段不可用的行计入 `skippedLines` 后跳过。
 */
function parseJsonl(raw) {
  const records = []
  let skippedLines = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skippedLines += 1
      continue
    }
    const record = sanitizeRecord(parsed, { fillTs: false })
    if (record === null) {
      skippedLines += 1
      continue
    }
    records.push(record)
  }
  return { records, skippedLines }
}

/**
 * 区分「文件还没创建（正常）」与「路径根本不可用（坏路径）」。
 *
 * 为什么需要它（§31.3 第 2 条）：Windows 上父级是文件时 `CreateFileW` 报
 * `ERROR_PATH_NOT_FOUND`，Node 一律映射成 **ENOENT**，与「文件不存在」**不可区分**
 * ⇒ 坏路径会静默表现为「空历史」，用户以为功能坏了。所以拿到 ENOENT 后再 `stat`
 * 一次父目录来定向判定。
 *
 * @returns {Promise<string|null>} 坏路径原因；一切正常（含「父目录尚不存在」）返回 null
 */
async function diagnoseMissingFile(path) {
  const parent = dirname(path)
  try {
    const info = await stat(parent)
    // 父目录存在但不是目录（是文件）⇒ 该路径永远不可能可用
    if (!info.isDirectory()) return `历史文件的父路径不是目录：${parent}`
    return null // 父目录正常，只是文件还没创建 ⇒ 首次运行的正常状态
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    // 父目录尚未创建 ⇒ 首次写入会 mkdir 出来 ⇒ 仍属正常状态，不得报错
    if (code === 'ENOENT') return null
    return `历史文件所在目录不可用：${parent}（${text(error)}）`
  }
}

/**
 * 读入整个历史文件。文件不存在是**正常状态**（`error: null`）。
 * 记录顺序 = 文件顺序 = **旧 → 新**。
 */
async function loadAll() {
  const path = resolveHistoryPath()
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') {
      // 定向检测：ENOENT 也可能由「父级是文件」这类坏路径伪装而来。
      const problem = await diagnoseMissingFile(path)
      if (problem !== null) {
        return { path, records: [], skippedLines: 0, bytes: 0, error: `读取历史文件失败：${problem}` }
      }
      return { path, records: [], skippedLines: 0, bytes: 0, error: null }
    }
    return { path, records: [], skippedLines: 0, bytes: 0, error: `读取历史文件失败：${text(error)}` }
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  const { records, skippedLines } = parseJsonl(raw)
  return { path, records, skippedLines, bytes, error: null }
}

// ── 裁剪 ────────────────────────────────────────────────────────────────────

/**
 * 从「旧 → 新」的记录数组里选出要保留的部分：**从最新往旧**累加，
 * 同时受两个上限约束 —— 最多 `MAX_RECORDS` 条、总字节不超过 `MAX_BYTES`。
 *
 * 为什么不是单纯的 `slice(-500)`：§29.2 的裁剪触发条件是「条数 > 500 **或** 体积 > 1 MB」。
 * 若某次只有 300 条却已超过 1 MB（例如 model id 异常长），`slice(-500)` 会一条不删、
 * 体积永远超标。按字节回退取新才能让体积条件真正生效（至少保留 1 条，避免把文件清空）。
 *
 * @returns 保留的片段（仍按 旧 → 新 排列）
 */
function selectKept(records) {
  const kept = []
  let bytes = 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (kept.length >= MAX_RECORDS) break
    const size = Buffer.byteLength(JSON.stringify(records[index]), 'utf8') + 1 // +1 = 换行符
    if (kept.length > 0 && bytes + size > MAX_BYTES) break
    kept.push(records[index])
    bytes += size
  }
  kept.reverse()
  return kept
}

/** 原子裁剪：写临时文件 → rename 覆盖。 */
async function trimTo(records) {
  const kept = selectKept(records)
  const removed = records.length - kept.length
  if (removed <= 0) return { removed: 0, error: null }

  const path = resolveHistoryPath()
  const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, kept.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    await rename(temp, path)
    return { removed, error: null }
  } catch (error) {
    return { removed: 0, error: `裁剪历史失败：${text(error)}` }
  }
}

// ── 进程内串行队列（§31.3 第 1 条）─────────────────────────────────────────

/**
 * 模块级 promise 链：把所有**会写文件的操作**（`appendRecords`、`clearHistory`，
 * 以及 `appendRecords` 内部的裁剪）串行化。
 *
 * 为什么必须有：
 *   1. `clearHistory` 走「写临时文件 → rename」，与 append 的 O_APPEND 之间会竞态 ——
 *      UI 上点「清空历史」的同时一个 run 刚好结束，就可能把刚追加的记录丢掉。
 *   2. 多个 run 同时进终态时并发追加，大写入不保证原子。
 *
 * 纪律：**链上任何一环失败都不得污染后续调用**（`safe` 吞掉异常后继续），
 * 失败仍走各自返回体的 `error` 字段 / 回退值，**绝不 reject**。
 */
let writeChain = Promise.resolve()

/**
 * 把一次写操作排进串行队列。
 * @param {() => Promise<any>} task 实际操作
 * @param {() => any} fallback 任务意外抛出时的回退值（保证调用方永不 reject）
 */
function enqueue(task, fallback) {
  const safe = () => {
    try {
      return Promise.resolve(task()).catch(() => fallback())
    } catch {
      return Promise.resolve(fallback())
    }
  }
  // 前一环无论成功或失败都继续执行本环：then(safe, safe)
  const run = writeChain.then(safe, safe)
  // 链本身永远收敛为 resolved，避免一次失败卡死后续所有调用
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ── 对外接口（§29.4）────────────────────────────────────────────────────────

/**
 * 追加一批记录（原子写）。**经进程内串行队列**，与 `clearHistory` / 裁剪互斥。
 *
 * @param records 记录数组；不可用元素（缺 provider / model）被静默丢弃
 * @returns `{ ok, appended, total, trimmed, path, error }`
 *          `error` 非 null 时 `ok === false`，**函数不抛**
 */
export async function appendRecords(records) {
  return enqueue(
    () => appendRecordsInner(records),
    () => ({
      ok: false,
      appended: 0,
      total: 0,
      trimmed: 0,
      path: resolveHistoryPath(),
      error: '追加历史失败：队列任务未能执行',
    }),
  )
}

/** `appendRecords` 的实际实现（本身不带队列）。 */
async function appendRecordsInner(records) {
  const path = resolveHistoryPath()
  try {
    const list = Array.isArray(records) ? records : []
    const clean = []
    for (const item of list) {
      const record = sanitizeRecord(item, { fillTs: true })
      if (record !== null) clean.push(record)
    }
    if (clean.length === 0) {
      const current = await loadAll()
      return {
        ok: true,
        appended: 0,
        total: current.records.length,
        trimmed: 0,
        path,
        error: current.error,
      }
    }

    await mkdir(dirname(path), { recursive: true })
    // 单次 appendFile：追加语义由 O_APPEND 保证，一行一条不会被拆成半行。
    await appendFile(path, clean.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')

    // 追加之后再判断是否需要裁剪（条数上限 / 体积上限）
    let after = await loadAll()
    let trimmed = 0
    if (after.error === null && (after.records.length > MAX_RECORDS || after.bytes > MAX_BYTES)) {
      const result = await trimTo(after.records)
      if (result.error !== null) {
        return { ok: false, appended: clean.length, total: after.records.length, trimmed: 0, path, error: result.error }
      }
      trimmed = result.removed
      after = await loadAll()
    }

    return {
      ok: after.error === null,
      appended: clean.length,
      total: after.records.length,
      trimmed,
      path,
      error: after.error,
    }
  } catch (error) {
    return { ok: false, appended: 0, total: 0, trimmed: 0, path, error: `追加历史失败：${text(error)}` }
  }
}

/**
 * 读取历史记录，**最新在前**。
 *
 * @param {{limit?: number, provider?: string, model?: string}} [options]
 * @returns 记录数组；任何失败退化为 `[]`（原因见 `historyStats().error`）
 */
export async function readHistory(options) {
  const loaded = await loadAll()
  if (loaded.error !== null) return []

  const provider = toNonEmptyString(options?.provider)
  const model = toNonEmptyString(options?.model)
  const limit = toPositiveInt(options?.limit)

  let records = loaded.records
  if (provider !== null) records = records.filter((record) => record.provider === provider)
  if (model !== null) records = records.filter((record) => record.model === model)

  // 文件是 旧 → 新；接口要求最新在前。
  records = records.slice().reverse()
  if (limit !== null) records = records.slice(0, limit)
  return records
}

/**
 * 清空历史。**经进程内串行队列**，与 `appendRecords` 互斥
 * （否则「写临时文件 → rename」会与 append 的 O_APPEND 竞态丢数据）。
 * @returns 被移除的**有效记录条数**（失败或文件本就不存在时为 `0`；函数不抛）
 */
export async function clearHistory() {
  return enqueue(
    () => clearHistoryInner(),
    () => 0,
  )
}

/** `clearHistory` 的实际实现（本身不带队列）。 */
async function clearHistoryInner() {
  try {
    const path = resolveHistoryPath()
    const loaded = await loadAll()
    if (loaded.error !== null) return 0

    const removed = loaded.records.length
    const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, '', 'utf8')
    await rename(temp, path)
    return removed
  } catch {
    return 0
  }
}

/**
 * 历史文件概况。
 * @returns `{ count, path, oldest, newest, skippedLines, error }`
 *          - `oldest` / `newest`：`ts` 的最小 / 最大值（无记录时 null）
 *          - `skippedLines`：跳过的损坏行数（空行不计）
 *          - `error`：读取失败原因；**这是判断"读不到了"的唯一入口**
 */
export async function historyStats() {
  const loaded = await loadAll()
  let oldest = null
  let newest = null
  for (const record of loaded.records) {
    const ts = record.ts
    if (typeof ts !== 'string') continue
    if (oldest === null || ts < oldest) oldest = ts
    if (newest === null || ts > newest) newest = ts
  }
  return {
    count: loaded.records.length,
    path: loaded.path,
    oldest,
    newest,
    skippedLines: loaded.skippedLines,
    error: loaded.error,
  }
}

/** ISO 字符串比较；`null` 视为最早。 */
function isLater(candidate, current) {
  if (typeof candidate !== 'string') return false
  if (typeof current !== 'string') return true
  return candidate > current
}

/**
 * 按 `(provider, model)` 聚合。
 *
 * @returns `[{ provider, model, lastTs, runs, lastDecision, lastPrediction, lastProbability, lastStability }]`
 *          按 `lastTs` 降序（`null` 排在最后），**任何失败退化为 `[]`**
 */
export async function aggregateByModel() {
  const loaded = await loadAll()
  if (loaded.error !== null) return []

  const byModel = new Map()
  // 文件顺序是 旧 → 新；逐条覆盖 last*，遇上更晚的 ts 才更新，天然得到「最近一条」。
  for (const record of loaded.records) {
    const key = `${record.provider}\u0000${record.model}`
    const existing = byModel.get(key)
    if (existing === undefined) {
      byModel.set(key, {
        provider: record.provider,
        model: record.model,
        lastTs: record.ts,
        runs: 1,
        lastDecision: record.decision,
        lastPrediction: record.prediction,
        lastProbability: record.probability,
        lastStability: record.stability,
      })
      continue
    }
    existing.runs += 1
    if (isLater(record.ts, existing.lastTs)) {
      existing.lastTs = record.ts
      existing.lastDecision = record.decision
      existing.lastPrediction = record.prediction
      existing.lastProbability = record.probability
      existing.lastStability = record.stability
    }
  }

  const rows = [...byModel.values()]
  rows.sort((left, right) => {
    if (left.lastTs !== right.lastTs) {
      if (typeof left.lastTs !== 'string') return 1
      if (typeof right.lastTs !== 'string') return -1
      return left.lastTs < right.lastTs ? 1 : -1 // 降序
    }
    // 确定性兜底：provider 再 model 字典序
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1
    if (left.model !== right.model) return left.model < right.model ? -1 : 1
    return 0
  })
  return rows
}
