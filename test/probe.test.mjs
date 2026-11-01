/**
 * test/probe.test.mjs —— 取样层单测（W3）
 *
 * 原则：**零真实网络请求**。
 *   - `parseNumbers` / `generateChallenges` 用 lmfpd-sdk 的**真实实现**（纯函数，不联网），
 *     比自写 stub 更能证明「语义被正确依赖」。
 *   - `analyze` 是 `Detector` 的实例方法，拿它必须先 `loadDetector()`（会下载 ~3.6MB 参考数据），
 *     因此测试里必须 stub。
 *   - `send` 一律由测试注入，绝不触碰 `ctx.llm`。
 *
 *   node --test test/probe.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  generateChallenges as realGenerateChallenges,
  parseNumbers as realParseNumbers,
} from 'lmfpd-sdk';

import {
  MIN_ABSOLUTE,
  MIN_RATIO,
  OK_END_REASONS,
  assessSample,
  bindDetector,
  ensureDetector,
  minimumNumbers,
  runChallenge,
  runRound,
} from '../lib/probe.js';

// ── 关键：关掉 W2 的「导入期预热」─────────────────────────────────────
// `lib/detector.js` 在导入时会后台 `getDetector()` 预热一次（冗余保险）。
// 若开着，下面那条**反证测试**会被预热「救」过去 → 假绿 → 什么都没验证到。
// 必须在 `lib/detector.js` 被求值**之前**设好，所以放在模块体最前面。
// （本文件的所有静态 import 都不会求值 detector.js；它是被 probe.js 在
//  `ensureDetector()` 里懒加载的，而其它测试都先 `bindDetector()` 提前返回，
//  所以这条 env 一定赶在首次求值之前生效——反证测试里还会显式断言这一点。）
process.env.DSH_FINGERPRINT_NO_PREWARM = '1';

// ── 测试替身 ───────────────────────────────────────────────────────────

/** 记录 analyze 调用的 stub（真 analyze 需要联网加载参考库）。 */
function makeAnalyzeStub(impl) {
  const calls = [];
  const analyze = (outputs, options) => {
    calls.push({ outputs, options });
    if (typeof impl === 'function') return impl(outputs, options);
    return { decision: 'scored', prediction: 'stub-model', prediction_name: 'stub-model' };
  };
  analyze.calls = calls;
  return analyze;
}

/** 固定挑战的 generateChallenges stub（真实实现随机选语言与整数个数，不利断言）。 */
function makeChallengesStub(counts) {
  return (count = 3) =>
    counts.slice(0, count).map((expectedCount, index) => ({
      id: `ch-${index}`,
      expected_count: expectedCount,
      prompt: `请输出 ${expectedCount} 个整数`,
    }));
}

/**
 * 安装默认绑定：真 parseNumbers + 可控的 generateChallenges / analyze。
 * @param {{challenges?: number[], analyze?: Function}} [opts]
 */
function installBinding(opts = {}) {
  const analyze = makeAnalyzeStub(opts.analyze);
  bindDetector({
    parseNumbers: realParseNumbers,
    generateChallenges: opts.generateChallenges ?? makeChallengesStub(opts.challenges ?? [300, 311, 296]),
    analyze,
  });
  return { analyze };
}

installBinding();

/** 生成 n 个 1–355 的整数文本（空格分隔，字母不出现 → parseNumbers 只有一个数字段）。 */
function numberText(n) {
  return Array.from({ length: n }, (_, i) => (i % 355) + 1).join(' ');
}

/**
 * 流式 send 替身。
 * @param {string} text 完整回答
 * @param {string} endReason 结束原因
 */
function makeSend(text, endReason = 'stop', { chunkSize = 64 } = {}) {
  const calls = [];
  const send = async (prompt, { signal, onDelta } = {}) => {
    const call = { prompt, aborted: false };
    calls.push(call);
    let acc = '';
    for (let i = 0; i < text.length; i += chunkSize) {
      if (signal?.aborted) {
        call.aborted = true;
        return { text: acc, endReason: 'aborted' };
      }
      const piece = text.slice(i, i + chunkSize);
      acc += piece;
      if (typeof onDelta === 'function') onDelta(piece);
      // 让出事件循环：模拟流式到达，也让 AbortSignal 有机会被观察
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { text, endReason };
  };
  send.calls = calls;
  return send;
}

/** 收集 onProgress 调用。 */
function makeProgress() {
  const events = [];
  const onProgress = (p) => events.push(p);
  onProgress.events = events;
  return onProgress;
}

// ── 1. minimumNumbers 边界 ────────────────────────────────────────────

test('minimumNumbers：契约与官方文档的边界值', () => {
  assert.equal(MIN_ABSOLUTE, 80);
  assert.equal(MIN_RATIO, 0.55);
  assert.equal(minimumNumbers(300), 165); // ceil(165)
  assert.equal(minimumNumbers(10), 80); // ceil(5.5)=6 → 被绝对下限抬到 80
  assert.equal(minimumNumbers(1000), 550); // ceil(550)
  // 额外边界：刚好卡在绝对下限两侧
  assert.equal(minimumNumbers(146), 81); // ceil(80.3)=81 > 80
  assert.equal(minimumNumbers(145), 80); // ceil(79.75)=80
});

test('OK_END_REASONS 为 lmfpd 词表', () => {
  assert.deepEqual(OK_END_REASONS, ['stop', 'end_turn', 'completed']);
});

// ── 2. 正常回答 → complete ────────────────────────────────────────────

test('正常回答（整数够 + stop）→ complete', async () => {
  installBinding();
  const send = makeSend(numberText(200), 'stop');
  const sample = await runChallenge({
    challenge: { id: 'c1', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'complete');
  assert.equal(sample.count, 200);
  assert.equal(sample.expectedCount, 300);
  assert.equal(sample.error, null);
  assert.equal(send.calls.length, 1);
  assert.ok(send.calls[0].prompt === 'p');
  assert.ok(typeof sample.firstByteMs === 'number' && sample.firstByteMs >= 0);
});

// ── 3. 整数个数不足 → failed ──────────────────────────────────────────

test('整数个数不足最小阈值 → failed，且 error 可读', async () => {
  installBinding();
  const send = makeSend(numberText(10), 'stop');
  const sample = await runChallenge({
    challenge: { id: 'c2', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'failed');
  assert.equal(sample.count, 10);
  assert.match(sample.error, /整数个数不足/);
  assert.match(sample.error, /10 < 最小要求 165/);
});

// ── 4. 非 OK 结束原因 → failed ────────────────────────────────────────

test('endReason = refusal → failed', async () => {
  installBinding();
  const send = makeSend(numberText(200), 'refusal');
  const sample = await runChallenge({
    challenge: { id: 'c3', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'failed');
  assert.match(sample.error, /结束原因不可接受：refusal/);
});

test('endReason 缺失 → 保守按正常结束处理，但记备注', async () => {
  installBinding();
  const send = async () => ({ text: numberText(200) }); // 无 endReason
  const sample = await runChallenge({
    challenge: { id: 'c3b', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'complete');
  assert.match(sample.error, /未取到结束原因/);
});

// ── 5. 宽松模式超长 → truncated ───────────────────────────────────────

test('非严格模式流式超长 → truncated，text 只保留前 expectedCount 个整数', async () => {
  installBinding();
  const send = makeSend(numberText(355), 'stop');
  const sample = await runChallenge({
    challenge: { id: 'c4', expected_count: 300, prompt: 'p' },
    send,
    strict: false,
  });

  assert.equal(sample.state, 'truncated');
  assert.equal(sample.count, 300);
  // text 只保留前 300 个整数
  assert.equal(realParseNumbers(sample.text).length, 300);
  // 而 rawText 保留「截止早停那一刻已收到」的原始文本：
  //   - 必须 ≥ expectedCount（否则不可能触发早停）
  //   - 必须 < 全部整数个数（否则证明没有真的早停）
  const rawCount = realParseNumbers(sample.rawText).length;
  assert.ok(rawCount >= 300, `早停时至少应收到 expectedCount 个整数，实得 ${rawCount}`);
  assert.ok(rawCount < 355, `早停后不应读完整个回答，实得 ${rawCount}`);
  assert.ok(sample.rawText.length > sample.text.length);
  // 早停：send 观察到自己被 abort
  assert.equal(send.calls[0].aborted, true);
});

// ── 6. 严格模式同输入 → 不截断 ────────────────────────────────────────

test('严格模式同输入 → 不截断、状态 complete', async () => {
  installBinding();
  const send = makeSend(numberText(355), 'stop');
  const sample = await runChallenge({
    challenge: { id: 'c5', expected_count: 300, prompt: 'p' },
    send,
    strict: true,
  });

  assert.equal(sample.state, 'complete');
  assert.equal(sample.count, 355); // 未被截断
  assert.equal(realParseNumbers(sample.text).length, 355);
  assert.equal(sample.error, null);
  // 严格模式不早停：send 跑完并正常结束
  assert.equal(send.calls[0].aborted, false);
});

// ── 7. 已 abort → 不调 send ───────────────────────────────────────────

test('signal 已 abort → 不调 send，返回 failed', async () => {
  installBinding();
  const controller = new AbortController();
  controller.abort();
  const send = makeSend(numberText(200), 'stop');

  const sample = await runChallenge({
    challenge: { id: 'c6', expected_count: 300, prompt: 'p' },
    send,
    signal: controller.signal,
  });

  assert.equal(send.calls.length, 0, '已取消时不得调用 send');
  assert.equal(sample.state, 'failed');
  assert.match(sample.error, /已取消/);
});

test('流中取消 → 该样本 failed 且不带可评分文本', async () => {
  installBinding();
  const controller = new AbortController();
  const send = makeSend(numberText(355), 'stop', { chunkSize: 16 });
  const promise = runChallenge({
    challenge: { id: 'c6b', expected_count: 300, prompt: 'p' },
    send,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const sample = await promise;

  assert.equal(sample.state, 'failed');
  assert.equal(sample.text, '');
  assert.match(sample.error, /已取消/);
});

// ── 8. onProgress ─────────────────────────────────────────────────────

test('onProgress 至少被调用一次且参数形状正确', async () => {
  installBinding();
  const onProgress = makeProgress();
  const send = makeSend(numberText(200), 'stop');

  await runChallenge({
    challenge: { id: 'c7', expected_count: 300, prompt: 'p' },
    send,
    onProgress,
  });

  assert.ok(onProgress.events.length >= 1);
  for (const event of onProgress.events) {
    assert.deepEqual(Object.keys(event).sort(), ['count', 'expectedCount', 'firstByteMs', 'state'].sort());
    assert.equal(typeof event.state, 'string');
    assert.equal(typeof event.count, 'number');
    assert.equal(event.expectedCount, 300);
    assert.ok(event.firstByteMs === null || typeof event.firstByteMs === 'number');
  }
  // 最后一次应为最终态
  assert.equal(onProgress.events.at(-1).state, 'complete');
  assert.equal(onProgress.events.at(-1).count, 200);
});

// ── 9. parseNumbers 语义被正确依赖 ────────────────────────────────────

test('字母会切开数字段：12abc34 只算作一段（依赖 parseNumbers 语义）', async () => {
  installBinding();
  // 真实 parseNumbers：返回「最长的一段」数字。'12abc34' → 两段各 1 个 → 最长段长 1。
  assert.equal(realParseNumbers('12abc34').length, 1);

  // 因此下面这条回答的 count 是 1（而不是 2），必然低于最小阈值
  const send = makeSend('12abc34', 'stop');
  const sample = await runChallenge({
    challenge: { id: 'c8', expected_count: 300, prompt: 'p' },
    send,
  });
  assert.equal(sample.state, 'failed');
  assert.equal(sample.count, 1);
});

test('assessSample 是纯文本级评估，不涉及结束原因', () => {
  installBinding();
  const failed = assessSample({ rawText: numberText(20), expectedCount: 300 });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.rawCount, 20);
  assert.equal(failed.minimum, 165);

  const complete = assessSample({ rawText: numberText(200), expectedCount: 300 });
  assert.equal(complete.state, 'complete');

  const truncated = assessSample({ rawText: numberText(355), expectedCount: 300 });
  assert.equal(truncated.state, 'truncated');
  assert.equal(truncated.count, 300);
  assert.equal(truncated.rawCount, 355);

  const strictComplete = assessSample({ rawText: numberText(355), expectedCount: 300, strict: true });
  assert.equal(strictComplete.state, 'complete');
  assert.equal(strictComplete.count, 355);
});

// ── 10. runRound ──────────────────────────────────────────────────────

test('runRound：全并发取样 → 评分，onSample 按序回调', async () => {
  const { analyze } = installBinding({ challenges: [300, 311, 296] });
  const send = async (prompt, { onDelta } = {}) => {
    const text = numberText(300);
    if (typeof onDelta === 'function') onDelta(text);
    return { text, endReason: 'stop' };
  };
  const seen = [];

  const result = await runRound({
    count: 3,
    strict: false,
    send,
    onSample: (index, sample) => seen.push([index, sample.state]),
  });

  assert.equal(result.challenges.length, 3);
  assert.equal(result.samples.length, 3);
  assert.equal(result.error, null);
  assert.notEqual(result.analysis, null);
  assert.deepEqual(seen.map(([i]) => i), [0, 1, 2]);
  // analyze 收到 3 条 {text, expected_count}
  assert.equal(analyze.calls.length, 1);
  assert.equal(analyze.calls[0].outputs.length, 3);
  assert.equal(analyze.calls[0].outputs[0].expected_count, 300);
  assert.equal(analyze.calls[0].outputs[1].expected_count, 311);
});

test('runRound：全部样本失败 → 契约原文错误', async () => {
  const { analyze } = installBinding({ challenges: [300, 311, 296] });
  const send = makeSend(numberText(5), 'stop');

  const result = await runRound({ count: 3, send });

  assert.equal(result.analysis, null);
  assert.equal(result.error, 'No valid samples. This round cannot be scored.');
  assert.equal(analyze.calls.length, 0, '无有效样本时不得调用 analyze');
});

test('runRound：严格模式样本不足 3/3 → 契约原文错误', async () => {
  const { analyze } = installBinding({ challenges: [300, 311, 296] });
  let call = 0;
  const send = async (prompt, { onDelta } = {}) => {
    call += 1;
    // 第一条有效，其余两条整数不足
    const text = call === 1 ? numberText(300) : numberText(5);
    if (typeof onDelta === 'function') onDelta(text);
    return { text, endReason: 'stop' };
  };

  const result = await runRound({ count: 3, strict: true, send });

  assert.equal(result.analysis, null);
  assert.equal(result.error, 'Strict mode requires 3/3 successful samples; received 1/3.');
  assert.equal(analyze.calls.length, 0);
});

test('runRound：analyze 抛错 → 转成可读 error，不让异常穿透', async () => {
  installBinding({
    challenges: [300, 311, 296],
    analyze: () => {
      throw new Error('数据文件损坏');
    },
  });
  const send = makeSend(numberText(300), 'stop');

  const result = await runRound({ count: 3, send });

  assert.equal(result.analysis, null);
  assert.match(result.error, /评分失败：数据文件损坏/);
});

test('runRound：真实 generateChallenges 产出合法挑战（292–332）', async () => {
  // 这条用真生成器，验证契约假设：每道挑战 expected_count 292–332、同轮互不相同
  bindDetector({
    parseNumbers: realParseNumbers,
    generateChallenges: realGenerateChallenges,
    analyze: makeAnalyzeStub(),
  });

  const challenges = realGenerateChallenges(3);
  assert.equal(challenges.length, 3);
  const counts = challenges.map((c) => c.expected_count);
  for (const c of counts) {
    assert.ok(c >= 292 && c <= 332, `expected_count 应在 292–332，实得 ${c}`);
  }
  assert.equal(new Set(counts).size, 3, '同一轮内 expected_count 应互不相同');
  for (const c of challenges) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.prompt, 'string');
  }

  installBinding(); // 还原默认绑定，避免影响后续
});

// ── 11. 绑定与懒加载 ──────────────────────────────────────────────────

test('ensureDetector：显式绑定后立即可用', async () => {
  const binding = await ensureDetector();
  assert.equal(typeof binding.parseNumbers, 'function');
  assert.equal(typeof binding.generateChallenges, 'function');
  assert.equal(typeof binding.analyze, 'function');
});

test('bindDetector：缺失必需函数时明确报错', () => {
  const snapshot = {
    parseNumbers: realParseNumbers,
    generateChallenges: realGenerateChallenges,
    analyze: makeAnalyzeStub(),
  };
  assert.throws(() => bindDetector({ parseNumbers: realParseNumbers }), /缺少必需函数/);
  bindDetector(snapshot); // 还原
});

// ── 12. 失败降级：异常不得穿透 ────────────────────────────────────────

test('parseNumbers 抛错 → 样本降级为 failed，不炸穿 runChallenge', async () => {
  bindDetector({
    parseNumbers: () => {
      throw new Error('解析器内部错误');
    },
    generateChallenges: makeChallengesStub([300]),
    analyze: makeAnalyzeStub(),
  });
  const send = makeSend(numberText(300), 'stop');

  const sample = await runChallenge({
    challenge: { id: 'c9', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'failed');
  assert.match(sample.error, /样本评估失败：解析器内部错误/);
  installBinding(); // 还原
});

test('detector 绑定不可用 → runRound 返回可读 error 而非抛异常', async () => {
  const snapshot = {
    parseNumbers: realParseNumbers,
    generateChallenges: realGenerateChallenges,
    analyze: makeAnalyzeStub(),
  };
  installBinding({ challenges: [300] });
  // 破坏绑定的 generateChallenges，模拟 detector 层系统性故障
  bindDetector({
    parseNumbers: realParseNumbers,
    generateChallenges: () => {
      throw new Error('挑战生成器不可用');
    },
    analyze: makeAnalyzeStub(),
  });

  const result = await runRound({ count: 1, send: makeSend(numberText(300), 'stop') });

  assert.equal(result.analysis, null);
  assert.match(result.error, /生成挑战失败：挑战生成器不可用/);
  assert.deepEqual(result.samples, []);
  bindDetector(snapshot);
});

// ── 13. §11.3 反证测试：ensureDetector() 必须自己把单例加载起来 ──────────
//
// 这一节是**反证测试**，不是回归测试：三条都在「全新 probe 模块实例」里只走
// `ensureDetector()`，不手动 `bindDetector()`、不手动 `getDetector()`。
// 在补上 `await getDetector()` 之前，这三条**必然失败** —— 这正是它们的价值。

test('反证(重点)：关掉预热后，仅 ensureDetector() 就必须让同步 analyze() 可用', async () => {
  // ① 先证明预热确实被关掉了。
  //    否则这条测试会被 W2 的导入期预热「救」过去 → 假绿 → 什么都没验证到。
  const detectorModule = await import('../lib/detector.js');
  assert.equal(
    detectorModule.detectorStatus().ready,
    false,
    'DSH_FINGERPRINT_NO_PREWARM=1 未生效：单例在导入期已被预热，本反证测试将失去意义',
  );

  // ② 全新 probe 实例：带 query 的 URL 会产生新的模块实例，模块级绑定状态全新
  const fresh = await import(`../lib/probe.js?counter=${Date.now()}`);

  // ③ 只调 ensureDetector()：不手动 bindDetector、不手动 getDetector
  const binding = await fresh.ensureDetector();

  // ④ ensureDetector() 必须真的把单例加载起来了
  assert.equal(
    detectorModule.detectorStatus().ready,
    true,
    'ensureDetector() 没有真正加载 detector 单例（缺 `await getDetector()` 就是这个症状）',
  );
  assert.equal(typeof binding.analyze, 'function');

  // ⑤ **同步**调用 —— 这正是 runRound 里的调用形态。
  //    修复前这里会抛「lmfpd 检测器尚未加载：请先 await getDetector()…」
  const analysis = binding.analyze(
    [{ text: numberText(300), expected_count: 300 }],
    { strict: false },
  );
  assert.ok(analysis !== null && typeof analysis === 'object');
  assert.ok(
    ['scored', 'partial', 'unscorable', 'not_model'].includes(analysis.decision),
    `decision 应为四个合法值之一，实得 ${analysis.decision}`,
  );
  // §11.5：离线合成数据必然被 sequence-check 判为 not_model —— 这是 SDK 正确工作
  assert.equal(analysis.decision, 'not_model');
});

test('反证：真实单例绑定下 runRound 能拿到 analysis（而不是「评分失败」）', async () => {
  const fresh = await import(`../lib/probe.js?realround=${Date.now()}`);
  const send = makeSend(numberText(300), 'stop');

  const result = await fresh.runRound({ count: 1, strict: false, send });

  assert.ok(
    result.error === null || !String(result.error).startsWith('评分失败'),
    `不应再出现「评分失败：…」：${result.error}`,
  );
  assert.notEqual(result.analysis, null, '必须拿到 analysis');
  assert.equal(result.samples.length, 1);
  assert.ok(['complete', 'truncated'].includes(result.samples[0].state));
});

test('反证：detector 加载失败时 ensureDetector() 抛可读错误，而不是 null 解引用', async () => {
  const fresh = await import(`../lib/probe.js?fail=${Date.now()}`);

  // 触发点说明（这点很重要，见回报）：
  //   把 DSH_FINGERPRINT_LMFPD_CACHE 指向不存在路径**并不能**制造加载失败 ——
  //   缓存未命中时 SDK 会回落去联网下载（lmfpd-sdk/index.js:1918-1920），
  //   而写缓存失败还被它自己吞掉、父目录也由它 mkdir 出来（:1868-1879）。
  //   那样写出来的测试是环境依赖的（有网就绿、断网才红）。
  //   这里改用**确定性、零网络**的触发点：source 指向不存在的本地参考库目录，
  //   SDK 对「单个非 http(s) 的 source」会短路到 readDir 并抛错（:1916-1917, :1852）。
  const missingDir = path.join(os.tmpdir(), `dsh-fingerprint-no-such-bank-${Date.now()}`);

  await assert.rejects(
    () => fresh.ensureDetector({ source: missingDir }),
    (error) => {
      assert.ok(error instanceof Error, '必须抛 Error');
      assert.match(error.message, /lmfpd 检测器不可用/, '必须给出可读的领域错误');
      assert.match(error.message, /lmfpd 参考数据加载失败/, '应带上 detector.js 的原始可读原因');
      assert.match(error.message, /Cannot read/, '应带上 SDK readDir 的原文');
      assert.doesNotMatch(
        error.message,
        /Cannot read properties of null/,
        '绝不能退化成 null 解引用',
      );
      return true;
    },
  );
});

// ── 14. FIX-9：结束原因豁免必须是**两维**判据 ────────────────────────────
//
// 官方 `lmfpd-sdk/index.js:483`：truncated = !final || numbers.length > expected_count
//      该标志用在 `:671` 的结束原因检查上 —— 只要 truncated 就**豁免** stop/end_turn/completed 要求。
//
// 本模块的两个对应物：
//   · truncatedEarly                 ⇔ 官方 !final（非严格模式收满 expectedCount 主动早停）
//   · assessed.state === 'truncated' ⇔ 官方 numbers.length > expected_count（读完但超长）
//
// 下面刻意用**非流式 send**（不回调 onDelta、直接返回完整文本）来隔离第二维：
// buffer 为空 → 早停守卫不可能触发（truncatedEarly=false）→ 只剩 assessed 那一维可用。
// 这也正是真实世界里「JSON 一次性响应」的形态。

test('FIX-9：读完且整数 > expectedCount + endReason=length → truncated（不是 failed）', async () => {
  installBinding();
  const send = async () => ({ text: numberText(355), endReason: 'length' });

  const sample = await runChallenge({
    challenge: { id: 'fix9-a', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.notEqual(sample.state, 'failed', '整数已够就不得因 max-tokens 丢弃样本');
  assert.equal(sample.state, 'truncated');
  assert.equal(sample.count, 300);
  // 豁免要留下可追溯的备注（样本仍被接受，状态不受影响）
  assert.match(sample.error, /已按「宽松截断豁免」接受/);
});

test('FIX-9 边界：整数 ≤ expectedCount + endReason=length → 仍必须 failed', async () => {
  installBinding();
  // 200 个整数 ≥ 最小阈值 165，但 ≤ expectedCount 300 → 不构成截断 → 不得豁免
  const send = async () => ({ text: numberText(200), endReason: 'length' });

  const sample = await runChallenge({
    challenge: { id: 'fix9-b', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'failed');
  assert.match(sample.error, /结束原因不可接受：length/);
});

test('FIX-9 边界（判据是 > 而非 >=）：恰好等于 expectedCount + length → failed', async () => {
  installBinding();
  // 官方原文是 numbers.length > expected_count，等号不置 truncated → 仍必须要求正常结束
  const send = async () => ({ text: numberText(300), endReason: 'length' });

  const sample = await runChallenge({
    challenge: { id: 'fix9-d', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'failed');
  assert.match(sample.error, /结束原因不可接受：length/);
});

test('FIX-9 严格模式：同一输入不截断，且 length 不获豁免 → failed', async () => {
  installBinding();
  const send = async () => ({ text: numberText(355), endReason: 'length' });

  const sample = await runChallenge({
    challenge: { id: 'fix9-c', expected_count: 300, prompt: 'p' },
    send,
    strict: true,
  });

  // 官方在严格模式下从不置 truncated（那段被 !options.strict 守卫）→ 结束原因检查始终生效
  assert.equal(sample.state, 'failed');
  assert.equal(sample.count, 355, '严格模式不截断（§4.2）');
  assert.match(sample.error, /结束原因不可接受：length/);
});

test('FIX-9 回归：宽松模式下 endReason=stop 的超长回答仍是 truncated 且无豁免备注', async () => {
  installBinding();
  const send = async () => ({ text: numberText(355), endReason: 'stop' });

  const sample = await runChallenge({
    challenge: { id: 'fix9-e', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(sample.state, 'truncated');
  assert.equal(sample.error, null, '正常结束不需要豁免备注');
});

test('FIX-9（流式路径）：末段 < 16 字符躲过早停守卫 → 第二维是唯一豁免来源', async () => {
  installBinding();
  // 这条证明第二维在**真实流式**形态下也必需，不是只有「非流式」才用得上：
  //   · 第一段给出 expectedCount-2 = 298 个整数 → 触发一次解析，但 298 < 300 → **不早停**
  //   · 第二段只有 12 字符（< REPARSE_MIN_GROWTH = 16）→ 守卫跳过解析 → **早停不触发**
  //   ⇒ truncatedEarly === false，而最终文本 301 > 300 → 只剩第二维能豁免 'length'。
  // 生产环境里这对应「最后一次解析时还差几个整数、余下不足 16 字符刚好补满」的窗口。
  const head = numberText(298);
  const tail = ' 299 300 301';
  assert.ok(tail.length < 16, '末段必须短于早停守卫的 16 字符窗口');

  const send = async (prompt, { onDelta } = {}) => {
    if (typeof onDelta === 'function') {
      onDelta(head);
      onDelta(tail);
    }
    return { text: head + tail, endReason: 'length' };
  };

  const sample = await runChallenge({
    challenge: { id: 'fix9-f', expected_count: 300, prompt: 'p' },
    send,
  });

  assert.equal(realParseNumbers(sample.rawText).length, 301, '最终文本应比 expectedCount 多一个整数');
  assert.equal(sample.state, 'truncated', '第二维必须把它救回来，不能丢样本');
  assert.match(sample.error, /已按「宽松截断豁免」接受/);
});
