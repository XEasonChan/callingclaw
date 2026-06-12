---
name: callingclaw-onboarding
description: "Install CallingClaw from GitHub, complete permissions + Google Calendar auth, and host a live onboarding meeting where the CallingClaw digital human introduces itself."
version: 1.1.0
author: CallingClaw
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [CallingClaw, Onboarding, Meetings, Voice-AI, Installer, Google-Meet]
    related_skills: [claude-code]
---

# CallingClaw Onboarding — Install → Authorize → Meet the Digital Human

CallingClaw is a real-time voice AI that joins Google Meet as a participant: it listens, speaks, takes notes, and controls the computer. This skill takes a brand-new user from a pasted GitHub link to a live onboarding call. macOS only.

Trigger when the user: pastes the CallingClaw GitHub link, says "install CallingClaw / 安装 CallingClaw", asks to "try / 体验 CallingClaw", or asks for an onboarding.

**Architecture note:** all CallingClaw *capabilities* are exposed by the universal MCP server `callingclaw-events` (works in Hermes, Claude Code, opencode, Cursor). **Prefer the MCP tools below whenever they're available**; the `curl` commands are fallbacks for sessions where the MCP server isn't registered yet (e.g. right after a fresh install — Stage 1 registers it).

| Step | MCP tool | REST fallback |
|---|---|---|
| Readiness check | `callingclaw_onboarding_status` | `GET /api/status`, `/api/onboarding/permissions`, `/api/google/auth-status` |
| Open auth panes / Google login | `callingclaw_request_auth` | `POST /api/onboarding/permissions/open`, `/api/google/chrome-login` |
| Scan user's Claude projects | `callingclaw_scan_claude_projects` | `bun scripts/onboarding-scan-claude-projects.ts` + `POST /api/context/pin` |
| Create meeting w/ Meet link | `callingclaw_create_meeting` | `POST /api/calendar/create` |
| Join as digital human | `callingclaw_join_meeting` (url, topic, instructions) | `POST /api/meeting/join` |
| Watch progress | `callingclaw_recent_events` / `callingclaw_transcript` | `GET /ws/events`, `/api/meeting/transcript` |

**Conversational style:** report progress after each stage in one short message; never dump raw JSON. Match the user's language (中文 ↔ English).

---

## Stage 0 — Detect existing install

Call `callingclaw_onboarding_status` (or `curl -sf http://localhost:4000/api/status`).

- Backend healthy → skip to Stage 2.
- Unreachable → check for a local clone (`~/CallingClaw` or an existing checkout). Found → start it (Stage 1 start step); nothing → full install.

## Stage 1 — Install & start (the "one pasted link" path)

```bash
git clone https://github.com/XEasonChan/callingclaw.git "$HOME/CallingClaw"
cd "$HOME/CallingClaw"
./scripts/setup.sh            # installs Bun, dependencies, configures .env
./scripts/start.sh --no-desktop
```

- If the user pasted a different GitHub URL, clone that instead.
- `setup.sh` prompts for the needed configuration (voice + fast-model providers) interactively — let the user complete those prompts themselves; this skill never collects or stores credentials.
- Register the MCP server for THIS agent so the rest of the flow uses tools, not curl: the server entry point is `<repo>/plugins/callingclaw-events/index.ts` (run with `bun`). In Hermes: add under `mcp_servers:` in `~/.hermes/config.yaml`; in Claude Code: `claude mcp add callingclaw-events -- bun <repo>/plugins/callingclaw-events/index.ts`.
- Poll up to 60s until the backend is healthy, then report which subsystems are up.

## Stage 2 — Permissions (macOS)

From `callingclaw_onboarding_status` read `permissions.allRequiredGranted`. If false, for each missing permission:

1. Explain why it's needed (Screen Recording → meeting screen analysis; Accessibility → keyboard/mouse automation).
2. `callingclaw_request_auth` with `panel: "screenRecording"` / `"accessibility"` to open the right Settings pane.
3. Ask the user to toggle it on, re-check. The onboarding meeting still works without them — say so if the user wants to skip.

## Stage 3 — Google auth (calendar + Meet)

From `callingclaw_onboarding_status` read `google`:

- `calendar.connected: true` → done.
- Chrome not logged in → `callingclaw_request_auth` with `panel: "googleLogin"`, tell the user to complete the sign-in, re-check every ~15s.
- Calendar still disconnected with `hasCredentials: true` → the OAuth refresh token is expired: run `<repo>/scripts/google-auth.sh` (opens browser; user authorizes; writes the new token) and re-check.
- If the user declines calendar auth, onboarding can still run with a Meet link they paste.

## Stage 4 — Personalize: scan the user's Claude Code work (work-memory lite)

**Ask the user first** (one sentence: shallow metadata only — project paths and recent session openers, no code). On consent, call `callingclaw_scan_claude_projects`. It scans `~/.claude/projects`, writes `~/.callingclaw/shared/onboarding-context.md`, and pins it into CallingClaw's shared context automatically. Remember the top project name for the next stage.

## Stage 5 — ASK before the onboarding meeting

**Always ask, never auto-start:**

> "要不要现在开一个 10 分钟的 CallingClaw 体验会议？CallingClaw 的数字人会加入 Google Meet，向你介绍自己、现场演示记笔记和屏幕共享——还能聊聊你最近在 <top project> 上的工作。"

No → summarize what's set up, mention they can ask any time. Done.

## Stage 6 — Create + join the onboarding meeting

1. `callingclaw_create_meeting` with `summary: "CallingClaw Onboarding 体验"` (start defaults to now, 30 min). Extract the Meet link from the result. If calendar isn't connected, ask the user to paste any Meet link instead.
2. `callingclaw_join_meeting` with:
   - `url`: the Meet link
   - `topic`: `"CallingClaw Onboarding 体验"`
   - `instructions`: "This is a first-time onboarding session. Warmly introduce yourself as CallingClaw, explain you can take notes, share screen, control the computer, and prepare meetings. Reference the pinned onboarding-context to mention the user's recent projects. Keep each turn short and invite questions."
3. **Send the user the Meet link** — CallingClaw is already inside, will admit them from the waiting room, and greets them by voice.
4. Check in via `callingclaw_recent_events` / `callingclaw_transcript`; when the meeting ends a summary is generated automatically — offer to share it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Backend unreachable | `cd <repo> && ./scripts/start.sh --no-desktop` |
| Join ok but no voice | Voice provider not configured — re-run `./scripts/setup.sh`, then `POST /api/voice/start` |
| Stuck in waiting room | The meeting owner must admit CallingClaw once; afterwards it auto-admits attendees |
| Calendar create fails | Refresh token expired → `scripts/google-auth.sh`, then re-check Stage 3 |
