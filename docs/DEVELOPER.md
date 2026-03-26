# Developer Guide

Setup notes for contributors and self-hosted deployments.

---

## Google Calendar OAuth (Developer Setup)

CallingClaw ships with a built-in Google OAuth client for end users. If you're forking or self-hosting, you need your own:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select existing)
3. Enable **Google Calendar API**: APIs & Services → Library → search "Google Calendar API" → Enable
4. Configure **OAuth consent screen**: APIs & Services → OAuth consent screen
   - User type: External
   - App name: `CallingClaw`
   - Scopes: add `https://www.googleapis.com/auth/calendar`
   - Test users: add your Google account email
5. Create **OAuth credentials**: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Name: `CallingClaw`
   - Authorized redirect URIs: add `http://localhost:3939/callback`
6. Copy **Client ID** and **Client Secret** into `.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

Then run `./scripts/google-auth.sh` to generate a refresh token.

**Note:** While in "Testing" mode, OAuth consent expires every 7 days. Publish the app to remove this limit (Google review required for sensitive scopes).

---

## OpenClaw Gateway Token

CallingClaw connects to OpenClaw via WebSocket. The gateway token is read from:

1. `OPENCLAW_GATEWAY_TOKEN` in `.env` (highest priority)
2. `~/.openclaw/openclaw.json` → `gateway.auth.token` (auto-detected by `setup.sh`)

If you change the OpenClaw token, update `.env` and restart.

---

## Device Identity

CallingClaw uses an Ed25519 keypair to authenticate with OpenClaw's gateway (required for scope grants). The identity is auto-generated at:

- `~/.callingclaw/device.json` (CallingClaw's own identity)
- Falls back to `~/.openclaw/identity/device.json` (shared with OpenClaw CLI)

If you get `missing scope: operator.write` errors, delete `~/.callingclaw/device.json` and restart — a fresh identity will be generated and auto-paired.

---

## Remote OpenClaw Deployment

Currently, CallingClaw hardcodes `ws://localhost:18789` for the OpenClaw gateway connection. Remote deployment requires editing `openclaw_bridge.ts` to change the URL.

The gateway token can be overridden via `.env`:

```bash
OPENCLAW_GATEWAY_TOKEN=your-token
```

**What works remotely (once URL is changed):** Meeting prep, context recall, summary generation (all WebSocket push).

**What requires same machine:** Auto-join cron callback (OpenClaw fires HTTP to `localhost:4000`), todo execution from Telegram, `/callingclaw` skill. See [docs/DECOUPLING.md](./DECOUPLING.md) for a planned WS command channel to fix this.

---

## Build DMG

```bash
cd callingclaw-desktop
xattr -cr .
npm run build
# Output: dist/CallingClaw-{version}-arm64.dmg
```

**Important:** Output to a non-iCloud path. iCloud re-adds resource forks between afterPack and codesign. Use `--config.directories.output=/tmp/cc-dist` if your project is in iCloud Drive.

---

## Pre-deploy Check

```bash
./scripts/check.sh
```

Verifies all backend modules are properly wired (instantiation, callbacks, tool registration).
