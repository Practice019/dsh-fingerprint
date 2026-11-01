/**
 * lib/probe.js —— 取样层（W3）
 *
 * 职责：把「一道挑战」变成「一条可评分的样本」。
 * 契约：`dsh-fingerprint-CONTRACT.md` §4.2（本文档为唯一真相源）
 *
 * 与 DSH 完全解耦：所有模型调用都通过注入的 `send` 完成，因此本模块可离线单测。
 *
 * ── 规则出处（照抄官方文档，逐条对应）────────────────────────────────────
 *   https://lm.ikale.io/docs/sdk/api   「取样规则」一节：
 *     1. 宽松模式下，流式回答收到 expected_count 个整数后就停止读取，样本状态为 truncated
 *     2. 回答必须正常结束：结束原因是 stop / end_turn / completed
 *        拒答、内容过滤和未完成的回答都算失败，**除非宽松模式已经截断**
 *     3. 有效回答至少要有 max(80, ceil(expected_count × 0.55)) 个整数
 *     4. 不跟随重定向，不自动重试
 *   https://lm.ikale.io/docs/sdk/api   「结果 / Sample」一节：
 *     state ∈ complete | truncated | failed（官方另有 cancelled）
 *     ⚠️ 本项目**不产出 `cancelled`**（契约 §20.4 主脑裁决）：外部取消一律计入 `failed`，
 *        取消这件事由 `lib/index.js` 的 run 级 `phase` 负责表达。不要照抄官方的四态。
 *   https://lm.ikale.io/docs/sdk       「读结果」一节：
 *     一条回答至少要有 max(80, ceil(expected_count × 0.55)) 个 1–355 之间的整数才算有效
 *
 * ── 结束原因豁免是**两维**判据（照抄官方，勿只认一维）────────────────────
 *   官方 `lmfpd-sdk/index.js:483`：
 *       truncated = !final || numbers.length > expected_count
 *   `lmfpd-sdk/index.js:671` 用它豁免结束原因检查：
 *       if (!truncated && (!terminal || !["stop","end_turn","completed"].includes(finish))) throw …
 *   两维在本模块的对应物：
 *       - `!final`                        → `truncatedEarly`（非严格模式收满 expectedCount 主动早停）
 *       - `numbers.length > expected_count` → `assessed.state === 'truncated'`（读完的回答超长）
 *   只认前者会**错误丢弃**「被 max-tokens 截断但整数已够」的样本 → 有效回合变少 →
 *   更容易落成 partial / unscorable，**会改变检测结论**。
 *
 * ── DSH 侧注意事项（证词，供宿主侧 send 适配器使用）──────────────────────
 * 宿主 `ctx.llm.stream(options)` 的分片词表**不是** lmfpd 的词表，适配时必须映射：
 *   - 分片判别字段是 `chunk.type`，取值：block-start | text-delta | reasoning-delta
 *     | tool-call-delta | block-end | usage | finish
 *     证据：`@deepseek-ai/dsh-llm/lib/typert.host.js:572`（StreamChunk 联合类型声明）
 *   - 终止分片是 `{ type:'finish', reason: FinishReason }` —— 字段名是 **reason**，
 *     且 `FinishReason` 是 tagged union，判别字段是 **kind**：
 *       stop | tool-calls | max-tokens | aborted | error
 *     证据：`@deepseek-ai/dsh-llm/lib/typert.host.js:356`（FinishReasonMap）
 *     失败分片形如 `{ kind:'error', failure }` / `{ kind:'aborted', failure }`，
 *     failure 是 `{ message, code, status?, ... }`（typert.host.js:412）。
 *   - 因此宿主侧 send 应做如下映射后再交给本模块：
 *       kind 'stop'       → 'stop'      （∈ OK_END_REASONS）
 *       kind 'max-tokens' → 'length'    （非 OK；官方视 max-tokens 为未完成，除非宽松截断）
 *       kind 'tool-calls' → 'tool_calls'（非 OK；挑战不需要工具调用）
 *       kind 'error'      → 'error'     （非 OK，把 failure.message 带进 error 备注）
 *       kind 'aborted'    → 外部 signal 取消 → 'aborted'；本模块自身因截断而 abort → 走截断豁免
 *   - 分片上**没有**时间戳；`firstByteMs` 只能由 send 侧自行记录（首个 text-delta 到达时刻），
 *     `StreamChunk` 联合类型未声明任何时间字段（typert.host.js:572）。本模块也会自己兜底测量。
 */

// ── 常量（契约 §4.2 冻结）───────────────────────────────────────────────

/** 有效回答的整数个数下限（绝对下限）。官方：max(80, ceil(expected_count × 0.55))。 */
export const MIN_ABSOLUTE = 80;

/** 有效回答的整数个数下限（相对 expected_count 的比例）。 */
export const MIN_RATIO = 0.55;

/** 允许的结束原因白名单（lmfpd 词表：OpenAI stop / Anthropic end_turn / Responses completed）。 */
export const OK_END_REASONS = ['stop', 'end_turn', 'completed'];

/** onProgress 节流窗口（毫秒）。官方提示「界面需要的话自己限制刷新频率」。 */
const PROGRESS_THROTTLE_MS = 100;

/** 流式早停的重解析最小增量（字符）。避免每个 delta 都全量重解析造成 O(n²)。 */
const REPARSE_MIN_GROWTH = 16;

/**
 * 有效回答所需的最少整数个数。
 * 官方：`max(80, ceil(expected_count × 0.55))`。
 * @param {number} expectedCount 挑战要求的整数个数（正整数）
 * @returns {number}
 */
export function minimumNumbers(expectedCount) {
  const n = Number(expectedCount);
  if (!Number.isFinite(n) || n <= 0) return MIN_ABSOLUTE;
  return Math.max(MIN_ABSOLUTE, Math.ceil(n * MIN_RATIO));
}

// ── detector 绑定（懒加载 + 可注入）────────────────────────────────────
//
// `lib/detector.js` 由 W2 拥有，可能尚未落盘。因此**不在模块顶层静态 import**
// （否则本模块在 detector.js 缺失时连加载都失败，单测也无法运行）。
// 改为运行时 `import()` 懒加载，并允许测试/宿主显式注入绑定。

/** @type {{parseNumbers: Function, generateChallenges: Function, analyze: Function} | null} */
let detectorBinding = null;

/** 正在进行的懒加载 Promise（并发调用去重）。 */
let detectorLoading = null;

/**
 * 显式注入 detector 绑定。测试用 stub、宿主提前预热都用它。
 * @param {{parseNumbers: Function, generateChallenges: Function, analyze: Function}} binding
 */
export function bindDetector(binding) {
  if (binding === null || typeof binding !== 'object') {
    throw new TypeError('bindDetector 需要一个对象');
  }
  for (const key of ['parseNumbers', 'generateChallenges', 'analyze']) {
    if (typeof binding[key] !== 'function') {
      throw new TypeError(`bindDetector 缺少必需函数：${key}`);
    }
  }
  detectorBinding = binding;
  detectorLoading = null;
  return detectorBinding;
}

/**
 * 确保 detector 绑定可用：**真正加载单例** → 再绑定 `./detector.js` 的导出。
 *
 * 契约 §11.3：`analyze()` 是 `lib/detector.js` 提供的**同步包装**，它依赖已加载的单例。
 * 所以这里必须在绑定校验**之前** `await getDetector()`；否则 `runRound` 里那句同步
 * `analyze(...)` 会每轮都抛「检测器尚未加载」→ 被捕获成 `评分失败：…`，
 * 外部即表现为「检测器坏了」。
 *
 * 契约 §11.2：`getDetector()` **失败时不抛**，返回 `{detector:null, ..., error}`。
 * 必须显式判空，否则后面 `analyze()` 就成了 `Cannot read properties of null`。
 * 这里把该失败转成**可读异常**，交给上层（`runRound` / W7 的 HTTP 层）映射成
 * `{ok:false, error:{code:'DETECTOR_UNAVAILABLE', message}}`。
 *
 * @param {{force?: boolean, source?: string}} [options]
 *   `force`  ：丢弃单例重新加载一次。
 *   `source` ：**仅供测试/离线**——单个非 http(s) 字符串会被 SDK 当作本地参考库目录
 *              （`lmfpd-sdk/index.js:1916-1917` 短路到 `readDir`，全程不联网）。
 *              常规调用不要传。
 * @returns {Promise<{parseNumbers: Function, generateChallenges: Function, analyze: Function}>}
 */
export async function ensureDetector(options = {}) {
  if (detectorBinding !== null) return detectorBinding;
  if (detectorLoading === null) {
    detectorLoading = (async () => {
      let mod;
      try {
        mod = await import('./detector.js');
      } catch (cause) {
        detectorLoading = null;
        throw new Error(
          `无法加载 ./detector.js（应由 W2 提供，并从 lmfpd-sdk 转出 parseNumbers/generateChallenges/analyze）：${cause?.message ?? cause}`,
          { cause },
        );
      }

      // ── 契约 §11.3 的一行：先真正加载单例，同步 analyze() 才可用 ────────
      let loaded;
      try {
        loaded = await mod.getDetector(options);
      } catch (cause) {
        detectorLoading = null;
        throw new Error(`lmfpd 检测器加载异常：${cause?.message ?? cause}`, { cause });
      }
      // §11.2：getDetector() 失败不抛，所以必须判空（否则后面就是 null 解引用）
      if (loaded === null || loaded?.detector === null || loaded?.detector === undefined) {
        detectorLoading = null;
        const reason = loaded?.error ?? '未提供失败原因（getDetector() 既未抛错也未返回 error）';
        throw new Error(`lmfpd 检测器不可用（同步 analyze() 无法工作）：${reason}`);
      }

      try {
        return bindDetector({
          parseNumbers: mod.parseNumbers,
          generateChallenges: mod.generateChallenges,
          analyze: mod.analyze,
        });
      } catch (cause) {
        detectorLoading = null;
        throw new Error(`./detector.js 的导出不符合契约 §4.1：${cause?.message ?? cause}`, { cause });
      }
    })();
  }
  return detectorLoading;
}

/** 同步取绑定；未就绪时明确报错（而不是静默用错实现）。 */
function requireDetector() {
  if (detectorBinding === null) {
    throw new Error('detector 绑定尚未就绪：请先 `await ensureDetector()` 或 `bindDetector(...)`');
  }
  return detectorBinding;
}

// ── 文本级评估（纯函数，可离线单测）──────────────────────────────────

/**
 * 对一条**已收到的原始回答文本**做取样规则评估（不涉及网络与结束原因）。
 * @param {{rawText: string, expectedCount: number, strict?: boolean}} input
 * @returns {{state:'complete'|'truncated'|'failed', text:string, rawText:string,
 *            count:number, rawCount:number, expectedCount:number, minimum:number, error:string|null}}
 */
export function assessSample({ rawText, expectedCount, strict = false }) {
  const text = typeof rawText === 'string' ? rawText : '';
  const expected = Number(expectedCount);
  const minimum = minimumNumbers(expected);
  const { parseNumbers } = requireDetector();

  if (!Number.isInteger(expected) || expected <= 0) {
    return {
      state: 'failed',
      text: '',
      rawText: text,
      count: 0,
      rawCount: 0,
      expectedCount: expected,
      minimum,
      error: `expectedCount 非法：${expectedCount}（必须是正整数）`,
    };
  }

  const parsed = parseNumbers(text);
  const rawCount = Array.isArray(parsed) ? parsed.length : 0;

  // 规则 3：整数个数不足 → 失败（官方「有效回答至少要有 …」）
  if (rawCount < minimum) {
    return {
      state: 'failed',
      text: '',
      rawText: text,
      count: rawCount,
      rawCount,
      expectedCount: expected,
      minimum,
      error: `整数个数不足：${rawCount} < 最小要求 ${minimum}（expectedCount=${expected}）`,
    };
  }

  // 规则 1：宽松模式下超出 expectedCount 的部分截掉 → truncated
  // 规则 4：严格模式不截断（官方「严格模式不截断，要求三条完整的回答」）
  if (!strict && rawCount > expected) {
    const kept = parsed.slice(0, expected);
    return {
      state: 'truncated',
      // 截断后只保留前 expectedCount 个整数；用解析结果重建等价文本，
      // 对 analyze 而言与「原文截断」等价（它同样按整数解析）。
      text: kept.join(' '),
      rawText: text,
      count: kept.length,
      rawCount,
      expectedCount: expected,
      minimum,
      error: null,
    };
  }

  return {
    state: 'complete',
    // 未截断时直接把原文交给 analyze：这样它的 diagnostics.raw_out_of_range_count
    // 等原始统计才准确（analyze 自己会取最长数字段）。
    text,
    rawText: text,
    count: rawCount,
    rawCount,
    expectedCount: expected,
    minimum,
    error: null,
  };
}

// ── 单条挑战 ──────────────────────────────────────────────────────────

/** 把挑战对象规整成内部表示（lmfpd 的 Challenge 用 expected_count）。 */
function normalizeChallenge(challenge) {
  const expectedCount = Number(challenge?.expectedCount ?? challenge?.expected_count);
  return {
    challengeId: challenge?.id ?? null,
    prompt: typeof challenge?.prompt === 'string' ? challenge.prompt : '',
    expectedCount,
  };
}

/** 结束原因归一化：非字符串/空 → 视为「未知」（未证实）。 */
function normalizeEndReason(endReason) {
  if (typeof endReason !== 'string') return null;
  const trimmed = endReason.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * 跑一道挑战，产出可评分样本。
 * @param {object} input
 * @param {{id?:any, prompt:string, expectedCount?:number, expected_count?:number}} input.challenge
 * @param {(prompt:string, opts:{signal?:AbortSignal, onDelta?:(t:string)=>void}) =>
 *          Promise<{text:string, endReason?:string, firstByteMs?:number}>} input.send 注入的调用器
 * @param {boolean} [input.strict]
 * @param {AbortSignal} [input.signal]
 * @param {(p:{state:string,count:number,expectedCount:number,firstByteMs:number|null})=>void} [input.onProgress]
 * @returns {Promise<{challengeId:any, prompt:string, expectedCount:number, state:string,
 *                    text:string, rawText:string, count:number, firstByteMs:number|null, error:string|null}>}
 */
export async function runChallenge({ challenge, send, strict = false, signal, onProgress }) {
  const { challengeId, prompt, expectedCount } = normalizeChallenge(challenge);

  /** 失败兜底结果。 */
  const fail = (error) => ({
    challengeId,
    prompt,
    expectedCount,
    state: 'failed',
    text: '',
    rawText: '',
    count: 0,
    firstByteMs: null,
    error,
  });

  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    return fail(`挑战的 expectedCount 非法：${challenge?.expectedCount ?? challenge?.expected_count}`);
  }
  if (typeof send !== 'function') {
    return fail('runChallenge 缺少 send 注入（签名：(prompt, {signal, onDelta}) => Promise<{text, endReason, firstByteMs?}>)');
  }
  // 规则：已取消则不发请求（契约要求「不调 send」）
  if (signal?.aborted) {
    return fail('已取消：开始前 signal 即为 aborted');
  }

  const binding = await ensureDetector();
  const { parseNumbers } = binding;

  // 内部控制器：外部取消 → 转发；自身因截断早停 → 也走它，但标记豁免。
  const controller = new AbortController();
  let externalAborted = false;
  const onExternalAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  let buffer = '';
  let firstByteMs = null;
  let truncatedEarly = false;
  let lastParsedLength = 0;
  let lastProgressAt = 0;
  let progressEmitted = false;

  const emitProgress = (state, count, force) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && progressEmitted && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    progressEmitted = true;
    try {
      onProgress({ state, count, expectedCount, firstByteMs });
    } catch {
      // 回调异常不得影响取样（契约：进度回调是旁路）
    }
  };

  const startedAt = Date.now();
  let result = null;
  let thrown = null;
  try {
    result = await send(prompt, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (typeof delta !== 'string' || delta === '') return;
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt; // 分片无时间戳，只能自测
        buffer += delta;

        // 早停判定只对宽松模式生效（规则 1）；严格模式必须读完（规则 4）。
        if (!strict && !truncatedEarly && buffer.length - lastParsedLength >= REPARSE_MIN_GROWTH) {
          lastParsedLength = buffer.length;
          let seen = 0;
          try {
            const parsed = parseNumbers(buffer);
            seen = Array.isArray(parsed) ? parsed.length : 0;
          } catch {
            seen = 0; // 解析异常不致命：最终还会再解析一次
          }
          if (seen >= expectedCount) {
            truncatedEarly = true;
            controller.abort();
            emitProgress('streaming', seen, true);
            return;
          }
          emitProgress('streaming', seen, false);
          return;
        }
        emitProgress('streaming', Math.min(buffer.length, expectedCount), false);
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  const rawText = buffer.length > 0 ? buffer : (typeof result?.text === 'string' ? result.text : '');

  // 外部取消：整轮不评分
  if (externalAborted || signal?.aborted) {
    return {
      challengeId, prompt, expectedCount,
      state: 'failed',
      text: '',
      rawText,
      count: 0,
      firstByteMs: firstByteMs ?? (Number.isFinite(result?.firstByteMs) ? result.firstByteMs : null),
      error: '已取消：外部 signal 中止',
    };
  }

  if (thrown !== null) {
    const detail = thrown?.message ?? String(thrown);
    const code = thrown?.code ? `[${thrown.code}] ` : '';
    return {
      challengeId, prompt, expectedCount,
      state: 'failed',
      text: '',
      rawText,
      count: 0,
      firstByteMs: firstByteMs ?? null,
      error: `调用失败：${code}${detail}`,
    };
  }

  if (result) {
    if (!Number.isFinite(firstByteMs) && Number.isFinite(result.firstByteMs)) {
      firstByteMs = Math.round(result.firstByteMs);
    }
  }

  const endReason = normalizeEndReason(result?.endReason);

  // 样本级评估异常（例如解析器对畸形文本抛错）必须降级成可读 error，
  // 不得让异常穿透 Promise.all 把整轮打挂。
  let assessed;
  try {
    assessed = assessSample({ rawText, expectedCount, strict });
  } catch (error) {
    return {
      challengeId, prompt, expectedCount,
      state: 'failed',
      text: '',
      rawText,
      count: 0,
      firstByteMs,
      error: `样本评估失败：${error?.message ?? error}`,
    };
  }

  // 规则 2：结束原因必须 ∈ OK_END_REASONS。
  // 官方豁免：「拒答、内容过滤和未完成的回答都算失败，**除非宽松模式已经截断**」。
  //
  // ⚠️ 豁免是**两维**判据，等价官方 `truncated = !final || numbers.length > expected_count`
  //    （`lmfpd-sdk/index.js:483`，用在 `:671` 的结束原因检查上）：
  //      · truncatedEarly            ⇔ 官方 !final（非严格模式收满 expectedCount 主动早停）
  //      · assessed.state==='truncated' ⇔ 官方 numbers.length > expected_count（读完但超长）
  //    只认前者会错误丢弃「max-tokens 截断但整数已够」的样本，进而改变检测结论。
  // 保守策略：拿不到结束原因（未证实）时按正常结束处理，但把情况写进 error 备注。
  const truncated = truncatedEarly || assessed.state === 'truncated';
  let endNote = null;
  if (!truncated) {
    if (endReason === null) {
      endNote = '未取到结束原因，按正常结束处理（保守策略）';
    } else if (!OK_END_REASONS.includes(endReason)) {
      return {
        challengeId, prompt, expectedCount,
        state: 'failed',
        text: '',
        rawText,
        count: assessed.count,
        firstByteMs,
        error: `结束原因不可接受：${endReason}（要求 ∈ ${OK_END_REASONS.join(' | ')}）`,
      };
    }
  } else {
    // 已达豁免条件。若结束原因本不可接受，留一条备注说明它为何仍被接受（状态不受影响）。
    if (endReason !== null && !OK_END_REASONS.includes(endReason)) {
      endNote = `结束原因 ${endReason} 已按「宽松截断豁免」接受（官方 lmfpd-sdk 两维判据）`;
    } else if (truncatedEarly && assessed.state !== 'truncated') {
      // 边角：早停后重新评估却不再是 truncated（例如解析抖动）——以评估结果为准，仅加注
      endNote = `宽松模式已早停，但复查状态为 ${assessed.state}`;
    }
  }

  const state = truncatedEarly && assessed.state === 'complete' ? 'truncated' : assessed.state;
  const error = assessed.error ?? endNote;

  emitProgress(state, assessed.count, true);

  return {
    challengeId,
    prompt,
    expectedCount,
    state,
    text: assessed.text,
    rawText,
    count: assessed.count,
    firstByteMs,
    error,
  };
}

// ── 一轮（1–3 道挑战 + 评分）──────────────────────────────────────────

/**
 * 跑一轮：生成挑战 → 全并发取样 → 评分。
 * @param {object} input
 * @param {number} [input.count] 每轮挑战数，1–3
 * @param {boolean} [input.strict]
 * @param {AbortSignal} [input.signal]
 * @param {Function} input.send 见 {@link runChallenge}
 * @param {(index:number, sample:object)=>void} [input.onSample]
 * @returns {Promise<{challenges:any[], samples:object[], analysis:object|null, error:string|null}>}
 */
export async function runRound({ count = 3, strict = false, signal, send, onSample } = {}) {
  let binding;
  try {
    binding = await ensureDetector();
  } catch (error) {
    // detector 层系统性失败（缺文件 / 导出不符契约）：转成可读 error，不炸穿 HTTP handler
    return { challenges: [], samples: [], analysis: null, error: `detector 不可用：${error?.message ?? error}` };
  }
  const { generateChallenges, analyze } = binding;

  let challenges;
  try {
    challenges = generateChallenges(count);
  } catch (error) {
    return {
      challenges: [],
      samples: [],
      analysis: null,
      error: `生成挑战失败：${error?.message ?? error}`,
    };
  }

  const list = Array.isArray(challenges) ? challenges : [];

  // 契约：并发数固定为 count（全并发）；跨任务并发由上层控制。
  const samples = await Promise.all(
    list.map(async (challenge, index) => {
      const sample = await runChallenge({ challenge, send, strict, signal });
      if (typeof onSample === 'function') {
        try {
          onSample(index, sample);
        } catch {
          // 回调异常不得影响取样
        }
      }
      return sample;
    }),
  );

  // 有效样本 = 通过取样规则的样本（complete / truncated）
  const valid = samples.filter((s) => s.state === 'complete' || s.state === 'truncated');

  if (valid.length === 0) {
    return { challenges: list, samples, analysis: null, error: 'No valid samples. This round cannot be scored.' };
  }
  if (strict && valid.length < 3) {
    return {
      challenges: list,
      samples,
      analysis: null,
      error: `Strict mode requires 3/3 successful samples; received ${valid.length}/3.`,
    };
  }

  let analysis = null;
  try {
    analysis = analyze(
      valid.map((s) => ({ text: s.text, expected_count: s.expectedCount })),
      { strict },
    );
  } catch (error) {
    return {
      challenges: list,
      samples,
      analysis: null,
      error: `评分失败：${error?.message ?? error}`,
    };
  }

  return { challenges: list, samples, analysis, error: null };
}
