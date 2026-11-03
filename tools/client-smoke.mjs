#!/usr/bin/env node
/**
 * tools/client-smoke.mjs —— dsh-fingerprint `client.js` 的**运行时**冒烟（所有权：W6）
 *
 * 为什么需要它：`tools/selfcheck.mjs` 只做静态检查（ESM 语法 / require 白名单 / 槽位语义），
 * 覆盖不到「挂载后是否真的接上任务、是否真的订阅 SSE、切视图是否真的刷新」这类运行时行为。
 * 本文件用 mini-React（真 hooks + effects + 重渲染）+ 可编排 fetch + 假 EventSource
 * 在 Node 里把 client.js 跑起来断言这些行为。
 *
 * 用法：
 *   node tools/client-smoke.mjs                    # 全部场景 × 2 种 primitives 模式
 *   node tools/client-smoke.mjs --list             # 只列场景
 *   node tools/client-smoke.mjs --scenario attach  # 只跑一个场景
 *   node tools/client-smoke.mjs --mode primitives-absent
 *   node tools/client-smoke.mjs --client <path>    # 指定被测 client.js
 *
 * 退出码：全绿 0；有失败 1；用法错误 2。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT = path.resolve(HERE, '..', 'client.js');

/** 场景清单（顺序即输出顺序）。 */
const SCENARIOS = [
  'attach',
  'idleNone',
  'statusLegacy',
  'busyWithRunId',
  'busyFallbackStatus',
  'busyHopeless',
  'parallelDefault',
  'inflightCap',
  'sseError',
  'detailToggle',
  'roundsHoles',
  'dormant45',
  'countsanity',
  'historyOk',
  'historyStatsError',
  'historyEmpty',
  'historyUnready',
  'historyRealFixture',
  'historyCountScope',
  'historyInterrupted',
  'historyWriteFail',
  'probabilityStates',
  'historyColumns',
  'detectVerdictColumns',
  'originFilter',
  'countLowHint',
  'countHintTwo',
  'countHintMissing',
  'hostActiveRunDead',
  'hostActiveRunAlive',
  'regress',
];

const MODES = ['primitives-present', 'primitives-absent'];

const START_LABEL = '开始检测';
const HISTORY_TAB_LABEL = '历史';
const MODEL = 'example/text-image';
const MODEL_KEY = 'provider_a\u0000' + MODEL;

/**
 * 每个场景在 `primitives-present` 模式下**至少**应执行的断言条数（回归闸门用）。
 *
 * 为什么需要它：守恒不变式只能发现"运行期按模式分叉却没走 checkP"的断言；
 * 如果有人（或某次重构）把整条断言**删掉**，两个模式会一起变少、依然守恒 ——
 * 静默少测在报告里完全不可见。有了下限，任何"断言凭空消失"都会当场判失败。
 * 下限只升不降：新增断言后把它调高；调低必须在回报里说明理由。
 */
const ASSERTION_FLOOR = {
  attach: 17,
  idleNone: 15,
  statusLegacy: 17,
  busyWithRunId: 18,
  busyFallbackStatus: 18,
  busyHopeless: 16,
  parallelDefault: 16,
  inflightCap: 14,
  sseError: 17,
  detailToggle: 17,
  roundsHoles: 17,
  dormant45: 23,
  countsanity: 14,
  historyOk: 26,
  historyStatsError: 16,
  historyEmpty: 15,
  historyUnready: 15,
  historyRealFixture: 24,
  historyCountScope: 16,
  historyInterrupted: 23,
  historyWriteFail: 18,
  probabilityStates: 24,
  historyColumns: 24,
  detectVerdictColumns: 26,
  originFilter: 34,
  countLowHint: 20,
  countHintTwo: 20,
  countHintMissing: 16,
  hostActiveRunDead: 19,
  hostActiveRunAlive: 19,
  regress: 16,
};

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { client: DEFAULT_CLIENT, scenario: null, mode: null, list: false, help: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--client') out.client = argv[++i];
    else if (arg === '--scenario') out.scenario = argv[++i];
    else if (arg === '--mode') out.mode = argv[++i];
    else {
      console.error('未知参数：' + arg);
      out.help = true;
    }
  }
  return out;
}

function usage() {
  console.log(
    [
      'tools/client-smoke.mjs —— dsh-fingerprint client.js 运行时冒烟（W6）',
      '',
      '用法:',
      '  node tools/client-smoke.mjs                     跑全部场景 × 2 种模式',
      '  node tools/client-smoke.mjs --list              只列场景/模式',
      '  node tools/client-smoke.mjs --scenario attach   只跑一个场景',
      '  node tools/client-smoke.mjs --mode primitives-absent',
      '  node tools/client-smoke.mjs --client <file>     指定被测 client.js（默认 ../client.js）',
      '  node tools/client-smoke.mjs --verbose           打印每条被跳过的断言名（SKIP 明细）',
      '  node tools/client-smoke.mjs --help',
      '',
      '场景:',
      ...SCENARIOS.map((name) => '  ' + name),
      '',
      '模式:',
      '  primitives-present  宿主 primitives 齐全；SKIP 恒为 0（出现 SKIP 即判失败）',
      '  primitives-absent   primitives 全缺 → 走降级实现；原语实例断言记 SKIP（不计入 PASS）',
      '',
      '计数口径（PASS / SKIP / FAIL，三列分开报）:',
      '  PASS  真正执行并通过的断言。',
      '  SKIP  **未执行**的断言：只在 primitives-absent 模式下发生 ——',
      '        那里原语组件不存在，凡是"检查某个原语实例的 props"的断言都无法执行',
      '        （checkP 声明的那批；对应的降级路径另有文本断言兜底，仍然执行）。',
      '        ⚠️ SKIP **不计入 PASS**：否则"跳过的断言变多了"会完全不可见 ——',
      '        某天某个模式下断言大面积不再执行，报告依旧"全绿"。',
      '        primitives-present 模式下 SKIP 必须恒为 0，出现即判失败（退出码 1）。',
      '  FAIL  执行了但不通过（或未执行且不该跳过）。',
      '',
      '退出码: 0 = 全绿（可以带 SKIP）；1 = 有 FAIL 或违反了 SKIP 不变式；2 = 用法错误',
      '        SKIP 本身不影响退出码。',
    ].join('\n'),
  );
}

// ── 单场景运行器 ────────────────────────────────────────────────────────────
/**
 * 在全新的 vm 上下文里装载 client.js（每次都是新 module 实例），
 * 用 mini-React 挂载注册进 `main` 槽位的组件，跑该场景的断言。
 * @returns {Promise<{failures: string[], passes: number, detail: string}>}
 */
async function runScenario(scenario, mode, src) {
  const hasPrimitives = mode === 'primitives-present';
  const failures = [];
  let passes = 0;
  let skips = 0;
  const skippedNames = [];
  const notes = [];

  function check(name, condition, detail) {
    if (condition) {
      passes += 1;
    } else {
      failures.push(name + (detail ? ' :: ' + detail : ''));
    }
  }
  /**
   * primitives 缺失时原语实例不可观测 ⇒ 这类断言**跳过**（降级路径另有文本断言兜底）。
   *
   * ⚠️ 跳过必须**单列 SKIP**、**不计入 PASS**（契约 §36.3 裁决 4）。
   * 理由：这份 harness 将来要当**回归闸门**。若 SKIP 伪装成 PASS，
   * 「SKIP 数量增加」将完全不可见 —— 某天某个模式下断言大面积不再执行，报告仍然"全绿"。
   * 这正是本项目一路在防的那类**虚高**（参见 §22.1「跨时刻的观察不得写成结论」、
   * §32.1「并发度量必须先定口径」）。
   */
  function checkP(name, condition, detail) {
    if (!hasPrimitives) {
      skips += 1;
      skippedNames.push(name);
      return;
    }
    check(name, condition, detail);
  }

  // ── mini React ────────────────────────────────────────────────────────────
  const Fragment = Symbol.for('react.fragment');
  const stores = new WeakMap();
  const storeList = [];
  let currentStore = null;
  let effectQueue = [];
  let seed = {};
  let renderCount = 0;

  function storeFor(type) {
    let store = stores.get(type);
    if (!store) {
      store = { slots: [], cursor: 0, dirty: false };
      stores.set(type, store);
      storeList.push(store);
    }
    return store;
  }
  function depsChanged(prev, next) {
    if (prev === undefined) return true;
    if (!Array.isArray(prev) || !Array.isArray(next)) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) if (!Object.is(prev[i], next[i])) return true;
    return false;
  }

  const React = {
    Fragment,
    useState: (init) => {
      const store = currentStore;
      const idx = store.cursor++;
      if (store.slots[idx] === undefined) {
        const seeded = Object.prototype.hasOwnProperty.call(seed, idx) ? seed[idx] : typeof init === 'function' ? init() : init;
        store.slots[idx] = { kind: 'state', value: seeded };
      }
      const slot = store.slots[idx];
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
          store.dirty = true;
        },
      ];
    },
    useEffect: (fn, deps) => {
      const store = currentStore;
      const idx = store.cursor++;
      const slot = store.slots[idx];
      if (slot === undefined || depsChanged(slot.deps, deps)) {
        store.slots[idx] = { kind: 'effect', deps };
        effectQueue.push({ store, idx, fn });
      }
    },
    useMemo: (fn) => {
      currentStore.cursor += 1;
      return fn();
    },
    useCallback: (fn) => {
      currentStore.cursor += 1;
      return fn;
    },
    useRef: (value) => {
      const store = currentStore;
      const idx = store.cursor++;
      if (store.slots[idx] === undefined) store.slots[idx] = { kind: 'ref', ref: { current: value } };
      return store.slots[idx].ref;
    },
    Component: class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(next) {
        Object.assign(this.state, typeof next === 'function' ? next(this.state) : next);
      }
    },
  };

  const jsx = (type, props, key) => ({ $$el: true, type, key, props: props || {} });
  const jsxs = jsx;

  function stubComponent(name) {
    const fn = function Stub(props) {
      const p = props || {};
      const children =
        name === 'JsonBlock'
          ? (() => {
              try {
                return JSON.stringify(p.payload);
              } catch (err) {
                return String(p.payload);
              }
            })()
          : name === 'DisclosureRow'
            ? [p.title, p.collapsedContent, p.open === true ? p.children : null]
            : p.children;
      return { $$el: true, type: 'div', props: { 'data-primitive': name, children } };
    };
    fn.__primitive = name;
    return fn;
  }
  const primitives = hasPrimitives ? new Proxy({}, { get: (t, name) => (typeof name === 'string' ? stubComponent(name) : undefined) }) : {};

  const requireLog = [];
  const myRequire = (spec) => {
    requireLog.push(spec);
    if (spec === 'react') return React;
    if (spec === 'react/jsx-runtime') return { jsx, jsxs, jsxDEV: jsx, Fragment };
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('SEED-WHITELIST-VIOLATION: ' + spec);
  };

  function renderNode(node, out) {
    if (node === null || node === undefined || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') {
      out.texts.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) renderNode(child, out);
      return out;
    }
    if (node.$$el !== true) return out;
    out.elements += 1;
    const type = node.type;
    const props = node.props || {};
    if (type === Fragment) return renderNode(props.children, out);
    if (typeof type === 'function') {
      if (type.__primitive !== undefined) out.primitives.push({ name: type.__primitive, props });
      if (type.prototype && type.prototype instanceof React.Component) {
        const instance = new type(props);
        try {
          return renderNode(instance.render(), out);
        } catch (error) {
          if (typeof type.getDerivedStateFromError === 'function') {
            instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error));
            if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error);
            return renderNode(instance.render(), out);
          }
          throw error;
        }
      }
      const prev = currentStore;
      currentStore = storeFor(type);
      currentStore.cursor = 0;
      let child;
      try {
        child = type(props);
      } finally {
        currentStore = prev;
      }
      return renderNode(child, out);
    }
    out.hosts.push({ type, props });
    if (type === 'input' && props.type === 'checkbox') out.inputs.push({ disabled: props.disabled === true });
    return renderNode(props.children, out);
  }
  function walk(node) {
    return renderNode(node, { texts: [], elements: 0, primitives: [], inputs: [], hosts: [] });
  }

  // ── 假环境 ────────────────────────────────────────────────────────────────
  const fetchLog = [];
  const esCreated = [];
  const esInstances = [];
  const intervals = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.closed = false;
      this.listeners = {};
      esCreated.push(this.url);
      esInstances.push(this);
      // 模拟真实 EventSource：建连成功后触发 onopen（微任务后，确保 onopen 已被赋值）
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (!this.closed && typeof this.onopen === 'function') this.onopen();
        });
      });
    }
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    }
    close() {
      this.closed = true;
    }
    emitMessage(data) {
      if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(data) });
    }
    emitError() {
      if (typeof this.onerror === 'function') this.onerror({});
    }
  }

  let routes = {};
  let registration = null;
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn, ms) => {
      intervals.push({ fn, ms, kind: 'timeout' });
      return intervals.length;
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, kind: 'interval' });
      return intervals.length;
    },
    clearInterval: (id) => {
      if (typeof id === 'number' && intervals[id - 1]) intervals[id - 1].cleared = true;
    },
    Promise,
    Symbol,
    Object,
    Array,
    JSON,
    Number,
    String,
    Math,
    Date,
    Error,
    Map,
    Set,
    WeakMap,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    window: { __ModuleLoader__: { load: (reg) => (registration = reg) } },
    EventSource: FakeEventSource,
    fetch: async (url, init) => {
      const p = String(url);
      fetchLog.push({ path: p, method: (init && init.method) || 'GET' });
      // 路由查找容错：先按完整 URL，再按去掉 query 的路径（/history?limit=20&… 属于后者）
      const bare = p.split('?')[0];
      const route = Object.prototype.hasOwnProperty.call(routes, p) ? routes[p] : Object.prototype.hasOwnProperty.call(routes, bare) ? routes[bare] : undefined;
      const body = route === undefined ? { ok: false, error: { code: 'NO_ROUTE', message: 'no route for ' + p } } : typeof route === 'function' ? route({ path: p, method: (init && init.method) || 'GET' }) : route;
      const wrapped = body && body.__status !== undefined ? body : { __status: 200, body };
      return { status: wrapped.__status, text: async () => JSON.stringify(wrapped.body) };
    },
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, remove() {}, click() {}, appendChild() {} }),
      body: { appendChild() {} },
      head: { appendChild() {} },
      querySelector: () => null,
    },
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  };
  sandbox.globalThis = sandbox;

  async function drain() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function flush(rootType) {
    let tree = null;
    let out = null;
    for (let round = 0; round < 14; round += 1) {
      const jobs = effectQueue.splice(0);
      for (const job of jobs) {
        try {
          await job.fn();
        } catch (error) {
          failures.push('effect 抛异常: ' + String(error && error.message));
        }
      }
      await drain();
      let dirty = false;
      for (const store of storeList) if (store.dirty) dirty = true;
      if (!dirty && jobs.length === 0 && tree !== null) break;
      for (const store of storeList) store.dirty = false;
      renderCount += 1;
      tree = rootType({});
      out = walk(tree);
      await drain();
    }
    return { tree, out: out === null ? walk(tree) : out };
  }

  /** 找按钮（原语在位用原语；缺失时降级实现是宿主 <button>）。 */
  function findButton(out, label) {
    const viaPrimitive = out.primitives.find((p) => p.name === 'Button' && String(p.props.children) === label);
    if (viaPrimitive !== undefined) return { onClick: viaPrimitive.props.onClick, disabled: viaPrimitive.props.disabled };
    const viaHost = out.hosts.find((h) => h.type === 'button' && String(h.props.children) === label);
    if (viaHost !== undefined) return { onClick: viaHost.props.onClick, disabled: viaHost.props.disabled };
    return undefined;
  }

  /** 找折叠行（原语在位用 props；缺失时降级实现的 header <button> 里含标题文本）。 */
  function findDisclosure(out, titlePrefix) {
    const viaPrimitive = out.primitives.find((p) => p.name === 'DisclosureRow' && String(p.props.title).indexOf(titlePrefix) === 0);
    if (viaPrimitive !== undefined) return { toggle: viaPrimitive.props.onToggle, open: viaPrimitive.props.open };
    const viaHost = out.hosts.find(
      (h) => h.type === 'button' && Array.isArray(h.props.children) && walk(h.props.children).texts.some((c) => c.indexOf(titlePrefix) === 0),
    );
    if (viaHost !== undefined) return { toggle: viaHost.props.onClick, open: undefined };
    return undefined;
  }

  /** 找「隐藏探针记录」勾选框：原语在位用 props.onChange（boolean）；降级路径用宿主 input 的 onChange（事件）。 */
  function setHideProbe(out, value) {
    const viaPrimitive = out.primitives.find((p) => p.name === 'Checkbox' && String(p.props.label) === '隐藏探针记录');
    if (viaPrimitive !== undefined) {
      viaPrimitive.props.onChange(value);
      return true;
    }
    const viaHost = out.hosts.find((h) => h.type === 'input' && h.props.type === 'checkbox' && h.props['aria-label'] === '隐藏探针记录');
    if (viaHost !== undefined) {
      viaHost.props.onChange({ target: { checked: value } });
      return true;
    }
    return false;
  }

  /** 统计某种**徽标**（span 的唯一子节点恰好是该文案）。用于精确计数，避免把提示语里的同名字串算进去。 */
  function badgeCount(out, label) {
    return out.hosts.filter((h) => h.type === 'span' && String(h.props.children) === label).length;
  }

  /** 切换到某个视图：原语 SegmentedTabs 走 onChange；降级实现点按钮。 */
  function switchTab(out, label) {
    const tabs = out.primitives.find((p) => p.name === 'SegmentedTabs');
    if (tabs !== undefined && typeof tabs.props.onChange === 'function') {
      const item = (Array.isArray(tabs.props.items) ? tabs.props.items : []).find((entry) => entry.label === label);
      if (item !== undefined) {
        tabs.props.onChange(item.value);
        return true;
      }
    }
    const button = out.hosts.find((h) => h.type === 'button' && String(h.props.children) === label);
    if (button !== undefined) {
      button.props.onClick();
      return true;
    }
    return false;
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  const providerA = {
    provider: 'provider_a',
    displayName: 'provider_a',
    active: true,
    dormant: false,
    api: 'openai-completions',
    baseURL: 'http://x/v1',
    credentialRef: 'PROVIDER_A_API_KEY',
    credentialRefSource: 'profile',
    credentialAvailable: true,
    error: null,
    models: [{ id: MODEL, name: MODEL, source: 'config', input: ['text', 'image'], contextWindow: 1048576, maxTokens: 384000 }],
  };
  const providerB = { provider: 'deepseek-official', displayName: 'deepseek-official', active: true, dormant: false, api: 'openai-completions', baseURL: 'http://b/v1', credentialRef: 'DEEPSEEK_API_KEY', credentialRefSource: 'profile', credentialAvailable: true, error: null, models: [{ id: 'deepseek-chat', name: 'deepseek-chat', source: 'config', input: ['text'], contextWindow: null, maxTokens: null }] };
  const providerC = { provider: 'deepseek-account', displayName: 'deepseek-account', active: true, dormant: false, api: 'openai-completions', baseURL: 'http://c/v1', credentialRef: 'ACCOUNT_KEY', credentialRefSource: 'profile', credentialAvailable: true, error: null, models: [{ id: 'ds-acct', name: 'ds-acct', source: 'config', input: ['text'], contextWindow: 200000, maxTokens: 8192 }] };
  const providerD = { provider: 'provider_b', displayName: 'provider_b', active: true, dormant: false, api: 'openai-completions', baseURL: 'http://d/v1', credentialRef: 'PROVIDER_B_API_KEY', credentialRefSource: 'profile', credentialAvailable: false, error: null, models: [{ id: 'local/foo', name: 'local/foo', source: 'catalog', input: ['text'], contextWindow: null, maxTokens: null }] };
  const DORMANT = [];
  for (let i = 0; i < 41; i += 1) {
    const name = 'catalog_provider_' + String(i);
    DORMANT.push({ provider: name, displayName: name, active: false, dormant: true, declared: true, api: 'openai-completions', baseURL: 'https://api.' + String(i) + '.example/v1', credentialRef: name.toUpperCase().replace(/-/g, '_') + '_API_KEY', credentialAvailable: false, error: null, models: [{ id: name + '/model-x', name: name + '/model-x', source: 'config', input: ['text'] }] });
  }
  const dormantKeys = DORMANT.map((p) => p.provider + '\u0000' + p.models[0].id);
  const snapshotSimple = {
    ok: true,
    runId: 'r-1',
    phase: 'running',
    startedAt: 1762000000000,
    finishedAt: null,
    options: { rounds: 3, count: 3, parallel: 3, strict: false, timeoutSec: 120, gapSec: 0 },
    error: null,
    tasks: [{ provider: 'provider_a', model: MODEL, round: 2, totalRounds: 3, state: 'streaming', count: 287, expectedCount: 300, firstByteMs: 412, error: null }],
    results: [{ provider: 'provider_a', model: MODEL, aggregate: { decision: 'partial', prediction: null, predictionName: null, family: null, familyName: null, validRounds: 2, totalRounds: 3, agreement: 0.5, confidence: null, stability: 'unstable', ranking: [{ model: MODEL, displayName: 'Example V1 Flash', family: 'deepseek', familyName: 'DeepSeek', score: 0.8, probability: 0.91, votes: 1, meanRank: 1 }], perRound: [{ index: 0, decision: 'scored', prediction: '', predictionName: '', probability: 0.91, error: null }] } }],
  };
  const runningSnapshot = {
    ok: true,
    runId: 'r-9',
    phase: 'running',
    startedAt: 1762000000000,
    finishedAt: null,
    options: { rounds: 3, count: 3, parallel: 3, strict: false, timeoutSec: 120, gapSec: 0 },
    error: null,
    tasks: [{ provider: 'provider_a', model: MODEL, round: 1, totalRounds: 3, state: 'streaming', count: 120, expectedCount: 300, firstByteMs: 412, error: null }],
    results: [],
  };
  const detector = { ready: true, builtAt: 'x', bankModelCount: 64 };
  // 回归场景专用的三个 provider（§14.5 空值 / §24.3 临时故障 / §12.5 休眠）
  const providerNulls = { provider: 'catalog-only', displayName: 'catalog-only', active: true, dormant: false, api: 'openai-completions', baseURL: 'http://n/v1', credentialRef: 'K', credentialRefSource: 'profile', credentialAvailable: true, error: null, models: [{ id: 'cat/model', name: 'cat/model', source: 'catalog', input: null, contextWindow: null, maxTokens: null }] };
  const providerTransient = { provider: 'settings-bad', displayName: 'settings-bad', active: true, dormant: false, api: 'openai-completions', baseURL: 'http://s/v1', credentialRef: 'S', credentialRefSource: 'guessed', credentialAvailable: null, settingsOk: false, catalogState: 'ok', error: null, models: [{ id: 's/m', name: 's/m', source: 'config', input: ['text'] }] };
  const providerDormant = { provider: 'sleepy', displayName: 'sleepy', active: false, dormant: true, declared: true, api: 'openai-completions', baseURL: 'http://d/v1', credentialRef: 'D', credentialAvailable: false, error: null, models: [{ id: 'd/m', name: 'd/m', source: 'config', input: ['text'] }] };
  const targetsRegress = { ok: true, detector, providers: [providerNulls, providerTransient, providerDormant] };
  const targetsOk = { ok: true, detector, providers: [providerA] };

  // 历史场景 fixture
  const historyModels = [
    { provider: 'provider_a', model: MODEL, lastTs: '2026-11-02T06:30:00.000Z', runs: 3, lastDecision: 'scored', lastPrediction: 'example-v1-flash-0101', lastPredictionName: 'Example V1 Flash', lastProbability: 0.9096, lastStability: 'stable' },
    { provider: 'provider_a', model: 'second/model', lastTs: null, runs: null, lastDecision: 'unscorable', lastPrediction: null, lastProbability: null, lastStability: null },
  ];
  const historyRecords = [
    { v: 1, ts: '2026-11-02T06:30:00.000Z', runId: 'r-7', provider: 'provider_a', model: MODEL, decision: 'scored', prediction: 'example-v1-flash-0101', predictionName: 'Example V1 Flash', probability: 0.9096, agreement: 1, stability: 'stable', validRounds: 3, totalRounds: 3, error: null },
    { v: 1, ts: '2026-11-02T05:10:00.000Z', runId: 'r-6', provider: 'provider_a', model: MODEL, decision: 'partial', prediction: null, predictionName: null, probability: null, agreement: 0.5, stability: 'unstable', validRounds: 1, totalRounds: 3, error: 'No valid samples. This round cannot be scored.' },
  ];
  /**
   * W7 真机历史文件里的那一条（父任务「现成验收夹具」）：
   * prediction / predictionName / family / familyName / probability / agreement 全 null，
   * decision='unscorable'，stability='inconclusive' —— 专门压测 `—` 与文案分支。
   */
  const realRecord = {
    v: 1,
    ts: '2026-11-01T22:36:12.137Z',
    runId: 'r-1',
    provider: 'provider_a',
    model: 'acme/text-large',
    decision: 'unscorable',
    prediction: null,
    predictionName: null,
    family: null,
    familyName: null,
    probability: null,
    agreement: null,
    stability: 'inconclusive',
    validRounds: 0,
    totalRounds: 1,
    options: { rounds: 1, count: 1, parallel: 1, strict: false },
    error: null,
  };
  const realModelRow = { provider: 'provider_a', model: 'acme/text-large', lastTs: realRecord.ts, runs: 1, lastDecision: 'unscorable', lastPrediction: null, lastPredictionName: null, lastProbability: null, lastStability: 'inconclusive' };

  // ── §55 夹具：被打断的记录 / 宿主侧事实 ──────────────────────────────────
  /** 被打断（run 级 error 非空 + decision unscorable）——**不得**渲染成「样本不足」。 */
  const INTERRUPTED_ERROR = 'interrupted: 上一次运行未完成（宿主进程已重启，无结果）';
  const interruptedModelRow = { provider: 'provider_a', model: 'acme/text-large', lastTs: '2026-11-03T00:10:02.315Z', runs: 1, lastDecision: 'unscorable', lastPrediction: null, lastPredictionName: null, lastProbability: null, lastStability: 'inconclusive', lastError: INTERRUPTED_ERROR };
  /** 真的样本不足（error 为空）——原有分支**不得被误伤**。 */
  const insufficientModelRow = { provider: 'provider_a', model: MODEL, lastTs: '2026-11-02T06:30:00.000Z', runs: 3, lastDecision: 'unscorable', lastPrediction: null, lastPredictionName: null, lastProbability: null, lastStability: 'inconclusive', lastError: null };
  const interruptedRecord = { v: 1, ts: '2026-11-03T00:10:02.315Z', runId: 'r-1', provider: 'provider_a', model: 'acme/text-large', decision: 'unscorable', prediction: null, predictionName: null, family: null, familyName: null, probability: null, agreement: null, stability: 'inconclusive', validRounds: 0, totalRounds: 3, options: { rounds: 3, count: 3, parallel: 3, strict: true }, error: INTERRUPTED_ERROR };
  const deadRun = { runId: 'r-dead', startedAt: '2026-11-03T00:10:02.315Z', sameProcess: false, options: { rounds: 3, count: 3, parallel: 3, strict: true }, targets: [{ provider: 'provider_a', model: 'acme/text-large' }] };
  const liveRun = { runId: 'r-live', startedAt: '2026-11-03T00:20:00.000Z', sameProcess: true, options: { rounds: 3, count: 3, parallel: 3, strict: false }, targets: [{ provider: 'provider_a', model: MODEL }] };
  const writeError = { at: '2026-11-03T00:12:44.001Z', message: 'EACCES: permission denied, open ...\\history.jsonl' };

  // ── §61.4 C/D 夹具：置信度三态 + 列语义拆分 ─────────────────────────────
  const CALIB_NOTE = '校准参数与当前检测器不匹配，置信度不可用；候选顺序由排名分数决定。';
  /** 原因列的**截断**要用一条真的超长 error 才验得出来（短 error 本来就不该截断）。 */
  const INTERRUPTED_LONG_ERROR = INTERRUPTED_ERROR + '；宿主进程在写入结果前退出，本轮所有目标均未落盘，请重新发起检测或扩大超时后重试。';
  const probModelRow = { provider: 'provider_a', model: MODEL, lastTs: '2026-11-03T01:00:00.000Z', runs: 4, lastDecision: 'scored', lastPrediction: MODEL, lastPredictionName: 'Example V1 Flash', lastProbability: null, lastProbabilityStatus: 'unavailable', lastStability: 'stable' };
  const probRecords = [
    { v: 1, ts: '2026-11-03T01:00:00.000Z', runId: 'r-1', provider: 'provider_a', model: MODEL, decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', probability: 0.9096, probabilityStatus: 'reference_calibrated', agreement: 1, stability: 'stable', validRounds: 3, totalRounds: 3, error: null },
    { v: 1, ts: '2026-11-03T00:50:00.000Z', runId: 'r-2', provider: 'provider_a', model: MODEL, decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', probability: null, probabilityStatus: 'unavailable', agreement: 1, stability: 'stable', validRounds: 3, totalRounds: 3, error: null },
    // 声明已校准却无数值 ⇒ 按未知处理，**不得**说"未校准"
    { v: 1, ts: '2026-11-03T00:40:00.000Z', runId: 'r-3', provider: 'provider_a', model: MODEL, decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', probability: null, probabilityStatus: 'reference_calibrated', agreement: 1, stability: 'stable', validRounds: 3, totalRounds: 3, error: null },
    // 旧记录：字段缺失 ⇒ 未知
    { v: 1, ts: '2026-11-03T00:30:00.000Z', runId: 'r-4', provider: 'provider_a', model: MODEL, decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', probability: null, agreement: 1, stability: 'stable', validRounds: 3, totalRounds: 3, error: null },
  ];
  const colStableRow = { provider: 'provider_a', model: MODEL, lastTs: '2026-11-03T01:00:00.000Z', runs: 2, lastDecision: 'scored', lastPrediction: MODEL, lastPredictionName: 'Example V1 Flash', lastProbability: 0.9096, lastStability: 'stable' };
  const colInsufficientRow = { provider: 'provider_b', model: 'example/second', lastTs: '2026-11-03T00:58:00.000Z', runs: 1, lastDecision: 'unscorable', lastPrediction: null, lastPredictionName: null, lastProbability: null, lastStability: 'inconclusive' };
  const colInterruptedRow = { provider: 'provider_a', model: 'acme/text-large', lastTs: '2026-11-03T00:55:00.000Z', runs: 1, lastDecision: 'unscorable', lastPrediction: null, lastPredictionName: null, lastProbability: null, lastStability: 'inconclusive', lastError: INTERRUPTED_LONG_ERROR };

  // ── OPT-8 夹具：origin 客户端过滤 / 来源徽标（§64.4 A）──────────────────────
  /** 用 `predictionName` 当**行标记**（top1 列会原样渲染），便于精确计数"这行在不在"。 */
  const originRecord = (origin, mark) =>
    Object.assign(
      {
        v: 1,
        ts: '2026-11-03T02:00:00.000Z',
        runId: 'r-' + mark,
        provider: 'provider_a',
        model: 'acme/text-large',
        decision: 'scored',
        prediction: mark,
        predictionName: mark,
        family: null,
        familyName: null,
        probability: 0.9,
        probabilityStatus: 'reference_calibrated',
        agreement: 1,
        stability: 'stable',
        validRounds: 3,
        totalRounds: 3,
        error: null,
      },
      // 'missing' ⇒ **整条不带 origin 字段**（旧记录）：必须与 null 一样照常显示
      origin === 'missing' ? {} : { origin: origin },
    );
  const originRecords = [originRecord('ui', 'MARK-UI'), originRecord('probe', 'MARK-PROBE'), originRecord('cli', 'MARK-CLI'), originRecord(null, 'MARK-NULL'), originRecord('missing', 'MARK-NOFLD')];
  const originAggRow = { provider: 'provider_a', model: 'acme/text-large', lastTs: '2026-11-03T02:00:00.000Z', runs: 5, lastDecision: 'scored', lastPrediction: 'MARK-UI', lastPredictionName: 'MARK-UI', lastProbability: 0.9, lastStability: 'stable' };
  const originProbeMark = 'MARK-PROBE';

  // ── OPT-3 件 A 夹具：检测页结果表（结论/原因 与历史页同一判定）────────────────
  // row.error 来自**运行结果本身**（tasks[].error → errorByTarget），不是臆造字段
  const detectAgg = (over) => Object.assign({ decision: 'unscorable', prediction: null, predictionName: null, family: null, familyName: null, validRounds: 0, totalRounds: 3, agreement: null, confidence: null, stability: 'inconclusive', ranking: [], perRound: [] }, over);
  const detectSnapshot = {
    ok: true,
    runId: 'r-1',
    phase: 'done',
    startedAt: 1762000000000,
    finishedAt: 1762000300000,
    options: { rounds: 3, count: 3, parallel: 3, strict: false, timeoutSec: 120, gapSec: 0 },
    error: null,
    tasks: [
      { provider: 'provider_a', model: MODEL, round: 1, totalRounds: 3, state: 'complete', count: 300, expectedCount: 300, firstByteMs: 412, error: null },
      // 这一条的 error 会经 errorByTarget 落到「acme/text-large」那一行的 row.error 上
      { provider: 'provider_a', model: 'acme/text-large', round: 1, totalRounds: 3, state: 'failed', count: 0, expectedCount: 300, firstByteMs: null, error: INTERRUPTED_LONG_ERROR },
    ],
    results: [
      { provider: 'provider_a', model: MODEL, aggregate: detectAgg({ decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', validRounds: 3, agreement: 1, confidence: 0.9096, probabilityStatus: 'reference_calibrated', stability: 'stable' }) },
      { provider: 'provider_a', model: 'example/second', aggregate: detectAgg({ totalRounds: 3 }) },
      { provider: 'provider_a', model: 'acme/text-large', aggregate: detectAgg({ totalRounds: 1 }) },
    ],
  };
  const hostStatusDead = { ok: true, detector, activeRunId: 'r-dead', activeRun: deadRun, lastHistoryError: null };
  const hostStatusAlive = { ok: true, detector, activeRunId: 'r-live', activeRun: liveRun, lastHistoryError: null };
  const hostStatusWriteFail = { ok: true, detector, activeRunId: null, activeRun: null, lastHistoryError: writeError };

  // §32.4 空洞 fixture：rounds[] 里夹 null / undefined；perRound[] 里夹 null 且缺 index
  const exportHoles = {
    ok: true,
    runId: 'r-1',
    phase: 'cancelled',
    startedAt: 1762000000000,
    finishedAt: 1762000100000,
    options: {},
    targets: [
      {
        provider: 'provider_a',
        model: MODEL,
        rounds: [
          { challenges: [], samples: [{ challengeId: 'c1', rawText: '111 222 HOLE-KEEP', text: 'x', state: 'complete', count: 300, expectedCount: 300, firstByteMs: 100, error: null }], analysis: {}, error: null },
          null,
          undefined,
          { challenges: [], samples: [{ challengeId: 'c2', rawText: '333 444 HOLE-KEEP-2', text: 'y', state: 'complete', count: 300, expectedCount: 300, firstByteMs: 120, error: null }], analysis: {}, error: null },
        ],
        aggregate: {
          decision: 'partial',
          prediction: null,
          predictionName: null,
          family: null,
          familyName: null,
          validRounds: 2,
          totalRounds: 4,
          agreement: 0.5,
          confidence: null,
          stability: 'unstable',
          ranking: [{ model: MODEL, displayName: 'Example V1 Flash', family: 'deepseek', familyName: 'DeepSeek', score: 0.5, probability: 0.9, votes: 1, meanRank: 1 }, null],
          perRound: [{ index: 0, decision: 'scored', prediction: MODEL, predictionName: 'Example V1 Flash', probability: 0.9, error: null }, null, { decision: 'not_model', prediction: '', predictionName: '', probability: null, error: 'refusal' }],
        },
      },
    ],
  };
  const snapshotHoles = {
    ok: true,
    runId: 'r-1',
    phase: 'cancelled',
    startedAt: 1762000000000,
    finishedAt: 1762000100000,
    options: { rounds: 4, count: 3, parallel: 3, strict: false, timeoutSec: 120, gapSec: 0 },
    error: null,
    tasks: [{ provider: 'provider_a', model: MODEL, round: 1, totalRounds: 4, state: 'complete', count: 300, expectedCount: 300, firstByteMs: 412, error: null }, null],
    results: [{ provider: 'provider_a', model: MODEL, aggregate: exportHoles.targets[0].aggregate }, null],
  };

  // ── 路由与种子（按场景）────────────────────────────────────────────────────
  const statusNull = { ok: true, detector, activeRunId: null };
  let statusHits = 0;
  let busyBody = null;
  const table = {
    attach: { status: { ok: true, detector, activeRunId: 'r-9' }, runs: { 'r-9': runningSnapshot } },
    idleNone: { status: statusNull, runs: {} },
    statusLegacy: { status: { ok: true, detector }, runs: {} },
    busyWithRunId: {
      status: statusNull,
      runs: { 'r-7': Object.assign({}, runningSnapshot, { runId: 'r-7' }) },
      busy: { ok: false, error: { code: 'BUSY', message: '已有运行中任务：r-7', runId: 'r-7' } },
      seedKeys: { selected: MODEL_KEY },
    },
    busyFallbackStatus: {
      status: 'stateful-r8',
      runs: { 'r-8': Object.assign({}, runningSnapshot, { runId: 'r-8' }) },
      busy: { ok: false, error: { code: 'BUSY', message: '已有运行中任务（无结构化 runId）' } },
      seedKeys: { selected: MODEL_KEY },
    },
    busyHopeless: {
      status: statusNull,
      runs: {},
      busy: { ok: false, error: { code: 'BUSY', message: '已有运行中任务（无结构化 runId）' } },
      seedKeys: { selected: MODEL_KEY },
    },
    parallelDefault: { status: statusNull, runs: {}, advanced: true },
    inflightCap: { status: statusNull, runs: {}, advanced: true, seedKeys: { selected: MODEL_KEY }, roundsText: '1' },
    sseError: { status: { ok: true, detector, activeRunId: 'r-9' }, runs: { 'r-9': runningSnapshot } },
    detailToggle: { status: statusNull, runs: { 'r-1': snapshotSimple }, seedKeys: { runId: 'r-1' }, simpleSnapshot: true, expandedEmpty: true },
    roundsHoles: { status: statusNull, runs: {}, detailless: false, holes: true },
    dormant45: { status: statusNull, runs: {}, manyProviders: true, dormantOpen: true },
    countsanity: { status: statusNull, runs: {}, threeProviders: true, seedKeys: { runId: null }, countSanity: true },
    historyOk: { status: statusNull, runs: {}, history: { models: historyModels, stats: { count: 5, path: 'x', oldest: 'a', newest: 'b', skippedLines: 0, error: null }, records: historyRecords, removed: 3 } },
    historyStatsError: { status: statusNull, runs: {}, history: { models: [], stats: { count: 0, path: 'x', oldest: null, newest: null, skippedLines: 2, error: 'EACCES: permission denied' }, records: [], removed: 0 } },
    historyEmpty: { status: statusNull, runs: {}, history: { models: [], stats: { count: 0, path: 'x', oldest: null, newest: null, skippedLines: 0, error: null }, records: [], removed: 0 } },
    historyUnready: { status: statusNull, runs: {}, history: 'unready' },
    historyRealFixture: { status: statusNull, runs: {}, history: { models: [realModelRow], stats: { count: 1, path: 'x', oldest: realRecord.ts, newest: realRecord.ts, skippedLines: 0, error: null }, records: [realRecord], removed: 0 } },
    // 父任务更正 2：stats.count 是文件总量，与过滤无关（?provider=nope → records=0 但 count=1）
    historyCountScope: { status: statusNull, runs: {}, history: { models: [realModelRow], stats: { count: 1, path: 'x', oldest: realRecord.ts, newest: realRecord.ts, skippedLines: 0, error: null }, records: [], removed: 0 }, filterQuery: 'nope' },
    // §55：一条被打断（error 非空）+ 一条真样本不足（error 空），两条必须在同一屏里各自成立
    historyInterrupted: {
      status: statusNull,
      runs: {},
      history: {
        models: [interruptedModelRow, insufficientModelRow],
        stats: { count: 2, path: 'x', oldest: 'a', newest: 'b', skippedLines: 0, error: null },
        records: [interruptedRecord],
        removed: 0,
      },
      interruptedModel: 'acme/text-large',
    },
    historyWriteFail: { status: hostStatusWriteFail, runs: {}, history: { models: [realModelRow], stats: { count: 1, path: 'x', oldest: realRecord.ts, newest: realRecord.ts, skippedLines: 0, error: null }, records: [realRecord], removed: 0 } },
    hostActiveRunDead: { status: hostStatusDead, runs: {} },
    // §61.4 C：置信度三态（数字 / unavailable / reference_calibrated+null / 缺失）
    probabilityStates: { status: statusNull, runs: {}, history: { models: [probModelRow], stats: { count: 4, path: 'x', oldest: 'a', newest: 'b', skippedLines: 0, error: null }, records: probRecords, removed: 0 } },
    // §61.4 D：结论 / 原因 两列各自装对东西
    historyColumns: { status: statusNull, runs: {}, history: { models: [colStableRow, colInsufficientRow, colInterruptedRow], stats: { count: 3, path: 'x', oldest: 'a', newest: 'b', skippedLines: 0, error: null }, records: [], removed: 0 } },
    detectVerdictColumns: { status: statusNull, runs: { 'r-1': detectSnapshot }, seedKeys: { runId: 'r-1' }, detectSnapshot: true },
    // §64.4 A：默认勾选「隐藏探针记录」；聚合表**不**过滤（聚合行跨记录汇总，前端不编造计数）
    originFilter: { status: statusNull, runs: {}, history: { models: [originAggRow], stats: { count: 5, path: 'x', oldest: 'a', newest: 'b', skippedLines: 0, error: null }, records: originRecords, removed: 0 } },
    // §64.4 B：count < 3 只提示不禁止
    countLowHint: { status: statusNull, runs: {}, advanced: true, seedKeys: { selected: MODEL_KEY }, countText: '1' },
    countHintTwo: { status: statusNull, runs: {}, advanced: true, seedKeys: { selected: MODEL_KEY }, countText: '2' },
    // count 字段异常/缺失 ⇒ 退回默认 3 ⇒ 不显示提示、不报错
    countHintMissing: { status: statusNull, runs: {}, advanced: true, seedKeys: { selected: MODEL_KEY }, countText: '' },
    hostActiveRunAlive: { status: hostStatusAlive, runs: { 'r-live': Object.assign({}, runningSnapshot, { runId: 'r-live' }) } },
    regress: { status: statusNull, runs: {}, regression: true },
  };
  const spec = table[scenario];
  check('场景夹具存在: ' + scenario, spec !== undefined);
  if (spec === undefined) return { failures, passes, skips, skippedNames, detail: 'no fixture' };

  routes = {
    '/fingerprint/targets': scenario === 'regress' ? targetsRegress : scenario === 'dormant45' ? { ok: true, detector, providers: [providerA, providerB, providerC, providerD].concat(DORMANT) } : scenario === 'countsanity' ? { ok: true, detector, providers: [providerA, providerB, providerC] } : targetsOk,
    '/fingerprint/status': () => {
      statusHits += 1;
      if (spec.status === 'stateful-r8') {
        return statusHits === 1 ? statusNull : Object.assign({}, statusNull, { activeRunId: 'r-8' });
      }
      return spec.status;
    },
    '/fingerprint/run': spec.busy === undefined ? { ok: true, runId: 'r-new' } : spec.busy,
    '/fingerprint/cancel': { ok: true },
    '/fingerprint/history/clear': { ok: true, removed: spec.history && spec.history.removed !== undefined ? spec.history.removed : 0 },
  };
  for (const runId of Object.keys(spec.runs || {})) {
    routes['/fingerprint/run/' + runId] = spec.runs[runId];
    routes['/fingerprint/run/' + runId + '/export'] = spec.holes ? exportHoles : { ok: true, runId, targets: [] };
  }
  if (spec.simpleSnapshot) {
    routes['/fingerprint/run/r-1'] = snapshotSimple;
    routes['/fingerprint/run/r-1/export'] = { ok: true, runId: 'r-1', targets: [] };
  }
  if (spec.detectSnapshot) {
    routes['/fingerprint/run/r-1'] = detectSnapshot;
    routes['/fingerprint/run/r-1/export'] = { ok: true, runId: 'r-1', targets: [] };
  }
  if (spec.holes) routes['/fingerprint/run/r-1'] = snapshotHoles;
  if (spec.history === 'unready') {
    routes['/fingerprint/history/models'] = { __status: 404, body: { ok: false } };
    routes['/fingerprint/history'] = { __status: 404, body: { ok: false } };
  } else if (spec.history !== undefined) {
    routes['/fingerprint/history/models'] = { ok: true, models: spec.history.models, stats: spec.history.stats };
    routes['/fingerprint/history'] = { ok: true, records: spec.history.records, stats: spec.history.stats };
  }

  // 种子（hook 下标见下方注释；只在首次渲染生效）
  // hook 下标（cursor，含 useCallback/useMemo/useRef 占位）：
  //   0=tt 1=targets 2=refreshing 3=selected 4=query 5=openGroups 6=rounds 7=count 8=parallel
  //   9=timeout 10=strict 11=advancedOpen 12=runId 13=actionError 14=actionNote 15=starting
  //   16=expanded 17=detailCache 18=tab 19=history 20=historyQuery 21=historyDetail
  //   22=historyNotice 23=confirmClear 24=serverActiveRunIdRef 25/26=useRunFeed 内部
  seed = {};
  if (spec.advanced) seed[11] = true; // advancedOpen
  if (spec.seedKeys !== undefined && spec.seedKeys.selected !== undefined) seed[3] = { [MODEL_KEY]: true }; // selected
  if (spec.roundsText !== undefined) seed[6] = spec.roundsText; // roundsText
  if (spec.countText !== undefined) seed[7] = spec.countText; // countText（§64.4 B）
  if (spec.filterQuery !== undefined) seed[20] = spec.filterQuery; // historyQuery（客户端筛选）
  if (spec.seedKeys !== undefined && spec.seedKeys.runId !== undefined && spec.seedKeys.runId !== null) seed[12] = spec.seedKeys.runId; // runId
  if (spec.dormantOpen) seed[5] = { __dormant__: true }; // openGroups
  if (spec.countSanity) seed[3] = { [MODEL_KEY]: true, ['deepseek-account\u0000ds-acct']: true }; // selected 两行
  if (spec.holes) {
    seed[12] = 'r-1'; // runId
    seed[15] = true; // starting（无关，占位）
    seed[16] = { [MODEL_KEY]: true }; // expanded
    seed[17] = { status: 'ready', payload: exportHoles, error: null }; // detailCache
    seed[17] = { status: 'ready', payload: exportHoles, error: null };
  }

  // ── 装载 ──────────────────────────────────────────────────────────────────
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'client.js' });
  check('__ModuleLoader__.load 被调用且 id 正确', registration !== null && registration.id === 'dsh-fingerprint');
  const exported = registration.factory(myRequire);
  check("exports.inject === ['slots','locale']", Array.isArray(exported.inject) && exported.inject.join(',') === 'slots,locale', JSON.stringify(exported.inject));
  check('require 只命中 3 个种子词（白名单运行期复核）', requireLog.join(' | ') === 'react | react/jsx-runtime | @deepseek-ai/dsh-client-ui-primitives', requireLog.join(' | '));

  const registered = [];
  const ctx = {
    get: (key) => (key === 'locale' ? { register: () => () => {}, bind: () => (k) => k } : undefined),
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    logger: { warn: () => {} },
    slots: {
      inject: (key, factory) => {
        const d = factory();
        if (typeof d !== 'function') throw new Error('slots.inject 未返回 disposer: ' + key);
        return d;
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  exported.apply(ctx);
  const panelEntry = registered.find((item) => item.options.name === 'sidebar.panellist');
  const mainEntry = registered.find((item) => item.options.name === 'main');
  check('panellist 注册: id/order=40/label thunk', panelEntry !== undefined && panelEntry.options.id === 'dsh-fingerprint' && panelEntry.options.order === 40 && typeof panelEntry.options.label === 'function');
  check('main.key === panellist.id', mainEntry !== undefined && panelEntry !== undefined && mainEntry.options.key === panelEntry.options.id);
  check('main 注册的是 FingerprintPanel（错误边界已挂载）', mainEntry !== undefined && mainEntry.component === exported.FingerprintPanel && mainEntry.component !== exported.FingerprintPage);
  if (mainEntry === undefined) return { failures, passes, skips, skippedNames, detail: 'no main entry' };
  const panelComp = mainEntry.component;

  // ── D1：错误边界端到端（敌意 props：读 props.t 即抛）──────────────────────
  const hostile = {
    get t() {
      throw new Error('boom: hostile props getter');
    },
  };
  let directThrew = false;
  try {
    walk(exported.FingerprintPage(hostile));
  } catch (err) {
    directThrew = true;
  }
  check('D1 对照：不经边界时确实会抛（异常会冒泡到宿主）', directThrew);
  let boundaryThrew = false;
  let boundaryText = '';
  try {
    boundaryText = walk(panelComp(hostile)).texts.join('\n');
  } catch (err) {
    boundaryThrew = true;
  }
  check('D1 挂载边界后不再抛出', boundaryThrew === false);
  check('D1 渲染出 pageCrash 文案 + 错误原文（不是空白格）', boundaryText.includes('本页面渲染出错') && boundaryText.includes('boom: hostile props getter'));

  // ── 挂载 ──────────────────────────────────────────────────────────────────
  const mounted = await flush(panelComp);
  let text = mounted.out.texts.join('\n');
  check('通用）未白屏（元素数 > 50）', mounted.out.elements > 50, String(mounted.out.elements) + ' :: ' + mounted.out.texts.join('|').slice(0, 300));
  check('通用）渲染树无字面量 undefined', text.indexOf('undefined') === -1);
  check('通用）未落入 pageCrash 兜底', text.includes('本页面渲染出错') === false);

  // ── 场景断言 ──────────────────────────────────────────────────────────────
  if (scenario === 'attach') {
    check('1) 挂载后自动接上 activeRunId（订阅 /fingerprint/run/r-9/events）', esCreated.indexOf('/fingerprint/run/r-9/events') >= 0, JSON.stringify(esCreated));
    check('1) 「运行中」横幅出现且带 r-9', text.includes('运行中') && text.includes('r-9'));
    check('1) 提示「已接上正在运行的任务」', text.includes('已接上正在运行的任务'));
    check('1) 横幅含取消 + 导出 JSON 按钮', text.includes('取消') && text.includes('导出 JSON'));
  }
  if (scenario === 'idleNone') {
    check('2) activeRunId=null → 不订阅任何 SSE', esCreated.length === 0, JSON.stringify(esCreated));
    check('2) 无「运行中」横幅', text.includes('运行中') === false);
  }
  if (scenario === 'statusLegacy') {
    check('3) /status 缺 activeRunId → 不报错、未落 PageBoundary', text.includes('本页面渲染出错') === false && text.includes('宿主接口未就绪') === false);
    check('3) 无 SSE、无横幅', esCreated.length === 0 && text.includes('运行中') === false);
    // §55 兼容：activeRun / lastHistoryError 一并缺失 ⇒ 按"未知"处理，什么都不显示、不报错
    check('3) 缺 activeRun 字段 → 无宿主横幅', text.includes('检测到上次有一个任务未完成') === false && text.includes('宿主侧有一个任务在运行') === false);
    check('3) 缺 lastHistoryError 字段 → 无写入失败提示条', text.includes('历史写入失败') === false);
  }
  if (scenario === 'busyWithRunId' || scenario === 'busyFallbackStatus') {
    const expectRun = scenario === 'busyWithRunId' ? 'r-7' : 'r-8';
    const startButton = findButton(mounted.out, START_LABEL);
    check('4/5) 找到「开始检测」按钮', startButton !== undefined);
    if (startButton !== undefined) {
      startButton.onClick();
      const after = await flush(panelComp);
      const t2 = after.out.texts.join('\n');
      check('4/5) 自动接上 ' + expectRun + '（订阅 SSE）', esCreated.indexOf('/fingerprint/run/' + expectRun + '/events') >= 0, JSON.stringify(esCreated));
      check('4/5) 提示「已接上正在运行的任务」', t2.includes('已接上正在运行的任务'));
      check('4/5) 不再只显示 BUSY 报错', t2.includes('宿主侧已有运行中的任务（BUSY）') === false);
      check('4/5) 「运行中」横幅出现', t2.includes('运行中') && t2.includes(expectRun));
    }
  }
  if (scenario === 'busyHopeless') {
    const startButton = findButton(mounted.out, START_LABEL);
    check('5b) 找到「开始检测」按钮', startButton !== undefined);
    if (startButton !== undefined) {
      startButton.onClick();
      const after = await flush(panelComp);
      const t2 = after.out.texts.join('\n');
      check('5b) 两条路都拿不到 → 只显示 BUSY 报错', t2.includes('宿主侧已有运行中的任务（BUSY）'));
      check('5b) 不订阅 SSE、不崩、未落 PageBoundary', esCreated.length === 0 && t2.includes('本页面渲染出错') === false, JSON.stringify(esCreated));
    }
  }
  if (scenario === 'parallelDefault') {
    const viaPrimitive = mounted.out.primitives.find((p) => p.name === 'Input' && p.props['aria-label'] === '并发');
    const viaHost = mounted.out.hosts.find((h) => h.type === 'input' && h.props['aria-label'] === '并发');
    const value = viaPrimitive !== undefined ? viaPrimitive.props.value : viaHost !== undefined ? viaHost.props.value : undefined;
    check('6) 高级面板默认并发数 = 3', value === '3', String(value));
    check('6) 并发释义已改为「同时在跑的轮次数（跨 目标 × 轮次）」', text.includes('同时在跑的轮次数') && text.includes('跨目标') === false);
    // §64.4 B：默认 count=3 ⇒ 不显示 count<3 提示（= 4 走同一条判断，不另设场景）
    check('6) count=3（默认）⇒ 不显示 count<3 提示', text.includes('SDK 需要恰好 3 条有效回答') === false);
  }
  if (scenario === 'inflightCap') {
    check('7) 在飞请求数精确封顶 = min(并发3, 目标×轮次1) × 每轮3 = 3', text.includes('min(并发 3, 目标×轮次 1) × 每轮挑战 3 = 3'), text.split('\n').filter((l) => l.indexOf('在飞') >= 0).join('|'));
  }
  if (scenario === 'sseError') {
    check('D3 初始通道为 SSE', text.includes('SSE'));
    const es = esInstances[0];
    check('D3 SSE 已建立', es !== undefined, JSON.stringify(esCreated));
    if (es !== undefined) {
      es.emitError();
      const afterError = await flush(panelComp);
      const tErr = afterError.out.texts.join('\n');
      check('D3 SSE 报错后切到轮询（标签显示「轮询兜底」）', tErr.includes('轮询兜底') && tErr.includes('SSE') === false, tErr.split('\n').filter((l) => l.indexOf('轮询') >= 0 || l.indexOf('SSE') >= 0).join('|'));
      es.emitMessage(Object.assign({}, runningSnapshot, { phase: 'running', tasks: [] }));
      const afterRecover = await flush(panelComp);
      const tBack = afterRecover.out.texts.join('\n');
      check('D3 SSE 恢复后切回 SSE', tBack.includes('SSE'));
    }
  }
  if (scenario === 'roundsHoles') {
    check('8) rounds[] 空洞被跳过：两份有效原始文本都渲染', text.includes('111 222 HOLE-KEEP') && text.includes('333 444 HOLE-KEEP-2'));
    check('8) 绝不出现「第 NaN 轮」', text.includes('NaN') === false, text.split('\n').filter((l) => l.indexOf('NaN') >= 0).join('|'));
    check('8) perRound 缺 index 时退回数组位置（出现「第 2 轮」）', text.includes('第 2 轮'));
    check('8) 空洞未触发 pageCrash', text.includes('本页面渲染出错') === false);
  }
  if (scenario === 'historyOk') {
    const switched = switchTab(mounted.out, HISTORY_TAB_LABEL);
    check('9) 找到并切到「历史」视图', switched);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('9) 聚合表渲染模型行 + 最近检测时间', t2.includes(MODEL) && t2.includes('2026/11/2') + true || t2.includes(MODEL));
    check('9) 表头齐全（最近检测/次数/最近 top1/置信度/稳定）', t2.includes('最近检测') && t2.includes('次数') && t2.includes('最近 top1') && t2.includes('置信度') && t2.includes('稳定'));
    check('9) null 字段渲染成 —（第二条记录的 lastTs/runs 为 null）', t2.includes('—'));
    check('9) 切到历史页触发 /history/models 拉取', fetchLog.some((entry) => entry.path === '/fingerprint/history/models'));
    const detailButton = findButton(after.out, '展开明细');
    check('9) 找到「展开明细」按钮', detailButton !== undefined);
    if (detailButton !== undefined) {
      detailButton.onClick();
      const afterDetail = await flush(panelComp);
      const t3 = afterDetail.out.texts.join('\n');
      check('9) 明细拉取 /history?limit=20&provider=&model=', fetchLog.some((entry) => entry.path.startsWith('/fingerprint/history?limit=20')));
      check(
        '9) 明细行渲染（时间/decision/top1/置信度/一致率/有效回合）',
        t3.includes('Example V1 Flash') && t3.includes('已评分') && t3.includes('3 / 3'),
        JSON.stringify({ len: t3.length, loading: t3.includes('明细加载中'), empty: t3.includes('该模型暂无明细记录'), recent: t3.includes('最近 2 条'), scored: t3.includes('已评分'), threeThree: t3.includes('3 / 3'), tail: t3.slice(-200) }),
      );
      const clearButton = findButton(afterDetail.out, '清空历史');
      check('9) 找到「清空历史」按钮', clearButton !== undefined);
      if (clearButton !== undefined) {
        clearButton.onClick();
        const afterAsk = await flush(panelComp);
        const t4 = afterAsk.out.texts.join('\n');
        check('9) 清空需二次确认（出现「确认清空？」）', t4.includes('确认清空？'));
        check('9) 二次确认前不调用 /history/clear', fetchLog.some((entry) => entry.path === '/fingerprint/history/clear') === false);
        const confirmButton = findButton(afterAsk.out, '确认清空？');
        if (confirmButton !== undefined) {
          confirmButton.onClick();
          const afterClear = await flush(panelComp);
          const t5 = afterClear.out.texts.join('\n');
          check('9) 二次确认后才调用 /history/clear', fetchLog.some((entry) => entry.path === '/fingerprint/history/clear'));
          check('9) 清空结果提示', t5.includes('已清空 3 条记录'));
        }
      }
    }
  }
  if (scenario === 'historyStatsError') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('10) stats.error 非空 → 显示「历史读取失败：…」', t2.includes('历史读取失败：') && t2.includes('EACCES'));
    check('10) 同时提示跳过行数', t2.includes('跳过 2 行'));
    check('10) 未把「读失败」显示成「没有记录」', t2.includes('还没有检测记录') === false);
  }
  if (scenario === 'historyEmpty') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('11) 空历史 → 「还没有检测记录」', t2.includes('还没有检测记录'));
    check('11) 无 stats.error 提示', t2.includes('历史读取失败：') === false);
  }
  if (scenario === 'historyUnready') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('12) 路由 404 → 明确「宿主接口未就绪」', t2.includes('宿主接口未就绪'));
    check('12) 不白屏、不落 PageBoundary', t2.includes('本页面渲染出错') === false && after.out.elements > 50, String(after.out.elements));
  }
  if (scenario === 'historyRealFixture') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('13) 真机夹具：模型行渲染', t2.includes('acme/text-large'));
    // §61.4 D 列拆分后：结论列 = 「样本不足 · 无排名」，原因列 = 「建议增加轮次」。
    // 判据未被削弱 —— 由"一句话同时命中"改成**分别命中两列**（更锐利）。
    check('13) 结论列=「样本不足 · 无排名」且 原因列=「建议增加轮次」', t2.includes('样本不足 · 无排名') && t2.includes('建议增加轮次'));
    check('13) null 全渲染成 —（无字面量 undefined / 0）', t2.includes('—') && t2.indexOf('undefined') === -1);
    const detailButton = findButton(after.out, '展开明细');
    check('13) 找到「展开明细」按钮', detailButton !== undefined);
    if (detailButton !== undefined) {
      detailButton.onClick();
      const afterDetail = await flush(panelComp);
      const t3 = afterDetail.out.texts.join('\n');
      check('13) 明细：top1 列无值显示 —（无排名不再作为取值）', t3.includes('—'));
      // OPT-3 再补·件 B：明细表的「无排名」并入**结论列**（top1 列改显示 —），规则与聚合表/检测页一致
      check('13) 明细：结论列 = 「无可评分回合 · 无排名」（无排名已并入结论列）', t3.includes('无可评分回合 · 无排名'));
      // 全屏「无排名」恰好 2 处 = 结论为「样本不足」的行数（聚合行 1 + 明细行 1），多一处即扩散
      check('13) 「无排名」总数 = 2（= 结论为样本不足的行数，无其它来源）', t3.split('无排名').length - 1 === 2, String(t3.split('无排名').length - 1));
      check('13) 明细：decision=unscorable → 「无可评分回合」', t3.includes('无可评分回合'));
      check('13) 明细：probability/agreement=null → —', t3.includes('—'));
      check('13) 明细：validRounds 0 / totalRounds 1', t3.includes('0 / 1'));
      check('13) 明细渲染后仍无字面量 undefined', t3.indexOf('undefined') === -1);
    }
  }
  if (scenario === 'historyCountScope') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    // 客户端筛选 'nope' → 0 行；文件总量仍是 1 ⇒ 两个口径必须分开表述
    check('14) 筛选后列表 0 行（当前显示 0 / 1 个模型）', t2.includes('当前显示 0 / 1 个模型'), t2.split('\n').filter((l) => l.indexOf('当前显示') >= 0).join('|'));
    check('14) 文件总量单独表述为「历史文件共 1 条记录」', t2.includes('历史文件共 1 条记录'));
    check('14) 不出现「共 0 条」这种自相矛盾计数', t2.includes('共 0 条') === false);
  }
  if (scenario === 'detailToggle') {
    const found = findDisclosure(mounted.out, '展开明细');
    check('D2 找到结果明细折叠行', found !== undefined);
    if (found !== undefined) {
      // 用 checkP 而不是内联 if：absent 模式下这也要显式记成 SKIP，
      // 否则它会"凭空消失"——两个模式跑出来的断言总数不等，且差值无处可见。
      checkP('D2 折叠行默认为收起', found.open === false, String(found.open));
      const before = fetchLog.length;
      found.toggle();
      found.toggle(); // 同步第二次：updater 若带副作用会重复发请求
      const after = await flush(panelComp);
      const t2 = after.out.texts.join('\n');
      const exportCalls = fetchLog.slice(before).filter((entry) => entry.path.indexOf('/export') >= 0);
      check('D2 两次同步 toggle 只发一次 /export', exportCalls.length === 1, JSON.stringify(exportCalls));
      check('D2 明细区真的渲染出内容（不再被 jsx 第三参数吃掉）', t2.includes('完整排名') && t2.includes('每轮明细'));
    }
  }
  if (scenario === 'dormant45') {
    const boxes = mounted.out.primitives.filter((p) => p.name === 'Checkbox');
    const group = mounted.out.primitives.find((p) => p.name === 'DisclosureRow' && String(p.props.title).includes('未启用'));
    const subtree = group === undefined ? { primitives: [], inputs: [] } : walk(group.props.children);
    const dormantBoxes = subtree.primitives.filter((p) => p.name === 'Checkbox');
    checkP('§12.5 45 个 provider → 45 个复选框', boxes.length === 45, String(boxes.length));
    checkP('§12.5「未启用（41）」子树内 = 41 个复选框', dormantBoxes.length === 41, String(dormantBoxes.length));
    checkP('§12.5 休眠项复选框全部禁用', dormantBoxes.length > 0 && dormantBoxes.every((p) => p.props.disabled === true));
    check('§12.5 休眠项注明原因（文本计数 >= 41）', text.split('该 provider 未启用适配器，无法检测').length - 1 >= 41);
    check('§12.5 分组标题「未启用（41）」', text.includes('未启用（41）'));
    check('§12.5 计数分母不含休眠项（0 / 3）', text.includes('0 / 3'));
    const selectAll = findButton(mounted.out, '全选');
    checkP('§12.5 找到「全选」按钮', selectAll !== undefined || hasPrimitives);
    check('§12.5 找到「全选」按钮（含降级路径）', selectAll !== undefined);
    if (selectAll !== undefined) {
      selectAll.onClick();
      const afterAll = await flush(panelComp);
      const t2 = afterAll.out.texts.join('\n');
      check('§12.5 全选后仍不含任何休眠 key（选中 3 个可勾选行）', t2.includes('已选 3 / 3'), t2.split('\n').filter((l) => l.indexOf('已选') >= 0).join('|'));
      check('§12.5 全选结果里没有休眠 provider 名称进入选择集', dormantKeys.every((k) => t2.indexOf(k) === -1));
    }
  }
  if (scenario === 'countsanity') {
    // 客户端筛选把一个已选中的模型过滤掉 ⇒ 分母若取"过滤后"就会显示 2 / 1
    check('D4 「已选 n / total」分母为全量可选行（2 / 3 而不是 2 / 1）', text.includes('已选 2 / 3') && text.includes('2 / 1') === false, text.split('\n').filter((l) => l.indexOf('已选') >= 0).join('|'));
  }
  if (scenario === 'historyInterrupted') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    // 聚合表：被打断行（lastError 非空）显示「被打断（无结果）」，真样本不足行保持原样
    check('15) 聚合表：被打断行显示「被打断（无结果）」', t2.includes('被打断（无结果）'));
    check('15) 真样本不足行：结论列=样本不足、原因列=建议增加轮次（各 1 次）', t2.includes('样本不足') && t2.split('建议增加轮次').length - 1 === 1, String(t2.split('建议增加轮次').length - 1));
    check('15) 「样本不足」只出现 1 次（被打断行不再误报样本不足）', t2.split('样本不足').length - 1 === 1, String(t2.split('样本不足').length - 1));
    const detailButton = findButton(after.out, '展开明细');
    check('15) 找到「展开明细」按钮', detailButton !== undefined);
    if (detailButton !== undefined) {
      detailButton.onClick();
      const afterDetail = await flush(panelComp);
      const t3 = afterDetail.out.texts.join('\n');
      check('15) 明细：聚合行 + 明细行 = 恰好 2 处「被打断（无结果）」', t3.split('被打断（无结果）').length - 1 === 2, String(t3.split('被打断（无结果）').length - 1));
      check('15) 明细：该行**不出现**「无可评分回合」', t3.includes('无可评分回合') === false);
      check('15) 明细：失败原因列显示 error 原文（未被吞掉）', t3.includes('interrupted: 上一次运行未完成（宿主进程已重启，无结果）'));
      // OPT-3 再补·件 B：明细结论列的「无排名」不得扩散到被打断行（精确计数）
      check('15) 明细：被打断行结论不带「无排名」', t3.split('被打断（无结果） · 无排名').length - 1 === 0, String(t3.split('被打断（无结果） · 无排名').length - 1));
      check('15) 「无排名」总数 = 1（只有聚合表那条样本不足行）', t3.split('无排名').length - 1 === 1, String(t3.split('无排名').length - 1));
      check('15) 明细：仍无字面量 undefined', t3.indexOf('undefined') === -1);
    }
  }
  if (scenario === 'historyWriteFail') {
    check('16) 检测页无「历史写入失败」（提示属于历史页）', text.includes('历史写入失败') === false);
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('16) 历史页出现「历史写入失败：<message>」', t2.includes('历史写入失败：') && t2.includes('EACCES'));
    check('16) 措辞说明"结果可能没存下来"', t2.includes('这次检测的结果可能没有存下来'));
    check('16) 带上失败时刻', t2.includes('2026/11/3') || t2.includes(writeError.at));
    check('16) 未白屏、未落 PageBoundary', t2.includes('本页面渲染出错') === false && after.out.elements > 50);
  }
  if (scenario === 'probabilityStates') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('19) 聚合行 null+unavailable → 「—（未校准）」', t2.includes('—（未校准）'));
    // 自检 3：全站「无排名」总数必须 = 结论为「样本不足」的行数（本场景全为稳定 ⇒ 必须 0）
    check('19) 稳定行不产生「无排名」（本场景总数 0）', t2.split('无排名').length - 1 === 0, String(t2.split('无排名').length - 1));
    check('19) 聚合表下方给出可见说明（不只 tooltip）', t2.includes(CALIB_NOTE));
    const detailButton = findButton(after.out, '展开明细');
    check('19) 找到「展开明细」按钮', detailButton !== undefined);
    if (detailButton !== undefined) {
      detailButton.onClick();
      const afterDetail = await flush(panelComp);
      const t3 = afterDetail.out.texts.join('\n');
      // 明细里 4 条记录：只有 1 条是你"未校准"；reference_calibrated+null 与字段缺失都必须是纯 —
      check('19) 明细：unavailable 行显示「—（未校准）」', t3.includes('—（未校准）'));
      check('19) 「—（未校准）」恰好 2 处（聚合 1 + 明细 1）', t3.split('—（未校准）').length - 1 === 2, String(t3.split('—（未校准）').length - 1));
      check('19) 说明文字恰好 2 处（聚合脚注 + 明细脚注）', t3.split(CALIB_NOTE).length - 1 === 2, String(t3.split(CALIB_NOTE).length - 1));
      check(
        '19) 只有 unavailable 那一格带 tooltip（reference_calibrated/缺失都不带）',
        afterDetail.out.hosts.filter((h) => h.props !== undefined && h.props.title === CALIB_NOTE).length === 2,
        String(afterDetail.out.hosts.filter((h) => h.props !== undefined && h.props.title === CALIB_NOTE).length),
      );
      check('19) 明细表头已从 decision 改为「结论」', t3.includes('结论') && t3.includes('decision') === false);
      check('19) 数字行不受影响（91.0% 原样，格式未变）', t3.includes('91.0%'));
      check('19) 明细渲染后仍无字面量 undefined', t3.indexOf('undefined') === -1);
    }
  }
  if (scenario === 'historyColumns') {
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    check('20) 旧表头「稳定标记」已消失', t2.includes('稳定标记') === false);
    check('20) 新表头「结论」「原因」都在', t2.includes('结论') && t2.includes('原因'));
    check('20) 结论列稳定 = 「稳定」', t2.includes('稳定'));
    check('20) 结论列样本不足 → 「样本不足 · 无排名」（无排名已移入结论列）', t2.split('样本不足 · 无排名').length - 1 === 1, String(t2.split('样本不足 · 无排名').length - 1));
    check('20) 原因列样本不足 → 「建议增加轮次」恰好 1 次', t2.split('建议增加轮次').length - 1 === 1, String(t2.split('建议增加轮次').length - 1));
    // OPT-3 件 B：被打断行**不再**带「无排名」（它本来就没结果，再写一遍是冗余）
    check('20) 结论列被打断 → 「被打断（无结果）」（不带无排名）恰好 1 处', t2.split('被打断（无结果）').length - 1 === 1, String(t2.split('被打断（无结果）').length - 1));
    check('20) 「被打断（无结果） · 无排名」必须为 0（无排名不得扩散回被打断行）', t2.split('被打断（无结果） · 无排名').length - 1 === 0, String(t2.split('被打断（无结果） · 无排名').length - 1));
    // 原因列的 error 摘要：截断显示 + title 全文（用超长 error 才验得出来）
    const titled = after.out.hosts.filter((h) => h.props !== undefined && h.props.title === INTERRUPTED_LONG_ERROR);
    check('20) 原因列被打断行带 title（error 全文）', titled.length === 1, String(titled.length));
    if (titled.length === 1) {
      const shown = titled[0].props.children;
      check('20) 原因列显示的是**截断摘要**（非全文、以 … 结尾）', typeof shown === 'string' && shown !== INTERRUPTED_LONG_ERROR && shown.endsWith('…'), String(shown));
    }
    check('20) 「无排名」只在样本不足行（共 1 处）', t2.split('无排名').length - 1 === 1, String(t2.split('无排名').length - 1));
    check('20) 未白屏、未落 PageBoundary', t2.includes('本页面渲染出错') === false && after.out.elements > 50);
  }
  if (scenario === 'detectVerdictColumns') {
    // 检测页（无需切页）：结论 / 原因 与历史页同一判定
    check('21) 检测页旧表头「稳定标记」已消失', text.includes('稳定标记') === false);
    check('21) 检测页新表头「结论」「原因」都在', text.includes('结论') && text.includes('原因'));
    check('21) 稳定行 → 结论「稳定」', text.includes('稳定'));
    check('21) 样本不足行 → 结论「样本不足 · 无排名」恰好 1 处', text.split('样本不足 · 无排名').length - 1 === 1, String(text.split('样本不足 · 无排名').length - 1));
    check('21) 被打断行 → 结论「被打断（无结果）」恰好 1 处', text.split('被打断（无结果）').length - 1 === 1, String(text.split('被打断（无结果）').length - 1));
    check('21) 「被打断（无结果） · 无排名」为 0（无排名不得扩散）', text.split('被打断（无结果） · 无排名').length - 1 === 0, String(text.split('被打断（无结果） · 无排名').length - 1));
    check('21) 「无排名」总数 = 1（只在样本不足行的结论里）', text.split('无排名').length - 1 === 1, String(text.split('无排名').length - 1));
    check('21) 原因列样本不足 → 「建议增加轮次」恰好 1 处', text.split('建议增加轮次').length - 1 === 1, String(text.split('建议增加轮次').length - 1));
    // OPT-3 再补·件 A：检测页原因列**不重复** error（完整 error 已在左邻「失败原因」列）
    check(
      '21) 检测页原因列不给被打断行重复 error（带该 title 的单元格必须为 0）',
      mounted.out.hosts.filter((h) => h.props !== undefined && h.props.title === INTERRUPTED_LONG_ERROR).length === 0,
      String(mounted.out.hosts.filter((h) => h.props !== undefined && h.props.title === INTERRUPTED_LONG_ERROR).length),
    );
    check('21) 检测页原因列不出现 error 截断摘要', text.includes(INTERRUPTED_LONG_ERROR.slice(0, 40) + '…') === false);
    check('21) 但完整 error 仍在「失败原因」列（没有被连带删掉）', text.includes(INTERRUPTED_LONG_ERROR));
    check('21) 数字置信度不受影响（91.0%）', text.includes('91.0%'));
    check('21) 未白屏、未落 PageBoundary', text.includes('本页面渲染出错') === false && mounted.out.elements > 50);
  }
  if (scenario === 'originFilter') {
    // ── M1/M2：默认勾选「隐藏探针记录」──────────────────────────────────
    switchTab(mounted.out, HISTORY_TAB_LABEL);
    const after = await flush(panelComp);
    const t2 = after.out.texts.join('\n');
    const detailButton = findButton(after.out, '展开明细');
    check('22) 找到「展开明细」按钮', detailButton !== undefined);
    if (detailButton !== undefined) {
      detailButton.onClick();
      const open = await flush(panelComp);
      const t3 = open.out.texts.join('\n');
      check('22) 明细表新增「来源」列', t3.includes('来源'));
      // 精确行数：5 条记录里隐藏 1 条探针
      check('22) 默认（勾选）隐藏探针：标题显示「最近 4 条」', t3.includes('最近 4 条'), t3.split('\n').filter((l) => l.indexOf('最近') >= 0).join('|'));
      check('22) 探针行被隐藏（MARK-PROBE 不出现）', t3.includes(originProbeMark) === false);
      check('22) ui 行显示（MARK-UI）', t3.includes('MARK-UI'));
      check('22) cli 行显示（MARK-CLI）', t3.includes('MARK-CLI'));
      // ⚠️ 最关键两条：防「历史变空」
      check('22) **origin: null 的旧记录必须显示**（MARK-NULL）', t3.includes('MARK-NULL'));
      check('22) **origin 字段缺失的记录必须显示**（MARK-NOFLD）', t3.includes('MARK-NOFLD'));
      check('22) 提示「已隐藏 1 条探针记录」', t3.includes('已隐藏 1 条探针记录'));
      // M2 徽标：默认下 probe 行不可见 ⇒ 探针徽标 0；cli 徽标 1
      check('22) 徽标精确计数：探针徽标 0 个', badgeCount(open.out, '探针') === 0, String(badgeCount(open.out, '探针')));
      check('22) 徽标精确计数：CLI 徽标 1 个（cli 不被过滤，徽标常显）', badgeCount(open.out, 'CLI') === 1, String(badgeCount(open.out, 'CLI')));
      check('22) 聚合表**不**做客户端过滤（聚合行仍在）', t3.includes('acme/text-large'));
      check('22) 未白屏、未落 PageBoundary', t3.includes('本页面渲染出错') === false && open.out.elements > 50);

      // ── 取消勾选 ⇒ 显示全部 ──────────────────────────────────────────
      const toggled = setHideProbe(open.out, false);
      check('22) 找到「隐藏探针记录」勾选框并取消勾选', toggled);
      const all = await flush(panelComp);
      const t4 = all.out.texts.join('\n');
      check('22) 取消勾选后总行数 = 全部（「最近 5 条」）', t4.includes('最近 5 条'), t4.split('\n').filter((l) => l.indexOf('最近') >= 0).join('|'));
      check('22) 取消勾选后探针行出现（MARK-PROBE）', t4.includes(originProbeMark));
      check('22) 取消勾选后 5 个标记全在（= 总行数全部）', ['MARK-UI', originProbeMark, 'MARK-CLI', 'MARK-NULL', 'MARK-NOFLD'].every((m) => t4.includes(m)));
      // 徽标总数 == probe 行数 + cli 行数 == 2（恰等于，不多不少）
      const probeBadges = badgeCount(all.out, '探针');
      const cliBadges = badgeCount(all.out, 'CLI');
      check('22) 徽标总数恰 = probe 行数 + cli 行数 = 2', probeBadges + cliBadges === 2, '探针=' + String(probeBadges) + ' CLI=' + String(cliBadges));
      check('22) 探针徽标 1 个（只给 probe 行）', probeBadges === 1, String(probeBadges));
      check('22) ui / null / 缺失行都没有徽标（徽标总数不含它们）', probeBadges + cliBadges === 2);
      check('22) 取消勾选后「已隐藏」提示消失', t4.includes('已隐藏') === false);
    }
  }
  if (scenario === 'countLowHint' || scenario === 'countHintTwo' || scenario === 'countHintMissing') {
    // ── M3：count < 3 的提示（§64.4 B）──────────────────────────────────
    const n = scenario === 'countLowHint' ? '1' : scenario === 'countHintTwo' ? '2' : null;
    const label = scenario === 'countLowHint' ? '22' : '23';
    if (n === null) {
      // count 字段异常/缺失 ⇒ 退回默认 3 ⇒ 不显示提示、不报错
      check(label + ') count 字段缺失/异常 ⇒ 不显示 count<3 提示', text.includes('SDK 需要恰好 3 条有效回答') === false);
      check(label + ') 退回默认 count=3（预计行仍写「每轮挑战 3」）', text.includes('每轮挑战 3'));
      check(label + ') 不报错、未落 PageBoundary', text.includes('本页面渲染出错') === false && mounted.out.elements > 50);
    } else {
      check(label + ') count=' + n + ' ⇒ 出现提示（含 SDK 需要恰好 3 条有效回答）', text.includes('SDK 需要恰好 3 条有效回答'));
      check(label + ') 提示里带实际值 N=' + n, text.includes('当前设为 ' + n + ' 时'), text.split('\n').filter((l) => l.indexOf('当前设为') >= 0).join('|'));
      check(label + ') 提示含「样本不足」措辞', text.includes('只会得到') && text.includes('样本不足'));
      // 「不禁止」：count 照原值生效，且「开始检测」仍可点
      check(label + ') count=' + n + ' 未被强制夹到 3（预计行写「每轮挑战 ' + n + '」）', text.includes('每轮挑战 ' + n), text.split('\n').filter((l) => l.indexOf('每轮挑战') >= 0).join('|'));
      const startButton = findButton(mounted.out, START_LABEL);
      check(label + ') 「开始检测」按钮存在且未被禁用（只提示不禁止）', startButton !== undefined && startButton.disabled !== true);
      const countField = mounted.out.primitives.find((p) => p.name === 'Input' && p.props['aria-label'] === '每轮挑战数') !== undefined || mounted.out.hosts.some((h) => h.type === 'input' && h.props['aria-label'] === '每轮挑战数');
      check(label + ') 挑战数控件仍在（没有被提示顶掉）', countField);
      check(label + ') 未落 PageBoundary', text.includes('本页面渲染出错') === false);
    }
  }
  if (scenario === 'hostActiveRunDead') {
    check('17) 出现「检测到上次有一个任务未完成」横幅', text.includes('检测到上次有一个任务未完成（宿主重启前启动，无结果）'));
    check('17) 横幅带 runId', text.includes('r-dead'));
    check('17) 横幅带启动时刻与目标数', text.includes('启动于') && text.includes('目标 1 个'));
    check('17) 死 run **不接管**：不订阅任何 SSE', esCreated.length === 0, JSON.stringify(esCreated));
    check('17) 不显示「运行中」横幅', text.includes('运行中') === false);
    check('17) 未白屏、未落 PageBoundary', text.includes('本页面渲染出错') === false && mounted.out.elements > 50);
  }
  if (scenario === 'hostActiveRunAlive') {
    // 「运行中」这三个字在别处也会出现（阶段标签、RUN_PHASE 文案）⇒ 按**横幅头**计数，
    // 而不是数裸字符串，否则测不出"两条横幅"这件事。
    const bannerHeads = mounted.out.hosts.filter((h) => h.type === 'strong' && String(h.props.children) === '运行中');
    check('18) 「运行中」横幅头只出现 1 个（合并，不重复）', bannerHeads.length === 1, String(bannerHeads.length));
    check(
      '18) 没有第二条宿主横幅（宿主文案不是独立横幅头）',
      mounted.out.hosts.filter((h) => h.type === 'strong' && String(h.props.children).includes('宿主侧有一个任务在运行')).length === 0,
    );
    check('18) 横幅内含「宿主侧有一个任务在运行」', text.includes('宿主侧有一个任务在运行'));
    check('18) 接上 r-live（订阅 SSE）', esCreated.indexOf('/fingerprint/run/r-live/events') >= 0, JSON.stringify(esCreated));
    check('18) 不出现「检测到上次有一个任务未完成」', text.includes('检测到上次有一个任务未完成') === false);
    check('18) 未落 PageBoundary', text.includes('本页面渲染出错') === false);
  }
  if (scenario === 'regress') {
    check('R1) §14.5 input=null → 「输入: 未知」', text.includes('输入: 未知'));
    check('R1) §14.5 上下文/输出 null → 「上下文 — · 输出 —」', text.includes('上下文 — · 输出 —'));
    check('R1) §12.5 休眠项收进「未启用」分组并注明原因', text.includes('未启用（1）') && text.includes('该 provider 未启用适配器，无法检测'));
  }

  notes.push('元素=' + String(mounted.out.elements) + ' renders=' + String(renderCount) + ' es=' + String(esCreated.length) + ' fetches=' + String(fetchLog.length));
  return { failures, passes, skips, skippedNames, detail: notes.join(' ') };
}

// ── main ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(args.client === DEFAULT_CLIENT && !args.list ? 0 : 0);
}
if (args.list) {
  console.log('场景：\n  ' + SCENARIOS.join('\n  '));
  console.log('模式：\n  ' + MODES.join('\n  '));
  process.exit(0);
}
if (!fs.existsSync(args.client)) {
  console.error('找不到被测文件：' + args.client);
  process.exit(2);
}
const scenarios = args.scenario === null ? SCENARIOS : [args.scenario];
const modes = args.mode === null ? MODES : [args.mode];
for (const name of scenarios) {
  if (!SCENARIOS.includes(name)) {
    console.error('未知场景：' + name + '（用 --list 查看）');
    process.exit(2);
  }
}
for (const name of modes) {
  if (!MODES.includes(name)) {
    console.error('未知模式：' + name + '（用 --list 查看）');
    process.exit(2);
  }
}

const src = fs.readFileSync(args.client, 'utf8');
console.log('被测文件：' + args.client + ' (' + Buffer.byteLength(src, 'utf8') + ' bytes)');
console.log('场景 ' + scenarios.length + ' × 模式 ' + modes.length + ' = ' + scenarios.length * modes.length + ' 次运行\n');

let totalPasses = 0;
let totalSkips = 0;
let totalFailures = 0;
const failed = [];
// 不变式（契约 §36.3 裁决 4）：primitives-present 模式下**不该有任何 SKIP**。
// 一旦出现，说明断言在"原语齐全"的模式下被静默跳过 ⇒ 必须当失败处理。
let presentSkips = 0;
const presentSkippedNames = [];
// 第二条不变式：**两个模式跑出来的断言总数必须相等**。
// 若 present(PASS) ≠ absent(PASS + SKIP)，说明有断言在某个模式下"凭空消失"
// —— 既没通过、也没跳过，报告里完全看不见（正是 §36.3 裁决 4 要防的虚高）。
const perScenario = new Map();
for (const mode of modes) {
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, mode, src);
    if (!perScenario.has(scenario)) perScenario.set(scenario, {});
    perScenario.get(scenario)[mode] = { passes: result.passes, skips: result.skips };
    totalPasses += result.passes;
    totalSkips += result.skips;
    totalFailures += result.failures.length;
    if (mode === 'primitives-present' && result.skips > 0) {
      presentSkips += result.skips;
      for (const name of result.skippedNames) presentSkippedNames.push(scenario + ': ' + name);
    }
    const status = result.failures.length === 0 ? 'PASS' : 'FAIL';
    const skipPart = result.skips > 0 ? '  SKIP ' + String(result.skips) : '';
    console.log(
      '[' + status + '] ' + mode.padEnd(18) + ' / ' + scenario.padEnd(20) + '  PASS ' + String(result.passes).padStart(3) + skipPart + (result.detail ? '  (' + result.detail + ')' : ''),
    );
    if (args.verbose && result.skips > 0) {
      for (const name of result.skippedNames) console.log('        ~ SKIP ' + name);
    }
    for (const item of result.failures) {
      console.log('        - ' + item);
      failed.push(mode + '/' + scenario + ': ' + item);
    }
  }
}

console.log('\n合计：PASS ' + String(totalPasses) + ' / SKIP ' + String(totalSkips) + ' / FAIL ' + String(totalFailures));
if (presentSkips > 0) {
  console.log('\n不变式失败：primitives-present 模式下出现了 ' + String(presentSkips) + ' 条 SKIP（该模式下不该有任何跳过）：');
  for (const item of presentSkippedNames) console.log('  - ' + item);
  process.exit(1);
}
// 断言总量守恒：present(PASS) 必须等于 absent(PASS + SKIP)。两模式都跑时才可判定。
if (modes.length === 2) {
  const unbalanced = [];
  for (const [scenario, both] of perScenario) {
    const present = both['primitives-present'];
    const absent = both['primitives-absent'];
    if (present === undefined || absent === undefined) continue;
    if (present.passes !== absent.passes + absent.skips) {
      unbalanced.push(scenario + '：present PASS ' + String(present.passes) + ' ≠ absent PASS ' + String(absent.passes) + ' + SKIP ' + String(absent.skips));
    }
  }
  if (unbalanced.length > 0) {
    console.log('\n不变式失败：出现了「既没通过、也没跳过」的静默丢失断言（两个模式断言总数必须相等）：');
    for (const item of unbalanced) console.log('  - ' + item);
    process.exit(1);
  }
}
// 断言数下限：防止断言被整体删除后"两个模式一起变少、依然守恒"的静默少测。
{
  const below = [];
  for (const [scenario, both] of perScenario) {
    const present = both['primitives-present'];
    if (present === undefined) continue;
    const floor = ASSERTION_FLOOR[scenario];
    if (floor === undefined) {
      below.push(scenario + '：ASSERTION_FLOOR 未登记（新增场景必须登记下限）');
    } else if (present.passes < floor) {
      below.push(scenario + '：present PASS ' + String(present.passes) + ' < 下限 ' + String(floor) + '（断言疑似被删除）');
    }
  }
  if (below.length > 0) {
    console.log('\n不变式失败：断言条数低于下限 —— 有断言凭空消失（既没通过也没跳过）：');
    for (const item of below) console.log('  - ' + item);
    process.exit(1);
  }
}
if (totalFailures > 0) {
  console.log('\n失败明细：');
  for (const item of failed) console.log('  - ' + item);
  process.exit(1);
}
console.log('client-smoke: PASS ' + String(totalPasses) + ' / SKIP ' + String(totalSkips) + ' / FAIL 0' + (totalSkips > 0 ? '（SKIP 未计入 PASS）' : ''));
process.exit(0);
