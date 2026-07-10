# offload

Run coding-agent subtasks on **free/cheap external models** instead of burning
your Claude Code (or other paid-CLI) quota — with the guardrails that make
delegation actually reliable.

One ~350-line Node script. No dependencies, no MCP server. Two lanes:

- **`oc`** — [opencode](https://opencode.ai) `serve` HTTP API (async, model failover)
- **`agy`** — [Google Antigravity](https://antigravity.google) CLI one-shots (Gemini / Claude / GPT-OSS)

## How it works

```
                         ┌─────────────────────────┐
   your orchestrator ───▶│   offload.mjs  (CLI)    │
   (Claude Code, etc.)   │  - require --dir        │
                         │  - inject project router│
                         │  - "don't spawn subagts"│
                         └───────────┬─────────────┘
                          route by role / lane
                    ┌────────────────┴───────────────┐
                    ▼                                 ▼
          ┌──────────────────┐              ┌──────────────────┐
          │  oc lane         │              │  agy lane        │
          │  opencode serve  │              │  agy CLI one-shot│
          │  fresh session   │              │  model verified  │
          │  tier failover ──┼── retry      │  from log        │
          │  (stale/empty/   │   next model │  quota detected  │
          │   429 → next)    │              │                  │
          └────────┬─────────┘              └────────┬─────────┘
                   └──────────────┬──────────────────┘
                                  ▼
                        jobs/<id>.json  (state)
                        jobs/<id>.out.md (result)
              compact ~20-line summary returned to orchestrator
```

## Why not the MCP bridge?

Measured on identical tasks: MCP put **~2,860 chars** into the orchestrator's
context vs **~730** via this CLI — ~**4× cheaper** first call. The MCP wrapper
was also synchronous (120s timeout froze parallel work) and had no directory
param (silent wrong-project runs). All fixed here as hard guardrails.

## Install

Node ≥ 18. Copy `offload.mjs` anywhere. Optional `config.json` beside it:

```json
{ "vault": "C:/path/to/your/notes-vault" }
```

- `oc` lane: `opencode serve --port 4096` must be running.
- `agy` lane: `agy` CLI logged in + on PATH (`OFFLOAD_AGY` to override).

## Usage

```
node offload.mjs health
node offload.mjs role <name>         "<task>" --dir <abs> [--vs claude|gemini] [--bg] [--skill s]
node offload.mjs oc   <agent>        "<task>" --dir <abs> [--model prov/model] [--bg] [--skill s]
node offload.mjs agy  "<model label>" "<task>" --dir <abs> [--bg] [--skill s]
node offload.mjs status [jobId] | abort <jobId>
node offload.mjs agents | models | skills | chains | roles
```

Flags: `--json` · `--full` (no truncate) · `--no-context` · `--session <id>` · `--router <path>`.

## Guardrails (each maps to a real incident)

1. **`--dir` required** — never runs against the wrong project.
2. **Fresh oc session per call** — avoids model-switch context overflow.
3. **Async + staleness detection** — frozen message count ≠ "still thinking"; timeout tells you to `status` before retrying.
4. **Context preamble** — anchors to abs project dir + per-project router note (`<vault>/02_Projects/<dir>.md`).
5. **Skill injection** — `--skill <name>` points the agent at a Claude-library SKILL.md by path. No copy/sync/restart.
6. **Anti-nesting** — "do NOT spawn sub-agents" on every prompt.
7. **agy honesty checks** — used model verified from log; quota exhaustion detected.
8. **Token-frugal output** — ~20-line summary; full result in `jobs/<id>.out.md`.

## Model failover (oc lane)

On stale / empty / HTTP error / rate-limit, the session is aborted and the task
re-fires down a **capability-tier chain** (max 3 attempts, fresh session each).
The agent's default is never edited; every attempt logged (`attempts[]`), answering
model shown as `via=`. Chains are data (`offload chains`), limited pools guarded.
`--no-fallback` or explicit `--model` opts out.

## Roles

`offload role <name>` = lane + primary model + preamble + fallback, stored as data
(`offload roles` to inspect). Key rules:

- One primary model per role, load spread across pools.
- oc roles head the tier chain (models float, role promise holds).
- Every fallback sits in a **different quota pool** than its primary.
- Review roles are **propose-only**; cross-family critics (`plan-critic`, `reviewer-hard`) review with the opposite model family.
- Roles earned by **canary** (verify artifacts, not self-report) — catches the silent no-op: plausible text, zero edits.

## Non-goals

No MCP, no plugin framework, no third lane until a real third CLI earns it.
Provider-side failures are surfaced, not hidden — reroute to the other lane.

## License

MIT
