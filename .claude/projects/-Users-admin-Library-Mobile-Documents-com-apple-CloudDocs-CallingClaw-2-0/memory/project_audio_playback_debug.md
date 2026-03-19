---
name: Audio playback debug — AudioContext suspended + capture coupling
description: P0 fix for AI audio not playing in Electron — root causes and fixes applied
type: project
---

AI responds with transcript but no audio heard in Electron AudioBridge.

**Root Cause 1: AudioContext suspended state.**
`_setupPlayback()` creates `new AudioContext()` deep in a callback chain:
button click → startLocalTalk() → await fetch() → startAudioBridge() → WS onopen (macrotask) → findBlackHoleDevices().then() → _setupPlayback()
By the time AudioContext is created, the user gesture context is gone. Chromium's autoplay policy leaves it in `suspended` state. ScriptProcessor.onaudioprocess never fires.
**Fix:** Explicit `_audioCtx.resume()` after creation + safety resume in `playAudio()`.

**Root Cause 2: Capture failure kills playback.**
`_running = true` was set AFTER both `_setupPlayback()` AND `_setupCapture()` succeeded.
If getUserMedia fails (no mic permission), `_running` stays false → `playAudio()` silently returns.
**Fix:** Set `_running = true` after `_setupPlayback()`. Make `_setupCapture()` failure non-fatal.

**Why:** In voice-test.html, AudioContext is created right after `await getUserMedia()` within the button click's gesture chain — so it starts running. The Electron flow loses the gesture across macrotasks.

**How to apply:** When debugging audio in Electron, always check `audioCtx.state`. Add `audioContextState` to getStatus() for runtime inspection.
