---
name: callingclaw-onboarding
description: "Install CallingClaw from GitHub, complete permissions + Google Calendar auth, and host a live onboarding meeting where the CallingClaw digital human introduces itself."
version: 1.0.0
author: CallingClaw
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [CallingClaw, Onboarding, Meetings, Voice-AI, Installer, Google-Meet]
    related_skills: [claude-code]
---

# CallingClaw Onboarding — Install → Authorize → Meet the Digital Human

CallingClaw is a real-time voice AI that joins Google Meet as a participant: it listens, speaks, takes notes, and controls the computer. This skill takes a brand-new user from a pasted GitHub link to a live onboarding call, end to end. macOS only.

Trigger this skill when the user: pastes the CallingClaw GitHub link, says "install CallingClaw / 安装 CallingClaw", asks to "try / 体验 CallingClaw", or asks for a CallingClaw onboarding.

**Conversational style:** report progress after each stage in one short message. Never dump raw JSON at the user. Match the user's language (中文 ↔ English).

---

## Stage 0 — Detect existing install

```bash
curl -sf http://localhost:4000/api/status
```

- **200 OK** → CallingClaw is already installed AND running. Skip to Stage 2.
- **Connection refused** → check if the repo exists locally:
  `test -d "$HOME/CallingClaw" || ls "$HOME/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0" 2>/dev/null`
  - Repo found → skip clone, go to Stage 1's start step.
  - Nothing → full install (Stage 1).

## Stage 1 — Install & start (the "one pasted link" path)

```bash
git clone https://github.com/XEasonChan/callingclaw.git "$HOME/CallingClaw"
cd "$HOME/CallingClaw"
./scripts/setup.sh            # installs Bun, dependencies, configures .env (interactive prompts possible)
./scripts/start.sh --no-desktop
```

Notes:
- If the user pasted a different GitHub URL, clone that instead.
- `setup.sh` may ask for API keys. CallingClaw needs at minimum `OPENAI_API_KEY` (voice) and `OPENROUTER_API_KEY` (fast models). If they're missing, ask the user for them ONE message at a time and write them into the repo's `.env`.
- After start, poll up to 60s: `curl -sf http://localhost:4000/api/status` until 200.
- Report: "✅ CallingClaw 已安装并启动" plus which subsystems `/api/status` reports healthy.

## Stage 2 — Permissions (macOS)

```bash
curl -s http://localhost:4000/api/onboarding/permissions
```

Read `allRequiredGranted`. If `false`, for each permission with `granted: false`:

1. Tell the user which permission is missing and why (Screen Recording → meeting screen analysis; Accessibility → keyboard/mouse automation).
2. Open the right Settings pane for them:
   ```bash
   curl -s -X POST http://localhost:4000/api/onboarding/permissions/open \
     -H "Content-Type: application/json" -d '{"panel":"screenRecording"}'   # or "accessibility"
   ```
3. Ask them to toggle it on, then re-check. Loop until `allRequiredGranted: true` or the user wants to skip (permissions can be granted later; the onboarding meeting still works without them — say so).

## Stage 3 — Google Calendar auth

```bash
curl -s http://localhost:4000/api/google/auth-status
```

- Connected → report "✅ 日历已连接" and move on.
- Not connected →
  ```bash
  curl -s -X POST http://localhost:4000/api/google/chrome-login    # opens Chrome to Google sign-in
  ```
  Tell the user: "我打开了 Chrome 的 Google 登录页，请在那边完成登录。" Then poll
  `curl -s http://localhost:4000/api/google/chrome-login/check` every ~15s (up to 5 min) until logged in.
- Calendar is needed for scheduled auto-join and creating the onboarding meeting. If the user declines, you can still run onboarding with a Meet link they provide.

## Stage 4 — Personalize: scan the user's Claude Code work (work-memory lite)

Before offering the meeting, gather light context so the digital human can talk about THEIR work, not generic marketing:

```bash
cd <repo-dir> && bun scripts/onboarding-scan-claude-projects.ts
curl -s -X POST http://localhost:4000/api/context/pin \
  -H "Content-Type: application/json" \
  -d '{"path":"'"$HOME"'/.callingclaw/shared/onboarding-context.md","summary":"User recent Claude Code projects (onboarding personalization)"}'
```

This reads only shallow metadata from `~/.claude/projects` (project paths, session counts, first message of recent sessions — no code or file contents) and pins it into CallingClaw's shared context. Mention to the user in one sentence what you did and that it's shallow metadata only.

If the scan finds projects, remember the top project name — use it when you offer the meeting ("比如可以聊聊你最近在做的 X").

## Stage 5 — ASK before the onboarding meeting

**Always ask first, never auto-start:**

> "要不要现在开一个 10 分钟的 CallingClaw 体验会议？CallingClaw 的数字人会加入 Google Meet，向你介绍自己、现场演示记笔记和屏幕共享——还能聊聊你最近在 <top project> 上的工作。"

- User says no → wrap up: summarize what's installed/authorized, tell them they can say "开个 onboarding 会议" any time. Done.
- User says yes → Stage 6.

## Stage 6 — Create + join the onboarding meeting

1. Create a calendar event with a Meet link, starting now:
   ```bash
   curl -s -X POST http://localhost:4000/api/calendar/create \
     -H "Content-Type: application/json" \
     -d '{"summary":"CallingClaw Onboarding 体验","start":"<now ISO8601 with tz>","end":"<now+30min ISO>","description":"CallingClaw digital human onboarding session"}'
   ```
   Extract the Meet link (`hangoutLink` / `meetLink` in the response).
   - If calendar isn't connected, ask the user to paste any Google Meet link instead.

2. Have CallingClaw join it (use the `callingclaw_join_meeting` MCP tool if available, otherwise REST):
   ```bash
   curl -s -X POST http://localhost:4000/api/meeting/join \
     -H "Content-Type: application/json" \
     -d '{"url":"<meet link>","topic":"CallingClaw Onboarding 体验","instructions":"This is a first-time onboarding session. Warmly introduce yourself as CallingClaw, explain you can take notes, share screen, control the computer, and prepare meetings. Reference the pinned onboarding-context to mention the user'\''s recent projects. Keep each turn short and invite questions."}'
   ```

3. **Send the user the Meet link** and tell them to join — CallingClaw is already inside and will admit them from the waiting room and greet them by voice.

4. After a few minutes, you can check how it's going with the `callingclaw_recent_events` / `callingclaw_transcript` MCP tools; when the meeting ends, a summary is generated automatically — offer to share it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/api/status` refuses connection | `cd <repo> && ./scripts/start.sh --no-desktop`, check `callingclaw-backend` logs |
| Join succeeds but no voice | Voice provider key missing — check `OPENAI_API_KEY` in repo `.env`, then `curl -X POST localhost:4000/api/voice/start` |
| Stuck in waiting room | The user must admit CallingClaw the first time if they own the meeting; afterwards CallingClaw auto-admits attendees |
| Calendar create fails | Re-run Stage 3; Google token may have expired |
