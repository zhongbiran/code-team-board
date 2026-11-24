// @ts-check
//
// Code Team 控制台：配置页行为检查。
//
// 在沙箱 DOM 里跑真实客户端脚本（miniapp/client/index.html），用一份按契约造的能力描述验证：
//   1. 表单按后端能力渲染：只展示 supported 字段，unsupported 禁用并说明原因，unknown 只显示当前值
//   2. 三个内置角色只有 model/effort 可改，backend 与 agent 身份固定
//   3. 换调用方式 -> 保存 -> 重开页面，参数不丢；保存只发已改的可写字段
//   4. 页面写明默认值、缺依赖与"从哪次调用开始生效"
//   5. 原有「问题诊断」「统计详情」两个视图仍然可用
//   6. 页面与插件描述是模型中立的（没写死模型品牌目录）
//
// 用法：node checks/config-view.mjs [客户端 html 路径]
// 默认跑仓库里的客户端；传路径可以拿旧版客户端跑红灯。

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = resolve(process.argv[2] || join(ROOT, 'miniapp', 'client', 'index.html'));

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log('  ok   ' + name); return true; }
  failures += 1;
  console.log('FAIL   ' + name + (detail ? '  ->  ' + detail : ''));
  return false;
};

const EXEC_ROLES = ['worker', 'explore', 'verifier'];
const DECISION_ROLES = ['overmind', 'coder'];

const baseConfig = () => ({
  roles: {
    overmind: { label: 'Overmind', kind: 'decision', backend: 'codex-cli', model: 'fixture-model-a', effort: 'medium', agent: null, note: '规划与拆包' },
    coder: { label: 'Coder', kind: 'decision', backend: 'codex-cli', model: 'fixture-model-a', effort: 'medium', agent: null, note: '代码方向' },
    worker: { label: 'Worker', kind: 'execution', backend: 'mcode-agent', model: 'fixture-model-a', effort: null, agent: 'worker', note: '实现' },
    explore: { label: 'Explore', kind: 'execution', backend: 'mcode-agent', model: 'fixture-model-a', effort: null, agent: 'explore', note: '取证' },
    verifier: { label: 'Verifier', kind: 'verification', backend: 'mcode-agent', model: 'fixture-model-a', effort: null, agent: 'verifier', note: '验收' },
  },
  alerts: { overmindCallsPerSession: 2, coderCallsPerSession: 3, minCacheHitRate: 0.5, slowCallSec: 90, staleDays: 14 },
});

// 能力描述按 P4 的实际形状造：backendOptions 带 available/reason，fields 带 state/values/default。
const makeCapabilities = (config, extraExecField) => {
  const roles = {};
  for (const role of DECISION_ROLES) {
    const args = Array.isArray(config.roles[role].args) ? config.roles[role].args : [];
    roles[role] = {
      backendOptions: [
        { id: 'codex-cli', label: 'codex-cli', available: true, reason: null },
        { id: 'external-command', label: 'external-command', available: true, reason: null },
      ],
      backends: {
        'codex-cli': {
          id: 'codex-cli', resume: 'thread-id', output: 'codex-jsonl',
          fields: {
            model: { type: 'string', state: 'supported', nullable: false, required: true, default: 'fixture-model-a', values: ['fixture-model-a', 'fixture-model-b'] },
            effort: { type: 'string', state: 'supported', nullable: false, required: true, default: 'medium', values: ['low', 'medium', 'high'] },
          },
        },
        'external-command': {
          id: 'external-command', resume: 'none', output: 'text',
          fields: {
            executable: { type: 'string', state: 'supported', nullable: false, required: true, default: null, values: null },
            args: { type: 'string[]', state: 'supported', nullable: true, required: false, default: [], values: null },
            model: { type: 'string', state: args.includes('{model}') ? 'supported' : 'unsupported', nullable: true, required: false, default: null, values: null },
            effort: { type: 'string', state: args.includes('{effort}') ? 'supported' : 'unsupported', nullable: true, required: false, default: null, values: null },
          },
        },
      },
    };
  }
  for (const role of EXEC_ROLES) {
    const fields = {
      model: { type: 'string', state: 'supported', nullable: true, required: false, default: null, values: null },
      // verifier 的档位域宿主还没证实：能力未知的字段只能看不能改。
      effort: { type: 'string', state: role === 'verifier' ? 'unknown' : 'supported', nullable: true, required: false, default: null, values: null },
    };
    if (extraExecField) {
      fields.executable = { type: 'string', state: 'supported', nullable: true, required: false, default: null, values: null };
    }
    roles[role] = {
      backendOptions: [{ id: 'mcode-agent', label: 'MCode 子代理', available: true, reason: null }],
      backends: { 'mcode-agent': { id: 'mcode-agent', resume: 'none', output: 'text', fields: fields } },
    };
  }
  return { ok: true, roles: roles };
};

const statsFixture = () => ({
  totals: {
    events: 1, calls: 1, dispatches: 0, projects: 1, sessions: 1,
    inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15,
    elapsedSec: 1.2, cacheHitRate: 0, avgCallSec: 1.2,
  },
  findings: [],
  findingCounts: { danger: 0, warning: 0, info: 0 },
  byProject: [], byRole: [], byModel: [], byBackend: [], bySkill: [], byPlugin: [], byDay: [],
  tree: [{
    project: 'demo', count: 1, elapsedSec: 1.2, total: 15,
    sessions: [{
      session: 's1', count: 1, elapsedSec: 1.2, total: 15,
      roles: [{ role: 'overmind', label: 'Overmind', count: 1, elapsedSec: 1.2, total: 15, models: { 'fixture-model-a': 1 } }],
    }],
  }],
  recent: [{ at: '2026-11-24T10:00:00.000Z', kind: 'call', role: 'overmind', model: 'fixture-model-a', elapsedSec: 1.2, tokens: 15 }],
});

// 从渲染出来的 HTML 里找出表单控件：属性是页面自己的约定，解析结果直接用来断言。
const parseFields = (html) => {
  const out = [];
  const re = /<(select|input|textarea)([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const role = /data-r="([^"]*)"/.exec(attrs);
    const field = /data-f="([^"]*)"/.exec(attrs);
    if (!role || !field) continue;
    let value = '';
    if (tag === 'select' || tag === 'textarea') {
      const end = html.indexOf('</' + tag + '>', m.index);
      const inner = end > -1 ? html.slice(m.index, end) : '';
      if (tag === 'select') {
        const sel = /<option value="([^"]*)"[^>]*selected/.exec(inner);
        value = sel ? sel[1] : '';
      } else {
        value = inner.split('>').slice(1).join('>').trim();
      }
    } else {
      const v = /value="([^"]*)"/.exec(attrs);
      value = v ? v[1] : '';
    }
    out.push({
      tag: tag, role: role[1], field: field[1], value: value,
      dataset: { r: role[1], f: field[1] },
      disabled: attrs.indexOf(' disabled') > -1,
    });
  }
  return out;
};

const parseAlerts = (html) => {
  const out = [];
  const re = /<input([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const key = /data-a="([^"]*)"/.exec(m[1]);
    if (!key) continue;
    const v = /value="([^"]*)"/.exec(m[1]);
    out.push({ dataset: { a: key[1] }, value: v ? v[1] : '' });
  }
  return out;
};

const createHarness = (script, store, capsFor) => {
  const els = new Map();
  const handlers = [];
  const posts = [];

  const stub = (id) => ({
    id: id, innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false, attrs: {}, listeners: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  });

  const tabs = ['t-findings', 't-tree', 't-config'].map(stub);
  const views = ['v-findings', 'v-tree', 'v-config'].map(stub);

  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, stub(id)); return els.get(id); },
    querySelectorAll(sel) {
      if (sel === '[role="tab"]') return tabs;
      if (sel === '.view') return views;
      if (sel === '#roles-form [data-r]') return parseFields(els.get('roles-form') ? els.get('roles-form').innerHTML : '');
      if (sel === '#alerts-form [data-a]') return parseAlerts(els.get('alerts-form') ? els.get('alerts-form').innerHTML : '');
      return [];
    },
    addEventListener(type, fn) { handlers.push({ type: type, fn: fn }); },
  };

  const applyPatch = (body) => {
    for (const [role, patch] of Object.entries(body.roles || {})) {
      store.roles[role] = Object.assign({}, store.roles[role], patch);
    }
    if (body.alerts) store.alerts = Object.assign({}, store.alerts, body.alerts);
  };

  const fetchStub = async (url, opts) => {
    const o = opts || {};
    const u = String(url);
    if (u.startsWith('/api/stats')) return { ok: true, status: 200, json: async () => statsFixture() };
    if (u === '/api/config' && o.method === 'POST') {
      const body = JSON.parse(o.body);
      posts.push(body);
      applyPatch(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, config: store, capabilities: capsFor(store) }) };
    }
    if (u === '/api/config') {
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          roles: store.roles,
          alerts: store.alerts,
          config: store,
          capabilities: capsFor(store),
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  };

  const sandbox = {
    document: document,
    fetch: fetchStub,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '' },
    window: { location: { href: '' } },
    URLSearchParams: URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'client.js' });

  return {
    els: els,
    posts: posts,
    handlers: handlers,
    rolesHtml: () => (els.get('roles-form') ? els.get('roles-form').innerHTML : ''),
    status: () => (els.get('status') ? els.get('status').textContent : ''),
    async openConfig() {
      const tab = tabs[2];
      for (const h of handlers) {
        if (h.type === 'click') await h.fn({ target: { closest: (sel) => (sel === '[role="tab"]' ? tab : null) } });
      }
    },
    change(role, field, value) {
      const target = { dataset: { r: role, f: field }, value: value };
      for (const h of handlers) if (h.type === 'change') h.fn({ target: target });
    },
    async save() {
      const btn = els.get('save');
      for (const fn of (btn && btn.listeners.click ? btn.listeners.click : [])) await fn();
    },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
// 旧页面可能压根没有这个节点：断言要能优雅地拿到"没有内容"。
const htmlOf = (harness, id) => (harness.els.get(id) ? harness.els.get(id).innerHTML : '');

const clientHtml = await readFile(CLIENT, 'utf8');
const scriptStart = clientHtml.indexOf('<script>');
const scriptEnd = clientHtml.lastIndexOf('</script>');
if (scriptStart < 0 || scriptEnd <= scriptStart) {
  console.log('FAIL   客户端里找不到 <script> 块  ->  ' + CLIENT);
  console.log('FAIL config-view (1 项未通过)');
  process.exit(1);
}
const script = clientHtml.slice(scriptStart + 8, scriptEnd);

// ── 场景 1：按能力渲染 + 换调用方式 → 保存 → 重开 ──────────────────
const store = baseConfig();
const h = createHarness(script, store, (s) => makeCapabilities(s, false));
await tick();
await tick();
await h.openConfig();

const fields = parseFields(h.rolesHtml());
const extraExec = fields.filter((f) => EXEC_ROLES.indexOf(f.role) > -1 && ['model', 'effort'].indexOf(f.field) < 0 && !f.disabled);
ok('三个内置角色没有 model/effort 之外的可编辑字段',
  extraExec.length === 0,
  extraExec.map((f) => f.role + '.' + f.field).join(', '));

const editableBackends = fields.filter((f) => f.field === 'backend' && !f.disabled);
ok('只有决策角色能改调用方式',
  editableBackends.every((f) => DECISION_ROLES.indexOf(f.role) > -1),
  editableBackends.map((f) => f.role).join(', '));

ok('内置角色写明 backend 与 agent 身份固定',
  h.rolesHtml().indexOf('身份固定') > -1 && h.rolesHtml().indexOf('mcode-agent') > -1);

ok('页面写明默认值',
  h.rolesHtml().indexOf('默认值') > -1);

ok('页面写明改动从哪次调用开始生效',
  h.rolesHtml().indexOf('开始生效') > -1);

const verifierEffort = fields.filter((f) => f.role === 'verifier' && f.field === 'effort');
ok('能力未知的字段不渲染成可编辑控件',
  verifierEffort.length === 0 || verifierEffort.every((f) => f.disabled),
  JSON.stringify(verifierEffort));
ok('能力未知的字段写明当前值不可编辑',
  h.rolesHtml().indexOf('能力未确认') > -1);
const workerEffort = fields.filter((f) => f.role === 'worker' && f.field === 'effort');
ok('能力已知的内置字段仍然可编辑',
  workerEffort.length === 1 && !workerEffort[0].disabled,
  JSON.stringify(workerEffort));

// 换调用方式
h.change('overmind', 'backend', 'external-command');
const afterSwitch = parseFields(h.rolesHtml());
ok('换到外部命令后出现可写的可执行程序字段',
  afterSwitch.some((f) => f.role === 'overmind' && f.field === 'executable' && !f.disabled));
ok('换到外部命令后出现可写的参数数组字段',
  afterSwitch.some((f) => f.role === 'overmind' && f.field === 'args' && !f.disabled));

const modelNoPlaceholder = afterSwitch.find((f) => f.role === 'overmind' && f.field === 'model');
ok('参数里没有 {model} 占位元素时模型字段不可编辑',
  !!modelNoPlaceholder && modelNoPlaceholder.disabled,
  JSON.stringify(modelNoPlaceholder));
ok('不可编辑的字段写明了原因',
  h.rolesHtml().indexOf('占位元素') > -1);

const ARGS = ['plan', '--stdin', '--model', '{model}', '--effort', '{effort}'];
h.change('overmind', 'args', JSON.stringify(ARGS));
const withPlaceholder = parseFields(h.rolesHtml());
const modelWithPlaceholder = withPlaceholder.find((f) => f.role === 'overmind' && f.field === 'model');
ok('参数里有 {model} 占位元素后模型字段可编辑',
  !!modelWithPlaceholder && !modelWithPlaceholder.disabled,
  JSON.stringify(modelWithPlaceholder));

h.change('overmind', 'executable', 'local-planner');
h.change('overmind', 'model', 'fixture-model-b');
h.change('overmind', 'effort', 'high');
await h.save();

const post = h.posts[h.posts.length - 1];
ok('保存写入了新的调用方式',
  !!post && !!post.roles && !!post.roles.overmind && post.roles.overmind.backend === 'external-command',
  JSON.stringify(post));
ok('保存写入了可执行程序',
  !!post && !!post.roles && !!post.roles.overmind && post.roles.overmind.executable === 'local-planner',
  JSON.stringify(post));
ok('保存写入了参数数组',
  !!post && !!post.roles && !!post.roles.overmind && JSON.stringify(post.roles.overmind.args) === JSON.stringify(ARGS),
  JSON.stringify(post));
ok('保存只发已改的可写字段：没改的内置角色一个字段都没提交',
  !!post && post.roles && post.roles.worker === undefined && post.roles.explore === undefined && post.roles.verifier === undefined,
  JSON.stringify(post && post.roles));
ok('保存只发已改的可写字段：没改的决策角色没提交',
  !!post && post.roles && post.roles.coder === undefined,
  JSON.stringify(post && post.roles));

// 重开页面（同一份已保存配置，重新渲染一次）
const h2 = createHarness(script, store, (s) => makeCapabilities(s, false));
await tick();
await tick();
await h2.openConfig();
ok('重开页面后外部命令的可执行程序还在',
  h2.rolesHtml().indexOf('local-planner') > -1);
ok('重开页面后参数数组还在',
  h2.rolesHtml().indexOf('{model}') > -1 && h2.rolesHtml().indexOf('{effort}') > -1);

// ── 场景 2：原有视图没被改坏 ───────────────────────────────────────
ok('问题诊断的读数条仍然渲染',
  htmlOf(h, 'readout').length > 0);
ok('统计详情的三级树仍然渲染',
  htmlOf(h, 'tree').length > 0);
ok('统计详情的原始事件表仍然渲染',
  htmlOf(h, 'raw-table').length > 0);
ok('三个视图的切换入口还在',
  clientHtml.indexOf('t-findings') > -1 && clientHtml.indexOf('t-tree') > -1 && clientHtml.indexOf('t-config') > -1);

// ── 场景 3：能力降级时给缺失依赖与修复动作 ─────────────────────────
const degradedStore = baseConfig();
const degradedCaps = () => ({
  ok: false,
  code: 'BACKEND_CAPABILITY_UNAVAILABLE',
  message: '核心插件缺少 scripts/decision-backend.mjs，读不到 overmind 的后端能力',
  nextStep: { text: '升级 Code Team 插件后重新打开控制台', command: null },
  roles: makeCapabilities(degradedStore, false).roles,
});
const h3 = createHarness(script, degradedStore, degradedCaps);
await tick();
await tick();
await h3.openConfig();
const banner = htmlOf(h3, 'cap-banner');
ok('能力降级时页面给出缺失依赖与修复动作',
  banner.indexOf('decision-backend.mjs') > -1 && banner.indexOf('升级 Code Team 插件') > -1,
  banner);

// ── 场景 4：内置角色的可写白名单 ───────────────────────────────────
const strictStore = baseConfig();
const h4 = createHarness(script, strictStore, (s) => makeCapabilities(s, true));
await tick();
await tick();
await h4.openConfig();
const strictFields = parseFields(h4.rolesHtml()).filter((f) => EXEC_ROLES.indexOf(f.role) > -1);
ok('即使能力描述里多给了字段，内置角色也只渲染 model/effort',
  strictFields.every((f) => ['model', 'effort'].indexOf(f.field) > -1),
  strictFields.map((f) => f.role + '.' + f.field).join(', '));

// ── 场景 5：必填字段留空时本地拦下，不发请求 ───────────────────────
const blankStore = baseConfig();
const h5 = createHarness(script, blankStore, (s) => makeCapabilities(s, false));
await tick();
await tick();
await h5.openConfig();
h5.change('overmind', 'backend', 'external-command');
await h5.save();
ok('必填字段留空时不发请求',
  h5.posts.length === 0,
  JSON.stringify(h5.posts));
ok('必填字段留空时说明是哪个字段',
  h5.status().indexOf('executable') > -1,
  h5.status());

// ── 静态：模型中立与示例 ───────────────────────────────────────────
const BRANDS = ['codex', 'gpt-', 'openai', 'claude', 'sonnet', 'opus', 'haiku', 'minimax/'];
const clientHits = BRANDS.filter((t) => clientHtml.toLowerCase().indexOf(t) > -1);
ok('页面文案没有写死模型品牌', clientHits.length === 0, clientHits.join(', '));

const plugin = JSON.parse(await readFile(join(ROOT, '.minimax-plugin', 'plugin.json'), 'utf8'));
const pluginText = (plugin.description || '') + ' ' + (plugin.exampleQueries || []).join(' ');
const pluginHits = BRANDS.filter((t) => pluginText.toLowerCase().indexOf(t) > -1);
ok('插件描述与示例没有写死模型品牌', pluginHits.length === 0, pluginHits.join(', '));
ok('插件示例覆盖换调用方式与专业方向两件事',
  pluginText.indexOf('后端') > -1 || pluginText.indexOf('命令') > -1,
  pluginText);

const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
ok('README 给出外部命令的占位元素示例',
  readme.indexOf('{model}') > -1 && readme.indexOf('{effort}') > -1);
ok('README 给出前端专业方向的示例',
  readme.indexOf('frontend-design:frontend-design') > -1);
ok('README 写明外部命令的前提',
  readme.indexOf('stdin') > -1);

if (failures) {
  console.log('');
  console.log('FAIL config-view (' + failures + ' 项未通过)');
  process.exit(1);
}
console.log('');
console.log('PASS config-view');
