/**
 * dsh-fingerprint 宿主侧入口。
 *
 * 组成：
 * 1. 契约 §5 的 HTTP 层（前缀 `/fingerprint`，8 条路由，webServer 直注册）。
 * 2. W1 遗留的只读自检 + `.smoke.json` 诊断落盘（已降级为旁路，不再阻断任何流程）。
 *
 * 关键契约：
 * - §2.4 / §2.7 / §12.2：`inject = ['llm','settings']`；传输层必须用
 *   `ctx.inject(['webServer'], host => host.effect(() => host.webServer.register({kind:'prefix', path, handler})))`。
 * - §12.3：裸 registry 不继承 Connection 认证 ⇒ 自带访问控制（见 `authorize`）。
 * - §11.2：`getDetector()` 失败返回 `detector: null` 且不抛 ⇒ 所有路由先判空。
 * - §12.4：目标枚举归 W5（`./targets.js`），本文件只调用、不实现。
 * - §12.8：运行快照与 export 体形状已冻结。
 * - §9.6 / §12.B：聚合走 `./aggregate.js`，取样走 `./probe.js`，模型调用走 `./send.js`。
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CACHE_PATH, detectorStatus, getDetector } from './detector.js';
import { runRound } from './probe.js';
import { aggregateRounds } from './aggregate.js';
import { finishObservations, sendViaLlm } from './send.js';
// 目标枚举归 W5（契约 §12.4 冻结接口；本文件只调用，不实现）
import { invalidateTargets, listTargets } from './targets.js';
// 检测历史归 W5（契约 §29.4 冻结接口；本文件只调用，不改它）
import { aggregateByModel, appendRecords, clearHistory, historyStats, readHistory } from './history.js';
// §55.5 A 的侧车三件套由 W5 新增（writeActiveRun / readActiveRun / clearActiveRun）。
// ⚠️ 用具名 import 会在**链接期**对不存在的导出报 SyntaxError ⇒ 整个插件加载失败。
// 这里故意改用命名空间 import + 运行时存在性检查：W5 尚未落盘时只降级成"侧车功能不可用"，
// 插件其余功能（检测、历史、状态）照常工作。
import * as historySidecar from './history.js';

export const name = 'fingerprint';
export const inject = ['llm', 'settings'];

/** 契约 §1：HTTP 前缀。 */
const PREFIX = '/fingerprint';

/** 保留的历史运行快照上限。 */
const MAX_KEPT_RUNS = 5;

/** 契约 §12.3：请求体上限。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 契约 §1（FIX-7 + §28.2）：**跨 (目标 × 轮次)** 的并发上限，即「同时在跑的轮次数」（1–3）。 */
export const MAX_PARALLEL = 3;

/** 契约 §5：SSE 推送间隔。 */
const SSE_HEARTBEAT_MS = 500;

/** 开发期诊断产物路径（主脑一次性授权；仅此一个文件）。 */
const SMOKE_PATH = fileURLToPath(new URL('../.smoke.json', import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────────────────────

/** 把任意抛错转成一行可读文本。 */
function text(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 契约 §5：请求级统一失败体（HTTP 200）。
 *
 * §28.3（P2）：`extra` 允许附带结构化字段（当前用于 `BUSY` 的 `runId`），
 * 但 `code` / `message` 永远由本函数决定 —— `extra` 覆盖不了它们。
 */
export function failure(code, message, extra) {
  return { ok: false, error: { ...(extra === undefined ? {} : extra), code, message } };
}

/** 写 JSON 响应。 */
function sendJson(response, body, status = 200) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/** 取请求头（大小写不敏感，Node 已规范化）。 */
function headerOf(request, name) {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : '';
}

/** 回环地址判定。 */
export function isLoopbackAddress(address) {
  let value = String(address ?? '').trim().toLowerCase();
  if (value === '') return false;
  if (value === '::1') return true;
  // Node 在双栈监听下把 IPv4 客户端报成 ::ffff:a.b.c.d ⇒ 剥掉前缀再判。
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  for (const part of octets) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return false;
  }
  return Number(octets[0]) === 127;
}

/** Host 头 / Origin 的 host 是否指向本机回环（`127/8` / `localhost` / `::1`）。 */
export function isLoopbackHost(host) {
  if (host === '') return false;
  let hostname = host;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const value = hostname.toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  return isLoopbackAddress(value);
}

/** 端口归一化：URL 省略默认端口时补回，便于两侧比较（FIX-3）。 */
function portOf(target, scheme) {
  if (target.port !== '') return target.port;
  return scheme === 'https:' ? '443' : '80';
}

/**
 * 契约 §12.3 的访问控制（参照 dsh-purge-community 的 `allowPluginRequest`，并加严三项）。
 *
 * 判据（全部通过才放行）：
 * 1. 方法白名单：只允许 GET / POST（其它 405）。
 * 2. `request.socket.remoteAddress` 必须是回环地址（`127/8` / `::1` / `::ffff:127/8`）。
 * 3. `Host` 头必须指向回环（端口不限）。
 * 4. `sec-fetch-site: cross-site` ⇒ 拒绝（浏览器发起的跨站请求）。
 * 5. `Origin` / `Referer` 若存在：`null` 拒绝；host 必须是回环，且**端口必须与 Host 一致**
 *    （FIX-3：只放宽 hostname 等价 `localhost ↔ 127.0.0.1`，端口不放宽）。
 *
 * 残余风险（诚实声明）：以上全部是**请求头判据**，挡不住本机任意进程——
 * 任何能自己发 HTTP 的程序都能伪造 `Host` / 不发送 `Origin`。真正的进程级隔离需要
 * DSH Connection 层的认证（本 registry 不继承），或用户侧防火墙策略。本层的目标是
 * 阻断**浏览器页面/第三方站点**对 `/fingerprint/run` 的驱动（CSRF / DNS-rebinding 面）。
 *
 * @returns {true|{status:number, body:object}} true 表示放行
 */
export function authorize(request) {
  const method = (request.method ?? '').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return { status: 405, body: failure('METHOD_NOT_ALLOWED', `不允许的方法：${method}`) };
  }
  if (!isLoopbackAddress(request.socket?.remoteAddress ?? '')) {
    return { status: 403, body: failure('FORBIDDEN', '仅允许本机回环地址访问') };
  }
  const host = headerOf(request, 'host').trim();
  if (!isLoopbackHost(host)) {
    return { status: 403, body: failure('FORBIDDEN', `Host 头必须指向本机回环：${host || '(缺失)'}`) };
  }
  if (headerOf(request, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    return { status: 403, body: failure('FORBIDDEN', '拒绝跨站请求（sec-fetch-site: cross-site）') };
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return { status: 403, body: failure('FORBIDDEN', `Host 头不可解析：${host}`) };
  }
  for (const header of ['origin', 'referer']) {
    const raw = headerOf(request, header).trim();
    if (raw === '') continue;
    if (raw === 'null') {
      return { status: 403, body: failure('FORBIDDEN', `${header} 为 null，拒绝`) };
    }
    let source;
    try {
      source = new URL(raw);
    } catch {
      return { status: 403, body: failure('FORBIDDEN', `${header} 不可解析：${raw}`) };
    }
    if (!isLoopbackHost(source.host)) {
      return { status: 403, body: failure('FORBIDDEN', `${header} 必须指向本机回环：${source.host}`) };
    }
    // FIX-3：hostname 允许等价（localhost ↔ 127.0.0.1，否则会误拒用 localhost 打开 GUI 的用户），
    // 但**端口必须一致** —— 否则本机任意端口的页面都能驱动 /run（替用户花钱）。
    if (portOf(source, source.protocol) !== portOf(hostUrl, hostUrl.protocol)) {
      return {
        status: 403,
        body: failure(
          'FORBIDDEN',
          `${header} 端口与 Host 不一致：${portOf(source, source.protocol)} ≠ ${portOf(hostUrl, hostUrl.protocol)}`,
        ),
      };
    }
  }
  return true;
}

/** 请求体超限的专用错误码（FIX-2）：handler 据此回 §5 失败体，而不是直接掐断连接。 */
export const BODY_TOO_LARGE = 'BODY_TOO_LARGE';

/** 造一个带码的超限错误。 */
function bodyTooLargeError() {
  const error = new Error(`请求体超过上限 ${String(MAX_BODY_BYTES)} 字节`);
  error.code = BODY_TOO_LARGE;
  return error;
}

/**
 * 读并解析 JSON 请求体；超限或非法 JSON 抛可读错误。
 *
 * FIX-2：超限时**不再 `request.destroy()`**（那会让客户端拿到零响应体，实测 `code=000`，
 * 违反 §5 的统一失败体要求）。改为立即 reject 并**停止累积**，把响应交给 handler；
 * handler 回完失败体后再断开剩余请求流。
 */
export function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (settled) return; // 已判超限：丢弃后续数据，等 handler 回包
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(bodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${text(error)}`));
      }
    });
  });
}

/** 可被取消的 sleep。 */
export function sleep(ms, signal) {
  // FIX-5：进函数先看是否已经取消；否则取消后仍要等满 gapSec（≤120s）。
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 目标路由的内部 key。 */
function targetKey(target) {
  return `${target.provider}\u0000${target.model}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行管理
// ─────────────────────────────────────────────────────────────────────────────

/** runId → run；`activeRunId` 非空即 BUSY（契约 §5）。 */
const runs = new Map();
let activeRunId = null;
let runSequence = 0;

/** 契约 §12.8：运行快照（`error` 是 run 级人类可读字符串，不是请求级失败体）。 */
function snapshot(run) {
  return {
    ok: true,
    runId: run.runId,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    options: {
      rounds: run.options.rounds,
      count: run.options.count,
      parallel: run.options.parallel,
      strict: run.options.strict,
      timeoutSec: run.options.timeoutSec,
      gapSec: run.options.gapSec,
    },
    error: run.error,
    tasks: run.tasks.map((task) => ({ ...task })),
    results: run.results.map((result) => ({ ...result })),
  };
}

/** 契约 §12.8：export 体（`targets[]` 是权威形状）。 */
function exportBody(run) {
  return {
    ok: true,
    runId: run.runId,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    options: snapshot(run).options,
    targets: run.targets.map((target) => ({
      provider: target.provider,
      model: target.model,
      rounds: run.rounds.get(targetKey(target)) ?? [],
      aggregate: run.results.find(
        (result) => result.provider === target.provider && result.model === target.model,
      )?.aggregate ?? null,
    })),
    ...(run.error === null ? {} : { error: run.error }),
  };
}

/** 通知 SSE 订阅者；单个订阅者异常不影响其它订阅者。 */
function notify(run) {
  if (run.subscribers.size === 0) return;
  const payload = JSON.stringify(snapshot(run));
  // FIX-8：直迭代 Set 时，订阅者在回调里退订会改变迭代中的集合；统一走副本。
  for (const push of [...run.subscribers]) {
    try {
      push(payload);
    } catch {
      // 忽略
    }
  }
}

/** (target, round) → task 的索引键（FIX-1）。 */
function taskKeyFor(target, round) {
  return `${targetKey(target)}\u0000${String(round)}`;
}

/**
 * 把一次运行展平成 **(目标 × 轮次)** 的并发任务项（§28.2 P1 裁决）。
 *
 * 旧实现以 `target` 为队列单位，`workerCount = min(parallel, targets.length)`，
 * 于是「1 个模型 × 3 轮」只有 1 个 worker，3 轮被**串行**跑完。
 * 现在队列单位就是「一轮」，`parallel` 表示「同时在跑的轮次数」（1–3）。
 *
 * @param {{targets:Array<{provider:string,model:string}>, options:{rounds:number}, taskIndex:Map<string,object>}} run
 * @returns {Array<{target:object, round:number, task:object}>} 按目标、再按轮次升序
 */
export function buildRunItems(run) {
  const items = [];
  for (const target of run.targets) {
    for (let round = 1; round <= run.options.rounds; round += 1) {
      const task = run.taskIndex.get(taskKeyFor(target, round));
      if (task === undefined) continue;
      items.push({ target, round, task });
    }
  }
  return items;
}

/**
 * 固定并发的任务池（§28.2 的并发语义载体，独立出来便于离线断言）。
 *
 * @param {Array<unknown>} items 待执行项（按顺序派发）
 * @param {number} workerCount 并发上限（实际 worker 数 = min(workerCount, items.length)）
 * @param {(item:unknown)=>Promise<void>} worker 单项执行体
 * @param {()=>boolean} [shouldStop] 每次取项前询问是否停止（取消）
 * @returns {Promise<{started:number, peak:number}>} 已派发项数与该次运行的**峰值并发**
 */
export async function runPool(items, workerCount, worker, shouldStop = () => false) {
  const queue = items.slice();
  const limit = Math.max(1, Math.min(workerCount, queue.length));
  let concurrent = 0;
  let peak = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const item = queue.shift();
      if (item === undefined) return;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      try {
        await worker(item);
      } finally {
        concurrent -= 1;
      }
    }
  });
  await Promise.all(workers);
  return { started: items.length, peak };
}

// ─────────────────────────────────────────────────────────────────────────────
// 检测历史（§29.2 终态落盘 / §29.3 记录形状）
// ─────────────────────────────────────────────────────────────────────────────

/** 契约 §29.3 的 18 个键（原 17 + §61 的 `probabilityStatus`；**追加在最后**，既有 17 键顺序不变）。 */
export const HISTORY_RECORD_KEYS = [
  'v', 'ts', 'runId', 'provider', 'model', 'decision', 'prediction', 'predictionName',
  'family', 'familyName', 'probability', 'agreement', 'stability', 'validRounds',
  'totalRounds', 'options', 'error', 'probabilityStatus',
];

/** §61.4 B：`probabilityStatus` 的唯一合法取值（其余归 null）。与 `lib/history.js` 的枚举保持一致。 */
export const PROBABILITY_STATUS_VALUES = ['reference_calibrated', 'unavailable'];

/** 非空字符串，否则 null。 */
function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** §61：只接受三个合法值；其余归 null（不透传任意字符串）。 */
function probabilityStatusOrNull(value) {
  return typeof value === 'string' && PROBABILITY_STATUS_VALUES.includes(value) ? value : null;
}

/** 有限数字，否则 null。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 整数，否则取兜底值。 */
function intOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * 由 run 构造历史记录数组（**纯函数**，可离线测）—— §29.2：一条记录 = 一个 `(run, target)`。
 *
 * - 以 `run.targets` 为准（不是 `run.results`），这样**取消 / 失败**的 run 也每个目标一条记录
 * - `aggregate` 为 null（取消 / 失败 / 聚合未产出）时**取安全默认且不抛**：
 *   `decision='unscorable'`、`stability='inconclusive'`、`validRounds=0`、`totalRounds=options.rounds`
 * - `aggregate` 的字段是 **camelCase**（§9.1 的 `predictionName` / `familyName` / `validRounds` …），
 *   直接映射即可；这里**不做** snake_case 兼容 —— 契约形状就是 camelCase
 * - `options` **只**含 `{rounds, count, parallel, strict}`（§29.3 的形状，不塞 timeoutSec/gapSec）
 *
 * @param {object} run 运行对象
 * @returns {Array<object>} 记录数组（可能为空；缺 provider/model 的目标被跳过，因为会被 history.js 丢弃）
 */
export function buildHistoryRecords(run) {
  const options = run?.options ?? {};
  const shapeOptions = {
    rounds: intOr(options.rounds, 0),
    count: intOr(options.count, 0),
    parallel: intOr(options.parallel, 0),
    strict: options.strict === true,
  };
  const ts =
    typeof run?.finishedAt === 'number' && Number.isFinite(run.finishedAt)
      ? new Date(run.finishedAt).toISOString()
      : new Date().toISOString();

  const results = new Map();
  for (const result of Array.isArray(run?.results) ? run.results : []) {
    if (result === null || typeof result !== 'object') continue;
    results.set(`${String(result.provider)}\u0000${String(result.model)}`, result);
  }

  const records = [];
  for (const target of Array.isArray(run?.targets) ? run.targets : []) {
    if (target === null || typeof target !== 'object') continue;
    const provider = stringOrNull(target.provider);
    const model = stringOrNull(target.model);
    if (provider === null || model === null) continue;
    const result = results.get(`${provider}\u0000${model}`);
    const aggregate =
      result !== undefined && result.aggregate !== null && typeof result.aggregate === 'object' ? result.aggregate : null;
    records.push({
      v: 1,
      ts,
      runId: stringOrNull(run?.runId) ?? '',
      provider,
      model,
      decision: stringOrNull(aggregate?.decision) ?? 'unscorable',
      prediction: stringOrNull(aggregate?.prediction),
      predictionName: stringOrNull(aggregate?.predictionName),
      family: stringOrNull(aggregate?.family),
      familyName: stringOrNull(aggregate?.familyName),
      // ⚠️ OD-1 修复（§61 同轮发现）：聚合对象顶层的数值字段名是 **`confidence`**（契约 §9.1
      // L155：`confidence = median(有效回合的 numeric probability)`），**没有**顶层 `probability`
      // ⇒ 原先读 `aggregate.probability` 会**恒为 null**，导致"已校准却显示 —"。
      // 这里先读 `confidence`，并保留 `probability` 作为兼容别名（若调用方直接塞了该键）。
      probability: finiteOrNull(aggregate?.confidence ?? aggregate?.probability),
      agreement: finiteOrNull(aggregate?.agreement),
      stability: stringOrNull(aggregate?.stability) ?? 'inconclusive',
      validRounds: intOr(aggregate?.validRounds, 0),
      totalRounds: intOr(aggregate?.totalRounds, intOr(options.rounds, 0)),
      options: { ...shapeOptions },
      error: stringOrNull(run?.error),
      // §61.4 B：解释"置信度为何是 null"（unavailable = 上游说不可用；null = 未知）
      probabilityStatus: probabilityStatusOrNull(aggregate?.probabilityStatus),
    });
  }
  return records;
}

/**
 * run 进终态时落盘（§29.2）。
 *
 * ⚠️ 硬要求：**写历史失败绝不允许影响 run 的终态** —— 本函数自带 try/catch，
 * 任何失败（`append` 抛错、返回 `ok:false`）都只记日志并返回 `{ok:false}`，**绝不抛出**。
 *
 * @param {object} ctx 插件上下文（只用 `logger`，可缺省）
 * @param {object} run 运行对象
 * @param {(records:Array<object>)=>Promise<unknown>} [append] 可注入的追加实现（测试用）
 * @returns {Promise<{ok:boolean, count:number, error:string|null}>}
 */
export async function persistRunHistory(ctx, run, append = appendRecords) {
  try {
    const records = buildHistoryRecords(run);
    if (records.length === 0) return { ok: true, count: 0, error: null };
    const written = await append(records);
    if (written !== null && typeof written === 'object' && written.ok === false) {
      const error = `追加历史未成功：${String(written.error)}`;
      try {
        ctx?.logger?.warn?.(`[fingerprint] ${error}`);
      } catch {
        // 日志不可用不影响终态
      }
      noteHistoryError(error); // §55.5 B：缺口 B 的可见化（不改变 run 终态）
      return { ok: false, count: records.length, error };
    }
    return { ok: true, count: records.length, error: null };
  } catch (error) {
    const message = text(error);
    try {
      ctx?.logger?.warn?.(`[fingerprint] 写历史异常（已忽略，run 终态不受影响）：${message}`);
    } catch {
      // 同上
    }
    noteHistoryError(`写历史异常：${message}`); // §55.5 B：同样要留痕
    return { ok: false, count: 0, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §55：运行中侧车 → 中断恢复 → 写历史失败可见
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 缺口 B 的可见化：最近一次"写历史/侧车失败"。
 * ⚠️ **一旦被设置就保留**（直到进程结束）—— 操作者事后也能看见"有一次历史没写进去"，
 * 而不是错过那一瞬间的日志。
 */
export const historyState = { lastHistoryError: null };

/** 记一次历史/侧车失败（**不改变 run 终态**）。 */
export function noteHistoryError(message) {
  historyState.lastHistoryError = { at: new Date().toISOString(), message: String(message) };
}

/** 安全转 ISO 字符串：缺失/非法 ⇒ 当前时刻（**绝不抛**）。 */
export function isoOrNow(value) {
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** 当前进程的「进程启动时刻」估计值（§55.5 A 冻结公式）。 */
export function currentProcessStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * ⚠️ **改这里之前先看实测**：`Date.now() - round(process.uptime()*1000)` 在**同一进程内会抖 ±1ms**
 * （实测 200 次采样得到 **2 个不同取值**、极差 1ms）。所以**不能用严格 `!==`**：那会把一个
 * **还活着**的 run 误判成"进程已重启"，给它写一条假的 `interrupted` 记录 —— 恰好违反 §55.5 A
 * 「同一进程内重组合绝不写被打断」的意图。
 * 这里用 1 秒容差：同进程抖动 ≤1ms，而真正的进程重启至少相隔数秒（信号差 >1000×）。
 */
export const PROCESS_STARTED_AT_TOLERANCE_MS = 1000;

/**
 * 侧车里的 descriptor 是否属于**当前**进程。
 * @param {object|null} descriptor 侧车内容
 * @returns {boolean} true ⇒ 那个 run 可能还在跑（**绝不能**写"被打断"、也**不能**清侧车）
 */
export function isSameProcess(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object') return false;
  const startedAt = descriptor.processStartedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return false;
  const pidMatches = typeof descriptor.pid !== 'number' || descriptor.pid === process.pid;
  return pidMatches && Math.abs(startedAt - currentProcessStartedAt()) <= PROCESS_STARTED_AT_TOLERANCE_MS;
}

/** 取 W5 的侧车三件套；未落盘时对应项为 null（**不抛**）。 */
export function sidecarApi(source = historySidecar) {
  const pick = (name) => (typeof source?.[name] === 'function' ? source[name].bind(source) : null);
  return { write: pick('writeActiveRun'), read: pick('readActiveRun'), clear: pick('clearActiveRun') };
}

/**
 * run 启动时写侧车（§55.5 B①）。
 * ⚠️ **写失败绝不阻止 run 启动** —— 只 `logger.warn` + 记 `lastHistoryError`。
 */
export async function writeRunSidecar(ctx, run, api = sidecarApi()) {
  if (api.write === null) {
    const message = 'history.js 未提供 writeActiveRun（契约 §55.5 A 接口尚未落盘）⇒ 本次运行没有中断保护';
    try {
      ctx?.logger?.warn?.(`[fingerprint] ${message}`);
    } catch {
      // 忽略
    }
    noteHistoryError(message);
    return { ok: false, error: message };
  }
  try {
    const result = await api.write({
      v: 1,
      runId: run.runId,
      startedAt: isoOrNow(run.startedAt),
      pid: process.pid,
      processStartedAt: currentProcessStartedAt(),
      options: {
        rounds: intOr(run.options.rounds, 0),
        count: intOr(run.options.count, 0),
        parallel: intOr(run.options.parallel, 0),
        strict: run.options.strict === true,
      },
      targets: (Array.isArray(run.targets) ? run.targets : []).map((target) => ({
        provider: target.provider,
        model: target.model,
      })),
    });
    if (result !== null && typeof result === 'object' && result.ok === false) {
      const message = `写侧车失败：${String(result.error)}`;
      try {
        ctx?.logger?.warn?.(`[fingerprint] ${message}`);
      } catch {
        // 忽略
      }
      noteHistoryError(message);
      return { ok: false, error: message };
    }
    return { ok: true, error: null };
  } catch (error) {
    const message = `写侧车异常：${text(error)}`;
    try {
      ctx?.logger?.warn?.(`[fingerprint] ${message}`);
    } catch {
      // 忽略
    }
    noteHistoryError(message);
    return { ok: false, error: message };
  }
}

/**
 * run 终态后清侧车（§55.5 B②）。
 * ⚠️ **失败不改变 run 终态** —— 只 `logger.warn` + 记 `lastHistoryError`。
 */
export async function clearRunSidecar(ctx, api = sidecarApi()) {
  if (api.clear === null) return { ok: true, removed: false, error: null }; // 未落盘：静默（写侧车时已记过一次）
  try {
    const result = await api.clear();
    if (result !== null && typeof result === 'object' && result.ok === false) {
      const message = `清侧车失败：${String(result.error)}`;
      try {
        ctx?.logger?.warn?.(`[fingerprint] ${message}`);
      } catch {
        // 忽略
      }
      noteHistoryError(message);
      return { ok: false, error: message };
    }
    return { ok: true, removed: result?.removed === true, error: null };
  } catch (error) {
    const message = `清侧车异常：${text(error)}`;
    try {
      ctx?.logger?.warn?.(`[fingerprint] ${message}`);
    } catch {
      // 忽略
    }
    noteHistoryError(message);
    return { ok: false, error: message };
  }
}

/** 中断记录的 error 文案（§55.5 B 冻结值）。 */
export const INTERRUPTED_ERROR = 'interrupted: 上一次运行未完成（宿主进程已重启，无结果）';

/**
 * 由侧车 descriptor 构造"被打断"记录（**纯函数**；形状复用 {@link HISTORY_RECORD_KEYS} 的 18 键）。
 *
 * §55.5 B 冻结取值：`decision='unscorable'`、`validRounds=0`、`totalRounds=options.rounds`、
 * `ts=descriptor.startedAt`、其余聚合字段 `null`、`stability='inconclusive'`。
 * `provider` / `model` **不做生态校验** —— 这是事实记录，任意名字都要能写。
 *
 * @param {object} descriptor 侧车内容
 * @param {string} [reason] error 文案
 * @returns {Array<object>} 每个 target 一条
 */
export function buildInterruptedRecords(descriptor, reason = INTERRUPTED_ERROR) {
  const source = descriptor !== null && typeof descriptor === 'object' ? descriptor : {};
  const options = source.options !== null && typeof source.options === 'object' ? source.options : {};
  const shapeOptions = {
    rounds: intOr(options.rounds, 0),
    count: intOr(options.count, 0),
    parallel: intOr(options.parallel, 0),
    strict: options.strict === true,
  };
  const ts = isoOrNow(source.startedAt); // 缺失/非法 ⇒ 当前时刻（不再抛 RangeError）
  const runId = stringOrNull(source.runId) ?? '';
  const records = [];
  for (const target of Array.isArray(source.targets) ? source.targets : []) {
    if (target === null || typeof target !== 'object') continue;
    const provider = stringOrNull(target.provider);
    const model = stringOrNull(target.model);
    if (provider === null || model === null) continue;
    records.push({
      v: 1,
      ts,
      runId,
      provider,
      model,
      decision: 'unscorable',
      prediction: null,
      predictionName: null,
      family: null,
      familyName: null,
      probability: null,
      agreement: null,
      stability: 'inconclusive',
      validRounds: 0,
      totalRounds: intOr(shapeOptions.rounds, 0),
      options: { ...shapeOptions },
      error: reason,
      // §61.4 B：被打断的 run 没有聚合 ⇒ 没有置信度状态 ⇒ **null**（"未知"，不是"不可用"）
      probabilityStatus: null,
    });
  }
  return records;
}

/**
 * 模块初始化时的中断恢复（§55.5 B）。
 *
 * **触发条件（两个都要满足）**：侧车存在 **且** 它的 `processStartedAt` 不属于当前进程
 * ⇒ 那个 run 所在的进程已经没了，它永远不会走到终态路径 ⇒ 为每个 target 补一条记录。
 *
 * **幂等**：写之前查 history 里是否已有**同 runId** 的记录，有则跳过该记录（`skipped++`）。
 * **任何失败都不得让宿主启动失败** —— 只 `logger.warn` + 记 `lastHistoryError`。
 *
 * @param {object} ctx 插件上下文（只用 logger，可缺省）
 * @param {{read:Function|null, clear:Function|null}} [api] 可注入的侧车实现（测试用）
 * @param {(records:Array<object>)=>Promise<unknown>} [append] 可注入的追加实现（测试用）
 * @returns {Promise<{ok:boolean, appended:number, skipped:number, error:string|null}>}
 */
export async function recoverInterruptedRuns(ctx, api = sidecarApi(), append = appendRecords) {
  const result = { ok: true, appended: 0, skipped: 0, error: null };
  try {
    if (api.read === null) {
      result.ok = false;
      result.error = 'history.js 未提供 readActiveRun（契约 §55.5 A 接口尚未落盘）';
      return result;
    }
    const descriptor = await api.read();
    if (descriptor === null || descriptor === undefined || typeof descriptor !== 'object') return result;
    // ⚠️ 同一进程 ⇒ 旧 run 可能仍在跑（模块重组合 ≠ 进程重启）⇒ 不写、也不清侧车
    if (isSameProcess(descriptor)) return result;

    const records = buildInterruptedRecords(descriptor);
    if (records.length > 0) {
      const existing = await readHistory({});
      const known = new Set((Array.isArray(existing) ? existing : []).map((record) => record?.runId));
      const fresh = records.filter((record) => !known.has(record.runId));
      result.skipped = records.length - fresh.length;
      if (fresh.length > 0) {
        const written = await append(fresh);
        if (written !== null && typeof written === 'object' && written.ok === false) {
          result.ok = false;
          result.error = `写中断记录失败：${String(written.error)}`;
          noteHistoryError(result.error);
          // ⚠️ 有意偏离字面 spec：写失败时**不清侧车**，留给下次初始化重试。
          //（否则这条 run 的记录就永久消失了 —— 正是 §55 要修的那个缺口。）
          return result;
        }
        result.appended = fresh.length;
      }
    }
    if (api.clear !== null) {
      const cleared = await api.clear();
      if (cleared !== null && typeof cleared === 'object' && cleared.ok === false) {
        result.ok = false;
        result.error = `清侧车失败：${String(cleared.error)}`;
        noteHistoryError(result.error);
      }
    }
    return result;
  } catch (error) {
    result.ok = false;
    result.error = `中断恢复异常：${text(error)}`;
    try {
      ctx?.logger?.warn?.(`[fingerprint] ${result.error}`);
    } catch {
      // 忽略
    }
    noteHistoryError(result.error);
    return result;
  }
}

/**
 * 生成任务表并同时给出索引（FIX-1）。
 *
 * 旧实现按 `provider+model+round` 在 `run.tasks` 里 `find()`，重复 target 时只会命中
 * **第一个** task ⇒ 第二个 target 的 task 永远停在 `queued`，且 `run.rounds` 按 targetKey
 * 归并导致两份 target 共享同一数组、`totalRounds` 看起来翻倍。
 * 现在：入参已在 {@link parseRunOptions} 去重，取 task 走 Map 索引（O(1)、无歧义）。
 *
 * @param {Array<{provider:string, model:string}>} targets 已去重的目标
 * @param {number} rounds 轮数
 * @returns {{tasks:Array<object>, index:Map<string, object>}}
 */
export function buildTasks(targets, rounds) {
  const tasks = [];
  const index = new Map();
  for (const target of targets) {
    for (let round = 1; round <= rounds; round += 1) {
      const task = {
        provider: target.provider,
        model: target.model,
        round,
        totalRounds: rounds,
        state: 'queued',
        count: null,
        expectedCount: null,
        firstByteMs: null,
        error: null,
      };
      tasks.push(task);
      index.set(taskKeyFor(target, round), task);
    }
  }
  return { tasks, index };
}

/**
 * 解析并校验 `/run` 请求体。
 * FIX-1：按 `provider+model` **去重**（保留首次出现的顺序）——重复 target 是用户可轻易
 * 造出的输入，必须在此收敛，否则下游 tasks/rounds 会错乱。
 */
export function parseRunOptions(body) {
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (targets.length === 0) throw new Error('targets 不能为空');
  const cleaned = [];
  const seen = new Set();
  for (const target of targets) {
    const provider = typeof target?.provider === 'string' ? target.provider : '';
    const model = typeof target?.model === 'string' ? target.model : '';
    if (provider === '' || model === '') throw new Error('每个 target 必须同时给 provider 与 model');
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) continue; // FIX-1：重复目标只保留首次出现
    seen.add(key);
    cleaned.push({ provider, model });
  }
  const clampInt = (value, fallback, min, max) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  };
  return {
    targets: cleaned,
    rounds: clampInt(body.rounds, 3, 1, 10),
    count: clampInt(body.count, 3, 1, 3),
    // §28.2：并发单位是 (目标 × 轮次)，`parallel` = **同时在跑的轮次数**（1–3）
    parallel: clampInt(body.parallel, MAX_PARALLEL, 1, MAX_PARALLEL),
    strict: body.strict === true,
    timeoutSec: clampInt(body.timeoutSec, 120, 5, 900),
    gapSec: clampInt(body.gapSec, 0, 0, 120),
    ...(typeof body.reasoningEffort === 'string' && body.reasoningEffort !== ''
      ? { reasoningEffort: body.reasoningEffort }
      : {}),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Number.isFinite(Number(body.maxTokens)) ? { maxTokens: Number(body.maxTokens) } : {}),
  };
}

/**
 * 语义级校验（FIX-6）。契约 §4.2：strict 要求 3 条样本全部有效，
 * 而 `count` 决定一轮生成几道挑战 ⇒ `strict && count !== 3` 必然在取样阶段白等一轮。
 *
 * @param {object} options {@link parseRunOptions} 的结果
 * @returns {string|null} 不为 null 即为人可读的拒绝原因
 */
export function validateRunOptions(options) {
  if (options.strict === true && options.count !== 3) {
    return `strict 模式要求 count=3（收到 count=${String(options.count)}）；否则一轮不可能有 3/3 有效样本`;
  }
  return null;
}

/** 跑一个 (target, round)：把 probe 的取样结果写进 task 与该 run 的 rounds。 */
async function runOneTargetRound(ctx, run, target, round, task) {
  task.state = 'waiting';
  notify(run);

  const signal = AbortSignal.any([
    run.controller.signal,
    AbortSignal.timeout(run.options.timeoutSec * 1000),
  ]);

  let outcome;
  try {
    outcome = await runRound({
      count: run.options.count,
      strict: run.options.strict,
      signal,
      send: async (prompt, { signal: innerSignal, onDelta }) => {
        task.state = 'streaming';
        notify(run);
        const sample = await sendViaLlm(ctx, {
          provider: target.provider,
          model: target.model,
          prompt,
          signal: innerSignal,
          ...(run.options.reasoningEffort === undefined ? {} : { reasoningEffort: run.options.reasoningEffort }),
          ...(run.options.temperature === undefined ? {} : { temperature: run.options.temperature }),
          ...(run.options.maxTokens === undefined ? {} : { maxTokens: run.options.maxTokens }),
          onDelta,
        });
        // probe 只认 { text, endReason, firstByteMs? }；note 是附加诊断信息
        return { text: sample.text, endReason: sample.endReason, firstByteMs: sample.firstByteMs, note: sample.note };
      },
      onSample: (_index, sample) => {
        if (Number.isFinite(sample?.count)) task.count = sample.count;
        if (Number.isFinite(sample?.expectedCount)) task.expectedCount = sample.expectedCount;
        if (Number.isFinite(sample?.firstByteMs)) task.firstByteMs = sample.firstByteMs;
        if (typeof sample?.error === 'string' && sample.error !== '') task.error = sample.error;
        if (typeof sample?.state === 'string') task.state = sample.state;
        notify(run);
      },
    });
  } catch (error) {
    outcome = { challenges: [], samples: [], analysis: null, error: `取样异常：${text(error)}` };
  }

  const samples = Array.isArray(outcome.samples) ? outcome.samples : [];
  const failed = samples.filter((sample) => sample.state === 'failed');
  const truncated = samples.filter((sample) => sample.state === 'truncated');
  let state = 'complete';
  if (run.controller.signal.aborted) state = 'failed'; // 契约 §5：被取消的回合不计分
  else if (typeof outcome.error === 'string' && outcome.error !== '') state = 'failed';
  else if (failed.length > 0) state = 'failed';
  else if (truncated.length > 0) state = 'truncated';
  task.state = state;

  const counts = samples.map((sample) => sample.count).filter((value) => Number.isFinite(value));
  if (counts.length > 0) task.count = Math.max(...counts);
  const firstBytes = samples.map((sample) => sample.firstByteMs).filter((value) => Number.isFinite(value));
  if (firstBytes.length > 0) task.firstByteMs = Math.min(...firstBytes);

  const parts = [];
  if (typeof outcome.error === 'string' && outcome.error !== '') parts.push(outcome.error);
  if (failed.length > 0 && typeof failed[0]?.error === 'string' && failed[0].error !== '') parts.push(failed[0].error);
  const note = samples.map((sample) => sample?.note).find((value) => typeof value === 'string' && value !== '');
  if (note !== undefined) parts.push(note);
  task.error = parts.length === 0 ? null : parts.join(' | ');
  notify(run);

  // §28.2：轮次现在会**并发**，必须按 round 写**固定槽位** —— 若继续 push，完成顺序会让
  // export / aggregate 的 perRound 顺序漂移（`perRound[].index` 就不再是轮号）。
  const list = run.rounds.get(targetKey(target)) ?? [];
  list[round - 1] = {
    challenges: outcome.challenges,
    samples: outcome.samples,
    analysis: outcome.analysis,
    error: outcome.error ?? null,
  };
  run.rounds.set(targetKey(target), list);
}

/**
 * 执行整个运行。
 *
 * §28.2（P1 裁决）：并发单位是 **(目标 × 轮次)** —— `options.parallel` 表示
 * 「**同时在跑的轮次数**」（1–3），不再被目标数限制。每轮内部的 `count` 个挑战仍由
 * probe 全并发（不变）。因此在飞 HTTP 请求数 ≈ `parallel × count`。
 *
 * 旧实现在这里以 target 为队列单位，单模型多轮时 workerCount 恒为 1 ⇒ 轮次被串行。
 */
async function executeRun(ctx, run) {
  try {
    if (run.controller.signal.aborted) {
      run.phase = 'cancelled';
      return;
    }
    // §55.5 B①：真正开始跑之前写侧车（供"进程重启后"做中断恢复）。
    // 失败**不阻止 run 启动** —— writeRunSidecar 内部只 warn + 记 lastHistoryError。
    await writeRunSidecar(ctx, run);
    const items = buildRunItems(run);
    let dispatched = 0;
    await runPool(
      items,
      run.options.parallel,
      async (item) => {
        // gapSec：原语义是「轮与轮之间的间隔」；轮级并发后按「相邻派发之间的间隔」生效
        //（客户端固定发 0，故实际不生效）。
        if (run.options.gapSec > 0 && dispatched > 0) {
          await sleep(run.options.gapSec * 1000, run.controller.signal);
        }
        dispatched += 1;
        await runOneTargetRound(ctx, run, item.target, item.round, item.task);
      },
      // 取消：每次取项前询问，已取消则不再派发新轮次
      () => run.controller.signal.aborted,
    );

    // §9.6：每个目标用自己的 roundsOf 做聚合
    for (const target of run.targets) {
      const rounds = run.rounds.get(targetKey(target)) ?? [];
      run.results.push({
        provider: target.provider,
        model: target.model,
        aggregate: aggregateRounds(rounds.map((round) => ({ analysis: round.analysis, error: round.error }))),
      });
    }
    run.phase = run.controller.signal.aborted ? 'cancelled' : 'done';
  } catch (error) {
    run.phase = run.controller.signal.aborted ? 'cancelled' : 'failed';
    run.error = text(error);
  } finally {
    run.finishedAt = Date.now();
    if (activeRunId === run.runId) activeRunId = null;
    // §29.2：run 进终态时落盘（一条记录 = 一个 (run, target)）。
    // persistRunHistory 自带 try/catch ⇒ 写历史失败绝不改变本 run 的终态。
    await persistRunHistory(ctx, run);
    // §55.5 B②：终态已落盘 ⇒ 清侧车（失败同样不改变终态，只记 lastHistoryError）
    await clearRunSidecar(ctx);
    // 把 finish 分片的运行时取证带进诊断产物（核对类型声明用）
    if (finishObservations.length > 0) {
      smoke.finishObservations = finishObservations.slice(-32);
    }
    await persistSmoke();
    notify(run);
    for (const push of [...run.subscribers]) {
      try {
        push(null); // 结束信号
      } catch {
        // 忽略
      }
    }
    run.subscribers.clear();
    const finished = [...runs.values()].filter((entry) => entry.phase !== 'running');
    finished.sort((left, right) => left.startedAt - right.startedAt);
    while (finished.length > MAX_KEPT_RUNS) {
      const victim = finished.shift();
      runs.delete(victim.runId);
    }
  }
}

/** 启动一次运行（契约 §5：已有运行 → BUSY）。 */
function startRun(ctx, options) {
  // §28.3（P2）：BUSY 必须附带**结构化** runId，否则客户端只能解析自由文本（或干脆解析不了），
  // 配合"客户端不持久化 runId"就变成死局：既开不了新任务，也看不到旧任务。
  if (activeRunId !== null) {
    return failure('BUSY', `已有运行中任务：${activeRunId}`, { runId: activeRunId });
  }
  runSequence += 1;
  const runId = `r-${String(runSequence)}`;
  // FIX-1：任务表与索引一次生成；取 task 走 Map，不再按字段 find()
  const { tasks, index: taskIndex } = buildTasks(options.targets, options.rounds);
  const run = {
    runId,
    phase: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    options,
    targets: options.targets,
    tasks,
    taskIndex,
    results: [],
    rounds: new Map(),
    subscribers: new Set(),
    controller: new AbortController(),
    error: null,
  };
  runs.set(runId, run);
  activeRunId = runId;
  void executeRun(ctx, run);
  return { ok: true, runId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────────────────────

/** GET /status（`api` 可注入侧车实现，便于离线测 activeRun） */
export async function routeStatus(response, api = sidecarApi()) {
  const status = detectorStatus();
  // §55.5 B③：侧车视图。⚠️ 读侧车失败**绝不能**把 /status 变成非 200 ⇒ 失败一律 activeRun = null。
  let activeRun = null;
  try {
    if (api.read !== null) {
      const descriptor = await api.read();
      if (descriptor !== null && descriptor !== undefined && typeof descriptor === 'object') {
        activeRun = {
          runId: descriptor.runId ?? null,
          startedAt: descriptor.startedAt ?? null,
          sameProcess: isSameProcess(descriptor),
          // §55.8 追加 2：侧车的 processStartedAt 与 pid 也如实透出（客户端据此算三态）
          processStartedAt: typeof descriptor.processStartedAt === 'number' ? descriptor.processStartedAt : null,
          currentProcessStartedAt: currentProcessStartedAt(),
          pid: typeof descriptor.pid === 'number' ? descriptor.pid : null,
          options: descriptor.options ?? null,
          targets: Array.isArray(descriptor.targets) ? descriptor.targets : [],
        };
      }
    }
  } catch {
    activeRun = null;
  }
  sendJson(response, {
    ok: true,
    detector: {
      ready: status.ready === true,
      builtAt: status.builtAt ?? null,
      bankModelCount: status.bankModelCount ?? null,
      cachePath: status.cachePath ?? CACHE_PATH,
      ...(status.error === undefined || status.error === null ? {} : { error: status.error }),
    },
    // §28.3（P2）：暴露正在跑的 runId（无则 null）。客户端挂载/重载时据此恢复并订阅 SSE，
    // 这是解开「BUSY 死局」的另一半（另一半是 BUSY 响应体里的 error.runId）。
    activeRunId,
    // §55.5 B③：侧车（含 sameProcess）+ 最近一次写历史失败（缺口 B 的可见化）
    activeRun,
    lastHistoryError: historyState.lastHistoryError,
  });
}

/**
 * GET /targets —— 目标枚举归 W5（`./targets.js`）。
 * 契约 §14.4：handler 必须先 `invalidateTargets()` 再 `listTargets(ctx)`，
 * 这样页面上的「刷新」才是当前配置（W5 内部有 5 秒 TTL 缓存）。
 * 注意：`credentialAvailable` 是三态 `true|false|null`（null = 无法判定，OAuth 账号路由），
 * 本层**原样透传、不压成布尔**。
 */
async function routeTargets(ctx, response) {
  try {
    invalidateTargets();
    const result = await listTargets(ctx);
    const providers = Array.isArray(result) ? result : (result?.providers ?? []);
    const status = detectorStatus();
    sendJson(response, {
      ok: true,
      detector: {
        ready: status.ready === true,
        builtAt: status.builtAt ?? null,
        bankModelCount: status.bankModelCount ?? null,
        ...(status.error === undefined || status.error === null ? {} : { error: status.error }),
      },
      providers,
    });
  } catch (error) {
    sendJson(response, failure('TARGETS_FAILED', `枚举目标失败：${text(error)}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 检测历史路由（§29.5 + §31.2 + H2 追加）
// ─────────────────────────────────────────────────────────────────────────────

/** `/history` 的 limit 口径：缺省 50，最大 200（非法值走默认，不报错）。 */
export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 200;

/**
 * 解析 `/history` 的查询参数（纯函数，可离线测）。
 * - `limit`：1–200，缺省或非法 → {@link HISTORY_LIMIT_DEFAULT}
 * - `provider` / `model`：空串或缺失视为**不过滤**（不写进返回对象）
 *
 * @param {URLSearchParams} [params]
 * @returns {{limit:number, provider?:string, model?:string}}
 */
export function parseHistoryQuery(params) {
  const rawLimit = params === undefined || params === null ? null : params.get('limit');
  const parsed = Number(rawLimit);
  const limit =
    Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), HISTORY_LIMIT_MAX) : HISTORY_LIMIT_DEFAULT;
  const pick = (key) => {
    const value = params === undefined || params === null ? null : params.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  const provider = pick('provider');
  const model = pick('model');
  return {
    limit,
    ...(provider === null ? {} : { provider }),
    ...(model === null ? {} : { model }),
  };
}

/**
 * GET /history
 *
 * §31.2 硬要求：**必须**带上 `stats`（含 `stats.error`）——
 * `readHistory()` 在读失败时按冻结签名退化为 `[]`，没有 `stats.error` 客户端就分不清
 * 「空历史」与「读失败」。
 */
export async function routeHistory(params, response) {
  const query = parseHistoryQuery(params);
  const records = await readHistory(query);
  const stats = await historyStats();
  sendJson(response, {
    ok: true,
    records: Array.isArray(records) ? records : [],
    stats,
  });
}

/**
 * GET /history/models
 *
 * H2 追加：`aggregateByModel()` 有**和 `readHistory()` 一样的诊断盲区**（读失败退化为 `[]`），
 * 所以这里同样带上与 `/history` 同形的 `stats`。
 *
 * §55.7 追加（FIX-A2 追加 1）：每行**必须**带 `lastError`（该模型**最新那条记录**的 `error`，
 * 无则 `null`，**字段不省略**）。理由：聚合表要区分「样本不足」与「被打断（无结果）」——
 * 少了它，一条"被宿主重启打断"的记录会被显示成"样本不够，建议增加轮次"，
 * 把**数据丢失说成样本问题**（正是 §55 要消除的误导）。
 *
 * @param {object} response 假/真响应对象
 * @param {(options:object)=>Promise<Array<object>>} [reader] 可注入（测试用）
 * @param {()=>Promise<Array<object>>} [aggregator] 可注入（测试用）
 */
export async function routeHistoryModels(response, reader = readHistory, aggregator = aggregateByModel) {
  const models = await aggregator();
  const stats = await historyStats();
  const rows = Array.isArray(models) ? models : [];
  // 最新的 error：readHistory 返回**最新在前** ⇒ 每个 (provider,model) 第一次见到的那条就是最新
  let records = [];
  try {
    const loaded = await reader({});
    records = Array.isArray(loaded) ? loaded : [];
  } catch {
    records = []; // 读失败：lastError 一律 null（诊断入口是 stats.error）
  }
  const newestError = new Map();
  const newestProbabilityStatus = new Map();
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const key = `${String(record.provider)}\u0000${String(record.model)}`;
    if (newestError.has(key)) continue;
    newestError.set(key, stringOrNull(record.error));
    // §61 追加 1：与 lastError 同源（该模型最新那条记录）——`null` 是**合法值**，键必须存在
    newestProbabilityStatus.set(key, probabilityStatusOrNull(record.probabilityStatus));
  }
  sendJson(response, {
    ok: true,
    models: rows.map((row) => {
      const key = `${String(row?.provider)}\u0000${String(row?.model)}`;
      // 优先用 `aggregateByModel` 已经算好的值（避免第二处真值来源）；它没给时用本路由的扫描兜底
      const fromRow = Object.hasOwn(row ?? {}, 'lastProbabilityStatus')
        ? probabilityStatusOrNull(row.lastProbabilityStatus)
        : (newestProbabilityStatus.get(key) ?? null);
      return {
        ...row,
        lastError: newestError.get(key) ?? null,
        // 字段**永不省略**，无则 null（W6 的聚合表靠它显示 `—（未校准）`）
        lastProbabilityStatus: fromRow,
      };
    }),
    stats,
  });
}

/**
 * POST /history/clear
 * `clearHistory()` 失败时按冻结签名退化为 `0`；这里如实返回 `removed`，
 * 诊断入口仍是 `stats.error`（客户端清空后可再查一次 `/history`）。
 */
export async function routeHistoryClear(response) {
  const removed = await clearHistory();
  sendJson(response, { ok: true, removed: Number.isFinite(removed) ? removed : 0 });
}

/** POST /detector/refresh（§11.2：先判空） */
async function routeDetectorRefresh(response) {
  try {
    const loaded = await getDetector({ force: true });
    if (loaded.detector === null) {
      sendJson(response, failure('DETECTOR_UNAVAILABLE', loaded.error ?? 'lmfpd 参考数据加载失败'));
      return;
    }
    sendJson(response, { ok: true, builtAt: loaded.builtAt, bankModelCount: loaded.bankModelCount });
  } catch (error) {
    sendJson(response, failure('DETECTOR_UNAVAILABLE', `重载 detector 失败：${text(error)}`));
  }
}

/** GET /run/<runId>/events（SSE：500ms 或状态变化推一次，结束推 done） */
function routeEvents(run, request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  /**
   * FIX-8：背压标志。`write()` 返回 false 表示内部缓冲已满 —— 继续写只会把快照堆进进程内存。
   * 心跳帧是**可丢的**（最终状态由 `event: done` 与 `GET /run/<id>` 快照保证），所以这里直接
   * 跳过被背压的帧，等 `drain` 再继续。量级上限：每 500ms 一帧、每帧 ~1–4 KB。
   */
  let backpressured = false;
  response.on('drain', () => {
    backpressured = false;
  });
  const push = (payload) => {
    if (closed) return;
    if (payload === null) {
      // 结束事件不受背压影响：数据仍会排进缓冲并最终送达。
      response.write('event: done\ndata: {}\n\n');
      response.end();
      closed = true;
      cleanup();
      return;
    }
    if (backpressured) return;
    backpressured = response.write(`data: ${payload}\n\n`) === false;
  };
  const heartbeat = setInterval(() => {
    if (closed) return;
    push(JSON.stringify(snapshot(run)));
  }, SSE_HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(heartbeat);
    run.subscribers.delete(push);
  };
  const onClose = () => {
    closed = true;
    cleanup();
  };
  run.subscribers.add(push);
  request.on('close', onClose);
  response.on('close', onClose);
  response.on('error', onClose);
  // 首帧 + 已结束的运行立刻补 done
  backpressured = response.write(`data: ${JSON.stringify(snapshot(run))}\n\n`) === false;
  if (run.phase !== 'running') push(null);
}

/**
 * 统一入口：webServer 的 `prefix` 处理器。
 * @param {object} ctx
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function handle(ctx, request, response) {
  const allowed = authorize(request);
  if (allowed !== true) {
    sendJson(response, allowed.body, allowed.status);
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = (request.method ?? 'GET').toUpperCase();
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    sendJson(response, failure('NOT_FOUND', `未知路由：${method} ${path}`), 404);
    return;
  }
  const rest = path.slice(PREFIX.length);

  try {
    // GET /status（`/fingerprint` 与 `/fingerprint/status` 等价）
    if (method === 'GET' && (rest === '/status' || rest === '')) {
      await routeStatus(response);
      return;
    }
    if (method === 'GET' && rest === '/targets') {
      await routeTargets(ctx, response);
      return;
    }
    // §29.5：检测历史三条路由（走同一个 authorize 访问控制）
    if (method === 'GET' && rest === '/history') {
      await routeHistory(url.searchParams, response);
      return;
    }
    if (method === 'GET' && rest === '/history/models') {
      await routeHistoryModels(response);
      return;
    }
    if (method === 'POST' && rest === '/history/clear') {
      await routeHistoryClear(response);
      return;
    }
    if (method === 'POST' && rest === '/run') {
      const body = await readJsonBody(request);
      let options;
      try {
        options = parseRunOptions(body);
      } catch (error) {
        sendJson(response, failure('BAD_REQUEST', text(error)));
        return;
      }
      // FIX-6：strict 要求 3/3 全部有效（契约 §4.2）—— count<3 时一轮不可能满足，白等一轮
      const invalid = validateRunOptions(options);
      if (invalid !== null) {
        sendJson(response, failure('INVALID_OPTIONS', invalid));
        return;
      }
      // §11.2：先判空，失败直接回 DETECTOR_UNAVAILABLE，不启动运行
      const loaded = await getDetector();
      if (loaded.detector === null) {
        sendJson(response, failure('DETECTOR_UNAVAILABLE', loaded.error ?? 'lmfpd 参考数据加载失败'));
        return;
      }
      sendJson(response, startRun(ctx, options));
      return;
    }
    if (method === 'POST' && rest === '/cancel') {
      const body = await readJsonBody(request);
      // §28.3：空 body（或 runId 为空串）时**有意**默认指向 `activeRunId` ——
      // 客户端在"重载后从 /status 恢复"的场景下可以不带 runId 直接取消当前运行。
      const runId = typeof body.runId === 'string' && body.runId !== '' ? body.runId : activeRunId;
      const run = runId === null ? undefined : runs.get(runId);
      if (run === undefined) {
        sendJson(response, failure('NOT_FOUND', `未找到运行：${String(runId)}`));
        return;
      }
      if (run.phase === 'running') {
        run.controller.abort();
        // FIX-4：phase 只在 executeRun 的结尾/finally 改，abort 后立刻读会拿到过时的 'running'。
        // 这里同步置为 cancelled 并广播，响应与后续快照都反映真实意图。
        run.phase = 'cancelled';
        notify(run);
      }
      sendJson(response, { ok: true, runId: run.runId, phase: run.phase });
      return;
    }
    if (method === 'POST' && rest === '/detector/refresh') {
      await routeDetectorRefresh(response);
      return;
    }

    const runMatch = /^\/run\/([^/]+)(\/events|\/export)?$/.exec(rest);
    if (runMatch !== null) {
      const runId = decodeURIComponent(runMatch[1]);
      const tail = runMatch[2] ?? '';
      const run = runs.get(runId);
      if (run === undefined) {
        sendJson(response, failure('NOT_FOUND', `未找到运行：${runId}`));
        return;
      }
      if (tail === '' && method === 'GET') {
        sendJson(response, snapshot(run));
        return;
      }
      if (tail === '/events' && method === 'GET') {
        routeEvents(run, request, response);
        return;
      }
      if (tail === '/export' && method === 'GET') {
        sendJson(response, exportBody(run));
        return;
      }
    }

    sendJson(response, failure('NOT_FOUND', `未知路由：${method} ${path}`), 404);
  } catch (error) {
    // FIX-2：响应可能已经开始（例如 SSE 中途出错）—— 再写头会抛 ERR_HTTP_HEADERS_SENT，
    // 此时只能结束连接，不能假装还回得出失败体。
    if (response.headersSent === true) {
      try {
        response.end();
      } catch {
        // 连接可能已断，忽略
      }
      return;
    }
    if (error?.code === BODY_TOO_LARGE) {
      // FIX-2：先回 §5 统一失败体，**再**断开剩余请求流。旧实现在读体时直接
      // `request.destroy()`，客户端拿到零响应体（实测 code=000），违反 §5。
      sendJson(response, failure(BODY_TOO_LARGE, text(error)));
      request.resume(); // 排空剩余数据，避免网关侧 EPIPE
      response.on('finish', () => {
        try {
          request.destroy();
        } catch {
          // 忽略
        }
      });
      return;
    }
    sendJson(response, failure('INTERNAL', text(error)));
  }
}

/**
 * 把路由挂到 webServer 上（契约 §12.2 idiom 的最后一跳）。
 * @returns {Function} disposer
 */
export function installRoutes(ctx, webServer) {
  return webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (request, response) => {
      // FIX-2：handle 内部已 try/catch，但响应阶段（SSE 写入、连接中断）仍可能抛异步异常；
      // 不接住就会变成 unhandledRejection。
      void handle(ctx, request, response).catch((error) => {
        try {
          if (response.headersSent !== true) sendJson(response, failure('INTERNAL', text(error)));
          else response.end();
        } catch {
          // 连接已断，忽略
        }
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 骨架期自检（旁路诊断，非关键路径）
// ─────────────────────────────────────────────────────────────────────────────

/** 最近一次自检的快照（模块级；`.smoke.json` 的内容来源）。 */
export const smoke = {
  checkedAt: null,
  runs: 0,
  providerIds: null,
  configurableProviderIds: null,
  settingsDescribeOk: false,
  settingsNamespaceCount: null,
  settingsNamespaces: null,
  credentialsAvailable: false,
  webServerAvailable: false,
  webServerRegisterType: undefined,
  webServerConstructorName: undefined,
  launchEnvironmentAvailable: false,
  httpRoutesRegistered: false,
  /** 最近一次运行观察到的 finish 分片真实形状（契约 §12.B 的运行时核对）。 */
  finishObservations: [],
  errors: {},
};

/** 输出一行自检日志（logger 与 stdout 双写）。 */
function emit(ctx, line) {
  try {
    ctx.logger.info(line);
  } catch (error) {
    console.error(`[fingerprint-smoke] logger unavailable: ${text(error)}`);
  }
  console.log(line);
}

/** 跑一项自检；抛错只记录，绝不上抛。 */
async function check(ctx, key, run, fallback) {
  try {
    const value = await run();
    return value === undefined ? fallback : value;
  } catch (error) {
    smoke.errors[key] = text(error);
    emit(ctx, `[fingerprint-smoke] ${key} THREW: ${text(error)}`);
    return fallback;
  }
}

/** 把当前快照落盘成开发期诊断产物；失败只打印。 */
async function persistSmoke() {
  try {
    const payload = {
      devDiagnostic:
        'W1/W7 诊断快照：开发期诊断产物，不是运行时数据，可随时删除；不进 profile、不进 package.json 的 files。',
      smokePath: SMOKE_PATH,
      ...smoke,
    };
    await writeFile(SMOKE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error(`[fingerprint-smoke] persist .smoke.json failed: ${text(error)}`);
  }
}

/** 逐条执行只读自检并刷新快照（同时落盘）。 */
export async function runSmoke(ctx) {
  smoke.checkedAt = new Date().toISOString();
  smoke.runs += 1;
  emit(ctx, `[fingerprint-smoke] run#${String(smoke.runs)} @ ${smoke.checkedAt}`);

  smoke.providerIds = await check(ctx, 'providers', () => ctx.llm.listProviders().map((entry) => entry.id), null);
  smoke.configurableProviderIds = await check(
    ctx,
    'configurableProviders',
    () => ctx.llm.listConfigurableProviders().map((entry) => entry.provider),
    null,
  );
  const descriptors = await check(ctx, 'settingsDescribe', () => ctx.settings.describe(), null);
  smoke.settingsDescribeOk = Array.isArray(descriptors);
  smoke.settingsNamespaceCount = Array.isArray(descriptors) ? descriptors.length : null;
  smoke.settingsNamespaces = Array.isArray(descriptors) ? descriptors.map((entry) => entry.ns) : null;
  const credentials = await check(ctx, 'credentials', () => ctx.get('credentials'), undefined);
  smoke.credentialsAvailable = credentials !== undefined && credentials !== null;
  const webServer = await check(ctx, 'webServer', () => ctx.get('webServer'), undefined);
  smoke.webServerAvailable = webServer !== undefined && webServer !== null;
  smoke.webServerRegisterType = typeof webServer?.register;
  smoke.webServerConstructorName = webServer?.constructor?.name;
  const launchEnvironment = await check(ctx, 'launchEnvironment', () => ctx.get('launchEnvironment'), undefined);
  smoke.launchEnvironmentAvailable = launchEnvironment !== undefined && launchEnvironment !== null;

  emit(
    ctx,
    `[fingerprint-smoke] providers=${JSON.stringify(smoke.providerIds)} settingsDescribeOk=${String(smoke.settingsDescribeOk)} webServer.register=${String(smoke.webServerRegisterType)} routes=${String(smoke.httpRoutesRegistered)} errors=${JSON.stringify(smoke.errors)}`,
  );
  await persistSmoke();
  return smoke;
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件体
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const once = (why) => {
    runSmoke(ctx).catch((error) => {
      console.error(`[fingerprint-smoke] runSmoke(${why}) failed: ${text(error)}`);
    });
  };

  once('apply');

  // §55.5 B：模块初始化时的中断恢复。
  // ⚠️ 同进程重组合 ≠ 进程重启 ⇒ isSameProcess 守卫会拦住误判（不会写假的"被打断"）。
  // 函数自带 try/catch 且永不抛 ⇒ 恢复失败**不会**让宿主加载失败。
  void recoverInterruptedRuns(ctx).catch((error) => {
    console.error(`[fingerprint] recoverInterruptedRuns failed: ${text(error)}`);
  });

  // 传输层：契约 §2.7 / §12.2 主路径。必须等 webServer 出现（它可能晚于本插件挂载）。
  try {
    ctx.inject(['webServer'], (host) => {
      host.effect(() => {
        const dispose = installRoutes(ctx, host.webServer);
        smoke.httpRoutesRegistered = true;
        emit(ctx, `[fingerprint] HTTP routes registered under ${PREFIX}`);
        return () => {
          dispose();
          smoke.httpRoutesRegistered = false;
        };
      }, 'fingerprint: http routes');
      once('inject:webServer');
    });
  } catch (error) {
    emit(ctx, `[fingerprint-smoke] inject(webServer) failed: ${text(error)}`);
  }

  for (const service of ['credentials', 'launchEnvironment']) {
    try {
      ctx.inject([service], () => {
        once(`inject:${service}`);
      });
    } catch (error) {
      emit(ctx, `[fingerprint-smoke] inject(${service}) failed: ${text(error)}`);
    }
  }

  for (const delayMs of [1500, 6000, 15000]) {
    ctx.effect(() => {
      const timer = setTimeout(() => once(`timer:${String(delayMs)}`), delayMs);
      return () => clearTimeout(timer);
    }, `fingerprint: smoke recheck @${String(delayMs)}ms`);
  }
}
