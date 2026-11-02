/**
 * test/history.test.mjs —— lib/history.js 的离线单测（负责人 W5）
 *
 * 运行：node --test test/history.test.mjs
 *
 * 隔离方式：每个用例通过 `DSH_FINGERPRINT_HISTORY` 把目标文件指到**独立临时目录**，
 * 结束时删目录并还原环境变量 —— **绝不触碰真实的 `%LOCALAPPDATA%`**。
 * `lib/history.js` 的所有函数内部每次调用都重新读该环境变量，因此不需要重新 import 模块。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  HISTORY_PATH,
  appendRecords,
  readHistory,
  clearHistory,
  historyStats,
  aggregateByModel,
} from '../lib/history.js'

// ── 夹具 ────────────────────────────────────────────────────────────────────

let counter = 0

/** 在一个独立临时目录里跑用例；结束必定清理并还原环境变量。 */
async function withTemp(fn) {
  counter += 1
  const dir = join(tmpdir(), `dsh-fp-history-${String(process.pid)}-${String(counter)}-${String(Date.now())}`)
  const file = join(dir, 'history.jsonl')
  const previous = process.env.DSH_FINGERPRINT_HISTORY
  process.env.DSH_FINGERPRINT_HISTORY = file
  try {
    return await fn({ file, dir })
  } finally {
    if (previous === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
    else process.env.DSH_FINGERPRINT_HISTORY = previous
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 一条形状完整的 §29.3 记录。 */
function record(overrides = {}) {
  return {
    v: 1,
    ts: '2026-11-02T06:00:00.000Z',
    runId: 'r-1',
    provider: 'provider_a',
    model: 'example/text-image',
    decision: 'scored',
    prediction: 'example-v1-flash-0101',
    predictionName: 'Example V1 Flash',
    family: 'deepseek',
    familyName: 'DeepSeek',
    probability: 0.9,
    agreement: 1,
    stability: 'stable',
    validRounds: 3,
    totalRounds: 3,
    options: { rounds: 3, count: 3, parallel: 3, strict: false },
    error: null,
    ...overrides,
  }
}

/** §29.3 冻结的 17 个键。 */
const RECORD_KEYS = [
  'v',
  'ts',
  'runId',
  'provider',
  'model',
  'decision',
  'prediction',
  'predictionName',
  'family',
  'familyName',
  'probability',
  'agreement',
  'stability',
  'validRounds',
  'totalRounds',
  'options',
  'error',
]

// ── 0. 导出常量 ────────────────────────────────────────────────────────────

test('0) HISTORY_PATH 是默认路径常量（加载时求值）', () => {
  assert.equal(typeof HISTORY_PATH, 'string')
  assert.ok(HISTORY_PATH.endsWith('history.jsonl'), `实际：${HISTORY_PATH}`)
  assert.ok(HISTORY_PATH.includes('dsh-fingerprint'), `实际：${HISTORY_PATH}`)
})

// ── 1. 空目录不是错误 ──────────────────────────────────────────────────────

test('1) 空目录：readHistory → []、stats.count=0，且 error 为 null', async () => {
  await withTemp(async ({ file }) => {
    assert.deepEqual(await readHistory(), [])
    assert.deepEqual(await aggregateByModel(), [])

    const stats = await historyStats()
    assert.equal(stats.count, 0)
    assert.equal(stats.oldest, null)
    assert.equal(stats.newest, null)
    assert.equal(stats.skippedLines, 0)
    assert.equal(stats.error, null, '文件不存在是首次运行的正常状态，不是错误')
    assert.equal(stats.path, file, 'stats.path 必须反映当前生效路径')
  })
})

// ── 2. 追加 + 最新在前 ────────────────────────────────────────────────────

test('2) 追加 3 条 → 读回 3 条且最新在前', async () => {
  await withTemp(async () => {
    const result = await appendRecords([
      record({ ts: '2026-11-02T06:00:00.000Z', runId: 'r-1' }),
      record({ ts: '2026-11-02T06:01:00.000Z', runId: 'r-2' }),
      record({ ts: '2026-11-02T06:02:00.000Z', runId: 'r-3' }),
    ])

    assert.equal(result.ok, true)
    assert.equal(result.appended, 3)
    assert.equal(result.total, 3)
    assert.equal(result.trimmed, 0)
    assert.equal(result.error, null)

    const back = await readHistory()
    assert.deepEqual(
      back.map((r) => r.runId),
      ['r-3', 'r-2', 'r-1'],
      '接口要求最新在前（文件存储是 旧 → 新）',
    )
    assert.equal((await historyStats()).count, 3)
  })
})

// ── 3. 过滤 ────────────────────────────────────────────────────────────────

test('3) limit / provider / model 过滤各自正确', async () => {
  await withTemp(async () => {
    await appendRecords([
      record({ ts: '2026-11-02T06:00:00.000Z', runId: 'a1', provider: 'provider_a', model: 'M-a' }),
      record({ ts: '2026-11-02T06:01:00.000Z', runId: 'a2', provider: 'provider_a', model: 'M-b' }),
      record({ ts: '2026-11-02T06:02:00.000Z', runId: 'a3', provider: 'provider_b', model: 'M-a' }),
      record({ ts: '2026-11-02T06:03:00.000Z', runId: 'a4', provider: 'provider_a', model: 'M-a' }),
    ])

    // limit：取最新的 N 条
    assert.deepEqual((await readHistory({ limit: 2 })).map((r) => r.runId), ['a4', 'a3'])
    assert.equal((await readHistory({ limit: 100 })).length, 4, 'limit 超过总数时返回全部')

    // provider
    assert.deepEqual((await readHistory({ provider: 'provider_a' })).map((r) => r.runId), ['a4', 'a2', 'a1'])
    assert.deepEqual((await readHistory({ provider: 'nope' })), [])

    // model
    assert.deepEqual((await readHistory({ model: 'M-a' })).map((r) => r.runId), ['a4', 'a3', 'a1'])

    // 组合
    assert.deepEqual(
      (await readHistory({ provider: 'provider_a', model: 'M-a', limit: 1 })).map((r) => r.runId),
      ['a4'],
    )
  })
})

// ── 4. 滚动上限：保留最新 ─────────────────────────────────────────────────

test('4) 滚动上限：追加 505 条 → 只留 500，且留的是最新的', async () => {
  await withTemp(async () => {
    const batch = []
    for (let i = 1; i <= 505; i += 1) {
      batch.push(record({ ts: new Date(Date.UTC(2026, 10, 2, 6, 0, 0, i)).toISOString(), runId: `r-${String(i)}` }))
    }

    const result = await appendRecords(batch)
    assert.equal(result.ok, true)
    assert.equal(result.trimmed, 5, '应裁掉最旧的 5 条')
    assert.equal(result.total, 500)

    const back = await readHistory()
    assert.equal(back.length, 500)
    assert.equal(back[0].runId, 'r-505', '第一条必须是最新的')
    assert.equal(back[499].runId, 'r-6', '被裁掉的是最旧的 r-1…r-5')
    assert.equal((await historyStats()).count, 500)

    // 反向断言：绝不保留最旧的
    const ids = new Set(back.map((r) => r.runId))
    for (const dropped of ['r-1', 'r-2', 'r-3', 'r-4', 'r-5']) {
      assert.equal(ids.has(dropped), false, `${dropped} 应已被裁掉`)
    }
  })
})

// ── 5. 体积上限（> 1 MB）触发裁剪 ─────────────────────────────────────────

test('5) 文件 > 1 MB 触发裁剪（用超长 model 撑体积；条数未达 500 也要裁）', async () => {
  await withTemp(async ({ file }) => {
    const longModel = 'm'.repeat(4000)
    const batch = []
    for (let i = 1; i <= 300; i += 1) {
      batch.push(
        record({
          ts: new Date(Date.UTC(2026, 10, 2, 6, 0, 0, i)).toISOString(),
          runId: `r-${String(i)}`,
          model: longModel,
          prediction: `p-${String(i)}`,
        }),
      )
    }

    const result = await appendRecords(batch)
    assert.equal(result.ok, true)
    assert.equal(result.appended, 300)

    // 前置断言：夹具本身确实把体积撑过了 1 MB（否则本用例是空转）
    const naiveBytes = batch.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r), 'utf8') + 1, 0)
    assert.ok(naiveBytes > 1024 * 1024, `夹具失效：300 条仅 ${naiveBytes} 字节，未超过 1 MB 上限`)

    const size = (await stat(file)).size
    assert.ok(size <= 1024 * 1024, `文件应被压到 1 MB 以内，实际 ${String(size)}`)

    const stats = await historyStats()
    assert.ok(stats.count < 300, `体积超限应裁掉一部分，实际保留 ${String(stats.count)}`)
    assert.ok(stats.count > 0, '至少保留 1 条，不得把文件清空')

    // 保留的是最新的
    assert.equal((await readHistory({ limit: 1 }))[0].prediction, 'p-300', '最新那条必须还在')
  })
})

// ── 6. 损坏行跳过 ─────────────────────────────────────────────────────────

test('6) 损坏行跳过：坏行不影响其余记录，skippedLines 计数正确（空行不算）', async () => {
  await withTemp(async ({ file }) => {
    await mkdir(dirname(file), { recursive: true })
    const good1 = JSON.stringify(record({ runId: 'r-good-1' }))
    const good2 = JSON.stringify(record({ runId: 'r-good-2' }))
    const body = [
      good1,
      '{ 这不是 json', // ① 解析失败
      '',
      '   ', // 空行 / 纯空白 —— 格式合法，不计入 skippedLines
      'null', // ② 解析成功但不是对象
      '[]', // ③ 对象形状错误（缺 provider/model）
      good2,
      '{"provider":"x"}', // ④ 缺 model
      '',
    ].join('\n')

    await writeFile(file, body + '\n', 'utf8')

    const back = await readHistory()
    assert.equal(back.length, 2, '两条有效记录必须完整读出（不许整文件报废）')
    assert.deepEqual(back.map((r) => r.runId).sort(), ['r-good-1', 'r-good-2'])

    const stats = await historyStats()
    assert.equal(stats.count, 2)
    assert.equal(stats.skippedLines, 4, '恰好 4 条损坏行；两条空行不计')
  })
})

// ── 7. 永不抛 ─────────────────────────────────────────────────────────────

test('7) 永不抛：父级是文件的路径 → 写失败只报 error，所有函数都不 reject', async () => {
  const previous = process.env.DSH_FINGERPRINT_HISTORY
  try {
    // 「历史文件」位于 node 可执行文件之下 ⇒ 父级是一个**文件**，创建子项必然失败
    process.env.DSH_FINGERPRINT_HISTORY = join(process.execPath, 'history.jsonl')
    // 前提断言：夹具本身确实具备「不可写」性质
    assert.ok((await stat(process.execPath)).isFile(), '前提：process.execPath 确实是一个文件')

    let result
    await assert.doesNotReject(async () => {
      result = await appendRecords([record()])
    })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /追加历史失败/)

    // 读侧同样不抛，退化为空
    await assert.doesNotReject(async () => {
      assert.deepEqual(await readHistory(), [])
    })
    await assert.doesNotReject(async () => {
      assert.deepEqual(await aggregateByModel(), [])
      await historyStats()
    })

    // clear 也不抛
    let removed
    await assert.doesNotReject(async () => {
      removed = await clearHistory()
    })
    assert.equal(removed, 0)
    // ⚠️ 此处**不**断言 stats.error：Windows 上该路径经 CreateFileW 报
    //    ERROR_PATH_NOT_FOUND → 映射为 ENOENT，按 §29.4 第 4 条被正确视为
    //    「文件不存在 ⇒ 空列表、不是错误」。真正的「读失败」由用例 7b（EISDIR）覆盖。
  } finally {
    if (previous === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
    else process.env.DSH_FINGERPRINT_HISTORY = previous
  }
})

test('7b) 永不抛：路径是已存在的目录 → 写失败与读失败都由 error 字段表达', async () => {
  await withTemp(async ({ dir }) => {
    const previous = process.env.DSH_FINGERPRINT_HISTORY
    await mkdir(dir, { recursive: true }) // 关键：先让目录真实存在，否则 appendFile 会把它创建成文件
    process.env.DSH_FINGERPRINT_HISTORY = dir
    try {
      let result
      await assert.doesNotReject(async () => {
        result = await appendRecords([record()])
      })
      assert.equal(result.ok, false, '写进一个目录必须失败')
      assert.match(String(result.error), /追加历史失败/)

      await assert.doesNotReject(async () => {
        assert.deepEqual(await readHistory(), [])
      })

      const stats = await historyStats()
      assert.equal(stats.count, 0)
      assert.match(String(stats.error), /读取历史文件失败/, '读一个目录失败（EISDIR），原因由 error 暴露')

      let removed
      await assert.doesNotReject(async () => {
        removed = await clearHistory()
      })
      assert.equal(removed, 0)
    } finally {
      if (previous === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
      else process.env.DSH_FINGERPRINT_HISTORY = previous
    }
  })
})

// ── 8. aggregateByModel ───────────────────────────────────────────────────

test('8) aggregateByModel：同模型 3 条 → runs=3，last* 取最新那条，按 lastTs 降序', async () => {
  await withTemp(async () => {
    await appendRecords([
      record({
        ts: '2026-11-02T06:00:00.000Z',
        provider: 'provider_a',
        model: 'M1',
        decision: 'unscorable',
        prediction: null,
        probability: null,
        stability: 'inconclusive',
      }),
      record({
        ts: '2026-11-02T06:01:00.000Z',
        provider: 'provider_a',
        model: 'M1',
        decision: 'partial',
        prediction: 'P-mid',
        probability: null,
        stability: 'unstable',
      }),
      record({
        ts: '2026-11-02T06:02:00.000Z',
        provider: 'provider_a',
        model: 'M1',
        decision: 'scored',
        prediction: 'P-last',
        probability: 0.91,
        stability: 'stable',
      }),
      record({
        ts: '2026-11-02T06:03:00.000Z',
        provider: 'provider_b',
        model: 'M2',
        decision: 'scored',
        prediction: 'P2',
        probability: 0.5,
        stability: 'stable',
      }),
    ])

    const rows = await aggregateByModel()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.model), ['M2', 'M1'], '按 lastTs 降序')

    const m1 = rows.find((r) => r.model === 'M1')
    assert.equal(m1.provider, 'provider_a')
    assert.equal(m1.runs, 3)
    assert.equal(m1.lastTs, '2026-11-02T06:02:00.000Z')
    assert.equal(m1.lastDecision, 'scored')
    assert.equal(m1.lastPrediction, 'P-last')
    assert.equal(m1.lastProbability, 0.91)
    assert.equal(m1.lastStability, 'stable')

    const m2 = rows.find((r) => r.model === 'M2')
    assert.equal(m2.runs, 1)
    assert.equal(m2.lastPrediction, 'P2')

    // 键集合恰好 8 个
    assert.deepEqual(Object.keys(m1).sort(), [
      'lastDecision',
      'lastPrediction',
      'lastProbability',
      'lastStability',
      'lastTs',
      'model',
      'provider',
      'runs',
    ])
  })
})

// ── 9. clearHistory ───────────────────────────────────────────────────────

test('9) clearHistory：返回移除条数，清空后 readHistory 为 []', async () => {
  await withTemp(async () => {
    await appendRecords([record({ runId: 'r-1' }), record({ runId: 'r-2' }), record({ runId: 'r-3' })])
    assert.equal((await historyStats()).count, 3)

    const removed = await clearHistory()
    assert.equal(removed, 3)

    assert.deepEqual(await readHistory(), [])
    const stats = await historyStats()
    assert.equal(stats.count, 0)
    assert.equal(stats.oldest, null)
    assert.equal(stats.newest, null)
    assert.equal(stats.error, null)

    // 幂等：再清一次得 0，不抛
    assert.equal(await clearHistory(), 0)
  })
})

// ── 10. §29.2「明确不记」白名单 ───────────────────────────────────────────

test('10) §29.2 白名单：rawText / challenges / samples / apiKey 等多余字段一律落盘丢弃', async () => {
  await withTemp(async ({ file }) => {
    const SENTINEL = 'MUST-NOT-PERSIST'
    await appendRecords([
      {
        ...record({ runId: 'r-secret' }),
        apiKey: `sk-${SENTINEL}`,
        rawText: `${SENTINEL}-${'x'.repeat(5000)}`,
        challenges: [{ prompt: SENTINEL }],
        samples: [{ raw_text: SENTINEL }],
      },
    ])

    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes(SENTINEL), false, '禁止持久化的内容不得出现在文件里')
    for (const forbidden of ['apiKey', 'rawText', 'challenges', 'samples']) {
      assert.equal(raw.includes(forbidden), false, `字段 ${forbidden} 不应被写入`)
    }

    const back = await readHistory()
    assert.equal(back.length, 1)
    assert.deepEqual(Object.keys(back[0]).sort(), RECORD_KEYS.slice().sort(), '键集合必须恰好是 §29.3 的 17 个')
  })
})

// ── 11. 进程内串行队列（§31.3 第 1 条）─────────────────────────────────────

test('11) 串行队列：并发 append ×3 + clear ×1 → 无半行、无丢记录', async () => {
  await withTemp(async ({ file }) => {
    const makeBatch = (from, to, tag, modelPad = 0) => {
      const out = []
      for (let i = from; i <= to; i += 1) {
        out.push(
          record({
            ts: new Date(Date.UTC(2026, 10, 2, 7, 0, 0, i)).toISOString(),
            runId: `${tag}-${String(i)}`,
            prediction: `${tag}-p-${String(i)}`,
            ...(modelPad > 0 ? { model: 'm'.repeat(modelPad) } : {}),
          }),
        )
      }
      return out
    }

    // 一个「重」批次：把 appendFile 的写入窗口撑大，让竞态有机会暴露。
    // 240 × ~3.1 KB ≈ 750 KB，仍在 1 MB 裁剪线之下 ⇒ 不会触发裁剪，不变量保持简单。
    const heavy = makeBatch(1, 240, 'H', 3000)

    // 同一 tick 全部发起（不 await 顺序启动），让它们真正竞争
    const pending = [
      appendRecords(heavy),
      appendRecords(makeBatch(1, 10, 'A')),
      clearHistory(),
      appendRecords(makeBatch(11, 20, 'B')),
    ]
    const [rH, r1, cleared, r2] = await Promise.all(pending)

    assert.equal(rH.ok, true)
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(typeof cleared, 'number')

    const appended = rH.appended + r1.appended + r2.appended
    assert.equal(appended, 260, '三个批次都必须完整写入')

    // 不变量 1：没有半行 —— 文件里每一行都是合法 JSON
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `出现半行/坏行：${line.slice(0, 60)}`)
    }

    // 不变量 2：现存行数 + 被清掉的条数 === 追加总数
    //   （clear 落在链上任何一环都成立：它移除的是"当时全部"，之后追加的都留下）
    assert.equal(
      lines.length + cleared,
      appended,
      `现存 ${String(lines.length)} + 清掉 ${String(cleared)} ≠ 追加 ${String(appended)}`,
    )

    // 不变量 3：读回的有效记录数与文件行数一致，且 stats 干净
    const stats = await historyStats()
    assert.equal(stats.error, null)
    assert.equal(stats.count, lines.length)
    assert.equal(stats.skippedLines, 0)

    // 不变量 4：留下的记录 id 全部是完整批次里的（没有幻觉记录）
    const known = new Set()
    for (const entry of [
      ['A', 1, 10],
      ['B', 11, 20],
      ['H', 1, 240],
    ]) {
      const [tag, from, to] = entry
      for (let i = from; i <= to; i += 1) known.add(`${tag}-${String(i)}`)
    }
    for (const rec of await readHistory()) {
      assert.equal(known.has(rec.runId), true, `出现未知 runId：${rec.runId}`)
    }
  })
})

test('11b) 队列：一环失败不污染后续调用（链永远收敛为 resolved）', async () => {
  await withTemp(async ({ file }) => {
    const previous = process.env.DSH_FINGERPRINT_HISTORY
    try {
      // 故意让「中间那一环」失败：把路径临时指到坏位置
      const badPath = join(process.execPath, 'history.jsonl')
      process.env.DSH_FINGERPRINT_HISTORY = badPath
      const bad = await appendRecords([record({ runId: 'r-bad' })])
      assert.equal(bad.ok, false, '坏路径那一环应当失败')

      // 紧接着恢复正常路径 —— 队列必须已经恢复，不能因为上一环失败而卡死
      process.env.DSH_FINGERPRINT_HISTORY = file
      const good = await appendRecords([record({ runId: 'r-good' })])
      assert.equal(good.ok, true, '上一环失败不得卡死队列')
      assert.equal(good.appended, 1)
      assert.equal((await historyStats()).count, 1)
    } finally {
      if (previous === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
      else process.env.DSH_FINGERPRINT_HISTORY = previous
    }
  })
})

// ── 12. 坏路径定向检测（§31.3 第 2 条）────────────────────────────────────

test('12) 坏路径定向检测：父级是文件 → historyStats().error 非空（原来那个 Windows 盲区）', async () => {
  await withTemp(async ({ dir }) => {
    const previous = process.env.DSH_FINGERPRINT_HISTORY
    try {
      await mkdir(dir, { recursive: true })
      const afile = join(dir, 'afile')
      await writeFile(afile, 'this is a file, not a directory', 'utf8')
      // 前提断言：夹具确实是「父级是文件」
      assert.equal((await stat(afile)).isFile(), true)

      process.env.DSH_FINGERPRINT_HISTORY = join(afile, 'history.jsonl')

      const stats = await historyStats()
      assert.equal(stats.count, 0)
      assert.notEqual(stats.error, null, '父级是文件必须被识别为坏路径，而不是静默表现为「空历史」')
      assert.match(String(stats.error), /读取历史文件失败/)
      assert.match(String(stats.error), /不是目录/)
      assert.deepEqual(await readHistory(), [])
      assert.deepEqual(await aggregateByModel(), [])

      // 对照组 A：父目录**尚未创建** ⇒ 仍是「首次运行」的正常状态，不得报错
      process.env.DSH_FINGERPRINT_HISTORY = join(dir, 'not-created-yet', 'history.jsonl')
      const fresh = await historyStats()
      assert.equal(fresh.error, null, '父目录尚不存在属于首次运行，不得报错')
      assert.equal(fresh.count, 0)

      // 对照组 B：父目录是目录、文件未创建 ⇒ 正常空历史
      const realdir = join(dir, 'realdir')
      await mkdir(realdir, { recursive: true })
      process.env.DSH_FINGERPRINT_HISTORY = join(realdir, 'history.jsonl')
      const normal = await historyStats()
      assert.equal(normal.error, null, '文件未创建属于正常状态')
      assert.equal(normal.count, 0)

      // 对照组 C：父目录不存在时**写入应当成功**（appendRecords 会 mkdir 出来）
      process.env.DSH_FINGERPRINT_HISTORY = join(dir, 'fresh-dir', 'history.jsonl')
      const written = await appendRecords([record({ runId: 'r-fresh' })])
      assert.equal(written.ok, true, '父目录不存在属正常状态，写入应自动创建目录并成功')
      assert.equal((await historyStats()).count, 1)
    } finally {
      if (previous === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
      else process.env.DSH_FINGERPRINT_HISTORY = previous
    }
  })
})
