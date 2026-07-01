# Raven Agent Integration — Design Spec

**Date:** 2026-06-30
**Author:** andrew@tanka.ai + Claude
**Status:** Draft for review — DESIGN ONLY (no implementation in this branch)
**Branch:** `feat/raven-integration`

Add **Raven** (EverMind-AI's agent CLI) as a new agent-platform adapter (`"raven"`) so
CallingClaw can use Raven as its cognitive backend for meeting prep, context recall,
task/todo execution, and timeline processing — and so a user can converse with
CallingClaw and launch meetings *from inside Raven* via the existing universal MCP
server `plugins/callingclaw-events`.

This is the same two-piece pattern already shipped for Hermes and Codex:
1. A new `AgentAdapter` implementation (`RavenAdapter`) that shells out to `raven agent -m …`.
2. A `setup-raven.sh` script that registers `callingclaw-events` in Raven's own config
   and sets `AGENT_PLATFORM=raven`.

Nothing about voice / audio / Meet-join changes — those live in the REST API on
`localhost:4000` and are backend-owned regardless of adapter.

---

## Confirmed Raven facts (from github.com/EverMind-AI/Raven @194bb307)

- Python 3.12+ CLI, entry point `raven` (Typer). Installs as a PyPI wheel; also a curl installer.
- Non-interactive single-prompt invocation: `raven agent -m "<prompt>"`.
  Useful flags: `-w/--workspace <path>`, `--config <path>`, `--no-markdown`,
  `--no-logs`, `-s/--session <key>`.
- **Model/provider selection is CONFIG-FILE based (NOT CLI flags).** Configured
  via `raven onboard` (interactive) or by writing `~/.raven/config.json`.
  Multi-provider via LiteLLM (OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter /
  custom). **This is the key divergence** from hermes/codex/claude, all of which take
  the model as a CLI flag (`-m`, `--model`).
- Full MCP client support: MCP servers registered in `~/.raven/config.json` (JSON).
  Transports: stdio, SSE, streamable HTTP.
- Output: plain text + optional markdown (rich). **No JSON output mode.** Hard-exits
  via `os._exit(0)` → exit code 0 on success; **no structured error codes**.
- Permissions: default "direct executor" (no sandbox, full host FS); optional
  "boxlite" sandbox. No fine-grained per-tool scoping (all registered tools globally
  visible). Credentials are blocked from the sandbox env by design.

> ⚠️ **`raven agent -m` collision.** For hermes/codex/claude, `-m` means *model*. For
> Raven, `-m` is the **message/prompt** and there is **no model flag at all**. The
> adapter must NOT try to pass a model on the command line. Model selection is done
> once, in the config file (see Decision 2). This is the single biggest footgun in
> the port — call it out in code comments.

---

## Architecture (unchanged shape; new adapter slots in)

```
                         ┌───────────────────────────────────────┐
                         │  CallingClaw backend (localhost:4000)   │
                         │  REST API + EventBus + /ws/events        │
                         └───────────────┬───────────────────────────┘
                                         │
              ┌──────────────────────────┼───────────────────────────┐
              │ Outbound (agent→CC)       │ Inbound (CC→agent)         │
              ▼                           ▼
   ┌────────────────────┐    ┌──────────────────────────────────────┐
   │ AgentAdapter        │    │ Universal MCP server                  │
   │  - RavenAdapter ★   │    │ plugins/callingclaw-events/index.ts   │
   │    (raven agent -m) │    │  TOOLS: status, transcript, summary,  │
   │  - HermesAdapter    │    │   recent_events, join_meeting,        │
   │  - CodexAdapter     │    │   prepare_meeting, list_calendar      │
   │  - ClaudeCodeAdapter │   │  + Claude channel push (CC-only)      │
   │  - OpenClawAdapter  │    │  buffers /ws/events for polling       │
   │  - StandaloneAdapter│    └──────────────────────────────────────┘
   └────────────────────┘                ▲
              ▲                           │ registered in Raven's MCP config
     selected by AGENT_PLATFORM     ~/.raven/config.json (JSON, mcpServers)
```

Raven has **no channel-push equivalent** (that path is Anthropic-proprietary, Claude
Code only), so Raven — like Hermes/Codex — polls `callingclaw_recent_events` for
meeting notifications.

---

## Decision 1 — RavenAdapter shell-out

Model the adapter on `HermesAdapter` (plain-text CLI shell-out, `InternalJobScheduler`,
local-file + macOS-notification delivery). It is close to identical *except* the
`runRaven()` runner and binary resolution.

### 1a. Command shape

```
raven agent \
  -m "<prompt>" \
  -w <WORKSPACE_DIR> \
  --config <RAVEN_CONFIG_PATH>   # only if the CallingClaw-managed config is used (Decision 2C — NOT recommended)
  --no-markdown \
  --no-logs
```

- **`-m "<prompt>"`** — the message/prompt. NOT a model flag (see collision warning).
- **`-w <WORKSPACE_DIR>`** — set to `~/.callingclaw/shared` (same `WORKSPACE_DIR` const
  every other adapter uses). This is where prep/notes live and where recall/task work
  should read+write. Matches `--cd` in the Codex adapter and `cwd` in Hermes.
- **`--no-markdown`** — strip rich/ANSI markdown decoration so stdout is clean plain
  text we can return verbatim. (Rich markup would otherwise contaminate prep JSON and
  recall answers.)
- **`--no-logs`** — suppress Raven's own run logs from stdout so the returned text is
  only the model's answer, not log noise. (Analogous to Codex's `--color never` +
  `--output-last-message`, though Raven has no last-message file — see 1c.)
- **`--config <path>`** — omitted under the recommended Decision 2B. Only present if we
  adopt 2C (a CallingClaw-managed config file), which we do NOT recommend.
- **`-s/--session <key>`** — **omit by default.** Each cognitive call is stateless and
  independent; a shared session key would leak one meeting's context into another
  (exactly the "voice session context leak" class of bug from the v2.8.14 gotchas).
  If per-meeting continuity is ever wanted, key it `cc-<meetingId>` — but not in v1.

`cwd` for the spawned process is also `WORKSPACE_DIR` (belt-and-suspenders with `-w`).
`env` is `{ ...process.env }` so the LiteLLM provider key (e.g. `OPENROUTER_API_KEY`)
is inherited — see Decision 5.

### 1b. Timeout + process cleanup (identical to Hermes/Codex)

Use the established `Promise.race` pattern:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
const stdout = await Promise.race([
  new Response(proc.stdout).text(),
  new Promise<string>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();                                   // reap the child on timeout
      reject(new Error(`raven agent timeout (${timeout}ms)`));
    }, timeout);
  }),
]).finally(() => { if (timer) clearTimeout(timer); });
```

Per-channel timeouts (same budgets as Hermes/Codex):

| Channel | Timeout | Rationale |
|---|---|---|
| `generateMeetingPrep` | 120_000 ms | deep research |
| `recallContext` | 30_000 ms | fast, meeting-time |
| `executeTask` | 60_000 ms | |
| `executeTodo` | 300_000 ms | deep work |
| `processTimeline` | 120_000 ms | |
| `connect()` health check | ~10_000 ms | `raven --version` should be instant |

### 1c. Plain-text output handling (no JSON parse)

Raven has **no JSON output mode and no `--output-last-message` file**. So, exactly like
`HermesAdapter.runHermes`, we treat **`stdout.trim()` as the answer** — no parsing.

```ts
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;
if (exitCode !== 0 && !stdout) {
  throw new Error(`raven agent exited ${exitCode}: ${stderr.slice(0, 500)}`);
}
return stdout.trim();
```

Notes:
- `--no-logs` + `--no-markdown` are what make the raw stdout clean enough to return
  directly. Without them, prep JSON (OC-001 asks for a structured brief) would be
  wrapped in rich markup / log lines.
- **`os._exit(0)` caveat:** Raven hard-exits with code 0 on success and has no
  structured error codes. So `exitCode !== 0` is a weak signal. Guard the same way
  Hermes does: only throw on non-zero exit **when stdout is empty**. A non-empty stdout
  is treated as success even if the exit code is unusual. Because `os._exit` skips
  stdio flushing in some runtimes, prefer reading stdout to completion (the `Response`
  read above) *before* awaiting `proc.exited`.
- The OC-001 prep prompt already instructs the agent to emit a structured brief; the
  existing prep-parsing in `MeetingPrepSkill` tolerates a plain-text/markdown-ish
  response the same way it does for Hermes. No Raven-specific parsing needed.

### 1d. `connect()` health check

Mirror Hermes: spawn `raven --version`, read stdout, require non-empty:

```ts
async connect(): Promise<void> {
  try {
    const proc = Bun.spawn([resolveRavenBin(), "--version"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (stdout.trim()) {
      this._connected = true;
      console.log(`[RavenAdapter] Connected (${stdout.trim()})`);
    } else {
      throw new Error("raven CLI not found");
    }
  } catch (e: any) {
    this._connected = false;
    throw new Error(`Raven not available: ${e.message}`);
  }
}
```

Optional stronger check (deferred): also assert `~/.raven/config.json` exists and has a
provider configured, warning if not (so we fail fast with a clear "run setup-raven.sh"
message instead of an opaque LiteLLM auth error on first prep). Recommended as a
`console.warn`, not a hard throw, so a partially-configured Raven still connects.

### 1e. Binary resolution (`RAVEN_BIN` → PATH → pipx/venv)

Raven installs as a PyPI wheel; the console-script `raven` can land in several places
depending on install method (pip, pipx, curl installer, or a venv). Resolve in order:

```ts
function resolveRavenBin(): string {
  if (process.env.RAVEN_BIN) return process.env.RAVEN_BIN;         // 1. explicit override / test stub
  try {                                                            // 2. on PATH
    require("child_process").execSync("which raven", { stdio: "ignore" });
    return "raven";
  } catch {}
  const fs = require("fs");
  const candidates = [                                            // 3. common install locations
    `${process.env.HOME}/.local/bin/raven`,                        //    pip --user / curl installer
    `${process.env.HOME}/.local/pipx/venvs/raven/bin/raven`,       //    pipx venv
    `/opt/homebrew/bin/raven`,                                     //    homebrew (Apple Silicon)
    `/usr/local/bin/raven`,                                        //    homebrew (Intel) / system
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return "raven";                                                 // 4. fall back; connect() surfaces the error
}
```

This is the union of the Hermes strategy (`HERMES_BIN` → `~/.local/bin` → PATH) and the
Codex strategy (`CODEX_BIN` → `which` → app-bundle path). `RAVEN_BIN` is the escape
hatch and also what the E2E test/stubs use.

---

## Decision 2 — Config-file-based model/provider selection (the key divergence)

Raven takes **no model flag**. Options:

| Option | What it does | Pros | Cons |
|---|---|---|---|
| **A. Adapter rewrites `~/.raven/config.json` per invocation** | Before each `runRaven`, patch the config's active model to the per-channel model, spawn, (optionally) restore | Per-channel model like Hermes; single global config | Race conditions if two channels run concurrently (prep + recall overlap during a meeting); mutates a user-owned file behind their back; TOCTOU with a running interactive Raven; brittle |
| **B. Setup configures provider+model ONCE; adapter just invokes** ✅ | `setup-raven.sh` writes provider + a single default model into `~/.raven/config.json`; adapter never touches model | Simplest, safest, matches Raven's own mental model; no races; user can tune via `raven onboard` | No per-channel (prep-vs-recall) model split out of the box |
| **C. Adapter passes `--config <CallingClaw-managed json>`** | Ship our own `~/.callingclaw/raven-config.json`, pass `--config` on every call | Isolated from the user's Raven config; we fully own it | We must reproduce Raven's entire config schema (providers, keys, MCP) and keep it in sync as Raven evolves; duplicates the key already in `.env`; more moving parts |

### ✅ Recommendation: **Option B**, with a lazy env-override seam for a future per-channel split.

- `setup-raven.sh` writes the provider + one default model into `~/.raven/config.json`
  **once** (non-destructive merge — Decision 3). The adapter then just runs
  `raven agent -m …` and lets Raven resolve the model from its own config.
- This is the *correct* fit for Raven's design (model lives in config, not on the CLI)
  and avoids the concurrency/TOCTOU hazards of A and the schema-duplication burden of C.

**Lazy `RAVEN_*_MODEL` env seam (design now, wire later):** define the same
lazy-getter shape Hermes/Codex use, so the moment Raven adds a CLI/env model override
(or we decide to adopt Option A behind a flag) we can honor per-channel models without
touching call sites:

```ts
// Read lazily so changes apply without a backend restart. Empty string = "use whatever
// ~/.raven/config.json is configured for" (the Option B default).
const prepModel   = () => process.env.RAVEN_PREP_MODEL   || process.env.RAVEN_MODEL || "";
const recallModel = () => process.env.RAVEN_RECALL_MODEL || process.env.RAVEN_MODEL || "";
const taskModel   = () => process.env.RAVEN_TASK_MODEL   || prepModel();
```

In v1 these getters are **plumbed but not applied** (Raven has no model flag). Document
in a code comment: "Raven selects the model from ~/.raven/config.json; these env vars
are reserved for a future per-channel override and are intentionally not passed on the
CLI today." This keeps the adapter shape identical to its siblings and future-proofs it.

> If per-channel models become a hard requirement before Raven gains a flag, adopt a
> **guarded Option A**: serialize all `runRaven` calls through a single async mutex and
> write→spawn→restore the config atomically. Given the meeting-time concurrency
> (prep + recall can overlap), this is deliberately deferred, not adopted in v1.

---

## Decision 3 — MCP registration for `setup-raven.sh`

Raven reads MCP servers from `~/.raven/config.json` (JSON). We must **non-destructively
merge** `callingclaw-events` into whatever the user already has (their providers, keys,
other MCP servers, onboarding state) — never clobber the file.

### Target JSON shape

Registering under the conventional `mcpServers` key (the de-facto MCP-client standard,
same shape Claude/Cursor/opencode use; Raven follows LiteLLM+MCP conventions). The
setup script MUST verify the exact key name against the installed Raven's schema on
first run — see Open Question (e).

```jsonc
{
  // ...user's existing provider/model/onboarding config preserved untouched...
  "mcpServers": {
    // ...user's other MCP servers preserved...
    "callingclaw-events": {
      "command": "bun",
      "args": ["<PROJECT_DIR>/plugins/callingclaw-events/index.ts"],
      "env": {
        "CALLINGCLAW_HTTP": "http://localhost:4000",
        "CALLINGCLAW_URL": "ws://localhost:4000/ws/events"
      },
      "enabled": true
    }
  }
}
```

- `command: "bun"` — resolve `bun`'s absolute path in the script
  (`BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")`, as `setup-codex.sh` does)
  because a daemon-spawned Raven may not have `bun` on PATH. Prefer the absolute path in
  `command` for robustness (`args[0]` = the MCP index path).
- `env` matches every other integration: `CALLINGCLAW_HTTP` (REST) + `CALLINGCLAW_URL`
  (EventBus WS) — the two vars `plugins/callingclaw-events/index.ts` reads.

### Merge with **node** (not jq/python), per the task requirement

Raven's config is JSON, so unlike Hermes (YAML → needed python/PyYAML) we can do the
merge with `node` — no extra runtime dependency. `bun` is guaranteed present (it's our
backend runtime), so `bun` could also run this, but `node` is what the requirement asks
for and is universally available. Shape:

```bash
RAVEN_HOME="${RAVEN_HOME:-$HOME/.raven}"
mkdir -p "$RAVEN_HOME"
CONFIG="$RAVEN_HOME/config.json"
MCP_INDEX="$PROJECT_DIR/plugins/callingclaw-events/index.ts"
BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"

node - "$CONFIG" "$MCP_INDEX" "$BUN_PATH" <<'NODE'
const fs = require("fs");
const [configPath, mcpIndex, bunPath] = process.argv.slice(2);

let data = {};
try { data = JSON.parse(fs.readFileSync(configPath, "utf8")); }
catch { data = {}; }                       // missing or corrupt → start fresh (see note)

const servers = (data.mcpServers ||= {});  // non-destructive: create only if absent
servers["callingclaw-events"] = {          // idempotent: overwrite only OUR entry
  command: bunPath,
  args: [mcpIndex],
  env: {
    CALLINGCLAW_HTTP: "http://localhost:4000",
    CALLINGCLAW_URL:  "ws://localhost:4000/ws/events",
  },
  enabled: true,
};

fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
console.log("✓ Wrote", configPath);
NODE
```

Safety notes:
- **Corrupt-config guard.** If `JSON.parse` throws on a *non-empty* file, do NOT silently
  overwrite the user's config. The snippet above starts fresh on parse failure, which is
  fine for an empty/missing file but destructive for a corrupt one. Harden: if the file
  is non-empty and fails to parse, back it up to `config.json.bak` and warn, or abort.
  Recommend: **back up + warn**, then proceed with a fresh object seeded from backup-less
  defaults. (Match the "back up existing first" spirit in `setup-hermes.sh`.)
- **Idempotent.** Re-running only rewrites `mcpServers["callingclaw-events"]`, keeping
  the path pointed at *this* checkout (same guarantee Codex gets from `mcp remove` +
  `mcp add`). Safe to run repeatedly.
- **`bun install` the plugin deps first** (same as Hermes/Codex):
  `( cd "$PROJECT_DIR/plugins/callingclaw-events" && "$BUN_PATH" install --silent )`.

### Provider wiring (Decision 2B) inside the same script

After the MCP merge, seed the provider + default model **once** if not already set
(non-destructive — only fill gaps, never overwrite a user's chosen provider):

```bash
# reads OPENROUTER_API_KEY from .env (same as setup-hermes.sh)
node - "$CONFIG" "$OPENROUTER_KEY" "$RAVEN_DEFAULT_MODEL" <<'NODE'
const fs = require("fs");
const [configPath, key, defaultModel] = process.argv.slice(2);
let data = {}; try { data = JSON.parse(fs.readFileSync(configPath,"utf8")); } catch {}
// Only set if the user hasn't already configured a provider/model via `raven onboard`.
if (key && !data.provider && !data.model) {
  // NOTE: exact provider/model config schema is Open Question (e) — confirm against
  // Raven's `raven onboard`-generated config before shipping. Placeholder shape:
  data.provider = "openrouter";
  data.model    = defaultModel;            // e.g. "openrouter/anthropic/claude-sonnet-4.6"
  data.providers = data.providers || {};
  data.providers.openrouter = { api_key: key, ...(data.providers.openrouter||{}) };
  fs.writeFileSync(configPath, JSON.stringify(data,null,2)+"\n");
  console.log("✓ Seeded OpenRouter provider + default model");
} else {
  console.log("• Provider/model already configured (or no key) — left as-is");
}
NODE
```

> The provider/model **key names above are placeholders.** LiteLLM-based configs vary;
> the script must be reconciled with the real schema `raven onboard` writes. This is the
> only part of the script that can't be finalized without inspecting an
> onboarding-generated `~/.raven/config.json` (Open Question e). Everything else (the
> `mcpServers` merge) is safe as designed.

---

## Decision 4 — Permission / sandbox posture

**Adopt Raven's default "direct executor" (no sandbox) for CallingClaw.**

Rationale:
- CallingClaw's cognitive backend must read+write the shared workspace
  (`~/.callingclaw/shared/{prep,notes}`) and, for `executeTodo`/`executeTask`, act on
  the host (files, browser via the MCP tools). This is exactly what OpenClaw / Codex
  (`--sandbox workspace-write`) / Hermes already do. Raven's "boxlite" sandbox blocks
  credentials from the env by design, which would **break LiteLLM provider auth**
  (`OPENROUTER_API_KEY`) and defeat the point.
- CallingClaw already runs on a single-user macOS machine as a trusted local agent; the
  trust boundary is the same one Codex's `workspace-write` and Hermes's default posture
  assume.

**Documented posture (put this in `setup-raven.sh` output + CLAUDE.md):**
- **Executor:** direct (no boxlite). Full host FS, workspace-scoped by convention (`-w`).
- **Credentials:** provider key (`OPENROUTER_API_KEY`) inherited via `env: {...process.env}`.
  We deliberately do NOT use boxlite because it strips creds → LiteLLM would fail.
- **Tool set is fixed and global.** Raven has no per-tool scoping — every registered MCP
  server is visible to every Raven run. We register exactly one server
  (`callingclaw-events`, 7 tools). Because the same `~/.raven/config.json` is shared with
  the user's interactive Raven, those 7 CallingClaw tools also appear in the user's
  normal Raven sessions (by design — that's the "converse from Raven" feature). Document
  this so it's not a surprise. If a user wants CallingClaw tools *isolated* from their
  personal Raven, that's the argument for Option 2C (`--config`), which we can revisit.
- **Boxlite is a documented opt-out**, not a default: a security-conscious user can flip
  Raven to boxlite, but must then supply the provider key through Raven's own
  credential mechanism (not env) — noted as a caveat, not supported in v1.

---

## Decision 5 — `.env` keys to add

Add a Raven block to `.env.example` mirroring the Codex/Hermes blocks. **Reuse the
existing `OPENROUTER_API_KEY`** (already in `.env`, already used by VisionModule /
ContextRetriever / TranscriptAuditor and by Hermes) — do not introduce a second key
unless the user picks a different provider (Open Question b).

```dotenv
# ─── Raven (OPTIONAL — used when AGENT_PLATFORM=raven) ────────
# Raven agent CLI (EverMind-AI). Install + configure: ./scripts/setup-raven.sh
# Model/provider are configured in ~/.raven/config.json (NOT via CLI flags),
# seeded from OPENROUTER_API_KEY by the setup script.
# RAVEN_BIN=                                     # custom raven path (default: PATH → ~/.local/bin → pipx venv → homebrew)
# RAVEN_MODEL=                                   # reserved: single default (setup writes this into ~/.raven/config.json)
# RAVEN_PREP_MODEL=                              # reserved for future per-channel model override (not applied in v1)
# RAVEN_RECALL_MODEL=                            # reserved (not applied in v1)
# RAVEN_TASK_MODEL=                              # reserved (not applied in v1)
```

- `RAVEN_BIN` — real, used by `resolveRavenBin()` and the E2E stub.
- `RAVEN_MODEL` — consumed by **`setup-raven.sh`** (written into the config), default
  `openrouter/anthropic/claude-sonnet-4.6` (see Open Question a). NOT passed on the CLI.
- `RAVEN_{PREP,RECALL,TASK}_MODEL` — reserved seams (Decision 2); plumbed in the adapter
  getters but intentionally inert in v1. Documented as such to avoid the expectation
  that setting them changes behavior today.
- **`OPENROUTER_API_KEY`** — reused. `setup-raven.sh` reads it from `.env` exactly like
  `setup-hermes.sh` does and seeds it into `~/.raven/config.json`.

Also update the `AGENT_PLATFORM` comment (two places) to include `raven`:
```dotenv
# Which agentic backend to use: openclaw | claude-code | codex | hermes | raven | standalone
```

---

## Decision 6 — Auto-detect rule in `callingclaw.ts`

Extend both the `AGENT_PLATFORM` allow-list and the auto-detect fallback chain. Slot
Raven **after hermes** (Raven is the newest, least-common backend; keep the existing
precedence stable so we don't change behavior for current users).

**Explicit-env allow-list** (add `raven`):
```ts
if (
  envPlatform === "openclaw" || envPlatform === "claude-code" ||
  envPlatform === "codex"    || envPlatform === "hermes"     ||
  envPlatform === "raven"    || envPlatform === "standalone"
) return envPlatform;
```

**Auto-detect fallback** (append after the hermes checks, before `standalone`):
```ts
try {
  if (require("fs").existsSync(`${process.env.HOME}/.raven/config.json`)) return "raven";
} catch {}
try {
  require("child_process").execSync("which raven", { stdio: "ignore" });
  return "raven";
} catch {}
```

Final precedence: `openclaw > claude-code > codex > hermes > raven > standalone`.
Primary signal is **`~/.raven/config.json` exists** (Raven was onboarded), with `which
raven` as a secondary signal. Also update the `console.log`-adjacent comment
("Auto-detect: prefer openclaw …") and the `AgentPlatform` union type (Decision 7).

> **Ordering caveat for the user:** because auto-detect returns the *first* match, a
> machine with several agents installed keeps using its current one. To force Raven,
> set `AGENT_PLATFORM=raven` (what `setup-raven.sh` does). Confirm this precedence is
> what you want (Open Question d).

---

## Decision 7 — Exact wiring checklist

### Task A — Adapter (backend)

1. **`callingclaw-backend/src/agent-adapter.ts`**
   - Add `"raven"` to the `AgentPlatform` union (line ~30):
     `"openclaw" | "claude-code" | "codex" | "hermes" | "raven" | "standalone"`.
   - Add a `case "raven"` to `createAgentAdapter` (line ~244):
     ```ts
     case "raven": {
       const { RavenAdapter } = require("./adapters/raven-adapter");
       return new RavenAdapter(deps?.onJobFire);
     }
     ```
   - Update the header comment block's "Implementations:" list to mention `RavenAdapter`.

2. **`callingclaw-backend/src/adapters/raven-adapter.ts`** (NEW)
   - Copy `hermes-adapter.ts` as the template (closest analog: plain-text CLI, no
     last-message file).
   - `readonly name = "raven" as const;`
   - `resolveRavenBin()` per Decision 1e.
   - Model getters per Decision 2 (plumbed, inert — with the explanatory comment).
   - `connect()` per Decision 1d (`raven --version`).
   - `runRaven(prompt, {timeout, cwd})` per Decisions 1a–1c: args
     `[bin, "agent", "-m", prompt, "-w", cwd, "--no-markdown", "--no-logs"]`,
     `Promise.race` timeout, `proc.kill()` on timeout, return `stdout.trim()`, throw only
     on `exitCode !== 0 && !stdout`. **No model flag. No JSON parse.**
   - Reuse OC-001/006/010 prompts (`generateMeetingPrep`/`executeTodo`/`processTimeline`)
     and `LANGUAGE_RULE` for `recallContext`/`executeTask` — verbatim from Hermes.
   - Scheduling (`InternalJobScheduler`) + delivery (local file + `osascript`
     notification) — verbatim from Hermes, with log prefix `[RavenAdapter]`.
   - `onActivity` hook — verbatim.

3. **`.env.example`** — add the Raven block (Decision 5) + update both `AGENT_PLATFORM`
   comment lines to include `raven`.

4. **`callingclaw-backend/src/callingclaw.ts`** (~lines 98–133) — allow-list `raven` +
   append the two-step auto-detect (Decision 6) + update the comment.

5. **Docs**
   - `CLAUDE.md` (root) + `.claude/worktrees/.../CLAUDE.md` — add Raven to the
     "Agent platform" paragraph and a one-line bullet like the Hermes one, pointing at
     `./scripts/setup-raven.sh`, `./scripts/start-raven.sh`, `bun scripts/e2e-raven.ts`,
     and this design doc.

### Task B — Setup + start + E2E scripts

6. **`scripts/setup-raven.sh`** (NEW) — model on `setup-hermes.sh`/`setup-codex.sh`:
   - Locate/install Raven (curl installer or `pipx install raven` — confirm the exact
     package name; see Open Question e). Resolve binary via the same order as 1e.
   - `bun install --silent` the `plugins/callingclaw-events` deps.
   - **node**-based non-destructive merge of `callingclaw-events` into
     `~/.raven/config.json` (Decision 3), with the corrupt-config backup guard.
   - Seed provider + default model from `OPENROUTER_API_KEY` if absent (Decision 3, with
     the schema caveat).
   - Set `AGENT_PLATFORM=raven` in `.env` (`sed -i ''` / append — same as siblings).
   - Print next-steps (start backend, then `./scripts/start-raven.sh`).

7. **`scripts/start-raven.sh`** (NEW) — model on `start-hermes.sh`:
   - Resolve the raven binary; export `OPENROUTER_API_KEY` from `.env`; warn if backend
     not on :4000; `exec raven agent "$@"` (or interactive `raven` if Raven has an
     interactive REPL — confirm; Hermes launches bare `hermes`).

8. **`scripts/e2e-raven.ts`** (NEW) — model on `e2e-hermes.ts` (stub-backend variant, so
   it needs no running backend and no live meeting):
   - Reuse `scripts/e2e-hermes-stub.ts` as the fake backend (it's adapter-agnostic — REST
     + `/ws/events` recorder).
   - Write a throwaway `~/.raven/config.json` (temp `RAVEN_HOME` if Raven honors it; else
     `--config <tempfile>`) registering `callingclaw-events` pointed at the stub, seeded
     with `OPENROUTER_API_KEY`.
   - Drive real `raven agent -m "<prompt>"` for: (1) `callingclaw_status`,
     (2) `callingclaw_prepare_meeting`, (3) `callingclaw_recent_events` — asserting the
     stub recorded `/api/status`, `/api/meeting/prepare`, and that the reply mentions
     cursor/count. Same three checks as `e2e-hermes.ts`.
   - Sanitize the spawned env (allow-list like `hermesEnv()`), set `OPENROUTER_API_KEY`.
   - **Open Question e** blocks finalizing this: confirm Raven honors a `RAVEN_HOME`/
     `XDG`-style override or that `--config <tempfile>` fully overrides config discovery,
     so the test doesn't touch the user's real `~/.raven/config.json`.

9. **Design doc** — this file: `docs/raven-adapter-design.md`.

### What does NOT change
- `plugins/callingclaw-events/*` — reused as-is (the whole point of the universal MCP
  server). No new tools.
- `MeetingPrepSkill`, EventBus, REST API, voice/audio/Meet-join — untouched.

---

## Acceptance criteria

- `AGENT_PLATFORM=raven ./scripts/start.sh --no-desktop` boots with
  `[Init] Agent platform: raven` and `[RavenAdapter] Connected (<version>)`.
- With no `AGENT_PLATFORM` set and `~/.raven/config.json` present (and no
  openclaw/claude/codex/hermes ahead of it), auto-detect selects `raven`.
- `bun scripts/e2e-raven.ts` passes all three checks against the stub backend using a
  real installed Raven + `OPENROUTER_API_KEY`.
- Re-running `setup-raven.sh` is idempotent and preserves any pre-existing
  `~/.raven/config.json` content (other MCP servers, provider config).
- A meeting run with `raven` backend produces a prep brief, recall answers, and a
  post-meeting todos file in `~/.callingclaw/shared/notes/`, matching Hermes behavior.

---

## Open questions for the USER

Decisions only you can make. Recommended defaults are given so implementation can
proceed on the defaults if you don't object.

**(a) Which LLM provider + model should Raven use for CallingClaw's prep / recall / task work?**
Raven picks the model from `~/.raven/config.json`; `setup-raven.sh` will seed it once.
- **Recommended default:** OpenRouter provider, single default model
  `openrouter/anthropic/claude-sonnet-4.6` (matches Hermes's `HERMES_PREP_MODEL` default
  and the "sonnet for prep/task" convention). Prep/task benefit from a strong model;
  recall is fast and meeting-time but with no per-channel split in v1 (Decision 2B) it
  uses the same default.
- **Alternative if you want cheaper recall:** we defer per-channel splitting until Raven
  gains a model flag/env override (the getters are pre-wired). Or accept guarded
  Option A (config rewrite w/ mutex) if a split is required now — say the word.
- **You decide:** the exact model id (e.g. keep Sonnet, or use a Gemini/DeepSeek/GPT
  model), and whether a single default is acceptable for v1.

**(b) Reuse the existing `OPENROUTER_API_KEY`, or a different provider key?**
- **Recommended default:** **reuse `OPENROUTER_API_KEY`** — it's already in `.env`, already
  funds Vision/Context/Transcript modules and Hermes, and OpenRouter fronts
  Anthropic/OpenAI/Gemini/DeepSeek so one key covers most model choices under (a).
- **Alternative:** if you want Raven on a *direct* provider (e.g. a native Anthropic key
  for lower latency/cost, or an EverMind/DeepSeek key), tell me which — I'll add a
  dedicated `.env` key (e.g. `RAVEN_PROVIDER_API_KEY`) and have `setup-raven.sh` seed
  that provider instead of OpenRouter.

**(c) Sandbox posture — confirm "direct executor" (no boxlite)?**
- **Recommended default:** direct executor (Decision 4) — required for LiteLLM auth and
  workspace read/write, consistent with Codex `workspace-write` / Hermes. Boxlite would
  strip the provider key and break inference.
- **You decide:** if you require sandboxing for the Raven backend specifically, we'll
  document the boxlite credential-injection workaround (not supported in v1).

**(d) Auto-detect precedence — is `openclaw > claude-code > codex > hermes > raven > standalone` right?**
- **Recommended default:** append Raven last (above `standalone`) so current users' backend
  selection is unchanged; force Raven via `AGENT_PLATFORM=raven` (what setup does).
- **You decide:** if Raven should rank *higher* (e.g. above hermes/codex) when present,
  say so and I'll reorder.

**(e) Confirm Raven's config schema + install/test details (needs a real install to verify).**
These are the only items that can't be finalized from the repo alone; please confirm or
let me install Raven to verify:
- Exact MCP key name in `~/.raven/config.json` — is it `mcpServers` (assumed) or
  something else (`mcp_servers`, `mcp.servers`)?
- Exact provider/model config shape written by `raven onboard` (so the seed snippet in
  Decision 3 matches — top-level `provider`/`model` vs a `providers`/`litellm` block).
- Install command for the setup script: curl installer URL vs `pipx install <pkg>` — and
  the PyPI package/console-script name.
- Whether Raven honors a `RAVEN_HOME` / XDG config-dir override, or whether
  `--config <tempfile>` fully overrides discovery — needed so `e2e-raven.ts` never
  touches the user's real `~/.raven/config.json`.

**(f) Do you want a per-meeting Raven session key (`-s cc-<meetingId>`)?**
- **Recommended default:** **no** — stateless per-call (avoids cross-meeting context
  leak, the v2.8.14 bug class). Enable later only if you want intra-meeting continuity.
