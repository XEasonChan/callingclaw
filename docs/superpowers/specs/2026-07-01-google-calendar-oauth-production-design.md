# Google Calendar OAuth Production Migration

> Design doc, 2026-07-01. Status: **proposed**.
> Context: CallingClaw Calendar currently depends on a temporary Google OAuth
> project under Memdex Ops, a terminal-driven token refresh script, and local
> `.env` credentials. This design moves Calendar auth to a CallingClaw-owned
> production Google Cloud project and makes Calendar connection a first-class
> desktop onboarding flow.

## Decision summary

| Question | Decision | Why |
|---|---|---|
| Production Google project | Create `callingclaw-prod` owned by CallingClaw | Removes the Memdex Ops dependency and gives consent screen, scopes, domains, and verification their own lifecycle |
| OAuth app type | Native desktop flow with PKCE and localhost loopback redirect | CallingClaw is a macOS desktop app; client ID can ship in the app, and PKCE removes the need to store a client secret in `.env` |
| Primary scopes | Start with `openid email profile` + `https://www.googleapis.com/auth/calendar.events.readonly`; request `https://www.googleapis.com/auth/calendar.events` only when write features are used | Least privilege: auto-join/prep only needs event read access; creating Meet events, accepting invites, and attaching notes need event write access |
| Avoided scope | Do not request `https://www.googleapis.com/auth/calendar` | It grants broad calendar management, including share/delete access, while current CallingClaw features only need event-level read/write |
| Token storage | Store tokens in `~/.callingclaw/google-token.json` for v1; migrate to macOS Keychain in a hardening pass | Stops using `.env` for user refresh tokens and keeps desktop/backend/OpenClaw reading from one CallingClaw-owned store |
| Chrome Google login | Keep it separate from Calendar OAuth in onboarding | Chrome profile login lets the bot join Google Meet as a participant; Calendar OAuth lets the backend read/create calendar events. They are different permissions and failure modes |
| Legacy OpenClaw/Memdex scan | Keep as dev-only fallback, never auto-overwrite a CallingClaw production token | Current auto-scan can silently pull unrelated OAuth credentials from OpenClaw or gcloud files |
| Verification | Submit brand + sensitive scope verification before broad release | Calendar event scopes are sensitive; testing projects keep warning screens, user caps, and limited refresh token lifetime |

## Current behavior

Current Calendar auth is built around:

- `scripts/google-auth.sh` and `scripts/ts/google-auth.ts`, which open a browser,
  receive a callback on `localhost:3939`, and write `GOOGLE_REFRESH_TOKEN` to
  `.env`.
- `callingclaw-backend/src/mcp_client/google_cal.ts`, which expects
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`, and
  also scans `~/.openclaw/workspace/*`, `~/.callingclaw/*`, and gcloud ADC files.
- `/api/google/scan`, `/api/google/apply`, `/api/google/set`, and
  `/api/google/auth-status` in `callingclaw-backend/src/config_server.ts`.
- `callingclaw-desktop/src/renderer/index.html`, where Settings offers
  "Scan Credentials" and onboarding says "Sign in with Google" even though that
  flow mainly signs the Playwright Chrome profile into Google for Meet.

The direct consequence is user friction: refresh tokens from an external
Testing project expire quickly, every user has to touch terminal or `.env`, and
CallingClaw can silently fall back to the wrong Google project.

## Target architecture

```
CallingClaw Desktop
  Settings / Onboarding
    1. Connect Calendar
    2. Sign in Browser for Google Meet
            |
            v
CallingClaw Backend (:4000)
  /api/google/calendar/connect
  /api/google/calendar/callback
  /api/google/auth-status
  /api/google/disconnect
            |
            v
Google OAuth
  Native desktop client
  PKCE code verifier/challenge
  localhost loopback redirect
            |
            v
~/.callingclaw/google-token.json
  client_id
  refresh_token
  granted_scopes
  email
  issued_at
```

Calendar API calls continue to live in `GoogleCalendarClient`; the auth flow and
token persistence should become a small adjacent module instead of being spread
across scripts, `.env`, and UI scans.

## Product flow

### New user

1. Desktop onboarding shows two independent connection rows:
   - **Connect Calendar**: read upcoming meetings and prepare/auto-join.
   - **Sign in Browser for Meet**: join Google Meet as a real participant.
2. User clicks **Connect Calendar**.
3. CallingClaw opens the system browser to Google's consent screen.
4. Backend receives the loopback callback, exchanges code + PKCE verifier for
   tokens, stores the refresh token in `~/.callingclaw/google-token.json`, and
   calls `calendar.connect()`.
5. UI polls `/api/google/auth-status` and shows the signed-in email, granted
   scopes, and whether write access is available.
6. If the user later clicks a write feature, such as "Create calendar event",
   request incremental consent for `calendar.events`.

### Existing user

1. On startup, if `~/.callingclaw/google-token.json` exists, prefer it.
2. If only legacy `.env` credentials exist, mark status as `legacy_connected`
   and show a "Reconnect with CallingClaw" CTA.
3. Do not auto-copy OpenClaw or gcloud credentials over a production
   CallingClaw token.
4. After a successful production OAuth connection, ignore legacy Memdex tokens
   unless the user explicitly chooses a dev fallback action.

## Google Cloud setup

Create a new Google Cloud project:

- Project name: `CallingClaw Production`
- Project ID suggestion: `callingclaw-prod`
- APIs: Google Calendar API
- OAuth consent:
  - User type: External
  - App name: `CallingClaw`
  - Authorized domain: `callingclaw.com`
  - Home page: `https://callingclaw.com`
  - Privacy policy: `https://callingclaw.com/privacy`
  - Terms: `https://callingclaw.com/terms`
  - Support email and developer contact: CallingClaw-owned group address
- OAuth client:
  - Type: Desktop app / native app
  - Name: `CallingClaw macOS`
  - Ship only the client ID in the app; keep a development override env var for
    local testing.

Verification package:

- Brand verification: app name, logo, authorized domain, home page, privacy
  policy, support email.
- Sensitive scope verification: justify each Calendar scope and provide an
  unlisted English demo video showing the consent screen, app name/client ID,
  and actual use of Calendar data in CallingClaw.
- Scope justifications:
  - `calendar.events.readonly`: list upcoming meetings, detect Google Meet
    links, generate prep, and schedule auto-join.
  - `calendar.events`: create Google Calendar events with Meet links, accept
    invites on the user's behalf, and attach post-meeting notes URLs.
  - `openid email profile`: display the connected Google account and match the
    user's attendee identity without using Calendar metadata for identity.

## Engineering migration plan

### P0: Google project and policy pages

- Create `callingclaw-prod`.
- Publish/verify `callingclaw.com`, `/privacy`, and `/terms`.
- Add only the minimum scopes needed for the first public build.
- Keep the old Memdex project available for internal dev while the new project
  is in Testing.

### P1: Auth module and token store

- Add a backend module, for example `src/modules/google-oauth.ts`, that owns:
  - PKCE verifier/challenge generation.
  - OAuth state generation and validation.
  - Loopback callback handling.
  - Token exchange and refresh token persistence.
  - Incremental scope requests with `include_granted_scopes=true`.
- Update `GoogleCalendarClient` so `clientSecret` is optional and token data can
  be loaded from `~/.callingclaw/google-token.json`.
- Keep `.env` support behind a clearly named legacy path.

### P2: API surface

Add or replace backend endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/google/calendar/connect` | Starts Calendar OAuth, opens browser or returns `authUrl` |
| `GET /api/google/calendar/callback` | Handles loopback callback and stores token |
| `GET /api/google/auth-status` | Returns Calendar OAuth status, scopes, email, token source, Chrome Meet login status |
| `POST /api/google/disconnect` | Revokes/deletes local token and disconnects Calendar |
| `POST /api/google/calendar/request-write` | Starts incremental consent for event write scope |

Keep `/api/google/scan` and `/api/google/apply` only as dev/diagnostic actions.

### P3: Desktop onboarding and Settings

- Rename the current onboarding copy:
  - From "Sign in with Google"
  - To "Sign in Browser for Meet"
- Add a separate "Connect Calendar" button that calls
  `/api/google/calendar/connect`.
- Settings should show:
  - Calendar account email.
  - Scope level: read-only / read-write / disconnected / legacy.
  - Token source: CallingClaw production / legacy env / dev scan.
  - Reconnect and Disconnect actions.
- Remove "Scan Credentials" as the primary CTA.

### P4: Cleanup and release

- Update `.env.example` and `callingclaw-backend/.env.example` to remove
  `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` from normal setup.
- Move `scripts/google-auth.sh` and `callingclaw-backend/scripts/refresh-google-token.ts`
  under a "dev only" label or replace them with the new backend OAuth endpoint.
- Add tests for:
  - PKCE state/callback validation.
  - Token-store precedence over `.env`.
  - Legacy credentials never overwriting production tokens.
  - Auth status distinguishing Calendar OAuth from Chrome Meet login.
  - `calendar.events.readonly` mode preventing write actions until write consent.

## Acceptance criteria

- A clean macOS install can connect Google Calendar from the desktop UI without
  terminal steps or `.env` edits.
- Production users authorize a CallingClaw-owned OAuth client, not Memdex Ops.
- A production refresh token remains usable past 7 days, unless revoked by the
  user/admin or affected by normal Google token invalidation policies.
- UI clearly separates Calendar OAuth from Chrome profile login for Meet.
- The app no longer requires a local Google client secret for normal use.
- Auto-scan cannot silently replace a CallingClaw production token with an
  OpenClaw, Memdex, or gcloud token.

## Sources

- Google OAuth overview and refresh token expiration rules:
  https://developers.google.com/identity/protocols/oauth2
- Google OAuth for iOS and desktop apps, including PKCE/native app token flow:
  https://developers.google.com/identity/protocols/oauth2/native-app
- Google Calendar API scopes:
  https://developers.google.com/workspace/calendar/api/auth
- Google OAuth sensitive scope verification:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Google OAuth brand verification:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
