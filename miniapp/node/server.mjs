// @ts-check

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

// Code Team 插件目录：数据源在这里（事件流与角色配置）。
// 优先读环境变量 CODE_TEAM_PLUGIN_DIR，这样换机器或换安装位置不用改代码。
const PLUGIN_DIR = process.env.CODE_TEAM_PLUGIN_DIR
  || join(process.env.USERPROFILE || process.env.HOME || '', '.minimax', 'plugins', 'code-team');
const EVENTS_FILE = join(PLUGIN_DIR, 'config', 'events.jsonl');
const TEAM_CONFIG = join(PLUGIN_DIR, 'config', 'team.json');
const LESSONS_FILE = join(PLUGIN_DIR, 'config', 'lessons.json');

function readEvents() {
  if (!existsSync(EVENTS_FILE)) return [];
  return readFileSync(EVENTS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function roleLabel(roleKey, cfg) {
  return cfg?.roles?.[roleKey]?.label ?? roleKey;
}

/**
 * 诊断引擎。
 *
 * 这里不回答"用了多少"，回答"哪里出了问题"。
 * 每条规则都对应 Code Team 机制里的一个真实失效模式，
 * 而不是通用的统计阈值。
 */
function diagnose(events, cfg, query) {
  const alerts = {
    overmindCallsPerSession: 2,
    coderCallsPerSession: 3,
    minCacheHitRate: 0.5,
    slowCallSec: 90,
    staleDays: 14,
    ...(cfg?.alerts ?? {}),
  };

  // 按会话分组：session 是主键，没有 session 的事件归到 '(无会话)'。
  const sessions = new Map();
  for (const e of events) {
    const key = e.session ?? e.threadId ?? '(无会话)';
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(e);
  }

  const findings = [];

  const q = (query ?? '').trim().toLowerCase();

  for (const [sessionId, list] of sessions) {
    const sorted = [...list].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // 会话内任一事件命中关键词，整个会话都纳入诊断——
    // 否则会漏掉"同一会话里的另一个角色"这类问题。
    if (q && !sorted.some((e) => [e.project, e.session, e.task, e.role, e.model, e.backend, e.skill, e.plugin]
      .some((v) => String(v ?? '').toLowerCase().includes(q)))) continue;
    const project = sorted.find((e) => e.project)?.project ?? '(未记录)';
    const calls = sorted.filter((e) => e.kind === 'codex-call' || e.kind === 'call');
    const dispatches = sorted.filter((e) => e.kind === 'dispatch' || e.kind === 'dispatch-result');

    // 规则 1：规划返工 —— 一个会话里 Overmind 开了多次，说明方案被推翻了。
    const overmindCalls = calls.filter((e) => e.role === 'overmind');
    if (overmindCalls.length >= alerts.overmindCallsPerSession) {
      findings.push({
        kind: 'overmind-rework',
        severity: 'warning',
        sessionId,
        project,
        title: `规划返工：同一会话开了 ${overmindCalls.length} 次 Overmind`,
        detail: `阈值是 ${alerts.overmindCallsPerSession} 次。超过说明方案被推翻重来——这是最贵的一种浪费。
建议：用 --resume 续聊同一线程改方案，不要重开线程。`,
        evidence: overmindCalls.map((e) => ({ at: e.at, model: e.model, elapsedSec: e.elapsedSec, task: e.task })),
      });
    }

    // 规则 2：代码方向空转 —— Coder 开了但没有 Worker 落地。
    const coderCalls = calls.filter((e) => e.role === 'coder');
    const workerEvents = sorted.filter((e) => e.role === 'worker');
    if (coderCalls.length > 0 && workerEvents.length === 0) {
      findings.push({
        kind: 'coder-without-worker',
        severity: 'warning',
        sessionId,
        project,
        title: '只规划没落地：Coder 开了，但没有 Worker 执行',
        detail: `Coder 调了 ${coderCalls.length} 次，没有对应的 Worker 派工记录。
可能原因：派工没记事件（埋点漏了），或 Overmind 指明需要 Coder 后流程中断。`,
        evidence: coderCalls.map((e) => ({ at: e.at, model: e.model, elapsedSec: e.elapsedSec, task: e.task })),
      });
    }

    // 规则 3：无独立验收 —— 有执行但没有 Verifier。
    if (workerEvents.length > 0 && !sorted.some((e) => e.role === 'verifier')) {
      findings.push({
        kind: 'no-verification',
        severity: 'danger',
        sessionId,
        project,
        title: '验收缺失：有 Worker 执行，但没有 Verifier 记录',
        detail: 'Code Team 的验收只做一次、由 Verifier 独立完成。没有验收记录意味着这条链路不完整——结果没被独立检查过。',
        evidence: workerEvents.map((e) => ({ at: e.at, model: e.model, elapsedSec: e.elapsedSec, task: e.task })),
      });
    }

    // 规则 4：缓存未复用 —— 同一会话多次调用但缓存命中率低，说明前缀没复用。
    if (calls.length >= 2) {
      const input = calls.reduce((n, e) => n + (e.usage?.input_tokens ?? 0), 0);
      const cached = calls.reduce((n, e) => n + (e.usage?.cached_input_tokens ?? 0), 0);
      const rate = input > 0 ? cached / input : 1;
      if (rate < alerts.minCacheHitRate) {
        findings.push({
          kind: 'low-cache-hit',
          severity: 'warning',
          sessionId,
          project,
          title: `前缀未复用：缓存命中率 ${(rate * 100).toFixed(0)}%`,
          detail: `同会话 ${calls.length} 次调用，缓存命中 ${(rate * 100).toFixed(0)}%（阈值 ${(alerts.minCacheHitRate * 100).toFixed(0)}%）。
说明每次都在重新发全量上下文。规划类调用应该用 --resume 续聊复用前缀。`,
          evidence: calls.map((e) => ({ at: e.at, model: e.model, elapsedSec: e.elapsedSec, cached: e.usage?.cached_input_tokens ?? 0, input: e.usage?.input_tokens ?? 0 })),
        });
      }
    }

    // 规则 5：慢调用 —— 单次耗时异常。
    for (const e of calls) {
      if ((e.elapsedSec ?? 0) >= alerts.slowCallSec) {
        findings.push({
          kind: 'slow-call',
          severity: 'info',
          sessionId,
          project,
          title: `慢调用：${roleLabel(e.role, cfg)} 用了 ${e.elapsedSec} 秒`,
          detail: `阈值 ${alerts.slowCallSec} 秒。原因可能是：档位过高、prompt 过长、上下文膨胀、模型排队。`,
          evidence: [{ at: e.at, model: e.model, effort: e.effort, elapsedSec: e.elapsedSec, task: e.task }],
        });
      }
    }

    // 规则 6：失败调用。
    for (const e of [...calls, ...dispatches]) {
      if (e.ok === false) {
        findings.push({
          kind: 'failed-call',
          severity: 'danger',
          sessionId,
          project,
          title: `${roleLabel(e.role, cfg)} 调用失败`,
          detail: e.note || '该调用未成功完成。',
          evidence: [{ at: e.at, model: e.model, elapsedSec: e.elapsedSec, task: e.task }],
        });
      }
    }

    // 规则 7：派工没有归因 —— 派工事件缺 project/task，统计就断了。
    for (const e of dispatches) {
      if (!e.project || e.project === '(未记录)') {
        findings.push({
          kind: 'missing-attribution',
          severity: 'info',
          sessionId,
          project: '(未记录)',
          title: '派工事件缺归因信息',
          detail: '派工时没带 --project / --task，这条记录无法归到具体项目与任务，统计会断链。',
          evidence: [{ at: e.at, role: e.role }],
        });
        break;
      }
    }
  }

  const order = { danger: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

/**
 * 三级结构：项目 → 会话 → 角色。
 * 这是"Code Team 到底做了什么"的答案。
 */
function buildTree(events, cfg, query) {
  const q = (query ?? '').trim().toLowerCase();
  const matches = (e) => {
    if (!q) return true;
    return [e.project, e.session, e.task, e.role, e.model, e.backend, e.skill, e.plugin, e.note]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  };

  const filtered = events.filter(matches);
  const projects = new Map();

  for (const e of filtered) {
    const projectKey = e.project ?? '(未记录)';
    if (!projects.has(projectKey)) projects.set(projectKey, { project: projectKey, sessions: new Map(), total: 0, count: 0, elapsedSec: 0 });
    const p = projects.get(projectKey);
    p.count += 1;
    p.elapsedSec += e.elapsedSec ?? 0;
    const u = e.usage ?? {};
    p.total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);

    const sessionKey = e.session ?? '(无会话)';
    if (!p.sessions.has(sessionKey)) p.sessions.set(sessionKey, { session: sessionKey, roles: new Map(), count: 0, elapsedSec: 0, total: 0, startedAt: null, endedAt: null });
    const s = p.sessions.get(sessionKey);
    s.count += 1;
    s.elapsedSec += e.elapsedSec ?? 0;
    s.total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
    if (!s.startedAt || String(e.at) < s.startedAt) s.startedAt = e.at;
    if (!s.endedAt || String(e.at) > s.endedAt) s.endedAt = e.at;

    const roleKey = e.role ?? '(无角色)';
    if (!s.roles.has(roleKey)) s.roles.set(roleKey, { role: roleKey, label: roleLabel(roleKey, cfg), count: 0, elapsedSec: 0, total: 0, input: 0, cached: 0, output: 0, reasoning: 0, models: new Map(), events: [] });
    const r = s.roles.get(roleKey);
    r.count += 1;
    r.elapsedSec += e.elapsedSec ?? 0;
    r.input += u.input_tokens ?? 0;
    r.cached += u.cached_input_tokens ?? 0;
    r.output += u.output_tokens ?? 0;
    r.reasoning += u.reasoning_output_tokens ?? 0;
    r.total = r.input + r.output + r.reasoning;
    r.models.set(e.model ?? '(未知)', (r.models.get(e.model ?? '(未知)') ?? 0) + 1);
    r.events.push({
      at: e.at, kind: e.kind, backend: e.backend, model: e.model, effort: e.effort,
      task: e.task, skill: e.skill, elapsedSec: e.elapsedSec, ok: e.ok, note: e.note,
      tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      cached: u.cached_input_tokens ?? 0,
    });
  }

  const out = [];
  for (const p of projects.values()) {
    const sessions = [...p.sessions.values()].map((s) => ({
      session: s.session,
      count: s.count,
      elapsedSec: s.elapsedSec,
      total: s.total,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      roles: [...s.roles.values()]
        .map((r) => ({ ...r, models: Object.fromEntries(r.models) }))
        .sort((a, b) => b.total - a.total),
    })).sort((a, b) => b.total - a.total);
    out.push({ project: p.project, count: p.count, elapsedSec: p.elapsedSec, total: p.total, sessions });
  }
  return out.sort((a, b) => b.total - a.total);
}

function buildStats(events, cfg, query) {
  const filtered = query ? events.filter((e) => {
    const q = query.trim().toLowerCase();
    return [e.project, e.session, e.task, e.role, e.model, e.backend, e.skill, e.plugin]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  }) : events;

  const calls = filtered.filter((e) => e.kind === 'codex-call' || e.kind === 'call');
  const dispatches = filtered.filter((e) => e.kind === 'dispatch' || e.kind === 'dispatch-result');
  const sum = (k) => calls.reduce((n, e) => n + (e.usage?.[k] ?? 0), 0);
  const totalElapsed = calls.reduce((n, e) => n + (e.elapsedSec ?? 0), 0);
  const cached = sum('cached_input_tokens');

  const byDim = (keyFn, labelFn) => {
    const map = new Map();
    for (const e of filtered) {
      const key = keyFn(e) ?? '(未记录)';
      if (!map.has(key)) map.set(key, { key, label: labelFn ? labelFn(key) : key, count: 0, elapsedSec: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 });
      const g = map.get(key);
      g.count += 1;
      g.elapsedSec += e.elapsedSec ?? 0;
      const u = e.usage ?? {};
      g.input += u.input_tokens ?? 0;
      g.cached += u.cached_input_tokens ?? 0;
      g.output += u.output_tokens ?? 0;
      g.reasoning += u.reasoning_output_tokens ?? 0;
      g.total = g.input + g.output + g.reasoning;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };

  // 按日聚合：周报和"按日消耗"都要它。
  const byDayMap = new Map();
  for (const e of filtered) {
    const day = String(e.at ?? '').slice(0, 10);
    if (!day) continue;
    if (!byDayMap.has(day)) byDayMap.set(day, { key: day, count: 0, elapsedSec: 0, total: 0 });
    const d = byDayMap.get(day);
    d.count += 1;
    d.elapsedSec += e.elapsedSec ?? 0;
    const u = e.usage ?? {};
    d.total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  }

  // 诊断只在检索命中的会话上做：检索是"缩小问题范围"，不是"看全部问题"。
  const findings = diagnose(events, cfg, query);

  return {
    generatedAt: new Date().toISOString(),
    query: query ?? '',
    totals: {
      events: filtered.length,
      calls: calls.length,
      dispatches: dispatches.length,
      projects: new Set(filtered.map((e) => e.project).filter(Boolean)).size,
      sessions: new Set(filtered.map((e) => e.session).filter(Boolean)).size,
      inputTokens: sum('input_tokens'),
      cachedTokens: cached,
      outputTokens: sum('output_tokens'),
      reasoningTokens: sum('reasoning_output_tokens'),
      totalTokens: sum('input_tokens') + sum('output_tokens') + sum('reasoning_output_tokens'),
      elapsedSec: totalElapsed,
      cacheHitRate: sum('input_tokens') > 0 ? cached / sum('input_tokens') : 0,
      avgCallSec: calls.length ? totalElapsed / calls.length : 0,
    },
    findings,
    findingCounts: {
      danger: findings.filter((f) => f.severity === 'danger').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    byRole: byDim((e) => e.role, (k) => roleLabel(k, cfg)),
    byModel: byDim((e) => e.model),
    byBackend: byDim((e) => e.backend),
    bySkill: byDim((e) => e.skill),
    byPlugin: byDim((e) => e.plugin),
    byProject: byDim((e) => e.project),
    byDay: [...byDayMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
    // 原始事件：最近的在前，供"原始事件"表使用。
    recent: filtered.slice(-50).reverse(),
    tree: buildTree(events, cfg, query),
  };
}

function buildReport(cfg) {
  const s = buildStats(readEvents(), cfg, '');
  const t = s.totals;
  const fmt = (n) => (n ?? 0).toLocaleString('zh-CN');
  const rows = (arr) => arr.length
    ? arr.map((g) => `| ${g.label ?? g.key} | ${g.count} | ${g.elapsedSec.toFixed(1)} | ${fmt(g.total)} |`).join('\n')
    : '| (无) | 0 | 0 | 0 |';

  const lines = [
    '# Code Team 用量周报',
    '',
    `- 生成时间：${s.generatedAt}`,
    `- 覆盖：${t.projects} 个项目 / ${t.sessions} 个会话 / ${t.calls} 次调用 / ${t.dispatches} 次派工`,
    `- Token：输入 ${fmt(t.inputTokens)}｜缓存命中 ${fmt(t.cachedTokens)}｜输出 ${fmt(t.outputTokens)}｜推理 ${fmt(t.reasoningTokens)}`,
    `- 缓存命中率：${(t.cacheHitRate * 100).toFixed(1)}%｜总耗时 ${t.elapsedSec.toFixed(1)}s｜单次均 ${t.avgCallSec.toFixed(1)}s`,
    '',
    '## 需要处理的问题',
    '',
  ];

  if (s.findings.length) {
    for (const f of s.findings) {
      const badge = f.severity === 'danger' ? '严重' : f.severity === 'warning' ? '注意' : '提示';
      lines.push(`### [${badge}] ${f.title}`, '', `- 项目：${f.project}｜会话：${f.sessionId}`, `- ${f.detail}`, '');
    }
  } else {
    lines.push('本周期没有检测到异常。', '');
  }

  lines.push(
    '## 按项目', '', '| 项目 | 次数 | 耗时(s) | Token |', '|---|---|---|---|', rows(s.byProject), '',
    '## 按角色', '', '| 角色 | 次数 | 耗时(s) | Token |', '|---|---|---|---|', rows(s.byRole), '',
    '## 按模型', '', '| 模型 | 次数 | 耗时(s) | Token |', '|---|---|---|---|', rows(s.byModel), '',
    '## 按后端', '', '| 后端 | 次数 | 耗时(s) | Token |', '|---|---|---|---|', rows(s.byBackend), '',
    '## 按 Skill', '', '| Skill | 次数 | 耗时(s) | Token |', '|---|---|---|---|', rows(s.bySkill), ''
  );

  const notes = [];
  if (t.calls > 0 && s.byModel[0]) {
    notes.push(`- 耗时最集中的模型是 **${s.byModel[0].label ?? s.byModel[0].key}**（${s.byModel[0].count} 次，${s.byModel[0].elapsedSec.toFixed(1)} 秒），换模型前优先看它。`);
  }
  if (t.calls > 0 && t.cacheHitRate < 0.5) {
    notes.push(`- 缓存命中率仅 ${(t.cacheHitRate * 100).toFixed(1)}%，多数调用在重发全量上下文。规划类调用应优先 --resume 续聊。`);
  }
  const topProject = s.byProject[0];
  if (topProject && topProject.key !== '(未记录)') {
    notes.push(`- 消耗最集中的项目是 **${topProject.key}**，占 ${((topProject.total / (t.totalTokens || 1)) * 100).toFixed(1)}% 的 token。`);
  }
  const topSkill = s.bySkill[0];
  if (topSkill && topSkill.key !== '(未记录)') {
    notes.push(`- 调用最集中的 Skill 是 **${topSkill.key}**（${topSkill.count} 次）。`);
  }
  if (!notes.length) notes.push('- 数据还太少，跑几次 Code Team 后再看。');
  lines.push('## 优化支撑点', '', ...notes, '');

  return lines.join('\n');
}

async function writeJsonAtomic(file, data) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function start(context) {
  const clientEntry = await readFile(join(context.pluginRoot, 'miniapp/client/index.html'));
  const cfg = readJson(TEAM_CONFIG, {});

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const path = url.pathname;

    if (request.method === 'GET' && (path === '/dashboard' || path === '/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(clientEntry);
      return;
    }

    if (request.method === 'GET' && path === '/api/stats') {
      try { json(response, buildStats(readEvents(), cfg, url.searchParams.get('q') ?? '')); }
      catch (error) { json(response, { error: String(error?.message ?? error) }, 500); }
      return;
    }

    if (request.method === 'GET' && path === '/api/config') {
      const c = readJson(TEAM_CONFIG, null);
      if (!c) { json(response, { error: '读不到 team.json' }, 500); return; }
      json(response, c);
      return;
    }

    if (request.method === 'POST' && path === '/api/config') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', async () => {
        try {
          const patch = JSON.parse(body || '{}');
          const current = readJson(TEAM_CONFIG, {});
          const merged = { ...current, roles: { ...(current.roles ?? {}) } };
          for (const [key, incoming] of Object.entries(patch.roles ?? {})) {
            if (!incoming || typeof incoming !== 'object') continue;
            const role = { ...(merged.roles[key] ?? {}) };
            for (const field of ['backend', 'model', 'effort', 'agent']) {
              if (field === 'effort') {
                if (incoming[field] === null || incoming[field] === '') role[field] = null;
                else if (typeof incoming[field] === 'string') role[field] = incoming[field];
              } else if (typeof incoming[field] === 'string') {
                role[field] = incoming[field];
              }
            }
            merged.roles[key] = role;
          }
          if (patch.alerts && typeof patch.alerts === 'object') {
            merged.alerts = { ...(current.alerts ?? {}), ...patch.alerts };
          }
          await writeJsonAtomic(TEAM_CONFIG, merged);
          json(response, { ok: true, config: merged });
        } catch (error) {
          json(response, { error: String(error?.message ?? error) }, 400);
        }
      });
      return;
    }

    if (request.method === 'GET' && path === '/api/report') {
      try {
        const md = buildReport(readJson(TEAM_CONFIG, {}));
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="code-team-report.md"',
        });
        response.end(md);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(String(error?.message ?? error));
      }
      return;
    }

    if (request.method === 'GET' && path === '/api/lessons') {
      json(response, readJson(LESSONS_FILE, { lessons: [] }));
      return;
    }

    json(response, { error: 'not_found' }, 404);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    context.signal.removeEventListener('abort', onAbort);
    disposal = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return disposal;
  };
  const onAbort = () => { void dispose(); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}
