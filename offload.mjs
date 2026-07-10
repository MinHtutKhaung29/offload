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
  // zai-glm removed from build (implementation) chain 2026-07-06: silent no-op
  // canary fail (writes nothing, returns plausible text). Kept in review chain
  // — review output IS text, so the failure mode doesn't apply there.
  build:   ['opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'opencode/nemotron-3-ultra-free', 'groq/llama-3.1-8b-instant', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'],
  explore: ['opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'groq/llama-3.1-8b-instant'],
  // north-mini-code-free REMOVED 2026-07-08: canary-confirmed dead (2/2 probes,
  // zero output parts on trivial PONG, empty completion) — do not re-add without retest.
  review:  ['opencode/deepseek-v4-flash-free', 'cerebras/zai-glm-4.7'],
  plan:    ['google/gemini-3.1-pro-preview', 'opencode/mimo-v2.5-free'],
  heavy:   ['nvidia/deepseek-ai/deepseek-v4-pro', 'google/gemini-3.1-pro-preview'],
};
const AGENT_TIER = {
  build: 'build', general: 'build', 'backend-developer': 'build', 'ecc-frontend-builder': 'build', 'refactor-cleaner': 'build',
  explore: 'explore', 'docs-lookup': 'explore', 'doc-updater': 'explore',
  'code-reviewer': 'review', oracle: 'review', 'ecc-ui-reviewer': 'review',
  planner: 'plan', 'security-reviewer': 'heavy',
  'e2e-runner': 'build', 'build-error-resolver': 'build',
};
const MAX_ATTEMPTS = 3;
const OPENROUTER_DAILY_STOP = 45; // pool is 50/day shared with agents we don't see

// Specialized roles (v1.2) — one primary model per role, load spread across
// pools, every fallback in a DIFFERENT pool. agy is 2 quota pools, not 6
// models: 'gemini' (3.1 Pro + 3.5 Flash) and 'claude' (Opus + Sonnet +
// GPT-OSS) — fallbacks must cross pools. oc roles ride the tier chains;
// `roleModel` heads the chain (does not disable it, unlike user --model).
// `noEdit` appends PROPOSE ONLY (agy agents edit files unasked — RULES.md #5).
// `crossFamily` roles pick the opposite family of the work's author (--vs).
// Full self-contained researcher spec for the AGY lane. agy has no agent-file
// mechanism (unlike oc's agents/researcher.md), so the one-shot prompt IS the
// whole agent — this embeds the SAME specialization the oc agent file carries
// (methodology, provenance, output contract), one-shot-CLI-optimized per the
// 2026-07-08 agent-design research: absolute paths, explicit output contract,
// hard stop condition. Tool guidance differs from oc: agy Gemini reads PDFs
// NATIVELY (no pypdf step). Keep this in sync with agents/researcher.md.
const RESEARCHER_SPEC_AGY = [
  'RESEARCHER. Process over conclusions: every claim traced, confidence calibrated, contradictions reported.',
  'Before start: check skills library, invoke relevant skill. Don\'t wait for skill name.',
  'WORKFLOW: (1) FRAME question(s), one sentence each, state scope. (2) GATHER 3+ independent sources, different types; follow references in best sources; never skip a contradicting source. (3) ASSESS each source HIGH/MEDIUM/LOW (authority, recency, purpose); Wikipedia/AI summaries = navigation only, never cite as evidence. (4) EXTRACT own words but copy numbers/dates/caveats VERBATIM; record source+location per claim. (5) SYNTHESIZE by THEME not source; state agreement/disagreement + conditions. (6) WRITE file, stop.',
  'WEB READING: prefer `firecrawl scrape "<url>"` (clean markdown, handles JS) over plain fetch; `firecrawl search "<query>"` = search+content in one call. Fallback: native fetch on firecrawl error. Cite page, never snippet.',
  'PDFs/books: read natively, FULLY, chunked if long, running notes. Never summarize from partial read.',
  'OUTPUT: ONE markdown file at given absolute path. Create exactly there, no filesystem search. Sections: Question & scope / Summary (BLUF) / Findings by theme (claim -> citation [source, title, date, URL] -> confidence HIGH|MODERATE|LOW|SPECULATIVE) / Contradictions & open questions / Limitations / Sources (list + retrieval date). Exclude raw snippets, tool logs, speculation-as-fact. Never "proves" without 2+ independent HIGH sources.',
  'BOUNDARIES: no edits except findings file. No build/git/install commands. No sub-agents. Code edits/decisions needed -> stop, report "out of researcher scope".',
  'DONE WHEN: findings file exists, all sections populated, every claim cited. Final message: 3-5 line summary + file path. Nothing else.',
].join('\n');

const ROLES = {
  planner:           { lane: 'agy', model: 'Gemini 3.1 Pro (High)', pool: 'gemini', fb: { lane: 'oc', agent: 'planner' },
    pre: 'PLANNER. Concrete step-by-step implementation plan: files, order, risks, verification. No implementation.' },
  'plan-critic':     { lane: 'agy', crossFamily: true, defaultModel: 'GPT-OSS 120B (Medium)', pool: 'claude', noEdit: true, fb: { lane: 'oc', agent: 'oracle' },
    pre: 'PLAN CRITIC. Adversarial review: find flaws, risks, missing steps, better alternatives.' },
  // researcher rebuilt 2026-07-08: dedicated agents/researcher.md (Nemotron 3 Ultra
  // primary — canary-passed PDF extraction 2/2; least-loaded Zen model). Fan-out
  // pattern: researcher + researcher2 (DeepSeek Flash) + researcher3 (agy Gemini,
  // native PDF) = 3 model families, load spread across pools.
  researcher:        { lane: 'oc', agent: 'researcher', roleModel: 'opencode/nemotron-3-ultra-free', fb: { lane: 'agy', model: 'Gemini 3.5 Flash (Low)', pool: 'gemini' },
    pre: 'RESEARCHER. Task: one sentence first, then details. Rules: cite every claim inline (source, date, URL); confidence HIGH/MODERATE/LOW; report contradictions, never false consensus; copy numbers verbatim; synthesize by theme not source; write ONE findings markdown file at given path, stop. No edits to existing files. PDFs: extract via python pypdf to <name>_extracted.txt, read that; empty extraction = scanned, report "needs vision lane", move on.' },
  researcher2:       { lane: 'oc', agent: 'researcher', roleModel: 'opencode/deepseek-v4-flash-free', fb: { lane: 'agy', model: 'Gemini 3.5 Flash (Low)', pool: 'gemini' },
    pre: 'RESEARCHER. Task: one sentence first, then details. Rules: cite every claim inline (source, date, URL); confidence HIGH/MODERATE/LOW; report contradictions, never false consensus; copy numbers verbatim; synthesize by theme not source; write ONE findings markdown file at given path, stop. No edits to existing files. PDFs: extract via python pypdf to <name>_extracted.txt, read that; empty extraction = scanned, report "needs vision lane", move on.' },
  researcher3:       { lane: 'agy', model: 'Gemini 3.5 Flash (Medium)', pool: 'gemini', fb: { lane: 'oc', agent: 'researcher' },
    pre: RESEARCHER_SPEC_AGY },
  explorer:          { lane: 'oc', agent: 'explore',
    pre: 'EXPLORER. Locate and explain code/files relevant to question. Read-only. Report paths + findings.' },
  // NOTE: zai-glm-4.7 canary-FAILED as frontend primary 2026-07-06 (2/2 silent
  // no-ops: returned a task restatement, edited nothing — undetectable by
  // failover since output is non-empty). Do not give glm implementation roles.
  frontend:          { lane: 'oc', agent: 'ecc-frontend-builder',
    pre: 'FRONTEND BUILDER. Implement UI/HTML/CSS/JS changes. Match existing style, design tokens.' },
  backend:           { lane: 'oc', agent: 'backend-developer',
    pre: 'BACKEND BUILDER. Implement server/API/data logic changes. Include error handling.' },
  'builder-careful': { lane: 'agy', model: 'Claude Sonnet 4.6 (Thinking)', pool: 'claude', fb: { lane: 'agy', model: 'Gemini 3.5 Flash (High)', pool: 'gemini' },
    pre: 'CAREFUL BUILDER. Risky multi-file changes. Think before edit. Minimal, consistent changes. Re-check each edit.' },
  reviewer:          { lane: 'oc', agent: 'code-reviewer', noEdit: true,
    pre: 'CODE REVIEWER. Review code/diff: bugs, quality, maintainability. Report findings ranked by severity.' },
  'reviewer-hard':   { lane: 'agy', crossFamily: true, defaultModel: 'Claude Opus 4.6 (Thinking)', pool: 'claude', noEdit: true, fb: { lane: 'oc', agent: 'oracle' },
    pre: 'ADVERSARIAL REVIEWER. High-stakes work. Actively find what\'s wrong or risky. Challenge assumptions.' },
  security:          { lane: 'oc', agent: 'security-reviewer', noEdit: true, fb: { lane: 'agy', model: 'Claude Opus 4.6 (Thinking)', pool: 'claude' },
    pre: 'SECURITY REVIEWER. Audit vulnerabilities: injection, auth, secrets, OWASP Top 10. Report findings with severity.' },
  'ui-critic':       { lane: 'oc', agent: 'ecc-ui-reviewer', noEdit: true,
    pre: 'UI CRITIC. Evaluate visual design, layout, UX quality. Report concrete issues + improvements.' },
  tester:            { lane: 'oc', agent: 'e2e-runner',
    pre: 'TESTER. Write and/or run tests for described behavior. Report pass/fail with evidence.' },
  'build-fixer':     { lane: 'oc', agent: 'build-error-resolver',
    pre: 'BUILD FIXER. Diagnose build/test failure. Apply MINIMAL fix. No refactor.' },
  cleaner:           { lane: 'oc', agent: 'refactor-cleaner', roleModel: 'opencode/nemotron-3-ultra-free',
    pre: 'CLEANER. Remove dead code, tidy structure. No behavior change.' },
  'doc-writer':      { lane: 'oc', agent: 'doc-updater',
    pre: 'DOC WRITER. Write/update docs to match reality. Concise, accurate.' },
};
// cross-family pick: the reviewer must be a different model family than the
// work's author. --vs <family-of-author> selects the opposite side.
const CROSS_FAMILY = {
  claude: { model: 'Gemini 3.1 Pro (High)', pool: 'gemini' },
  gemini: { model: 'Claude Opus 4.6 (Thinking)', pool: 'claude' },
};

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
  if (a === '--bg' || a === '--json' || a === '--full' || a === '--no-context' || a === '--no-fallback') opt[a.slice(2)] = true;
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

function buildPrompt(task, dir, role) {
  const lines = [];
  if (role?.pre) lines.push(`ROLE: ${role.pre}`);
  if (role?.noEdit) lines.push('PROPOSE ONLY. No file edits, no state-changing commands. Text output only.');
  lines.push(`Project dir: ${dir}`);
  lines.push('Read files at given absolute paths directly. No filesystem search outside this dir.');
  const router = routerFor(dir);
  if (router) lines.push(`Read project router first: ${router} — purpose, structure, plans, current state. Follow it.`);
  for (const s of opt.skill) {
    const p = resolveSkill(s);
    if (!p) die(`skill not found in Claude library: ${s}`);
    lines.push(`Invoke ${s} skill. Also read: ${p}. Apply it.`);
  }
  lines.push('');
  lines.push('TASK:');
  lines.push(task);
  lines.push('');
  lines.push('Do this yourself. No sub-agents, no delegate tool. Short steps.');
  return lines.join('\n');
}

// ---------- output shaping (token frugality) ----------
function summarize(job, text) {
  fs.writeFileSync(outFile(job.id), text || '(empty response)');
  const lines = (text || '').trim().split('\n');
  const excerpt = lines.length > 20 ? lines.slice(0, 20).join('\n') + `\n... (${lines.length - 20} more lines)` : lines.join('\n');
  const via = job.finalModel && job.finalModel !== '(agent default)' ? ` via=${job.finalModel}` : '';
  const role = job.role ? ` role=${job.role}` : '';
  const head = `[${job.id}] ${job.status} | lane=${job.lane}${role} agent=${job.agent || job.model}${via} | full output: ${outFile(job.id)}`
    + (job.verifyNote ? `\n${job.verifyNote}` : '');
  if (opt.json) return { id: job.id, status: job.status, lane: job.lane, verify: job.verifyNote, outFile: outFile(job.id), excerpt };
  return head + '\n' + (opt.full ? text : excerpt);
}

// ---------- verification (evidence, not self-report) ----------
// Snapshot `git status --porcelain` at job creation; diff it after completion.
// Catches: no-edit agents that edited anyway (mimo 2026-07-08), and "silent
// no-op" builders that report success but changed nothing (zai-glm class).
function gitSnapshot(dir) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? (r.stdout || '') : null; // null = not a git repo
}
const EDIT_ROLES_HINT = /build|fix|clean|frontend|backend|doc-writer|tester/;
// New porcelain lines since job creation (files the job created/modified).
// [] when not a git repo or on snapshot failure — caller can't distinguish
// "no changes" from "can't tell", so only use this to CONFIRM a write, never
// to assert none happened.
function changedFiles(job) {
  if (job.gitBefore == null) return [];
  const after = gitSnapshot(job.dir);
  if (after == null) return [];
  const before = new Set(job.gitBefore.split('\n').filter(Boolean));
  return after.split('\n').filter(Boolean).filter(l => !before.has(l));
}
function verifyJob(job) {
  if (job.gitBefore == null) return; // not a repo — nothing to check
  if (gitSnapshot(job.dir) == null) return;
  const changed = changedFiles(job);
  job.filesChanged = changed;
  if (job.noEdit && changed.length) {
    job.verifyNote = `⚠️ VERIFY: agent MODIFIED FILES despite propose-only: ${changed.slice(0, 5).join(' | ')}${changed.length > 5 ? ` (+${changed.length - 5} more)` : ''} — inspect/revert before trusting the report`;
  } else if (!job.noEdit && !changed.length && EDIT_ROLES_HINT.test(job.role || job.agent || '')) {
    job.verifyNote = '⚠️ VERIFY: implementation-type job finished with ZERO file changes — possible silent no-op; check the output against reality';
  } else if (changed.length) {
    job.verifyNote = `verify: ${changed.length} file(s) changed: ${changed.slice(0, 5).join(' | ')}${changed.length > 5 ? ' …' : ''}`;
  }
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

// live diagnosis for a session: what tool is it stuck in, and is a
// permission ask pending? (the 2026-07-08 external_directory hang looked
// like 9 model failures until this info was pulled out by hand)
async function liveState(job) {
  const bits = [];
  try {
    const perms = await api('GET', '/permission', null, { directory: job.dir });
    const mine = (perms || []).filter(p => !job.sessionId || p.sessionID === job.sessionId);
    for (const p of mine.slice(0, 2))
      bits.push(`⏸ BLOCKED: pending "${p.permission}" permission ask (${(p.patterns || []).join(', ')}) — headless serve cannot approve; fix opencode.jsonc permission config`);
  } catch { /* endpoint absent on older serve */ }
  try {
    const msgs = await api('GET', `/session/${job.sessionId}/message`, null, { directory: job.dir });
    const last = msgs.filter(m => m.info?.role === 'assistant').pop();
    const tools = (last?.parts || []).filter(p => p.type === 'tool');
    const open = tools.find(t => t.state?.status && t.state.status !== 'completed');
    if (open) {
      const secs = open.state?.time?.start ? Math.round((Date.now() - open.state.time.start) / 1000) : '?';
      bits.push(`⏳ in tool "${open.tool}" (${open.state.status}, ${secs}s) input=${JSON.stringify(open.state?.input || {}).slice(0, 120)}`);
    } else if (last && !last.info?.time?.completed) {
      bits.push(`⏳ generating (parts: ${(last.parts || []).map(p => p.type).join(',') || 'none yet'})`);
    }
  } catch { /* ignore */ }
  return bits.join('\n');
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

async function diagSuffix(job) {
  const d = await liveState(job);
  return d ? ` — DIAGNOSIS: ${d.replace(/\n/g, ' | ')}` : '';
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
      if (!text.trim()) {
        // Some models (e.g. Nemotron 3 Ultra) end a turn on a terminal tool
        // call — they do the work and write the output file but emit no closing
        // text part. Treat that as success IF a file actually appeared, so the
        // real deliverable isn't discarded as "empty". Only trusts a positive
        // git signal; a non-repo dir still counts as empty (can't confirm).
        const wrote = changedFiles(job);
        if (wrote.length) return `(no chat summary emitted; wrote ${wrote.length} file(s): ${wrote.slice(0, 3).map(l => l.replace(/^\s*\S+\s+/, '')).join(' | ')})`;
        const e = new Error('empty response'); e.kind = 'empty'; throw e;
      }
      return text;
    }
    if (Date.now() - lastChange > staleMs) { const e = new Error(`no session activity for ${staleMs / 1000}s${await diagSuffix(job)}`); e.kind = 'stale'; throw e; }
    if (Date.now() - start > timeoutMs) { const e = new Error(`no completion after ${timeoutMs / 1000}s${await diagSuffix(job)}`); e.kind = 'timeout'; throw e; }
  }
}

async function runOc(job) {
  // model plan: explicit --model or --no-fallback = single attempt; a
  // role-supplied model HEADS the chain (fallback stays active); otherwise
  // agent default first, then the tier chain (skipping chain[0] = the default)
  let models;
  if (job.modelStr || job.noFallback) models = [job.modelStr || job.roleModel];
  else {
    const chain = (cfg.chains || CHAINS)[AGENT_TIER[job.agent] || 'build'] || CHAINS.build;
    const orBlocked = quotaToday().openrouter >= OPENROUTER_DAILY_STOP;
    const base = job.roleModel
      ? [job.roleModel, ...chain.filter(m => m !== job.roleModel)]
      : [undefined, ...chain.slice(1)];
    models = base.filter(m => {
      if (m && orBlocked && m.startsWith('openrouter/')) {
        console.error(`offload: skipping ${m} (OpenRouter free pool at ${quotaToday().openrouter}/day, stop=${OPENROUTER_DAILY_STOP})`);
        return false;
      }
      return true;
    }).slice(0, MAX_ATTEMPTS);
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
  const xlane = job.fb?.lane === 'agy' ? ` | cross-lane fallback (your call): offload agy "${job.fb.model}" "<task>" --dir ${job.dir}` : '';
  throw new Error(`all ${job.attempts.length} attempt(s) failed [${job.attempts.map(a => `${a.model}:${a.outcome}`).join(', ')}]. Last: ${lastErr.message}. Check offload status ${job.id} before retrying.${xlane}`);
}

// ---------- agy lane ----------
// same-LANE fallback only (agy -> agy across quota pools). Cross-lane
// failover stays the orchestrator's decision — we print the exact command.
function runAgy(job) {
  try {
    const text = runAgyOnce(job);
    if (job.attempts) job.attempts.push({ model: job.model, outcome: 'ok' });
    return text;
  } catch (e) {
    const outcome = job.status === 'quota' ? 'quota' : 'error';
    if (!job.noFallback && job.fb?.lane === 'agy' && job.fb.model && job.fb.model !== job.model) {
      (job.attempts ??= []).push({ model: job.model, outcome });
      console.error(`offload: [${job.id}] ${job.model} failed (${outcome}) — failing over to ${job.fb.model} (cross-pool)`);
      job.model = job.fb.model;
      job.fb = undefined; // one same-lane retry only
      job.status = 'running';
      saveJob(job);
      return runAgy(job);
    }
    if (job.fb?.lane === 'oc') {
      e.message += ` | cross-lane fallback (your call): offload oc ${job.fb.agent} "<task>" --dir ${job.dir}`;
    }
    throw e;
  }
}

function runAgyOnce(job) {
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
    verifyJob(job);
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
    noFallback: !!opt['no-fallback'],
    task: task.slice(0, 200),
    fullPrompt: buildPrompt(task, dir),
    skills: opt.skill,
    noEdit: /propose only|do not edit|don't edit/i.test(task),
    gitBefore: gitSnapshot(dir),
  };
  saveJob(job);
  return execJob(job);
}

async function execJob(job) {
  if (opt.bg) return detach(job);
  try {
    const text = job.lane === 'oc' ? await runOc(job) : runAgy(job);
    job.status = 'done';
    verifyJob(job);
    saveJob(job);
    out(summarize(job, text));
  } catch (e) {
    saveJob(job);
    die(`[${job.id}] ${e.message}`);
  }
}

// ---------- role command (v1.2 specialized agents) ----------
async function cmdRole() {
  const roles = { ...ROLES, ...(cfg.roles || {}) };
  const [name, ...rest] = pos;
  const role = roles[name];
  if (!role) die(`unknown role: ${name || '(none)'}. Available: ${Object.keys(roles).join(', ')}`);
  const dir = opt.dir && path.resolve(opt.dir);
  if (!dir) die('--dir <absolute project path> is required');
  if (!fs.existsSync(dir)) die('--dir does not exist: ' + dir);
  const task = rest.join(' ');
  if (!task) die(`usage: offload role ${name} "<prompt>" --dir <abs> [--bg] [--skill s] [--vs claude|gemini] [--timeout s]`);

  let agyModel = role.model;
  if (role.crossFamily) {
    const pick = opt.vs && CROSS_FAMILY[opt.vs];
    if (opt.vs && !pick) die('--vs must be claude or gemini (the family that AUTHORED the work under review)');
    agyModel = pick ? pick.model : role.defaultModel;
  }

  const job = {
    id: newId(), lane: role.lane, dir, status: 'running', created: now(),
    role: name,
    agent: role.lane === 'oc' ? role.agent : undefined,
    model: role.lane === 'agy' ? agyModel : undefined,
    roleModel: role.lane === 'oc' ? role.roleModel : undefined,
    fb: role.fb,
    timeout: opt.timeout,
    noFallback: !!opt['no-fallback'],
    attempts: [],
    task: task.slice(0, 200),
    fullPrompt: buildPrompt(task, dir, role),
    skills: opt.skill,
    noEdit: !!role.noEdit || /propose only|do not edit|don't edit/i.test(task),
    gitBefore: gitSnapshot(dir),
  };
  saveJob(job);
  return execJob(job);
}

function cmdRoles() {
  const roles = { ...ROLES, ...(cfg.roles || {}) };
  const lines = Object.entries(roles).map(([n, r]) => {
    const primary = r.lane === 'agy' ? (r.crossFamily ? `cross-family (default ${r.defaultModel})` : r.model)
      : `${r.agent}${r.roleModel ? ` @ ${r.roleModel}` : ' (agent default + tier chain)'}`;
    const fb = r.fb ? (r.fb.lane === 'agy' ? `agy ${r.fb.model}` : `oc ${r.fb.agent} (manual)`) : 'tier chain';
    return `${n.padEnd(16)} ${r.lane.padEnd(4)} ${primary.padEnd(48)} fb: ${fb}${r.noEdit ? '  [propose-only]' : ''}`;
  });
  out(lines.join('\n'), roles);
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
          verifyJob(j);
          saveJob(j);
        } else j.liveMessageCount = msgs.length;
      } catch { /* server unreachable; report stored state */ }
    }
    let text = fs.existsSync(outFile(id)) ? fs.readFileSync(outFile(id), 'utf8') : '(no output yet)';
    if (j.status === 'running' && j.lane === 'oc' && j.sessionId) {
      const d = await liveState(j);
      if (d) text = d + '\n' + text;
    }
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
  role: cmdRole,
  roles: cmdRoles,
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

  offload role <name> "<prompt>" --dir <abs> [--bg] [--skill name] [--vs claude|gemini] [--timeout s]
  offload oc <agent> "<prompt>" --dir <abs> [--model p/m] [--bg] [--skill name] [--timeout s] [--session id] [--no-context] [--json] [--full]
  offload agy "<model label>" "<prompt>" --dir <abs> [--bg] [--skill name] [--timeout s]
  offload status [jobId] | abort <jobId> | health | agents | models | skills | chains | roles

  'role' = specialized agents with per-role model routing + fallback (see 'roles').
  oc lane fails over automatically across the tier's model chain (see 'chains');
  disable with --no-fallback or by passing an explicit --model.`);
  process.exit(cmd ? 1 : 0);
}
await table[cmd]();
