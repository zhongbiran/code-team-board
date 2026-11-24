// @ts-check
//
// Code Team 控制台：角色配置 API 的按角色分权检查。
//
// 全部跑在隔离目录里：临时插件目录 + 临时 team.json + 临时端口，
// 绝不碰真实运行态的 config/team.json、events.jsonl、lessons.json。
//
// 覆盖：
//   1. 内置角色（worker/explore/verifier）的 backend / agent 不可改 → 403 + 配置哈希不变
//   2. 未知角色 / 只读字段 → 403
//   3. 类型错误 → 422，且同一请求里的合法改动也不落盘
//   4. GET 返回 { ok, config, capabilities }，capabilities 用 describe 的形状
//   5. 核心插件缺 scripts/decision-backend.mjs 时优雅降级，不崩
//
// 用法：node checks/role-config.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'miniapp', 'node', 'server.mjs');

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log('  ok   ' + name); return true; }
  failures += 1;
  console.log('FAIL   ' + name + (detail ? '  ->  ' + detail : ''));
  return false;
};

const BASE_CONFIG = {
  roles: {
    overmind: { label: 'Overmind', kind: 'decision', backend: 'codex-cli', model: 'gpt-6.2-astra', effort: 'medium', agent: null, skills: ['superpowers:brainstorming'], note: '总脑' },
    coder: { label: 'Coder', kind: 'decision', backend: 'codex-cli', model: 'gpt-6.2-sol', effort: 'medium', agent: null, skills: [], note: '代码方向' },
    worker: { label: 'Worker', kind: 'execution', backend: 'mcode-agent', model: 'minimax/MiniMax-M3.1-Flash', effort: null, agent: 'worker', skills: [], note: '实现' },
    explore: { label: 'Explore', kind: 'execution', backend: 'mcode-agent', model: 'minimax/MiniMax-M3.1-Flash', effort: null, agent: 'explore', skills: [], note: '取证' },
    verifier: { label: 'Verifier', kind: 'verification', backend: 'mcode-agent', model: 'minimax/MiniMax-M3.1-Flash', effort: null, agent: 'verifier', skills: [], note: '验收' },
  },
  provider: { id: 'codexchatgpt', name: 'ChatGPT' },
  alerts: { overmindCallsPerSession: 2, coderCallsPerSession: 3, minCacheHitRate: 0.5, slowCallSec: 90, staleDays: 14 },
};

// 契约 1 的 describe 替身：只实现能力描述，不发请求。
const STUB_DESCRIBE = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = fileURLToPath(new URL('./describe-calls.json', import.meta.url));

export function describe(role, roleConfig, localContext) {
  // 记录收到的 localContext（不落 env，避免把环境变量写进临时文件）
  const calls = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : [];
  calls.push({
    role,
    backend: roleConfig.backend,
    hasConfig: !!localContext?.config,
    roleKeys: Object.keys(localContext?.config?.roles ?? {}),
    hasProvider: !!localContext?.config?.provider,
  });
  writeFileSync(LOG, JSON.stringify(calls, null, 2));
  if (roleConfig.backend === 'external-command') {
    return {
      id: 'external-command', resume: 'none', output: 'text',
      fields: {
        executable: { type: 'string', state: 'supported', nullable: false, required: true, default: null, values: null },
        args: { type: 'string[]', state: 'supported', nullable: true, required: false, default: [], values: null },
        model: { type: 'string', state: 'supported', nullable: true, required: false, default: null, values: null },
        effort: { type: 'string', state: 'supported', nullable: true, required: false, default: null, values: null },
      },
    };
  }
  return {
    id: 'codex-cli', resume: 'thread-id', output: 'codex-jsonl',
    fields: {
      model: { type: 'string', state: 'supported', nullable: false, required: true, default: 'gpt-6.2-astra', values: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
      effort: { type: 'string', state: 'supported', nullable: false, required: true, default: 'medium', values: ['low', 'medium', 'high'] },
    },
  };
}
`;

const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 在隔离的插件目录里起一个控制台服务进程。 */
async function startServer(pluginDir) {
  const port = await freePort();
  const runner = join(pluginDir, 'runner.mjs');
  await writeFile(runner, [
    "import { start } from " + JSON.stringify(pathToFileURL(SERVER).href) + ";",
    'const controller = new AbortController();',
    'await start({ pluginRoot: ' + JSON.stringify(ROOT) + ', listen: { host: "127.0.0.1", port: ' + port + ' }, signal: controller.signal });',
    'process.stdout.write("READY\\n");',
    '',
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [runner], {
    env: { ...process.env, CODE_TEAM_PLUGIN_DIR: pluginDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + stderr)), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('服务退出 ' + code + ': ' + stderr)); });
  });
  return { port, stop: () => child.kill() };
}

async function api(port, method, body) {
  const res = await fetch('http://127.0.0.1:' + port + '/api/config', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

const paths = (res) => (res.body?.error?.fields ?? []).map((f) => f.path);
const codes = (res) => (res.body?.error?.fields ?? []).map((f) => f.code);

async function makePluginDir(prefix, { withStub }) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, 'config'), { recursive: true });
  await writeFile(join(dir, 'config', 'team.json'), JSON.stringify(BASE_CONFIG, null, 2) + '\n', 'utf8');
  if (withStub) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'decision-backend.mjs'), STUB_DESCRIBE, 'utf8');
  }
  return { dir, team: join(dir, 'config', 'team.json') };
}

// ── 场景 A：核心插件缺少 scripts/decision-backend.mjs（降级） ──────────
async function scenarioDegraded() {
  console.log('场景 A：核心插件缺少 scripts/decision-backend.mjs');
  const { dir, team } = await makePluginDir('ct-role-config-a-', { withStub: false });
  const app = await startServer(dir);
  try {
    const hash0 = await sha(team);

    const get = await api(app.port, 'GET');
    ok('GET 返回 { ok, config, capabilities }',
      get.status === 200 && get.body?.ok === true && !!get.body?.config && !!get.body?.capabilities,
      'status=' + get.status + ' body=' + JSON.stringify(get.body).slice(0, 160));
    ok('capabilities 公布执行角色的 model/effort 字段',
      get.body?.capabilities?.roles?.worker?.backends?.['mcode-agent']?.fields?.model?.state === 'supported'
      && get.body?.capabilities?.roles?.worker?.backends?.['mcode-agent']?.fields?.effort?.state === 'supported',
      JSON.stringify(get.body?.capabilities?.roles?.worker));
    ok('capabilities 公布决策角色的后端选项',
      (get.body?.capabilities?.roles?.overmind?.backendOptions ?? []).some((o) => o.id === 'codex-cli'),
      JSON.stringify(get.body?.capabilities?.roles?.overmind?.backendOptions));
    ok('缺后端能力时给出可操作的错误状态',
      get.body?.capabilities?.ok === false
      && typeof get.body?.capabilities?.message === 'string' && get.body.capabilities.message.length > 0
      && !!get.body?.capabilities?.nextStep?.text,
      JSON.stringify(get.body?.capabilities?.message));

    // 目标症状：直接 POST 改内置角色的 backend。
    const forbidden = await api(app.port, 'POST', { roles: { worker: { backend: 'codex-cli' } } });
    ok('越权改内置角色的 backend 被拒（403）',
      forbidden.status === 403 && forbidden.body?.error?.code === 'FORBIDDEN_FIELD',
      'status=' + forbidden.status + ' body=' + JSON.stringify(forbidden.body));
    ok('403 给出字段名 roles.worker.backend', paths(forbidden).includes('roles.worker.backend'),
      JSON.stringify(paths(forbidden)));
    ok('拒绝后配置文件哈希不变', (await sha(team)) === hash0);

    const mixed = await api(app.port, 'POST', { roles: { overmind: { model: 'gpt-6.2-astra' }, worker: { agent: 'verifier' } } });
    ok('混合请求里的越权字段导致整次拒绝（403）', mixed.status === 403 && mixed.body?.error?.code === 'FORBIDDEN_FIELD',
      'status=' + mixed.status + ' body=' + JSON.stringify(mixed.body));
    ok('错误路径含 roles.worker.agent', paths(mixed).includes('roles.worker.agent'), JSON.stringify(paths(mixed)));
    ok('混合请求拒绝后配置文件哈希不变', (await sha(team)) === hash0);

    const unknownRole = await api(app.port, 'POST', { roles: { nosuch: { model: 'x' } } });
    ok('未知角色 403', unknownRole.status === 403 && paths(unknownRole).includes('roles.nosuch'),
      'status=' + unknownRole.status + ' body=' + JSON.stringify(unknownRole.body));

    const readonly = await api(app.port, 'POST', { roles: { worker: { label: '改名' } } });
    ok('只读字段不可改（403）', readonly.status === 403 && paths(readonly).includes('roles.worker.label'),
      'status=' + readonly.status + ' body=' + JSON.stringify(readonly.body));

    const writable = await api(app.port, 'POST', { roles: { worker: { model: 'minimax/MiniMax-M3' } } });
    ok('内置角色可改 model（200）', writable.status === 200 && writable.body?.ok === true,
      'status=' + writable.status + ' body=' + JSON.stringify(writable.body));
    const afterWritable = JSON.parse(await readFile(team, 'utf8'));
    ok('改动写回 team.json', afterWritable.roles.worker.model === 'minimax/MiniMax-M3',
      JSON.stringify(afterWritable.roles.worker));

    const hash1 = await sha(team);
    const atomic = await api(app.port, 'POST', { roles: { explore: { model: 'minimax/MiniMax-M3' }, verifier: { model: 123 } } });
    ok('类型错误 → 422 INVALID_CONFIG',
      atomic.status === 422 && atomic.body?.error?.code === 'INVALID_CONFIG'
      && codes(atomic).includes('INVALID_TYPE'),
      'status=' + atomic.status + ' body=' + JSON.stringify(atomic.body));
    ok('同一请求里的合法改动也不落盘', (await sha(team)) === hash1);

    const unknownValue = await api(app.port, 'POST', { roles: { overmind: { model: 'gpt-6.2-sol' } } });
    ok('缺后端能力时改决策角色参数 → 422 CAPABILITY_UNKNOWN',
      unknownValue.status === 422 && codes(unknownValue).includes('CAPABILITY_UNKNOWN'),
      'status=' + unknownValue.status + ' body=' + JSON.stringify(unknownValue.body));
    ok('拒绝后配置文件哈希不变', (await sha(team)) === hash1);

    const alerts = await api(app.port, 'POST', { alerts: { slowCallSec: 120 } });
    ok('alerts 入口保留', alerts.status === 200
      && JSON.parse(await readFile(team, 'utf8')).alerts.slowCallSec === 120,
      'status=' + alerts.status + ' body=' + JSON.stringify(alerts.body));

    const badBody = await fetch('http://127.0.0.1:' + app.port + '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    ok('非法 JSON → 400 INVALID_BODY', badBody.status === 400, 'status=' + badBody.status);

    // 旧客户端把每个角色的 backend/model/effort/agent 原样回传：没改的值不该算越权。
    const currentCfg = JSON.parse(await readFile(team, 'utf8'));
    const legacyPayload = { roles: {} };
    for (const [role, r] of Object.entries(currentCfg.roles)) {
      legacyPayload.roles[role] = r.backend === 'codex-cli'
        ? { backend: r.backend, model: r.model ?? '', effort: r.effort ?? '' }
        : { backend: r.backend, model: r.model ?? '', agent: r.agent ?? '' };
    }
    const hashLegacy = await sha(team);
    const legacy = await api(app.port, 'POST', legacyPayload);
    ok('旧客户端原样回传只读值仍可保存', legacy.status === 200 && legacy.body?.ok === true,
      'status=' + legacy.status + ' body=' + JSON.stringify(legacy.body).slice(0, 200));
    ok('旧客户端保存后配置内容不变', (await sha(team)) === hashLegacy);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 场景 B：后端能力由 describe 提供 ──────────────────────────────
async function scenarioWithDescribe() {
  console.log('场景 B：后端能力来自核心插件的 describe');
  const { dir, team } = await makePluginDir('ct-role-config-b-', { withStub: true });
  const app = await startServer(dir);
  try {
    const get = await api(app.port, 'GET');
    const described = get.body?.capabilities?.roles?.overmind?.backends?.['codex-cli'];
    ok('capabilities 用 describe 的字段形状（模型候选来自 describe）',
      Array.isArray(described?.fields?.model?.values) && described.fields.model.values.join(',') === 'gpt-6.2-astra,gpt-6.2-sol',
      JSON.stringify(described?.fields?.model));
    ok('后端可用时 capabilities.ok 为 true', get.body?.capabilities?.ok === true,
      JSON.stringify(get.body?.capabilities?.message));

    // 契约：describe 的 localContext 必须带完整的 team.json（P2 的 preflight 靠 cfg.provider.id 判 provider）。
    const calls = JSON.parse(await readFile(join(dir, 'scripts', 'describe-calls.json'), 'utf8'));
    const ROLE_KEYS = ['overmind', 'coder', 'worker', 'explore', 'verifier'];
    ok('describe 收到的 localContext 含完整 config（config.roles 五个角色键）',
      calls.length > 0
      && calls.every((c) => c.hasConfig && c.roleKeys.length === 5 && ROLE_KEYS.every((k) => c.roleKeys.includes(k))),
      JSON.stringify(calls));
    ok('describe 收到的 localContext 含 provider（preflight 判 provider 用）',
      calls.every((c) => c.hasProvider === true),
      JSON.stringify(calls.map((c) => c.hasProvider)));
    ok('外部命令后端也用 describe 形状',
      get.body?.capabilities?.roles?.overmind?.backends?.['external-command']?.fields?.executable?.required === true,
      JSON.stringify(get.body?.capabilities?.roles?.overmind?.backends?.['external-command']?.fields?.executable));

    const badModel = await api(app.port, 'POST', { roles: { overmind: { model: 'gpt-9' } } });
    ok('模型不在能力域 → 422 INVALID_VALUE',
      badModel.status === 422 && codes(badModel).includes('INVALID_VALUE'),
      'status=' + badModel.status + ' body=' + JSON.stringify(badModel.body));

    const badEffort = await api(app.port, 'POST', { roles: { overmind: { effort: 'ultra' } } });
    ok('档位不在能力域 → 422 INVALID_VALUE',
      badEffort.status === 422 && codes(badEffort).includes('INVALID_VALUE'),
      'status=' + badEffort.status + ' body=' + JSON.stringify(badEffort.body));

    const goodModel = await api(app.port, 'POST', { roles: { overmind: { model: 'gpt-6.2-sol' } } });
    ok('合法模型可保存', goodModel.status === 200
      && JSON.parse(await readFile(team, 'utf8')).roles.overmind.model === 'gpt-6.2-sol',
      'status=' + goodModel.status + ' body=' + JSON.stringify(goodModel.body));

    const hash0 = await sha(team);
    const atomic = await api(app.port, 'POST', { roles: { overmind: { model: 'gpt-6.2-astra' }, coder: { executable: 'tool.cmd' } } });
    ok('请求里有一处不支持 → 整次拒绝',
      atomic.status === 422 && codes(atomic).includes('UNSUPPORTED'),
      'status=' + atomic.status + ' body=' + JSON.stringify(atomic.body));
    ok('整次拒绝后配置文件哈希不变', (await sha(team)) === hash0);

    const noExecutable = await api(app.port, 'POST', { roles: { coder: { backend: 'external-command' } } });
    ok('切外部命令缺 executable → 422 REQUIRED',
      noExecutable.status === 422 && paths(noExecutable).includes('roles.coder.executable')
      && codes(noExecutable).includes('REQUIRED'),
      'status=' + noExecutable.status + ' body=' + JSON.stringify(noExecutable.body));

    const switched = await api(app.port, 'POST', { roles: { coder: { backend: 'external-command', executable: 'my-decider' } } });
    const coderNow = JSON.parse(await readFile(team, 'utf8')).roles.coder;
    ok('切外部命令成功', switched.status === 200 && coderNow.backend === 'external-command'
      && coderNow.executable === 'my-decider',
      'status=' + switched.status + ' body=' + JSON.stringify(switched.body));
    ok('切后端后清掉旧后端专属字段（model/effort 归一为 null）',
      coderNow.model === null && coderNow.effort === null,
      JSON.stringify(coderNow));

    const noPlaceholder = await api(app.port, 'POST', { roles: { coder: { model: 'x' } } });
    ok('args 无占位元素时显式提交 model → 422 UNSUPPORTED',
      noPlaceholder.status === 422 && codes(noPlaceholder).includes('UNSUPPORTED'),
      'status=' + noPlaceholder.status + ' body=' + JSON.stringify(noPlaceholder.body));

    const withPlaceholder = await api(app.port, 'POST', { roles: { coder: { args: ['--model', '{model}'], model: 'x' } } });
    ok('args 含 {model} 占位时 model 可写',
      withPlaceholder.status === 200 && JSON.parse(await readFile(team, 'utf8')).roles.coder.model === 'x',
      'status=' + withPlaceholder.status + ' body=' + JSON.stringify(withPlaceholder.body));

    const badExe = await api(app.port, 'POST', { roles: { coder: { executable: 'tool.cmd' } } });
    ok('Windows .cmd 不在支持域 → 422 UNSUPPORTED',
      badExe.status === 422 && codes(badExe).includes('UNSUPPORTED'),
      'status=' + badExe.status + ' body=' + JSON.stringify(badExe.body));

    const badArgs = await api(app.port, 'POST', { roles: { coder: { args: [123] } } });
    ok('args 非字符串项 → 422 INVALID_TYPE',
      badArgs.status === 422 && codes(badArgs).includes('INVALID_TYPE'),
      'status=' + badArgs.status + ' body=' + JSON.stringify(badArgs.body));

    const forbiddenHere = await api(app.port, 'POST', { roles: { explore: { backend: 'codex-cli' } } });
    ok('有 describe 时内置角色的 backend 仍然 403',
      forbiddenHere.status === 403 && paths(forbiddenHere).includes('roles.explore.backend'),
      'status=' + forbiddenHere.status + ' body=' + JSON.stringify(forbiddenHere.body));

    // POST 路径（校验时用合并后的角色配置）传的 localContext 也要带 config。
    const allCalls = JSON.parse(await readFile(join(dir, 'scripts', 'describe-calls.json'), 'utf8'));
    ok('GET 与 POST 路径的每一次 describe 都收到完整 config',
      allCalls.length > 4 && allCalls.every((c) => c.hasConfig && c.roleKeys.length === 5),
      'calls=' + allCalls.length + ' ' + JSON.stringify(allCalls.map((c) => c.hasConfig)));
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 场景 C：历史决策配置里的 mcode-agent 后端 ─────────────────────
async function scenarioHistoricalBackend() {
  console.log('场景 C：历史决策配置里的 mcode-agent 后端');
  const { dir, team } = await makePluginDir('ct-role-config-c-', { withStub: true });
  const historical = JSON.parse(await readFile(team, 'utf8'));
  historical.roles.overmind.backend = 'mcode-agent';
  historical.roles.coder.backend = 'mcode-agent';
  await writeFile(team, JSON.stringify(historical, null, 2) + '\n', 'utf8');

  const app = await startServer(dir);
  try {
    const get = await api(app.port, 'GET');
    ok('GET 保留历史的 mcode-agent 值',
      get.body?.config?.roles?.overmind?.backend === 'mcode-agent'
      && get.body?.config?.roles?.coder?.backend === 'mcode-agent',
      JSON.stringify(get.body?.config?.roles?.overmind));
    const options = get.body?.capabilities?.roles?.overmind?.backendOptions ?? [];
    const legacyOption = options.find((o) => o.id === 'mcode-agent');
    ok('历史后端被标记为不可用', legacyOption?.available === false && typeof legacyOption?.reason === 'string',
      JSON.stringify(options));
    ok('支持的后端仍然可选', options.some((o) => o.id === 'codex-cli' && o.available === true),
      JSON.stringify(options));

    const switched = await api(app.port, 'POST', { roles: { overmind: { backend: 'codex-cli' } } });
    const cfg = JSON.parse(await readFile(team, 'utf8'));
    ok('可显式改选支持的后端', switched.status === 200 && cfg.roles.overmind.backend === 'codex-cli',
      'status=' + switched.status + ' body=' + JSON.stringify(switched.body).slice(0, 200));
    ok('改选后按目标后端重算调用字段', cfg.roles.overmind.model === 'gpt-6.2-astra' && cfg.roles.overmind.effort === 'medium',
      JSON.stringify(cfg.roles.overmind));
    ok('编辑其他角色不改动历史值', cfg.roles.coder.backend === 'mcode-agent',
      JSON.stringify(cfg.roles.coder));

    const params = await api(app.port, 'POST', { roles: { coder: { model: 'x' } } });
    ok('历史后端下的调用参数 → 422 UNSUPPORTED',
      params.status === 422 && codes(params).includes('UNSUPPORTED'),
      'status=' + params.status + ' body=' + JSON.stringify(params.body));
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

await scenarioDegraded();
await scenarioWithDescribe();
await scenarioHistoricalBackend();

if (failures) {
  console.log('\nFAIL role-config (' + failures + ' 项未通过)');
  process.exit(1);
}
console.log('\nPASS role-config');
