# Expert ORACLE Agent Specification: Adversarial Fallback Consultant

**Generated:** 2026-07-15 | **Sources:** 15+ | **Confidence:** HIGH

---

## Question & Scope

**Research question:** How should an expert ORACLE agent (high-reasoning adversarial fallback consulted when primary plan/review agents fail or need a second opinion) be specified?

**In scope:** Invocation triggers, procedure, adversarial/critical method, knowledge requirements, specialization boundary vs planner/reviewer, output format.

**Out of scope:** Implementation code, specific model provider configs, UI/UX details.

---

## Summary (BLUF)

An ORACLE agent is a **read-only, high-reasoning, escalation-only consultant** invoked when primary agents (planner, reviewer, executor) hit architectural ambiguity, debugging dead-ends, or risk-critical decisions. It operates in a **fresh subagent context** with **no write tools**, **no delegation ability**, and **temperature ~0.1** for deterministic reasoning. Its adversarial method: assume the current plan/implementation is flawed until proven otherwise; challenge assumptions, surface hidden risks, and produce a structured verdict (PROCEED / REVISE / ESCALATE) with file:line evidence. It is distinct from the Planner (creates plans) and Reviewer (quality-gates implementations) by being **consultative not generative**, **escalation-only not default-gate**, and **architecture/risk-focused not code-quality-focused**.

---

## Findings by Theme

### 1. When Invoked + Procedure

| Trigger | Source |
|---------|--------|
| **Architecture tradeoffs** — competing valid designs, no clear winner | opencode-codex-orch AGENTS.md: "Read-only escalation consultant for architecture/debugging/risk" |
| **Hard debugging** — root cause unknown after primary agent attempts | oh-my-opencode Debugging and Consultation: "Strategic consultation, architecture decisions, hard debugging" |
| **Security/performance/data-integrity risk analysis** | opencode-codex-orch README: "Oracle — escalation-only consultant for architecture tradeoffs, hard debugging, and security/performance/data-integrity risk analysis" |
| **Plan feels "correct but dead"** — team stuck, consensus too fast | wildwasser/opencode-agents: "Jester challenges... when a plan feels 'correct' but dead; everyone agrees too quickly (dangerous!)" |
| **Complex refactor >5 files** or risky architectural change | wildwasser/opencode-agents: "Call Jester when: Complex refactors touching >5 files; Risky architectural changes" |
| **Reviewer/Planner disagreement** or low-confidence verdict | Cross-model adversarial review pattern: escalate after 3 failed builder-critic cycles |

**Procedure (consistent across sources):**
1. **Spawn fresh subagent** — never inline; clean context prevents rationalization bias (oh-my-opencode Architecture Critic: "The review runs in a fresh subagent — never inline. Dispatching it is the whole point.")
2. **Feed only artifacts** — spec/plan/diff + read-only repo access; **no backstory, no reasoning trace** (Architecture Critic: "The critic does NOT receive the design's backstory. Pass the spec + proposed design + read-only repo access. Do NOT paste the brainstorming conversation.")
3. **High-reasoning model** — GLM-5, GPT-5.4, or equivalent with extended reasoning budget (opencode-codex-orch: Oracle uses `glm-5` temp 0.1; oh-my-opencode: "EXPENSIVE" cost tier, high-reasoning models)
4. **Read-only tools only** — denied: `write`, `edit`, `task`, `call_oco_agent` (opencode-codex-orch AGENTS.md tool restrictions)
5. **Return structured verdict** — not implementation

---

### 2. Adversarial / Critical Method

| Principle | Source |
|-----------|--------|
| **Assume broken until proven otherwise** — "Assume the code is broken until the evidence proves otherwise" | ASDLC Critic Pattern |
| **Fresh context = fresh eyes** — same-context review reproduces generator's rationalizations | Cross-model adversarial review: "A model reviewing its own code is not checking the code against the spec; it is checking whether the code looks like it was generated correctly" |
| **Cross-model diversity** — different model family than builder/reviewer | Cross-model adversarial review: "Never use the same model as both builder and critic"; ng/adversarial-review uses Optimizer + Skeptic (different models) |
| **Explicit failure-mode priming** — prompt lists known rationalization patterns to avoid | ng/adversarial-review: "Anti-rationalization guards — explicitly naming rubber-stamping and lazy disagreement as failure modes, listing invalid verdict bases" |
| **Evidence-gated verdicts** — every finding requires file:line evidence; no evidence = guess | ng/adversarial-review: "Evidence-gated verdicts — no evidence means the verdict is a guess, labeled accordingly" |
| **Structured adversarial personas** — Auditor (compliance), Adversary (break it), Pragmatist (cost/benefit) | adverse-review skill: "Spawns three reviewer subagents (Auditor, Adversary, Pragmatist) on a single model, runs a cross-examination round" |
| **Debate loop for high stakes** — multi-round cross-critique | alecnielsen/adversarial-review: "Round 1: Independent reviews; Round 2: Cross-review; Round 3: Meta-review; Round 4: Synthesis" |
| **Signal gate / numeric anchors** — limit verbosity, force concise findings | ng/adversarial-review: "Numeric output anchors — Optimizer findings ≤50 words, suggested fixes ≤30 words, Skeptic challenges ≤50 words" |

**Oracle-specific adversarial stance:** Unlike code reviewers, Oracle challenges **assumptions, architecture, and risk** — not implementation defects. It asks: "What if this design is wrong? What fails under load? What did the planner miss?"

---

### 3. Knowledge Needed

| Domain | Depth | Source |
|--------|-------|--------|
| **System architecture patterns** — distributed systems, data consistency, failure modes, scaling boundaries | Expert | opencode-codex-orch: "architecture tradeoffs"; oh-my-opencode: "strategic consultation, architecture decisions" |
| **Security threat modeling** — authz/authN, injection, supply chain, data exfiltration | Expert | opencode-codex-orch: "security/performance/data-integrity risk analysis" |
| **Performance engineering** — latency budgets, throughput, capacity planning, bottleneck analysis | Expert | opencode-codex-orch: "performance risk analysis" |
| **Data integrity / transactional semantics** — ACID, eventual consistency, migration safety | Expert | opencode-codex-orch: "data-integrity risk analysis" |
| **Debugging methodology** — hypothesis-driven, binary search, observability correlation | Expert | oh-my-opencode: "hard debugging problems" |
| **Cross-model reasoning differences** — know failure modes of primary models (Claude, GPT, Gemini) | Working | Cross-model adversarial review: different models catch different blind spots |
| **Project-specific context** — read-only access to repo, specs, ADRs, CLAUDE.md constitution | Runtime | Architecture Critic: "Pass the spec + proposed design + read-only repo access" |
| **Escalation criteria** — when to say "needs human" vs "revise plan" | Defined | Cross-model adversarial review: "After 3 failures: escalate to human" |

**Key constraint:** Oracle **does not need** implementation-level framework knowledge (React, Django, etc.) — that's for Executor/Librarian. It needs **architectural judgment**.

---

### 4. Specialization Boundary vs Planner / Reviewer

| Dimension | **Planner** | **Reviewer** | **Oracle** |
|-----------|-------------|--------------|------------|
| **Role** | Creates plans, decomposes tasks | Quality gate on implementations/plans/reports | Escalation consultant for architecture/debugging/risk |
| **Trigger** | User request / new feature | Every PR / plan completion / report | On-demand: ambiguity, dead-end, high risk, disagreement |
| **Mode** | `primary` (user-facing) | `subagent` (default quality gate) | `subagent` (escalation-only, hidden from picker) |
| **Tools** | Full (write, edit, task, bash) | Read + write (for fixes in auto-fix mode) | **Read-only** (denied: write, edit, task, call_oco_agent) |
| **Delegation** | Yes — spawns executors, researchers | No (but can request re-review) | **No** — cannot spawn subagents |
| **Output** | Plan / task list | PASS/FAIL + findings list | **Verdict: PROCEED / REVISE / ESCALATE** + reasoning |
| **Model** | High-end (GPT-5.4 xhigh) | Balanced (k2p5, GLM-5) | **Highest-reasoning** (GLM-5, GPT-5.4, temp 0.1) |
| **Context** | Full conversation history | Spec + diff + tests | **Fresh context** — only artifacts + repo read access |
| **Cost tier** | Standard | Standard | **EXPENSIVE** (oh-my-opencode cost matrix) |
| **Specialization** | Task decomposition, sequencing | Code quality, spec compliance, test coverage | **Architecture tradeoffs, root-cause, risk analysis** |

**Critical distinction:** Planner *generates*; Reviewer *validates*; Oracle *adjudicates* when the first two disagree or hit a wall. Oracle is **not a default gate** — it's a **break-glass consultant**.

---

### 5. Output Format

**Structured verdict (required):**

```markdown
## ORACLE VERDICT: [PROCEED | REVISE | ESCALATE]

### Trigger
- Invoked by: [agent/session]
- Reason: [architecture tradeoff / debugging dead-end / risk analysis / planner-reviewer disagreement]
- Artifacts reviewed: [spec.md, plan.md, diff, ADR-XXX]

### Findings (evidence-gated)
| # | Category | Severity | File:Line | Evidence | Assessment |
|---|----------|----------|-----------|----------|------------|
| 1 | Architecture | HIGH | spec.md:42 | "Assumes single-leader DB" | Violates multi-region requirement |
| 2 | Security | CRITICAL | auth.ts:15 | Token stored in localStorage | XSS exfiltration vector |
| 3 | Performance | MEDIUM | query.sql | N+1 in user feed | 100ms → 2s at scale |

### Reasoning
[Concise adversarial analysis: what assumptions are fragile, what fails under load, what the planner missed]

### Recommendation
- **PROCEED** — risks accepted, mitigations documented
- **REVISE** — specific changes required before proceed (list)
- **ESCALATE** — human architect/security review needed (reason)

### Confidence
[HIGH / MODERATE / LOW] — based on evidence completeness and cross-model agreement
```

**Format rules (from ng/adversarial-review & adverse-review):**
- One finding per row, file:line mandatory
- Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO
- Categories: Architecture, Security, Performance, Data Integrity, Operational, Spec Drift
- Max 50 words per finding description
- Verdict must be explicit — no "it depends"

---

## Contradictions & Open Questions

| Issue | Sources | Status |
|-------|---------|--------|
| **Single-model vs multi-model Oracle** — oh-my-opencode uses one high-reasoning model; ng/adversarial-review and cross-model review insist on different model families | oh-my-opencode vs ng/adversarial-review vs cross-model review | **Open** — multi-model adds cost/latency but catches correlated blind spots |
| **Oracle as "Jester" (wildcard) vs structured consultant** — wildwasser uses high-temp (0.8) chaotic oracle; others use low-temp (0.1) deterministic | wildwasser/opencode-agents vs opencode-codex-orch vs oh-my-opencode | **Resolved** — Oracle = low-temp consultant; Jester = separate high-temp wildcard role |
| **Escalation threshold** — 3 failures (cross-model) vs "when stuck" (wildwasser) vs explicit triggers (opencode-codex-orch) | Cross-model review vs wildwasser vs opencode-codex-orch | **Open** — needs project-specific policy |
| **Whether Oracle sees planner/reviewer reasoning** — Architecture Critic says NO; some patterns feed full context | Architecture Critic vs general practice | **Resolved** — Oracle must NOT see reasoning (fresh eyes principle) |

---

## Limitations

- **No direct Oracle prompt source** — opensoft/oh-my-opencode oracle.ts scrape failed; inferred from AGENTS.md + Debugging and Consultation docs
- **opencode-codex-orch** is a Codex-focused fork; may not reflect upstream oh-my-opencode Oracle behavior exactly
- **Adversarial review patterns** primarily documented for code review; Oracle applies to architecture/debugging — extrapolation required
- **Model-specific configs** (GLM-5, k2p5, etc.) are vendor-specific and will rot; spec should use capability tiers not model IDs
- **Cost/latency data** for Oracle-tier models not publicly available

---

## Sources

1. **opencode-codex-orch AGENTS.md** — Agent inventory, Oracle config (glm-5, temp 0.1, subagent, read-only tools, purpose: "Read-only escalation consultant for architecture/debugging/risk") — https://github.com/allOwO/opencode-codex-orch/blob/main/src/agents/AGENTS.md
2. **opencode-codex-orch README** — Review/advisory roles: "Oracle — escalation-only consultant for architecture tradeoffs, hard debugging, and security/performance/data-integrity risk analysis" — https://github.com/allOwO/opencode-codex-orch
3. **oh-my-opencode Debugging and Consultation (DeepWiki)** — Oracle agent overview: mode=subagent, cost=EXPENSIVE, "Strategic consultation, architecture decisions, hard debugging" — https://deepwiki.com/code-yeongyu/oh-my-openagent/9.4-debugging-and-consultation
4. **oh-my-opencode Oracle Agent (DeepWiki)** — Factory config: createOracleAgent, mode=subagent, temp=0.1, read-only, non-delegating — https://deepwiki.com/code-yeongyu/oh-my-opencode/4.5.2-oracle:-architecture-consultant
5. **Architecture Critic Skill (nima-karami/agentic-development)** — "Review runs in fresh subagent — never inline. Critic does NOT receive design's backstory. Pass spec + design + read-only repo access." — https://github.com/nima-karami/agentic-development/blob/main/skills/architecture-critic/SKILL.md
6. **Cross-Model Adversarial Review (Daniel Vaughan)** — "Never use same model as builder and critic. Fresh session. Evidence-gated verdicts. After 3 failures: escalate to human." — https://codex.danielvaughan.com/2026/03/28/cross-model-adversarial-review
7. **ng/adversarial-review (GitHub)** — Dual Optimizer/Skeptic agents, anti-rationalization guards, evidence-gated verdicts, numeric output anchors, signal gate — https://github.com/ng/adversarial-review
8. **adverse-review Skill (addyosmani)** — Three personas (Auditor, Adversary, Pragmatist), cross-examination round, deterministic synthesis — https://skillsmp.com/creators/addyosmani/adverse/skills-adverse-review
9. **ASDLC Critic Pattern** — "Assume broken until proven otherwise. Read spec before diff. Structured verdict: PASS/PASS WITH NOTES/FAIL." — https://asdlc.io/recipes/critic
10. **alecnielsen/adversarial-review** — 4-phase debate loop: independent review → cross-review → meta-review → synthesis — https://github.com/alecnielsen/adversarial-review
11. **wildwasser/opencode-agents** — Jester agent: high-temp (0.8) wildcard oracle for "complex refactors >5 files, risky changes, team stuck, consensus too fast" — https://github.com/wildwasser/opencode-agents
12. **ASDLC Adversarial Code Review Practice** — Process: fetch context → gather artifacts → load contracts → adversarial review (skeptical by design) → violations + verdict — https://asdlc.io/practices/adversarial-code-review/
13. **ClawHub Adversarial Code Review** — Three-agent pattern (Builder, Reviewer, Meta-Reviewer), cross-model diversity, priming trick ("AI agent likely introduced bugs"), versioned critique cycle — https://clawhub.ai/reikys/adversarial-code-review
14. **AgentDesk Adversarial Review (DEV Community)** — Dual independent reviewers, substantive quality check (citations required), consensus engine — https://dev.to/rih0z/why-ai-agent-outputs-need-adversarial-review-and-how-to-add-it-in-one-api-call-42ho
15. **OpenCode Agents Docs** — Built-in agent modes: build (primary), plan (primary), general (subagent), explore (subagent, read-only), scout (subagent, read-only) — https://opencode.ai/docs/agents/

---

## Actionable Spec Bullets (for implementation)

### Invocation
- [ ] Expose `oracle` as hidden subagent (picker `hidden: true`), invokable via `@oracle` mention or orchestrator delegation
- [ ] Triggers: architecture decision deadlock, debugging >2 failed attempts, security/perf/data-integrity risk flagged, planner↔reviewer disagreement, "plan feels correct but dead"
- [ ] Block trivial invocations (typos, config changes, docs-only)

### Procedure
- [ ] Spawn fresh subagent session (no parent context)
- [ ] Inject: spec/plan/diff + read-only repo access (Glob, Grep, Read, Bash(read-only))
- [ ] Deny tools: `write`, `edit`, `task`, `call_oco_agent`, `todo`
- [ ] Model: highest-reasoning available (capability tier, not model ID), temp 0.1
- [ ] Timeout: 120s max; budget: 50k tokens max

### Adversarial Method
- [ ] System prompt: "You are an adversarial architecture consultant. Assume the current design/plan is flawed. Your job is to find what breaks, what was missed, what fails under load. Every finding must cite file:line. Output structured verdict only."
- [ ] Explicit anti-rationalization list: "Do not accept: 'it looks correct', 'tests pass', 'standard practice', 'we can fix later'"
- [ ] Evidence gate: findings without file:line = INVALID
- [ ] Categories: Architecture, Security, Performance, Data Integrity, Operational, Spec Drift

### Knowledge
- [ ] Pre-load: project CLAUDE.md/constitution, ADRs, architecture docs (read-only)
- [ ] Runtime access: full repo read (Glob, Grep, Read)
- [ ] No external search (that's Librarian) — Oracle reasons from evidence

### Boundary
- [ ] NOT a planner — does not create tasks or decompose work
- [ ] NOT a reviewer — does not gate every PR; only escalation
- [ ] NOT an executor — zero write capability
- [ ] NOT a delegator — cannot spawn subagents

### Output
- [ ] Structured markdown verdict (PROCEED/REVISE/ESCALATE)
- [ ] Findings table with file:line, severity, category, evidence
- [ ] Confidence calibration (HIGH/MODERATE/LOW)
- [ ] Max 5 findings; if more, batch as "ESCALATE — systemic issues"

---

*End of specification*