# SETUP — for an AI coding agent

You (an AI coding agent, e.g. Claude Code) are setting up `offload` for your user
after they cloned this repo. Work through the steps **in order**, verify each
before the next, and **ask the user only for credentials/logins you cannot obtain
yourself**. When a step needs a current install command, fetch it live from the
linked docs rather than trusting memory — these tools change.

## 0. What offload is
Orchestrates coding subtasks onto external model CLIs so the user's paid-agent
quota (Claude Code etc.) is preserved. One Node file, zero npm deps. Two lanes:
- **oc** — `opencode serve` HTTP API. **Required** (most roles run here).
- **agy** — Antigravity CLI one-shots. Optional; needed for `plan`, `build --careful`, cross-family `--vs` / `review --hard`.

`offload.mjs` self-anchors: `jobs/`, `agy-roles/`, `config.json` live beside the
script, so the clone works wherever it lands (override dir w/ env `OFFLOAD_HOME`).

## 1. Prereqs
- `node -v` → must be **≥ 18**. If missing, tell the user to install Node.
- Note this repo's absolute path — you'll pass it as `--dir` in the smoke test.

## 2. opencode (oc lane) — REQUIRED
1. Install: get the current command from <https://opencode.ai/docs> (typically
   `npm i -g opencode-ai`, or the curl installer). Verify: `opencode --version`.
2. Connect a model provider. Free path = **OpenCode Zen**: run `opencode`, then
   `/connect`, choose OpenCode Zen, paste the API key from
   <https://opencode.ai/zen>. **ASK the user for this key** — you cannot create it.
3. Verify models with `/models`. The roles reference these Zen IDs:
   `opencode/deepseek-v4-flash-free`, `opencode/hy3-free`,
   `opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`.
   Note any that are absent — you'll rewire them in step 5.

## 3. Install offload's oc agents — REQUIRED
opencode loads agents from its global config dir. Copy this repo's bundled
`agents/*.md` there (create the dir first):
- Linux/macOS: `~/.config/opencode/agents/`
- Windows: `%USERPROFILE%\.config\opencode\agents\`

Verify (after step 6 starts the server): `node offload.mjs agents` lists
`researcher, explore, build, code-reviewer, security-reviewer, oracle,
ecc-ui-reviewer, planner`.

## 4. Antigravity (agy lane) — OPTIONAL (recommended)
Skip only if the user is oc-only; then `plan`/`--careful`/cross-family degrade
(`plan` falls back to the oc `planner`).
1. Install from <https://antigravity.google/docs/cli>; the installer puts `agy`
   on PATH. Verify: `agy --version` (override binary w/ env `OFFLOAD_AGY`).
2. Log in per its docs (interactive — the **user** runs it).
3. `agy models` → the roles use exact display labels, e.g.
   `Claude Opus 4.6 (Thinking)`, `Gemini 3.5 Flash (Medium)`. If the user's
   account exposes different labels, rewire in step 5.
4. Caveat: some agy builds have a `-p` print-mode stdout bug
   (github.com/google-gemini/gemini-cli#27466). If agy jobs return empty, run
   `agy update`.

## 5. Rewire model IDs to what the user can reach — CONDITIONAL
Only if step 2 or 4 showed missing models/labels. Model IDs live in **two** places:
- **`offload.mjs`** — `CHAINS` (near top) and each role's `roleModel`. Replace any
  absent `opencode/...` id with one the user's `/models` lists.
- **`agents/*.md` frontmatter** — each bundled agent's `model:` line is its default
  when no `roleModel` overrides it. All ship pointing at Zen ids; if the user's
  provider differs, repoint these too (and re-copy to opencode's agents dir, step 3).
- **agy labels** live in each role's `model:` / `defaultModel:` / `fb.model`.
  Replace with exact labels from `agy models`.
- Preserve the rule: each fallback sits in a **different quota pool** than its
  primary (agy pools: `claude` = Opus/Sonnet/GPT-OSS, `gemini` = Pro/Flash).
- Re-run `node offload.mjs roles` — must still print without error.

## 6. Start + health-check
1. Start the oc server (leave running): `opencode serve --port 4096`
   (override host/port w/ env `OFFLOAD_SERVER`).
2. `node offload.mjs health` → expect oc **up** (and agy up if installed).
3. Smoke test: `node offload.mjs role explore "list this repo's top-level files
   and what each does" --dir <this-repo-abs-path>`. Expect a real file listing,
   not an error or empty result.

## 7. Report to the user
State plainly: which lanes are live, which models are wired, any role degraded
(missing model/CLI), and the run command:
`node offload.mjs role <name> "<task>" --dir <abs-project-dir>` — list roles with
`node offload.mjs roles`.

## Must ASK the user for (never guess or fabricate)
- OpenCode Zen API key (or another opencode provider key).
- Antigravity / Google login (interactive; the user runs it).
