/**
 * lib/aggregate.js —— 多轮指纹检测结果的聚合层（契约 §4.3，负责人 W5）
 *
 * 官方 SDK 明确不做多轮检测（原文：「SDK 不做分词器探测，也不提供多轮检测；需要多轮时，
 * 在自己的程序里循环调用」），因此轮次之间的合并由本模块承担。
 *
 * 设计约束：
 *   1. 纯函数 —— 零 I/O、零依赖、不修改入参、可离线单测。
 *   2. 确定性 —— 同一输入（含语义相同但对象键序不同的输入）必须产出完全一致的结果；
 *      所有排序链都以 model id 字典序收尾，绝不依赖 Map/对象的迭代顺序。
 *   3. 健壮性 —— null / undefined / 缺字段 / results 为空数组一律按无效回合处理，绝不抛异常。
 *
 * 输入侧沿用 lmfpd-sdk 的 `Analysis` 形状（snake_case：prediction_name / display_name /
 * family_name），输出侧统一转成 camelCase 供 HTTP 层与前端消费。
 */

/** 有效回合的判定：必须拿到排名（decision === 'scored'）且存在第一名。 */
const VALID_DECISION = 'scored'

/** 稳定阈值：一致率 >= 2/3 判 stable（与契约 §4.3 一致）。 */
const STABLE_THRESHOLD = 2 / 3

/** 有限数值判定，用来把 null / undefined / NaN / Infinity 一并挡在统计之外。 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 只接受非空字符串；其余（含空串）统一归为 null，避免空串伪装成有效值。 */
function toNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 中位数口径（本模块唯一标准，测试据此断言）：
 *   - 先滤掉非有限数值，再升序排序；
 *   - 奇数个 → 取正中那一个；
 *   - 偶数个 → 取中间两个的算术平均；
 *   - 过滤后为空 → null。
 */
function medianOf(values) {
  const numbers = []
  for (const value of values) {
    if (isFiniteNumber(value)) numbers.push(value)
  }
  if (numbers.length === 0) return null
  numbers.sort((a, b) => a - b)
  const mid = numbers.length >> 1
  return numbers.length % 2 === 1 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2
}

/** 升序比较，null 视为 +∞（永远排在最后）。 */
function compareNullableAsc(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/** 降序比较，null 视为 -∞（永远排在最后）。 */
function compareNullableDesc(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/** model id 字典序 —— 所有排序链的最终决胜键，保证确定性。 */
function compareModelId(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 回合级错误：analysis.error 优先，其次 round.error；两者都缺则 null。 */
function pickError(analysis, round) {
  if (analysis !== null && analysis.error !== undefined && analysis.error !== null) return analysis.error
  if (round !== null && round.error !== undefined && round.error !== null) return round.error
  return null
}

/**
 * 把一条原始回合归一化成内部结构。任何脏输入都退化为「无效回合」，不抛异常。
 * @param entry 原始回合，形如 { analysis, error }，允许为 null/undefined/非对象
 * @param index 回合下标（从 0 起，原样透出到 perRound）
 */
function normalizeRound(entry, index) {
  const round = entry !== null && typeof entry === 'object' ? entry : null
  const analysis =
    round !== null && round.analysis !== null && typeof round.analysis === 'object' ? round.analysis : null

  const decision = analysis !== null ? toNonEmptyString(analysis.decision) : null
  const prediction = analysis !== null ? toNonEmptyString(analysis.prediction) : null
  const predictionName = analysis !== null ? toNonEmptyString(analysis.prediction_name) : null
  const probability = analysis !== null && isFiniteNumber(analysis.probability) ? analysis.probability : null
  // §61：SDK 在这里明确说明置信度是否可用。输入侧是 snake_case，**不做大小写转换**。
  const probabilityStatus = analysis !== null ? toNonEmptyString(analysis.probability_status) : null

  // results 行按**原始下标**编号（1-based）：滤掉脏行但不重新编号，
  // 这样「名次」始终对应候选在官方排名里的真实位置。
  const results = []
  const rawResults = analysis !== null && Array.isArray(analysis.results) ? analysis.results : []
  for (let i = 0; i < rawResults.length; i += 1) {
    const row = rawResults[i]
    if (row === null || typeof row !== 'object') continue
    const model = toNonEmptyString(row.model)
    if (model === null) continue
    results.push({
      rank: i + 1,
      model,
      displayName: toNonEmptyString(row.display_name),
      family: toNonEmptyString(row.family),
      familyName: toNonEmptyString(row.family_name),
      score: isFiniteNumber(row.score) ? row.score : null,
      probability: isFiniteNumber(row.probability) ? row.probability : null,
    })
  }

  return {
    index,
    decision,
    prediction,
    predictionName,
    probability,
    probabilityStatus,
    error: pickError(analysis, round),
    results,
    valid: decision === VALID_DECISION && prediction !== null,
  }
}

/**
 * 从已排序的 ranking 里选出胜者。
 *   决胜链：票数降序 → 平均 score 降序 → model id 字典序。
 * 一票都没有时返回 null（对应「全无效」）。
 */
function pickWinner(ranking) {
  if (ranking.length === 0) return null
  const topVotes = ranking[0].votes
  if (topVotes <= 0) return null
  const tied = ranking.filter((row) => row.votes === topVotes)
  tied.sort((a, b) => compareNullableDesc(a.score, b.score) || compareModelId(a.model, b.model))
  return tied[0]
}

/**
 * 推导 `probabilityStatus`（§61）—— 判定只看**有效回合**（`valid === true`，
 * 即回合级 `decision === 'scored'` 且 `prediction` 非空）。
 *
 *   1. 任一轮 `analysis.probability_status === 'reference_calibrated'` ⇒ `'reference_calibrated'`
 *   2. 否则，任一轮**带**该字段（无论何值）⇒ `'unavailable'`
 *   3. 再否则 ⇒ `null`（无有效回合 / 旧数据 / SDK 未给该字段）
 *
 * ── 语义划分（§61.2「四种缺失不能长得一样」）────────────────────────────────
 *
 *   | 情形                      | 返回值                   | 界面           | 归因于       |
 *   |---------------------------|--------------------------|----------------|--------------|
 *   | 有有效回合 + SDK 说不可用 | `'unavailable'`          | `—（未校准）`  | **校准**     |
 *   | 有有效回合 + SDK 说已校准 | `'reference_calibrated'` | 数字           | 正常         |
 *   | **无有效回合**            | **`null`**               | `—`            | **样本不足** |
 *   | 旧数据 / 无该键           | `null`                   | `—`            | 未知         |
 *
 * ⚠️ **为什么「无有效回合」必须是 `null` 而不是 `'unavailable'`**：
 * 真机 `count=1` 时 SDK 会返回回合级 `decision='partial'` **且**
 * `probability_status='unavailable'`（SDK 那句话的意思是「校准参数与当前检测器不匹配」）。
 * 但那时 `validRounds === 0`，**真正的缺失原因是「样本不足」**，而结论列已经写了「样本不足」。
 * 若这里返回 `'unavailable'`，界面就会变成：
 *     结论列  ：样本不足       ← 正确
 *     置信度列：—（未校准）     ← **错误**：挂了第二个、而且并不成立的原因
 * ⇒ 那是**把两个不同原因混成一个**，正好违反 §61.2「四种缺失不能长得一样」。
 * ⇒ **`null` 与 `'unavailable'` 绝不可合并**（两者在 UI 上是不同文案）。
 *
 * 🚫 **不要把这里「修」成 `'unavailable'`** —— 那是把「样本不足」误报成「未校准」。
 *    动手改这一行之前，请先读用例 24 / 26 / 27：它们就是为了钉死这条边界而存在的。
 *
 * 为什么要透出它：SDK 在 `probability_status` 里明确说明了「置信度是否可用」及其原因
 * （`evidence.reason`）。旧实现一个字段都不往外传 ⇒ 界面上只剩光秃秃的 `—`，
 * 看起来像我们算错了，其实是「当前检测器没有匹配的校准参数」。
 *
 * ⚠️ 不改动 `probability` 的既有语义（仍走 `probabilitySum / probabilityCount` 平均）。
 */
function deriveProbabilityStatus(validRoundsList) {
  let sawAnyStatus = false
  for (const round of validRoundsList) {
    if (round.probabilityStatus === 'reference_calibrated') return 'reference_calibrated'
    if (round.probabilityStatus !== null) sawAnyStatus = true
  }
  return sawAnyStatus ? 'unavailable' : null
}

/**
 * 聚合多轮检测结果。
 *
 * @param rounds 形如 [{ analysis, error }] 的回合数组；允许 null/undefined/脏元素
 * @returns {{
 *   decision: 'scored'|'partial'|'unscorable',
 *   prediction: string|null, predictionName: string|null,
 *   family: string|null, familyName: string|null,
 *   validRounds: number, totalRounds: number,
 *   agreement: number|null, confidence: number|null,
 *   probabilityStatus: 'reference_calibrated'|'unavailable'|null,
 *   stability: 'stable'|'unstable'|'inconclusive',
 *   ranking: Array<{model,displayName,family,familyName,score,probability,votes,meanRank}>,
 *   perRound: Array<{index,decision,prediction,predictionName,probability,error}>
 * }}
 *
 * 口径说明：
 *   - 有效回合 = analysis 存在 && decision === 'scored' && prediction 非空。
 *   - votes / meanRank / score / probability 的统计**只累计有效回合**，与 agreement 的分母一致。
 *   - meanRank 只统计该候选真正出现过的回合（未出现不计入分母）。
 *   - 无胜者时 prediction / predictionName / family / familyName 一律为 null（不用空串伪装）。
 *   - `probabilityStatus`（§61）**只看有效回合**：任一轮 calibrated ⇒ `'reference_calibrated'`；
 *     任一轮带该字段 ⇒ `'unavailable'`；都没带 ⇒ `null`。
 *     它解释了 `confidence` 为何可能是 `null` —— `null` 不是「我们算不出来」，
 *     而是「SDK 说当前检测器没有匹配的校准参数」。**不要为了看起来有数据而造数**。
 *   - ⚠️ `probabilityStatus === null` 有**两种**互不相同的含义（§61.2）：
 *       ① **无有效回合**（`validRounds === 0`）⇒ 归因「**样本不足**」（结论列已说明），
 *          置信度列显示 `—`。**此时即使 SDK 给了 `'unavailable'` 也不采纳** ——
 *          采纳它会把「样本不足」误报成「未校准」。
 *       ② **旧数据 / SDK 未给该字段** ⇒ 归因「未知」，同样显示 `—`。
 *     只有 `validRounds > 0` 时，SDK 的 `'unavailable'` 才会被采纳为「`—（未校准）`」。
 *     ⇒ **`null` 与 `'unavailable'` 在 UI 上是不同文案，绝不可合并。**
 */
export function aggregateRounds(rounds) {
  const list = Array.isArray(rounds) ? rounds : []
  const totalRounds = list.length

  const normalized = list.map((entry, index) => normalizeRound(entry, index))
  const validRoundsList = normalized.filter((round) => round.valid)
  const validRounds = validRoundsList.length

  // ── 候选统计 ────────────────────────────────────────────────────────────
  const stats = new Map()
  const ensureStats = (model) => {
    let entry = stats.get(model)
    if (entry === undefined) {
      entry = {
        model,
        displayName: null,
        family: null,
        familyName: null,
        votes: 0,
        rankSum: 0,
        rankCount: 0,
        scoreSum: 0,
        scoreCount: 0,
        probabilitySum: 0,
        probabilityCount: 0,
      }
      stats.set(model, entry)
    }
    return entry
  }

  for (const round of validRoundsList) {
    for (const row of round.results) {
      const entry = ensureStats(row.model)
      // 行元数据取「第一次出现的非空值」，避免不同回合的缺失值把已有信息覆盖掉。
      if (entry.displayName === null) entry.displayName = row.displayName
      if (entry.family === null) entry.family = row.family
      if (entry.familyName === null) entry.familyName = row.familyName
      entry.rankSum += row.rank
      entry.rankCount += 1
      if (row.score !== null) {
        entry.scoreSum += row.score
        entry.scoreCount += 1
      }
      if (row.probability !== null) {
        entry.probabilitySum += row.probability
        entry.probabilityCount += 1
      }
    }
    // prediction 理论上等于 results[0].model，但不做此假设：票照记、行照建。
    ensureStats(round.prediction).votes += 1
  }

  const ranking = []
  for (const entry of stats.values()) {
    ranking.push({
      model: entry.model,
      displayName: entry.displayName !== null ? entry.displayName : entry.model,
      family: entry.family,
      familyName: entry.familyName,
      score: entry.scoreCount > 0 ? entry.scoreSum / entry.scoreCount : null,
      probability: entry.probabilityCount > 0 ? entry.probabilitySum / entry.probabilityCount : null,
      votes: entry.votes,
      meanRank: entry.rankCount > 0 ? entry.rankSum / entry.rankCount : null,
    })
  }

  // 排序链：票数降序 → 平均名次升序 → model id 字典序（确定性兜底）。
  ranking.sort(
    (a, b) => b.votes - a.votes || compareNullableAsc(a.meanRank, b.meanRank) || compareModelId(a.model, b.model),
  )

  const winner = pickWinner(ranking)
  const winnerVotes = winner !== null ? winner.votes : 0
  const agreement = validRounds > 0 ? winnerVotes / validRounds : null
  const confidence = medianOf(validRoundsList.map((round) => round.probability))
  const probabilityStatus = deriveProbabilityStatus(validRoundsList)

  const stability =
    validRounds < 2 ? 'inconclusive' : agreement >= STABLE_THRESHOLD ? 'stable' : 'unstable'

  const decision = validRounds === 0 ? 'unscorable' : validRounds < totalRounds ? 'partial' : 'scored'

  return {
    decision,
    prediction: winner !== null ? winner.model : null,
    predictionName: winner !== null ? winner.displayName : null,
    family: winner !== null ? winner.family : null,
    familyName: winner !== null ? winner.familyName : null,
    validRounds,
    totalRounds,
    agreement,
    confidence,
    probabilityStatus,
    stability,
    ranking,
    perRound: normalized.map((round) => ({
      index: round.index,
      decision: round.decision,
      prediction: round.prediction,
      predictionName: round.predictionName,
      probability: round.probability,
      error: round.error,
    })),
  }
}
