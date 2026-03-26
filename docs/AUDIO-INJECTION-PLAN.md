# Audio Injection Plan — Replace BlackHole on macOS 26

> BlackHole 0.6.1 loopback is broken on macOS 26 Tahoe (0 signal on both 2ch and 16ch).
> This branch implements an alternative audio routing that bypasses BlackHole entirely.

## Problem

```
BROKEN on macOS 26:
  BlackHole 16ch (Meet speaker → AI input)    ❌ 0 signal
  BlackHole 2ch  (AI output → Meet mic input) ❌ 0 signal
```

## Solution Architecture

```
OUTPUT (AI → Meet participants):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Grok/OpenAI Realtime API
       ↓ response.audio.delta (base64 PCM16 24kHz)
  Bun Backend (config_server.ts)
       ↓ fan-out to audio-bridge clients
  Meet page (via Playwright eval)
       ↓ WebSocket → base64 decode → Float32
  Ring Buffer AudioWorklet (playback-worklet.js)
       ↓ continuous gapless playback
  MediaStreamDestination
       ↓ live MediaStream (not a file!)
  RTCRtpSender.replaceTrack()
       ↓ swaps Meet's mic track with AI track
  Meet PeerConnection → other participants hear AI


INPUT (Meet participants → AI):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Meet tab (Chrome via Playwright)
       ↓ plays participant audio through speakers
  macOS ScreenCaptureKit (native, macOS 26)
       ↓ captures system audio
  Electron desktopCapturer / getDisplayMedia({audio:true})
       ↓ MediaStream
  Existing AudioWorklet capture pipeline (audio-bridge.js)
       ↓ PCM16 24kHz base64
  WebSocket → Backend → Realtime API
```

## Key Design Decisions (from eng review 2026-03-26)

1. **replaceTrack() instead of getUserMedia monkey-patch**
   - playwright-cli has no addInitScript, only eval()
   - Wrap RTCPeerConnection constructor via eval() BEFORE clicking Join
   - After joining, replaceTrack() on the audio sender
   - No timing race — we control when Join is clicked

2. **Host worklet on localhost backend (not Blob URL)**
   - Meet's CSP has `require-trusted-types-for 'script'`
   - Blob URLs may be blocked; real URLs from localhost are safe
   - `audioCtx.audioWorklet.addModule('http://localhost:4000/playback-worklet.js')`

3. **Standalone injection script (not inline eval strings)**
   - `callingclaw-backend/public/meet-audio-inject.js` — full orchestrator
   - Loaded via `eval(fetch(...).then(r => r.text()).then(eval))`
   - Testable, editable with syntax highlighting

4. **desktopCapturer for input side (not RTCPeerConnection.ontrack)**
   - Standard Electron API, no Meet-side monkey-patching
   - macOS 26 ScreenCaptureKit well-supported
   - Reuses existing AudioWorklet capture pipeline

5. **Accept 2-3s gap on Grok session rotation**
   - Proactive rotation deferred as TODO (P2)

## Files

| File | Status | Purpose |
|------|--------|---------|
| `callingclaw-backend/public/meet-audio-inject.js` | NEW | Injection orchestrator |
| `callingclaw-backend/public/playback-worklet.js` | NEW | Ring buffer worklet (standalone) |
| `callingclaw-backend/src/mcp_client/playwright-cli.ts` | MODIFY | Add injection steps to joinGoogleMeet() |
| `callingclaw-desktop/src/renderer/audio-bridge.js` | MODIFY | Add desktopCapturer capture mode |
| `docs/AUDIO-INJECTION-PLAN.md` | NEW | This file |

## Critical Gaps (from eng review)

1. **RTCPeerConnection variant detection**: If Meet uses `webkitRTCPeerConnection` or a non-standard constructor, wrapper misses it → silent failure. **Must add defensive check.**
2. **desktopCapturer audio-only stream**: If getDisplayMedia returns video-only stream, capture silently fails. **Must validate audio track exists.**

## Alternative: recall.ai Bot

If this injection approach proves too fragile, consider recall.ai's managed meeting bot service as an alternative. Their bots join as real participants and handle audio routing server-side.
