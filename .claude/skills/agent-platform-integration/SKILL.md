---
name: agent-platform-integration
description: Use when adding a new agent-platform "cognitive backend" adapter to CallingClaw (e.g. Raven, opencode, Cursor, Gemini CLI) — a new value in the AgentPlatform union that shells out to a CLI agent for prep/recall/task/timeline work — or when a "successful" install / green unit tests / a "registered" MCP server still produce a dead or wrong integration (zero tools registered, errors swallowed, hallucinated tool calls). Covers the wiring checklist, config-schema discovery, the end-to-end acceptance bar (independent review + real-tool-call E2E), and the permission/sandbox model each adapter must declare.
---

# Agent Platform Integration

## Overview

CallingClaw's core value (voice, audio, screen, meeting lifecycle) lives in the REST/WS API on `localhost:4000`. The **cognitive backend** — meeting prep, context recall, task execution, timeline processing, post-meeting delivery — is abstracted behind the `AgentAdapter` interface (`callingclaw-backend/src/agent-adapter.ts`). Adding a new platform (opencode, Cursor, Gemini CLI, …) means writing one more `AgentAdapter` implementation plus its onboarding scripts, held to the same bar as the shipped adapters (`openclaw`, `claude-code`, `codex`, `hermes`, and now `raven`).

**Core principle:** a new adapter is a thin, fault-isolated wrapper that (1) shells out to an external CLI agent for cognition, (2) reuses the agent-agnostic OC-protocol prompts, (3) schedules with the internal timer (never external cron), and (4) proves itself end-to-end by having the *external agent actually invoke a `callingclaw-events` MCP tool that round-trips to the live backend*.

**The hard-won meta-lesson: "green unit tests" ≠ "works".** This skill is battle-tested against five onboardings (`openclaw`, `claude-code`, `codex`, `hermes`, and `raven`). In the Raven integration, the implementing agent's own tests were all green, the install "succeeded," and the MCP server was "registered" — yet the integration was **dead** (zero tools actually registered, see below). Two independent checks — an adversarial code review and a real-inference E2E — *each* caught a distinct blocker that the passing tests missed. The acceptance bar therefore requires BOTH: an independent review with an explicit verdict AND an E2E that asserts a real tool *call* happened (not just that the agent ran, not just that a schema looked right).

**Three pillars** (all three are required before an adapter is "done"):
1. Coding workflow — the ordered wiring checklist (incl. config-schema discovery)
2. End-to-end acceptance criteria — the uniform bar: independent review + real-tool-call E2E + the checklist
3. Permission-restriction model (权限限制) — sandbox/tool-scoping each adapter declares

Reference implementations to copy from (in order of closeness to the CLI-shell-out pattern): **codex** (`src/adapters/codex-adapter.ts`) is the fullest, then **hermes** (`hermes-adapter.ts`), then **claude-code** (`claude-code-adapter.ts`). `standalone-adapter.ts` is the no-external-agent fallback. Pick the closest match to the new CLI's invocation shape and copy it verbatim, then adjust. (`raven-adapter.ts` is the newest; see the Raven notes at the end for the traps it fell into.)

## Discovery FIRST: never trust an assumed config schema

Before writing the setup script or the MCP-registration path, **read the installed agent's own source** (its `schema.py` / config model / CLI `--help`) and **validate your generated config against the tool's own loader**. Config schemas are easy to guess WRONG and a wrong guess can silently or fatally break the integration:

- **Casing and nesting are not guessable.** Raven's design doc assumed `mcpServers` (camelCase, top-level). The real key is `mcp_servers` (snake_case) — and it is **not top-level**; it is nested under `tools.mcp_servers`. The root config uses pydantic `extra="forbid"`, so a wrong top-level key **bricks config load entirely** (hard failure, not a warning).
- **Key casing can differ *within the same file*.** Raven's provider block uses `providers.<name>.apiKey` (camelCase, via a pydantic alias generator) even though sibling keys are snake_case. Confirm exact casing from source for every key you emit.
- **Validate, don't hope.** After generating the config, load it through the tool's own validator (e.g. `python -c "from raven...config import Config; Config.model_validate(<yaml>)"`) before shipping the setup script. A config that "looks right" but fails `model_validate` is a shipped bug.

## The Shared Subprocess Pattern (copy this exactly)

Every CLI-shell-out adapter (hermes/codex/claude-code) follows the same private `run<Agent>()` runner. Reproduce all of it — each element exists because something broke without it:

| Element | What it does | Where to see it |
|---|---|---|
| **`Bun.spawn`** | Launch the CLI. `stdout:"pipe", stderr:"pipe"`, `cwd = ~/.callingclaw/shared`, `env:{...process.env}`. Bun, never Node `child_process` for the run path. | `hermes-adapter.ts:268`, `codex-adapter.ts:278` |
| **`Promise.race` timeout** | Race `new Response(proc.stdout).text()` against a `setTimeout` that rejects. Per-task timeouts: recall 30s, task 60s, prep 120s, executeTodo 300s. | `hermes-adapter.ts:276-286`, `claude-code-adapter.ts:267-278` |
| **Process cleanup (no zombies)** | On timeout, call `proc.kill()` **inside** the timeout callback before rejecting, and `clearTimeout` in `.finally()`. | `codex-adapter.ts:289-295` (see comment "#16: Kill orphan subprocess on timeout" in `claude-code-adapter.ts:272`) |
| **Lazy model-env reads** | Model selection is a `() => process.env.X \|\| default` **function**, called per-run — so `.env` changes apply without a backend restart. Never read the env into a module constant. | `hermes-adapter.ts:45-49`, `codex-adapter.ts:51-53` |
| **Bin resolution** | `resolve<Agent>Bin()`: `<AGENT>_BIN` env override first (also lets tests point at a stub), then `which`, then known bundle/install path (e.g. `/Applications/Codex.app/Contents/Resources/codex`, `~/.local/bin/hermes`), then bare name for PATH. | `codex-adapter.ts:37-47`, `hermes-adapter.ts:33-40` |
| **`connect()` health-check** | Spawn `<bin> --version`; if stdout is non-empty set `_connected = true` and log `[<Adapter>] Connected (<version>)`; else throw `"<Platform> not available: …"`. | all three adapters, `connect()` |
| **Exit-code handling** | After `await proc.exited`, throw on **any** non-zero exit — do NOT use the reference adapters' `exitCode !== 0 && !output` guard verbatim. That guard swallows the error when the CLI **exits non-zero with the error message on STDOUT** (as Raven does: exit 1, `Error: …` on stdout), returning the error text as if it were a valid answer. Throw `"<cli> exited <code>: <stderr\|stdout>.slice(0,500)"` whenever `exitCode !== 0`. **Add an error-path unit test** — happy-path-only tests hid this exact blocker; an independent review caught it. | `hermes-adapter.ts:290-296` (has the flawed guard — improve on it) |
| **Final-answer extraction** | Depends on the CLI's output contract: hermes `-z` → plain stdout; codex → `--output-last-message <file>` (stdout is event-log noise); claude `-p --output-format json` → `JSON.parse(stdout).result`. Know your CLI's contract. **`--no-markdown`/`--no-logs` do NOT guarantee clean output**: Raven still emits ANSI color codes plus a structlog + `🐦‍⬛ Raven` banner preamble on stdout even with those flags. The adapter must **strip ANSI** (regex `\x1b\[[0-9;]*m` + set `NO_COLOR=1`/`TERM=dumb` in `env`) AND extract the real answer out of the preamble (skip the banner/log lines), not just `.trim()` stdout. | `codex-adapter.ts:301-315`, `claude-code-adapter.ts:285-291` |
| **CostMeter usage record** | After a successful run, call `recordUsage({ component: "agent", model: opts.model || "<name>", meta: { adapter: "<name>" } })` from `../modules/cost-meter`. Plain-text CLIs emit no usage block, so tokens stay unknown — but the call still has to be COUNTED or `/api/cost` under-reports the whole agent component. Fail-soft by design. | `hermes-adapter.ts` / `codex-adapter.ts` / `claude-code-adapter.ts`, end of the runner |
| **OC-protocol prompt reuse** | prep→`OC001_PROMPT`, executeTodo→`OC006_PROMPT`, processTimeline→`OC010_PROMPT` from `src/openclaw-protocol.ts`. They are agent-agnostic. recallContext builds an inline prompt and appends `LANGUAGE_RULE` from `src/prompt-constants.ts`. Do NOT invent new prompts. | every adapter's cognitive methods |
| **Internal scheduling** | `new InternalJobScheduler(onJobFire)` in the constructor; `scheduleJob`/`cancelJob` delegate to it; `disconnect()` calls `scheduler.stop()`. **Never** an external cron. Jobs persist to `~/.callingclaw/scheduled-jobs.json` and reload on restart. | `agent-adapter.ts:161-240` |
| **Delivery** | `deliverTodos` writes markdown to `~/.callingclaw/shared/notes/<meetingId>_todos.md` + fires an `osascript` notification, returns `true`/`false`. `deliverSummary` fires an `osascript` notification, returns `true`. (OpenClaw's Telegram path is the exception, not the template.) | `codex-adapter.ts:150-202` |
| **Activity feed (optional)** | `onActivity(fn)` stores the callback; cognitive methods emit `this._onActivity?.("adapter.prep_start", …)` etc. | `hermes-adapter.ts:100-127,242-244` |

---

## Pillar 1 — Coding Workflow (ordered wiring checklist)

Do these in order. Each `[ ]` is one step; steps (a)–(c) are the backend, (d)–(g) are scripts/tests, (h)–(j) are config/docs.

- [ ] **(a) Union** — add `"<name>"` to the `AgentPlatform` union in `src/agent-adapter.ts:30`.
- [ ] **(b) Factory** — add a `case "<name>":` to `createAgentAdapter()` (`src/agent-adapter.ts:244`) that `require`s and returns `new <Name>Adapter(deps?.onJobFire)`. Match the existing arg convention (CLI adapters take only `onJobFire`; openclaw also takes `openclawBridge`).
- [ ] **(c) Adapter** — create `src/adapters/<name>-adapter.ts` implementing **every** `AgentAdapter` member, and call `recordUsage(...)` in the runner (see the CostMeter row above). Copy the closest reference adapter and swap the runner. Full member list (all required except `onActivity`):

  | Member | Contract |
  |---|---|
  | `name` | `readonly "<name>" as const` |
  | `connected` | getter over private `_connected` |
  | `connect()` | `<bin> --version` health-check → set `_connected` or throw |
  | `disconnect()` | `scheduler.stop()` + `_connected = false` |
  | `generateMeetingPrep(opts)` | `OC001_PROMPT`, prep model, 120s → returns brief string |
  | `recallContext(query, localContext?)` | inline prompt + `LANGUAGE_RULE`, recall model, 30s, <500 words |
  | `executeTask(instruction)` | raw instruction as prompt, task model, 60s |
  | `scheduleJob(opts)` | delegate to `scheduler.schedule` → returns job id |
  | `cancelJob(jobId)` | delegate to `scheduler.cancel` |
  | `deliverTodos(opts)` | write notes md + osascript notify → `boolean` |
  | `deliverSummary(opts)` | osascript notify → `boolean` |
  | `executeTodo(opts)` | `OC006_PROMPT`, task model, 300s |
  | `processTimeline(opts)` | `OC010_PROMPT`, prep model, 120s |
  | `onActivity?(fn)` | optional — store callback for streaming deltas |

- [ ] **(d) Setup script** — `scripts/setup-<name>.sh`. Must, idempotently: (1) locate/install the CLI (mirror `setup-hermes.sh`'s install-if-missing or `setup-codex.sh`'s locate-only), (2) register the `callingclaw-events` MCP server into the agent's **own** config (`plugins/callingclaw-events/index.ts` run under `bun`, with `env` `CALLINGCLAW_HTTP=http://localhost:4000` + `CALLINGCLAW_URL=ws://localhost:4000/ws/events`), (2b) **install the agent's MCP-client dependency into the agent's OWN env** — see the warning below, (3) `bun install --silent` inside `plugins/callingclaw-events`, (4) set `AGENT_PLATFORM=<name>` in `.env` (grep-then-`sed -i ''`-or-append — the idempotent pattern used by all three). Registration mechanics differ per agent: codex uses `codex mcp remove … || true` then `codex mcp add`; claude-code uses `claude mcp remove/add --scope user`; hermes edits `~/.hermes/config.yaml` via Python/PyYAML; raven seeds a provider + model and the MCP server into `~/.raven/config.json`'s nested `tools.mcp_servers`. Use whatever the new agent provides; the *remove-then-add* re-registration is what makes it idempotent and path-correct. First **read the tool's config source** to get the schema right (see "Discovery FIRST" above) and **validate the config you write** against the tool's own loader before considering registration done.

  > **BIGGEST TRAP — the undeclared MCP-client dependency (Raven, the dead integration).** Raven does **not declare the `mcp` Python package as a dependency**, yet it imports it *lazily* and **silently swallows the `ImportError`** — so with a "successful" install and a "registered" MCP server, the integration registered **ZERO tools** and no-oped with **no error surfaced anywhere**. A green install + a registered server can still be a completely dead integration. The setup script MUST explicitly install the MCP-client dep into the agent's own environment (`pipx inject <agent> mcp`, or the agent venv's `pip install mcp`, or equivalent) AND then **verify tools actually register** (query the agent for its live tool list / list MCP tools) — do not assume registration implies loaded. This is verifiable in the E2E: the real tool CALL (Pillar 2) fails hard if tools didn't register.
- [ ] **(e) Start script** — `scripts/start-<name>.sh`. Locate the bin, export any keys from `.env`, warn (don't fail) if `localhost:4000` isn't up, then `exec` the agent — passing through args for one-shot mode. Mirror `start-hermes.sh`.
- [ ] **(f) E2E test** — `scripts/e2e-<name>.ts`. See Pillar 2 — this is the real bar.
- [ ] **(g) Unit test** — `test/adapters/<name>-adapter.test.ts`. Copy `codex-adapter.test.ts`: a fake CLI shell script on a temp dir that answers `--version` and records argv; point the adapter at it via `<AGENT>_BIN`; assert model flags, prompt content, scheduler round-trip, and `deliverTodos` file write. Import the adapter **after** setting env so lazy reads see stub values. **Include an ERROR-PATH test** (do not ship happy-path only): a stub that exits non-zero with `Error: …` on **stdout** must make the cognitive method **throw**, not return the error string as an answer. Happy-path-only tests are exactly what hid the Raven exit-code blocker; the error-path test is the regression guard.
- [ ] **(h) `.env.example`** — add a `# ─── <Name> (OPTIONAL — used when AGENT_PLATFORM=<name>) ───` block with `<AGENT>_BIN` and per-task model overrides, matching the codex/hermes blocks (`.env.example:42-57`). Also add `<name>` to the two comment lines listing platforms (`.env.example:33-34`).
- [ ] **(i) Docs** — update `README.md` (add a platform subsection like the Hermes one at README:274) and `CLAUDE.md` (the "Agent platform (cognitive backend)" section lists platforms + one line per platform).
- [ ] **(j) Auto-detect (optional)** — add a probe to the `_detectedPlatform` IIFE in `callingclaw.ts:98-133`, respecting priority order (config-file existence check and/or `which <bin>`). Place it consistent with the documented order. Skip if the platform should be opt-in only.

---

## Pillar 2 — End-to-End Acceptance Criteria (the uniform bar)

An adapter is NOT done until all of these pass. **Green unit tests are necessary but not sufficient** — in the Raven onboarding, all the implementer's tests passed while two separate blockers (swallowed non-zero-exit error; zero MCP tools registered) shipped anyway. The bar therefore has TWO independent gates on top of the checklist, because each caught a distinct blocker the other missed:

- **(A) Independent adversarial code review with an explicit verdict.** A reviewer that did NOT write the code reviews the diff and returns a machine-readable **PASS / CHANGES-REQUIRED** verdict. "Looks fine" is not a verdict; the review must name specific issues or explicitly pass. The Raven review is what caught the exit-code-on-stdout blocker that the happy-path tests hid.
- **(B) A real-inference E2E that asserts a real tool CALL + a real backend response.** Not stub-only, not the model *claiming* it called a tool, not a hallucinated answer. Use a **unique per-run marker** the model cannot guess (see below). The E2E is what catches "zero tools registered" — if the MCP tools never loaded, the real tool call cannot happen and the marker never appears.

The load-bearing check is (B): it must prove the *external agent genuinely invoked a `callingclaw-events` MCP tool AND the tool result reflects the REAL running backend* — not a stub, not the model paraphrasing.

### Concrete acceptance checklist that WOULD have caught the Raven blockers

Every one of these must be satisfied before "done". Each maps to a blocker that green tests missed:

- **(a) Independent code review, explicit PASS / CHANGES-REQUIRED verdict** — reviewer ≠ implementer; verdict names issues or explicitly passes. *(caught: exit-code-on-stdout)*
- **(b) E2E asserts a REAL tool call + REAL backend response** — machine-transcript shows the `callingclaw_*` tool was invoked AND the result carries a **unique per-run marker** (see below), so it can't be stub output or a hallucination. *(caught: zero-tools-registered / dead integration)*
- **(c) Error-path test** — non-zero exit / error-on-stdout makes the cognitive method THROW, not return the error as an answer. *(caught: swallowed error)*
- **(d) MCP tools actually register (not silently zero)** — the setup/E2E verifies the agent's live tool list contains the `callingclaw_*` tools; a "registered" server with 0 loaded tools is a failure, not a pass. *(caught: undeclared `mcp` dep silently ImportError'd)*
- **(e) Typecheck clean** — `bunx tsc --noEmit`, no new errors.
- **(f) Idempotent setup that installs any undeclared MCP-client deps** — runs twice as a no-op; explicitly installs the agent's MCP-client dependency into the agent's own env (don't assume the agent ships it).

### The unique per-run marker (how to prove B is real, not hallucinated)

The old "assert the live `version` string" check is good but a model *could* plausibly guess a version like `2.9.x`. Strengthen it with a marker the model cannot fabricate: before the run, POST a unique token (e.g. a UUID or `run-${Date.now()}`) into the backend's event/state (or read a value the backend computes fresh per boot), then require that exact token to appear in the tool result / final answer. A hallucinating model cannot produce a token it never saw; a stub backend "would never produce" it. Combine with the live-`version` assertion below — both, not either.

### The key e2e assertion pattern (from `e2e-codex.ts` / `e2e-claude-code.ts`)

The proof-of-liveness has **two independent halves**, both required:

1. **Tool was genuinely invoked** — parse the agent's own machine-readable transcript (codex `--json` `item.completed`; claude `--output-format stream-json` `tool_use` blocks) and assert the `callingclaw_*` tool name appears. Do NOT accept the model merely *saying* it called the tool.
2. **Result reflects the LIVE backend** — the test first reads `GET /api/status` from the real backend and captures `version` (e.g. `2.9.5`). It then asserts that live version string appears in the tool result / final answer. A stub backend "would never produce" it. This is the line that separates true end-to-end from a convincing hallucination:

```ts
// e2e-codex.ts — hard proof the data came from the LIVE backend
const versionSeen =
  items1.includes(backendVersion) || run1.lastMessage.includes(backendVersion) ||
  /2\.9\.\d/.test(items1) || /2\.9\.\d/.test(run1.lastMessage);
check("tool output / answer reflects REAL backend version", versionSeen, …);
```

Two valid harness shapes (pick per the new platform):
- **Real backend + registered MCP** (codex, claude-code): require `./scripts/start.sh --no-desktop` up on :4000; assert against its live `version`. Richest proof.
- **Stub backend + throwaway config** (hermes): boot `e2e-<name>-stub.ts` on a spare port, write a throwaway agent config pointing the MCP server at it, record REST calls to a log file, and assert the expected path (e.g. `/api/status`, `/api/meeting/prepare`) was hit. Use when the platform can't reliably reach the real backend in CI.

Also codify from the reference tests: use **read-only, idempotent** tools (`callingclaw_status`, `callingclaw_recent_events`) for assertions; a fresh one-shot MCP server has an **empty event buffer**, so 0 events is expected — assert the *shape* (`cursor`/`count`/`events`), not content; and treat account/quota blocks (usage-limit, unsupported-model) as an explicit non-failure branch (`BLOCKED_BY_ACCOUNT` in `e2e-codex.ts:124-132`), not a red test.

### Acceptance checklist

| # | Criterion | How verified | Command |
|---|---|---|---|
| 1 | `connect()` succeeds against the installed CLI | unit test `connect() verifies the <cli>` asserts `connected === true` | `cd callingclaw-backend && bun test test/adapters/<name>-adapter.test.ts` |
| 2 | Each cognitive method returns non-empty | unit test asserts stub response string returned for prep/recall/task | same |
| 3 | Model flags + prompt content correct | unit test inspects recorded argv (`-m <model>`, OC-prompt topic present) | same |
| 4 | Scheduler round-trips; `deliverTodos` writes a notes file | unit tests `scheduleJob/cancelJob` + `deliverTodos` (file exists, contains todo) | same |
| 5 | **Error path throws** | unit test: stub exits non-zero with `Error:` on **stdout** → method throws (does NOT return the error text) | same |
| 6 | MCP round-trip works from inside the agent | e2e transcript shows a `callingclaw_*` tool_use/item | `bun scripts/e2e-<name>.ts` |
| 7 | **MCP tools actually registered (not silently zero)** | agent's live tool list / MCP list contains `callingclaw_*`; 0 tools = FAIL even if "registered" | `bun scripts/e2e-<name>.ts` (or agent's `mcp list`) |
| 8 | Tool result reflects the REAL backend (not stubbed/hallucinated) | e2e asserts **unique per-run marker** AND live `version` string in the tool result/answer | `bun scripts/e2e-<name>.ts` (after `./scripts/start.sh --no-desktop`) |
| 9 | Typecheck clean | no new `tsc` errors introduced | `cd callingclaw-backend && bunx tsc --noEmit` |
| 10 | Unit suite green | full adapter suite passes | `cd callingclaw-backend && bun test test/adapters/` |
| 11 | Setup script idempotent + installs MCP-client deps | run twice → no-op re-register, exactly one `AGENT_PLATFORM=<name>`, agent's `mcp`-client dep present in its env | `./scripts/setup-<name>.sh && ./scripts/setup-<name>.sh && grep -c '^AGENT_PLATFORM=' .env` (expect `1`) |
| 12 | **Independent code review passed** | reviewer ≠ implementer returns explicit **PASS** (not "looks fine"); CHANGES-REQUIRED items resolved | out-of-band review with recorded verdict |

---

## Pillar 3 — Permission-Restriction Model (权限限制)

Every adapter runs an autonomous external agent on the user's machine on CallingClaw's behalf. It MUST pin the tightest sandbox/permission posture the CLI offers, and it MUST NOT widen the tool surface beyond what cognition needs. This is prescriptive — a new adapter declares its posture explicitly, in code, in the runner's argv.

### How the existing adapters scope permission (copy the closest)

| Platform | Sandbox / permission flags (in the run argv) | Effect |
|---|---|---|
| **Claude Code** | `--permission-mode bypassPermissions`, `--no-session-persistence`, `--disable-slash-commands` (`claude-code-adapter.ts:243-251`); e2e adds `--strict-mcp-config` + explicit `--allowedTools mcp__callingclaw-events__<tool>` (`e2e-claude-code.ts:76-80`) | Runs unattended (no interactive approval prompts), leaves no session state, and — in e2e — the tool surface is an **explicit allowlist** of exactly the MCP tools under test. Nothing else is callable. |
| **Codex** | `--sandbox workspace-write`, `--skip-git-repo-check`, `--cd <workspace>` (`codex-adapter.ts:265-272`) | Read/write confined to the working dir (`~/.callingclaw/shared`); no approvals needed; not treated as a git repo. It cannot write outside the workspace. |
| **Hermes** | Config-level: MCP server + provider declared in `~/.hermes/config.yaml`; no per-invocation sandbox flag (`hermes-adapter.ts:257-264`) | Scope is whatever the Hermes config grants. Because there's no argv sandbox, the *config* is the boundary — the setup script must not register more than the events MCP server. |

### The fixed tool surface

The `callingclaw-events` MCP server (`plugins/callingclaw-events/index.ts`) exposes a **fixed set of exactly 7 tools** — this is the entire surface CallingClaw offers any agent, and a new adapter neither adds nor removes from it:

`callingclaw_status`, `callingclaw_transcript`, `callingclaw_summary`, `callingclaw_recent_events`, `callingclaw_join_meeting`, `callingclaw_prepare_meeting`, `callingclaw_list_calendar`.

All seven proxy to `localhost:4000` REST/WS. They do not expose the filesystem, shell, or credentials. Meeting control (`join_meeting`, `prepare_meeting`) is deliberately in the set; anything more powerful is not.

### What a NEW adapter MUST declare

1. **Pin a sandbox flag if the CLI has one.** Prefer workspace-confined write over full-disk, and non-interactive over approval-prompting (an unattended daemon can't answer prompts). State which flag and why in a comment on the runner, like codex's `// read/write within cwd, no approvals needed`.
2. **Scope the tool surface.** If the CLI supports an MCP-tool allowlist (like claude's `--allowedTools`/`--strict-mcp-config`), use it in the e2e test to prove the agent can reach *only* the intended `callingclaw_*` tools. If it only scopes via config (hermes), keep the setup script's registration minimal — register the events MCP server and nothing else.
3. **Confine the working dir** to a CallingClaw-owned dir via the CLI's cwd/sandbox-dir flag, so file writes land in a known area and nowhere sensitive. Default to `~/.callingclaw/shared` (`WORKSPACE_DIR`) — **BUT if the agent scaffolds its own files into its cwd** (memory dirs, `TOOLS.md`, etc.), point it at a **dedicated subdir** instead (e.g. `~/.callingclaw/raven-workspace`) so it doesn't pollute the shared prep/notes area that Desktop/OpenClaw read. See the Raven note below.
4. **Credentials from `.env` only, never hardcoded.** Keys (e.g. `OPENROUTER_API_KEY`) are read from `.env` by the setup/start scripts and passed via `env`/config. Never bake a key into the adapter, a script, or a committed config. The hermes e2e even *allowlists* which env vars reach the subprocess (`hermesEnv()` in `e2e-hermes.ts:79-86`) — copy that hygiene if the CLI is env-sensitive.
5. **Do NOT expose** shell/exec tools, arbitrary filesystem roots, network egress beyond the agent's own inference provider, or CallingClaw internals beyond the 7 MCP tools. If the new platform wants a richer surface, that is a change to the MCP server (reviewed separately), not something an adapter smuggles in.

---

## Common Mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| Reading model env into a module-level constant | `.env` model changes need a backend restart | Wrap in `() => process.env.X \|\| default`, call per-run |
| Not `proc.kill()`-ing on timeout | Zombie CLI processes accumulate | Kill inside the timeout callback before rejecting; `clearTimeout` in `.finally()` |
| Using Node `child_process` for the run path | Violates the Bun-only rule | `Bun.spawn` for runs (`which`-style detection may use `child_process.execSync` as the adapters do, but the cognitive run path is `Bun.spawn`) |
| Inventing new prompts instead of OC-001/006/010 | Diverges from the agent-agnostic contract; breaks parity | Import from `src/openclaw-protocol.ts` |
| Adding an external cron for scheduling | Breaks the "no external cron" invariant; jobs don't survive restart cleanly | Use `InternalJobScheduler` (persists to disk, reloads on boot) |
| E2E asserts the model *said* it called the tool | Passes on a hallucination | Assert the machine transcript's tool_use/item (or backend-side hit) **and** a unique per-run marker + live backend `version` in the result |
| Setup script appends `AGENT_PLATFORM` on every run | Duplicate keys in `.env` | grep-then-`sed`-or-append (idempotent); re-register MCP with remove-then-add |
| Widening the tool surface in the adapter | Security regression | Adapter is a fixed 7-tool client; surface changes go through the MCP server |
| Trusting the design doc's assumed config schema | Wrong key/casing/nesting; `extra="forbid"` bricks config load | Read the tool's own config source (`schema.py`); validate the generated config with the tool's loader (`model_validate`) before shipping |
| Assuming "install succeeded" + "MCP registered" ⇒ tools loaded | Silent zero-tool dead integration (undeclared `mcp` dep, swallowed ImportError) | Install the MCP-client dep into the agent's env; verify the live tool list is non-empty; make the E2E assert a real tool CALL |
| Using the reference `exitCode !== 0 && !stdout` guard verbatim | Error-on-stdout at non-zero exit returned as a valid answer | Throw on ANY non-zero exit; add an error-path unit test |
| Returning `.trim()`ed stdout as the answer | ANSI codes + log/banner preamble leak into the answer (`--no-markdown`/`--no-logs` don't fully clean it) | Strip ANSI (regex + `NO_COLOR`/`TERM=dumb`) and extract the answer after the preamble |
| Shipping happy-path-only unit tests / no independent review | Green tests hide real blockers | Require an error-path test AND an independent review with an explicit PASS/CHANGES-REQUIRED verdict |

## Red Flags — STOP

- "All my unit tests pass" is being treated as done. It isn't — you still need an independent review with an explicit verdict AND a real-tool-call E2E. (This is the Raven meta-lesson: green tests hid two blockers.)
- The e2e "passes" but you never started the real backend, you have no unique-per-run-marker / live-`version` assertion, or you only assert the model *said* it called a tool → it's not proving end-to-end.
- You "registered" the MCP server but never verified the agent's live tool list is non-empty → the integration may be silently loading ZERO tools.
- You wrote the config from a design doc's assumed schema without reading the tool's own config source or validating with its loader.
- The exit-code guard is `exitCode !== 0 && !stdout` (swallows error-on-stdout), or you return raw `.trim()`ed stdout without stripping ANSI/preamble.
- No error-path test (non-zero exit / error-on-stdout).
- The runner has no `proc.kill()` on timeout, or no per-task timeout at all.
- Model selection is a `const`, not a `() => …` (unless, like Raven, the model is config-file-based and set once at setup — then say so in a comment).
- The adapter reads or writes outside `~/.callingclaw/shared`, or handles a raw API key.
- Setup script isn't safe to run twice, or doesn't install the agent's MCP-client dependency.

## Platform-specific notes

> This section collects per-platform gotchas discovered during real integration. Grounded facts above come from the openclaw/claude-code/codex/hermes/**raven** adapters. Raven is the 5th onboarding and the concrete data point that makes this skill battle-tested — its notes below are the real, discovered answers, and several were *not* what the design doc guessed. Use them as the template for what to write down when the 6th platform lands.

### Raven (EverMind-AI) — the 5th onboarding
- **CLI invocation shape:** `raven agent -m "<prompt>"` for one-shot, plus `--no-markdown --no-logs`. Model/provider are **NOT** CLI flags — they come from `~/.raven/config.json`.
- **Final-answer extraction:** plain stdout, but NOT clean. Even with `--no-markdown --no-logs`, stdout still carries (1) ANSI color codes from Raven's `rich` layer and (2) a structlog + `🐦‍⬛ Raven` **banner preamble** before the answer. Adapter must strip ANSI (`s.replace(/\x1b\[[0-9;]*m/g, "")`) with `NO_COLOR=1`/`TERM=dumb` in `env` as defense-in-depth, then extract the answer AFTER the banner. Do not just `.trim()` stdout.
- **Exit-code trap:** Raven hard-exits `os._exit(0)` on success (skips stdio flush in some runtimes → read stdout to completion BEFORE `await proc.exited`) and, critically, exits **1 with `Error: …` on STDOUT** on failure. The reference adapters' `exitCode !== 0 && !stdout` guard SWALLOWS this and returns the error as an answer. Fix: throw on **any** non-zero exit (prefer the stripped-stdout error text, fall back to stderr). An independent review caught this; the happy-path unit tests did not.
- **Bin resolution:** `RAVEN_BIN` env → PATH → `~/.local/bin/raven` → pipx venv (`~/.local/pipx/venvs/raven/bin/raven`) → homebrew. Install method varies (pip/pipx/curl/venv), so probe several.
- **MCP registration — the schema the design GUESSED WRONG:** register under **`tools.mcp_servers.<name>`** (nested, snake_case) in `~/.raven/config.json`. The design doc assumed top-level `mcpServers` (camelCase, the de-facto MCP standard) — that is WRONG for Raven: MCP lives nested under `tools`, snake_case, and the root Config uses pydantic `extra="forbid"` so a wrong top-level key **fails schema validation and bricks config load**. Non-destructive NODE merge; transport auto-detects to `stdio` from `command`; use an absolute command path.
- **Undeclared `mcp` dependency — the dead-integration blocker:** Raven does not declare the `mcp` Python package, yet `raven/agent/tools/mcp.py` does `from mcp import …` and **silently swallows the ImportError** → Raven starts fine and "registers" the server but loads **ZERO tools**, no error surfaced. `setup-raven.sh` must `pipx inject raven mcp` (the specific stdio-server symbol `mcp.py` needs, not a bare package) and then verify tools actually register; the real-inference E2E is what surfaces this (the tool call fails if tools never loaded).
- **Provider key casing:** `providers.openrouter.apiKey` — **camelCase** (raven's pydantic alias generator writes `by_alias=True`, and `raven onboard` reads `p.get("apiKey")`), even though sibling config keys are snake_case. Casing differs *within the same file*; confirm from source per key.
- **Sandbox/permission:** set `tools.sandbox.backend = "none"` (DirectExecutor) in config — Raven's `boxlite` sandbox would otherwise block the MCP subprocess. There is no per-invocation sandbox argv flag; the config is the boundary, so the setup script's registration must stay minimal (events MCP server only).
- **Dedicated workspace — do NOT reuse the shared dir (exception to Pillar 3 item 3):** Raven scaffolds memory files (`agent_memory/`, `user_memory/`, `TOOLS.md`, `HEARTBEAT.md`) into its `-w` workspace root on every run. Point `-w` at a **dedicated** `~/.callingclaw/raven-workspace` (created if missing), NOT `~/.callingclaw/shared` — otherwise Raven pollutes the shared prep/notes area that Desktop/OpenClaw read. The adapter's unit test guards this (`-w` asserted == `raven-workspace`).
- **Model selection:** config-file based, NOT env-per-task. Setup seeds ONE default model + the OpenRouter provider into `~/.raven/config.json` (Option B: setup configures once, adapter never mutates the config per-run — avoids TOCTOU races when prep+recall overlap during a meeting). `RAVEN_MODEL` is reserved as the single default written at setup; `RAVEN_BIN` overrides the binary. No `RAVEN_PREP_MODEL`/`RAVEN_RECALL_MODEL` split.
- **E2E harness:** stub-friendly (`e2e-raven-stub.ts` exists alongside `e2e-raven.ts`) because Raven has **no JSON/structured output mode** — you cannot machine-parse a tool-call transcript the way codex `--json` / claude `stream-json` allow. So proof-of-liveness leans on the backend-side signal: assert the unique per-run marker + live `version` appear in the answer, and/or assert the stub backend recorded the REST hit. Account/quota (no OpenRouter key / unsupported model) → treat as an explicit non-failure branch, not a red test.
- **Auto-detect probe:** `~/.raven/config.json` existence and/or `which raven` (respect the documented priority order in `callingclaw.ts`).

### Meta-lesson from Raven (applies to every future onboarding)
The adversarial code review AND the real-inference E2E EACH caught a distinct BLOCKER that the implementing agent's own passing unit tests missed (review → swallowed exit-code error; E2E → zero tools registered). "Green unit tests" is not the bar. Require BOTH an independent review with an explicit verdict AND an E2E with a real tool invocation before calling any adapter done.
