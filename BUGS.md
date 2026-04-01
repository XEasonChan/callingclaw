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

## Resolved / Known

**BUG-002: Google Calendar Token Expired** — P2. Re-run OAuth flow.  
**BUG-003: cliclick Not Installed** — P3. `brew install cliclick`.
