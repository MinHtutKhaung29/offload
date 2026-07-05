# offload

Run coding-agent subtasks on **free/cheap external models** instead of your
Claude Code (or other paid-CLI) quota — with the orchestration guardrails
that make delegation actually reliable.

One ~350-line Node script, no dependencies, no MCP server. Two lanes:

- **`oc`** — [opencode](https://opencode.ai) `serve` HTTP API (async-native via `prompt_async`)
- **`agy`** — [Google Antigravity](https://antigravity.google) CLI one-shots (Gemini / Claude / GPT-OSS models)

## Why not the MCP bridge?

Measured on identical tasks (2026-07-06): an MCP-based delegation put
**~2,860 chars** into the orchestrator's context (first call, incl. minimal
tool-schema load) vs **~730 chars** via this CLI — roughly **4× cheaper on
the first call, 1.6× steady-state** — and the savings compound because the
orchestrator's context is usually the expensive one. Beyond tokens, the MCP
wrapper we replaced was synchronous (120s client timeout; wide parallel
blocks freeze the calling session) and had no directory parameter (silent
wrong-project execution). Every one of those failure modes is a hard
guardrail here.

## Install

Requires Node ≥ 18. Copy `offload.mjs` anywhere (e.g. `~/.config/offload/`).
Optional `config.json` next to it:

```json
{ "vault": "C:/path/to/your/notes-vault" }
```

For the `oc` lane, `opencode serve --port 4096` must be running.
For the `agy` lane, the `agy` CLI must be logged in and on PATH
(override with `OFFLOAD_AGY`). Server URL override: `OFFLOAD_SERVER`.

## Usage

```
node offload.mjs health
node offload.mjs oc  <agent>          "<task>" --dir <abs-project-path> [--model provider/model] [--bg] [--skill name] [--timeout s]
node offload.mjs agy "<model label>"  "<task>" --dir <abs-project-path> [--bg] [--skill name] [--timeout s]
node offload.mjs status [jobId]
node offload.mjs abort <jobId>
node offload.mjs agents | models | skills
```

Flags: `--json` machine output · `--full` don't truncate · `--no-context`
skip the router preamble · `--session <id>` reuse an oc session ·
`--router <path>` explicit context file.

## What it bakes in (each maps to a real incident)

1. **`--dir` is required** — delegated work can never silently run against
   the wrong project.
2. **Fresh oc session per call** — reusing sessions across model switches
   overflows small-context models and surfaces as a useless generic error.
3. **Async-native** — uses the server's own `prompt_async` + polling with
   staleness detection (a frozen message count for 10 min ≠ "still
   thinking"). Foreground timeout tells you to check `status` **before**
   retrying, because the server may still be working and a blind retry
   duplicates the work.
4. **Context preamble** — every prompt is anchored to the absolute project
   dir ("do not search the filesystem") and, if found, a per-project
   "router" note at `<vault>/02_Projects/<dirname>.md` (or `projects.json`
   mapping) so the agent understands the project, not just the task.
5. **Skill injection** — `--skill <name>` resolves a skill from your Claude
   Code library (`~/.claude/skills/`, plugins) and instructs the agent to
   read that SKILL.md by absolute path. No copying, no registry sync, no
   server restart. Canary-proven: agents quote the file's section headings
   verbatim.
6. **Anti-nesting** — "do NOT spawn sub-agents" is appended to every prompt
   (nested delegation is the #1 hang cause we hit).
7. **agy honesty checks** — the actually-used model is verified from agy's
   log (never trust self-report; wrong `--model` strings silently fall back
   to a different model), and quota exhaustion is detected and reported so
   you can reroute to the other lane.
8. **Token-frugal output** — compact ~20-line summary + job id; full agent
   output lands in `jobs/<id>.out.md` for on-demand reading.

## Automatic model failover (oc lane)

Free-model pools fail in boring ways: a model hangs mid-generation, returns
empty, or rate-limits. The oc lane retries across a **capability-tier chain**
(max 3 attempts, fresh session each): on stale (frozen message count),
timeout, empty response, HTTP error, or rate-limit, the session is aborted
and the same task re-fires with the next model as a per-call override — the
agent's configured default is never edited. Every attempt is recorded in the
job JSON (`attempts: [{model, outcome}]`) and the answering model is shown
as `via=` in the output. Chains are data (see `offload chains`), overridable
per-tier in `config.json`; limited pools are guarded (a daily counter stops
OpenRouter free-pool use at 45/50 shared). Disable with `--no-fallback`, or
pass an explicit `--model` (your choice is respected, no chain).

## Job model

Every run writes `jobs/<id>.json` (state) and `jobs/<id>.out.md` (result).
`--bg` detaches immediately (poll with `status`). `status <id>` live-refreshes
running/timed-out oc jobs from the server. `abort <id>` also aborts the
server-side oc session.

## Non-goals

No MCP protocol, no plugin framework, no third lane until a real third CLI
earns it. Provider-side failures (free-model empty responses, pool outages,
quotas) are surfaced, not fixed — reroute to the other lane; that's why
there are two.

## License

MIT
