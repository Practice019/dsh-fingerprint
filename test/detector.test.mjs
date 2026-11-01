/**
 * test/detector.test.mjs —— `lib/detector.js` 的验收测试（唯一所有者：W2）
 * =============================================================================
 * 运行：  node --test test/detector.test.mjs      （在插件目录下）
 *
 * 关于 ESM：插件根目录此刻**还没有** `package.json`（归 W1 所有），
 * 但 Node 22.7+ 的模块语法探测默认开启，所以 `lib/detector.js` 里的 `export`
 * 会被正确识别为 ESM。W1 的 `"type": "module"` 落地后行为不变。
 *
 * 关于联网：第 1 条测试允许联网下载约 3.6 MB 参考数据到
 * `%LOCALAPPDATA%\lmfpd\data.bin`。若网络不通，该断言会带着可读原因失败，
 * 而不是抛一个栈出来。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 默认模块实例：在改动任何环境变量之前导入，所以 CACHE_PATH 就是真实默认路径。
import {
  CACHE_PATH as DEFAULT_CACHE_PATH,
  getDetector,
  detectorStatus,
  getBankModels,
  warmup,
  generateChallenges,
  parseNumbers,
  analyze,
} from '../lib/detector.js'

const MODULE_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'detector.js')).href

/** 每个用例拿一个全新的模块实例（绕过单例，便于测失败路径与并发去重）。 */
let importCounter = 0
function freshModule() {
  importCounter += 1
  return import(MODULE_URL + '?case=' + String(importCounter) + '-' + String(Date.now()))
}

/** 轮询等待某个条件成立（用于等导入期预热完成）。 */
async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 构造一段确定性的 1–355 整数文本。 */
function numbersText(count, start = 1) {
  const out = []
  for (let index = 0; index < count; index += 1) out.push(((start + index - 1) % 355) + 1)
  return out.join(' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 首次加载能成功
// ─────────────────────────────────────────────────────────────────────────────
test('1. getDetector() 首次加载成功（允许联网下载参考数据）', async () => {
  assert.equal(typeof DEFAULT_CACHE_PATH, 'string')
  assert.ok(DEFAULT_CACHE_PATH.length > 0, 'CACHE_PATH 必须是非空字符串')

  const startedAt = Date.now()
  const snapshot = await getDetector()
  const elapsed = Date.now() - startedAt

  console.log(`[1] 首次加载耗时 ${elapsed}ms，缓存路径 ${DEFAULT_CACHE_PATH}`)

  // 失败时给出可读原因，而不是让栈冒出来
  assert.ok(
    snapshot.detector !== null,
    `detector 未能加载。可读原因：${snapshot.error ?? '(无)'}`,
  )
  assert.ok(snapshot.detector.analyze, 'detector 必须暴露 analyze 方法')
  assert.equal(snapshot.error, null)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 单例复用（不允许二次加载）
// ─────────────────────────────────────────────────────────────────────────────
test('2. 第二次调用复用单例，且并发调用只触发一次加载', async () => {
  // 2a) 同一实例内二次调用必须是同一个对象（SDK 每次 loadDetector() 都返回新实例，
  //     所以对象恒等就等价于「没有重新加载」）
  const first = await getDetector()
  const second = await getDetector()
  assert.ok(first.detector !== null)
  assert.equal(second.detector, first.detector, '第二次调用返回了不同的 detector 实例（发生了重载）')

  // 2b) 全新实例上并发发起 3 次默认加载：必须共用同一个 in-flight promise
  const fresh = await freshModule()
  const [a, b, c] = await Promise.all([fresh.getDetector(), fresh.getDetector(), fresh.getDetector()])
  assert.ok(a.detector !== null, `并发加载失败：${a.error ?? '(无)'}`)
  assert.equal(b.detector, a.detector, '并发调用没有去重（拿到不同实例）')
  assert.equal(c.detector, a.detector, '并发调用没有去重（拿到不同实例）')

  // 2c) warmup() 也必须命中单例
  const warmed = await warmup()
  assert.equal(warmed.builtAt, second.builtAt, 'warmup 返回的 builtAt 与单例不一致')
  assert.equal(warmed.error, null)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. generateChallenges
// ─────────────────────────────────────────────────────────────────────────────
test('3. generateChallenges(3) 返回 3 道合法挑战', () => {
  const challenges = generateChallenges(3)
  assert.equal(challenges.length, 3)

  const lengths = new Set()
  for (const challenge of challenges) {
    assert.equal(typeof challenge.id, 'string')
    assert.ok(challenge.id.length > 0, 'challenge.id 不能为空')
    assert.equal(typeof challenge.prompt, 'string')
    assert.ok(challenge.prompt.length > 0, 'challenge.prompt 不能为空')
    assert.ok(
      Number.isInteger(challenge.expected_count) && challenge.expected_count > 0,
      `expected_count 必须是正整数，实际 ${String(challenge.expected_count)}`,
    )
    lengths.add(challenge.expected_count)
  }
  // 官方规则：同一轮的 expected_count 各不相同
  assert.equal(lengths.size, 3, '同一轮挑战的 expected_count 出现了重复')

  // 越界参数必须报错（SDK 自身规则：count 1–3）
  assert.throws(() => generateChallenges(0))
  assert.throws(() => generateChallenges(4))
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. parseNumbers
// ─────────────────────────────────────────────────────────────────────────────
test('4. parseNumbers 取最长整数段（标点不断段、字母断段、越界数跳过）', () => {
  // 字母 "words" 断段；"——" 与空格、逗号都不断段；0 / 500 / 444 超出 1–355 被跳过
  const text = '0 500 12 34 56 —— 78 90 111 words 222 333 444 four'
  assert.deepEqual(parseNumbers(text), [12, 34, 56, 78, 90, 111])

  // 只有标点与空白：整段保留
  assert.deepEqual(parseNumbers('7, 8. 9; 10'), [7, 8, 9, 10])

  // 字母断段后取较长的一段
  assert.deepEqual(parseNumbers('1 2 x 3'), [1, 2])

  // 全是越界数字：返回空
  assert.deepEqual(parseNumbers('0 400 999'), [])

  // 边界值 1 与 355 必须被接受
  assert.deepEqual(parseNumbers('1 355 356'), [1, 355])
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. detectorStatus
// ─────────────────────────────────────────────────────────────────────────────
test('5. detectorStatus() 在加载后 ready=true 且 builtAt 非空', async () => {
  await getDetector()
  const status = detectorStatus()

  assert.equal(status.ready, true)
  assert.equal(typeof status.builtAt, 'string')
  assert.ok(status.builtAt.length > 0, 'builtAt 不能为空')
  assert.equal(status.cachePath, DEFAULT_CACHE_PATH)
  assert.equal(status.error, null)
  console.log(
    `[5] builtAt=${status.builtAt} bankModelCount=${String(status.bankModelCount)} cachePath=${status.cachePath}`,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. getBankModels（§4.1 导出，验证真的能拿到参考库模型表）
// ─────────────────────────────────────────────────────────────────────────────
test('6. getBankModels() 返回参考库模型表（与 bankModelCount 自洽）', async () => {
  const models = await getBankModels()
  const status = detectorStatus()

  if (status.bankModelCount === null) {
    console.log('[6] 缓存包头读不到模型表 → bankModelCount 为 null，模型表退化为空（符合契约：不编造）')
    assert.deepEqual(models, [])
    return
  }

  assert.equal(models.length, status.bankModelCount, 'getBankModels() 长度与 bankModelCount 不一致')
  assert.ok(models.length > 0, 'bankModelCount 非 null 时模型表不应为空')

  for (const model of models) {
    assert.equal(typeof model.id, 'string')
    assert.ok(model.id.length > 0)
    assert.equal(typeof model.displayName, 'string')
    assert.ok(model.displayName.length > 0)
    assert.equal(typeof model.family, 'string')
    assert.equal(typeof model.familyName, 'string')
  }
  console.log(`[6] 参考库模型数 = ${String(models.length)}，首条 = ${models[0].id}`)
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 失败路径：坏缓存 + 坏来源 → error 可读、不抛、且可重试
// ─────────────────────────────────────────────────────────────────────────────
test('7. 加载失败时 error 有内容、不抛异常，且下一次调用能重试成功', async () => {
  const previous = process.env.DSH_FINGERPRINT_LMFPD_CACHE
  // 不可写路径：父目录不存在，且用一个不存在的本地目录当 source
  const badCache = path.join(os.tmpdir(), `dsh-fp-missing-${Date.now()}`, 'data.bin')
  const badSource = path.join(os.tmpdir(), `dsh-fp-no-such-bank-${Date.now()}`)

  process.env.DSH_FINGERPRINT_LMFPD_CACHE = badCache
  try {
    const fresh = await freshModule()
    assert.equal(
      fresh.CACHE_PATH,
      path.resolve(badCache),
      '环境变量 DSH_FINGERPRINT_LMFPD_CACHE 没有生效',
    )

    let snapshot
    await assert.doesNotReject(async () => {
      snapshot = await fresh.getDetector({ source: badSource })
    }, 'getDetector 失败时必须不抛异常')

    assert.equal(snapshot.detector, null)
    assert.equal(snapshot.bankModelCount, null)

    const status = fresh.detectorStatus()
    assert.equal(status.ready, false)
    assert.equal(typeof status.error, 'string')
    assert.ok(status.error.length > 0, 'detectorStatus().error 必须有可读原因')
    assert.ok(
      status.error.includes('lmfpd'),
      `error 应带上可读前缀，实际：${status.error}`,
    )
    console.log(`[7] 失败原因（可读）= ${status.error}`)

    // 失败后必须能重试：换回可用的默认缓存路径，同一实例再次加载应成功。
    // （DEFAULT_CACHE_PATH 已被用例 1 填充，所以这里是读缓存，不发网络请求。）
    if (detectorStatus().ready) {
      process.env.DSH_FINGERPRINT_LMFPD_CACHE = DEFAULT_CACHE_PATH
      const retried = await fresh.getDetector()
      assert.ok(
        retried.detector !== null,
        `失败后重试没有恢复。可读原因：${retried.error ?? '(无)'}`,
      )
      assert.equal(fresh.detectorStatus().error, null)
      assert.equal(fresh.detectorStatus().ready, true)
      console.log('[7] 失败后同一实例重试成功 → 未把 rejected promise 永久缓存')
    } else {
      console.log('[7] 跳过重试断言：默认 detector 未就绪（用例 1 未成功加载）')
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FINGERPRINT_LMFPD_CACHE
    else process.env.DSH_FINGERPRINT_LMFPD_CACHE = previous
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. analyze 包装（§4.1 导出；SDK 无顶层 analyze，本模块做同步包装）
// ─────────────────────────────────────────────────────────────────────────────
test('8. analyze() 在已加载的实例上可用，未加载时抛可读错误', async () => {
  // 8a) 关闭导入期预热 → 全新实例必然是「未加载」态，此时必须抛可读错误而非 TypeError
  const previous = process.env.DSH_FINGERPRINT_NO_PREWARM
  process.env.DSH_FINGERPRINT_NO_PREWARM = '1'
  try {
    const cold = await freshModule()
    assert.equal(cold.detectorStatus().ready, false, '关闭预热后不应自动加载')
    assert.throws(
      () => cold.analyze([{ text: '1 2 3', expected_count: 3 }]),
      (error) =>
        error instanceof Error &&
        error.message.includes('getDetector') &&
        !(error instanceof TypeError),
      '未加载时 analyze 应抛出提示先加载的可读错误',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_FINGERPRINT_NO_PREWARM
    else process.env.DSH_FINGERPRINT_NO_PREWARM = previous
  }

  // 8b) 已加载实例：返回 SDK 的 Analysis
  await getDetector()
  const outputs = [
    { text: numbersText(300, 1), expected_count: 300 },
    { text: numbersText(311, 5), expected_count: 311 },
    { text: numbersText(296, 9), expected_count: 296 },
  ]
  const analysis = analyze(outputs)
  assert.equal(typeof analysis.decision, 'string')
  assert.ok(
    ['scored', 'partial', 'unscorable', 'not_model'].includes(analysis.decision),
    `analysis.decision 非法：${analysis.decision}`,
  )
  assert.equal(typeof analysis.prediction, 'string')
  assert.ok(Array.isArray(analysis.results))
  assert.ok(Array.isArray(analysis.diagnostics))
  console.log(`[8] analyze decision=${analysis.decision} prediction="${analysis.prediction}"`)
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. 复现 W3 的调用形态：只 await import，不调用 getDetector()，然后同步 analyze()
//    （这是导入期预热存在的唯一理由，必须被测试锁住）
// ─────────────────────────────────────────────────────────────────────────────
test('9. 导入期预热：只 import 不调 getDetector 也能同步 analyze（W3 probe.js 的真实形态）', async () => {
  const fresh = await freshModule()

  // W3 的 ensureDetector() 只做这件事：await import + 绑定三个导出
  assert.equal(typeof fresh.parseNumbers, 'function')
  assert.equal(typeof fresh.generateChallenges, 'function')
  assert.equal(typeof fresh.analyze, 'function')

  // 模拟「若干秒的模型请求」；预热应当在窗口内完成
  const warmed = await waitFor(() => fresh.detectorStatus().ready === true, 15000)
  assert.ok(
    warmed,
    `导入期预热没有完成。原因：${fresh.detectorStatus().error ?? '(无)'}`,
  )

  // 关键断言：**没有调用过 getDetector()**，但同步 analyze() 必须不抛
  let analysis
  assert.doesNotThrow(() => {
    analysis = fresh.analyze([
      { text: numbersText(300, 1), expected_count: 300 },
      { text: numbersText(311, 5), expected_count: 311 },
      { text: numbersText(296, 9), expected_count: 296 },
    ])
  }, '导入期预热没有让同步 analyze() 可用 —— W3 的 runRound 会整轮返回「评分失败」')
  assert.equal(typeof analysis.decision, 'string')
  console.log(`[9] 仅 import 后同步 analyze 成功：decision=${analysis.decision}`)
})
