# Agent-Matched Google OAuth During Bot Onboarding

> Research/design note, 2026-07-01. Status: **proposed**.
> Context: During CallingClaw bot onboarding, some users may already run an
> agent platform such as OpenClaw, Hermes, Claude Code, or Codex that has its
> own Google Calendar OAuth/tooling. CallingClaw should detect and reuse those
> capabilities when safe, instead of always forcing a new CallingClaw Google
> OAuth flow.

## Core distinction

Do not treat "the model has Google Calendar" as a model capability. Calendar
access belongs to the **agent runtime / tool layer / OAuth client**, not to the
LLM itself.

CallingClaw should therefore match against a **Calendar provider**, not scrape
tokens by default:

- Agent-delegated provider: OpenClaw/Hermes/Claude/Codex can list or create
  calendar events through their own tools.
- CallingClaw-native provider: CallingClaw owns the OAuth client and token.
- Legacy token import: CallingClaw explicitly imports a known local token after
  user consent.
- Manual provider: user pastes a Meet link.

## Recommended decision

Use this priority during onboarding:

| Rank | Provider | Use when | Product behavior |
|---|---|---|---|
| 1 | Existing healthy CallingClaw token | `calendar.connected=true` | Continue; no new auth |
| 2 | Agent-delegated, headless-capable | Active platform can be invoked by CallingClaw backend and can perform Calendar actions reliably | Select as Calendar provider; no token import |
| 3 | Agent-delegated, session-only | Current onboarding agent can call Calendar tools, but backend cannot call them later | Use for onboarding meeting creation/listing only; ask for native provider before enabling auto-join |
| 4 | CallingClaw-native OAuth | No reliable agent provider exists, or user wants product-default auto-join | Start CallingClaw OAuth |
| 5 | Explicit token import | User confirms importing a known OpenClaw/gcloud/local token | Import, tag source, never silently overwrite |
| 6 | Manual Meet link | User declines calendar access or enterprise policy blocks OAuth | Continue onboarding with pasted Meet link |

This reduces first-run friction without making CallingClaw's core calendar
automation dependent on an unreliable conversational path.

## Platform matrix

| Platform | What we can detect today | Best matching strategy | Caveat |
|---|---|---|---|
| OpenClaw | Local files like `~/.openclaw/workspace/google-token.json`; existing `/callingclaw google-auth` already scans and imports them | Prefer an OpenClaw-delegated provider if gateway/tooling exposes Calendar. Token import only after explicit consent | Current implementation writes imported credentials into `.env`; replace with provider registration or CallingClaw token store |
| Hermes | `~/.hermes/config.yaml` lists MCP servers. Hermes can have arbitrary MCP tools, including a user-provided Calendar server | During Hermes onboarding, ask Hermes to run a Calendar capability probe and register the result with CallingClaw | If Hermes can only call tools in the current session, use it for onboarding but not background auto-join |
| Claude Code | User/global MCP config may include Google Calendar servers. CallingClaw currently registers only `callingclaw-events` | Probe Claude's available MCP tools or have Claude call a new `callingclaw_register_calendar_provider` tool with its Calendar tool mapping | Headless `claude -p` must be launched with the same MCP config/tools to be usable by backend |
| Codex | `~/.codex/config.toml` may include MCP servers; ChatGPT/Codex app connectors are not automatically available to the local backend | Treat Codex MCP Calendar tools as session or headless provider only if the CLI config proves available | Do not assume ChatGPT connected apps are exposed to `codex exec` |
| Standalone | No external agent tool layer | Use CallingClaw-native OAuth or manual Meet link | Safest default path |
| Browser/Chrome Google login | Chrome profile can be logged into Google for Meet | Keep as separate "Meet identity" step | Chrome login is not Calendar API OAuth |

## Matching handshake

CallingClaw needs a small provider-discovery protocol that every onboarding
surface can use.

### Backend API

| Endpoint | Purpose |
|---|---|
| `GET /api/calendar/providers` | Returns detected providers, selected provider, source, capabilities, and health |
| `POST /api/calendar/providers/select` | Selects a provider by id |
| `POST /api/calendar/providers/register-agent` | Agent reports a Calendar provider it can operate, with tool mapping and background capability |
| `POST /api/calendar/providers/test` | Runs a low-risk probe, e.g. list next 1 event |
| `POST /api/calendar/providers/import-token` | Explicit user-approved token import from OpenClaw/gcloud/local source |

### MCP tools

Add these to both `mcp/` and `plugins/callingclaw-events`:

| Tool | Purpose |
|---|---|
| `callingclaw_discover_calendar_providers` | Show current provider candidates during onboarding |
| `callingclaw_register_calendar_provider` | Let the active agent declare "I can list/create Calendar events via these tools" |
| `callingclaw_test_calendar_provider` | Ask CallingClaw to validate the selected provider |
| `callingclaw_select_calendar_provider` | Commit the user's choice |

The register call should not include secrets. It should include metadata:

```json
{
  "platform": "hermes",
  "mode": "agent_delegated_session",
  "capabilities": ["list_events", "create_event"],
  "toolMap": {
    "list_events": "google_calendar_list_events",
    "create_event": "google_calendar_create_event"
  },
  "accountHint": "a***@example.com",
  "backgroundCapable": false
}
```

## CalendarProvider interface

Backend code should treat all sources through one interface:

```ts
interface CalendarProvider {
  id: string;
  source: "callingclaw_native" | "openclaw" | "hermes" | "claude-code" | "codex" | "manual";
  mode: "native_oauth" | "agent_delegated_headless" | "agent_delegated_session" | "legacy_import" | "manual";
  capabilities: {
    listEvents: boolean;
    createEvent: boolean;
    patchEvent: boolean;
    freeBusy: boolean;
    background: boolean;
  };
  healthCheck(): Promise<{ ok: boolean; message?: string; accountHint?: string }>;
  listUpcomingEvents?(maxResults?: number): Promise<CalendarEvent[]>;
  createEvent?(event: CalendarEvent): Promise<string>;
}
```

Important behavioral rule:

- `MeetingScheduler` can use only providers with `background=true`.
- Onboarding meeting creation can use session-only providers.
- `PostMeetingDelivery.patchEvent()` requires a provider with `patchEvent=true`.

## Onboarding flow

Replace current Stage 3 with:

1. Check Calendar provider status.
2. Check Chrome/Meet login status separately.
3. If Calendar disconnected, run provider discovery:
   - Existing CallingClaw token.
   - OpenClaw local provider or gateway provider.
   - Current agent-delegated provider.
   - CallingClaw-native OAuth.
   - Manual link fallback.
4. Ask the user to confirm the selected provider if it will read Calendar data.
5. For session-only agent providers, explicitly say:
   "I can use your current agent's Calendar access for this onboarding meeting.
   For future auto-join while you are not chatting with the agent, connect
   CallingClaw Calendar later."
6. Continue to create/join onboarding meeting.

## Security and policy rules

- Never silently copy OAuth refresh tokens from OpenClaw, Hermes, gcloud, or
  another agent into CallingClaw.
- If importing a token, show source path, masked client id, account hint if
  available, and explain it will be stored by CallingClaw.
- Prefer delegated calls over token import.
- Treat Calendar event title/description/attendees as untrusted input before
  feeding it into an agent. Calendar events can contain prompt injection.
- Track `calendar.provider.source` in status and logs so support can debug
  "Calendar is connected but auto-join did not run" cases.
- Do not call this an OAuth bypass. If another agent accesses Google Calendar,
  that agent's OAuth client and data-use policy own the compliance burden.

## Current code impact

Likely touchpoints:

- `.agents/skills/callingclaw-onboarding/SKILL.md`
  - Rewrite Stage 3 as provider matching, not `scripts/google-auth.sh`.
- `callingclaw-backend/src/mcp_client/google_cal.ts`
  - Split Google API client from provider selection and token scanning.
- `callingclaw-backend/src/config_server.ts`
  - Replace ad hoc `/api/google/scan/apply/set` onboarding behavior with
    provider discovery and explicit import.
- `callingclaw-backend/src/skills/callingclaw-skill.ts`
  - Replace automatic `/api/google/apply` with user-confirmed provider select.
- `plugins/callingclaw-events/tools.ts` and `mcp/src/tools.ts`
  - Add provider discovery/register/select tools.
- `scripts/setup-hermes.sh`, `scripts/setup-claude-code.sh`, `scripts/setup-codex.sh`
  - Register CallingClaw MCP as today, then optionally run a Calendar provider
    probe that lets the active agent report available Google Calendar tools.

## Acceptance criteria

- During onboarding, a Hermes/OpenClaw/Claude/Codex user with existing Calendar
  capability can create the onboarding meeting without running
  `scripts/google-auth.sh`.
- CallingClaw status shows the chosen provider and whether it supports
  background scheduler use.
- Session-only providers do not enable unattended auto-join.
- No refresh token is imported without explicit user confirmation.
- Manual Meet-link onboarding still works with no Calendar provider.

## Sources

- Google OAuth overview, token/scopes, and refresh token expiration:
  https://developers.google.com/identity/protocols/oauth2
- Google Calendar API scopes:
  https://developers.google.com/workspace/calendar/api/auth
- Google sensitive scope verification:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
