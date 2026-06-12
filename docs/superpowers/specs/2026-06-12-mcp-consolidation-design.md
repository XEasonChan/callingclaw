# MCP Consolidation: One Server, Two Capability Surfaces

> Design doc, 2026-06-12. Status: **proposed**.
> Context: the repo currently ships TWO MCP servers that grew independently —
> `mcp/` (30 tools, npm `callingclaw-mcp@1.0.0`, control surface) and
> `plugins/callingclaw-events` (11 tools, Bun script, event stream + onboarding).
> They overlap on 6 tools with diverging names/schemas. This plan merges them
> into ONE server exposing two capability surfaces: **control** and **events**.

## Decision summary

| Question | Decision | Why |
|---|---|---|
| Which codebase survives? | **`mcp/`** absorbs the plugin | npm-published (existing users), 1,327-line test suite, typed REST client with timeouts; plugin's client is thin |
| Tool naming | **Bare names** (`join_meeting`, not `callingclaw_join_meeting`) | `callingclaw-mcp@1.0.0` is public API; MCP clients already namespace by server. The plugin's prefixed names get a one-release compat shim |
| Runtime | **Node 18+** (current mcp/ build) | npm distribution requires Node; Bun-only code paths get eliminated (see "scan tool" below) |
| Where do capabilities live? | **In the backend, behind REST** — the MCP server stays a thin client | This was the architecture rule all along; the plugin violated it once (`scan_claude_projects` spawns `bun` directly) and it immediately caused a runtime coupling problem |
| Event capability | **Ported into `mcp/src/events.ts`** as an optional surface | Events are the plugin's unique value (ring buffer + `/ws/events` subscriber + Claude channel notifications). Optional: server runs fine when backend is down |
| `plugins/callingclaw-events` fate | Thin **compat shim for one release**, then deleted | `setup-hermes.sh`, `~/.hermes/config.yaml` entries, and the onboarding SKILL.md reference it today |

## Target architecture

```
mcp/  (callingclaw-mcp@1.1.0, npm + bun-compatible source)
├── src/index.ts        — stdio server; wires BOTH surfaces
├── src/tools.ts        — CONTROL surface (request/response, ~33 tools)
├── src/events.ts       — EVENTS surface (NEW, ported from plugin):
│   │                       • EventBuffer (ring, 100 events, cursor)
│   │                       • WS subscriber → ws://localhost:4000/ws/events
│   │                       •   (lazy connect, exponential retry, survives backend restarts)
│   │                       • Claude channel notifications (notifications/claude/channel)
│   │                       •   for clients that support push; polling tool for the rest
│   └── tool: recent_events (cursor-based polling)
├── src/callingclaw.ts  — REST client (single one, typed, timeouts)
└── src/__tests__/      — merged suite (mcp's 1,327 lines + plugin's ported cases)
```

**Two surfaces, one process:** control tools always work (pure REST); the
events surface activates when `/ws/events` is reachable and degrades to
"empty buffer + hint" when not. No client configuration difference.

## Tool reconciliation (30 + 11 → 33)

### Overlaps — keep mcp/ name, adopt best schema
| Final tool | From | Schema change |
|---|---|---|
| `get_status` | mcp | none (plugin's `callingclaw_status` retired) |
| `get_transcript` | mcp | none |
| `get_meeting_summary` | mcp | meeting-id optional (plugin behavior) |
| `join_meeting` | mcp | **superset**: keep `botName`, add plugin's `topic` + `instructions` (persona shaping — needed by onboarding) |
| `list_calendar_events` | mcp | none |
| `check_ready` | mcp | **becomes the aggregate** the plugin's `onboarding_status` proved out: one call returns backend + permissions + google auth (clients hated 3 round-trips) |
| `open_permissions` / `google_chrome_login` | mcp | unchanged; plugin's unified `request_auth` retired (granular tools compose fine) |

### New tools ported from the plugin (bare names)
| Final tool | Notes |
|---|---|
| `recent_events` | cursor-based event polling (the events surface) |
| `prepare_meeting` | prep brief by topic/eventId — REST `/api/meeting/prepare` |
| `create_calendar_event` | calendar event + Meet link — REST `/api/calendar/create` (pairs with `join_meeting` for instant meetings) |
| `scan_claude_projects` | **moves into the backend**: new endpoint `POST /api/onboarding/scan-claude-projects` runs `scripts/onboarding-scan-claude-projects.ts` server-side and pins the result. MCP tool becomes a thin REST call — kills the `Bun.spawn` runtime coupling |

### Compat shim (one release only)
`plugins/callingclaw-events/index.ts` becomes ~40 lines: re-export the merged
server with the 11 legacy `callingclaw_*` names mapped to the new tools, log a
deprecation warning. Removed in the release after.

## Migration phases

**P1 — Events surface into mcp/** (~half day)
Port `event-buffer.ts` + WS subscriber + channel notifications into
`mcp/src/events.ts`; add `recent_events` tool; port the plugin's buffer tests.
Acceptance: `npx callingclaw-mcp` exposes `recent_events`; kill/restart the
backend → buffer reconnects and keeps the cursor.

**P2 — Backend endpoint + missing tools** (~half day)
Add `POST /api/onboarding/scan-claude-projects` to `config_server.ts` (runs the
scan script via `Bun.spawn` INSIDE the backend, where Bun is guaranteed);
add `prepare_meeting`, `create_calendar_event`, `scan_claude_projects` to
mcp/. Extend `join_meeting` schema (topic/instructions), upgrade `check_ready`
to the aggregate. Acceptance: merged test suite green; live smoke against a
running backend for all 4 new tools.

**P3 — Consumers cut over** (~1 hour, same PR as P2)
- `scripts/setup-hermes.sh`: register `mcp/` (via `npx callingclaw-mcp` or
  `node <repo>/mcp/dist/index.js`) instead of the plugin path
- `.agents/skills/callingclaw-onboarding/SKILL.md`: tool-name table updated to
  bare names (re-run the Hermes security scan after — the skill text changes)
- `README.md`: single MCP section ("two capability surfaces"), drop the
  events-server subsection
- `.claude-plugin/` manifest + `mcp/README.md` regenerated
- e2e: `scripts/e2e-hermes.ts` asserts the NEW tool names

**P4 — Shim + release** (~1 hour)
Plugin shim in place, `callingclaw-mcp@1.1.0` published, CHANGELOG entry with
the rename table. The release after (1.2.0) deletes `plugins/callingclaw-events`.

## Risks

- **Hermes installs in the wild** reference the plugin path in
  `~/.hermes/config.yaml` — the shim covers them for one release; the
  onboarding skill (Stage 1) points users at `setup-hermes.sh`, which will
  register the new server, so fresh installs are clean.
- **Channel notifications** (`notifications/claude/channel`) are a Claude-Code
  extension — guard behind capability detection so Hermes/Cursor sessions
  don't receive unknown notifications.
- **npm publish access** — verify the `callingclaw-mcp` npm token before P4.

## Out of scope
- Consolidating REST endpoints themselves (e.g. `request_auth`'s two backing
  endpoints stay as-is)
- Remote/HTTP MCP transport (stdio only, unchanged)
