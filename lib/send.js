/**
 * dsh-fingerprint / lib/send.js
 *
 * 契约 §10：把 DSH 的分片流适配成 probe 需要的 `send`。
 *
 * DSH 的终止分片是 **tagged union**，判别字段是 `kind`：
 *   { kind:'stop' } | { kind:'tool-calls' } | { kind:'max-tokens' }
 * | { kind:'aborted'; failure } | { kind:'error'; failure }
 * 而 probe 的 `OK_END_REASONS = ['stop','end_turn','completed']` 是 **lmfpd 词表**。
 * 两份词表不同，必须显式映射（`kind:'stop'` 之外一律让样本 failed / 由 probe 判 truncated）。
 *
 * 运行时取证：`finishObservations` 记录每个 finish 分片里 `reason` 的**真实键集合**，
 * 用来核对类型声明（`dsh-llm/lib/typert.host.js:356`）是否与运行时一致。
 */

/** finish.reason.kind → probe endReason（契约 §10 冻结映射表）。 */
const KIND_TO_END_REASON = {
  stop: 'stop',
  'max-tokens': 'length',
  'tool-calls': 'tool_calls',
  error: 'error',
  aborted: 'aborted',
};

/** 这些 kind 会让该样本被判为「非正常结束」（probe 侧据此失败）。 */
const NORMAL_KINDS = new Set(['stop']);

/** 运行时取证缓冲（上限 64 条，避免内存无界增长）。 */
export const finishObservations = [];

/**
 * 把 DSH `finish.reason` 映射成 probe 的 `endReason`（纯函数，可离线单测）。
 * @param {unknown} reason DSH finish 分片的 reason
 * @returns {{endReason:string, ok:boolean, aborted:boolean, kind:string|null, message:string|null, rawKeys:string[]}}
 */
export function mapFinish(reason) {
  const object = reason !== null && typeof reason === 'object' ? reason : {};
  const rawKeys = Object.keys(object);
  const kind = typeof object.kind === 'string' ? object.kind : null;
  const failure = object.failure !== null && typeof object.failure === 'object' ? object.failure : null;
  const message =
    failure !== null && typeof failure.message === 'string' && failure.message !== ''
      ? failure.message
      : null;

  if (kind === null) {
    return {
      endReason: 'error',
      ok: false,
      aborted: false,
      kind: null,
      message: `finish.reason 缺少字符串 kind（收到键：${JSON.stringify(rawKeys)}）`,
      rawKeys,
    };
  }
  const endReason = Object.hasOwn(KIND_TO_END_REASON, kind) ? KIND_TO_END_REASON[kind] : 'error';
  const known = Object.hasOwn(KIND_TO_END_REASON, kind);
  return {
    endReason,
    ok: known && NORMAL_KINDS.has(kind),
    aborted: kind === 'aborted',
    kind,
    message: known ? message : `未知的 finish.reason.kind: ${JSON.stringify(kind)}（收到键：${JSON.stringify(rawKeys)}）`,
    rawKeys,
  };
}

/** 把一次观测写进取证缓冲。 */
function observe(observation) {
  finishObservations.push(observation);
  while (finishObservations.length > 64) finishObservations.shift();
}

/**
 * 跑一次模型调用，产出 probe 需要的样本正文与结束原因。
 *
 * @param {object} ctx 插件上下文（`llm` 已注入）
 * @param {object} input
 * @param {string} input.provider
 * @param {string} input.model
 * @param {string} input.prompt
 * @param {AbortSignal} [input.signal] 调用方取消信号（probe 的早停也走它）
 * @param {string} [input.reasoningEffort]
 * @param {number} [input.temperature]
 * @param {number} [input.maxTokens]
 * @param {(delta:string)=>void} [input.onDelta] 每个正文分片到达时回调（probe 用它早停与计时）
 * @returns {Promise<{text:string, endReason:string, firstByteMs:number|null, note:string|null}>}
 */
export async function sendViaLlm(ctx, input) {
  const { provider, model, prompt, signal, reasoningEffort, temperature, maxTokens, onDelta } = input;

  // 内部控制器：外部取消 → 转发；同时保证即使 provider 忽略 signal，循环也能退出。
  const controller = new AbortController();
  let externalAborted = signal?.aborted === true;
  const onExternalAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const startedAt = Date.now();
  let firstByteMs = null;
  let body = '';
  let mapped = null;
  let note = null;

  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      // 契约 §10.1：RequestUserInput 形式最省事，不需要持久 Message 的 id
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      if (externalAborted || controller.signal.aborted) break;
      const type = chunk?.type;
      if (type === 'text-delta') {
        // §10.1：正文只吃 text-delta；reasoning-delta 是思考过程，混进来会污染整数解析。
        const delta = typeof chunk.text === 'string' ? chunk.text : '';
        if (delta === '') continue;
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt; // 分片无时间戳，只能自测
        body += delta;
        if (typeof onDelta === 'function') onDelta(delta);
      } else if (type === 'finish') {
        mapped = mapFinish(chunk.reason);
        observe({
          provider,
          model,
          kind: mapped.kind,
          endReason: mapped.endReason,
          rawKeys: mapped.rawKeys,
          observedAt: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    // 取消导致的抛错不算模型错误
    if (externalAborted || controller.signal.aborted) {
      mapped = { endReason: 'aborted', ok: false, aborted: true, message: null };
    } else {
      mapped = {
        endReason: 'error',
        ok: false,
        aborted: false,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    if (error instanceof Error && error.name !== 'AbortError') note = `流读取异常：${String(mapped.message)}`;
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort);
  }

  if (mapped === null) {
    // 契约 §12.B：流缺 finish 分片时按 'stop' 兜底，但记备注。
    mapped = { endReason: 'stop', ok: true, aborted: false, message: null };
    note = '流未给出 finish 分片，按 stop 兜底（保守策略，probe 仍会独立校验样本长度）';
    observe({ provider, model, kind: null, endReason: 'stop', rawKeys: [], observedAt: new Date().toISOString(), missingFinish: true });
  }
  if (externalAborted || controller.signal.aborted) {
    mapped = { ...mapped, endReason: 'aborted', aborted: true };
    note = note ?? '调用被取消';
  }
  if (mapped.message !== null && mapped.message !== undefined && note === null) note = mapped.message;

  return { text: body, endReason: mapped.endReason, firstByteMs, note: note ?? null };
}
