# Expert Code-Builder/Implementer Agent Specification

**Research Question:** How should an expert code-builder/implementer agent in an AI coding fleet be specified? Cover: (1) core impl procedure, (2) knowledge/skills needed, (3) specialization boundary (delegate vs do), (4) ideal report format. Cover backend AND frontend in ONE generalist builder leaning on a skill library. Cite sources: Claude Code subagents, opencode, Aider, SWE-agent.

---

## Question & Scope

**Investigated:** Specification for a single generalist "builder/implementer" agent that handles both backend and frontend implementation, delegating to a skill library for domain specifics.  
**Excluded:** Architect/planner agents, reviewer agents, orchestrator agents, researcher agents — those are separate fleet roles.

---

## Summary (BLUF)

An expert builder agent should be a **single generalist implementer** with: (1) a rigid 4-step impl loop (grep→minimal-diff→style-match→verify), (2) a **skill library** for backend/frontend/framework specifics (not hardcoded knowledge), (3) a **sharp delegation boundary** — it implements, it does NOT plan/architect/review, (4) a **structured implementation report** (diff summary, tests run, files touched, follow-ups). This mirrors the "implementer-tester" subagent pattern from PubNub/Claude Code, Aider's Architect/Editor split, opencode's `build` agent with permission boundaries, and SWE-agent's ACI command loop.

---

## Findings by Theme

### 1. Core Implementation Procedure (grep-before-edit → minimal-diff → style-match → verify)

| Step | Rule | Evidence |
|------|------|----------|
| **1. Grep before edit** | Never edit without first searching the codebase for existing patterns, conventions, and the exact files to change. Use `grep`/`glob`/`read` first. | Claude Code subagents: "Explore subagent for read-only search" [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents.md); SWE-agent ACI: "search/navigation system" + "file viewer" before edit [SWE-agent paper](https://arxiv.org/abs/2405.15793) |
| **2. Minimal diff** | Make the smallest change that satisfies the requirement. No speculative refactors, no "while I'm here" edits. | Aider Architect/Editor: "Editor focuses all attention on properly formatting edits without needing to reason about the problem" [Aider Architect blog](https://aider.chat/2024/09/26/architect.html); PubNub implementer: "If refactors beyond ADR guardrails are needed, STOP and ask" [PubNub blog](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/) |
| **3. Style-match** | Match existing codebase conventions (naming, formatting, patterns) by reading adjacent files first. Never impose external style. | Aider RepoMap: "understands file relationships... identifies which methods call the modified function" [Aider DeepWiki](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system); opencode `build` agent: inherits project conventions via permissions + prompt [opencode agents](https://opencode.ai/docs/agents/) |
| **4. Verify (test/lint/build)** | Run the project's test suite, linter, type-checker, build. If any fail, iterate until green. Report exact commands run and results. | Aider: "auto_lint, auto_test, reflected_message... reflection loop for error correction" [Aider Coder Orchestration](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system); SWE-agent: "reproduce script → edit → rerun → confirm fixed" [SWE-agent default config](https://swe-agent.com/1.0/config/) |

**Confidence:** HIGH — consistent across all four sources.

---

### 2. Knowledge/Skills Needed (Skill Library, Not Hardcoded)

| Category | What the Builder Needs | Source |
|----------|------------------------|--------|
| **Repo orientation** | RepoMap / AST index / grep/glob skills to locate relevant files fast | Aider RepoMap (tree-sitter + PageRank) [AgentPatterns](https://agentpatterns.ai/context-engineering/repository-map-pattern/); SWE-agent file viewer/search commands [SWE-agent config](https://swe-agent.com/1.0/config/) |
| **Language/framework patterns** | **Loaded from skill library** — not memorized. Skills for: React/Next.js, Vue, Python/FastAPI/Django, Go, Rust, SQL, etc. | opencode: `skills` field preloads skill content at startup [opencode agents](https://opencode.ai/docs/agents/); Claude Code: `skills` field injects full skill content [Claude Code subagents](https://code.claude.com/docs/en/sub-agents.md) |
| **Test patterns** | Know how to run tests (pytest, vitest, jest, go test), write tests matching project style | Aider: `auto_test` runs project test command [Aider Coder](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system) |
| **Lint/typecheck commands** | Project-specific lint/typecheck commands (eslint, ruff, mypy, tsc, golangci-lint) | opencode permissions: `bash` allowlist for test/lint commands [opencode config](https://opencode.ai/docs/config/) |
| **Git hygiene** | Commit with conventional messages, atomic changes, no unrelated files | Aider: `aider_commit_hashes` tracks AI commits [Aider Coder](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system) |
| **Architectural guardrails** | Read ADR/guardrail files (if present) before implementing; stop if changes exceed scope | PubNub: "Architect produces ADR + guardrails; Implementer stops if refactors beyond guardrails" [PubNub blog](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/) |

**Confidence:** HIGH — all sources converge on "skills/config injected at runtime, not baked into prompt."

---

### 3. Specialization Boundary: Delegate vs Do

| **Builder DOES (implement)** | **Builder DELEGATES (does NOT do)** |
|------------------------------|--------------------------------------|
| Write/edit code files per spec | **Architecture/design decisions** — ADR creation, API contracts, data models |
| Run tests, lint, typecheck, build | **Code review** — security, performance, maintainability critique |
| Match existing code style/patterns | **Planning/spec writing** — PRD, task breakdown, sequencing |
| Fix bugs in implementation | **Research/exploration** — "find all X in codebase" → delegate to explorer |
| Update tests to match new behavior | **Release/deploy** — CI/CD, versioning, changelog |
| Write minimal docs/comments in code | **Product decisions** — "should we add feature X?" |

**Boundary rule:** If the task requires **judgment about "what" or "why"** → delegate to architect/planner/reviewer. If the task is **"how to implement a given spec"** → builder does it.

**Evidence:**
- PubNub pipeline: `pm-spec` → `architect-review` (ADR) → `implementer-tester` (code+tests) [PubNub blog](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- Aider Architect/Editor split: Architect reasons, Editor implements [Aider Architect](https://aider.chat/2024/09/26/architect.html)
- opencode: `build` (primary, all tools) vs `plan` (read-only, edit denied) [opencode agents](https://opencode.ai/docs/agents/)
- SWE-agent: Single agent does search+edit+test but config enforces "minimal changes to non-test files" [SWE-agent default config](https://swe-agent.com/1.0/config/)

**Confidence:** HIGH — clear separation across all four systems.

---

### 4. Ideal Implementation Report Format

The builder returns a **structured markdown report** (not free text) with these sections:

```markdown
## Implementation Report: <slug>

### Summary
- **Spec/ADR ref:** <link or slug>
- **Change type:** feat|fix|refactor|test
- **Files changed:** N (list)
- **Tests:** X passed, Y failed (command run)

### Diff Summary
<unified diff or summary of key changes per file>

### Verification
- **Test command:** `npm test` / `pytest` / `go test ./...`
- **Lint command:** `npm run lint` / `ruff check` / `golangci-lint run`
- **Typecheck:** `tsc --noEmit` / `mypy` / `go vet`
- **Build:** `npm run build` / `cargo build` / `go build`
- **All green?** ✅/❌ (if ❌, list failures)

### Follow-ups (for architect/reviewer)
- [ ] Item needing architectural review
- [ ] Tech debt noted (ponytail: comment)
- [ ] Test coverage gaps
```

**Evidence:**
- PubNub: "Implementer summarizes changes; sets status DONE if green" [PubNub blog](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- Aider: Tracks `aider_commit_hashes`, `total_cost`, shows diff on commit [Aider Coder](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system)
- SWE-agent: `submit` command requires diff review + reproduction script re-run [SWE-agent config](https://swe-agent.com/1.0/config/)

**Confidence:** HIGH — consistent structured handoff pattern.

---

## Contradictions & Open Questions

| Issue | Sources | Resolution |
|-------|---------|------------|
| **Single agent vs Architect/Editor split** | Aider uses 2-model split (Architect+Editor) for SOTA benchmarks; others use 1 generalist builder | **Recommendation:** Single generalist builder + skill library for cost/latency; offer Architect/Editor as optional "high-stakes" mode |
| **RepoMap vs agentic search** | Aider uses precomputed RepoMap; Claude Code uses on-demand grep/glob; SWE-agent uses custom commands | **Recommendation:** Builder uses skill-injected search patterns (grep/glob/read) — no external index dependency |
| **Test writing responsibility** | PubNub: implementer writes tests; Aider: can auto-test; SWE-agent: "don't modify test files" | **Recommendation:** Builder writes/updates tests matching existing patterns; never modifies test *logic* specified in spec |

---

## Limitations

- Did not deeply analyze Cursor/Windsurf/Codex agent configs (closed source)
- SWE-agent now in maintenance mode; mini-swe-agent not fully reviewed
- opencode v2 config schema still evolving (permissions V2)
- No benchmark comparison of single-agent vs Architect/Editor on real fleet tasks

---

## Sources

| Source | Type | Date Accessed | Key Artifact |
|--------|------|---------------|--------------|
| [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents.md) | Official docs | 2026-07-15 | Subagent schema, tools, skills, delegation |
| [PubNub Best Practices](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/) | Practitioner blog | 2026-07-15 | 3-agent pipeline (PM→Architect→Implementer) |
| [opencode Agents](https://opencode.ai/docs/agents/) | Official docs | 2026-07-15 | Agent config: mode, permissions, model, steps |
| [opencode Config](https://opencode.ai/docs/config/) | Official docs | 2026-07-15 | Permission rules, agent merging |
| [Aider Core Architecture](https://deepwiki.com/Aider-AI/aider/2-core-architecture) | DeepWiki | 2026-07-15 | Coder class, RepoMap, 3-tier models |
| [Aider Architect Mode](https://aider.chat/2024/09/26/architect.html) | Official blog | 2026-07-15 | Architect/Editor split, SOTA benchmarks |
| [Aider Coder Orchestration](https://deepwiki.com/Aider-AI/aider/2.2-coder-orchestration-system) | DeepWiki | 2026-07-15 | Reflection loop, file tracking, git integration |
| [SWE-agent Paper](https://arxiv.org/abs/2405.15793) | NeurIPS 2024 | 2026-07-15 | ACI design, commands, context management |
| [SWE-agent Config](https://swe-agent.com/1.0/config/) | Official docs | 2026-07-15 | Default YAML config, templates, tools |
| [AgentPatterns RepoMap](https://agentpatterns.ai/context-engineering/repository-map-pattern/) | Pattern catalog | 2026-07-15 | Tree-sitter + PageRank + token fitting |

---

## Actionable Spec Bullets (Copy-Paste Ready)

### Agent Definition (opencode/Claude Code style)
```yaml
name: builder
description: "Implements code per spec/ADR. Runs tests/lint/build. Returns structured report. Use proactively for implementation tasks."
mode: primary
model: anthropic/claude-sonnet-4-5  # or project default
skills:
  - backend-patterns
  - frontend-patterns
  - react-patterns
  - python-patterns
  - golang-patterns
  - database-migrations
  - testing-patterns
  - verification-loop
permission:
  edit: allow
  bash: allow
  read: allow
  grep: allow
  glob: allow
  task: deny          # no subagent spawning
  skill: allow        # can invoke skills
steps: 50             # generous step budget for impl+verify loop
```

### System Prompt (Condensed)
```
You are the BUILDER/IMPLEMENTER. Your job: implement the given spec/ADR with minimal, style-matched diffs.

RULES:
1. GREP FIRST — search codebase for patterns, existing files, conventions before ANY edit
2. MINIMAL DIFF — smallest change satisfying spec. No refactors beyond guardrails.
3. STYLE MATCH — mimic adjacent files: naming, formatting, imports, error handling
4. VERIFY — run project test/lint/typecheck/build commands. Iterate until ALL green.
5. REPORT — return structured markdown report (see format below). No chatter.

DELEGATION BOUNDARY:
- You IMPLEMENT. You do NOT: architect, review, plan, research, decide product scope.
- If spec is ambiguous or requires design judgment → STOP, report ambiguity, request clarification.
- If refactor beyond ADR guardrails needed → STOP, report, request architect review.

SKILLS: Use preloaded skills for framework patterns. Invoke `skill` tool for domain specifics.
```

### Verification Loop (Pseudo-code)
```python
def verify_loop():
    while True:
        run_tests()
        run_lint()
        run_typecheck()
        run_build()
        if all_green: break
        else: fix_failure_and_retry(max_3_iterations)
```

### Report Template (Required Output)
```markdown
## Implementation Report: <slug>

### Summary
- Spec/ADR: <ref>
- Change type: <feat|fix|refactor|test>
- Files changed: <N> (<list>)
- Tests: <X passed, Y failed> — cmd: `<cmd>`

### Diff Summary
<per-file unified diff or concise change list>

### Verification
- Test: `<cmd>` → ✅/❌
- Lint: `<cmd>` → ✅/❌
- Typecheck: `<cmd>` → ✅/❌
- Build: `<cmd>` → ✅/❌

### Follow-ups
- [ ] <item for architect/reviewer>
```

---

*End of spec. Ready for fleet integration.*