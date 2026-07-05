#!/usr/bin/env node
// offload — move heavy subagent work OFF Claude's quota.
// Two lanes: `oc` (opencode serve HTTP API) and `agy` (Antigravity CLI).
// Design rationale: see plan 2026-07-05 (async-native, dir required,
// fresh session per call, router-context + skill injection by default).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const BASE = path.join(HOME, '.config', 'offload');
const JOBS = path.join(BASE, 'jobs');
const SELF = fileURLToPath(import.meta.url);
const SERVER = process.env.OFFLOAD_SERVER || 'http://localhost:4096';
const AGY = process.env.OFFLOAD_AGY || 'agy';
// vault: root of your notes vault; project routers are looked up at
// <vault>/02_Projects/<project-dirname>.md. Set via config.json or env.
const DEFAULTS = {
  vault: process.env.OFFLOAD_VAULT || null,
};

// Failover chains per capability tier (grounded in CLAUDE_OPENCODE_RULES.md
// pool analysis: Zen/Cerebras generous; Groq only the 14.4k-RPD 8B model;
// OpenRouter free = 50/day SHARED, last resort + counted; NIM fenced to heavy).
// chain[0] documents the tier's configured primary; attempt 1 always runs the
// agent's own default, so failover starts at chain[1].
const CHAINS = {
  build:   ['opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'opencode/nemotron-3-ultra-free', 'cerebras/zai-glm-4.7', 'groq/llama-3.1-8b-instant', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'],
  explore: ['opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'groq/llama-3.1-8b-instant'],
  review:  ['opencode/north-mini-code-free', 'opencode/deepseek-v4-flash-free', 'cerebras/zai-glm-4.7'],
  plan:    ['google/gemini-3.1-pro-preview', 'opencode/mimo-v2.5-free'],
  heavy:   ['nvidia/deepseek-ai/deepseek-v4-pro', 'google/gemini-3.1-pro-preview'],
};
const AGENT_TIER = {
  build: 'build', general: 'build', 'backend-developer': 'build', 'ecc-frontend-builder': 'build', 'refactor-cleaner': 'build',
  explore: 'explore', 'docs-lookup': 'explore', librarian: 'explore',
  'code-reviewer': 'review', architect: 'plan', planner: 'plan', 'security-reviewer': 'heavy',
};
const MAX_ATTEMPTS = 3;
const OPENROUTER_DAILY_STOP = 45; // pool is 50/day shared with agents we don't see

fs.mkdirSync(JOBS, { recursive: true });
const cfgPath = path.join(BASE, 'config.json');
const cfg = fs.existsSync(cfgPath)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }
  : DEFAULTS;
const projPath = path.join(BASE, 'projects.json');
const projects = fs.existsSync(projPath) ? JSON.parse(fs.readFileSync(projPath, 'utf8')) : {};

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = [];
const opt = { skill: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--bg' || a === '--json' || a === '--full' || a === '--no-context') opt[a.slice(2)] = true;
  else if (a === '--skill') opt.skill.push(argv[++i]);
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  else pos.push(a);
}

function die(msg) { console.error('offload: ' + msg); process.exit(1); }
function out(human, json) {
  console.log(opt.json ? JSON.stringify(json ?? human, null, 2) : human);
}
const now = () => new Date().toISOString();
const newId = () => 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- job store ----------
const jobFile = (id) => path.join(JOBS, id + '.json');
const outFile = (id) => path.join(JOBS, id + '.out.md');
function saveJob(j) { j.updated = now(); fs.writeFileSync(jobFile(j.id), JSON.stringify(j, null, 2)); }
function loadJob(id) { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); }
function allJobs() {
  return fs.readdirSync(JOBS).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(JOBS, f), 'utf8')))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

// ---------- context + skill preamble ----------
function routerFor(dir) {
  if (opt['no-context']) return null;
  if (opt.router) return opt.router;
  const mapped = projects[path.resolve(dir)] || projects[dir];
  if (mapped) return mapped;
  if (!cfg.vault) return null;
  const guess = path.join(cfg.vault, '02_Projects', path.basename(dir) + '.md');
  if (fs.existsSync(guess)) return guess;
  console.error('offload: no project router found for ' + dir + ' (context preamble skipped)');
  return null;
}

function resolveSkill(name) {
  const direct = path.join(HOME, '.claude', 'skills', name, 'SKILL.md');
  if (fs.existsSync(direct)) return direct;
  // plugin-installed skills: ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
  const pluginRoot = path.join(HOME, '.claude', 'plugins');
  if (fs.existsSync(pluginRoot)) {
    for (const p of fs.readdirSync(pluginRoot)) {
      const cand = path.join(pluginRoot, p, 'skills', name, 'SKILL.md');
      if (fs.existsSync(cand)) return cand;
    }
  }
  return null;
}

function buildPrompt(task, dir) {
  const lines = [];
  lines.push(`You are working in the project directory: ${dir}`);
  lines.push('Read files directly at the given absolute paths — do NOT search the filesystem outside this directory.');
  const router = routerFor(dir);
  if (router) lines.push(`Before starting, read the project router at: ${router} — it describes the project purpose, folder structure, plans, and current state. Let it guide your work.`);
  for (const s of opt.skill) {
    const p = resolveSkill(s);
    if (!p) die(`skill not found in Claude library: ${s}`);
    lines.push(`Apply the skill/checklist at: ${p} — read it first and follow it for this task.`);
  }
  lines.push('');
  lines.push('TASK:');
  lines.push(task);
  lines.push('');
  lines.push('Do this task YOURSELF — do NOT spawn sub-agents or use any task/delegate tool. Keep each step short.');
  return lines.join('\n');
}

// ---------- output shaping (token frugality) ----------
function summarize(job, text) {
  fs.writeFileSync(outFile(job.id), text || '(empty response)');
  const lines = (text || '').trim().split('\n');
  const excerpt = lines.length > 20 ? lines.slice(0, 20).join('\n') + `\n... (${lines.length - 20} more lines)` : lines.join('\n');
  const via = job.finalModel && job.finalModel !== '(agent default)' ? ` via=${job.finalModel}` : '';
  const head = `[${job.id}] ${job.status} | lane=${job.lane} agent=${job.agent || job.model}${via} | full output: ${outFile(job.id)}`;
  if (opt.json) return { id: job.id, status: job.status, lane: job.lane, outFile: outFile(job.id), excerpt };
  return head + '\n' + (opt.full ? text : excerpt);
}

// ---------- oc lane ----------
async function api(method, p, body, query) {
  const url = new URL(SERVER + p);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : null;
}

function parseModel(s) {
  if (!s) return undefined;
  const i = s.indexOf('/');
  if (i < 0) die('--model must be providerID/modelID');
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

function textParts(msgs) {
  let t = '';
  for (const m of msgs) {
    if (m.info?.role !== 'assistant') continue;
    for (const part of m.parts || []) if (part.type === 'text') t += part.text;
    t += '\n';
  }
  return t.trim();
}

// ---------- quota counter (OpenRouter free pool: 50/day shared) ----------
const quotaFile = path.join(JOBS, '_quota.json');
function quotaToday() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const q = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
    if (q.date === today) return q;
  } catch { /* fresh day */ }
  return { date: today, openrouter: 0 };
}
function bumpQuota(model) {
  if (!model || !model.startsWith('openrouter/')) return;
  const q = quotaToday();
  q.openrouter++;
  fs.writeFileSync(quotaFile, JSON.stringify(q));
}

// one delegation attempt; throws typed errors so the failover loop can decide
async function runOcAttempt(job, modelStr) {
  const q = { directory: job.dir };
  const ses = await api('POST', '/session', { title: `offload ${job.id}` }, q);
  job.sessionId = ses.id;
  if (ses.directory && path.resolve(ses.directory) !== path.resolve(job.dir))
    throw new Error(`session directory mismatch: wanted ${job.dir}, got ${ses.directory}`);
  saveJob(job);

  bumpQuota(modelStr);
  const body = {
    agent: job.agent,
    parts: [{ type: 'text', text: job.fullPrompt }],
    ...(modelStr ? { model: parseModel(modelStr) } : {}),
  };
  await api('POST', `/session/${ses.id}/prompt_async`, body, q);

  const timeoutMs = (Number(job.timeout) || 600) * 1000;
  const staleMs = Math.min(10 * 60 * 1000, timeoutMs);
  const start = Date.now();
  let lastSig = '', lastChange = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    const msgs = await api('GET', `/session/${ses.id}/message`, null, q);
    const asst = msgs.filter(m => m.info?.role === 'assistant');
    const last = asst[asst.length - 1];
    const sig = JSON.stringify(msgs).length + ':' + asst.length;
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    if (last?.info?.time?.completed) {
      const text = textParts(msgs);
      if (!text.trim()) { const e = new Error('empty response'); e.kind = 'empty'; throw e; }
      return text;
    }
    if (Date.now() - lastChange > staleMs) { const e = new Error(`no session activity for ${staleMs / 1000}s`); e.kind = 'stale'; throw e; }
    if (Date.now() - start > timeoutMs) { const e = new Error(`no completion after ${timeoutMs / 1000}s`); e.kind = 'timeout'; throw e; }
  }
}

async function runOc(job) {
  // model plan: explicit --model or --no-fallback = single attempt; otherwise
  // agent default first, then the tier chain (skipping chain[0] = the default)
  let models;
  if (job.modelStr || opt['no-fallback']) models = [job.modelStr];
  else {
    const chain = (cfg.chains || CHAINS)[AGENT_TIER[job.agent] || 'build'] || CHAINS.build;
    const orBlocked = quotaToday().openrouter >= OPENROUTER_DAILY_STOP;
    models = [undefined, ...chain.slice(1).filter(m => {
      if (orBlocked && m.startsWith('openrouter/')) {
        console.error(`offload: skipping ${m} (OpenRouter free pool at ${quotaToday().openrouter}/day, stop=${OPENROUTER_DAILY_STOP})`);
        return false;
      }
      return true;
    })].slice(0, MAX_ATTEMPTS);
  }

  job.attempts = [];
  let lastErr;
  for (const m of models) {
    const label = m || '(agent default)';
    try {
      const text = await runOcAttempt(job, m);
      job.attempts.push({ model: label, outcome: 'ok' });
      job.finalModel = label;
      job.status = 'done';
      saveJob(job);
      return text;
    } catch (e) {
      const kind = e.kind || (/429|rate.?limit|quota/i.test(e.message) ? 'ratelimit' : 'error');
      job.attempts.push({ model: label, outcome: kind });
      saveJob(job);
      lastErr = e;
      if (job.sessionId) { try { await api('POST', `/session/${job.sessionId}/abort`, {}, { directory: job.dir }); } catch { /* best effort */ } }
      const next = models[models.indexOf(m) + 1];
      if (next !== undefined) console.error(`offload: [${job.id}] ${label} failed (${kind}) — failing over to ${next}`);
    }
  }
  job.status = job.attempts[job.attempts.length - 1]?.outcome === 'timeout' ? 'timeout' : 'error';
  saveJob(job);
  throw new Error(`all ${job.attempts.length} attempt(s) failed [${job.attempts.map(a => `${a.model}:${a.outcome}`).join(', ')}]. Last: ${lastErr.message}. Check offload status ${job.id} before retrying.`);
}

// ---------- agy lane ----------
function runAgy(job) {
  const log = path.join(JOBS, job.id + '.agy.log');
  job.logFile = log;
  saveJob(job);
  const res = spawnSync(AGY, ['-p', job.fullPrompt, '--model', job.model, '--log-file', log,
    '--print-timeout', (Number(job.timeout) || 300) + 's', '--add-dir', job.dir],
    { encoding: 'utf8', timeout: ((Number(job.timeout) || 300) + 60) * 1000, maxBuffer: 32 * 1024 * 1024 });
  const stdout = res.stdout || '';
  const logTxt = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const modelLine = (logTxt.match(/Propagating selected model override.*$/m) || [])[0];
  job.actualModel = modelLine || 'UNVERIFIED (no override line in log)';
  if (/RESOURCE_EXHAUSTED|quota (has been )?exceeded/i.test(stdout + logTxt)) {
    job.status = 'quota';
    saveJob(job);
    throw new Error('agy quota exhausted — re-delegate via oc lane per routing rules. Output so far in ' + outFile(job.id));
  }
  if (res.status !== 0 && !stdout.trim()) {
    job.status = 'error';
    saveJob(job);
    throw new Error(`agy exited ${res.status}. stderr: ${(res.stderr || '').slice(0, 400)}`);
  }
  job.status = 'done';
  saveJob(job);
  return stdout.trim() + (modelLine ? `\n\n[model verified: ${modelLine.trim()}]` : '\n\n[WARNING: model use not verified in log]');
}

// ---------- background ----------
function detach(job) {
  const child = spawn(process.execPath, [SELF, '_worker', job.id], { detached: true, stdio: 'ignore' });
  child.unref();
  out(`[${job.id}] started in background (${job.lane}). Poll: offload status ${job.id}`,
    { id: job.id, status: 'running', poll: `offload status ${job.id}` });
}

async function worker(id) {
  const job = loadJob(id);
  try {
    const text = job.lane === 'oc' ? await runOc(job) : runAgy(job);
    fs.writeFileSync(outFile(job.id), text || '(empty response)');
    job.status = 'done';
  } catch (e) {
    if (job.status === 'running') job.status = 'error';
    job.error = String(e.message || e);
    fs.writeFileSync(outFile(job.id), 'ERROR: ' + job.error);
  }
  saveJob(job);
}

// ---------- commands ----------
async function cmdRun(lane) {
  const dir = opt.dir && path.resolve(opt.dir);
  if (!dir) die('--dir <absolute project path> is required');
  if (!fs.existsSync(dir)) die('--dir does not exist: ' + dir);
  const [target, ...rest] = pos; // oc: agent name | agy: model label
  const task = rest.join(' ');
  if (!target || !task) die(lane === 'oc'
    ? 'usage: offload oc <agent> "<prompt>" --dir <abs> [--model p/m] [--bg] [--skill name]'
    : 'usage: offload agy "<model label>" "<prompt>" --dir <abs> [--bg] [--skill name]');
  const job = {
    id: newId(), lane, dir, status: 'running', created: now(),
    agent: lane === 'oc' ? target : undefined,
    model: lane === 'agy' ? target : opt.model,
    modelStr: lane === 'oc' ? opt.model : undefined,
    sessionId: opt.session, timeout: opt.timeout,
    task: task.slice(0, 200),
    fullPrompt: buildPrompt(task, dir),
    skills: opt.skill,
  };
  saveJob(job);
  if (opt.bg) return detach(job);
  try {
    const text = job.lane === 'oc' ? await runOc(job) : runAgy(job);
    job.status = 'done'; saveJob(job);
    out(summarize(job, text));
  } catch (e) {
    saveJob(job);
    die(`[${job.id}] ${e.message}`);
  }
}

async function cmdStatus() {
  const id = pos[0];
  if (id) {
    const j = loadJob(id);
    // live-refresh a running oc job from the server
    if (['running', 'timeout', 'stale'].includes(j.status) && j.lane === 'oc' && j.sessionId) {
      try {
        const msgs = await api('GET', `/session/${j.sessionId}/message`, null, { directory: j.dir });
        const last = msgs.filter(m => m.info?.role === 'assistant').pop();
        if (last?.info?.time?.completed) {
          j.status = 'done';
          fs.writeFileSync(outFile(j.id), textParts(msgs));
          saveJob(j);
        } else j.liveMessageCount = msgs.length;
      } catch { /* server unreachable; report stored state */ }
    }
    const text = fs.existsSync(outFile(id)) ? fs.readFileSync(outFile(id), 'utf8') : '(no output yet)';
    return out(summarize(j, text), { ...j, excerpt: text.split('\n').slice(0, 20).join('\n') });
  }
  const rows = allJobs().slice(0, 15).map(j =>
    `${j.id}  ${j.status.padEnd(7)} ${j.lane}  ${(j.agent || j.model || '').padEnd(28)} ${j.created}  ${j.task}`);
  out(rows.join('\n') || '(no jobs)', allJobs().slice(0, 15));
}

async function cmdAbort() {
  if (!pos[0]) die('usage: offload abort <jobId>');
  const j = loadJob(pos[0]);
  if (j.lane === 'oc' && j.sessionId) await api('POST', `/session/${j.sessionId}/abort`, {}, { directory: j.dir });
  j.status = 'aborted'; saveJob(j);
  out(`[${j.id}] aborted`, j);
}

async function cmdHealth() {
  let oc = 'DOWN';
  try { await api('GET', '/global/health'); oc = 'OK'; } catch { /* down */ }
  const agy = spawnSync(AGY, ['models'], { encoding: 'utf8', timeout: 15000 });
  const agyOk = agy.status === 0 ? 'OK' : 'DOWN';
  out(`opencode serve: ${oc} (${SERVER}) | agy: ${agyOk}`, { opencode: oc, agy: agyOk });
  if (oc === 'DOWN') console.error('start with: opencode serve --port 4096');
}

async function cmdAgents() {
  const agents = await api('GET', '/agent');
  const rows = agents.filter(a => !a.hidden).map(a => `${a.name.padEnd(24)} ${a.model?.modelID || ''}`);
  out(rows.join('\n'), agents.map(a => ({ name: a.name, model: a.model })));
}

function cmdModels() {
  const r = spawnSync(AGY, ['models'], { encoding: 'utf8', timeout: 15000 });
  out('agy:\n' + (r.stdout || r.stderr || 'unavailable').trim(), { agy: (r.stdout || '').trim().split('\n') });
}

function cmdChains() {
  const chains = cfg.chains || CHAINS;
  const q = quotaToday();
  const lines = Object.entries(chains).map(([t, c]) => `${t.padEnd(8)} ${c.join('  ->  ')}`);
  lines.push(`\nOpenRouter free pool today: ${q.openrouter}/${OPENROUTER_DAILY_STOP} (hard pool cap 50/day shared)`);
  out(lines.join('\n'), { chains, openrouterToday: q.openrouter, stop: OPENROUTER_DAILY_STOP });
}

function cmdSkills() {
  const found = [];
  const root = path.join(HOME, '.claude', 'skills');
  if (fs.existsSync(root)) for (const n of fs.readdirSync(root))
    if (fs.existsSync(path.join(root, n, 'SKILL.md'))) found.push(n);
  out(found.join('\n') || '(none found in ' + root + ')', found);
}

// ---------- dispatch ----------
const table = {
  oc: () => cmdRun('oc'),
  agy: () => cmdRun('agy'),
  status: cmdStatus,
  abort: cmdAbort,
  health: cmdHealth,
  agents: cmdAgents,
  models: cmdModels,
  skills: cmdSkills,
  chains: cmdChains,
  _worker: () => worker(pos[0]),
};
if (!table[cmd]) {
  console.log(`offload — run subagent work on free/external models (save Claude tokens)

  offload oc <agent> "<prompt>" --dir <abs> [--model p/m] [--bg] [--skill name] [--timeout s] [--session id] [--no-context] [--json] [--full]
  offload agy "<model label>" "<prompt>" --dir <abs> [--bg] [--skill name] [--timeout s]
  offload status [jobId] | abort <jobId> | health | agents | models | skills | chains

  oc lane fails over automatically across the tier's model chain (see 'chains');
  disable with --no-fallback or by passing an explicit --model.`);
  process.exit(cmd ? 1 : 0);
}
await table[cmd]();
