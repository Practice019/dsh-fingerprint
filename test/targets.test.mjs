/**
 * test/targets.test.mjs —— lib/targets.js 的离线单测（负责人 W5）
 *
 * 运行：node --test test/targets.test.mjs
 * 全部用自己构造的「假 ctx」注入，**不触碰任何真实服务、不发任何网络请求**。
 *
 * 假 ctx 的形状（可直接复用）：
 *   makeCtx({ directory, registered, describe, credentials, launchEnvironment, listModels })
 *   → { ctx, calls }   // calls.listModels 记录 listModels 被调用的 provider 序列
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { listTargets, invalidateTargets, deriveKeyRef } from '../lib/targets.js'

// ── 假 ctx ──────────────────────────────────────────────────────────────────

/**
 * 构造一个假 cordis 上下文。
 * @param directory           `llm.listConfigurableProviders()` 的返回值（目录，含休眠项）
 * @param registered          `llm.listProviders()` 的返回值（已注册路由）
 * @param describe            `settings.describe()` 的返回值
 * @param credentials         `ctx.get('credentials')` 的返回值
 * @param launchEnvironment   `ctx.get('launchEnvironment')` 的返回值
 * @param listModels          `llm.listModels(provider)` 的实现；默认返回 []
 */
function makeCtx({
  directory = [],
  registered = [],
  describe = [],
  credentials,
  launchEnvironment,
  listModels,
} = {}) {
  const calls = { listModels: [] }
  const ctx = {
    llm: {
      listConfigurableProviders: () => directory,
      listProviders: () => registered,
      listModels: async (provider) => {
        calls.listModels.push(provider)
        if (typeof listModels === 'function') return listModels(provider)
        return []
      },
    },
    settings: {
      describe: () => describe,
    },
    get(key) {
      if (key === 'credentials') return credentials
      if (key === 'launchEnvironment') return launchEnvironment
      return undefined
    },
  }
  return { ctx, calls }
}

/** 造一个 pi-ai 风格的 settings ns 条目：profile 挂在 `value.providers.<id>`。 */
function piAiDescriptor(providers) {
  return { ns: 'llm-pi-ai', value: { providers } }
}

/** 造一个 llm-deepseek 风格的 settings ns 条目：profile 就是 `value` 本身。 */
function deepseekDescriptor(profile) {
  return { ns: 'llm-deepseek', value: profile }
}

/** 常用的三个模型配置。 */
const THREE_MODELS = [
  { id: 'workbuddy/deepseek-v4.1-flash', name: 'workbuddy/deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 128000 },
  { id: 'loomy/DeepSeek-V4.1-Flash', name: 'loomy/DeepSeek-V4.1-Flash', contextWindow: 1048576, maxTokens: 384000, input: ['text', 'image'] },
  { id: 'workbuddy-intl/deepseek-v4.1-flash', name: 'workbuddy-intl/deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 128000 },
]

// ── 1. 并集 ────────────────────────────────────────────────────────────────

test('1) 目录条目 + 已注册路由取并集，同一 provider 不重复', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      { provider: 'test', displayName: 'test', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'test'] },
    ],
    registered: [
      { id: 'my', name: 'my' }, // 与目录重复 —— 不得产生第二行
      { id: 'deepseek-official', name: 'DeepSeek 官方' }, // 只在注册侧出现
    ],
    describe: [
      piAiDescriptor({ my: { models: [] }, test: { models: [] } }),
      deepseekDescriptor({ models: [] }),
    ],
  })

  const { providers } = await listTargets(ctx)

  assert.deepEqual(
    providers.map((p) => p.provider),
    ['my', 'test', 'deepseek-official'],
    '目录顺序在前，仅注册侧的新 provider 追加在后，重复项只出现一次',
  )
  assert.equal(providers.length, 3)
})

// ── 2. active / dormant ───────────────────────────────────────────────────

test('2) active / dormant 判定正确，休眠项也出现在结果里', async () => {
  invalidateTargets()
  const { ctx, calls } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: true },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: true },
    ],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { models: [] }, openai: { models: [] }, anthropic: { models: [] } })],
  })

  const { providers } = await listTargets(ctx)
  const byProvider = new Map(providers.map((p) => [p.provider, p]))

  assert.equal(byProvider.get('my').active, true)
  assert.equal(byProvider.get('my').dormant, false)

  assert.equal(byProvider.get('openai').active, false)
  assert.equal(byProvider.get('openai').dormant, true)
  assert.equal(byProvider.get('anthropic').dormant, true)

  // 休眠项依然在清单里（UI 靠 active 决定是否禁用复选框，见 §12.5）
  assert.equal(providers.length, 3)

  // catalog 只该问 active 的
  assert.deepEqual(calls.listModels, ['my'], '休眠 provider 不得触发 listModels')
})

// ── 3. 核心：无 key 时 listModels 返回 []，config 模型必须还在 ──────────────

test('3) 核心：settings 有 3 个 model 而 listModels 返回 [] → 3 个 config 模型照常在', async () => {
  invalidateTargets()
  const { ctx, calls } = makeCtx({
    directory: [
      { provider: 'test', displayName: 'test', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'test'] },
    ],
    registered: [{ id: 'test', name: 'test' }],
    describe: [
      piAiDescriptor({
        test: { api: 'openai-completions', baseURL: 'http://127.0.0.1:7860/v1', apiKeyEnv: 'TEST_API_KEY', models: THREE_MODELS },
      }),
    ],
    // 模拟 pi-ai 无 key 的行为：MISSING_CREDENTIAL → return []
    listModels: async () => [],
  })

  const { providers } = await listTargets(ctx)
  const target = providers.find((p) => p.provider === 'test')

  assert.equal(target.models.length, 3, '不能因为 listModels 返回空就丢掉 settings 里的模型')
  assert.deepEqual(
    target.models.map((m) => m.id),
    THREE_MODELS.map((m) => m.id),
  )
  assert.ok(
    target.models.every((m) => m.source === 'config'),
    '主来源必须是 config',
  )
  assert.equal(target.models[1].contextWindow, 1048576)
  assert.equal(target.models[1].maxTokens, 384000)

  assert.deepEqual(calls.listModels, ['test'], 'active provider 仍会尝试一次 catalog')
})

// ── 4. listModels 抛错 ────────────────────────────────────────────────────

test('4) listModels 抛错 → config 模型照常在，整个调用不抛异常', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
    ],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { models: THREE_MODELS } })],
    listModels: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7860')
    },
  })

  let result
  await assert.doesNotReject(async () => {
    result = await listTargets(ctx)
  })

  const target = result.providers.find((p) => p.provider === 'my')
  assert.equal(target.models.length, 3)
  assert.ok(target.models.every((m) => m.source === 'config'))
  assert.equal(target.error, null, 'catalog 失败不算 provider 级错误')
})

// ── 5. settingsPath 两种形状 ───────────────────────────────────────────────

test('5) settingsPath 下钻：["providers","my"] 与 [] 两种形状都正确', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      { provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] },
    ],
    registered: [
      { id: 'my', name: 'my' },
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
    ],
    describe: [
      // shape A：嵌套在 value.providers.my
      piAiDescriptor({
        my: { api: 'openai-completions', baseURL: 'http://198.51.100.7:7863/v1', models: THREE_MODELS },
      }),
      // shape B：profile 就是 section 根
      deepseekDescriptor({
        api: 'deepseek-completions',
        baseURL: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }],
      }),
    ],
  })

  const { providers } = await listTargets(ctx)
  const byProvider = new Map(providers.map((p) => [p.provider, p]))

  // shape A
  assert.equal(byProvider.get('my').api, 'openai-completions')
  assert.equal(byProvider.get('my').baseURL, 'http://198.51.100.7:7863/v1')
  assert.equal(byProvider.get('my').models.length, 3)

  // shape B（settingsPath 为空 → 不下钻）
  assert.equal(byProvider.get('deepseek-official').api, 'deepseek-completions')
  assert.equal(byProvider.get('deepseek-official').baseURL, 'https://api.deepseek.com')
  assert.deepEqual(
    byProvider.get('deepseek-official').models.map((m) => m.id),
    ['deepseek-v4-flash'],
  )
})

test('5b) settings 缺 ns / 形状怪 → 不当作错误，只是没有 config 模型', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      { provider: 'ghost', displayName: 'ghost', settingsNs: 'not-present', settingsPath: ['providers', 'ghost'] },
      { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'] },
      { provider: 'nopath', displayName: 'nopath', settingsNs: 'llm-pi-ai' }, // 没有 settingsPath
    ],
    registered: [],
    describe: [
      piAiDescriptor({ weird: 'not-an-object' }), // profile 形状怪
      { ns: 'llm-pi-ai', value: null },
    ],
  })

  const { providers } = await listTargets(ctx)
  assert.equal(providers.length, 3)
  for (const row of providers) {
    assert.deepEqual(row.models, [])
    assert.equal(row.error, null)
    assert.equal(row.active, false)
    assert.equal(row.dormant, true)
  }
})

// ── 6. credentialRef 回退 ─────────────────────────────────────────────────

test('6) credentialRef：profile.apiKeyEnv 优先，缺失时回退 deriveKeyRef', async () => {
  invalidateTargets()
  assert.equal(deriveKeyRef('my'), 'MY_API_KEY')
  assert.equal(deriveKeyRef('deepseek-official'), 'DEEPSEEK_OFFICIAL_API_KEY')
  assert.equal(deriveKeyRef('a.b c-d'), 'A_B_C_D_API_KEY')

  const { ctx } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      { provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] },
    ],
    registered: [],
    describe: [
      piAiDescriptor({ my: { apiKeyEnv: 'MY_CUSTOM_KEY', models: [] } }),
      deepseekDescriptor({ models: [] }), // 无 apiKeyEnv
    ],
  })

  const { providers } = await listTargets(ctx)
  const byProvider = new Map(providers.map((p) => [p.provider, p]))

  assert.equal(byProvider.get('my').credentialRef, 'MY_CUSTOM_KEY', 'profile 里有就用它')
  assert.equal(byProvider.get('my').credentialRefSource, 'profile')
  assert.equal(
    byProvider.get('deepseek-official').credentialRef,
    'DEEPSEEK_OFFICIAL_API_KEY',
    'profile 里没有就走 deriveKeyRef',
  )
  assert.equal(byProvider.get('deepseek-official').credentialRefSource, 'guessed')
})

// ── 7. 明文 key 绝不外泄 ──────────────────────────────────────────────────

test('7) credentialAvailable 只回布尔，返回体里绝不含 key 明文', async () => {
  const SECRET = 'sk-super-secret-value-must-never-leak'

  // (a) credentials 有值 → true，但值不外泄
  invalidateTargets()
  const { ctx: ctxWithKey } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: THREE_MODELS } })],
    credentials: { resolve: async () => ({ value: SECRET, source: 'store' }) },
  })

  const withKey = await listTargets(ctxWithKey)
  assert.equal(withKey.providers[0].credentialAvailable, true)
  assert.equal(
    JSON.stringify(withKey).includes(SECRET),
    false,
    '返回体序列化后不得出现明文 key',
  )

  // (b) credentials 没有 → 回退 launchEnvironment 命中 → true，值仍不外泄
  invalidateTargets()
  const { ctx: ctxWithEnv } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: THREE_MODELS } })],
    launchEnvironment: { get: (ref) => (ref === 'MY_API_KEY' ? { value: SECRET } : undefined) },
  })

  const withEnv = await listTargets(ctxWithEnv)
  assert.equal(withEnv.providers[0].credentialAvailable, true)
  assert.equal(JSON.stringify(withEnv).includes(SECRET), false)

  // (c) 两处都没有 → false，且同样不含明文
  invalidateTargets()
  const { ctx: ctxNoKey } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: THREE_MODELS } })],
    credentials: { resolve: async () => undefined },
    launchEnvironment: { get: () => undefined },
  })

  const noKey = await listTargets(ctxNoKey)
  assert.equal(noKey.providers[0].credentialAvailable, false)
  assert.equal(JSON.stringify(noKey).includes(SECRET), false)
  assert.equal(JSON.stringify(noKey).includes('MY_API_KEY'), true, '引用名本身是配置，可以出现')
})

// ── 8. 错误隔离 ───────────────────────────────────────────────────────────

test('8) 单个 provider 抛错 → 其余 provider 正常，出错者带 error', async () => {
  invalidateTargets()

  // 目录字段是抛错 getter：扫描阶段不得被它炸掉
  const evil = { provider: 'evil' }
  Object.defineProperty(evil, 'settingsNs', {
    get() {
      throw new Error('boom-settingsNs')
    },
  })

  const { ctx } = makeCtx({
    directory: [
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      evil,
      { provider: 'bad', displayName: 'bad' }, // 无 settingsNs → 走 deriveKeyRef
      { provider: 'diag', displayName: 'diag', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'diag'], error: '配置诊断：缺少 baseURL' },
    ],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { models: THREE_MODELS }, diag: { models: [] } })],
    credentials: {
      resolve: async (ref) => {
        if (ref === 'BAD_API_KEY') throw new Error('resolve exploded')
        return undefined
      },
    },
  })

  let result
  await assert.doesNotReject(async () => {
    result = await listTargets(ctx)
  })

  assert.equal(result.providers.length, 4, '一个 provider 出问题不得影响整体')

  const byProvider = new Map(result.providers.map((p) => [p.provider, p]))

  // 正常的照常
  assert.equal(byProvider.get('my').models.length, 3)
  assert.equal(byProvider.get('my').error, null)

  // 抛错 getter → 捕获成 error 字符串，其余字段退化为安全默认
  assert.match(byProvider.get('evil').error, /boom-settingsNs/)
  assert.deepEqual(byProvider.get('evil').models, [])
  assert.equal(byProvider.get('evil').displayName, 'evil')

  // credentials.resolve 抛错 → 只降级为 false，不算 provider 级错误
  assert.equal(byProvider.get('bad').credentialRef, 'BAD_API_KEY')
  assert.equal(byProvider.get('bad').credentialAvailable, false)
  assert.equal(byProvider.get('bad').error, null)

  // 目录自带的配置诊断必须透出
  assert.equal(byProvider.get('diag').error, '配置诊断：缺少 baseURL')
})

test('8b) 整个 llm / settings 服务缺失也不抛异常', async () => {
  invalidateTargets()
  for (const ctx of [
    {},
    { llm: {} },
    { llm: { listConfigurableProviders: () => { throw new Error('llm down') } }, settings: {} },
    { llm: {}, settings: { describe: () => { throw new Error('settings down') } } },
    null,
    undefined,
  ]) {
    const result = await listTargets(ctx)
    assert.deepEqual(result.providers, [], `ctx=${JSON.stringify(ctx)} 应退化为空清单`)
  }
})

// ── 9. input 模态透传 ─────────────────────────────────────────────────────

test('9) input 模态被正确透传，catalog 的 inputModalities 也映射进来', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [
      piAiDescriptor({
        my: {
          models: [
            { id: 'with-image', name: 'with-image', input: ['text', 'image'] },
            { id: 'text-only', name: 'text-only', input: ['text'] },
            { id: 'unknown', name: 'unknown' },
          ],
        },
      }),
    ],
    listModels: async () => [
      { provider: 'my', id: 'catalog-only', name: 'catalog-only', inputModalities: ['text', 'image'] },
      { provider: 'my', id: 'with-image', name: 'with-image', inputModalities: ['text', 'image'] }, // 与 config 重复
    ],
  })

  const { providers } = await listTargets(ctx)
  const models = new Map(providers[0].models.map((m) => [m.id, m]))

  assert.deepEqual(models.get('with-image').input, ['text', 'image'])
  assert.deepEqual(models.get('text-only').input, ['text'])
  assert.equal(models.get('unknown').input, null, '缺省表示未知，用 null 而不是空数组')

  // catalog 补充
  assert.deepEqual(models.get('catalog-only').input, ['text', 'image'])
  assert.equal(models.get('catalog-only').source, 'catalog')
  assert.equal(models.get('catalog-only').contextWindow, null)

  // 去重：config 优先，catalog 不得把 config 行挤掉
  assert.equal(models.get('with-image').source, 'config')
  assert.equal(providers[0].models.length, 4, '3 个 config + 1 个新 catalog，重复的不算')
})

// ── 10. 缓存 ──────────────────────────────────────────────────────────────

test('10) 5 秒短缓存：同一 ctx 命中缓存，invalidateTargets() 立即失效', async () => {
  invalidateTargets()
  let describeCalls = 0
  const ctx = {
    llm: { listConfigurableProviders: () => [], listProviders: () => [], listModels: async () => [] },
    settings: {
      describe: () => {
        describeCalls += 1
        return []
      },
    },
    get: () => undefined,
  }

  await listTargets(ctx)
  await listTargets(ctx)
  assert.equal(describeCalls, 1, '第二次调用应命中缓存')

  invalidateTargets()
  await listTargets(ctx)
  assert.equal(describeCalls, 2, 'invalidateTargets() 后必须重新构建')

  // 不同 ctx 不共享缓存
  const other = {
    llm: { listConfigurableProviders: () => [], listProviders: () => [], listModels: async () => [] },
    settings: { describe: () => [] },
    get: () => undefined,
  }
  invalidateTargets()
  await listTargets(ctx)
  await listTargets(other)
  assert.equal(describeCalls, 3, '不同 ctx 必须各算一次')
})

// ── 11. §14.2 credentialRef 按序探测 ──────────────────────────────────────

test('11) nativeAuth.env 命中 → credentialRef 取该值且 credentialRefSource === "nativeAuth"', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      {
        provider: 'my',
        displayName: 'my',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'my'],
        nativeAuth: { env: ['MY_PROVIDER_KEY', 'MY_FALLBACK_KEY'] },
      },
    ],
    registered: [{ id: 'my', name: 'my' }],
    // profile 里没有 apiKeyEnv → 落到第二级
    describe: [piAiDescriptor({ my: { models: [] } })],
    credentials: { resolve: async (ref) => (ref === 'MY_PROVIDER_KEY' ? { value: 'secret' } : undefined) },
  })

  const { providers } = await listTargets(ctx)
  const target = providers[0]

  assert.equal(target.credentialRef, 'MY_PROVIDER_KEY', 'nativeAuth.env 里取第一个非空 ref')
  assert.equal(target.credentialRefSource, 'nativeAuth')
  assert.equal(target.credentialAvailable, true)
})

test('12) profile.apiKeyEnv 优先于 nativeAuth.env，且 source === "profile"', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      {
        provider: 'my',
        displayName: 'my',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'my'],
        nativeAuth: { env: ['FROM_NATIVE'] },
      },
    ],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'FROM_PROFILE', models: [] } })],
    credentials: { resolve: async () => undefined },
  })

  const { providers } = await listTargets(ctx)
  const target = providers[0]

  assert.equal(target.credentialRef, 'FROM_PROFILE', 'apiKeyEnv 是第一优先级')
  assert.equal(target.credentialRefSource, 'profile')
  assert.equal(target.credentialAvailable, false, '两处都没值 → false（不是 null，因为没有走账号路由）')
})

test('14) credentialRefSource === "guessed" 只在三级兜底命中时出现', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [
      { provider: 'bare', displayName: 'bare', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bare'] },
      { provider: 'profiled', displayName: 'profiled', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'profiled'] },
      {
        provider: 'nativ',
        displayName: 'nativ',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'nativ'],
        nativeAuth: { env: ['NATIV_KEY'] },
      },
    ],
    registered: [],
    describe: [
      piAiDescriptor({
        bare: { models: [] },
        profiled: { apiKeyEnv: 'PROFILED_KEY', models: [] },
        nativ: { models: [] },
      }),
    ],
  })

  const { providers } = await listTargets(ctx)
  const byProvider = new Map(providers.map((p) => [p.provider, p]))

  assert.equal(byProvider.get('bare').credentialRefSource, 'guessed')
  assert.equal(byProvider.get('bare').credentialRef, 'BARE_API_KEY', '兜底用 deriveKeyRef')
  assert.equal(byProvider.get('bare').credentialAvailable, false, 'guessed 不影响可用性判定本身')

  assert.equal(byProvider.get('profiled').credentialRefSource, 'profile')
  assert.equal(byProvider.get('nativ').credentialRefSource, 'nativeAuth')

  // guessed 必须只出现在那个裸 provider 上
  const guessed = providers.filter((p) => p.credentialRefSource === 'guessed').map((p) => p.provider)
  assert.deepEqual(guessed, ['bare'])

  // 每个 provider 的 source 都在合法取值域内
  for (const row of providers) {
    assert.ok(
      ['profile', 'nativeAuth', 'guessed'].includes(row.credentialRefSource),
      `非法 source: ${row.credentialRefSource}`,
    )
  }
})

// ── 13. §14.3 / §15.2 credentialAvailable 三态 ────────────────────────────

test('13) credentialAvailable 三态：true / false / null 都能构造出来', async () => {
  // (a) true —— 确定 ref（来自 profile）且解析得到值
  invalidateTargets()
  const { ctx: ctxTrue } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: [] } })],
    credentials: { resolve: async () => ({ value: 'secret' }) },
  })
  assert.equal((await listTargets(ctxTrue)).providers[0].credentialAvailable, true)

  // (b) false —— 确定 ref（来自 profile），但确实没有值
  invalidateTargets()
  const { ctx: ctxFalse } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: [] } })],
    credentials: { resolve: async () => undefined },
    launchEnvironment: { get: () => undefined },
  })
  const falseResult = (await listTargets(ctxFalse)).providers[0]
  assert.equal(falseResult.credentialAvailable, false)
  assert.equal(falseResult.credentialRefSource, 'profile')

  // (c) null —— 走账号路由且前两级 ref 都没命中（ref 只能靠猜）→ 无法判定
  invalidateTargets()
  const { ctx: ctxNull } = makeCtx({
    directory: [
      {
        provider: 'deepseek-account',
        displayName: 'DeepSeek 账号',
        settingsNs: 'llm-deepseek-account',
        settingsPath: [],
        // §15.2：真机数据里 oauth 不是严格布尔 true
        nativeAuth: { oauth: 'oauth' },
      },
    ],
    registered: [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    describe: [{ ns: 'llm-deepseek-account', value: { models: [] } }], // 无 apiKeyEnv
    credentials: { resolve: async () => undefined },
  })
  const nullResult = (await listTargets(ctxNull)).providers[0]
  assert.equal(nullResult.credentialRefSource, 'guessed', '前两级都没命中 → 只能猜')
  assert.equal(nullResult.credentialAvailable, null, '账号路由 → 三态之「无法判定」')

  // (d) 【按 §15.2 重写】`source` 一旦是确定来源，就一律走 true/false —— 不再看 oauth
  invalidateTargets()
  const { ctx: ctxOauthWithRef } = makeCtx({
    directory: [
      {
        provider: 'deepseek-account',
        displayName: 'DeepSeek 账号',
        settingsNs: 'llm-deepseek-account',
        settingsPath: [],
        nativeAuth: { oauth: 'oauth' },
      },
    ],
    registered: [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    describe: [{ ns: 'llm-deepseek-account', value: { apiKeyEnv: 'DS_ACCOUNT_KEY', models: [] } }],
    credentials: { resolve: async () => undefined },
  })
  const oauthWithRef = (await listTargets(ctxOauthWithRef)).providers[0]
  assert.equal(oauthWithRef.credentialRefSource, 'profile', 'profile 给了确定 ref')
  assert.equal(
    oauthWithRef.credentialAvailable,
    false,
    '确定 ref ⇒ 走 true/false，账号路由不参与（null 只留给 guessed）',
  )
})

// ── 15. §15.2 真机形状：catalog 有模型 ⇒ 凭据其实是通的 ────────────────────

test('15) 【真机形状】source=guessed + catalogHasModels → credentialAvailable === null', async () => {
  invalidateTargets()
  // 逐字复刻主脑真机实测里的 deepseek-account：
  //   refSource=guessed（profile 无 apiKeyEnv）、oauth 不是严格布尔 true，
  //   但 listModels() 真的返回了 2 个模型 ⇒ 这条路由的凭据是通的（pi-ai 无凭据时返回 []）
  const { ctx, calls } = makeCtx({
    directory: [
      {
        provider: 'deepseek-account',
        displayName: 'DeepSeek 账号',
        settingsNs: 'llm-deepseek-account',
        settingsPath: [],
        nativeAuth: { oauth: 'oauth' },
      },
    ],
    registered: [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    describe: [{ ns: 'llm-deepseek-account', value: { models: [] } }],
    listModels: async () => [
      { provider: 'deepseek-account', id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
      { provider: 'deepseek-account', id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
    ],
    credentials: { resolve: async () => undefined },
  })

  const { providers } = await listTargets(ctx)
  const target = providers[0]

  assert.equal(target.credentialRefSource, 'guessed')
  assert.equal(target.models.length, 2)
  assert.ok(
    target.models.every((m) => m.source === 'catalog'),
    '真机里这 2 条来自 catalog（这正是凭据可用的旁证）',
  )
  assert.equal(target.credentialAvailable, null, '不得被报成「未配置」而被 UI 置灰')
  assert.deepEqual(calls.listModels, ['deepseek-account'])

  // (b) 隔离变量：**不走账号路由**，仅靠 catalog 有模型也必须得到 null
  invalidateTargets()
  const { ctx: ctxCatalogOnly } = makeCtx({
    directory: [
      {
        provider: 'catalog-only',
        displayName: 'catalog-only',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'catalog-only'],
      },
    ],
    registered: [{ id: 'catalog-only', name: 'catalog-only' }],
    describe: [piAiDescriptor({ 'catalog-only': { models: [] } })],
    listModels: async () => [{ provider: 'catalog-only', id: 'm1', name: 'm1' }],
    credentials: { resolve: async () => undefined },
  })
  const catalogOnly = (await listTargets(ctxCatalogOnly)).providers[0]
  assert.equal(catalogOnly.credentialRefSource, 'guessed')
  assert.equal(catalogOnly.credentialAvailable, null, '「catalog 有模型」这一条独立成立就足够')
})

// ── 16. guessed + 无旁证 ⇒ 真·未配置 ─────────────────────────────────────

test('16) source=guessed + catalog 无模型 + 非账号路由 → false（真·未配置）', async () => {
  invalidateTargets()
  const { ctx, calls } = makeCtx({
    directory: [{ provider: 'bare', displayName: 'bare', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bare'] }],
    registered: [{ id: 'bare', name: 'bare' }], // active ⇒ 会真的去问 catalog
    describe: [piAiDescriptor({ bare: { models: [] } })],
    listModels: async () => [], // 无凭据 → 返回 []，没有证明任何事
    credentials: { resolve: async () => undefined },
    launchEnvironment: { get: () => undefined },
  })

  const target = (await listTargets(ctx)).providers[0]

  assert.deepEqual(calls.listModels, ['bare'], '确实问过 catalog，只是它返回空')
  assert.equal(target.credentialRefSource, 'guessed')
  assert.equal(target.credentialAvailable, false, '猜的 ref + 零旁证 ⇒ 真·未配置')
})

// ── 17. oauth 用 truthy 判定 ──────────────────────────────────────────────

test('17) oauth 用 truthy 判定：字符串 "oauth" 算账号路由，假值不算', async () => {
  invalidateTargets()
  // 三个 provider 全部休眠（registered 为空）⇒ catalog 必定为空 ⇒ 隔离出 oauth 这一个变量
  const { ctx } = makeCtx({
    directory: [
      {
        provider: 'str-oauth',
        displayName: 'str-oauth',
        settingsNs: 'llm-x',
        settingsPath: [],
        nativeAuth: { oauth: 'oauth' },
      },
      {
        provider: 'empty-oauth',
        displayName: 'empty-oauth',
        settingsNs: 'llm-x',
        settingsPath: [],
        nativeAuth: { oauth: '' },
      },
      {
        provider: 'zero-oauth',
        displayName: 'zero-oauth',
        settingsNs: 'llm-x',
        settingsPath: [],
        nativeAuth: { oauth: 0 },
      },
    ],
    registered: [],
    describe: [{ ns: 'llm-x', value: { models: [] } }],
  })

  const { providers } = await listTargets(ctx)
  const byProvider = new Map(providers.map((p) => [p.provider, p]))

  for (const row of providers) {
    assert.equal(row.credentialRefSource, 'guessed', `${row.provider} 都应走兜底`)
  }

  assert.equal(byProvider.get('str-oauth').credentialAvailable, null, '真值字符串算账号路由 ⇒ 无法判定')
  assert.equal(byProvider.get('empty-oauth').credentialAvailable, false, '空串是假值 ⇒ 真·未配置')
  assert.equal(byProvider.get('zero-oauth').credentialAvailable, false, '0 是假值 ⇒ 真·未配置')
})

// ── 18. FIX-10-A：listModels 抛错 ⇒ catalogState='error' ⇒ null ───────────

test('18) FIX-10-A：listModels 抛错 → catalogState=error → credentialAvailable 为 null（不是 false）', async () => {
  invalidateTargets()
  const { ctx, calls } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    // profile 里**没有** apiKeyEnv ⇒ ref 只能靠猜（guessed）
    describe: [piAiDescriptor({ my: { models: THREE_MODELS } })],
    listModels: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7860')
    },
    credentials: { resolve: async () => undefined },
  })

  const { providers } = await listTargets(ctx)
  const target = providers[0]

  assert.deepEqual(calls.listModels, ['my'], '确实问过 catalog')
  assert.equal(target.credentialRefSource, 'guessed')
  assert.equal(target.settingsOk, true, 'settings 本身是好的')
  assert.equal(target.catalogState, 'error', 'FIX-10：异常必须被记为 error，不能静默吞成空数组')
  assert.equal(
    target.credentialAvailable,
    null,
    'catalog 问不通 ⇒ 旁证丢失 ⇒ 无法判定；报 false 会把可用 provider 置灰',
  )
  // §2.5 不受影响：config 模型仍在
  assert.equal(target.models.length, 3)
  assert.ok(target.models.every((m) => m.source === 'config'))
})

// ── 19. FIX-10-B：settings.describe() 瞬时失败 ⇒ settingsOk=false ⇒ null ──

test('19) FIX-10-B：settings.describe() 瞬时失败 → settingsOk=false → 全体 guessed 但为 null（不是 false）', async () => {
  invalidateTargets()
  // 手写 ctx：describe 直接抛错，模拟 settings 快照取不到
  const ctx = {
    llm: {
      listConfigurableProviders: () => [
        { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
      ],
      listProviders: () => [{ id: 'my', name: 'my' }],
      listModels: async () => [], // 同时也没有 catalog 旁证
    },
    settings: {
      describe: () => {
        throw new Error('settings 瞬时故障')
      },
    },
    get: (key) => (key === 'credentials' ? { resolve: async () => undefined } : undefined),
  }

  let result
  await assert.doesNotReject(async () => {
    result = await listTargets(ctx)
  })

  const target = result.providers[0]
  assert.equal(target.settingsOk, false, 'FIX-10：settings 快照取不到必须被记录')
  assert.equal(target.catalogState, 'ok', 'catalog 是问通了的（返回空数组）')
  assert.equal(target.credentialRefSource, 'guessed', 'profile 丢失 ⇒ 退化成猜的 ref')
  assert.equal(
    target.credentialAvailable,
    null,
    'settings 抖动不得被误报成「用户没配 key」—— 这正是 V-D 复现的 B 场景',
  )
})

// ── 20. FIX-10：两条旁证通路各自独立成立 ──────────────────────────────────

test('20) FIX-10：settingsOk 与 catalogState 是两条独立通路，任一丢失都判 null；都好才判 false', async () => {
  const dirEntry = {
    provider: 'my',
    displayName: 'my',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'my'],
  }

  // (a) settings 挂了，但 catalog 有模型 ⇒ 另一条通路把结论救回 null
  invalidateTargets()
  const ctxCatalogSaves = {
    llm: {
      listConfigurableProviders: () => [dirEntry],
      listProviders: () => [{ id: 'my', name: 'my' }],
      listModels: async () => [{ provider: 'my', id: 'c1', name: 'c1' }],
    },
    settings: {
      describe: () => {
        throw new Error('settings down')
      },
    },
    get: () => undefined,
  }
  const a = (await listTargets(ctxCatalogSaves)).providers[0]
  assert.equal(a.settingsOk, false)
  assert.equal(a.credentialAvailable, null, 'catalog 通路独立成立 ⇒ null')

  // (b) 两条通路都健康，但真的没有凭据 ⇒ 这才是「真·未配置」
  invalidateTargets()
  const { ctx: ctxBothHealthy } = makeCtx({
    directory: [dirEntry],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { models: [] } })],
    listModels: async () => [],
    credentials: { resolve: async () => undefined },
    launchEnvironment: { get: () => undefined },
  })
  const b = (await listTargets(ctxBothHealthy)).providers[0]
  assert.equal(b.settingsOk, true)
  assert.equal(b.catalogState, 'ok')
  assert.equal(b.credentialAvailable, false, '旁证齐备 + 猜的 ref 无值 ⇒ 真·未配置')

  // (c) 旁证齐备，但猜的 ref 居然真能 resolve ⇒ FIX-10 新增的 true 分支
  invalidateTargets()
  const { ctx: ctxGuessedHits } = makeCtx({
    directory: [dirEntry],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { models: [] } })],
    listModels: async () => [],
    credentials: { resolve: async (ref) => (ref === 'MY_API_KEY' ? { value: 'secret' } : undefined) },
  })
  const c = (await listTargets(ctxGuessedHits)).providers[0]
  assert.equal(c.credentialRefSource, 'guessed')
  assert.equal(c.credentialAvailable, true, '猜的 ref 真能 resolve ⇒ 有凭据')
})

// ── 21. FIX-11：两处「永不抛」漏洞 ────────────────────────────────────────

test('21) FIX-11：抛错 toString 的错误对象 / 抛错 getter 的 descriptor 都不得让 listTargets 抛异常', async () => {
  invalidateTargets()

  // (a) 被抛对象自身 toString / name / message 全抛 ⇒ 旧的 text() 会二次抛出并逃逸
  const unstringifiable = {
    toString() {
      throw new Error('toString boom')
    },
    get name() {
      throw new Error('name getter boom')
    },
    get message() {
      throw new Error('message getter boom')
    },
  }
  assert.throws(() => String(unstringifiable), '前提：该对象确实不可字符串化')

  const evilEntry = { provider: 'evil' }
  Object.defineProperty(evilEntry, 'settingsNs', {
    get() {
      throw unstringifiable
    },
  })

  // (b) descriptor 的 ns 是抛错 getter ⇒ 旧的扫描循环会整体抛出
  const evilDescriptor = {}
  Object.defineProperty(evilDescriptor, 'ns', {
    get() {
      throw new Error('ns getter boom')
    },
  })

  const { ctx } = makeCtx({
    directory: [
      evilEntry,
      { provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] },
    ],
    registered: [],
    describe: [evilDescriptor, piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: [] } })],
  })

  let result
  await assert.doesNotReject(async () => {
    result = await listTargets(ctx)
  })

  const byProvider = new Map(result.providers.map((p) => [p.provider, p]))

  // (a) 错误被安全字符串化，provider 行仍产出
  assert.match(
    byProvider.get('evil').error,
    /不可字符串化的错误对象/,
    'text() 必须兜住二次抛出的字符串化，而不是让异常逃逸',
  )

  // (b) 坏 descriptor 被跳过，好的那个仍被正常处理
  assert.equal(
    byProvider.get('my').credentialRefSource,
    'profile',
    '抛错 getter 的 descriptor 被跳过后，后续 descriptor 仍须正常解析',
  )
  assert.equal(byProvider.get('my').credentialRef, 'MY_API_KEY')
})

// ── 22. FIX-12：缓存返回值冻结 ────────────────────────────────────────────

test('22) FIX-12：缓存返回值被冻结，调用方原地修改不会污染后续命中', async () => {
  invalidateTargets()
  const { ctx } = makeCtx({
    directory: [{ provider: 'my', displayName: 'my', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my'] }],
    registered: [{ id: 'my', name: 'my' }],
    describe: [piAiDescriptor({ my: { apiKeyEnv: 'MY_API_KEY', models: THREE_MODELS } })],
  })

  const first = await listTargets(ctx)

  assert.equal(Object.isFrozen(first), true, '顶层对象')
  assert.equal(Object.isFrozen(first.providers), true, 'providers 数组')
  assert.equal(Object.isFrozen(first.providers[0]), true, 'provider 行')
  assert.equal(Object.isFrozen(first.providers[0].models), true, 'models 数组')
  assert.equal(Object.isFrozen(first.providers[0].models[0]), true, 'model 行')

  // ESM 天然严格模式 ⇒ 原地写入必须抛 TypeError
  assert.throws(() => {
    first.providers[0].displayName = 'HACKED'
  }, TypeError)
  assert.throws(() => {
    first.providers[0].models[0].id = 'HACKED'
  }, TypeError)
  assert.throws(() => {
    first.providers.push({ provider: 'HACKED' })
  }, TypeError)

  // 第二次调用命中缓存 ⇒ 同一份对象，且内容未被污染
  const second = await listTargets(ctx)
  assert.equal(second, first, '命中缓存应返回同一份冻结对象')
  assert.equal(second.providers[0].displayName, 'my')
  assert.equal(second.providers[0].models[0].id, THREE_MODELS[0].id)
  assert.equal(second.providers.length, 1)
})
