/**
 * dsh-fingerprint / test/index.test.mjs
 *
 * FIX-A（契约 §20.3 / §22.5）的回归测试：覆盖 `lib/index.js` 里**可离线测**的部分。
 *
 * 覆盖：
 *   FIX-1  重复 target 去重 + buildTasks 计数/索引（task 永不重复、totalRounds 正确）
 *   FIX-2  readJsonBody 超限 → 抛带码错误且**不再 destroy 请求**（客户端能读到失败体）
 *   FIX-3  authorize 端口一致性（localhost ↔ 127.0.0.1 hostname 等价但端口必须相等）
 *   FIX-5  sleep() 进入即已取消 → 立即返回
 *   FIX-6  validateRunOptions：strict 必须 count=3
 *   FIX-7  MAX_PARALLEL = 3 且 parallel 被夹到 3（不再静默降为 2）
 *   FIX-8  回环白名单放宽到 127/8 与 ::ffff:127/8
 *
 * HTTP 层的活体验证（真机请求）见 tools/live-probe.mjs 与 FIX-A 报告。
 */

process.env.DSH_FINGERPRINT_NO_PREWARM = '1'; // 避免 import 期触发 lmfpd 预热

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ H2：把历史文件重定向到临时目录 —— 绝不允许测试碰到真机的
// %LOCALAPPDATA%\dsh-fingerprint\history.jsonl（history.js 每次调用重读该 env）。
const HISTORY_TMP_DIR = await mkdtemp(join(tmpdir(), 'dsh-fp-idx-'));
const HISTORY_GOOD = join(HISTORY_TMP_DIR, 'history.jsonl');
process.env.DSH_FINGERPRINT_HISTORY = HISTORY_GOOD;
after(async () => {
  await rm(HISTORY_TMP_DIR, { recursive: true, force: true });
});

const mod = await import('../lib/index.js');
const {
  BODY_TOO_LARGE,
  MAX_BODY_BYTES,
  MAX_PARALLEL,
  authorize,
  buildHistoryRecords,
  buildInterruptedRecords,
  buildRunItems,
  buildTasks,
  clearRunSidecar,
  currentProcessStartedAt,
  failure,
  historyState,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_RECORD_KEYS,
  INTERRUPTED_ERROR,
  isLoopbackAddress,
  isLoopbackHost,
  isSameProcess,
  noteHistoryError,
  parseHistoryQuery,
  parseRunOptions,
  persistRunHistory,
  PROCESS_STARTED_AT_TOLERANCE_MS,
  readJsonBody,
  recoverInterruptedRuns,
  routeHistory,
  routeHistoryClear,
  routeHistoryModels,
  routeStatus,
  runPool,
  sidecarApi,
  sleep,
  validateRunOptions,
  writeRunSidecar,
} = mod;

/** 造一个最小的假请求（authorize 只读 method / headers / socket.remoteAddress）。 */
function fakeRequest({ method = 'GET', host = '127.0.0.1:2418', origin, referer, secFetchSite, remoteAddress = '127.0.0.1' } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
  return { method, headers, socket: { remoteAddress } };
}

const allowed = (request) => authorize(request) === true;
const denied = (request) => {
  const result = authorize(request);
  return result !== true && result.status === 403;
};

// ── FIX-1：重复 target 去重 ────────────────────────────────────────────────

test('FIX-1：parseRunOptions 按 provider+model 去重并保留首次出现顺序', () => {
  const options = parseRunOptions({
    targets: [
      { provider: 'provider_a', model: 'a' },
      { provider: 'provider_b', model: 'b' },
      { provider: 'provider_a', model: 'a' }, // 完全重复
      { provider: 'provider_a', model: 'c' }, // 同 provider 不同 model：不算重复
      { provider: 'provider_b', model: 'b' }, // 完全重复
    ],
    rounds: 2,
  });
  assert.deepEqual(options.targets, [
    { provider: 'provider_a', model: 'a' },
    { provider: 'provider_b', model: 'b' },
    { provider: 'provider_a', model: 'c' },
  ]);
});

test('FIX-1：buildTasks 计数 = 去重后目标数 × 轮数，totalRounds 正确，索引全覆盖', () => {
  const { targets } = parseRunOptions({
    targets: [
      { provider: 'provider_a', model: 'a' },
      { provider: 'provider_a', model: 'a' }, // 重复
      { provider: 'provider_b', model: 'b' },
    ],
    rounds: 3,
  });
  const { tasks, index } = buildTasks(targets, 3);
  assert.equal(tasks.length, 6, '2 个目标 × 3 轮'); // 旧实现会按 3 个目标建 9 条
  assert.equal(index.size, 6);
  assert.ok(tasks.every((task) => task.totalRounds === 3), 'totalRounds 不得翻倍');
  assert.ok(tasks.every((task) => task.state === 'queued'));
  for (const target of targets) {
    for (let round = 1; round <= 3; round += 1) {
      const task = index.get(`${target.provider}\u0000${target.model}\u0000${String(round)}`);
      assert.notEqual(task, undefined, `${target.provider}/${target.model} 第 ${String(round)} 轮必须有 task`);
      assert.equal(task.round, round);
      assert.equal(task.provider, target.provider);
    }
  }
  // 索引里的每个 task 都必须能在 tasks 数组里找到（不存在“孤儿 task”）
  for (const task of index.values()) assert.ok(tasks.includes(task));
});

test('FIX-1：每个 task 只被索引一次（重复 target 不再共享/错位）', () => {
  const { targets } = parseRunOptions({ targets: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }], rounds: 2 });
  assert.equal(targets.length, 1);
  const { tasks, index } = buildTasks(targets, 2);
  assert.equal(new Set(tasks).size, tasks.length, 'task 对象互不相同');
  assert.equal(index.size, 2);
  // 同一 (target, round) 只能指向一个 task
  assert.equal(index.get('p\u0000m\u00001'), tasks[0]);
  assert.equal(index.get('p\u0000m\u00002'), tasks[1]);
});

test('FIX-1：空 targets / 缺字段仍然被拒', () => {
  assert.throws(() => parseRunOptions({ targets: [] }), /targets 不能为空/);
  assert.throws(() => parseRunOptions({ targets: [{ provider: 'provider_a' }] }), /必须同时给 provider 与 model/);
  assert.throws(() => parseRunOptions({ targets: [{ model: 'm' }] }), /必须同时给 provider 与 model/);
});

// ── FIX-7：并发上限 3 ─────────────────────────────────────────────────────

test('FIX-7：MAX_PARALLEL=3，parallel 被夹到 [1,3]（不再静默降为 2）', () => {
  assert.equal(MAX_PARALLEL, 3);
  assert.equal(parseRunOptions({ targets: [{ provider: 'p', model: 'm' }], parallel: 3 }).parallel, 3);
  assert.equal(parseRunOptions({ targets: [{ provider: 'p', model: 'm' }], parallel: 9 }).parallel, 3);
  assert.equal(parseRunOptions({ targets: [{ provider: 'p', model: 'm' }], parallel: 0 }).parallel, 1);
  assert.equal(parseRunOptions({ targets: [{ provider: 'p', model: 'm' }] }).parallel, 3, '缺省即上限 3');
});

// ── FIX-6：strict 前置校验 ────────────────────────────────────────────────

test('FIX-6：strict 要求 count=3，否则给出可读拒绝原因', () => {
  assert.equal(validateRunOptions({ strict: true, count: 3 }), null);
  assert.equal(validateRunOptions({ strict: false, count: 1 }), null, '非 strict 不限制');
  const message = validateRunOptions({ strict: true, count: 1 });
  assert.equal(typeof message, 'string');
  assert.match(message, /count=3/);
  assert.match(message, /count=1/);
});

// ── FIX-2：超限请求体 ─────────────────────────────────────────────────────

test('FIX-2：readJsonBody 超限 → 抛 BODY_TOO_LARGE，且**不 destroy** 请求', async () => {
  const request = new EventEmitter();
  let destroyed = false;
  request.destroy = () => {
    destroyed = true;
  };
  const promise = readJsonBody(request);
  // 分片推入 80KB（上限 64KB）
  const chunk = Buffer.alloc(16 * 1024, 0x61);
  for (let i = 0; i < 5; i += 1) request.emit('data', chunk);
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, BODY_TOO_LARGE);
    assert.match(error.message, /超过上限/);
    return true;
  });
  assert.equal(destroyed, false, '超限时不得 destroy 请求（否则客户端读不到失败体）');
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
});

test('FIX-2：超限后继续到来的分片被丢弃且不二次 reject', async () => {
  const request = new EventEmitter();
  request.destroy = () => {};
  const promise = readJsonBody(request);
  request.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
  await assert.rejects(promise, (error) => error.code === BODY_TOO_LARGE);
  // 之后再发 data / end 不应产生未处理的二次 reject
  request.emit('data', Buffer.alloc(1024));
  request.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
});

test('FIX-2：正常请求体仍能解析（空体 → {}，非法 JSON → 可读错误）', async () => {
  const ok = new EventEmitter();
  const promise = readJsonBody(ok);
  ok.emit('data', Buffer.from('{"a":1}', 'utf8'));
  ok.emit('end');
  assert.deepEqual(await promise, { a: 1 });

  const empty = new EventEmitter();
  const emptyPromise = readJsonBody(empty);
  empty.emit('end');
  assert.deepEqual(await emptyPromise, {});

  const bad = new EventEmitter();
  const badPromise = readJsonBody(bad);
  bad.emit('data', Buffer.from('not json', 'utf8'));
  bad.emit('end');
  await assert.rejects(badPromise, /不是合法 JSON/);
});

// ── FIX-3：端口一致性 ─────────────────────────────────────────────────────

test('FIX-3：localhost ↔ 127.0.0.1 的 hostname 等价仍被接受（同端口）', () => {
  assert.ok(allowed(fakeRequest({ origin: 'http://localhost:2418', host: '127.0.0.1:2418' })));
  assert.ok(allowed(fakeRequest({ origin: 'http://127.0.0.1:2418', host: 'localhost:2418' })));
  assert.ok(allowed(fakeRequest({ origin: 'http://127.0.0.1:2418', host: '127.0.0.1:2418' })));
  assert.ok(allowed(fakeRequest({ origin: 'http://localhost:2418', host: 'localhost:2418' })));
});

test('FIX-3：端口不一致必须拒绝（本机任意端口页面不得驱动 /run）', () => {
  assert.ok(denied(fakeRequest({ origin: 'http://localhost:9999', host: '127.0.0.1:2418' })));
  assert.ok(denied(fakeRequest({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:2418' })));
  assert.ok(denied(fakeRequest({ origin: 'http://127.0.0.1:2418', host: '127.0.0.1:9999' })));
  const result = authorize(fakeRequest({ origin: 'http://localhost:9999', host: '127.0.0.1:2418' }));
  assert.match(result.body.error.message, /端口与 Host 不一致/);
});

test('FIX-3：非回环 Origin / Referer / 跨站 / Host 依然全部拒绝', () => {
  assert.ok(denied(fakeRequest({ origin: 'http://evil.example' })));
  assert.ok(denied(fakeRequest({ origin: 'http://evil.example:2418' })));
  assert.ok(denied(fakeRequest({ origin: 'null' })));
  assert.ok(denied(fakeRequest({ secFetchSite: 'cross-site' })));
  assert.ok(denied(fakeRequest({ host: 'example.com' })));
  assert.ok(denied(fakeRequest({ referer: 'http://evil.example/x', host: '127.0.0.1:2418' })));
  assert.ok(allowed(fakeRequest({ referer: 'http://127.0.0.1:2418/page' })));
});

test('FIX-3：默认端口归一化（无端口的 Origin 与 Host 视为同端口）', () => {
  assert.ok(allowed(fakeRequest({ origin: 'http://localhost', host: '127.0.0.1' })));
});

// ── FIX-8：回环白名单 + 方法白名单 ────────────────────────────────────────

test('FIX-8：回环白名单放宽到 127/8 与 ::ffff:127/8，非回环仍拒', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true);
  assert.equal(isLoopbackAddress('127.255.255.254'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.9.9.9'), true);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('128.0.0.1'), false);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackHost('127.0.0.5:2418'), true);
  assert.equal(isLoopbackHost('127.0.0.1:2418'), true);
  assert.equal(isLoopbackHost('127.0.0.1:9999'), true);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('[::1]:2418'), true);

  assert.ok(allowed(fakeRequest({ remoteAddress: '127.9.9.9' })));
  assert.ok(denied(fakeRequest({ remoteAddress: '192.168.1.5' })));
  const result = authorize(fakeRequest({ method: 'DELETE' }));
  assert.equal(result.status, 405);
});

// ── FIX-5：sleep 的初始取消 ───────────────────────────────────────────────

test('FIX-5：signal 已取消 → sleep 立即返回（不再等满 gapSec）', async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  await sleep(120000, controller.signal); // 120s，若未修会挂住测试
  assert.ok(Date.now() - startedAt < 200, '必须立即返回');
});

test('FIX-5：sleep 在等待中被取消也会立即返回；正常情况按时返回', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 30);
  await sleep(120000, controller.signal);
  assert.ok(Date.now() - startedAt < 500);

  const normalStart = Date.now();
  await sleep(40);
  assert.ok(Date.now() - normalStart >= 30);
});

// ── P1（§28.2）：并发单位 = (目标 × 轮次) ──────────────────────────────────

test('P1：buildRunItems 把队列展平成 (目标 × 轮次)，按目标、再按轮次升序', () => {
  const { targets } = parseRunOptions({
    targets: [
      { provider: 'provider_a', model: 'a' },
      { provider: 'provider_b', model: 'b' },
    ],
    rounds: 3,
  });
  const { tasks, index } = buildTasks(targets, 3);
  const items = buildRunItems({ targets, options: { rounds: 3 }, taskIndex: index });
  assert.equal(items.length, 6, '2 目标 × 3 轮');
  assert.deepEqual(
    items.map((item) => `${item.target.provider}#${String(item.round)}`),
    ['provider_a#1', 'provider_a#2', 'provider_a#3', 'provider_b#1', 'provider_b#2', 'provider_b#3'],
  );
  assert.ok(items.every((item) => tasks.includes(item.task)), '必须复用 taskIndex 里的同一个 task 对象');
});

test('P1：单模型 3 轮 + parallel=3 → 峰值并发 3（旧实现恒为 1，轮次被串行）', async () => {
  const target = { provider: 'provider_a', model: 'a' };
  const { targets } = parseRunOptions({ targets: [target], rounds: 3 });
  const { index } = buildTasks(targets, 3);
  const items = buildRunItems({ targets, options: { rounds: 3 }, taskIndex: index });
  const parallel = parseRunOptions({ targets: [target], rounds: 3, parallel: 3 }).parallel;
  assert.equal(items.length, 3, '只有 1 个目标也必须展开成 3 个轮次项');
  const result = await runPool(items, parallel, async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  assert.equal(result.started, 3);
  assert.equal(result.peak, 3, '3 轮必须同时在跑（这正是操作者反馈的缺陷）');
});

test('P1：parallel=1 → 仍严格顺序（峰值并发 1）', async () => {
  const { targets } = parseRunOptions({ targets: [{ provider: 'provider_a', model: 'a' }], rounds: 3 });
  const { index } = buildTasks(targets, 3);
  const items = buildRunItems({ targets, options: { rounds: 3 }, taskIndex: index });
  const result = await runPool(items, 1, async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  assert.equal(result.peak, 1);
});

test('P1：runPool 的峰值并发 ≤ workerCount，且 shouldStop 立即停止派发', async () => {
  const items = [1, 2, 3, 4, 5];
  const seen = [];
  const result = await runPool(items, 2, async (item) => {
    seen.push(item);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(result.peak, 2);
  assert.equal(seen.length, 5);

  const skipped = await runPool(
    items,
    3,
    async () => {
      throw new Error('不应被调用');
    },
    () => true,
  );
  assert.equal(skipped.peak, 0, '已取消时一项都不派发');

  const capped = await runPool([1], 3, async () => {});
  assert.equal(capped.peak, 1, 'worker 数不超过项数');
});

// ── P2（§28.3）：BUSY 必须可恢复 ──────────────────────────────────────────

test('P2：failure 可附带结构化 runId，且 code/message 不被 extra 覆盖', () => {  const busy = failure('BUSY', '已有运行中任务：r-7', { runId: 'r-7' });
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'BUSY');
  assert.equal(busy.error.message, '已有运行中任务：r-7');
  assert.equal(busy.error.runId, 'r-7', 'BUSY 必须带可用 runId（客户端据此接上旧任务）');

  const clobber = failure('BUSY', 'msg', { code: 'EVIL', message: 'EVIL' });
  assert.equal(clobber.error.code, 'BUSY', 'extra 不得覆盖 code');
  assert.equal(clobber.error.message, 'msg', 'extra 不得覆盖 message');

  assert.deepEqual(failure('NOT_FOUND', 'x'), { ok: false, error: { code: 'NOT_FOUND', message: 'x' } });
  assert.deepEqual(failure('INVALID_OPTIONS', 'y'), { ok: false, error: { code: 'INVALID_OPTIONS', message: 'y' } });
});

test('P2：GET /status 暴露 activeRunId —— 客户端据此恢复被 BUSY 挡住的运行', async () => {
  /** 极小假响应：捕获 writeHead / end 的内容。 */
  const captured = { status: null, body: '' };
  const response = {
    writeHead(status) {
      captured.status = status;
    },
    end(payload) {
      captured.body = payload;
    },
  };
  await routeStatus(response); // FIX-A2：routeStatus 现在是 async（要读侧车）
  const body = JSON.parse(captured.body);
  assert.equal(captured.status, 200);
  assert.equal(body.ok, true);
  assert.ok(Object.hasOwn(body, 'activeRunId'), '/status 必须带 activeRunId 字段（无运行中时为 null）');
  assert.equal(body.activeRunId, null, '此刻没有运行中的任务');
  assert.equal(typeof body.detector, 'object', 'detector 块形状不变');
  assert.equal(Object.hasOwn(body.detector, 'ready'), true);
});

// ══════════════════════════════════════════════════════════════════════════
// H2（契约 §29 / §31.2）：检测历史
// ══════════════════════════════════════════════════════════════════════════

const { appendRecords, clearHistory, readHistory } = await import('../lib/history.js');

/** 造一个 run（默认 2 目标、3 轮）。 */
function fakeRun(overrides = {}) {
  return {
    runId: 'r-9',
    phase: 'done',
    options: { rounds: 3, count: 3, parallel: 3, strict: false, timeoutSec: 120, gapSec: 0 },
    targets: [
      { provider: 'provider_a', model: 'm-a' },
      { provider: 'provider_b', model: 'm-b' },
    ],
    results: [],
    error: null,
    finishedAt: Date.parse('2026-11-02T06:30:00.000Z'),
    ...overrides,
  };
}

/** 造一个聚合结果（camelCase，§9.1 形状 —— **顶层数值字段是 `confidence`**）。 */
function fakeAggregate(overrides = {}) {
  return {
    decision: 'scored',
    prediction: 'p-1',
    predictionName: 'P One',
    family: 'fam',
    familyName: 'Fam Name',
    confidence: 0.9,
    agreement: 1,
    stability: 'stable',
    validRounds: 3,
    totalRounds: 3,
    probabilityStatus: null,
    ...overrides,
  };
}

/** 捕获式假响应。 */
function fakeCapture() {
  const state = { status: null, body: '' };
  return {
    response: {
      writeHead(status) {
        state.status = status;
      },
      end(payload) {
        state.body = payload;
      },
    },
    body: () => state.body,
    status: () => state.status,
  };
}

test('H2：buildHistoryRecords —— 2 目标 → 2 条，逐键对齐 §29.3（18 键，camelCase 直映）', () => {
  const run = fakeRun({
    results: [
      { provider: 'provider_a', model: 'm-a', aggregate: fakeAggregate() },
      { provider: 'provider_b', model: 'm-b', aggregate: fakeAggregate({ prediction: 'p-2', predictionName: 'P Two' }) },
    ],
  });
  const records = buildHistoryRecords(run);
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[0]), HISTORY_RECORD_KEYS, '键集合与顺序都要逐字对齐契约');
  assert.equal(Object.keys(records[0]).length, 18);
  assert.equal(records[0].v, 1);
  assert.equal(records[0].ts, '2026-11-02T06:30:00.000Z', 'ts 用 finishedAt 的 ISO');
  assert.equal(records[0].runId, 'r-9');
  assert.equal(records[0].provider, 'provider_a');
  assert.equal(records[0].model, 'm-a');
  assert.equal(records[0].predictionName, 'P One', 'camelCase 直映，不读 snake_case');
  assert.equal(records[0].familyName, 'Fam Name');
  assert.equal(records[0].probability, 0.9);
  assert.equal(records[0].agreement, 1);
  assert.equal(records[0].validRounds, 3);
  assert.equal(records[0].totalRounds, 3);
  assert.equal(records[0].error, null);
  assert.equal(records[1].model, 'm-b');
  assert.equal(records[1].prediction, 'p-2');
});

test('H2：aggregate 为 null（取消/失败）→ 仍每个目标一条记录，取安全默认且不抛', () => {
  let records = null;
  assert.doesNotThrow(() => {
    records = buildHistoryRecords(fakeRun({ results: [{ provider: 'provider_a', model: 'm-a', aggregate: null }], error: '取样异常：x', phase: 'failed' }));
  });
  assert.equal(records.length, 2, '按 targets 产出 —— results 缺失时也要每个目标一条');
  for (const record of records) {
    assert.equal(record.decision, 'unscorable');
    assert.equal(record.stability, 'inconclusive');
    assert.equal(record.validRounds, 0);
    assert.equal(record.totalRounds, 3, '退化到 options.rounds');
    assert.equal(record.prediction, null);
    assert.equal(record.predictionName, null);
    assert.equal(record.probability, null);
    assert.equal(record.agreement, null);
    assert.equal(record.error, '取样异常：x', 'run 级失败原因如实记录');
  }
  // 极端脏输入也不抛
  for (const dirty of [null, undefined, {}, { targets: null }, { targets: [null, 42], options: null }, { targets: [{ provider: '', model: 'm' }] }]) {
    assert.doesNotThrow(() => buildHistoryRecords(dirty), `buildHistoryRecords(${JSON.stringify(dirty)}) 不得抛`);
  }
  assert.deepEqual(buildHistoryRecords({ targets: [{ provider: '', model: 'm' }] }), [], '缺 provider 的目标被跳过（history.js 会丢弃它）');
});

test('H2：options 只含 {rounds,count,parallel,strict}（不含 timeoutSec / gapSec）', () => {
  for (const record of buildHistoryRecords(fakeRun())) {
    assert.deepEqual(Object.keys(record.options).sort(), ['count', 'parallel', 'rounds', 'strict']);
    assert.equal(Object.hasOwn(record.options, 'timeoutSec'), false);
    assert.equal(Object.hasOwn(record.options, 'gapSec'), false);
  }
});

test('H2：写历史失败绝不影响 run 终态（注入抛错的 append）', async () => {
  const run = fakeRun({ phase: 'done', finishedAt: Date.now() });
  const before = { phase: run.phase, finishedAt: run.finishedAt, error: run.error, results: run.results.length };
  const warnings = [];
  const ctx = { logger: { warn: (message) => warnings.push(String(message)) } };

  const hard = await persistRunHistory(ctx, run, async () => {
    throw new Error('disk on fire');
  });
  assert.equal(hard.ok, false);
  assert.match(String(hard.error), /disk on fire/);
  assert.deepEqual(
    { phase: run.phase, finishedAt: run.finishedAt, error: run.error, results: run.results.length },
    before,
    'run 的终态字段一个都不能被改动',
  );
  assert.equal(warnings.length, 1, '失败只记一条 warn');

  const soft = await persistRunHistory(ctx, run, async () => ({ ok: false, error: 'bad path' }));
  assert.equal(soft.ok, false);
  assert.match(String(soft.error), /bad path/);

  const good = await persistRunHistory(ctx, run, async (records) => ({ ok: true, appended: records.length }));
  assert.deepEqual(good, { ok: true, count: 2, error: null });

  // 连 ctx.logger 都不可用也必须不抛
  await assert.doesNotReject(() => persistRunHistory(undefined, run, async () => {
    throw new Error('no logger');
  }));
});

test('H2：/history 与 /history/models 必须带 stats.error（读失败的唯一诊断出口）', async () => {
  const blockFile = join(HISTORY_TMP_DIR, 'not-a-dir');
  await writeFile(blockFile, 'x', 'utf8');
  process.env.DSH_FINGERPRINT_HISTORY = join(blockFile, 'history.jsonl'); // 父级是文件 ⇒ §31.3 #2 的坏路径

  const badHistory = fakeCapture();
  await routeHistory(undefined, badHistory.response);
  const badHistoryBody = JSON.parse(badHistory.body());
  assert.equal(badHistoryBody.ok, true);
  assert.deepEqual(badHistoryBody.records, []);
  assert.equal(typeof badHistoryBody.stats.error, 'string', '读失败必须透出 stats.error');
  assert.notEqual(badHistoryBody.stats.error, '');

  const badModels = fakeCapture();
  await routeHistoryModels(badModels.response);
  const badModelsBody = JSON.parse(badModels.body());
  assert.deepEqual(badModelsBody.models, []);
  assert.equal(typeof badModelsBody.stats.error, 'string', '/models 同样要透出 stats.error（H2 追加要求）');

  // 正常路径：真写一条，再读
  process.env.DSH_FINGERPRINT_HISTORY = HISTORY_GOOD;
  const written = await appendRecords(
    buildHistoryRecords(
      fakeRun({ results: [{ provider: 'provider_a', model: 'm-a', aggregate: fakeAggregate({ validRounds: 1, totalRounds: 1 }) }] }),
    ),
  );
  assert.equal(written.ok, true, `写入应成功：${JSON.stringify(written)}`);

  const goodHistory = fakeCapture();
  await routeHistory(new URLSearchParams('limit=1&provider=provider_a'), goodHistory.response);
  const goodHistoryBody = JSON.parse(goodHistory.body());
  assert.equal(goodHistoryBody.records.length, 1, 'provider=provider_a 过滤 + limit=1 生效');
  assert.equal(goodHistoryBody.records[0].provider, 'provider_a');
  assert.equal(goodHistoryBody.stats.error, null, '正常读：error 为 null（与"空历史"区分得开）');
  // ⚠️ stats.count 是**文件总量**，与 provider/limit 过滤无关（本次写了 2 条：provider_a/m-a + provider_b/m-b）
  assert.equal(goodHistoryBody.stats.count, 2);
  assert.equal(goodHistoryBody.records.length < goodHistoryBody.stats.count, true, '过滤后的视图小于文件总量');

  const goodModels = fakeCapture();
  await routeHistoryModels(goodModels.response);
  const goodModelsBody = JSON.parse(goodModels.body());
  assert.equal(goodModelsBody.models.length, 2, '两个目标 → 两个模型行');
  // 两条记录 ts 相同 ⇒ 按 provider 字典序做确定性兜底：provider_a 在前
  assert.equal(goodModelsBody.models[0].provider, 'provider_a');
  assert.equal(goodModelsBody.models[0].model, 'm-a');
  assert.equal(goodModelsBody.models[0].runs, 1);
  assert.equal(goodModelsBody.models[0].lastPrediction, 'p-1');
  assert.equal(goodModelsBody.stats.error, null);
  assert.equal(goodModelsBody.stats.count, 2);
});

test('H2：POST /history/clear 的 removed 与"清空后仍是空历史（非读失败）"', async () => {
  process.env.DSH_FINGERPRINT_HISTORY = HISTORY_GOOD;
  const written = await appendRecords(buildHistoryRecords(fakeRun()));
  assert.equal(written.ok, true);

  const cleared = fakeCapture();
  await routeHistoryClear(cleared.response);
  const body = JSON.parse(cleared.body());
  assert.equal(body.ok, true);
  assert.equal(typeof body.removed, 'number');
  assert.ok(body.removed >= 1, '应清掉刚写进去的记录');

  const after = fakeCapture();
  await routeHistory(undefined, after.response);
  const afterBody = JSON.parse(after.body());
  assert.equal(afterBody.records.length, 0);
  assert.equal(afterBody.stats.error, null, '清空后是「空历史」而不是「读失败」—— 这两者必须分得开');
});

test('H2：parseHistoryQuery —— limit 钳到 1–200（非法走默认），过滤透传、空串不过滤', () => {
  assert.equal(HISTORY_LIMIT_DEFAULT, 50);
  assert.equal(HISTORY_LIMIT_MAX, 200);
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('')), { limit: 50 });
  assert.deepEqual(parseHistoryQuery(undefined), { limit: 50 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=7')), { limit: 7 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=999')), { limit: 200 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=0')), { limit: 50 }, 'limit=0 非法 → 默认');
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=-5')), { limit: 50 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=abc')), { limit: 50 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('limit=12.7')), { limit: 12 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('provider=provider_a&model=m-a')), { limit: 50, provider: 'provider_a', model: 'm-a' });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('provider=&model=')), { limit: 50 }, '空串视为不过滤');
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('provider=provider_a')), { limit: 50, provider: 'provider_a' });
});

// ══════════════════════════════════════════════════════════════════════════
// FIX-A2（契约 §55）：运行中侧车 → 中断恢复 → 写历史失败可见
// ══════════════════════════════════════════════════════════════════════════

/** 造一个"上一个进程留下的"侧车 descriptor（远古 processStartedAt + 陌生 pid）。 */
function deadDescriptor(overrides = {}) {
  return {
    v: 1,
    runId: 'r-dead',
    startedAt: '2026-11-03T00:40:00.000Z',
    pid: 999999,
    processStartedAt: 1,
    options: { rounds: 2, count: 3, parallel: 2, strict: false },
    targets: [
      { provider: 'provider_a', model: 'm-a' },
      { provider: 'provider_b', model: 'm-b' },
    ],
    ...overrides,
  };
}

/** 可注入的侧车实现 + 调用计数（W5 未落盘时也能离线验逻辑）。 */
function fakeSidecar(descriptor) {
  const state = { reads: 0, clears: 0, cleared: false };
  return {
    state,
    api: {
      write: null,
      read: async () => {
        state.reads += 1;
        return descriptor;
      },
      clear: async () => {
        state.clears += 1;
        state.cleared = true;
        return { ok: true, removed: true, error: null };
      },
    },
  };
}

/** 静默 ctx（logger.warn 不计分）。 */
const quietCtx = () => ({ logger: { warn() {} } });

test('FIX-A2①：buildInterruptedRecords —— 2 目标 → 2 条，18 键逐字对齐 §55.5 B 的冻结取值（§61 后 +probabilityStatus）', () => {
  const records = buildInterruptedRecords(deadDescriptor());
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[0]), HISTORY_RECORD_KEYS, '键集合与顺序都要逐字对齐');
  assert.equal(Object.keys(records[0]).length, 18);
  assert.equal(records[0].v, 1);
  assert.equal(records[0].ts, '2026-11-03T00:40:00.000Z', 'ts 取自 descriptor.startedAt');
  assert.equal(records[0].runId, 'r-dead');
  assert.equal(records[0].provider, 'provider_a');
  assert.equal(records[0].model, 'm-a');
  assert.equal(records[0].decision, 'unscorable');
  assert.equal(records[0].validRounds, 0);
  assert.equal(records[0].totalRounds, 2, 'totalRounds 取自 options.rounds');
  assert.equal(records[0].stability, 'inconclusive');
  assert.equal(records[0].prediction, null);
  assert.equal(records[0].predictionName, null);
  assert.equal(records[0].family, null);
  assert.equal(records[0].familyName, null);
  assert.equal(records[0].probability, null);
  assert.equal(records[0].agreement, null);
  assert.equal(records[0].error, INTERRUPTED_ERROR);
  assert.match(records[0].error, /^interrupted: /, 'error 必须非空且带 interrupted: 前缀');
  assert.deepEqual(Object.keys(records[0].options).sort(), ['count', 'parallel', 'rounds', 'strict']);
  assert.equal(records[1].provider, 'provider_b');
  assert.equal(records[1].model, 'm-b');
  // 任意 provider/model 名都要能写（不做生态校验）
  const exotic = buildInterruptedRecords(deadDescriptor({ targets: [{ provider: '完全不在生态里的名字', model: '也不在' }] }));
  assert.equal(exotic.length, 1);
  assert.equal(exotic[0].provider, '完全不在生态里的名字');
  // reason 可覆盖
  assert.equal(buildInterruptedRecords(deadDescriptor(), 'interrupted: 自定义')[0].error, 'interrupted: 自定义');
  // 脏输入不抛
  for (const dirty of [null, undefined, {}, { targets: null }, { targets: [null, 42] }, { options: null }]) {
    assert.doesNotThrow(() => buildInterruptedRecords(dirty), `buildInterruptedRecords(${JSON.stringify(dirty)}) 不得抛`);
  }
  assert.deepEqual(buildInterruptedRecords({ targets: [{ provider: '', model: 'm' }] }), [], '缺 provider 的 target 被跳过');
});

test('FIX-A2②：恢复幂等 —— 已有同 runId 的记录 ⇒ skipped 计数正确且不产生重复', async () => {
  await clearHistory();
  await appendRecords(buildHistoryRecords(fakeRun({ runId: 'r-dead' }))); // 先落 2 条同 runId 的记录
  assert.equal((await readHistory({})).length, 2);

  const { api, state } = fakeSidecar(deadDescriptor());
  const result = await recoverInterruptedRuns(quietCtx(), api);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 2, '2 个 target 全因 runId 已存在而跳过');
  assert.equal(result.appended, 0, '绝不能重复写');
  const all = await readHistory({});
  assert.equal(all.length, 2, '记录数不变（无重复）');
  assert.equal(all.filter((record) => record.runId === 'r-dead').length, 2);
  assert.equal(state.clears, 1, '即使全部跳过，也要清侧车');
});

test('FIX-A2③：processStartedAt 相同（同进程重组合）⇒ 不恢复，且侧车不得被删除', async () => {
  await clearHistory();
  const live = deadDescriptor({ pid: process.pid, processStartedAt: currentProcessStartedAt() });
  const { api, state } = fakeSidecar(live);
  const result = await recoverInterruptedRuns(quietCtx(), api);
  assert.equal(result.appended, 0, '那个 run 可能还在跑，绝不能写"被打断"');
  assert.equal(result.skipped, 0);
  assert.equal(result.ok, true);
  assert.equal(state.clears, 0, '侧车必须保留');
  assert.equal(state.cleared, false);
  assert.equal((await readHistory({})).length, 0, 'history 里一条都不能多');
});

test('FIX-A2④：processStartedAt 不同（进程真的重启过）⇒ 每 target 一条 interrupted，且侧车被删', async () => {
  await clearHistory();
  const { api, state } = fakeSidecar(deadDescriptor());
  const result = await recoverInterruptedRuns(quietCtx(), api);
  assert.equal(result.ok, true);
  assert.equal(result.appended, 2);
  assert.equal(result.skipped, 0);
  assert.equal(state.clears, 1);
  assert.equal(state.cleared, true);

  const all = await readHistory({});
  assert.equal(all.length, 2);
  for (const record of all) {
    assert.equal(record.runId, 'r-dead');
    assert.equal(record.error, INTERRUPTED_ERROR);
    assert.equal(record.decision, 'unscorable');
    assert.equal(record.validRounds, 0);
    assert.equal(record.totalRounds, 2);
    assert.equal(record.ts, '2026-11-03T00:40:00.000Z');
  }
  // 端到端：经真实 /history 路由读回（写盘 → 读回）
  const capture = fakeCapture();
  await routeHistory(undefined, capture.response);
  const body = JSON.parse(capture.body());
  assert.equal(body.records.length, 2);
  assert.equal(body.records[0].error, INTERRUPTED_ERROR);
  assert.equal(body.stats.error, null);
});

test('FIX-A2⑤：写历史失败 ⇒ lastHistoryError 非空（缺口 B 可见化），且 run 终态不变', async () => {
  const before = historyState.lastHistoryError;
  historyState.lastHistoryError = null;
  try {
    const run = fakeRun({ phase: 'done', finishedAt: Date.now() });
    const snapshot = { phase: run.phase, finishedAt: run.finishedAt, error: run.error, results: run.results.length };
    const result = await persistRunHistory(quietCtx(), run, async () => {
      throw new Error('disk on fire');
    });
    assert.equal(result.ok, false);
    assert.notEqual(historyState.lastHistoryError, null, '缺口 B：失败必须可见');
    assert.equal(typeof historyState.lastHistoryError.at, 'string');
    assert.match(historyState.lastHistoryError.message, /disk on fire/);
    assert.deepEqual(
      { phase: run.phase, finishedAt: run.finishedAt, error: run.error, results: run.results.length },
      snapshot,
      'run 终态字段一个都不能被改动',
    );
    // 一次失败必须留痕到进程结束：后续成功**不能**把它冲掉
    await persistRunHistory(quietCtx(), run, async () => ({ ok: true }));
    assert.notEqual(historyState.lastHistoryError, null, 'lastHistoryError 一旦设置就保留');
    assert.match(historyState.lastHistoryError.message, /disk on fire/);
    // 软失败（append 返回 ok:false）也要留痕
    historyState.lastHistoryError = null;
    await persistRunHistory(quietCtx(), run, async () => ({ ok: false, error: 'bad path' }));
    assert.match(historyState.lastHistoryError.message, /bad path/);
  } finally {
    historyState.lastHistoryError = before;
  }
});

test('FIX-A2⑥：/status 的 activeRun 与 sameProcess 两种值各一次；读侧车抛错仍是 200', async () => {
  const live = deadDescriptor({
    runId: 'r-live',
    pid: process.pid,
    processStartedAt: currentProcessStartedAt(),
    targets: [{ provider: 'provider_a', model: 'm-a' }],
  });
  const c1 = fakeCapture();
  await routeStatus(c1.response, { write: null, read: async () => live, clear: null });
  assert.equal(c1.status(), 200);
  const b1 = JSON.parse(c1.body());
  assert.equal(b1.activeRun.sameProcess, true, '同进程 ⇒ true（宿主侧有一个任务在运行）');
  assert.equal(b1.activeRun.runId, 'r-live');
  assert.equal(b1.activeRun.startedAt, '2026-11-03T00:40:00.000Z');
  assert.deepEqual(b1.activeRun.targets, [{ provider: 'provider_a', model: 'm-a' }]);
  assert.deepEqual(b1.activeRun.options, live.options);

  const c2 = fakeCapture();
  await routeStatus(c2.response, { write: null, read: async () => ({ ...live, pid: 999999, processStartedAt: 1 }), clear: null });
  const b2 = JSON.parse(c2.body());
  assert.equal(b2.activeRun.sameProcess, false, '异进程 ⇒ false（上次未完成）');

  const c3 = fakeCapture();
  await routeStatus(c3.response, {
    write: null,
    read: async () => {
      throw new Error('sidecar boom');
    },
    clear: null,
  });
  assert.equal(c3.status(), 200, '读侧车失败绝不能把 /status 变成非 200');
  assert.equal(JSON.parse(c3.body()).activeRun, null);

  const c4 = fakeCapture();
  await routeStatus(c4.response, { write: null, read: null, clear: null });
  assert.equal(c4.status(), 200);
  assert.equal(JSON.parse(c4.body()).activeRun, null, '无侧车 ⇒ null');

  const c5 = fakeCapture();
  await routeStatus(c5.response);
  const b5 = JSON.parse(c5.body());
  assert.ok(Object.hasOwn(b5, 'activeRun'), '/status 必须带 activeRun 字段');
  assert.ok(Object.hasOwn(b5, 'lastHistoryError'), '/status 必须带 lastHistoryError 字段');
  assert.ok(Object.hasOwn(b5, 'activeRunId'), 'activeRunId 必须保留（P2 不回归）');
});

test('FIX-A2⑦：isSameProcess 的容差语义 —— ±1ms 抖动不能误判，真重启必须判出', () => {
  assert.equal(PROCESS_STARTED_AT_TOLERANCE_MS, 1000);
  const now = currentProcessStartedAt();
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now }), true);
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now + 1 }), true, '±1ms 抖动（实测存在）不得误判为"进程已重启"');
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now - 1 }), true);
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now - 60_000 }), false, '真正的进程重启必须判出');
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now + 60_000 }), false);
  assert.equal(isSameProcess({ pid: process.pid + 1, processStartedAt: now }), false, 'pid 不同 ⇒ 不同进程');
  assert.equal(isSameProcess({ processStartedAt: now }), true, 'pid 缺失时不否决（只按时间判）');
  assert.equal(isSameProcess(null), false);
  assert.equal(isSameProcess({}), false);
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: 'not-a-number' }), false);
});

test('FIX-A2⑧：侧车接口未落盘（W5 未合入）⇒ 只降级、不抛、不阻止启动', async () => {
  const empty = { write: null, read: null, clear: null };
  // sidecarApi：从一个没有这三个导出的模块取 ⇒ 三项皆 null
  const api = sidecarApi({ appendRecords, readHistory });
  assert.deepEqual(api, { write: null, read: null, clear: null });
  // 写侧车：不抛，只记 lastHistoryError
  const before = historyState.lastHistoryError;
  historyState.lastHistoryError = null;
  try {
    const written = await writeRunSidecar(quietCtx(), fakeRun(), empty);
    assert.equal(written.ok, false);
    assert.match(historyState.lastHistoryError.message, /writeActiveRun/);
    // 清侧车：未落盘时静默成功
    const cleared = await clearRunSidecar(quietCtx(), empty);
    assert.deepEqual(cleared, { ok: true, removed: false, error: null });
    // 恢复：read 缺失 ⇒ ok:false 但**不抛**
    const recovered = await recoverInterruptedRuns(quietCtx(), empty, async () => ({ ok: true }));
    assert.equal(recovered.ok, false);
    assert.match(recovered.error, /readActiveRun/);
  } finally {
    historyState.lastHistoryError = before;
  }
});

test('FIX-A2⑩（追加1）：/history/models 每行带 lastError —— 与 lastTs 指向同一条记录，字段不省略', async () => {
  // 情形 A：最新记录是"正常跑了但没聚出结果"（error=null）⇒ lastError 必须是 null（但字段仍在）
  await clearHistory();
  await appendRecords(
    buildInterruptedRecords(deadDescriptor({ runId: 'r-old', startedAt: '2026-11-03T00:40:00.000Z', targets: [{ provider: 'provider_a', model: 'm-a' }] })),
  );
  await appendRecords(
    buildHistoryRecords(
      fakeRun({
        runId: 'r-new',
        finishedAt: Date.parse('2026-11-03T02:00:00.000Z'),
        targets: [{ provider: 'provider_a', model: 'm-a' }],
        results: [{ provider: 'provider_a', model: 'm-a', aggregate: null }],
      }),
    ),
  );
  const c1 = fakeCapture();
  await routeHistoryModels(c1.response);
  const b1 = JSON.parse(c1.body());
  assert.equal(b1.models.length, 1);
  assert.ok(Object.hasOwn(b1.models[0], 'lastError'), 'lastError 字段必须存在（不省略）');
  assert.equal(b1.models[0].lastError, null, '最新记录 error=null ⇒ lastError=null');
  assert.equal(b1.models[0].lastTs, '2026-11-03T02:00:00.000Z', 'lastTs 也指向最新那条 ⇒ 两者同源');
  assert.equal(b1.models[0].runs, 2);

  // 情形 B：最新记录是 interrupted ⇒ lastError 带来原文（聚合表才能区分"被打断"与"样本不足"）
  await clearHistory();
  await appendRecords(
    buildHistoryRecords(
      fakeRun({
        runId: 'r-old2',
        finishedAt: Date.parse('2026-11-03T03:00:00.000Z'),
        targets: [{ provider: 'provider_a', model: 'm-a' }],
        results: [{ provider: 'provider_a', model: 'm-a', aggregate: null }],
      }),
    ),
  );
  await appendRecords(
    buildInterruptedRecords(deadDescriptor({ runId: 'r-new2', startedAt: '2026-11-03T04:00:00.000Z', targets: [{ provider: 'provider_a', model: 'm-a' }] })),
  );
  const c2 = fakeCapture();
  await routeHistoryModels(c2.response);
  const b2 = JSON.parse(c2.body());
  assert.equal(b2.models[0].lastError, INTERRUPTED_ERROR);
  assert.match(b2.models[0].lastError, /^interrupted: /);
  assert.equal(b2.models[0].lastTs, '2026-11-03T04:00:00.000Z');
  assert.equal(b2.models[0].lastDecision, 'unscorable');

  // 情形 C：注入 reader 抛错 ⇒ 仍然 200，且 lastError 退化为 null（不抛、不崩）
  const c3 = fakeCapture();
  await routeHistoryModels(
    c3.response,
    async () => {
      throw new Error('read boom');
    },
    async () => [{ provider: 'provider_a', model: 'm-a', lastTs: 'x', runs: 1, lastDecision: 'unscorable' }],
  );
  assert.equal(c3.status(), 200);
  const b3 = JSON.parse(c3.body());
  assert.equal(b3.models[0].lastError, null);
  assert.ok(Object.hasOwn(b3.models[0], 'lastError'), '退化为 null 时字段同样不能省略');

  // 情形 D：多个模型，只有其中一个最新记录带 error ⇒ 只污染那一行
  await clearHistory();
  await appendRecords(
    buildInterruptedRecords({
      ...deadDescriptor({ runId: 'r-x', startedAt: '2026-11-03T05:00:00.000Z' }),
      targets: [{ provider: 'provider_a', model: 'm-a' }],
    }),
  );
  await appendRecords(
    buildHistoryRecords(
      fakeRun({
        runId: 'r-y',
        finishedAt: Date.parse('2026-11-03T06:00:00.000Z'),
        targets: [{ provider: 'provider_b', model: 'm-b' }],
        results: [{ provider: 'provider_b', model: 'm-b', aggregate: null }],
      }),
    ),
  );
  const c4 = fakeCapture();
  await routeHistoryModels(c4.response);
  const b4 = JSON.parse(c4.body());
  assert.equal(b4.models.length, 2);
  const rowA = b4.models.find((row) => row.model === 'm-a');
  const rowB = b4.models.find((row) => row.model === 'm-b');
  assert.equal(rowA.lastError, INTERRUPTED_ERROR, 'm-a 的最新记录是 interrupted');
  assert.equal(rowB.lastError, null, 'm-b 的最新记录是正常记录 ⇒ null（不得串味）');
  await clearHistory();
});

test('FIX-A2⑪（追加2/3）：sameProcess 是"当下重算"的真实比较；无侧车时 activeRun 显式为 null', async () => {
  const now = currentProcessStartedAt();
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now }), true, '取值一：同进程 ⇒ true');
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now - 5_000 }), false, '取值二：旧进程 ⇒ false');
  // 同一对象挪走 processStartedAt ⇒ 立刻翻转（证明依赖输入，不是常量）
  const live = { pid: process.pid, processStartedAt: now };
  assert.equal(isSameProcess(live), true);
  live.processStartedAt = now - 5_000;
  assert.equal(isSameProcess(live), false);
  // 明显的未来/过去时刻 ⇒ false（证明不是恒 true 的常量）
  // ⚠️ 不能用 `Date.now()` 当 start：进程运行不足容差(1s)时它**本来就该**判 true —— 那不是常量，是容差的定义。
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now + 5_000 }), false);
  assert.equal(isSameProcess({ pid: process.pid, processStartedAt: now - 3_600_000 }), false);

  // 三态：字段存在且为 null ⇒ 宿主"明说"没有（客户端据此不显示横幅）
  const c1 = fakeCapture();
  await routeStatus(c1.response, { write: null, read: async () => null, clear: null });
  assert.equal(c1.status(), 200);
  const b1 = JSON.parse(c1.body());
  assert.ok(Object.hasOwn(b1, 'activeRun'), 'activeRun 字段必须存在（不省略）');
  assert.equal(b1.activeRun, null, '无侧车 ⇒ 显式 null');

  // 有侧车 ⇒ 形状完整（含 processStartedAt / currentProcessStartedAt / pid）
  const c2 = fakeCapture();
  await routeStatus(c2.response, {
    write: null,
    clear: null,
    read: async () => ({
      v: 1,
      runId: 'r-live',
      startedAt: '2026-11-03T07:00:00.000Z',
      pid: process.pid,
      processStartedAt: now,
      options: { rounds: 1, count: 1, parallel: 1, strict: false },
      targets: [{ provider: 'provider_a', model: 'm-a' }],
    }),
  });
  const b2 = JSON.parse(c2.body());
  assert.equal(b2.activeRun.sameProcess, true);
  assert.equal(b2.activeRun.processStartedAt, now, '侧车的 processStartedAt 必须能读到');
  assert.equal(typeof b2.activeRun.currentProcessStartedAt, 'number', '当下值也必须能读到');
  assert.equal(b2.activeRun.pid, process.pid);
  assert.equal(b2.lastHistoryError === null || typeof b2.lastHistoryError === 'object', true, 'lastHistoryError 只能是 null 或对象');
});

test('FIX-A2⑫（顺带）：interrupted 记录的 ts 取自 descriptor.startedAt（不是重启时刻）', async () => {
  await clearHistory();
  const descriptor = deadDescriptor({ runId: 'r-ts', startedAt: '2026-11-03T08:00:00.000Z' });
  const { api } = fakeSidecar(descriptor);
  await recoverInterruptedRuns(quietCtx(), api);
  const all = await readHistory({});
  assert.equal(all.length, 2);
  for (const record of all) {
    assert.equal(record.ts, '2026-11-03T08:00:00.000Z', 'ts 必须是那次 run 的启动时刻，而不是"恢复发生的时刻"');
    assert.equal(Number.isNaN(Date.parse(record.ts)), false);
  }
  // 非法 startedAt ⇒ 退化为当前时刻（不抛、不留非法 ts）
  const dirty = buildInterruptedRecords(deadDescriptor({ startedAt: 'not-a-date' }));
  assert.equal(Number.isNaN(Date.parse(dirty[0].ts)), false, 'ts 必须始终是可解析的 ISO');
  await clearHistory();
});

test('FIX-A2⑨：侧车写/清与恢复的失败路径都只留痕、不抛', async () => {
  const before = historyState.lastHistoryError;
  historyState.lastHistoryError = null;
  try {
    // 写侧车抛错
    const boom = await writeRunSidecar(quietCtx(), fakeRun(), {
      write: async () => {
        throw new Error('write boom');
      },
      read: null,
      clear: null,
    });
    assert.equal(boom.ok, false);
    assert.match(historyState.lastHistoryError.message, /write boom/);
    // 写侧车返回 ok:false
    await writeRunSidecar(quietCtx(), fakeRun(), { write: async () => ({ ok: false, error: 'ro fs' }), read: null, clear: null });
    assert.match(historyState.lastHistoryError.message, /ro fs/);
    // 清侧车返回 ok:false
    const cleared = await clearRunSidecar(quietCtx(), { write: null, read: null, clear: async () => ({ ok: false, error: 'unlink failed' }) });
    assert.equal(cleared.ok, false);
    assert.match(historyState.lastHistoryError.message, /unlink failed/);
    // 恢复过程整体抛错 ⇒ 不抛出去
    const recovered = await recoverInterruptedRuns(
      quietCtx(),
      {
        write: null,
        read: async () => {
          throw new Error('read boom');
        },
        clear: null,
      },
      async () => ({ ok: true }),
    );
    assert.equal(recovered.ok, false);
    assert.match(recovered.error, /read boom/);

    // ⚠️ 写中断记录失败 ⇒ **不清侧车**（有意偏离字面 spec：留给下次初始化重试，否则记录永久消失）
    await clearHistory();
    const { api, state } = fakeSidecar(deadDescriptor());
    const failed = await recoverInterruptedRuns(quietCtx(), api, async () => ({ ok: false, error: 'append failed' }));
    assert.equal(failed.ok, false);
    assert.equal(failed.appended, 0);
    assert.match(failed.error, /append failed/);
    assert.equal(state.clears, 0, '写失败时绝不能清侧车（否则记录永久消失）');
    assert.equal((await readHistory({})).length, 0);
  } finally {
    historyState.lastHistoryError = before;
    await clearHistory();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// OPT-2（契约 §61）：probabilityStatus 贯通
// ══════════════════════════════════════════════════════════════════════════

test('OPT-2⑥：buildHistoryRecords 带出 probabilityStatus（合法值 / 缺失 / 非法 / aggregate 为 null）', () => {
  const base = {
    runId: 'r-opt2',
    options: { rounds: 3, count: 3, parallel: 3, strict: false },
    targets: [{ provider: 'provider_a', model: 'm-a' }],
    finishedAt: Date.parse('2026-11-03T02:00:00.000Z'),
    error: null,
  };
  const withAggregate = (aggregate) => buildHistoryRecords({ ...base, results: [{ provider: 'provider_a', model: 'm-a', aggregate }] });

  // ① 两个非 null 合法值都能往返
  for (const value of ['reference_calibrated', 'unavailable']) {
    const records = withAggregate(fakeAggregate({ probabilityStatus: value }));
    assert.equal(records[0].probabilityStatus, value, `${value} 必须原样带出`);
    assert.equal(Object.keys(records[0]).length, 18);
    assert.deepEqual(Object.keys(records[0]), HISTORY_RECORD_KEYS);
  }
  // ② 显式 null
  assert.equal(withAggregate(fakeAggregate({ probabilityStatus: null }))[0].probabilityStatus, null);
  // ③ 缺失该键（旧聚合对象）⇒ null
  const withoutKey = fakeAggregate();
  delete withoutKey.probabilityStatus;
  assert.equal(withAggregate(withoutKey)[0].probabilityStatus, null);
  // ④ 非法值 ⇒ null（不透传）
  for (const bad of ['foo', 'REFERENCE_CALIBRATED', 1, true, { value: 'unavailable' }, ['unavailable']]) {
    assert.equal(withAggregate(fakeAggregate({ probabilityStatus: bad }))[0].probabilityStatus, null, `${JSON.stringify(bad)} 必须归 null`);
  }
  // ⑤ aggregate 为 null（取消/失败）⇒ null，且不抛
  assert.equal(withAggregate(null)[0].probabilityStatus, null);
  // ⑥ 兼容别名：调用方直接塞 `probability`（旧夹具/旧调用方）仍能映射
  assert.equal(withAggregate({ decision: 'scored', probability: 0.7 })[0].probability, 0.7);
});

test('OPT-2⑦：run.results[] 透传该字段（真实 aggregateRounds）；同时给 OD-1 的 confidence→probability 映射加回归网', async () => {
  const { aggregateRounds } = await import('../lib/aggregate.js'); // 只读使用，不改它
  const analysis = {
    decision: 'scored',
    prediction: 'p-1',
    predictionName: 'P One',
    probability: 0.9,
    agreement: 1,
    stability: 'stable',
    probability_status: 'reference_calibrated',
  };
  const aggregate = aggregateRounds([{ analysis, error: null }, { analysis: { ...analysis }, error: null }]);

  // ① 真实聚合对象里已有该字段（W5 的 §61 改动已落地）
  assert.equal(aggregate.probabilityStatus, 'reference_calibrated');
  // ② results[] 按**现有结构**原样携带（键名未改：仍是 results[].aggregate）
  const run = {
    runId: 'r-opt2',
    options: { rounds: 2, count: 2, parallel: 2, strict: false },
    targets: [{ provider: 'provider_a', model: 'm-a' }],
    results: [{ provider: 'provider_a', model: 'm-a', aggregate }],
    error: null,
    finishedAt: Date.now(),
  };
  assert.equal(run.results[0].aggregate.probabilityStatus, 'reference_calibrated', '结果对象里必须能读到');
  assert.equal(Object.hasOwn(run.results[0].aggregate, 'confidence'), true, '既有键名不变（confidence）');

  // ③ 记录里也带出；且聚合的 confidence 被正确映射成记录的 probability（OD-1 回归网）
  const records = buildHistoryRecords(run);
  assert.equal(records[0].probabilityStatus, 'reference_calibrated');
  assert.equal(records[0].probability, 0.9, '聚合的 confidence 必须映射到记录的 probability（否则恒为 null）');
  assert.equal(records[0].decision, 'scored');

  // ④ 未校准：status=unavailable 且 confidence 为 null ⇒ 两者都可解释（§61.4 C 第 2 行）
  const uncalibrated = aggregateRounds([
    { analysis: { ...analysis, probability: null, probability_status: 'unavailable' }, error: null },
  ]);
  assert.equal(uncalibrated.probabilityStatus, 'unavailable');
  const rec2 = buildHistoryRecords({ ...run, runId: 'r-unc', results: [{ provider: 'provider_a', model: 'm-a', aggregate: uncalibrated }] });
  assert.equal(rec2[0].probabilityStatus, 'unavailable');
  assert.equal(rec2[0].probability, null, '未校准时 confidence 为 null');
});

test('OPT-2 追加1：/history/models 每行带 lastProbabilityStatus（与 lastError 同源、字段永不省略）', async () => {
  await clearHistory();
  const one = (runId, provider, model, status, finishedAt) =>
    buildHistoryRecords({
      ...fakeRun({
        runId,
        finishedAt: Date.parse(finishedAt),
        targets: [{ provider, model }],
        results: [{ provider, model, aggregate: fakeAggregate({ probabilityStatus: status }) }],
      }),
    });
  // m-a：最新那条 unavailable；m-b：最新那条 reference_calibrated；m-c：最新那条 null
  await appendRecords(one('r-a1', 'provider_a', 'm-a', 'unavailable', '2026-11-03T03:00:00.000Z'));
  await appendRecords(one('r-b1', 'provider_b', 'm-b', 'reference_calibrated', '2026-11-03T03:01:00.000Z'));
  await appendRecords(one('r-c1', 'provider_c', 'm-c', null, '2026-11-03T03:02:00.000Z'));

  const capture = fakeCapture();
  await routeHistoryModels(capture.response);
  const body = JSON.parse(capture.body());
  const byModel = new Map(body.models.map((row) => [row.model, row]));

  // 字段永不省略
  for (const row of body.models) {
    assert.ok(Object.hasOwn(row, 'lastProbabilityStatus'), `${row.model} 必须带 lastProbabilityStatus 字段`);
    assert.ok(Object.hasOwn(row, 'lastError'), `${row.model} 必须带 lastError 字段`);
  }
  assert.equal(byModel.get('m-a').lastProbabilityStatus, 'unavailable');
  assert.equal(byModel.get('m-b').lastProbabilityStatus, 'reference_calibrated');
  assert.equal(byModel.get('m-c').lastProbabilityStatus, null, 'null 是合法值（不是"字段缺失"）');

  // 来一条更新的 null ⇒ 跟着回落（不得回退到 unavailable）
  await appendRecords(one('r-a2', 'provider_a', 'm-a', null, '2026-11-03T03:10:00.000Z'));
  const capture2 = fakeCapture();
  await routeHistoryModels(capture2.response);
  const body2 = JSON.parse(capture2.body());
  const a2 = body2.models.find((row) => row.model === 'm-a');
  assert.equal(a2.lastProbabilityStatus, null, '最新那条是 null ⇒ null');
  assert.equal(a2.runs, 2);

  // 非法值不得透传（走 history.js 白名单 ⇒ 读出来就是 null）
  await appendRecords(one('r-b2', 'provider_b', 'm-b', 'foo', '2026-11-03T03:11:00.000Z'));
  const capture3 = fakeCapture();
  await routeHistoryModels(capture3.response);
  const b3 = JSON.parse(capture3.body());
  assert.equal(b3.models.find((row) => row.model === 'm-b').lastProbabilityStatus, null, '非法值 ⇒ null');

  // 兜底：注入的 aggregator 若不给该字段，路由必须自己补上（键存在 + 取最新记录的值）
  const capture4 = fakeCapture();
  await routeHistoryModels(capture4.response, readHistory, async () => [{ provider: 'provider_a', model: 'm-a', lastTs: 'x', runs: 2 }]);
  const b4 = JSON.parse(capture4.body());
  assert.ok(Object.hasOwn(b4.models[0], 'lastProbabilityStatus'), '字段永不省略（兜底路径）');
  assert.equal(b4.models[0].lastProbabilityStatus, null, '该模型最新记录是 null ⇒ 兜底也是 null');

  await clearHistory();
});
