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
  buildRunItems,
  buildTasks,
  failure,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_RECORD_KEYS,
  isLoopbackAddress,
  isLoopbackHost,
  parseHistoryQuery,
  parseRunOptions,
  persistRunHistory,
  readJsonBody,
  routeHistory,
  routeHistoryClear,
  routeHistoryModels,
  routeStatus,
  runPool,
  sleep,
  validateRunOptions,
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

test('P2：GET /status 暴露 activeRunId —— 客户端据此恢复被 BUSY 挡住的运行', () => {
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
  routeStatus(response);
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

const { appendRecords } = await import('../lib/history.js');

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

/** 造一个聚合结果（camelCase，§9.1 形状）。 */
function fakeAggregate(overrides = {}) {
  return {
    decision: 'scored',
    prediction: 'p-1',
    predictionName: 'P One',
    family: 'fam',
    familyName: 'Fam Name',
    probability: 0.9,
    agreement: 1,
    stability: 'stable',
    validRounds: 3,
    totalRounds: 3,
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

test('H2：buildHistoryRecords —— 2 目标 → 2 条，逐键对齐 §29.3（17 键，camelCase 直映）', () => {
  const run = fakeRun({
    results: [
      { provider: 'provider_a', model: 'm-a', aggregate: fakeAggregate() },
      { provider: 'provider_b', model: 'm-b', aggregate: fakeAggregate({ prediction: 'p-2', predictionName: 'P Two' }) },
    ],
  });
  const records = buildHistoryRecords(run);
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[0]), HISTORY_RECORD_KEYS, '键集合与顺序都要逐字对齐契约');
  assert.equal(Object.keys(records[0]).length, 17);
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
