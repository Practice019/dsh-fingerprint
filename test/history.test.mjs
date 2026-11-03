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
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  HISTORY_PATH,
  appendRecords,
  readHistory,
  clearHistory,
  historyStats,
  aggregateByModel,
  writeActiveRun,
  readActiveRun,
  clearActiveRun,
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

/** §29.3 + §61.4 B + §64.4 冻结的 19 个键（原 17 + probabilityStatus + origin，都追加在最后）。 */
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
  'probabilityStatus',
  'origin',
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

    // 键集合恰好 9 个（原 8 + §61.4 B 的 lastProbabilityStatus）
    assert.deepEqual(Object.keys(m1).sort(), [
      'lastDecision',
      'lastPrediction',
      'lastProbability',
      'lastProbabilityStatus',
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
    assert.deepEqual(Object.keys(back[0]).sort(), RECORD_KEYS.slice().sort(), '键集合必须恰好是 §29.3 + §61.4 B 的 18 个')
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

// ══ 运行中侧车（§55）════════════════════════════════════════════════════════

/**
 * 侧车测试的隔离夹具：用**独立**变量 `DSH_FINGERPRINT_ACTIVE_RUN` 指到临时目录。
 * ⚠️ 刻意不复用 `withTemp`（那个设的是 `DSH_FINGERPRINT_HISTORY`）—— 侧车有自己的覆盖变量，
 * 两者混用会让「隔离断言」失去意义（§55 硬要求 1 / 用例 20）。
 */
async function withTempSidecar(fn) {
  counter += 1
  const dir = join(tmpdir(), `dsh-fp-active-run-${String(process.pid)}-${String(counter)}-${String(Date.now())}`)
  const file = join(dir, 'active-run.json')
  const previous = process.env.DSH_FINGERPRINT_ACTIVE_RUN
  process.env.DSH_FINGERPRINT_ACTIVE_RUN = file
  try {
    return await fn({ file, dir })
  } finally {
    if (previous === undefined) delete process.env.DSH_FINGERPRINT_ACTIVE_RUN
    else process.env.DSH_FINGERPRINT_ACTIVE_RUN = previous
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** §55 冻结形状的侧车描述符。 */
function activeRunDescriptor(overrides = {}) {
  return {
    v: 1,
    runId: 'r-3',
    startedAt: '2026-11-03T00:10:02.315Z',
    pid: 12345,
    processStartedAt: 1762000000000,
    options: { rounds: 3, count: 3, parallel: 3, strict: true },
    targets: [{ provider: 'provider_a', model: 'example/text-image' }],
    ...overrides,
  }
}

// ── 13. 写入 → 逐字段读回 ─────────────────────────────────────────────────

test('13) 侧车：写入后逐字段读回一致，且落盘可解析', async () => {
  await withTempSidecar(async ({ file }) => {
    const written = await writeActiveRun(activeRunDescriptor())
    assert.equal(written.ok, true)
    assert.equal(written.error, null)
    assert.equal(written.path, file, 'path 必须反映当前生效的侧车路径')

    const back = await readActiveRun()
    assert.equal(back.v, 1)
    assert.equal(back.runId, 'r-3')
    assert.equal(back.startedAt, '2026-11-03T00:10:02.315Z')
    assert.equal(back.pid, 12345)
    assert.equal(back.processStartedAt, 1762000000000, '关键字段必须原样往返')
    assert.deepEqual(back.options, { rounds: 3, count: 3, parallel: 3, strict: true })
    assert.deepEqual(back.targets, [{ provider: 'provider_a', model: 'example/text-image' }])

    // 键集合恰好 8 个（§55 冻结形状 + §64.4 的 origin）
    assert.deepEqual(Object.keys(back).sort(), [
      'options',
      'origin',
      'pid',
      'processStartedAt',
      'runId',
      'startedAt',
      'targets',
      'v',
    ])

    // 盘上内容本身可被 JSON.parse
    const rawOnDisk = await readFile(file, 'utf8')
    assert.doesNotThrow(() => JSON.parse(rawOnDisk))
  })
})

// ── 14. 未写入 → null ────────────────────────────────────────────────────

test('14) 侧车：未写入时 readActiveRun() → null（不是错误）', async () => {
  await withTempSidecar(async () => {
    assert.equal(await readActiveRun(), null)
    assert.equal(await readActiveRun(), null, '反复读仍为 null，不抛')
  })
})

// ── 15. 损坏 JSON → null ────────────────────────────────────────────────

test('15) 侧车：损坏 JSON → null，不抛（损坏必须当作「没有侧车」）', async () => {
  await withTempSidecar(async ({ file, dir }) => {
    await mkdir(dir, { recursive: true })

    for (const body of ['{ 这不是 json', 'null', '"a string"', '[]', '']) {
      await writeFile(file, body, 'utf8')
      let result
      await assert.doesNotReject(async () => {
        result = await readActiveRun()
      })
      assert.equal(result, null, `损坏内容必须判为「没有侧车」：${JSON.stringify(body)}`)
    }
  })
})

// ── 16. 缺关键字段 → null ──────────────────────────────────────────────

test('16) 侧车：缺 runId / processStartedAt → null；补齐后能读出', async () => {
  await withTempSidecar(async ({ file, dir }) => {
    await mkdir(dir, { recursive: true })

    const bad = [
      '{"v":1,"pid":1}', // 两个关键字段都缺
      '{"runId":"r-3","pid":1}', // 缺 processStartedAt
      '{"processStartedAt":1762000000000,"pid":1}', // 缺 runId
      '{"runId":"","processStartedAt":1762000000000}', // runId 空串
      '{"runId":"r-3","processStartedAt":"not-a-number"}', // 类型不对
      '{"runId":"r-3","processStartedAt":null}', // 显式 null
    ]
    for (const body of bad) {
      await writeFile(file, body, 'utf8')
      assert.equal(await readActiveRun(), null, `应判为不可用：${body}`)
    }

    // 反向断言：补齐关键字段后必须能读出来
    // ⇒ 证明上面的 null 是因为「缺关键字段」，而不是因为读路径坏了
    await writeFile(file, '{"runId":"r-3","processStartedAt":1762000000000}', 'utf8')
    const ok = await readActiveRun()
    assert.notEqual(ok, null)
    assert.equal(ok.runId, 'r-3')
    assert.equal(ok.processStartedAt, 1762000000000)
    assert.equal(ok.pid, null, '缺失的非关键字段落成 null')
    assert.deepEqual(ok.targets, [], '缺失的 targets 落成空数组')
  })
})

// ── 17. clearActiveRun 幂等 ────────────────────────────────────────────

test('17) 侧车：clearActiveRun 删文件；重复调用仍 ok:true / removed:false', async () => {
  await withTempSidecar(async ({ dir }) => {
    await writeActiveRun(activeRunDescriptor())
    assert.notEqual(await readActiveRun(), null)

    const first = await clearActiveRun()
    assert.equal(first.ok, true)
    assert.equal(first.removed, true, '第一次确实删掉了文件')
    assert.equal(first.error, null)
    assert.equal(await readActiveRun(), null)

    // 幂等：文件已不在 ⇒ 仍算成功，removed:false
    const second = await clearActiveRun()
    assert.equal(second.ok, true, '文件本就不存在也算成功')
    assert.equal(second.removed, false)
    assert.equal(second.error, null)

    assert.deepEqual(await clearActiveRun(), { ok: true, removed: false, error: null })

    // 文件确实不在了
    await assert.rejects(async () => readFile(join(dir, 'active-run.json'), 'utf8'))
  })
})

// ── 18. 原子性 ──────────────────────────────────────────────────────────

test('18) 侧车：原子性 —— 写入后盘上必定是完整可解析的 JSON（无半截），且不残留 .tmp-', async () => {
  await withTempSidecar(async ({ file }) => {
    for (let i = 1; i <= 12; i += 1) {
      const big = 'm'.repeat(i * 500)
      const ok = await writeActiveRun(
        activeRunDescriptor({
          runId: `r-${String(i)}`,
          targets: Array.from({ length: i * 3 }, (_, k) => ({ provider: `p-${String(k)}`, model: big })),
        }),
      )
      assert.equal(ok.ok, true)

      const raw = await readFile(file, 'utf8')
      let parsed
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw)
      }, `第 ${String(i)} 次写入后盘上不是合法 JSON（半截）`)
      assert.equal(parsed.runId, `r-${String(i)}`)
      assert.equal(parsed.targets.length, i * 3)
    }

    const leftovers = (await readdir(dirname(file))).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'rename 完成后不应残留临时文件')
  })
})

// ── 19. 永不抛 ──────────────────────────────────────────────────────────

test('19) 侧车：永不抛 —— 父级是文件时三个函数都只返回 error / null', async () => {
  await withTempSidecar(async ({ dir }) => {
    const afile = join(dir, 'afile')
    await mkdir(dir, { recursive: true })
    await writeFile(afile, 'not a directory', 'utf8')
    // 前提断言：夹具确实具备「父级是文件」的性质
    assert.equal((await stat(afile)).isFile(), true)

    const previous = process.env.DSH_FINGERPRINT_ACTIVE_RUN
    process.env.DSH_FINGERPRINT_ACTIVE_RUN = join(afile, 'active-run.json')
    try {
      let w
      await assert.doesNotReject(async () => {
        w = await writeActiveRun(activeRunDescriptor())
      })
      assert.equal(w.ok, false)
      assert.match(String(w.error), /写入运行中侧车失败/)

      let r
      await assert.doesNotReject(async () => {
        r = await readActiveRun()
      })
      assert.equal(r, null, '路径不可读 ⇒ 当作没有侧车')

      let c
      await assert.doesNotReject(async () => {
        c = await clearActiveRun()
      })
      // 平台差异：Windows 把「父级是文件」映射为 ENOENT（⇒ ok:true/removed:false，语义正确），
      // 类 Unix 报 ENOTDIR（⇒ ok:false）。两者都属于「不抛且语义正确」，故只断言形状。
      assert.equal(typeof c.ok, 'boolean', '必须返回合法形状而不是抛')
      assert.equal(typeof c.removed, 'boolean')
    } finally {
      if (previous === undefined) delete process.env.DSH_FINGERPRINT_ACTIVE_RUN
      else process.env.DSH_FINGERPRINT_ACTIVE_RUN = previous
    }
  })
})

// ── 20. 与 history 路径隔离 ─────────────────────────────────────────────

test('20) 侧车与 history 隔离：写侧车不得在被覆盖的 history 目录里产生任何文件', async () => {
  await withTempSidecar(async ({ file: sidecarFile }) => {
    counter += 1
    const historyDir = join(tmpdir(), `dsh-fp-iso-${String(process.pid)}-${String(counter)}-${String(Date.now())}`)
    const historyFile = join(historyDir, 'history.jsonl')
    const previousHistory = process.env.DSH_FINGERPRINT_HISTORY
    process.env.DSH_FINGERPRINT_HISTORY = historyFile
    try {
      // 只写侧车
      const w = await writeActiveRun(activeRunDescriptor())
      assert.equal(w.ok, true)
      assert.equal(w.path, sidecarFile, '侧车必须落在 ACTIVE_RUN 指定的位置')

      // history 目录**根本不该被创建**
      await assert.rejects(async () => stat(historyDir), '写侧车不得创建 history 目录')

      // 反向：写 history 也不得碰侧车
      await appendRecords([record({ runId: 'r-x' })])
      const after = await readActiveRun()
      assert.equal(after.runId, 'r-3', '写 history 不得影响侧车')

      // 侧车目录里不得出现 history.jsonl
      const names = await readdir(dirname(sidecarFile))
      assert.equal(names.includes('history.jsonl'), false, '侧车目录里不得出现 history.jsonl')
      assert.equal(names.includes('active-run.json'), true, '侧车文件本身应在')

      // 反向：侧车目录里只有侧车相关文件
      assert.deepEqual(
        names.filter((n) => !n.startsWith('active-run.json')),
        [],
        `侧车目录出现了预期外的文件：${names.join(', ')}`,
      )
    } finally {
      if (previousHistory === undefined) delete process.env.DSH_FINGERPRINT_HISTORY
      else process.env.DSH_FINGERPRINT_HISTORY = previousHistory
      await rm(historyDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ── 18–22. §61.4 B：probabilityStatus（17 → 18 键）──────────────────────────

test('18) §61：probabilityStatus 三值往返（写盘 → 读回，文件里也真的写了）', async () => {
  await withTemp(async ({ file }) => {
    const written = await appendRecords([
      record({ runId: 'r-cal', probabilityStatus: 'reference_calibrated' }),
      record({ runId: 'r-unavail', probabilityStatus: 'unavailable' }),
      record({ runId: 'r-null', probabilityStatus: null }),
    ])
    assert.equal(written.ok, true)
    const back = await readHistory({})
    const byId = new Map(back.map((r) => [r.runId, r]))
    assert.equal(byId.get('r-cal').probabilityStatus, 'reference_calibrated')
    assert.equal(byId.get('r-unavail').probabilityStatus, 'unavailable')
    assert.equal(byId.get('r-null').probabilityStatus, null)
    const raw = await readFile(file, 'utf8')
    assert.ok(raw.includes('"reference_calibrated"'), '值必须真的落到文件里')
    assert.ok(raw.includes('"unavailable"'))
    // §61 追加 3：`null` 是**合法值** ⇒ 必须作为值写进去（键存在、值为 null），不能省略该键
    assert.ok(raw.includes('"probabilityStatus":null'), 'null 必须落盘（不是省略键）')
    assert.equal(raw.split('"probabilityStatus"').length - 1, 3, '三条记录都要有该键')
  })
})

test('19) §61：非法值一律归 null（任意字符串 / 大小写变体 / 数字 / 对象 / 数组 / 布尔）', async () => {
  await withTemp(async () => {
    const bads = [
      ['任意字符串', 'foo'],
      ['大小写变体', 'REFERENCE_CALIBRATED'],
      ['近似值', 'reference'],
      ['数字', 1],
      ['对象', { value: 'reference_calibrated' }],
      ['数组', ['unavailable']],
      ['布尔', true],
      ['空串', ''],
    ]
    for (const [label, bad] of bads) {
      await appendRecords([record({ runId: `r-bad-${label}`, probabilityStatus: bad })])
    }
    const back = await readHistory({})
    assert.equal(back.length, bads.length)
    for (const one of back) {
      assert.equal(one.probabilityStatus, null, `${one.runId} 的非法值必须归 null，实际 ${JSON.stringify(one.probabilityStatus)}`)
    }
  })
})

test('20) §61：旧记录（完全没有该键）⇒ 读出为 null 且**不判为损坏**（向后兼容硬要求）', async () => {
  await withTemp(async ({ file, dir }) => {
    await mkdir(dir, { recursive: true }) // withTemp 不建目录；本用例直接写文件，须自己建
    // 手写一行真正的"旧版记录"：17 键，没有 probabilityStatus
    const legacy = {
      v: 1,
      ts: '2026-11-01T00:00:00.000Z',
      runId: 'r-legacy',
      provider: 'provider_a',
      model: 'example/text-image',
      decision: 'scored',
      prediction: 'p',
      predictionName: 'P',
      family: null,
      familyName: null,
      probability: 0.5,
      agreement: 1,
      stability: 'stable',
      validRounds: 3,
      totalRounds: 3,
      options: { rounds: 3, count: 3, parallel: 3, strict: false },
      error: null,
    }
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8')

    const stats = await historyStats()
    assert.equal(stats.error, null, '旧记录不得让整体读取报错')
    assert.equal(stats.skippedLines, 0, '旧记录**不得**被判为损坏行')
    assert.equal(stats.count, 1)

    const back = await readHistory({})
    assert.equal(back.length, 1, '旧记录必须仍能被读出')
    assert.equal(back[0].probabilityStatus, null, '缺键 ⇒ null（未知），不是损坏')
    assert.equal(back[0].probability, 0.5, '既有 17 键语义不受影响')
    assert.equal(back[0].decision, 'scored')
    assert.deepEqual(Object.keys(back[0]).sort(), RECORD_KEYS.slice().sort(), '读出后键集合是 19 键（17 键旧记录也补齐）')
  })
})

test('21) §61：19 键白名单 —— 缺键归默认、多余键一律丢弃、键集合恰好 19', async () => {
  await withTemp(async ({ file }) => {
    const partial = record()
    const withExtra = { ...partial, extraField: 'x', apiKey: 'sk-should-be-dropped', rawText: 'RAW-TEXT', challenges: [1, 2] }
    await appendRecords([withExtra])
    const back = await readHistory({})
    assert.equal(back.length, 1, '缺 probabilityStatus 不得导致整条被拒；多余字段不得导致整条被拒')
    assert.deepEqual(Object.keys(back[0]).sort(), RECORD_KEYS.slice().sort(), '键集合必须恰好是 18 个')
    assert.equal(back[0].probabilityStatus, null)
    assert.equal(Object.hasOwn(back[0], 'apiKey'), false)
    assert.equal(Object.hasOwn(back[0], 'rawText'), false)
    assert.equal(Object.hasOwn(back[0], 'challenges'), false)
    const raw = await readFile(file, 'utf8')
    assert.ok(!raw.includes('sk-should-be-dropped'), '秘密不得落盘')
    assert.ok(!raw.includes('RAW-TEXT'))
  })
})

test('22) §61：aggregateByModel.lastProbabilityStatus —— 取最新那条；缺该键 ⇒ null（不回退到旧值）', async () => {
  await withTemp(async () => {
    await appendRecords([
      record({ runId: 'r-1', ts: '2026-11-02T06:00:00.000Z', probabilityStatus: 'unavailable' }),
      record({ runId: 'r-2', ts: '2026-11-02T06:01:00.000Z', probabilityStatus: 'reference_calibrated' }),
      record({ runId: 'r-x', ts: '2026-11-02T06:03:00.000Z', provider: 'provider_b', model: 'example/text-image-2' }),
    ])
    const rows = await aggregateByModel()
    const a = rows.find((r) => r.model === 'example/text-image')
    assert.equal(a.lastProbabilityStatus, 'reference_calibrated', '最新那条的值')
    assert.equal(a.runs, 2)
    const b = rows.find((r) => r.model === 'example/text-image-2')
    assert.equal(b.lastProbabilityStatus, null, '唯一那条没给该键 ⇒ null')

    // 再来一条更新的 null ⇒ 必须跟着变成 null（不回退到上一条的 reference_calibrated）
    await appendRecords([record({ runId: 'r-3', ts: '2026-11-02T06:04:00.000Z', probabilityStatus: null })])
    const rows2 = await aggregateByModel()
    const a2 = rows2.find((r) => r.model === 'example/text-image')
    assert.equal(a2.lastProbabilityStatus, null, '最新那条是 null ⇒ null（不得回退）')
    assert.equal(a2.runs, 3)

    // 再来一条 unavailable ⇒ 跟着变成 unavailable
    await appendRecords([record({ runId: 'r-4', ts: '2026-11-02T06:05:00.000Z', probabilityStatus: 'unavailable' })])
    const rows3 = await aggregateByModel()
    assert.equal(rows3.find((r) => r.model === 'example/text-image').lastProbabilityStatus, 'unavailable')
  })
})

// ── 23–27. §64.4：origin（18 → 19 键；侧车 7 → 8 键）────────────────────────

test('23) §64.4：19 键白名单 —— 缺 origin 归默认、显式 null 保持 null、多余键丢弃、键集合恰好 19', async () => {
  await withTemp(async ({ file }) => {
    // ① 写入路径：**新建记录**缺 origin ⇒ 'ui'（"新建记录必须有值"）
    const noOrigin = record({ runId: 'r-no-origin' })
    delete noOrigin.origin
    const withExtra = { ...record({ runId: 'r-extra', origin: 'probe' }), extraField: 'x', apiKey: 'sk-should-be-dropped', rawText: 'RAW' }
    // ② 显式 null（中断恢复用的"未知"）⇒ 必须是 null，**不得**被补成 'ui'
    const explicitNull = record({ runId: 'r-null-origin', origin: null })
    await appendRecords([noOrigin, withExtra, explicitNull])

    const back = await readHistory({})
    const byId = new Map(back.map((r) => [r.runId, r]))
    assert.equal(back.length, 3, '三种情况都不得被拒')
    for (const one of back) {
      assert.deepEqual(Object.keys(one).sort(), RECORD_KEYS.slice().sort(), '键集合必须恰好 19 个')
    }
    assert.equal(byId.get('r-no-origin').origin, 'ui', '写入路径缺省 ⇒ ui')
    assert.equal(byId.get('r-null-origin').origin, null, '显式 null ⇒ null（未知，绝不伪装成 ui）')
    assert.equal(byId.get('r-extra').origin, 'probe')
    assert.equal(Object.hasOwn(back[0], 'apiKey'), false)
    const raw = await readFile(file, 'utf8')
    assert.ok(!raw.includes('sk-should-be-dropped'))
    assert.ok(raw.includes('"origin":null'), 'null 必须作为值落盘（不是省略键）')
  })
})

test('24) §64.4：旧记录（18 键、无 origin）⇒ 读出 null，且 skippedLines=0 / stats.error=null', async () => {
  await withTemp(async ({ file, dir }) => {
    await mkdir(dir, { recursive: true })
    const legacy = {
      v: 1,
      ts: '2026-11-01T00:00:00.000Z',
      runId: 'r-legacy18',
      provider: 'provider_a',
      model: 'example/text-image',
      decision: 'scored',
      prediction: 'p',
      predictionName: 'P',
      family: null,
      familyName: null,
      probability: 0.5,
      agreement: 1,
      stability: 'stable',
      validRounds: 3,
      totalRounds: 3,
      options: { rounds: 3, count: 3, parallel: 3, strict: false },
      error: null,
      probabilityStatus: 'unavailable',
    }
    assert.equal(Object.keys(legacy).length, 18, '夹具必须是 18 键的旧记录')
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8')

    const stats = await historyStats()
    assert.equal(stats.error, null)
    assert.equal(stats.skippedLines, 0, '旧记录**不得**被判为损坏')
    const back = await readHistory({})
    assert.equal(back.length, 1)
    assert.equal(back[0].origin, null, '缺 origin ⇒ null（未知），**不得**当作 ui')
    assert.equal(back[0].probabilityStatus, 'unavailable', '既有 §61 字段不受影响')
    assert.equal(back[0].probability, 0.5)
    assert.deepEqual(Object.keys(back[0]).sort(), RECORD_KEYS.slice().sort())
  })
})

test('25) §64.4：三个合法值往返；读取路径的非法值 ⇒ null', async () => {
  await withTemp(async ({ file, dir }) => {
    for (const value of ['ui', 'cli', 'probe']) {
      await appendRecords([record({ runId: `r-${value}`, origin: value })])
    }
    // 手写一条被改坏的记录：origin 是非法值 ⇒ 读取路径必须归 null（不透传）
    await mkdir(dir, { recursive: true })
    const corrupted = { ...record({ runId: 'r-corrupted' }), origin: 'foo' }
    await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify(corrupted)}\n`, 'utf8')

    const back = await readHistory({})
    const byId = new Map(back.map((r) => [r.runId, r]))
    assert.equal(byId.get('r-ui').origin, 'ui')
    assert.equal(byId.get('r-cli').origin, 'cli')
    assert.equal(byId.get('r-probe').origin, 'probe')
    assert.equal(byId.get('r-corrupted').origin, null, '非法值 ⇒ null（读取路径不透传）')
    assert.equal((await historyStats()).skippedLines, 0)
  })
})

test('26) §64.4：侧车放行 origin —— 合法值往返；缺省/非法 ⇒ null（绝不发明 ui）', async () => {
  await withTempSidecar(async () => {
    await writeActiveRun({
      v: 1,
      runId: 'r-probe-run',
      startedAt: '2026-11-03T01:00:00.000Z',
      pid: 1234,
      processStartedAt: 1762000000000,
      options: { rounds: 1, count: 1, parallel: 1, strict: false },
      targets: [{ provider: 'provider_a', model: 'example/text-image' }],
      origin: 'probe',
    })
    const back = await readActiveRun()
    assert.equal(back.origin, 'probe', '侧车必须原样带上 origin')
    assert.equal(Object.keys(back).length, 8, '侧车键数 7 → 8')

    // 旧版侧车（没有该字段）⇒ null
    await writeActiveRun({
      v: 1,
      runId: 'r-legacy-run',
      startedAt: '2026-11-03T01:00:00.000Z',
      pid: 1234,
      processStartedAt: 1762000000000,
      options: { rounds: 1, count: 1, parallel: 1, strict: false },
      targets: [{ provider: 'provider_a', model: 'example/text-image' }],
    })
    const legacy = await readActiveRun()
    assert.equal(legacy.origin, null, '旧侧车缺字段 ⇒ null（不得伪装成 ui）')
    // 非法值也 ⇒ null
    await writeActiveRun({
      v: 1,
      runId: 'r-bad-run',
      startedAt: '2026-11-03T01:00:00.000Z',
      pid: 1234,
      processStartedAt: 1762000000000,
      options: { rounds: 1, count: 1, parallel: 1, strict: false },
      targets: [{ provider: 'provider_a', model: 'example/text-image' }],
      origin: 'foo',
    })
    assert.equal((await readActiveRun()).origin, null, '侧车里的非法值 ⇒ null')
  })
})

test('27) §64.4：aggregateByModel 的行形状不变（仍 9 键、无 origin）；runs 仍是**全部记录**的计数', async () => {
  await withTemp(async () => {
    await appendRecords([
      record({ runId: 'r-ui', origin: 'ui', ts: '2026-11-02T06:00:00.000Z' }),
      record({ runId: 'r-probe', origin: 'probe', ts: '2026-11-02T06:01:00.000Z' }),
      record({ runId: 'r-cli', origin: 'cli', ts: '2026-11-02T06:02:00.000Z' }),
    ])
    const rows = await aggregateByModel()
    const row = rows.find((r) => r.model === 'example/text-image')
    // 我的选择：`aggregateByModel()` **不过滤**（签名冻结、缺省语义 = 全部）⇒ runs 计所有来源。
    // 按来源分成"真实用户记录"由**路由**的 ?origin= 过滤负责（见 test/index.test.mjs）。
    assert.equal(row.runs, 3, '缺省语义 = 全部记录（不排除探针）')
    assert.deepEqual(Object.keys(row).sort(), [
      'lastDecision',
      'lastPrediction',
      'lastProbability',
      'lastProbabilityStatus',
      'lastStability',
      'lastTs',
      'model',
      'provider',
      'runs',
    ], '行形状不变（9 键，无 origin）')
    assert.equal(row.lastTs, '2026-11-02T06:02:00.000Z')
  })
})
