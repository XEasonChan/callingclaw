# CallingClaw — AI Meeting Room

> Real-time voice AI for meetings. Joins Google Meet/Zoom, listens, speaks, takes notes, controls the computer.

## Architecture

```
callingclaw-backend/     Bun backend — AI orchestration, voice, meeting lifecycle
callingclaw-desktop/     Electron desktop app — UI, audio bridge, tray
callingclaw-landing/     Landing page (Vercel)
```

## Tech Stack

- **Runtime:** Bun (backend), Electron 35+ (desktop)
- **Voice:** OpenAI Realtime API / xAI Grok Realtime (switchable)
- **AI:** Claude via OpenRouter (analysis), Haiku (fast classification), Gemini Flash (vision)
- **Audio:** AudioWorklet capture + playback ring buffer, Playwright addInitScript injection for Meet (BlackHole removed v2.7.12)
- **Context:** 5-layer model (see callingclaw-backend/CONTEXT-ENGINEERING.md)

## Key Files

| File | Purpose |
|------|---------|
| `callingclaw-backend/src/callingclaw.ts` | Main entry, module wiring |
| `callingclaw-backend/src/ai_gateway/realtime_client.ts` | Multi-provider Realtime WS client |
| `callingclaw-backend/src/modules/voice.ts` | Voice module (audio state machine, heard transcript) |
| `callingclaw-backend/src/config_server.ts` | HTTP API + WebSocket server |
| `callingclaw-backend/src/voice-persona.ts` | Context engineering layers |
| `callingclaw-backend/src/native-bridge.ts` | NativeBridge (osascript + cliclick, replaced Python sidecar) |
| `callingclaw-desktop/src/renderer/audio-bridge.js` | AudioWorklet capture + playback |
| `callingclaw-desktop/src/renderer/index.html` | Desktop UI (vanilla JS) |
| `callingclaw-desktop/src/main/index.js` | Electron main process |

## Development

- Backend: `cd callingclaw-backend && bun --hot run src/callingclaw.ts`
- Desktop: `cd callingclaw-desktop && npm start -- --dev`
- Build DMG: `cd callingclaw-desktop && npx electron-builder --mac --config.directories.output=/tmp/cc-dist`
  - **Must output to non-iCloud path** — iCloud re-adds resource forks between afterPack and codesign
  - `build/afterPack.js` strips xattrs but iCloud re-adds them; `/tmp` is the reliable workaround
  - Copy DMG from `/tmp/cc-dist/` to `dist/` after build
- Tests: `cd callingclaw-backend && bun test`

## Rules

- Use Bun, not Node.js (backend)
- Vanilla JS in Electron renderer (no TypeScript in HTML files)
- Audio: always 24kHz PCM16 mono
- Context: follow 5-layer model in CONTEXT-ENGINEERING.md
- DMG build: output to /tmp, not iCloud (afterPack.js + non-iCloud output dir)

## Known Gotchas (Bug Memory)

These are bugs that have happened before. Check this section before making changes to related areas.

| Area | Gotcha | Burned When |
|------|--------|-------------|
| **Desktop renderer** | NEVER use TypeScript syntax in index.html — P0 crash, happened twice | v2.4.1, v2.6.2 |
| **DMG build** | iCloud resource forks → codesign fails. Must build to `/tmp`, not iCloud Drive | v2.7.10 |
| **Bundle ID** | Dev mode = `com.github.electron`, prod = `com.tanka.callingclaw`. TCC permissions don't carry between them | v2.7.10 |
| **Audio setSinkId** | `setSinkId()` MUST be called BEFORE `getUserMedia()` (Electron bug #40704) — silent audio failure | v2.5.0 |
| **Onboarding steps** | HTML data-ob order must match obCheckStep() JS — step 2=mic, 3=accessibility, 5=openclaw, 6=summary | v2.7.10 |
| **Scheduler events** | Use `meeting.prep_ready` not `scheduler.prep_ready` — frontend only listens for the former | v2.7.8 |
| **savePrepBrief** | Fire-and-forget save needs onPrepReady callback to notify frontend; without it, 5-min delay | v2.7.8 |
| **MeetingScheduler dedup** | Must check existing sessions by meetUrl/calendarEventId before creating new ones | v2.7.9 |
| **BlackHole speaker** | If system default output = BlackHole, direct mode AI audio goes to virtual device, user hears nothing | v2.7.10 |
| **getUserMedia + BlackHole** | Even virtual audio devices trigger macOS TCC mic permission — must be in checkAll() | v2.7.10 |
| **BlackHole macOS 26** | BlackHole 0.6.1 loopback is BROKEN on macOS 26 Tahoe (0 signal). Use Playwright addInitScript audio injection instead | v2.7.11 |
| **Meet audio receivers** | Meet creates 5+ audio receivers per PeerConnection, most are `muted=true` (silence). MUST select `track.muted===false` for the active speaker — picking first receiver gives all zeros | v2.7.11 |
| **Worklet cross-origin** | AudioWorklet.addModule() from localhost fails inside Meet page (cross-origin). MUST use Blob URL inline worklet code | v2.7.11 |
| **Playwright CLI vs Library** | `playwright-cli` eval() cannot intercept getUserMedia (Meet caches at module load). MUST use Playwright library `addInitScript()` for pre-load injection | v2.7.11 |
| **Meet bot detection** | Playwright Chrome must use `--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs: ["--enable-automation"]` or Meet blocks joining | v2.7.11 |
| **Audio capture self-check** | After joining Meet, MUST verify captured audio has nonzero amplitude (maxAmp > 0). If all zeros, cycle through ALL receivers trying each for 3s — the unmuted receiver may appear later after join stabilizes | v2.7.12 |
| **Playwright lib vs CLI coexistence** | `launchPersistentContext` holds Chrome process — playwright-cli CANNOT connect to same profile simultaneously. For Meet audio injection, use Playwright library for ALL operations (join + audio), bypass playwright-cli entirely. ChromeLauncher.launch() in meeting-routes.ts conflicts with playwright-cli path | v2.7.12 |
| **Admit monitor missing** | E2E audio injection flow (ChromeLauncher/Playwright library) does not have participant admission logic. PlaywrightCLIClient.startAdmissionMonitor() needs to be ported to Playwright library page object | v2.7.12 |
