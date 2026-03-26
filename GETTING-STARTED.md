# Getting Started with CallingClaw

---

## What is CallingClaw?

A voice AI that joins your Google Meet/Zoom meetings, listens, speaks, takes notes, and controls your computer. Runs locally on your Mac.

```
┌─────────────────────────────────────────┐
│  Your Mac                               │
│                                         │
│  CallingClaw Desktop (Electron UI)      │
│       │                                 │
│  CallingClaw Backend (Bun, :4000)       │
│       │                                 │
│  OpenClaw Gateway (:18789, optional)    │
│  └─ Deep reasoning + meeting prep       │
└─────────────────────────────────────────┘
```

---

## Prerequisites

| Software | Install |
|----------|---------|
| **macOS 13+** | — |
| **Node.js 18+** | `brew install node` |

That's it. The setup script installs everything else (Bun, OpenClaw).

**Note:** No virtual audio drivers needed. Audio injection happens at the browser level via Playwright's `addInitScript` (since v2.7.12). CallingClaw uses your main Chrome profile for Google account authentication.

**Optional** (for Computer Use screen control):
```bash
brew install cliclick
```

---

## Setup (One Command)

```bash
git clone https://github.com/XEasonChan/callingclaw.git
cd callingclaw
./scripts/setup.sh
```

The setup script will:
1. Install **Bun** (if missing)
2. Install **OpenClaw** via npm (if missing)
3. Run OpenClaw onboarding (first time — asks for API keys)
4. Create `.env` from template
5. Install all dependencies

### API Keys

After setup, edit `.env` and add your keys:

```bash
# Required — voice AI
OPENAI_API_KEY=sk-xxx

# Recommended — analysis, vision, computer use
OPENROUTER_API_KEY=sk-or-v1-xxx
```

Get keys at:
- OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- OpenRouter: [openrouter.ai/keys](https://openrouter.ai/keys)

---

## Start

```bash
./scripts/start.sh
```

This starts (in order):
1. **OpenClaw gateway** on :18789 (deep reasoning engine)
2. **CallingClaw backend** on :4000 (voice, meetings, tools)
3. **CallingClaw Desktop** (Electron window)

The desktop app opens automatically. You'll see your calendar and meeting cards.

### Other modes

```bash
./scripts/start.sh --no-desktop    # headless — use http://localhost:4000/voice-test.html
./scripts/start.sh --only-backend  # API only
```

### Stop

```bash
./scripts/stop.sh
```

---

## Quick Test

### Browser voice test
Open http://localhost:4000/voice-test.html — click Start and talk.

### Desktop app
Click a meeting card and use "Prepare" or "Join" to start.

### Health check
```bash
curl http://localhost:4000/api/status
```

---

## Configuration

### Voice Provider

Default is OpenAI (`~$0.30/min`). Switch to Grok for 6x cheaper (`~$0.05/min`):

```bash
# In .env
VOICE_PROVIDER=grok
XAI_API_KEY=your-xai-key
```

Or switch at runtime in the Desktop status bar dropdown.

### Google Calendar

Run the auth script — it opens your browser to sign in with Google:

```bash
./scripts/google-auth.sh
```

Authorize CallingClaw to access your calendar. The refresh token is automatically saved to `.env`. Then restart:

```bash
./scripts/stop.sh && ./scripts/start.sh
```

Calendar events with Google Meet links will now appear in the desktop app.

### macOS Permissions

On first run, grant these in **System Settings > Privacy & Security**:

| Permission | Why |
|-----------|-----|
| Microphone | Voice capture |
| Screen Recording | Screen analysis |
| Accessibility | Computer control |

---

## OpenClaw Setup (Control UI + Channels)

After `./scripts/start.sh`, OpenClaw runs on http://localhost:18789.

### Access the Control UI (Web Dashboard)

```bash
openclaw dashboard
```

This opens the Control UI in your browser with the auth token pre-filled. If you need the URL manually:

```bash
openclaw dashboard --no-open
# Outputs: http://localhost:18789/#token=xxx
```

If the browser shows "pairing required", approve the device:

```bash
openclaw devices list                    # find the pending request ID
openclaw devices approve <request-id>    # approve it
```

### Connect Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram → get the bot token
2. Add the channel:

```bash
openclaw channels add --channel telegram --token "123456:ABCDEF..."
```

3. Restart the gateway to pick up the new channel:

```bash
./scripts/stop.sh && ./scripts/start.sh --no-desktop
```

4. Message your bot on Telegram. First message triggers **DM pairing** — approve it:

```bash
openclaw pairing list          # see pending pairing request
openclaw pairing approve       # approve (or approve a specific ID)
```

Now your bot responds on Telegram. CallingClaw's meeting notes and todos are delivered here.

### Connect WeChat (via openclaw-weixin plugin)

1. Install the WeChat plugin:

```bash
openclaw plugins install @tencent-weixin/openclaw-weixin
```

2. Enable it in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-weixin": { "enabled": true }
    }
  }
}
```

3. Restart the gateway:

```bash
./scripts/stop.sh && ./scripts/start.sh --no-desktop
```

4. Check the gateway log for the WeChat QR code or login instructions:

```bash
tail -f /tmp/openclaw-gateway.log | grep -i weixin
```

### Other Channels

```bash
# Discord
openclaw channels add --channel discord --token "your-discord-bot-token"

# WhatsApp (QR code pairing)
openclaw channels login

# List all configured channels
openclaw channels list

# Check channel health
openclaw channels status
```

See [OpenClaw channel docs](https://docs.openclaw.ai/channels) for full setup guides.

### Useful OpenClaw Commands

```bash
openclaw status              # channel health + session info
openclaw devices list        # paired devices (browser, CallingClaw)
openclaw health              # gateway health check
openclaw doctor --fix        # auto-fix common issues
openclaw logs                # tail gateway logs
```

---

## What Works Without OpenClaw

OpenClaw is optional. Without it, CallingClaw still provides:

| Feature | Without OpenClaw |
|---------|-----------------|
| Voice conversation | ✅ Full |
| Join Google Meet/Zoom | ✅ Full |
| Meeting notes | ✅ Basic (no deep context) |
| Computer Use | ✅ Full |
| Calendar | ✅ View/create |
| Screen analysis | ✅ Full |
| Meeting prep briefs | ❌ Needs OpenClaw |
| Telegram delivery | ❌ Needs OpenClaw |

---

## Troubleshooting

### Backend won't start
```bash
lsof -ti :4000 | xargs kill   # kill stale process
./scripts/start.sh
```

### OpenClaw not connecting
```bash
curl http://localhost:18789/healthz   # should return {"ok":true}
# If not running:
openclaw gateway --port 18789
```

### No voice audio
1. Check API key: `curl http://localhost:4000/api/status`
2. Check mic: System Settings > Sound > Input (should NOT be BlackHole)

### Meet audio not working
1. `system_profiler SPAudioDataType | grep BlackHole`
2. Restart Mac if BlackHole was just installed

---

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture docs.
See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for feature-by-feature code flow.
