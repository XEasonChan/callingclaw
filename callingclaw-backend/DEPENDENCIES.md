# CallingClaw — Dependency Manifest (v2.7.17)

## Quick Setup

```bash
cd callingclaw-backend
bun install
cp .env.example .env  # Edit with your API keys
bun --hot run src/callingclaw.ts
```

No Python, no BlackHole, no virtual audio drivers needed. Audio injection via Playwright `addInitScript`.

---

## System Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| **macOS** | 13+ (Ventura) | Required for Accessibility, Screen Recording TCC |
| **Bun** | 1.3+ | Runtime for backend |
| **Google Chrome** | Stable | Playwright launches Chrome for meeting join + audio |

---

## Bun Dependencies

Defined in `package.json`, installed via `bun install`.

| Package | Purpose |
|---------|---------|
| `openai` | OpenAI Realtime voice API + GPT-4o vision |
| `@anthropic-ai/sdk` | Claude Computer Use (direct or via OpenRouter) |
| `playwright-core` | Chrome automation for Meet join + audio injection |

> **Google Calendar** uses direct REST API with OAuth2 refresh tokens — no npm package.
> Credentials auto-discovered from `~/.openclaw/workspace/` or `.env`.

---

## API Keys

| Key | Required | Purpose |
|-----|----------|---------|
| `XAI_API_KEY` | **Yes** (default voice) | Grok Realtime voice (Eve) |
| `OPENAI_API_KEY` | Optional | OpenAI Realtime voice (alternative to Grok) |
| `OPENROUTER_API_KEY` | Recommended | Claude Computer Use via OpenRouter |
| `GOOGLE_CLIENT_ID` + `SECRET` + `REFRESH_TOKEN` | Optional | Calendar integration |

---

## Environment Variables

```bash
# .env — see .env.example for all options
XAI_API_KEY=xai-xxx                # Required (default voice provider)
OPENAI_API_KEY=sk-xxx              # Optional (alternative voice)
OPENROUTER_API_KEY=sk-or-v1-xxx    # Recommended (Computer Use)

GOOGLE_CLIENT_ID=                  # Optional (Calendar)
GOOGLE_CLIENT_SECRET=              # Optional
GOOGLE_REFRESH_TOKEN=              # Optional

PORT=4000                          # Backend HTTP + WebSocket
VOICE_PROVIDER=grok                # "grok" (default) or "openai"
```

---

## Removed Dependencies (historical)

These were used in earlier versions and have been fully removed:

| Dependency | Removed In | Replaced By |
|-----------|-----------|-------------|
| Python sidecar (pyautogui, mss, pyaudio) | v2.6.0 | NativeBridge (osascript + cliclick) |
| BlackHole virtual audio | v2.7.12 | Playwright addInitScript audio injection |
| portaudio (brew) | v2.6.0 | Not needed |
| playwright-cli (npm) | v2.7.13 | playwright-core library (ChromeLauncher) |

---

## Verification

```bash
bun --hot run src/callingclaw.ts    # Should start on :4000
curl http://localhost:4000/api/status  # Should return version + module status
bun test                              # All tests pass
```
