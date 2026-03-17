# Onboarding — Backend API Requirements

The Electron onboarding flow needs these endpoints on `:4000` to fully function.
Currently the frontend gracefully degrades when they're missing (shows status as unknown, buttons still advance).

## Required Endpoints

### 1. `GET /api/skill/manifest`

Returns the latest CallingClaw skill markdown to be written to `~/.claude/commands/callingclaw.md`.

**Response:**
```json
{
  "markdown": "# /callingclaw — AI Meeting Room\n\n..."
}
```

**Why:** The Electron app writes this file during onboarding step 4 ("连接 OpenClaw"). If this endpoint isn't available, a bundled fallback is used (defined in `callingclaw-desktop/src/main/index.js` as `BUNDLED_SKILL_MARKDOWN`).

**Backend action:** Add this route to `config_server.ts`. The content should match `CALLINGCLAW_SKILL_MANIFEST` in `openclaw-callingclaw-skill.ts` but rendered as full markdown with API docs.

---

### 2. `POST /api/keys`

Saves API keys to the `.env` file.

**Request:**
```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENROUTER_API_KEY": "sk-or-v1-..."
}
```

**Response:**
```json
{ "ok": true }
```

**Status:** This endpoint likely already exists. Onboarding step 3 ("连接 AI 引擎") calls it to persist keys.

---

### 3. `GET /api/status`

Returns full system health. Already exists.

Used by the onboarding "Ready" step to show a config summary.

---

## Permissions (Electron-side only, no backend needed)

These are handled entirely by Electron's main process via IPC:

| Permission | IPC Channel | How it works |
|-----------|-------------|--------------|
| Screen Recording | `permissions:openSettings` | Opens `System Preferences > Privacy > Screen Recording` |
| Accessibility | `permissions:openSettings` | Opens `System Preferences > Privacy > Accessibility` |
| Permission check | `permissions:check` | Uses `systemPreferences.getMediaAccessStatus()` |

The frontend polls every 1.5s after opening System Settings to detect when the user grants the permission.

**Note:** Screen Recording requires an app restart to take effect after granting. The onboarding shows this warning.

---

## Skill Installation (Electron-side only)

| IPC Channel | What it does |
|-------------|-------------|
| `skill:check` | Runs `which claude` to find CLI, checks if `~/.claude/commands/callingclaw.md` exists |
| `skill:install` | Tries `GET /api/skill/manifest` for latest content, falls back to bundled markdown. Writes to `~/.claude/commands/callingclaw.md` |

---

## BlackHole Audio (Future)

Currently the onboarding "Ready" step just checks if BlackHole is installed via `system_profiler SPAudioDataType`.

Future plan: Bundle BlackHole `.pkg` in Electron's `extraResources` and auto-install on first launch with admin privileges.

---

## WebSocket: `/ws/openclaw` (Future — Pneuma-style fallback)

When OpenClaw Gateway (`:18789`) is not running, CallingClaw should be able to spawn `claude --sdk-url ws://localhost:4000/ws/openclaw` for one-off deep reasoning.

**Backend action:** Add a WebSocket handler at `/ws/openclaw` that speaks Claude Code's `stream-json` protocol (see [pneuma-skills](https://github.com/pandazki/pneuma-skills) `backends/claude-code/cli-launcher.ts` for reference).

This is a Phase 3+ task, not needed for onboarding.
