# Hermes Agent Integration — Design Spec

**Date:** 2026-05-28
**Author:** Andrew (andrew@tanka.ai) + Claude
**Status:** Draft for review

## Goal

Replicate the agent-integration capabilities CallingClaw already offers OpenClaw/Claude Code so users can, **from inside Hermes Agent**:

1. **Converse with CallingClaw** — query meeting status, transcript, summary; ask it to do things.
2. **拉起会议议程 (launch meeting agenda)** — trigger meeting prep generation and meeting join from Hermes.

The integration must be **extensible** so future agents (Claude Code — already done; opencode — planned) plug in with minimal work. Hermes must be delivered with a **complete end-to-end test** against a real, installed Hermes using the OpenRouter inference key.

## Background — How integration works today

CallingClaw already abstracts the "cognitive backend" behind an **`AgentAdapter`** interface ([`callingclaw-backend/src/agent-adapter.ts`](../../../callingclaw-backend/src/agent-adapter.ts)):

- `AgentPlatform = "openclaw" | "claude-code" | "standalone"`
- Factory `createAgentAdapter(platform, deps)` returns the right adapter.
- Adapters: `OpenClawAdapter` (gateway WS), `ClaudeCodeAdapter` (`claude -p` subprocess), `StandaloneAdapter`.
- The adapter exposes cognitive capabilities (`generateMeetingPrep`, `recallContext`, `executeTask`, `executeTodo`, `processTimeline`), scheduling (`scheduleJob`/`InternalJobScheduler`), and delivery (`deliverTodos`, `deliverSummary`).
- Platform is selected by `AGENT_PLATFORM` env, else auto-detected in [`callingclaw.ts`](../../../callingclaw-backend/src/callingclaw.ts) (`~/.openclaw/openclaw.json` → openclaw, `which claude` → claude-code, else standalone).

Two integration **directions** exist:

- **Outbound (agent → CallingClaw):** the agent calls CallingClaw's REST API on `localhost:4000` (status, transcript, join, prepare). Claude Code does this via a `/callingclaw` skill.
- **Inbound (CallingClaw → agent):** CallingClaw's `EventBus` emits meeting lifecycle events. The MCP server [`plugins/callingclaw-events/index.ts`](../../../plugins/callingclaw-events/index.ts) subscribes to `/ws/events` and pushes them into a Claude Code session using Anthropic's **proprietary** `notifications/claude/channel`. **This push mechanism is not portable to Hermes.**

## Hermes facts (researched)

- **Install:** `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`
- **Headless invocation:** `hermes -z "<prompt>"` → final answer as plain text only (analogous to `claude -p`). Model override `-m <provider/model>` or env `HERMES_INFERENCE_MODEL`. Provider override `--provider openrouter`. Toolsets `-t`, skills `-s`.
- **MCP client:** native, stdio + HTTP transports. Configured in **`~/.hermes/config.yaml`** under `mcp_servers:` (`command`, `args`, `env`, `enabled`, `tools`). Reload via `/reload-mcp`.
- **Scheduling:** Hermes supports scheduled automations + persistent memory (used for the polling notifier).
- Hermes is **not currently installed** on this machine (claude is; openclaw is not).

## Key decisions (confirmed with user)

1. **Interaction model:** Universal MCP **tools** + polling. Upgrade the MCP server to expose tools callable by *any* MCP client; Hermes uses tools for conversation + meeting control, and a Hermes scheduled automation polls a `recent_events` tool for notifications. Keep the Claude channel-notification path for Claude Code.
2. **E2E test:** Install Hermes via the official installer; configure it to use the existing `OPENROUTER_API_KEY` from `.env`; run a real end-to-end test.

## Architecture

```
                         ┌─────────────────────────────────────┐
                         │   CallingClaw backend (localhost:4000)│
                         │   REST API + EventBus + /ws/events    │
                         └───────────────┬───────────────────────┘
                                         │
              ┌──────────────────────────┼───────────────────────────┐
              │ Outbound (agent→CC)       │ Inbound (CC→agent)         │
              ▼                           ▼                            
   ┌────────────────────┐    ┌──────────────────────────────────────┐
   │ AgentAdapter        │    │ Universal MCP server                  │
   │ (cognitive backend) │    │ plugins/callingclaw-events/index.ts   │
   │  - HermesAdapter    │    │  TOOLS: status, transcript, summary,  │
   │    (hermes -z)      │    │   recent_events, join_meeting,        │
   │  - ClaudeCodeAdapter│    │   prepare_meeting, list_calendar      │
   │  - OpenClawAdapter  │    │  + Claude channel push (CC-only)      │
   │  - StandaloneAdapter│    │  buffers /ws/events for polling       │
   └────────────────────┘    └──────────────────────────────────────┘
              ▲                           ▲
              │                           │ registered in each agent's MCP config
     selected by AGENT_PLATFORM   ~/.hermes/config.yaml · .mcp.json · opencode.json
```

**Extensibility principle:** adding an agent = at most two small, independent pieces:
- (optional) a new `AgentAdapter` for using that agent as CallingClaw's cognitive backend; and
- registering the **same** universal MCP server in that agent's MCP config so the agent can converse with / control CallingClaw.

### Component A — `HermesAdapter` (`callingclaw-backend/src/adapters/hermes-adapter.ts`)

Mirrors `ClaudeCodeAdapter`, with these differences:
- `connect()`: verify `hermes --version` (or `which hermes`); set `_connected`.
- `runHermes(prompt, {model, timeout})`: `Bun.spawn(["hermes", "-z", ...modelArgs, prompt])`, plain-text stdout (no JSON parse). Timeout via `Promise.race`.
- Model selection via env, defaulting to OpenRouter ids:
  - `HERMES_PREP_MODEL` (default `openrouter/anthropic/claude-sonnet-4.6`)
  - `HERMES_RECALL_MODEL` (default `openrouter/anthropic/claude-haiku-4.5`)
  - `HERMES_TASK_MODEL` (default = prep model)
- Reuse existing agent-agnostic prompts `OC001_PROMPT`, `OC006_PROMPT`, `OC010_PROMPT` from [`openclaw-protocol.ts`](../../../callingclaw-backend/src/openclaw-protocol.ts) and `LANGUAGE_RULE`.
- Scheduling: `InternalJobScheduler` (same as ClaudeCodeAdapter).
- Delivery (`deliverTodos`/`deliverSummary`): write to `~/.callingclaw/shared/notes/` + macOS notification (same as ClaudeCodeAdapter). Hermes surfaces these to the user via the polling notifier.

Wiring:
- Add `"hermes"` to `AgentPlatform` union in `agent-adapter.ts`.
- Add `case "hermes": return new HermesAdapter(deps?.onJobFire)` to `createAgentAdapter`.
- Platform detection in `callingclaw.ts`: honor explicit `AGENT_PLATFORM=hermes`; auto-detect adds a check for `~/.hermes/config.yaml` / `which hermes`. Order: explicit env always wins; auto-detect stays `openclaw > claude-code > standalone` with `hermes` only via explicit env (avoids surprising existing users). *(Open to flipping if you'd rather auto-detect hermes too.)*

### Component B — Universal MCP tool server (upgrade `plugins/callingclaw-events/index.ts`)

Refactor into:
- `callingclaw-client.ts` — thin REST client (fetch wrappers) for the localhost:4000 endpoints.
- `index.ts` — MCP server that registers **tools** + keeps the in-memory event buffer + Claude channel push.

**Tools exposed (any MCP client):**

| Tool | REST call | Purpose |
|------|-----------|---------|
| `callingclaw_status` | GET `/api/status` + `/api/meeting/status` | System + current meeting state |
| `callingclaw_transcript` | GET `/api/meeting/transcript` | Live/last transcript |
| `callingclaw_summary` | GET `/api/meeting/summary` | Meeting summary + action items |
| `callingclaw_recent_events` | in-memory buffer (since cursor) | Poll meeting lifecycle events (notifier) |
| `callingclaw_join_meeting` | POST `/api/meeting/join` `{url}` | 拉起会议 (join a Meet/Zoom) |
| `callingclaw_prepare_meeting` | POST `/api/meeting/prepare` `{topic\|eventId}` | 会议议程/prep generation |
| `callingclaw_list_calendar` | GET `/api/calendar/events` | Upcoming meetings |

- The server still connects to `/ws/events`, filters `IMPORTANT_EVENTS`, and:
  - buffers the last N events (with monotonic cursor) for `callingclaw_recent_events`;
  - if the connected client advertises the Claude channel capability, also emits the existing `notifications/claude/channel` push (backwards-compatible for Claude Code).
- `CALLINGCLAW_URL` (ws) and a new `CALLINGCLAW_HTTP` (http base, default `http://localhost:4000`) env vars.

### Component C — Hermes wiring scripts

- `scripts/setup-hermes.sh`:
  1. Install Hermes if missing (official installer).
  2. Write/merge `~/.hermes/config.yaml`: set inference provider = openrouter using `OPENROUTER_API_KEY` from `.env`; register `callingclaw-events` MCP server (`command: bun`, `args: [<abs path>/plugins/callingclaw-events/index.ts]`, `env: { CALLINGCLAW_HTTP, CALLINGCLAW_URL }`).
  3. Install MCP plugin deps (`bun install` in plugin dir).
  4. Print next steps.
- `scripts/start-hermes.sh`: start a Hermes session wired to CallingClaw (analogous to `start-claude-channels.sh`); optionally register a scheduled automation that polls `callingclaw_recent_events` and notifies the user.
- `.env.example`: document `AGENT_PLATFORM=hermes` and `HERMES_PREP_MODEL` / `HERMES_RECALL_MODEL` / `HERMES_TASK_MODEL`.
- Update `setup.sh` auto-detection note + `CLAUDE.md`/`AGENTS.md` to mention the hermes platform.

### Component D — Tests

**Unit / integration (`bun test`, no live model):**
- `hermes-adapter.test.ts`: stub a fake `hermes` binary on PATH; assert `runHermes` builds correct args (`-z`, `-m`), parses plain text, applies timeouts, selects prompts (OC-001/006/010), and scheduling/delivery behave.
- `callingclaw-mcp.test.ts` (extends existing [`callingclaw-channel.test.ts`](../../../plugins/callingclaw-events/test/callingclaw-channel.test.ts)): start a mock CallingClaw HTTP+WS server; drive the MCP server; assert each tool maps to the right REST call and `recent_events` buffering/cursor works; assert Claude channel push still fires for channel-capable clients.

**End-to-end (real Hermes + OpenRouter):**
1. Install + configure Hermes (Component C).
2. Start CallingClaw backend headless (`./scripts/start.sh --no-backend-desktop`/`bun src/callingclaw.ts`).
3. `hermes -z "use the callingclaw tools to report current status"` → assert it invokes `callingclaw_status` and returns real data.
4. `hermes -z "prepare a meeting agenda about <topic> using callingclaw"` → assert POST `/api/meeting/prepare` fired (verify via backend log / prep file in `~/.callingclaw/shared/prep/`).
5. Emit a synthetic `meeting.summary_ready` on the EventBus (test endpoint) → `hermes -z "check callingclaw for recent meeting events"` surfaces it via `callingclaw_recent_events`.
6. (Adapter direction) set `AGENT_PLATFORM=hermes`, restart backend, trigger a prep generation through CallingClaw, and confirm `HermesAdapter.generateMeetingPrep` runs `hermes -z` and returns a brief.

Pass criteria: all steps produce the expected backend side effects and Hermes returns coherent, tool-grounded answers.

### Component E — Plan-only: Claude Code & opencode

**Claude Code (already integrated):**
- Benefits automatically from the universal MCP tool server. Optional follow-up: migrate the `/callingclaw` skill's REST calls to the new MCP tools for one consistent surface. Channel push unchanged.
- Test plan: existing channel test + add a tool-call test.

**opencode (planned, not built):**
- Cognitive backend: `OpencodeAdapter` invoking `opencode run "<prompt>"` (non-interactive) or `opencode serve` + `opencode run --attach http://localhost:<port>`. Add `"opencode"` to `AgentPlatform` + factory + detection (`which opencode` / `opencode.json`).
- Conversation/control: register the same universal MCP server in `opencode.json` under the `mcp` key (`{ type, command, args, env }`) or via `opencode mcp add`.
- Event notifications: opencode has no Claude channel; use the same `recent_events` polling (custom command / cron) as Hermes.
- Test plan: mirror the Hermes E2E with `opencode run`.

## Out of scope

- Replicating OpenClaw's gateway WebSocket protocol for Hermes (Hermes uses CLI + MCP; no gateway needed).
- Changing CallingClaw's core meeting/voice logic.
- Building the opencode integration (plan only).
- Live push parity beyond polling for Hermes.

## Risks / open questions

- **`hermes -z` latency/turn limits** for deep prep — may need a longer timeout or `hermes chat -q` if `-z` caps tool turns.

## Resolved during implementation (verified against Hermes v0.15.0)

- **Model id format:** Hermes uses *bare* ids (`anthropic/claude-sonnet-4.6`) with a separate `--provider openrouter` (or `model.provider` in config) — NOT an `openrouter/...` prefix. Adapter defaults updated accordingly; provider via `HERMES_PROVIDER`.
- **CLI arg order:** the prompt must come *immediately* after `-z` (`hermes -z "<prompt>" -m <model> --provider openrouter`). argparse treats `-z` as taking exactly one value.
- **Binary location:** installs to `~/.local/bin/hermes` (which isn't always on a daemon's PATH). Adapter resolves via `HERMES_BIN` → `~/.local/bin/hermes` → PATH.
- **MCP config:** `~/.hermes/config.yaml` under `mcp_servers:` (`command`/`args`/`env`/`enabled`), matching the existing plugin schema. Registered by `scripts/setup-hermes.sh`.
- **MCP server upgraded in place** (not a new dir): `plugins/callingclaw-events` now exposes universal tools + keeps the Claude channel push.
- **Env-pollution gotcha:** some agent-harness/CI env vars (e.g. OpenTelemetry `BAGGAGE`) break Hermes' Python HTTP client when Hermes is spawned as a subprocess. `scripts/e2e-hermes.ts` passes a sanitized allowlist env. Not an issue for normal user runtimes (backend started from a shell).
- **Event push is per-process:** each one-shot `hermes -z` spawns a fresh MCP server with an empty event buffer, so live event push needs a *persistent* Hermes session (interactive/gateway). The persistent event→buffer→`recent_events` flow is verified in `plugins/callingclaw-events/test/e2e-mcp.test.ts`.

## Verification status

- Unit/integration: `plugins/callingclaw-events` (17 tests, incl. real MCP-stdio E2E) + `callingclaw-backend/test/adapters/hermes-adapter.test.ts` (6 tests) — all green.
- Live E2E (`bun scripts/e2e-hermes.ts`, real Hermes + OpenRouter Sonnet 4.6): conversation (`callingclaw_status`), 会议议程拉起 (`callingclaw_prepare_meeting`), and event polling (`callingclaw_recent_events`) all pass.
