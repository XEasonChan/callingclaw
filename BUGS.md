# CallingClaw — Active Bugs

## BUG-001: Gemini 3.1 Live — First WS Connection Fails with 1006

**Status:** FIXED (retry loop)  
**Severity:** P0  
**Affects:** Gemini voice provider

**Root Cause:** First WS connection intermittently fails with 1006 (Connection ended) — proxy instability or Gemini rate limit from previous sessions.

**Fix:** Retry loop (3 attempts with 2s/4s/6s backoff) in `RealtimeClient.connect()`. Set `_intentionalClose=true` during retry to prevent parallel auto-reconnect connections.

---

## BUG-004: Gemini Audio Overlapping / Parallel Voices

**Status:** Investigating  
**Severity:** P1  
**Affects:** Gemini voice playback in voice-test.html

**Symptom:** When Gemini speaks, multiple audio chunks overlap causing garbled/doubled audio. User reported: "声音重叠了，很多并行的声音"

**Possible Causes:**
1. Gemini sends audio chunks faster than the scheduled playback can handle
2. `_nextPlayTime` scheduling in voice-test.html may not account for Gemini's burst delivery pattern
3. Multiple Gemini responses may overlap if tool call responses trigger additional speech

**Files:** `callingclaw-backend/public/voice-test.html` (playback scheduler, lines 650-705)

---

## BUG-005: Tool Calls Block Gemini Connection

**Status:** FIXED  
**Severity:** P0  
**Affects:** Gemini voice — tool calls cause disconnect

**Root Cause:** `recall_context` and `save_meeting_notes` were classified as "fast tools" and awaited inline. This blocked the voice thread, preventing audio from flowing. Gemini interpreted the silence as a timeout and disconnected (1000).

**Fix:** Added `recall_context` and `save_meeting_notes` to `SLOW_TOOLS` set. These now return "Working on it" immediately and execute async, injecting results via `conversation.item.create` when done.

---

## BUG-006: save_meeting_notes Crash

**Status:** Open  
**Severity:** P2  
**Affects:** Meeting notes saving

**Symptom:** `Error: undefined is not an object (evaluating 'summary.participants.length')`

**Cause:** `save_meeting_notes` handler accesses `summary.participants` without null check when no meeting session is active.

**File:** `callingclaw-backend/src/tool-definitions/meeting-tools.ts`

---

## BUG-007: Gemini Setup Silently Fails with Long Instruction + Tools

**Status:** FIXED (instruction compaction)  
**Severity:** P0  
**Affects:** Gemini voice setup

**Root Cause:** Gemini 3.1 Live silently hangs (no setupComplete, no error, no close) when `systemInstruction` > ~100 chars AND tools are present. Without tools, up to 600 chars works fine.

**Fix:** `_compactInstruction()` threshold lowered to 100 chars when tools are present. Remainder injected post-setup via `conversation.item.create`.

---

## BUG-008: Gemini Audio Input Field Name (API Breaking Change)

**Status:** FIXED  
**Severity:** P0  

**History:**
- `realtimeInput.media` → 1007 "Unknown name 'media'"
- `realtimeInput.mediaChunks` → 1007 "deprecated. Use audio, video, or text instead."
- `realtimeInput.audio` → WORKS (Gemini 3.1 current API)

---

## BUG-009: OpenClaw operator.write Scope Not Granted — Prep Generation Broken

**Status:** FIXED  
**Severity:** P0  
**Affects:** Meeting prep generation (OC-001), any `chat.send` via OpenClaw bridge  
**Found:** E2E test 2026-04-13

**Symptom:** Prep files generated with content `"OpenClaw error: missing scope: operator.write"`. Brief has 0 key points, 0 files, 0 URLs.

**Root Cause:** CallingClaw bridge (`openclaw_bridge.ts:154`) requests `scopes: ["operator.admin", "operator.write"]` during connect, and the gateway accepts the connection (returns snapshot). But when `chat.send` is called, the gateway rejects with `errorCode=INVALID_REQUEST errorMessage=missing scope: operator.write`.

**Evidence:**
```
# Gateway log (both old and new connections fail the same way)
[ws] ⇄ res ✗ chat.send 2ms errorCode=INVALID_REQUEST errorMessage=missing scope: operator.write conn=a7224023…153a id=2
```

**Analysis:** The fix in commit `b2aa6bc` (adding `operator.write` to bridge scopes) was necessary but not sufficient. The OpenClaw gateway (v2026.4.11) needs to be configured to grant `operator.write` scope to operator connections. Gateway config (`~/.openclaw/openclaw.json`) has no scope/permission settings.

**Next Steps:**
1. Check OpenClaw docs for gateway scope configuration
2. May need `openclaw configure --section gateway` to add scope grants
3. Or gateway version update may be needed

**Files:** `callingclaw-backend/src/openclaw_bridge.ts:154`, `~/.openclaw/openclaw.json`

---

## BUG-010: E2E Test False Positive on Prep Generation

**Status:** Open  
**Severity:** P1  
**Affects:** `test/experiments/e2e-website-launch-meeting.ts` — Phase 2

**Symptom:** Test reports "Prep generated ✅" when prep file exists but contains only an error message. Test passes 6/6 while prep is actually broken.

**Root Cause:** The test loop checks `session.files.prep` (file existence) from `/api/shared/manifest`, then breaks immediately. It never validates:
1. Prep content quality (keyPoints > 0)
2. File content isn't an error message
3. The "No test contamination" and "Brief has substance" assertions are only reached via the `/api/meeting/prep-brief` fallback path, which is skipped when manifest succeeds first.

**Fix:** After finding prep file in manifest, add content validation:
- Read prep file and check it doesn't contain "error"
- OR: call `/api/meeting/prep-brief` separately after the loop to verify keyPoints > 0

**File:** `callingclaw-backend/test/experiments/e2e-website-launch-meeting.ts:96-123`

---

## BUG-011: E2E Test API Shape Mismatch — prep-brief Endpoint

**Status:** Open  
**Severity:** P2  
**Affects:** `test/experiments/e2e-website-launch-meeting.ts` — Phase 2 fallback path

**Symptom:** Test expects `brief.brief.keyPoints` but `/api/meeting/prep-brief` returns `{workspace, voiceBrief, computerBrief, voiceBriefChars, computerBriefChars, pinnedFiles, persistedPreps, sharedPrepDir}` — no `brief` key.

**Root Cause:** API response shape changed since the test was written. The test's prep-brief fallback (lines 116-122) will never find `brief.brief.keyPoints` because the endpoint doesn't return that shape.

**Impact:** Masked by BUG-010 — the manifest path always succeeds first, so the prep-brief fallback is never reached. If the manifest endpoint were unavailable, this would cause the test to always timeout waiting for prep.

**File:** `callingclaw-backend/test/experiments/e2e-website-launch-meeting.ts:116-122`, `callingclaw-backend/src/config_server.ts:2707-2750`

---

## BUG-012: Presentation Engine Treats Localhost URL Query Params as Filename

**Status:** FIXED  
**Severity:** P1  
**Affects:** `POST /api/screen/present/prepare` with localhost `render.html?file=` URLs  
**Found:** E2E test 2026-04-13

**Symptom:** `ENOENT: no such file or directory, open '.../public/render.html?file=%2FUsers%2F...'`

**Root Cause:** `config_server.ts:3755-3757` strips `http://localhost:PORT/` prefix from URL and reads remainder as a local file path. But `render.html?file=/path/to/file.md` includes the query string, which is not a valid filename.

```typescript
// Bug: query string included in filename
const filename = body.url.replace(/^http:\/\/localhost:\d+\//, "");
// filename = "render.html?file=%2FUsers%2F..." → ENOENT
htmlContent = await Bun.file(`${import.meta.dir}/../public/${filename}`).text();
```

**Fix:** Parse URL and strip query params:
```typescript
const parsed = new URL(body.url);
const filename = parsed.pathname.replace(/^\//, "");
htmlContent = await Bun.file(`${import.meta.dir}/../public/${filename}`).text();
// For render.html, also fetch via HTTP to get the rendered output
```

Or better: for localhost URLs with query params, use HTTP fetch instead of file read.

**File:** `callingclaw-backend/src/config_server.ts:3755-3757`

---

## BUG-013: Screen Share Breaks on Navigate — Meet Drops Capture Silently

**Status:** Open  
**Severity:** P1  
**Affects:** `share_screen` tool during meetings  
**Found:** E2E live test 2026-04-13

**Symptom:** AI tells user "screen is shared" but Meet shows nothing. `sharing=false` in status.

**Root Cause:** `config_server.ts:3552-3564` — when `navigatePresentingPage(url)` navigates an already-sharing tab to a new URL (especially cross-origin, e.g. `localhost:4000/stage` → `www.callingclaw.com`), Google Meet silently drops the tab capture. The code checks `isSharing` getter which returns the **stale** `_isSharing` boolean (only updated in `shareScreen()` and `stopSharing()`, never after navigation).

**Introduced by:** `bc50962` (tab reuse for `/api/screen/share`) — reuse logic navigates but doesn't re-verify share state.

**Fix:** After `navigatePresentingPage()`, add a 1s wait + check Meet DOM for "Stop sharing" button. If missing, re-call `shareScreen()`. Add a `checkSharingStatus()` method to `chrome-launcher.ts`.

**Files:** `config_server.ts:3552-3564`, `chrome-launcher.ts:1630` (stale `isSharing` getter)

---

## BUG-014: False Meeting-End Detection — Bot Quits Mid-Meeting

**Status:** Open  
**Severity:** P0  
**Affects:** All meetings — bot randomly leaves  
**Found:** E2E live test 2026-04-13

**Symptom:** Bot abruptly leaves the meeting. User sees "xueyi chen left". No warning.

**Root Cause:** `chrome-launcher.ts:1321-1353` — `_checkMeetingEndedLib()` returns `'ended'` when `!leaveBtn && !callControls && !videoGrid` (line 1349). During transient DOM repaints, all three selectors can disappear simultaneously for one poll cycle. The admission monitor (line 1161, every 3s) acts on a **single** `'ended'` reading with zero tolerance — immediately calls the meeting-end callback and leaves.

`MAX_END_CHECK_FAILURES` (line 1140, value=20) only counts **exceptions** (the catch block at line 1177), NOT false `'ended'` boolean results.

**Prior fix attempt:** `e1223de` fixed Zoom false positives (defaults to `'active'`) but left Google Meet's transient DOM race intact.

**Fix:** Add `_consecutiveEndedChecks` counter. Require 3 consecutive `'ended'` readings (9s) before triggering leave. Reset counter on any `'active'` reading. Apply to both admission monitor (line 1164) and standalone watcher (line 1386).

**Files:** `chrome-launcher.ts:1139-1176` (admission monitor), `chrome-launcher.ts:1381-1413` (standalone watcher)

---

## BUG-015: Stale WS Chat Event Resolves New Prep Request

**Status:** Open  
**Severity:** P1  
**Affects:** Prep generation when session is reused  
**Found:** E2E test 2026-04-13

**Symptom:** Prep completes in ~1s with "(no response)" content. Should take 60-90s with Opus.

**Root Cause:** `openclaw_bridge.ts` — `sendTask()` sets a single `chatResolve` callback + `_pendingSessionKey`. When the same session (`agent:main:main`) is reused, a stale `state: "final"` event from a previous request resolves the new request's `chatResolve` immediately. The `idempotencyKey` is sent in `chat.send` but **never echoed back** in the response event, so there's no request-response correlation.

**Prior fix attempt:** `5f8f044` added `_pendingSessionKey` filter to prevent cron contamination, but it can't distinguish between requests within the same session.

**Fix:** Replace single `chatResolve` with a FIFO queue of pending requests. Each entry tracks `{sessionKey, idempotencyKey, resolve, timeout}`. On `state: "final"`, pop the oldest matching request. This survives concurrent requests on the same session.

**File:** `openclaw_bridge.ts:173-207` (sendTask), `openclaw_bridge.ts:208-253` (handleChatEvent)

---

## Resolved / Known

**BUG-002: Google Calendar Token Expired** — P2. Re-run OAuth flow.  
**BUG-003: cliclick Not Installed** — P3. `brew install cliclick`.
