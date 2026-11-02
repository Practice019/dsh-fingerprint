/**
 * dsh-fingerprint / test/send.test.mjs
 *
 * 契约 §12.B 要求：mock 分片流，覆盖
 *   1) 5 种 finish.reason.kind 全部正确映射
 *   2) reasoning-delta 不进入正文
 *   3) firstByteMs 非 null 且 ≥ 0
 *   4) 流抛错 / finish 缺失 时的兜底行为
 *   5) signal 取消 → 不挂死
 *   （追加）6) messages 形状 7) 未知 kind 8) 运行时取证记录真实键集合
 *
 * 禁止真实模型调用：所有 stream 都是本地 mock。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapFinish, sendViaLlm, finishObservations } from '../lib/send.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 造一个带 `llm.stream()` 的假 ctx。
 * @param {Array<object|Function>} script 依次产出的分片；函数会被 await（可用来 insert 延迟或抛错）
 */
function makeCtx(script) {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* generate() {
          for (const step of script) {
            if (typeof step === 'function') {
              const produced = await step();
              if (produced !== undefined) yield produced;
              continue;
            }
            yield step;
          }
        })();
      },
    },
  };
}

const delta = (text) => ({ type: 'text-delta', text });
const reasoning = (text) => ({ type: 'reasoning-delta', text });
const finish = (reason) => ({ type: 'finish', reason });

const BASE_INPUT = { provider: 'provider_a', model: 'example/text-image', prompt: 'count 1..300' };

// ── 1) 五值映射 ─────────────────────────────────────────────────────────────

test('mapFinish：5 种 kind 全部映射到契约 §10 的词表', () => {
  assert.equal(mapFinish({ kind: 'stop' }).endReason, 'stop');
  assert.equal(mapFinish({ kind: 'max-tokens' }).endReason, 'length');
  assert.equal(mapFinish({ kind: 'tool-calls' }).endReason, 'tool_calls');
  assert.equal(mapFinish({ kind: 'error' }).endReason, 'error');
  assert.equal(mapFinish({ kind: 'aborted' }).endReason, 'aborted');
  // 只有 stop 算正常结束
  assert.equal(mapFinish({ kind: 'stop' }).ok, true);
  for (const kind of ['max-tokens', 'tool-calls', 'error', 'aborted']) {
    assert.equal(mapFinish({ kind }).ok, false, `${kind} 不应被视为正常结束`);
  }
});

test('sendViaLlm：5 种 finish 分片在真实流中同样被映射', async () => {
  const cases = [
    ['stop', 'stop'],
    ['max-tokens', 'length'],
    ['tool-calls', 'tool_calls'],
    ['error', 'error'],
    ['aborted', 'aborted'],
  ];
  for (const [kind, expected] of cases) {
    const ctx = makeCtx([delta('42 '), finish({ kind, failure: { message: `failure of ${kind}` } })]);
    const result = await sendViaLlm(ctx, { ...BASE_INPUT });
    assert.equal(result.endReason, expected, `kind=${kind}`);
  }
});

test('error 分片把 failure.message 带出来（写进 note 与取证缓冲）', async () => {
  const ctx = makeCtx([finish({ kind: 'error', failure: { message: 'quota exceeded' } })]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT });
  assert.equal(result.endReason, 'error');
  assert.match(String(result.note), /quota exceeded/);
  const last = finishObservations.at(-1);
  assert.equal(last.endReason, 'error');
});

// ── 2) reasoning-delta 必须被排除 ───────────────────────────────────────────

test('sendViaLlm：reasoning-delta 的内容不进入正文', async () => {
  const ctx = makeCtx([
    reasoning('让我想想……用户要 300 个数字。'),
    delta('1 2 3 '),
    reasoning('继续思考'),
    delta('4 5 6'),
    finish({ kind: 'stop' }),
  ]);
  const seen = [];
  const result = await sendViaLlm(ctx, { ...BASE_INPUT, onDelta: (text) => seen.push(text) });
  assert.equal(result.text, '1 2 3 4 5 6');
  assert.equal(result.text.includes('想想'), false);
  assert.equal(result.text.includes('思考'), false);
  // onDelta 只应看到正文分片
  assert.deepEqual(seen, ['1 2 3 ', '4 5 6']);
});

// ── 3) firstByteMs ─────────────────────────────────────────────────────────

test('sendViaLlm：firstByteMs 自测首个 text-delta 到达时刻（非 null 且 ≥ 0）', async () => {
  let firstSeen = null;
  const ctx = makeCtx([
    finish({ kind: 'stop' }), // 先给 finish 也不影响计时（正文分片才计时）
    async () => {
      await sleep(20);
      return delta('7 8 9');
    },
  ]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT, onDelta: () => { if (firstSeen === null) firstSeen = Date.now(); } });
  assert.notEqual(result.firstByteMs, null);
  assert.ok(Number.isFinite(result.firstByteMs));
  assert.ok(result.firstByteMs >= 0);
  assert.notEqual(firstSeen, null);
});

test('sendViaLlm：完全没有正文分片时 firstByteMs 为 null（不谎报 0）', async () => {
  const ctx = makeCtx([finish({ kind: 'stop' })]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT });
  assert.equal(result.firstByteMs, null);
  assert.equal(result.text, '');
});

// ── 4) 兜底：抛错 / finish 缺失 ─────────────────────────────────────────────

test('sendViaLlm：流中途抛错 → endReason=error，且已收到的正文保留', async () => {
  const ctx = makeCtx([
    delta('10 20 '),
    () => {
      throw new Error('socket hang up');
    },
  ]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT });
  assert.equal(result.endReason, 'error');
  assert.equal(result.text, '10 20 ');
  assert.match(String(result.note), /socket hang up/);
});

test("sendViaLlm：流没有 finish 分片 → 按 'stop' 兜底并留备注", async () => {
  const ctx = makeCtx([delta('1 2 3')]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT });
  assert.equal(result.endReason, 'stop');
  assert.match(String(result.note), /未给出 finish/);
  const last = finishObservations.at(-1);
  assert.equal(last.missingFinish, true);
});

test('mapFinish：未知 kind 与畸形 reason 都降级成 error，不抛异常', () => {
  assert.equal(mapFinish({ kind: 'brand-new-kind' }).endReason, 'error');
  assert.equal(mapFinish(undefined).endReason, 'error');
  assert.equal(mapFinish('stop').endReason, 'error');
  assert.equal(mapFinish(null).endReason, 'error');
  assert.equal(mapFinish({ kind: 'stop', extra: 1 }).endReason, 'stop');
});

// ── 5) 取消不挂死 ──────────────────────────────────────────────────────────

test('sendViaLlm：外部 signal 取消 → 及时返回 aborted，不挂死', async () => {
  const controller = new AbortController();
  // 一个“不听话”的流：忽略 signal，持续产出
  const ctx = makeCtx([
    delta('1 '),
    async () => {
      await sleep(25);
      return delta('2 ');
    },
    async () => {
      await sleep(25);
      return delta('3 ');
    },
    async () => {
      await sleep(2000);
      return delta('late');
    },
  ]);
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 40);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT, signal: controller.signal });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.endReason, 'aborted');
  assert.ok(elapsed < 1000, `应在取消后迅速返回，实际 ${String(elapsed)}ms`);
});

test('sendViaLlm：进入时 signal 已 aborted → 立刻返回 aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = makeCtx([delta('never')]);
  const result = await sendViaLlm(ctx, { ...BASE_INPUT, signal: controller.signal });
  assert.equal(result.endReason, 'aborted');
});

// ── 6) 参数形状（契约 §10.1）───────────────────────────────────────────────

test('sendViaLlm：messages 用 RequestUserInput 形式，且 provider/model 原样透传', async () => {
  const ctx = makeCtx([delta('1'), finish({ kind: 'stop' })]);
  await sendViaLlm(ctx, { ...BASE_INPUT, temperature: 0.7, maxTokens: 4096, reasoningEffort: 'off' });
  const options = ctx.calls[0];
  assert.equal(options.provider, 'provider_a');
  assert.equal(options.model, 'example/text-image');
  assert.equal(options.temperature, 0.7);
  assert.equal(options.maxTokens, 4096);
  assert.equal(options.reasoningEffort, 'off');
  assert.equal(Array.isArray(options.messages), true);
  assert.equal(options.messages.length, 1);
  assert.equal(options.messages[0].role, 'user');
  assert.equal(options.messages[0].content[0].type, 'text');
  assert.equal(options.messages[0].content[0].text, BASE_INPUT.prompt);
  assert.equal(options.messages[0].id, undefined, '不需要持久 Message 的 id');
  assert.ok(options.signal instanceof AbortSignal);
});

test('sendViaLlm：未给的调用参数不出现在 stream options 里（不污染适配器默认值）', async () => {
  const ctx = makeCtx([finish({ kind: 'stop' })]);
  await sendViaLlm(ctx, { ...BASE_INPUT });
  const options = ctx.calls[0];
  assert.equal(Object.hasOwn(options, 'temperature'), false);
  assert.equal(Object.hasOwn(options, 'maxTokens'), false);
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false);
});

// ── 7) 运行时取证缓冲 ──────────────────────────────────────────────────────

test('finishObservations：记录 finish.reason 的真实键集合（用于核对类型声明）', async () => {
  const before = finishObservations.length;
  const ctx = makeCtx([finish({ kind: 'stop', extraField: true })]);
  await sendViaLlm(ctx, { ...BASE_INPUT });
  assert.equal(finishObservations.length, before + 1);
  const last = finishObservations.at(-1);
  assert.deepEqual(last.rawKeys.sort(), ['extraField', 'kind']);
  assert.equal(last.kind, 'stop');
  assert.equal(last.endReason, 'stop');
  assert.equal(last.provider, 'provider_a');
});
