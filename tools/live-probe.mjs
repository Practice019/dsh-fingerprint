#!/usr/bin/env node
/**
 * dsh-fingerprint / tools/live-probe.mjs
 *
 * 一次性**真实链路**验证脚本（契约 §11.5：离线合成数据永远得不到 `scored`，端到端必须真跑一次模型）。
 * 它只通过本机 HTTP 调运行中的 DSH 的 `/fingerprint/*`，**不 mock 任何东西**。
 *
 * 用法（DSH 桌面端在跑，端口默认 2418）：
 *   node tools/live-probe.mjs                      # status + targets + 自动挑一个可检测目标跑 1 轮
 *   node tools/live-probe.mjs --dry                # 只跑 status/targets，不发起模型调用
 *   node tools/live-probe.mjs --provider my --model loomy/DeepSeek-V4.1-Flash
 *   node tools/live-probe.mjs --rounds 1 --count 3 --timeout 240
 *   node tools/live-probe.mjs --security           # 只做访问控制自检（不开销模型）
 *
 * 退出码：0 = 链路通（拿到了 /run 的终态快照），1 = 失败/超时，2 = 用法错误。
 */

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = `http://127.0.0.1:${arg('port', '2418')}/fingerprint`;
const DRY = flag('dry');
const SECURITY_ONLY = flag('security');

/** 带 Host 头的请求（访问控制要求 Host 指向回环）。 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      host: new URL(BASE).host,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text: text.slice(0, 400) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function line(title) {
  console.log(`\n=== ${title} ===`);
}

function dump(label, value) {
  console.log(`--- ${label}`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function securityCheck() {
  line('访问控制自检（契约 §12.3）');
  const cases = [
    ['正常请求（无 Origin）', { headers: {} }],
    ['跨站 Origin', { headers: { origin: 'http://evil.example' } }],
    ['Origin: null', { headers: { origin: 'null' } }],
    ['sec-fetch-site: cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['非回环 Host', { headers: { host: 'example.com' } }],
    ['同源 Origin（localhost）', { headers: { origin: 'http://localhost:2418' } }],
  ];
  for (const [label, options] of cases) {
    try {
      const result = await api('/status', options);
      console.log(`  ${label.padEnd(28)} -> HTTP ${result.status} ${JSON.stringify(result.json?.error?.code ?? 'ok')}`);
    } catch (error) {
      console.log(`  ${label.padEnd(28)} -> ERR ${String(error.message)}`);
    }
  }
}

async function main() {
  if (SECURITY_ONLY) {
    await securityCheck();
    return 0;
  }

  line('GET /fingerprint/status');
  const status = await api('/status');
  console.log(`HTTP ${status.status}`);
  dump('detector', status.json?.detector ?? status.text);
  if (status.json?.detector?.ready !== true) {
    console.log('⚠️ detector 未就绪 —— 后续 /run 会被判 DETECTOR_UNAVAILABLE（原样返回，不粉饰）');
  }

  line('GET /fingerprint/targets');
  const targets = await api('/targets');
  console.log(`HTTP ${targets.status}`);
  if (targets.json?.ok !== true) {
    dump('失败体', targets.json ?? targets.text);
    return 1;
  }
  const providers = Array.isArray(targets.json.providers) ? targets.json.providers : [];
  const active = providers.filter((row) => row.active === true);
  const dormant = providers.filter((row) => row.active !== true);
  console.log(`providers 总数 = ${providers.length}（active ${active.length} / dormant ${dormant.length}）`);
  for (const row of active) {
    console.log(
      `  [active] ${row.provider} api=${String(row.api)} baseURL=${String(row.baseURL)} ref=${String(row.credentialRef)} key=${String(row.credentialAvailable)} models=${row.models?.length ?? 0}${row.error ? ` error=${row.error}` : ''}`,
    );
    for (const model of row.models ?? []) {
      console.log(`      - ${model.id} (${model.source}${model.contextWindow === undefined ? '' : `, ctx=${model.contextWindow}`})`);
    }
  }
  console.log(`  [dormant] ${dormant.slice(0, 6).map((row) => row.provider).join(', ')} … 共 ${dormant.length} 个`);

  // 选目标：必须在 active 且 key 可用，且模型来自 settings（source=config 的最稳）
  const requestedProvider = arg('provider');
  const requestedModel = arg('model');
  let pick = null;
  if (requestedProvider !== null && requestedModel !== null) {
    pick = { provider: requestedProvider, model: requestedModel };
  } else {
    for (const row of active) {
      if (row.credentialAvailable !== true) continue;
      const model = (row.models ?? []).find((entry) => entry.source === 'config') ?? (row.models ?? [])[0];
      if (model === undefined) continue;
      pick = { provider: row.provider, model: model.id };
      break;
    }
  }
  if (pick === null) {
    console.log('⚠️ 没有可检测目标（active 且 key 可用的 provider 都不存在）—— 不发起模型调用');
    return 1;
  }
  console.log(`\n选中目标：${pick.provider} / ${pick.model}`);
  if (DRY) {
    console.log('(--dry：不发起模型调用)');
    return 0;
  }

  line('POST /fingerprint/run（真实模型调用，会消耗额度）');
  const rounds = Number(arg('rounds', '1'));
  const count = Number(arg('count', '3'));
  const started = await api('/run', {
    method: 'POST',
    body: { targets: [pick], rounds, count, parallel: 2, strict: false, timeoutSec: Number(arg('timeout', '180')), gapSec: 0 },
  });
  console.log(`HTTP ${started.status}`);
  dump('body', started.json ?? started.text);
  if (started.json?.ok !== true) return 1;
  const runId = started.json.runId;

  line(`轮询 GET /fingerprint/run/${runId}`);
  const deadline = Date.now() + Number(arg('timeout', '180')) * 1000 + 30_000;
  let last = null;
  for (;;) {
    const poll = await api(`/run/${runId}`);
    last = poll.json;
    if (last === null || poll.status !== 200) {
      await sleep(1000);
      continue;
    }
    const states = (last.tasks ?? []).map((task) => `${task.provider}/${task.round}:${task.state}`).join(' ');
    console.log(`  phase=${String(last.phase)} ${states}`);
    if (last.phase !== 'running') break;
    if (Date.now() > deadline) {
      console.log('⚠️ 轮询超时');
      break;
    }
    await sleep(1500);
  }
  dump('最终快照', last);

  line(`GET /fingerprint/run/${runId}/export`);
  const exported = await api(`/run/${runId}/export`);
  console.log(`HTTP ${exported.status}`);
  const body = exported.json ?? {};
  for (const target of body.targets ?? []) {
    for (const round of target.rounds ?? []) {
      const analysis = round.analysis ?? {};
      console.log(`  ${target.provider}/${target.model} round: decision=${String(analysis.decision)} prediction=${JSON.stringify(analysis.prediction)}`);
      if (analysis.evidence !== undefined) console.log(`    evidence: ${String(analysis.evidence).slice(0, 200)}`);
      if (round.error !== null && round.error !== undefined) console.log(`    round.error: ${String(round.error)}`);
      for (const sample of round.samples ?? []) {
        console.log(
          `    sample ${String(sample.challengeId)}: state=${sample.state} count=${sample.count}/${sample.expectedCount} firstByteMs=${String(sample.firstByteMs)}${sample.error ? ` error=${sample.error}` : ''}`,
        );
      }
    }
    dump(`aggregate(${target.provider}/${target.model})`, target.aggregate);
  }
  console.log('\n⚠️ 提示：随机/排序整数会被 SDK 的 sequence-check 判为 not_model —— 这是正确行为（契约 §11.5）。');
  console.log('   若 decision=scored 才是「真实模型回复 + 参考库命中」的完整闭环。');
  return last?.phase === 'failed' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`live-probe 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
