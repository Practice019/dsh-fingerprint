/**
 * test/aggregate.test.mjs —— lib/aggregate.js 的离线单测（负责人 W5）
 *
 * 运行：node --test test/aggregate.test.mjs
 * 全部数据为手工构造的合成样本，不联网、不读磁盘、不依赖 lmfpd-sdk 运行时。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateRounds } from '../lib/aggregate.js'

// ── 构造工具 ────────────────────────────────────────────────────────────────

/** 构造一行候选，字段名与 lmfpd-sdk 的 AnalysisResult 一致（snake_case）。 */
function candidate(model, { score = 1, probability = 0.5, family = 'fam', familyName = 'Fam' } = {}) {
  return {
    model,
    display_name: model,
    family,
    family_name: familyName,
    score,
    probability,
  }
}

/**
 * 构造一个完整的 Analysis 对象（字段集与 lmfpd-sdk 的 Analysis 接口对齐），
 * 便于验证实现不会误用 field 名。
 */
function makeAnalysis({ prediction, results = [], probability = 0.9, decision = 'scored' }) {
  return {
    decision,
    prediction,
    prediction_name: prediction,
    family_prediction: 'fam',
    family_prediction_name: 'Fam',
    results,
    ranking_score: results.length > 0 ? results[0].score : null,
    probability,
    probability_status: 'reference_calibrated',
    probability_scope: null,
    calibration: null,
    used_outputs: 3,
    diagnostics: [],
    sequence: null,
    method: 'test-method',
    model_version: { base_sha256: 'deadbeef' },
    evidence: { insufficient: false, label: 'label', reason: 'reason', threshold: null, method: 'test-method' },
  }
}

/** 造一个「有效回合」：top1 = prediction，榜单为 results。 */
function scoredRound(prediction, results, { probability = 0.9 } = {}) {
  return { analysis: makeAnalysis({ prediction, results, probability }), error: null }
}

/** 两个候选的常规榜单：top1 分数高，第二名分数低。 */
function pairBoard(top, other, { topScore = 10, otherScore = 5 } = {}) {
  return [candidate(top, { score: topScore }), candidate(other, { score: otherScore })]
}

const EPS = 1e-12

// ── 1. 3 回合全部同 top1 ────────────────────────────────────────────────────

test('1) 3 回合 top1 全一致 → scored / agreement 1 / stable', () => {
  const rounds = [0, 1, 2].map(() => scoredRound('A', pairBoard('A', 'B'), { probability: 0.9 }))
  const agg = aggregateRounds(rounds)

  assert.equal(agg.decision, 'scored')
  assert.equal(agg.totalRounds, 3)
  assert.equal(agg.validRounds, 3)
  assert.equal(agg.agreement, 1)
  assert.equal(agg.stability, 'stable')
  assert.equal(agg.prediction, 'A')
  assert.equal(agg.predictionName, 'A')
  assert.equal(agg.confidence, 0.9)

  assert.equal(agg.ranking.length, 2)
  assert.equal(agg.ranking[0].model, 'A')
  assert.equal(agg.ranking[0].votes, 3)
  assert.equal(agg.ranking[1].model, 'B')
  assert.equal(agg.ranking[1].votes, 0)

  // perRound：index 从 0 起，逐回合透出
  assert.deepEqual(
    agg.perRound.map((r) => r.index),
    [0, 1, 2],
  )
  assert.deepEqual(
    agg.perRound.map((r) => r.prediction),
    ['A', 'A', 'A'],
  )
})

// ── 2. 3 回合 2:1（stable 边界）─────────────────────────────────────────────

test('2) 3 回合 2:1 → agreement≈0.667 且 stability 恰好为 stable（边界）', () => {
  const rounds = [
    scoredRound('A', pairBoard('A', 'B')),
    scoredRound('A', pairBoard('A', 'B')),
    scoredRound('B', pairBoard('B', 'A')),
  ]
  const agg = aggregateRounds(rounds)

  assert.equal(agg.decision, 'scored')
  assert.equal(agg.validRounds, 3)
  assert.ok(Math.abs(agg.agreement - 2 / 3) < EPS, `agreement 应为 2/3，实际 ${agg.agreement}`)
  assert.equal(agg.stability, 'stable', '2/3 是稳定阈值下界，必须判 stable')
  assert.equal(agg.prediction, 'A')
  assert.equal(agg.ranking[0].votes, 2)
  assert.equal(agg.ranking[1].votes, 1)
})

// ── 3. 5 回合 3:2 → unstable ───────────────────────────────────────────────

test('3) 5 回合 3:2 → agreement 0.6 且 unstable', () => {
  const rounds = [
    scoredRound('A', pairBoard('A', 'B')),
    scoredRound('A', pairBoard('A', 'B')),
    scoredRound('A', pairBoard('A', 'B')),
    scoredRound('B', pairBoard('B', 'A')),
    scoredRound('B', pairBoard('B', 'A')),
  ]
  const agg = aggregateRounds(rounds)

  assert.equal(agg.validRounds, 5)
  assert.equal(agg.totalRounds, 5)
  assert.equal(agg.agreement, 0.6)
  assert.equal(agg.stability, 'unstable')
  assert.equal(agg.prediction, 'A')
})

// ── 4. 1 有效 + 2 unscorable → partial ─────────────────────────────────────

test('4) 1 个有效 + 2 个无效 → decision partial / stability inconclusive', () => {
  const rounds = [
    scoredRound('A', pairBoard('A', 'B'), { probability: 0.8 }),
    {
      analysis: makeAnalysis({ prediction: '', results: [], probability: null, decision: 'unscorable' }),
      error: 'No valid samples. This round cannot be scored.',
    },
    { analysis: null, error: 'Cancelled. This round was not scored.' },
  ]
  const agg = aggregateRounds(rounds)

  assert.equal(agg.decision, 'partial')
  assert.equal(agg.validRounds, 1)
  assert.equal(agg.totalRounds, 3)
  assert.equal(agg.stability, 'inconclusive', '有效回合不足 2，必须判 inconclusive 而不是 stable')
  assert.equal(agg.agreement, 1, '唯一有效回合的 top1 即胜者，一致率为 1')
  assert.equal(agg.confidence, 0.8)

  // error 必须透出到 perRound
  assert.equal(agg.perRound[1].error, 'No valid samples. This round cannot be scored.')
  assert.equal(agg.perRound[2].error, 'Cancelled. This round was not scored.')
  assert.equal(agg.perRound[0].error, null)
})

// ── 5. 全无效 → unscorable ────────────────────────────────────────────────

test('5) 全无效 → unscorable / prediction 为 null / confidence 与 agreement 均为 null', () => {
  const rounds = [
    { analysis: null, error: 'round-0-boom' },
    { analysis: makeAnalysis({ prediction: '', results: [], probability: null, decision: 'not_model' }) },
    { analysis: makeAnalysis({ prediction: '', results: [], probability: null, decision: 'unscorable' }) },
  ]
  const agg = aggregateRounds(rounds)

  assert.equal(agg.decision, 'unscorable')
  assert.equal(agg.validRounds, 0)
  assert.equal(agg.totalRounds, 3)
  assert.equal(agg.prediction, null)
  assert.equal(agg.predictionName, null)
  assert.equal(agg.family, null)
  assert.equal(agg.familyName, null)
  assert.equal(agg.confidence, null)
  assert.equal(agg.agreement, null)
  assert.equal(agg.stability, 'inconclusive')
  assert.deepEqual(agg.ranking, [], '没有有效回合就不该有候选')
  assert.equal(agg.perRound[0].error, 'round-0-boom')

  // 空数组 / 非数组入参同样是合法输入
  for (const input of [[], null, undefined, 'not-an-array', 0]) {
    const empty = aggregateRounds(input)
    assert.equal(empty.decision, 'unscorable')
    assert.equal(empty.totalRounds, 0)
    assert.equal(empty.validRounds, 0)
    assert.equal(empty.agreement, null)
    assert.equal(empty.prediction, null)
  }
})

test('5b) analysis.error 优先于 round.error 透出', () => {
  const rounds = [
    { analysis: { decision: 'unscorable', prediction: '', results: [], error: 'from-analysis' }, error: 'from-round' },
  ]
  assert.equal(aggregateRounds(rounds).perRound[0].error, 'from-analysis')
})

// ── 6. 平票决胜的确定性 ────────────────────────────────────────────────────

test('6) 平票：平均 score 决定胜者，且 100 次运行结果完全一致', () => {
  // 两个回合各支持一个 top1 → 票数 1:1 平票。
  // 让 A 的平均 score (8) 高于 B 的平均 score (3)，胜者应为 A。
  const rounds = [
    scoredRound('A', [
      candidate('A', { score: 10, probability: 0.7 }),
      candidate('B', { score: 1, probability: 0.3 }),
    ]),
    scoredRound('B', [
      candidate('B', { score: 5, probability: 0.4 }),
      candidate('A', { score: 6, probability: 0.6 }),
    ]),
  ]

  const agg = aggregateRounds(rounds)
  assert.equal(agg.ranking[0].votes, 1)
  assert.equal(agg.ranking[1].votes, 1)
  assert.equal(agg.ranking.find((r) => r.model === 'A').score, 8)
  assert.equal(agg.ranking.find((r) => r.model === 'B').score, 3)
  assert.equal(agg.prediction, 'A', '平票时平均 score 高者胜')
  assert.equal(agg.agreement, 0.5)
  assert.equal(agg.stability, 'unstable')

  const baseline = JSON.stringify(aggregateRounds(rounds))
  for (let i = 0; i < 100; i += 1) {
    assert.equal(JSON.stringify(aggregateRounds(rounds)), baseline, `第 ${i} 次运行结果漂移`)
  }
})

test('6b) 平票且 score 也相同 → 按 model id 字典序稳定决胜（不依赖对象键序）', () => {
  const rowsInOneOrder = [
    candidate('B', { score: 5 }),
    candidate('A', { score: 5 }),
  ]
  // 语义完全相同，只是键的插入顺序与数组顺序反过来
  const rowsInOtherOrder = [
    { probability: 0.5, score: 5, family_name: 'Fam', family: 'fam', display_name: 'A', model: 'A' },
    { probability: 0.5, score: 5, family_name: 'Fam', family: 'fam', display_name: 'B', model: 'B' },
  ]

  const roundsA = [scoredRound('A', rowsInOneOrder), scoredRound('B', rowsInOneOrder.slice().reverse())]
  const roundsB = [scoredRound('A', rowsInOtherOrder), scoredRound('B', rowsInOtherOrder.slice().reverse())]

  const aggA = aggregateRounds(roundsA)
  const aggB = aggregateRounds(roundsB)

  assert.equal(aggA.prediction, 'A', "score 无法分胜负时按 model id 字典序，'A' < 'B'")
  assert.equal(aggA.ranking[0].model, 'A')
  assert.equal(aggA.ranking[1].model, 'B')
  assert.deepEqual(aggA, aggB, '对象键序不得影响结果')
})

// ── 7. confidence 中位数口径 ──────────────────────────────────────────────

test('7) confidence 中位数：偶数取中间两项平均，奇数取正中，非数值被过滤', () => {
  const board = pairBoard('A', 'B')

  // 4 个有效回合 → 偶数：升序 [0.3,0.5,0.7,0.9] → (0.5+0.7)/2 = 0.6
  const even = [
    scoredRound('A', board, { probability: 0.9 }),
    scoredRound('A', board, { probability: 0.5 }),
    scoredRound('A', board, { probability: 0.7 }),
    scoredRound('A', board, { probability: 0.3 }),
  ]
  assert.equal(aggregateRounds(even).confidence, 0.6)

  // 3 个有效回合 → 奇数：升序 [0.5,0.7,0.9] → 0.7
  const odd = [
    scoredRound('A', board, { probability: 0.9 }),
    scoredRound('A', board, { probability: 0.5 }),
    scoredRound('A', board, { probability: 0.7 }),
  ]
  assert.equal(aggregateRounds(odd).confidence, 0.7)

  // 2 个有效回合 → (0.4+0.6)/2 = 0.5
  const two = [
    scoredRound('A', board, { probability: 0.4 }),
    scoredRound('A', board, { probability: 0.6 }),
  ]
  assert.equal(aggregateRounds(two).confidence, 0.5)

  // null / NaN 被过滤，只按剩余的 [0.2, 0.8] 算 → 0.5
  const withNulls = [
    scoredRound('A', board, { probability: 0.2 }),
    scoredRound('A', board, { probability: null }),
    scoredRound('A', board, { probability: Number.NaN }),
    scoredRound('A', board, { probability: 0.8 }),
  ]
  assert.equal(aggregateRounds(withNulls).confidence, 0.5)
})

// ── 8. 脏输入不得抛异常 ───────────────────────────────────────────────────

test('8) 脏输入 [null, undefined, {}, {analysis:{}}] 不抛异常，全部按无效回合处理', () => {
  const dirty = [null, undefined, {}, { analysis: {} }]

  assert.doesNotThrow(() => aggregateRounds(dirty))
  const agg = aggregateRounds(dirty)

  assert.equal(agg.decision, 'unscorable')
  assert.equal(agg.totalRounds, 4)
  assert.equal(agg.validRounds, 0)
  assert.equal(agg.prediction, null)
  assert.equal(agg.agreement, null)
  assert.equal(agg.confidence, null)
  assert.deepEqual(
    agg.perRound.map((r) => r.index),
    [0, 1, 2, 3],
  )
  assert.deepEqual(
    agg.perRound.map((r) => r.decision),
    [null, null, null, null],
  )
})

test('8b) 字段类型错乱也不抛异常', () => {
  const messy = [
    { analysis: { decision: 123, prediction: 456, results: 'nope', probability: 'x' } },
    { analysis: { decision: 'scored', prediction: 'A', results: [null, 0, 'x', {}, { model: '' }] } },
    { analysis: { decision: 'scored', prediction: 'A', results: [{ model: 'A', score: 'high', probability: {} }] } },
    'string-round',
    42,
    [],
  ]

  assert.doesNotThrow(() => aggregateRounds(messy))
  const agg = aggregateRounds(messy)

  // 只有第 2、3 条是有效回合（decision=scored 且有 A）
  assert.equal(agg.validRounds, 2)
  assert.equal(agg.totalRounds, 6)
  assert.equal(agg.decision, 'partial')
  assert.equal(agg.prediction, 'A')
  assert.equal(agg.ranking[0].score, null, '非数值 score 必须落成 null，不参与均值')
  assert.equal(agg.confidence, null)
})

// ── 9. votes / meanRank / score 的手算对照 ────────────────────────────────

test('9) votes 与 meanRank 数值正确（手算对照）', () => {
  // 三回合榜单（名次 = 该行在 results 里的原始位置）：
  //   r0: [X, W, Y, Z] → X1 W2 Y3 Z4   top1 = X
  //   r1: [Y, X, Z]    → Y1 X2 Z3      top1 = Y
  //   r2: [X, Z, Y]    → X1 Z2 Y3      top1 = X
  //
  // 预期：
  //   votes    X=2, Y=1, Z=0, W=0
  //   meanRank X=(1+2+1)/3=4/3, Y=(3+1+3)/3=7/3, Z=(4+3+2)/3=3, W=2/1=2
  //   score    X 全部给 9 → 9；Y 全部给 6 → 6；Z 全部给 3 → 3；W 只有一次给 1 → 1
  //   ranking 顺序（votes desc → meanRank asc → model）：X, Y, W, Z
  const rounds = [
    scoredRound('X', [
      candidate('X', { score: 9 }),
      candidate('W', { score: 1 }),
      candidate('Y', { score: 6 }),
      candidate('Z', { score: 3 }),
    ]),
    scoredRound('Y', [candidate('Y', { score: 6 }), candidate('X', { score: 9 }), candidate('Z', { score: 3 })]),
    scoredRound('X', [candidate('X', { score: 9 }), candidate('Z', { score: 3 }), candidate('Y', { score: 6 })]),
  ]

  const agg = aggregateRounds(rounds)
  const byModel = new Map(agg.ranking.map((row) => [row.model, row]))

  assert.equal(agg.validRounds, 3)
  assert.equal(agg.prediction, 'X')
  assert.ok(Math.abs(agg.agreement - 2 / 3) < EPS)

  // votes
  assert.equal(byModel.get('X').votes, 2)
  assert.equal(byModel.get('Y').votes, 1)
  assert.equal(byModel.get('Z').votes, 0)
  assert.equal(byModel.get('W').votes, 0)

  // meanRank
  assert.equal(byModel.get('X').meanRank, 4 / 3)
  assert.equal(byModel.get('Y').meanRank, 7 / 3)
  assert.equal(byModel.get('Z').meanRank, 3)
  assert.equal(byModel.get('W').meanRank, 2, 'W 只在 1 个回合出现，分母为 1')

  // score
  assert.equal(byModel.get('X').score, 9)
  assert.equal(byModel.get('Y').score, 6)
  assert.equal(byModel.get('Z').score, 3)
  assert.equal(byModel.get('W').score, 1)

  // ranking 顺序
  assert.deepEqual(
    agg.ranking.map((row) => row.model),
    ['X', 'Y', 'W', 'Z'],
    'votes 降序 → meanRank 升序 → model id',
  )
})

test('9b) meanRank 只在候选出现过的回合计入分母', () => {
  // A 出现 3 次（名次 1,2,1）→ 4/3；B 只在最后一个回合出现且名次 2 → 2（分母 1）
  const rounds = [
    scoredRound('A', [candidate('A', { score: 9 }), candidate('C', { score: 1 })]),
    scoredRound('A', [candidate('C', { score: 1 }), candidate('A', { score: 9 })]),
    scoredRound('A', [candidate('A', { score: 9 }), candidate('B', { score: 1 })]),
  ]
  const agg = aggregateRounds(rounds)
  const byModel = new Map(agg.ranking.map((row) => [row.model, row]))

  assert.equal(byModel.get('A').meanRank, 4 / 3)
  assert.equal(byModel.get('B').meanRank, 2)
  assert.equal(byModel.get('C').meanRank, 1.5)
  assert.equal(byModel.get('B').votes, 0)
})

test('9c) prediction 不在 results 里时仍记票并建行', () => {
  // 防御性场景：官方 SDK 理论上不会这样，但聚合层不得因此崩掉或丢票。
  const rounds = [
    { analysis: makeAnalysis({ prediction: 'GHOST', results: [candidate('A', { score: 1 })], probability: 0.5 }) },
  ]
  const agg = aggregateRounds(rounds)

  assert.equal(agg.validRounds, 1)
  assert.equal(agg.prediction, 'GHOST')
  assert.equal(agg.ranking[0].model, 'GHOST')
  assert.equal(agg.ranking[0].votes, 1)
  assert.equal(agg.ranking[0].meanRank, null, '未出现在任何 results 里 → meanRank 为 null')
  assert.equal(agg.ranking[0].displayName, 'GHOST', 'displayName 缺失时回退 model id')
})

// ── 10. 纯函数性：不修改入参 ──────────────────────────────────────────────

test('10) 不修改入参（纯函数）', () => {
  const rounds = [scoredRound('A', pairBoard('A', 'B')), scoredRound('B', pairBoard('B', 'A'))]
  const snapshot = JSON.stringify(rounds)

  aggregateRounds(rounds)
  assert.equal(JSON.stringify(rounds), snapshot, 'aggregateRounds 不得修改传入的 rounds')
})
