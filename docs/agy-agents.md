# agy lane: file-based agents (no prompt injection)

## Finding
agy (Antigravity CLI) natively supports agent definitions. offload currently ignores this — `runAgyOnce` (offload.mjs:553) invokes only `agy -p <prompt> --model <m>`, so all role behavior is inline-injected via `pre:`. It does **not** pass `--agent`.

## Two mechanisms to use agents at agy

### 1. `--agent <name>` (built-in library)
`agy --agent <name> -p "<task>"` — agy loads the named agent's own procedure/tools. No inline `pre:` needed.

List: `agy agents`

### 2. Import your own agent-files: `agy plugin import claude`
`agy plugin import claude` (or `gemini`) imports Claude/opencode agent definitions as agy plugins → then callable via `--agent <name>`. Lets your hand-written specs (researcher etc.) run on the agy lane w/o rewriting as inline strings.
Related: `agy plugin validate <path>`, `agy plugin list`, `agy plugin install <target>`.

## agy built-in agents matching offload roles
| offload role | agy built-in candidate |
|---|---|
| plan | `planner`, `architect`, `code-architect` |
| research | (no direct; keep custom / import) |
| explore | `code-explorer` |
| build | `architect` / `build-error-resolver` (fixes) |
| review | `code-reviewer` (+ lang: `python-reviewer`, `react-reviewer`, `go-reviewer`, `typescript-reviewer`, `rust-reviewer`…) |
| security | `security-reviewer` |
| oracle (adversarial fb) | `silent-failure-hunter`, `spec-miner`, `agent-evaluator`, `type-design-analyzer` |

Full list also has: build-error-resolver per-lang (cpp/go/java/kotlin/dart/django/react/rust/swift/pytorch), performance-optimizer, refactor-cleaner, tdd-guide, e2e-runner, doc-updater, docs-lookup, comment-analyzer, database-reviewer, network-*, a11y-architect, seo-specialist, marketing-agent, pr-test-analyzer, mle-reviewer, chief-of-staff, loop-operator, opensource-{forker,packager,sanitizer}.

## To wire into offload
Add `--agent` support in `runAgyOnce`:
```js
const args = ['-p', job.fullPrompt, '--model', job.model, '--log-file', log,
  '--print-timeout', (Number(job.timeout)||300)+'s', '--add-dir', job.dir];
if (job.agyAgent) args.push('--agent', job.agyAgent);
const res = spawnSync(AGY, args, {...});
```
Then set `agyAgent: 'code-explorer'` etc. on each agy role/fallback in ROLES. Keeps `pre:` optional (agent def carries procedure).

## TEST RESULTS (2026-07-15) — DECISION: do NOT wire --agent
Tested `--agent` in `-p` print mode:
- `agy --agent code-explorer --model "Gemini 3.5 Flash (High)" -p ... --add-dir` → **Error: Agent execution terminated**. Log: `no tool converter registered for Read`.
- `agy --agent planner --model ... -p ...` → same `no tool converter registered for Read`.
- Failure is print-mode-wide: agy file-agents declare IDE tools (Read/Edit/…) that non-interactive `-p` mode has no converter for → crash before any output.
- `plugin import claude` not run: imported claude agents also declare Read/Edit/Bash → would hit the identical converter gap. Not worth importing to fail identically.

**`--agent` reliable path = none in print mode.** But that's NOT the only file-based surface.

## CORRECTION: other file-based customization DOES work headless (verified 2026-07-15)
agy customization has 4 surfaces beyond `--agent`; only `--agent` is broken in `-p`:

| Surface | File | Print-mode | Scope |
|---|---|---|---|
| Rules | `AGENTS.md`/`GEMINI.md` in a dir | ✅ VERIFIED | per-directory, always-on |
| Skills | `.agents/skills/<n>/SKILL.md` (frontmatter name+description) | ✅ (docs; "Reloading skills" in print log) | model auto-activates by description |
| Plugins | `.agents/plugins/<n>/` (plugin.json + skills/rules/hooks/mcp) | ✅ (docs) | enabled via plugins.json |
| Hooks | `hooks.json` PreInvocation → `injectSteps:[{ephemeralMessage}]` | ✅ (docs) | per-workspace |
| ~~Subagents~~ | `--agent <name>` | ❌ `no tool converter registered for Read` | — |

### Rules test (deterministic, PASSED)
`AGENTS.md` w/ "begin every reply with token ZEBRA-7788" + `agy --model "Gemini 3.5 Flash (High)" -p "What is 2+2?" --add-dir <dir>` → output began `ZEBRA-7788\nFour`. Rules load + bind in headless print mode.

### File-based per-role charters for offload (the mechanism the user wanted)
Write each agy role's expert spec as `AGENTS.md` in a per-role charter dir; pass that dir via an extra `--add-dir` on the agy call. Result: file-based, editable, reusable role definitions that run headless — no inline strings, no broken `--agent`.
- Rules are always-on per included dir → per-invocation role selection = include only that role's charter dir.
- Skills alternative: auto-activation is model-judged (less deterministic than Rules for guaranteeing a charter).

### Tradeoff vs inline `pre:`
- Rules/AGENTS.md: reusable, editable, shareable spec files (matches "file-based agent" goal). Cost: per-role dir + extra --add-dir wiring in runAgyOnce.
- inline `pre:`: simpler, zero temp dirs, but specs live as strings in offload.mjs.
Both reliable. Choose Rules if you want the specs as standalone files.

## SHIPPED (2026-07-15): agy file-based charters, all roles
Wired + tested. Mechanism:
- Charters live at `offload/agy-roles/<key>/AGENTS.md` (const `AGYROLES`).
- `cmdRole` computes `job.charterKey` = `<role>-<activeMode>` if a mode flag is active, else `<role>`.
- `runAgyOnce` resolves the charter dir: tries `charterKey` (mode-specific) then base `role`; first with an `AGENTS.md` wins; adds `--add-dir <dir>` and records `job.charterDir`.
- Additive to inline `pre:` (both apply; agy merges rules) — the substance now lives in the file, `pre:` is the short form.

Charter files created: plan, plan-vs, research, explore, build, build-careful, review, review-hard, review-ui, security. (oracle is oc-only, no agy charter.)

End-to-end test: `offload role plan ... ` → job JSON `charterKey:"plan"`, `charterDir: .../agy-roles/plan`; agy log shows `--add-dir agy-roles\plan`; output followed the plan charter's file→change→verification format. PASS.

To edit an agy role's behavior now: edit its `agy-roles/<key>/AGENTS.md` — no code change.

## ENRICHED (2026-07-15): charters distilled from the deep oc specs
The initial charters were thin (intent-only). Rewrote 7 as faithful senior distillations of the already-deep oc agent specs (not fresh research — the oc specs ARE the crystallized expertise; distilling them satisfies the local-file-search research rule):
- `plan` ← `planner.md` (phasing, red flags, file→change→why→deps→risk→verify)
- `plan-vs` ← plan-critic + oracle adversarial method
- `review` ← `code-reviewer.md` (4-question pre-report gate, false-positive skip list, checklist, "zero findings valid")
- `review-hard` ← code-reviewer + oracle (HIGH/CRITICAL require proof)
- `review-ui` ← `ecc-ui-reviewer.md` (WCAG AA, 4 viewports, ponytail tags, AI-slop, confidence≥50)
- `security` ← `security-reviewer.md` (OWASP, pattern→severity→fix table, false-positives)
- `research` ← `researcher.md` (FRAME→GATHER≥3→ASSESS→EXTRACT→SYNTHESIZE, provenance)

The seniority levers ported (vs prior stubs): evidence/confidence gates, false-positive skip-lists, domain checklists, "zero findings is valid". `build`/`build-careful`/`explore` already were research-backed distillations (kept). `oracle` stays oc-only.

Canary (dense charter, agy-primary): `role plan` on a real offload.mjs task → job `charterDir=agy-roles/plan`, Opus read the actual code, produced an evidence table w/ file:line, and correctly caught the feature already existed instead of blindly planning. Confirms a long AGENTS.md still loads + drives behavior on agy print mode (prior PASS was only a thin charter).

**Drift caveat:** each role now has TWO expert specs — the oc `agents/<role>.md` and the agy `agy-roles/<role>/AGENTS.md`. Keep the agy charter a faithful distillation of the oc source; when you change one, check the other.
