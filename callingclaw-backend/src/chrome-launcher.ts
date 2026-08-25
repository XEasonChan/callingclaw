// CallingClaw 2.0 — Chrome Launcher (Playwright Library Bootstrap)
//
// Launches Chrome with addInitScript for audio injection, then hands off
// to playwright-cli for all subsequent DOM operations.
//
// Architecture (Phase-Split):
//   Phase 1: This module → Playwright library launches Chrome
//     - Installs addInitScript (getUserMedia + RTCPeerConnection interception)
//     - Opens --remote-debugging-port for playwright-cli
//     - Disconnects after setup (~3 seconds)
//
//   Phase 2: PlaywrightCLIClient → connects to same Chrome via port
//     - All DOM operations (click, fill, snapshot, navigate)
//     - Existing code unchanged
//
//   Phase 3: Page-internal JavaScript (installed by addInitScript)
//     - Audio capture/playback via WebSocket to backend
//     - Runs independently of CDP, zero bandwidth conflict
//
// Data flow:
//   Chrome (with init script)
//     ├── getUserMedia → returns virtual MediaStreamDestination (AI audio out)
//     ├── RTCPeerConnection → captures remote tracks (meeting audio in)
//     └── WebSocket ws://127.0.0.1:' + (window.__CC_PORT || 4000) + '/ws/voice-test
//           ├── sends: captured meeting audio (PCM16 24kHz base64)
//           └── receives: AI response audio (PCM16 24kHz base64)

import { resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, rmSync } from "fs";
import { CONFIG } from "./config";
import { CURSOR_INJECT_JS } from "./utils/page-extract";

// Always use dedicated CallingClaw profile (lightweight, fast startup).
// Google cookies are imported from the user's main Chrome on first launch.
// Using the main Chrome profile directly causes hangs (huge profile, tab restore).
const DEFAULT_PROFILE = resolve(process.env.CALLINGCLAW_HOME || resolve(homedir(), ".callingclaw"), "browser-profile");
const MAIN_CHROME_PROFILE = resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
const DEFAULT_PORT = 0; // 0 = random free port

// ── Bot-detection evasion init script ────────────────────────────
// Hides navigator.webdriver so Google Meet treats us as a normal browser.
//
// We deliberately do NOT pass the `--disable-blink-features=AutomationControlled`
// command-line flag: although it keeps navigator.webdriver === false, Chrome
// surfaces a yellow "You are using an unsupported command-line flag" infobar
// that is visible during screen-share (looks unprofessional in demos).
//
// Instead we drop that flag and override navigator.webdriver here via
// addInitScript (runs before any page JS, like CDP
// Page.addScriptToEvaluateOnNewDocument). This is the standard
// playwright-stealth approach: it removes the banner AND makes
// navigator.webdriver `undefined` (even stealthier than the flag's `false`).
// We still keep `ignoreDefaultArgs: ["--enable-automation"]` — without that,
// Chrome sets navigator.webdriver = true (verified empirically), which Meet
// would flag as a bot.
const WEBDRIVER_STEALTH_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
`;

// ── Audio injection init script ──────────────────────────────────
// This runs BEFORE any page JavaScript, intercepting getUserMedia
// and wrapping RTCPeerConnection so audio injection works.

const AUDIO_INIT_SCRIPT = `
(function() {
  // Skip pages that aren't meeting platforms
  var isMeeting = location.hostname.includes('meet.google.com') || location.hostname.includes('zoom.us') || location.hostname === 'about:blank';
  if (!isMeeting) return;

  window.__cc = {
    gumCalls: 0,
    pcs: [],
    outputDest: null,
    outputCtx: null,
    outputTrack: null,
    captureActive: false,
    captureChunks: 0,
    captureMaxAmp: 0,
    triedReceiverIdx: 0,
    captureSource: null,
    captureWorklet: null,
    isPlaying: false,       // Echo suppression: true when AI audio is being played
    echoSuppressed: 0,      // Counter: chunks suppressed by echo gate
  };

  var origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  var OrigPC = window.RTCPeerConnection;

  // ── Output: virtual mic (AI audio → Meet) ──
  function ensureOutput() {
    var cc = window.__cc;
    if (cc.outputDest) return;
    cc.outputCtx = new AudioContext({ sampleRate: 24000 });
    cc.outputDest = cc.outputCtx.createMediaStreamDestination();
    cc.outputTrack = cc.outputDest.stream.getAudioTracks()[0];
  }

  // ── Intercept getUserMedia ──
  navigator.mediaDevices.getUserMedia = function(constraints) {
    window.__cc.gumCalls++;
    if (constraints && constraints.audio) {
      ensureOutput();
      return Promise.resolve(window.__cc.outputDest.stream.clone());
    }
    return origGUM(constraints);
  };

  // ── Wrap AudioContext to capture Zoom's remote audio output ──
  // Zoom uses WASM + AudioContext for speaker output (not RTC receivers).
  // We patch AudioContext.prototype.destination to intercept ALL audio going to speakers.
  var OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  if (OrigAudioContext) {
    var origCreateMediaStreamDest = OrigAudioContext.prototype.createMediaStreamDestination;

    // Patch connect() on AudioNode prototype to tap audio going to destination
    var origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(dest) {
      var cc = window.__cc;
      // When ANY node connects to an AudioDestinationNode (speakers), also route to our capture
      if (dest instanceof AudioDestinationNode && cc && !cc._destTapped) {
        try {
          // Create a capture tap: source → splitter → destination + our capture stream
          var ctx = this.context;
          var captureDest = ctx.createMediaStreamDestination();
          origConnect.call(this, captureDest); // parallel tap
          cc._zoomCaptureStream = captureDest.stream;
          cc._zoomCaptureCtx = ctx;
          cc._destTapped = true;
          console.log('[CC-Init] Tapped AudioContext.destination for remote audio capture (' + ctx.sampleRate + 'Hz)');
        } catch(e) {
          console.warn('[CC-Init] Destination tap failed:', e.message);
        }
      }
      return origConnect.apply(this, arguments);
    };
  }

  // ── Wrap RTCPeerConnection constructor ──
  window.RTCPeerConnection = function() {
    var pc = new (Function.prototype.bind.apply(OrigPC, [null].concat(Array.prototype.slice.call(arguments))))();
    window.__cc.pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  Object.getOwnPropertyNames(OrigPC).forEach(function(k) {
    if (k !== 'prototype' && k !== 'name' && k !== 'length') {
      try { window.RTCPeerConnection[k] = OrigPC[k]; } catch(e) {}
    }
  });
  if (window.webkitRTCPeerConnection) {
    window.webkitRTCPeerConnection = window.RTCPeerConnection;
  }

  // ── Patch addTrack on prototype (catches PCs created BEFORE our constructor wrap) ──
  // When Zoom/other platforms add an audio track to a PC, swap it with our virtual mic.
  var origAddTrack = OrigPC.prototype.addTrack;
  OrigPC.prototype.addTrack = function(track) {
    var cc = window.__cc;
    // Track this PC if not already tracked
    if (cc.pcs.indexOf(this) === -1) cc.pcs.push(this);
    // Swap audio track with virtual mic (if available)
    if (track && track.kind === 'audio' && cc.outputTrack) {
      console.log('[CC-Init] Swapped audio sender track with virtual mic');
      return origAddTrack.apply(this, [cc.outputTrack].concat(Array.prototype.slice.call(arguments, 1)));
    }
    return origAddTrack.apply(this, arguments);
  };

  // ── Patch ontrack to capture remote audio from ANY PC ──
  var origOnTrackDesc = Object.getOwnPropertyDescriptor(OrigPC.prototype, 'ontrack');
  if (origOnTrackDesc && origOnTrackDesc.set) {
    var origOnTrackSet = origOnTrackDesc.set;
    Object.defineProperty(OrigPC.prototype, 'ontrack', {
      set: function(handler) {
        var cc = window.__cc;
        if (cc.pcs.indexOf(this) === -1) cc.pcs.push(this);
        var wrappedHandler = function(event) {
          // Auto-capture audio tracks from remote participants
          if (event.track && event.track.kind === 'audio' && !cc.captureActive) {
            console.log('[CC-Init] Remote audio track detected via ontrack');
          }
          if (handler) handler.call(this, event);
        };
        origOnTrackSet.call(this, wrappedHandler);
      },
      get: origOnTrackDesc.get,
      configurable: true,
    });
  }
})();
`;

// ── Audio pipeline script (injected via evaluate after page loads) ──
// This connects the intercepted audio to the CallingClaw backend via WebSocket.

const AUDIO_PIPELINE_SCRIPT = `(async function() {
  var cc = window.__cc;
  // If init script didn't intercept getUserMedia (e.g., Zoom doesn't call it),
  // bootstrap __cc manually so the audio pipeline can still work.
  if (!cc) {
    cc = window.__cc = {
      gumCalls: 0, pcs: [], outputDest: null, outputCtx: null, outputTrack: null,
      captureActive: false, captureChunks: 0, captureMaxAmp: 0, triedReceiverIdx: 0,
      captureSource: null, captureWorklet: null, isPlaying: false, echoSuppressed: 0,
    };
  }
  if (!cc.outputDest) {
    // Create output destination manually (Zoom path — getUserMedia was never intercepted)
    cc.outputCtx = new AudioContext({ sampleRate: 24000 });
    cc.outputDest = cc.outputCtx.createMediaStreamDestination();
    cc.outputTrack = cc.outputDest.stream.getAudioTracks()[0];
    console.log('[CC-Audio] Created output dest manually (platform did not call getUserMedia)');
  }

  var BACKEND_WS_CANDIDATES = [
    'ws://127.0.0.1:${CONFIG.port}/ws/voice-test',
    'ws://localhost:${CONFIG.port}/ws/voice-test'
  ];
  var SAMPLE_RATE = 24000;
  cc.wsConnected = false;
  cc.wsUrl = '';
  cc.wsErrorCount = cc.wsErrorCount || 0;
  cc.wsCloseCount = cc.wsCloseCount || 0;
  cc.playbackChunks = cc.playbackChunks || 0;
  cc.playbackSamples = cc.playbackSamples || 0;
  cc.lastPlaybackAt = cc.lastPlaybackAt || 0;

  // ── Playback worklet (ring buffer, Blob URL) ──
  var outputCtx = cc.outputCtx;
  if (outputCtx.state === 'suspended') await outputCtx.resume();

  // Playback ring buffer: 30 seconds (was 10s — long AI responses overflowed and caused audio glitches)
  var PB_CODE = 'class P extends AudioWorkletProcessor{constructor(){super();this._b=new Float32Array(24000*30);this._w=0;this._r=0;this.port.onmessage=e=>{if(e.data==="clear"){this._w=0;this._r=0;return}var s=e.data;for(var i=0;i<s.length;i++){this._b[this._w%this._b.length]=s[i];this._w++}}}process(i,o){var out=o[0][0];if(!out)return true;for(var i=0;i<out.length;i++){if(this._r<this._w){out[i]=this._b[this._r%this._b.length];this._r++}else out[i]=0}return true}}registerProcessor("playback-processor",P);';
  var pbBlob = new Blob([PB_CODE], { type: 'application/javascript' });
  var pbUrl = URL.createObjectURL(pbBlob);
  await outputCtx.audioWorklet.addModule(pbUrl);
  URL.revokeObjectURL(pbUrl);
  var playbackNode = new AudioWorkletNode(outputCtx, 'playback-processor');
  playbackNode.connect(cc.outputDest);

  // ── Capture worklet (PCM16 encoder, Blob URL) ──
  var captureCtx = new AudioContext();
  var captureRate = captureCtx.sampleRate;
  var CAP_CODE = 'class C extends AudioWorkletProcessor{process(inputs){var ch=inputs[0][0];if(!ch)return true;var out=new Int16Array(ch.length);for(var i=0;i<ch.length;i++){var s=Math.max(-1,Math.min(1,ch[i]));out[i]=s<0?s*0x8000:s*0x7FFF}this.port.postMessage(out,[out.buffer]);return true}}registerProcessor("pcm-processor",C);';
  var capBlob = new Blob([CAP_CODE], { type: 'application/javascript' });
  var capUrl = URL.createObjectURL(capBlob);
  await captureCtx.audioWorklet.addModule(capUrl);
  URL.revokeObjectURL(capUrl);

  // ── Base64 encoder ──
  function audioToBase64(int16) {
    var bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    var CHUNK = 0x2000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))));
    }
    return btoa(parts.join(''));
  }

  // ── Capture remote audio (from meeting participants) ──
  // Dual-capture approach (ported from working test-audio-inject-grok.ts):
  //   Pipeline A: getReceivers() — immediate, picks best available receiver
  //   Pipeline B: ontrack event — catches new tracks as they appear
  // NO echo suppression — test proved Grok's server-side VAD handles echo fine.
  // The session reset bug (now fixed) was the real cause of self-interruption.

  function sendAudioChunk(int16) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // ── Echo suppression: mute capture while AI audio is playing ──
    // When playbackNode is outputting AI audio → Meet mic → remote participants hear it
    // → Meet SFU may echo it back → capture picks it up → Realtime API hears it as "user"
    // Half-duplex gate: suppress capture during AI playback + 300ms tail guard
    if (cc.isPlaying) {
      cc.echoSuppressed++;
      if (cc.echoSuppressed % 100 === 1) console.log('[CC-Audio] Echo suppressed: ' + cc.echoSuppressed + ' chunks');
      return;
    }
    // Downsample to 24kHz if needed
    if (captureRate !== SAMPLE_RATE && captureRate > SAMPLE_RATE) {
      var ratio = captureRate / SAMPLE_RATE;
      var newLen = Math.round(int16.length / ratio);
      var resampled = new Int16Array(newLen);
      for (var j = 0; j < newLen; j++) resampled[j] = int16[Math.round(j * ratio)] || 0;
      int16 = resampled;
    }
    ws.send(JSON.stringify({ type: 'audio', audio: audioToBase64(int16) }));
  }

  // Pipeline A: getReceivers approach
  // cc._triedTrackIds tracks which receiver tracks we already tried (to avoid re-picking muted ones)
  cc._triedTrackIds = cc._triedTrackIds || new Set();
  cc._lastNonZeroAt = Date.now();
  cc._cycleCount = 0;

  // ── Audio-health telemetry (read by ChromeLauncher.getAudioHealth via __ccPipeline.health) ──
  // These are updated live in the capture loop / receiver-cycle logic below.
  cc._activeReceiverIndex = (typeof cc._activeReceiverIndex === 'number') ? cc._activeReceiverIndex : -1;
  cc._lastChunkMaxAmp = cc._lastChunkMaxAmp || 0;   // max PCM16 amplitude of most-recent chunk
  cc._speakerDetected = cc._speakerDetected || false; // ever seen non-silent audio this session
  // Dedicated REAL-audio timestamp for health reporting. Bumped ONLY where an
  // actual non-silent PCM chunk is observed (see the three sites below) — NEVER
  // at pipeline init or by the silence-recovery watchdog (those bump the legacy
  // cc._lastNonZeroAt, which must stay decoupled from the trust signal so we
  // never report "healthy"/"Hearing you" while actually silent). 0 = never.
  cc._lastRealAudioAt = cc._lastRealAudioAt || 0;
  cc._SILENCE_FLOOR = 100; // amplitude below this is treated as silence

  function setupCapture(pc) {
    if (cc.captureActive) return;
    var receivers = pc.getReceivers();
    var audioRecvs = receivers.filter(function(r) { return r.track && r.track.kind === 'audio' && r.track.readyState === 'live'; });
    if (audioRecvs.length === 0) return;

    // Prefer unmuted receiver that we haven't already tried (on retry)
    var audioRecv = audioRecvs.find(function(r) { return !r.track.muted && !cc._triedTrackIds.has(r.track.id); })
      || audioRecvs.find(function(r) { return !r.track.muted; })
      || audioRecvs.find(function(r) { return !cc._triedTrackIds.has(r.track.id); })
      || audioRecvs[0];
    var track = audioRecv.track;
    cc._activeReceiverIndex = audioRecvs.indexOf(audioRecv); // health telemetry
    cc._triedTrackIds.add(track.id);

    // Reset tried set if we've exhausted all receivers (allow full re-scan)
    if (cc._triedTrackIds.size >= audioRecvs.length) {
      cc._triedTrackIds.clear();
    }

    console.log('[CC-Audio] Receivers: ' + audioRecvs.length + ', using: ' + track.id.substring(0, 10) + ' muted=' + track.muted + ' cycle#' + cc._cycleCount);

    if (cc.captureSource) { try { cc.captureSource.disconnect(); } catch(e) {} }
    if (cc.captureWorklet) { try { cc.captureWorklet.disconnect(); } catch(e) {} }

    var stream = new MediaStream([track]);
    var source = captureCtx.createMediaStreamSource(stream);
    var worklet = new AudioWorkletNode(captureCtx, 'pcm-processor');
    source.connect(worklet);
    cc.captureSource = source;
    cc.captureWorklet = worklet;
    cc.captureChunks = 0;
    cc.captureMaxAmp = 0;

    worklet.port.onmessage = function(e) {
      cc.captureChunks++;
      var int16 = e.data;
      var maxAmp = 0;
      for (var i = 0; i < int16.length; i++) { var a = Math.abs(int16[i]); if (a > maxAmp) maxAmp = a; }
      if (maxAmp > cc.captureMaxAmp) cc.captureMaxAmp = maxAmp;
      // ── Audio-health telemetry ──
      cc._lastChunkMaxAmp = maxAmp;
      if (maxAmp > cc._SILENCE_FLOOR) { cc._speakerDetected = true; cc._lastNonZeroAt = Date.now(); cc._lastRealAudioAt = Date.now(); }
      // Log every 50th chunk (~5s)
      if (cc.captureChunks % 50 === 1) {
        console.log('[CC-Audio] chunk#' + cc.captureChunks + ' maxAmp=' + maxAmp + ' peak=' + cc.captureMaxAmp);
      }
      // NO echo suppression — send ALL audio, let server VAD handle it
      sendAudioChunk(int16);
    };

    track.onmute = function() {
      console.log('[CC-Audio] Track MUTED — forcing receiver cycle');
      cc.captureActive = false;
      cc._cycleCount++;
      // Next 2s interval will call setupCapture with a different receiver
    };
    track.onunmute = function() { console.log('[CC-Audio] Track UNMUTED'); };
    track.onended = function() {
      console.log('[CC-Audio] Track ENDED — will retry');
      cc.captureActive = false;
      cc._cycleCount++;
    };

    cc.captureActive = true;
    console.log('[CC-Audio] Pipeline A active (track: ' + track.id.substring(0, 10) + ')');
  }

  // ── WebSocket to backend ──
  var ws = null;
  function connectWS(candidateIdx) {
    candidateIdx = candidateIdx || 0;
    var target = BACKEND_WS_CANDIDATES[candidateIdx % BACKEND_WS_CANDIDATES.length];
    cc.wsUrl = target;
    console.log('[CC-Audio] Connecting WS: ' + target);
    ws = new WebSocket(target);
    ws.onopen = function() {
      cc.wsConnected = true;
      console.log('[CC-Audio] WS connected: ' + target);
      ws.send(JSON.stringify({ type: 'start', provider: undefined }));
    };
    ws.onerror = function() {
      cc.wsErrorCount++;
      console.log('[CC-Audio] WS error #' + cc.wsErrorCount + ': ' + target);
    };
    ws.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'audio' && data.audio) {
          cc.playbackChunks++;
          cc.lastPlaybackAt = Date.now();
          // ── Echo suppression: mark AI as speaking ──
          cc.isPlaying = true;
          if (cc._playingTimer) clearTimeout(cc._playingTimer);
          // Tail guard: keep suppression after last audio chunk
          // Meet SFU: ~300ms echo delay. Zoom SFU: ~1000-2000ms echo delay.
          var tailMs = location.hostname.includes('zoom.us') ? 2500 : 500;
          cc._playingTimer = setTimeout(function() { cc.isPlaying = false; }, tailMs);

          var raw = atob(data.audio);
          var bytes = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          var pcm16 = new Int16Array(bytes.buffer);
          cc.playbackSamples += pcm16.length;
          if (cc.playbackChunks === 1 || cc.playbackChunks % 25 === 0) {
            console.log('[CC-Audio] playback chunk#' + cc.playbackChunks + ' samples=' + pcm16.length);
          }
          var float32 = new Float32Array(pcm16.length);
          for (var j = 0; j < pcm16.length; j++) float32[j] = pcm16[j] / 32768;
          var FADE = 24;
          if (float32.length > FADE * 2) {
            for (var f = 0; f < FADE; f++) { var g = f / FADE; float32[f] *= g; float32[float32.length - 1 - f] *= g; }
          }
          playbackNode.port.postMessage(float32, [float32.buffer]);
        } else if (data.type === 'interrupt') {
          // ── Echo suppression: AI interrupted, stop suppression immediately ──
          cc.isPlaying = false;
          if (cc._playingTimer) { clearTimeout(cc._playingTimer); cc._playingTimer = null; }
          playbackNode.port.postMessage('clear');
        }
      } catch(err) {}
    };
    ws.onclose = function(ev) {
      cc.wsConnected = false;
      cc.wsCloseCount++;
      console.log('[CC-Audio] WS closed #' + cc.wsCloseCount + ' code=' + ev.code + ' url=' + target);
      setTimeout(function() { connectWS(candidateIdx + 1); }, 3000);
    };
  }
  connectWS(0);

  // ── Monitor: set up capture when PC connects, re-inject if needed ──
  setInterval(function() {
    if (cc.captureActive) return;
    for (var i = 0; i < cc.pcs.length; i++) {
      if (cc.pcs[i].connectionState === 'connected') {
        setupCapture(cc.pcs[i]);
        break;
      }
    }
  }, 2000);

  // ── Audio health check: detect silent capture and auto-cycle receiver ──
  // Meet may switch the active audio receiver mid-meeting (new participant joins,
  // network reconnect, SFU migration). When this happens, the old track goes
  // muted but doesn't always fire onmute. This watchdog catches silent capture
  // and forces a receiver cycle.
  setInterval(function() {
    if (!cc.captureActive) return;
    // Check if we've seen non-zero amplitude recently
    if (cc.captureMaxAmp > 100) {
      cc._lastNonZeroAt = Date.now();
      cc.captureMaxAmp = 0; // reset for next window
      return;
    }
    var silentMs = Date.now() - (cc._lastNonZeroAt || 0);
    if (silentMs > 30000) {
      cc._cycleCount++;
      console.log('[CC-Audio] SILENT for ' + Math.round(silentMs / 1000) + 's — cycling receiver (cycle#' + cc._cycleCount + ')');
      cc.captureActive = false;
      cc.captureMaxAmp = 0;
      cc._lastNonZeroAt = Date.now(); // prevent rapid re-trigger
      // Next 2s interval will call setupCapture with a different receiver
    }
  }, 15000);

  // ── Pipeline C: Zoom fallback — capture from AudioContext.destination tap ──
  // Zoom uses WASM+DataChannels, not RTC receivers. The init script patches
  // AudioNode.connect to tap audio going to destination (speakers).
  // If RTC capture doesn't activate within 5s, try the Zoom tap.
  setTimeout(function() {
    if (cc.captureActive) return; // RTC capture already working
    if (!cc._zoomCaptureStream) {
      console.log('[CC-Audio] Pipeline C: no Zoom destination tap available');
      return;
    }
    console.log('[CC-Audio] Pipeline C: using Zoom AudioContext.destination tap for capture');
    try {
      var zoomStream = cc._zoomCaptureStream;
      var zoomSrc = captureCtx.createMediaStreamSource(zoomStream);
      var zoomWorklet = new AudioWorkletNode(captureCtx, 'pcm-processor');
      zoomSrc.connect(zoomWorklet);
      zoomWorklet.port.onmessage = function(e) {
        cc.captureChunks++;
        var d = e.data;
        var zMax = 0;
        for (var i = 0; i < d.length; i++) {
          var amp = Math.abs(d[i]);
          if (amp > zMax) zMax = amp;
          if (amp > cc.captureMaxAmp) cc.captureMaxAmp = amp;
        }
        // ── Audio-health telemetry ──
        cc._lastChunkMaxAmp = zMax;
        if (zMax > cc._SILENCE_FLOOR) { cc._speakerDetected = true; cc._lastNonZeroAt = Date.now(); cc._lastRealAudioAt = Date.now(); }
        sendAudioChunk(d);
      };
      cc.captureActive = true;
      cc._activeReceiverIndex = -2; // -2 = Zoom destination tap (no RTC receiver index)
      cc.captureSource = 'zoom_destination_tap';
      console.log('[CC-Audio] Pipeline C active — capturing Zoom remote audio from destination tap');
    } catch(e) {
      console.log('[CC-Audio] Pipeline C failed: ' + e.message);
    }
  }, 5000);

  // ── Pipeline B: ontrack event listener (dual-capture redundancy) ──
  // Catches new audio tracks as they appear — covers cases where
  // getReceivers() misses the active track at setup time.
  var ontracktriggered = false;
  for (var i = 0; i < cc.pcs.length; i++) {
    (function(pc) {
      // Pipeline A: retry via getReceivers
      pc.addEventListener('track', function() {
        setTimeout(function() { if (!cc.captureActive) setupCapture(pc); }, 500);
      });
      // Pipeline B: independent capture via ontrack event stream
      pc.addEventListener('track', function(event) {
        if (event.track && event.track.kind === 'audio' && event.streams && event.streams[0] && !ontracktriggered) {
          ontracktriggered = true;
          console.log('[CC-Track] ontrack event! Using event stream directly');
          var evtStream = event.streams[0];
          var evtSrc = captureCtx.createMediaStreamSource(evtStream);
          var evtWorklet = new AudioWorkletNode(captureCtx, 'pcm-processor');
          evtSrc.connect(evtWorklet);
          var evtChunks = 0;
          var evtMaxAmp = 0;
          evtWorklet.port.onmessage = function(e) {
            evtChunks++;
            var d = e.data;
            var amp = 0;
            for (var k = 0; k < d.length; k++) { var ab = Math.abs(d[k]); if (ab > amp) amp = ab; }
            if (amp > evtMaxAmp) evtMaxAmp = amp;
            // ── Audio-health telemetry ──
            cc.captureChunks++;
            cc._lastChunkMaxAmp = amp;
            if (amp > cc._SILENCE_FLOOR) { cc._speakerDetected = true; cc._lastNonZeroAt = Date.now(); cc._lastRealAudioAt = Date.now(); }
            if (evtChunks % 50 === 1) console.log('[CC-Track] chunk#' + evtChunks + ' maxAmp=' + amp + ' peak=' + evtMaxAmp);
            sendAudioChunk(d);  // Echo suppression applied inside sendAudioChunk
          };
        }
      });
    })(cc.pcs[i]);
  }

  // ── Meet Captions Scraper (MutationObserver-based) ──
  // Google's server-side speech recognition handles echo perfectly.
  // Uses MutationObserver for real-time caption detection.
  (function initCaptionsScraper() {
    var lastCaption = '';
    var captionsEnabled = false;

    // Enable captions by clicking the CC button
    function enableCaptions() {
      if (captionsEnabled) return;
      // Try multiple selector patterns for the CC button
      var selectors = [
        'button[aria-label*="captions" i]',
        'button[aria-label*="字幕"]',
        'button[aria-label*="Turn on captions"]',
        'button[data-tooltip*="captions" i]',
        'button[jsname] [data-icon="closed_caption"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn) {
          // Check if already enabled (aria-pressed or similar)
          var pressed = btn.getAttribute('aria-pressed');
          if (pressed === 'true') { captionsEnabled = true; return; }
          btn.click();
          captionsEnabled = true;
          console.log('[CC-Captions] Enabled via: ' + selectors[s]);
          return;
        }
      }
    }

    // Observe DOM for caption text changes
    function startCaptionObserver() {
      // Meet renders captions in a container at the bottom of the page
      // The container typically has role="region" or specific data attributes
      // We observe the entire body and filter for caption-like text nodes
      var observer = new MutationObserver(function(mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var mutation = mutations[m];
          // Look at added nodes that could be captions
          if (mutation.addedNodes) {
            for (var n = 0; n < mutation.addedNodes.length; n++) {
              var node = mutation.addedNodes[n];
              if (node.nodeType === 1) { // Element node
                var text = node.textContent ? node.textContent.trim() : '';
                // Caption text is typically 5+ chars, not a button/UI element
                if (text.length > 5 && !node.querySelector('button') && !node.querySelector('input')
                    && !node.closest('[role="menu"]') && !node.closest('[role="dialog"]')
                    && !node.closest('[role="navigation"]') && !node.closest('[role="listbox"]')) {
                  // Check if this looks like a caption (contains speech-like text)
                  // Exclude participant list items, settings panels
                  var parent = node.parentElement;
                  if (parent && (parent.getAttribute('role') === 'region'
                      || parent.className.indexOf('caption') !== -1
                      || parent.closest('[class*="caption" i]')
                      || parent.closest('[class*="subtitle" i]'))) {
                    if (text !== lastCaption) {
                      lastCaption = text;
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'caption', text: text, ts: Date.now() }));
                        console.log('[CC-Captions] ' + text.substring(0, 60));
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[CC-Captions] MutationObserver active');
    }

    // Also poll as fallback (in case MutationObserver misses captions)
    function pollCaptions() {
      // Look for the caption overlay container specifically
      var containers = document.querySelectorAll('[class*="caption" i] span, [role="region"] span');
      var texts = [];
      containers.forEach(function(el) {
        var t = el.textContent ? el.textContent.trim() : '';
        // Filter: only actual speech text (not UI, not participant names)
        if (t.length > 3 && t.indexOf('more_vert') === -1 && t.indexOf('Raising') === -1) {
          texts.push(t);
        }
      });
      if (texts.length > 0) {
        var combined = texts.join(' ');
        if (combined !== lastCaption && combined.length > 5) {
          lastCaption = combined;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'caption', text: combined, ts: Date.now() }));
          }
        }
      }
    }

    setTimeout(enableCaptions, 5000);
    setTimeout(enableCaptions, 10000);
    setTimeout(startCaptionObserver, 6000);
    setInterval(pollCaptions, 3000);
  })();

    window.__ccPipeline = {
      ws: function() { return ws; },
      playbackNode: playbackNode,
      captureActive: function() { return cc.captureActive; },
      captureChunks: function() { return cc.captureChunks; },
      captureMaxAmp: function() { return cc.captureMaxAmp; },
      playbackChunks: function() { return cc.playbackChunks; },
      playbackSamples: function() { return cc.playbackSamples; },
      // Live audio-health snapshot consumed by ChromeLauncher.getAudioHealth().
      // Returns a plain JSON-able object (no functions/DOM refs).
      health: function() {
        return {
          captureActive: !!cc.captureActive,
          captureChunks: cc.captureChunks || 0,
          lastChunkMaxAmp: cc._lastChunkMaxAmp || 0,
          peakMaxAmp: cc.captureMaxAmp || 0,
          // REAL-audio timestamp (NOT the watchdog's cc._lastNonZeroAt) — see init note.
          lastNonzeroAt: cc._lastRealAudioAt || 0,
          activeReceiverIndex: (typeof cc._activeReceiverIndex === 'number') ? cc._activeReceiverIndex : -1,
          receiverCycleCount: cc._cycleCount || 0,
          speakerDetected: !!cc._speakerDetected,
          wsState: ws ? ws.readyState : -1,
          playbackChunks: cc.playbackChunks || 0,
          playbackSamples: cc.playbackSamples || 0,
        };
      },
    };

    // ── Ensure AI audio is what the meeting sends as microphone input ──
    // Meet can create or replace senders after the initial getUserMedia call.
    // Keep checking all tracked PeerConnections so generated voice does not
    // stay local to the page without reaching remote participants.
    function ensureVirtualMicSender(reason) {
      if (!cc.outputTrack) return 0;
      var allPCs = cc.pcs.length > 0 ? cc.pcs : [];
      var replaced = 0;
      var checked = 0;
      for (var i = 0; i < allPCs.length; i++) {
        try {
          var senders = allPCs[i].getSenders();
          for (var j = 0; j < senders.length; j++) {
            if (senders[j].track && senders[j].track.kind === 'audio') {
              checked++;
              if (senders[j].track.id === cc.outputTrack.id) continue;
              Promise.resolve(senders[j].replaceTrack(cc.outputTrack)).catch(function(e) {
                console.warn('[CC-Audio] Sender replace promise failed: ' + (e && e.message ? e.message : e));
              });
              replaced++;
              console.log('[CC-Audio] Replaced audio sender track on PC #' + i + ' reason=' + reason);
            }
          }
        } catch(e) { console.warn('[CC-Audio] PC sender replace failed:', e); }
      }
      if (checked > 0 && (replaced > 0 || !cc._senderEnsureLogged)) {
        console.log('[CC-Audio] Sender ensure checked=' + checked + ' replaced=' + replaced + ' reason=' + reason);
        cc._senderEnsureLogged = true;
      }
      return replaced;
    }
    setTimeout(function() { ensureVirtualMicSender('post_activate'); }, 500);
    setInterval(function() { ensureVirtualMicSender('interval'); }, 5000);

    return 'pipeline_ready';
  })()`;

// ── Whole-join retry: pure, unit-testable helpers ────────────────
//
// These are extracted as pure functions (no Playwright, no DOM) so the
// retry/backoff policy can be tested without launching a browser.

/** Result of classifying a join failure summary. */
export type JoinFailureClass = "terminal" | "retryable";

/** Outcome shape returned by joinGoogleMeet / _joinAttempt. */
export interface JoinResult {
  success: boolean;
  summary: string;
  steps: string[];
  state: "in_meeting" | "waiting_room" | "failed";
}

/** Total number of whole-join attempts (the initial try + retries). */
export const MAX_JOIN_ATTEMPTS = 3;

/** Backoff schedule (ms) used before each retry; index = attempt number (0-based). */
export const JOIN_BACKOFF_SCHEDULE_MS = [0, 2000, 6000, 15000] as const;

/** Cap for any backoff delay beyond the explicit schedule. */
export const JOIN_BACKOFF_CAP_MS = 15000;

/**
 * Delay (ms) to wait BEFORE the attempt at `attemptIndex` (0-based).
 *   attemptIndex 0 → 0ms   (first attempt, no wait)
 *   attemptIndex 1 → 2000ms
 *   attemptIndex 2 → 6000ms
 *   attemptIndex 3 → 15000ms
 *   attemptIndex ≥4 → capped at 15000ms
 * Pure function — no side effects.
 */
export function joinBackoffMs(attemptIndex: number): number {
  if (!Number.isFinite(attemptIndex) || attemptIndex <= 0) return 0;
  const i = Math.floor(attemptIndex);
  if (i < JOIN_BACKOFF_SCHEDULE_MS.length) return JOIN_BACKOFF_SCHEDULE_MS[i] ?? JOIN_BACKOFF_CAP_MS;
  return JOIN_BACKOFF_CAP_MS;
}

/**
 * Classify a join-failure summary as `terminal` (never retry — the meeting
 * actively rejected us or is gone) or `retryable` (transient — navigation
 * error, button-not-found, timeout, load race, network/5xx).
 *
 * Terminal signals include being rejected/denied/kicked/removed, the meeting
 * having ended, an expired/invalid code, or access being blocked — retrying
 * any of these wastes time and can spam the host. Everything else defaults to
 * retryable. Pure function — case-insensitive substring match.
 */
export function classifyJoinFailure(summary: string): JoinFailureClass {
  const s = (summary || "").toLowerCase();
  const terminalPatterns = [
    // Rejected / removed from meeting or waiting room (must fail fast)
    "rejected", "denied", "declined",
    "kicked", "removed from", "removed you", "were removed", "you've been removed",
    "not admitted", "admission denied", "banned", "blocked from",
    // Meeting no longer joinable
    "meeting has ended", "meeting ended", "has ended",
    "code has expired", "expired", "invalid meeting", "invalid code",
    "cannot access", "access denied", "not allowed", "no access",
    // Precondition that a retry cannot fix
    "no page",
  ];
  return terminalPatterns.some((p) => s.includes(p)) ? "terminal" : "retryable";
}

// ── Audio-health: live in-memory state + pure derivation ─────────
//
// The audio capture self-check runs inside the page (window.__cc). The
// ChromeLauncher polls it and keeps a live in-memory snapshot exposed via
// getAudioHealth() — replacing the old "grep the backend log file" approach.

/** Raw per-poll snapshot read from the in-page audio pipeline (window.__ccPipeline.health()). */
export interface AudioHealthRaw {
  captureActive: boolean;
  captureChunks: number;
  /** Max PCM16 amplitude (0..32767) of the most-recent captured chunk. */
  lastChunkMaxAmp: number;
  /** Running peak amplitude (reset periodically by the in-page silence watchdog). */
  peakMaxAmp: number;
  /** Epoch ms of the last non-silent chunk; 0 if never. */
  lastNonzeroAt: number;
  /** Index of the RTC receiver in use (-1 none, -2 = Zoom destination tap). */
  activeReceiverIndex: number;
  /** Times the watchdog cycled to a different receiver (silence/mute recovery). */
  receiverCycleCount: number;
  /** True once any non-silent audio has been captured this session. */
  speakerDetected: boolean;
  /** Backend WebSocket readyState from the page (-1 none, 0..3 per WebSocket spec). */
  wsState: number;
}

/** Derived, consumer-facing audio-health shape returned by getAudioHealth(). */
export interface AudioHealth {
  /** Pipeline instrumentation is live (page reported a snapshot). */
  active: boolean;
  /** Capture is active AND non-silent audio was seen within AUDIO_FLOW_WINDOW_MS. */
  captureFlowing: boolean;
  /** Max PCM16 amplitude (0..32767) of the most-recent chunk. */
  lastMaxAmp: number;
  /** Epoch ms of the last non-silent chunk; 0 if never. */
  lastNonzeroAudioAt: number;
  /** RTC receiver index in use (-1 none, -2 Zoom tap). */
  activeReceiverIndex: number;
  /** Receiver cycle count (silence/mute recovery). */
  receiverCycleCount: number;
  /** True once any non-silent audio has been captured this session. */
  speakerDetected: boolean;
  /** Total PCM chunks captured since pipeline activation. */
  captureChunks: number;
  /** Backend WS readyState from page (-1 none, 0..3). */
  wsState: number;
  /** Epoch ms this snapshot was last refreshed from the page; 0 if never polled. */
  updatedAt: number;
}

/** How recently non-silent audio must have arrived for captureFlowing to be true. */
export const AUDIO_FLOW_WINDOW_MS = 10000;

/**
 * Derive the consumer-facing AudioHealth from a raw page snapshot at time `now`.
 * `raw === null` → inactive defaults (no page / pipeline not activated yet).
 * Pure function — no side effects, unit-testable.
 */
export function computeAudioHealth(raw: AudioHealthRaw | null, now: number): AudioHealth {
  if (!raw) {
    return {
      active: false,
      captureFlowing: false,
      lastMaxAmp: 0,
      lastNonzeroAudioAt: 0,
      activeReceiverIndex: -1,
      receiverCycleCount: 0,
      speakerDetected: false,
      captureChunks: 0,
      wsState: -1,
      updatedAt: now,
    };
  }
  // `lastNonzero` is the REAL-audio timestamp (page now sources it from
  // cc._lastRealAudioAt, not the watchdog's cc._lastNonZeroAt). captureFlowing —
  // the "Hearing you" trust signal — must reflect genuine audio only:
  //   • speakerDetected gate → can't be true before ANY non-silent chunk was
  //     ever seen (kills the post-activation false-positive window).
  //   • freshness window on the REAL-audio timestamp → goes false during the
  //     post-silence recovery cycle (which bumps only the watchdog timestamp),
  //     so the "Recovering audio" state can render; it flips back to true only
  //     once fresh real audio actually arrives after recovery.
  const lastNonzero = raw.lastNonzeroAt || 0;
  const captureFlowing =
    !!raw.captureActive &&
    !!raw.speakerDetected &&
    lastNonzero > 0 &&
    now - lastNonzero < AUDIO_FLOW_WINDOW_MS;
  return {
    active: true,
    captureFlowing,
    lastMaxAmp: raw.lastChunkMaxAmp || 0,
    lastNonzeroAudioAt: lastNonzero,
    activeReceiverIndex: typeof raw.activeReceiverIndex === "number" ? raw.activeReceiverIndex : -1,
    receiverCycleCount: raw.receiverCycleCount || 0,
    speakerDetected: !!raw.speakerDetected,
    captureChunks: raw.captureChunks || 0,
    wsState: typeof raw.wsState === "number" ? raw.wsState : -1,
    updatedAt: now,
  };
}

// ── ChromeLauncher class ─────────────────────────────────────────

export class ChromeLauncher {
  private port: number = 0;
  private profileDir: string;
  private _context: any = null;
  private _page: any = null;
  private _googleLoginCache: { loggedIn: boolean; email: string | null; checkedAt: number } | null = null;
  /** Mutex: if a launch is in progress, subsequent callers await the same promise */
  private _launchPromise: Promise<{ port: number }> | null = null;

  /** Live audio-health snapshot (refreshed by the poller while a pipeline is active). */
  private _audioHealth: AudioHealth = computeAudioHealth(null, 0);
  private _audioHealthInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { profileDir?: string }) {
    this.profileDir = opts?.profileDir || DEFAULT_PROFILE;
  }

  /**
   * Launch Chrome with audio injection init script.
   * Returns the debugging port for playwright-cli to connect.
   *
   * After calling this, playwright-cli can connect with:
   *   playwright-cli -s=callingclaw --browser=chrome open about:blank
   * (it will reconnect to the existing Chrome via the port)
   */
  async launch(): Promise<{ port: number }> {
    // Mutex: if another launch is already in progress, wait for it instead of racing
    if (this._launchPromise) {
      console.log("[ChromeLauncher] Launch already in progress, waiting for existing launch...");
      return this._launchPromise;
    }

    // If already launched, verify browser is still alive before reusing
    if (this._context && this._page) {
      try {
        await this._page.evaluate("1");
        console.log(`[ChromeLauncher] Already launched (port=${this.port}), reusing`);
        return { port: this.port };
      } catch {
        console.warn("[ChromeLauncher] Stale browser detected (closed/crashed), relaunching...");
        this._context = null;
        this._page = null;
      }
    }

    // Set the mutex — all concurrent callers will await this same promise
    this._launchPromise = this._launchInternal();
    try {
      return await this._launchPromise;
    } finally {
      this._launchPromise = null;
    }
  }

  private async _launchInternal(): Promise<{ port: number }> {

    // Dynamic import to avoid loading playwright-core at module level
    const { chromium } = await import("playwright-core");

    // Clean up stale locks + crash state
    const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of locks) {
      const p = resolve(this.profileDir, lock);
      if (existsSync(p)) try { rmSync(p); } catch {}
    }
    const crashFiles = ["Last Session", "Last Tabs", "Current Session", "Current Tabs"];
    for (const f of crashFiles) {
      const p = resolve(this.profileDir, f);
      if (existsSync(p)) try { rmSync(p); } catch {}
    }

    // Clear stale audio device preferences (BlackHole was removed in v2.7.12)
    // Without this, Meet may select BlackHole as mic/speaker from saved prefs → muted audio
    this.clearAudioDevicePrefs();

    // Import Google cookies from user's main Chrome profile (one-time bootstrap)
    // This gives the CallingClaw profile access to Google Meet without manual sign-in.
    await this.importGoogleCookies();

    // Ensure profile dir exists
    mkdirSync(this.profileDir, { recursive: true });

    // Find a free port
    const port = await this.findFreePort();
    this.port = port;

    console.log(`[ChromeLauncher] Starting Chrome (port=${port}, profile=${this.profileDir})...`);

    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      channel: "chrome",
      viewport: null,  // Use full window size — allows user to resize/maximize for presentation
      // Meet's CSP can block injected loopback WebSockets. The bridge is
      // injected by ChromeLauncher and only connects to the local backend.
      bypassCSP: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-web-security",
        "--allow-running-insecure-content",
        `--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:${CONFIG.port},http://localhost:${CONFIG.port}`,
        "--disable-infobars",
        // NOTE: --disable-blink-features=AutomationControlled is intentionally NOT
        // passed — it triggers a visible yellow "unsupported command-line flag"
        // banner. navigator.webdriver is hidden via WEBDRIVER_STEALTH_SCRIPT below.
        "--disable-session-crashed-bubble",      // Suppress "profile error" dialog
        "--hide-crash-restore-bubble",            // Suppress "restore pages" bar
        "--noerrdialogs",                         // Suppress error dialogs
        "--restore-last-session=false",             // Don't restore previous session tabs
        "--auto-select-desktop-capture-source=CallingClaw Presenting",  // Auto-select tab titled "CallingClaw Presenting" (zero-click share)
        "--enable-usermedia-screen-capturing",    // Enable screen capture API
        "--start-maximized",                      // Start Chrome maximized for presentation
        `--remote-debugging-port=${port}`,
      ],
      permissions: ["microphone", "camera"],
      ignoreDefaultArgs: ["--mute-audio", "--enable-automation", "--no-sandbox"],
    });

    // Hide navigator.webdriver (bot-detection evasion without the infobar flag)
    await context.addInitScript(WEBDRIVER_STEALTH_SCRIPT);

    // Install the audio injection init script
    await context.addInitScript(AUDIO_INIT_SCRIPT);
    console.log("[ChromeLauncher] Init scripts installed (webdriver stealth + getUserMedia + RTC interception)");

    // Use first page (close ALL extras Chrome opened from previous session)
    // Aggressive cleanup: close every page except the one we keep, then navigate to blank
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    const attachDiagnostics = (p: any) => {
        if (!p || p.__ccDiagnosticsAttached) return;
        p.__ccDiagnosticsAttached = true;
        let lastUrl = "";
        p.on("console", (msg: any) => {
          const text = msg.text();
          if (/\[CC-|WebSocket|Mixed Content|Content Security Policy/i.test(text)) {
            console.log(`[ChromePage:${msg.type()}] ${text}`);
          }
        });
        p.on("framenavigated", (frame: any) => {
          if (frame === p.mainFrame()) {
            lastUrl = p.url();
            console.log(`[ChromePage:navigated] ${lastUrl}`);
          }
        });
        p.on("close", () => {
          console.warn(`[ChromePage:close] ${lastUrl || "<unknown>"}`);
        });
        p.on("pageerror", (err: any) => {
          console.warn(`[ChromePage:error] ${err.message}`);
        });
      p.on("websocket", (socket: any) => {
        console.log(`[ChromePage:ws] ${socket.url()}`);
        socket.on("socketerror", (err: any) => console.warn(`[ChromePage:ws-error] ${socket.url()} ${err.message}`));
        socket.on("close", () => console.log(`[ChromePage:ws-close] ${socket.url()}`));
      });
      p.on("requestfailed", (req: any) => {
        const requestUrl = req.url();
        if (requestUrl.includes("/ws/voice-test") || requestUrl.includes("127.0.0.1") || requestUrl.includes("localhost")) {
          console.warn(`[ChromePage:requestfailed] ${requestUrl} ${req.failure()?.errorText || ""}`);
        }
      });
    };
    context.on("page", attachDiagnostics);
    attachDiagnostics(page);
    if (pages.length > 1) {
      console.log(`[ChromeLauncher] Closing ${pages.length - 1} extra tabs from previous session`);
      for (let i = pages.length - 1; i >= 1; i--) {
        try { await pages[i]?.close(); } catch {}
      }
    }
    await page.goto("about:blank");

    // Verify init script works
    const check = await page.evaluate(() => !!(globalThis as any).__cc);
    if (!check) {
      console.warn("[ChromeLauncher] Init script verification failed on about:blank");
    }

    // Keep the context alive — Chrome must stay open for playwright-cli to connect.
    // Store the context so it can be cleaned up later, but don't close it.
    // The init script persists in Chrome as long as the browser is open.
    this._context = context;
    this._page = page;

    // Crash/quit detection: without this, a dead Chrome left voice, vision
    // and recording running as zombies (every 3s page.evaluate just threw
    // into catch{} forever and end-detection could never fire).
    this._intentionalContextClose = false;
    context.on("close", () => {
      this._page = null as any;
      this._context = null as any;
      if (this._admissionInterval) this.stopAdmissionMonitor();
      this.stopAudioHealthMonitor();
      if (this._intentionalContextClose) return;
      console.warn("[ChromeLauncher] Chrome context closed unexpectedly (crash or manual quit)");
      this._onDisconnected?.();
    });

    console.log(`[ChromeLauncher] Chrome ready on port ${port}. playwright-cli can connect now.`);
    return { port };
  }

  private _onDisconnected: (() => void) | null = null;
  private _intentionalContextClose = false;

  /** Register a handler for unexpected Chrome death (crash / manual quit). */
  onDisconnected(cb: () => void): void {
    this._onDisconnected = cb;
  }

  private _getActivePage(preferMeeting = false): any | null {
    const current = this._page;
    const isOpen = (p: any) => p && (typeof p.isClosed !== "function" || !p.isClosed());
    const isMeetingPage = (p: any) => {
      try {
        const u = p.url?.() || "";
        return u.includes("meet.google.com") || u.includes("zoom.us");
      } catch {
        return false;
      }
    };

    if (isOpen(current) && (!preferMeeting || isMeetingPage(current))) return current;

    const pages = this._context?.pages?.() || [];
    const openPages = pages.filter(isOpen);
    const meetingPage = openPages.find(isMeetingPage);
    const next = (preferMeeting ? meetingPage : null) || meetingPage || openPages[0] || null;
    if (next && next !== this._page) {
      this._page = next;
      try {
        console.log(`[ChromeLauncher] Active page refreshed: ${next.url()}`);
      } catch {
        console.log("[ChromeLauncher] Active page refreshed");
      }
    }
    return next;
  }

  /**
   * After joining a meeting, call this to activate the audio pipeline.
   * Uses playwright-cli's evaluate to inject the audio bridge code.
   */
  static getAudioPipelineScript(): string {
    return AUDIO_PIPELINE_SCRIPT;
  }

  /**
   * Get the audio injection status from the page.
   * Call via playwright-cli evaluate.
   */
  static getStatusScript(): string {
    return `(function() {
      var cc = window.__cc;
      var p = window.__ccPipeline;
      if (!cc) return JSON.stringify({ error: 'no_init' });
      return JSON.stringify({
        gumCalls: cc.gumCalls,
        pcs: cc.pcs.length,
          pcStates: cc.pcs.map(function(pc) { return pc.connectionState; }),
          captureActive: cc.captureActive,
          captureChunks: cc.captureChunks,
          captureMaxAmp: cc.captureMaxAmp,
          wsConnected: !!cc.wsConnected,
          wsUrl: cc.wsUrl || null,
          wsErrorCount: cc.wsErrorCount || 0,
          wsCloseCount: cc.wsCloseCount || 0,
          wsState: p && p.ws() ? p.ws().readyState : -1,
          playbackChunks: cc.playbackChunks || 0,
          playbackSamples: cc.playbackSamples || 0,
          lastPlaybackAt: cc.lastPlaybackAt || 0,
          outputTrack: cc.outputTrack ? {
            id: cc.outputTrack.id,
            enabled: cc.outputTrack.enabled,
            muted: cc.outputTrack.muted,
            readyState: cc.outputTrack.readyState
          } : null,
          senders: cc.pcs.flatMap(function(pc) {
            return pc.getSenders().filter(function(s) { return s.track && s.track.kind === 'audio'; }).map(function(s) {
              return {
                id: s.track.id,
                label: s.track.label,
                enabled: s.track.enabled,
                muted: s.track.muted,
                readyState: s.track.readyState,
                sameAsOutput: !!(cc.outputTrack && s.track.id === cc.outputTrack.id)
              };
            });
          }),
          receivers: cc.pcs.flatMap(function(pc) {
            return pc.getReceivers().filter(function(r) { return r.track && r.track.kind === 'audio'; }).map(function(r) {
              return {
                id: r.track.id,
                label: r.track.label,
                muted: r.track.muted,
                readyState: r.track.readyState
              };
            });
          }),
        });
      })()`;
  }

  /** Activate the audio pipeline on the current page (call after joining a meeting) */
  async activateAudioPipeline(): Promise<string> {
    const page = this._getActivePage(true);
    if (!page) return "no_page";
    try {
      const result = await page.evaluate(AUDIO_PIPELINE_SCRIPT);
      console.log("[ChromeLauncher] Audio pipeline activated:", result);
      // Start (or keep) the live audio-health poller feeding getAudioHealth().
      this.startAudioHealthMonitor();
      return result;
    } catch (e: any) {
      console.warn("[ChromeLauncher] Audio pipeline activation failed:", e.message);
      return "error: " + e.message;
    }
  }

  // ── Audio-health live counters ───────────────────────────────────
  //
  // The audio self-check runs inside the page (window.__cc). This poller
  // reads window.__ccPipeline.health() every few seconds and keeps an
  // in-memory AudioHealth snapshot. getAudioHealth() returns it synchronously
  // so the status endpoint no longer needs to grep the backend log file.

  /** Poll interval for the audio-health snapshot (ms). */
  private static readonly AUDIO_HEALTH_POLL_MS = 3000;

  /** Start the audio-health poller (idempotent — no-op if already running). */
  private startAudioHealthMonitor(intervalMs = ChromeLauncher.AUDIO_HEALTH_POLL_MS): void {
    if (this._audioHealthInterval) return;
    console.log(`[AudioHealth] Monitor started (${intervalMs}ms)`);
    this._audioHealthInterval = setInterval(async () => {
      if (!this._page) return;
      try {
        const raw = await this._page.evaluate(
          `(function(){ var p = window.__ccPipeline; if (!p || !p.health) return null; return JSON.stringify(p.health()); })()`,
        );
        if (raw) {
          const parsed = JSON.parse(String(raw)) as AudioHealthRaw;
          this._audioHealth = computeAudioHealth(parsed, Date.now());
        }
      } catch {
        // Transient (page navigating / evaluate raced a close) — keep last snapshot.
      }
    }, intervalMs);
  }

  /** Stop the audio-health poller and reset the snapshot to inactive defaults. */
  stopAudioHealthMonitor(): void {
    if (this._audioHealthInterval) {
      clearInterval(this._audioHealthInterval);
      this._audioHealthInterval = null;
      console.log("[AudioHealth] Monitor stopped");
    }
    this._audioHealth = computeAudioHealth(null, Date.now());
  }

  /**
   * Live audio-health snapshot for the status endpoint. Synchronous — returns
   * a copy of the latest polled state (refreshed ~every 3s while a meeting
   * audio pipeline is active). Before any meeting / after teardown it reports
   * inactive defaults (active:false, captureFlowing:false).
   */
  getAudioHealth(): AudioHealth {
    return { ...this._audioHealth };
  }

  /** Get audio injection status from the page */
  async getStatus(): Promise<any> {
    const page = this._getActivePage(true);
    if (!page) return { error: "no_page" };
    try {
      const raw = await page.evaluate(`(function() {
        var cc = window.__cc;
        var p = window.__ccPipeline;
        if (!cc) return JSON.stringify({ error: 'no_init' });
        return JSON.stringify({
          gumCalls: cc.gumCalls,
          pcs: cc.pcs.length,
          pcStates: cc.pcs.map(function(pc) { return pc.connectionState; }),
          captureActive: cc.captureActive,
          captureChunks: cc.captureChunks,
          captureMaxAmp: cc.captureMaxAmp,
          wsConnected: !!cc.wsConnected,
          wsUrl: cc.wsUrl || null,
          wsErrorCount: cc.wsErrorCount || 0,
          wsCloseCount: cc.wsCloseCount || 0,
          wsState: p && p.ws() ? p.ws().readyState : -1,
          playbackChunks: cc.playbackChunks || 0,
          playbackSamples: cc.playbackSamples || 0,
          lastPlaybackAt: cc.lastPlaybackAt || 0,
          outputTrack: cc.outputTrack ? {
            id: cc.outputTrack.id,
            enabled: cc.outputTrack.enabled,
            muted: cc.outputTrack.muted,
            readyState: cc.outputTrack.readyState
          } : null,
          senders: cc.pcs.flatMap(function(pc) {
            return pc.getSenders().filter(function(s) { return s.track && s.track.kind === 'audio'; }).map(function(s) {
              return {
                id: s.track.id,
                label: s.track.label,
                enabled: s.track.enabled,
                muted: s.track.muted,
                readyState: s.track.readyState,
                sameAsOutput: !!(cc.outputTrack && s.track.id === cc.outputTrack.id)
              };
            });
          }),
          receivers: cc.pcs.flatMap(function(pc) {
            return pc.getReceivers().filter(function(r) { return r.track && r.track.kind === 'audio'; }).map(function(r) {
              return {
                id: r.track.id,
                label: r.track.label,
                muted: r.track.muted,
                readyState: r.track.readyState
              };
            });
          }),
        });
      })()`);
      return JSON.parse(raw);
    } catch {
      return { error: "evaluate_failed" };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Google Meet Join (replaces playwright-cli joinGoogleMeet)
  // ══════════════════════════════════════════════════════════════

  /** Total whole-join attempts before giving up (see MAX_JOIN_ATTEMPTS). */
  private static readonly MAX_JOIN_ATTEMPTS = MAX_JOIN_ATTEMPTS;

  /**
   * Join a Google Meet (or Zoom web-client) meeting, with whole-join
   * retry + exponential backoff.
   *
   * A single attempt already retries WITHIN itself (page reload, agentic DOM
   * scan, 6× verify loop). This wrapper adds resilience when the entire attempt
   * resolves state:"failed" for a transient reason (navigation error, join
   * button not found, verify timeout, network/5xx): it re-attempts up to
   * MAX_JOIN_ATTEMPTS times with backoff (0s → 2s → 6s, capped 15s).
   *
   * Failures are classified (classifyJoinFailure): terminal outcomes
   * (rejected / denied / kicked / removed / meeting ended / expired code /
   * access blocked) FAIL FAST and are never retried. A `waiting_room` result
   * is a legitimate non-failure and returns immediately (the admission monitor
   * takes over) — it is NOT retried.
   *
   * Google Meet behavior within an attempt is unchanged.
   */
  async joinGoogleMeet(
    url: string,
    opts?: {
      displayName?: string;
      muteCamera?: boolean;
      muteMic?: boolean;
      onStep?: (step: string) => void;
    },
  ): Promise<JoinResult> {
    if (!this._page) return { success: false, summary: "No page — call launch() first", steps: [], state: "failed" };

    const onStep = opts?.onStep;
    const allSteps: string[] = [];
    const wlog = (msg: string) => { allSteps.push(msg); onStep?.(msg); console.log(`[MeetJoin] ${msg}`); };

    let last: JoinResult = { success: false, summary: "join not attempted", steps: [], state: "failed" };

    for (let attempt = 0; attempt < ChromeLauncher.MAX_JOIN_ATTEMPTS; attempt++) {
      // Backoff before retries (attempt 0 has no delay).
      const delay = joinBackoffMs(attempt);
      if (delay > 0) {
        wlog(`Retry backoff: waiting ${Math.round(delay / 1000)}s before attempt ${attempt + 1}/${ChromeLauncher.MAX_JOIN_ATTEMPTS}...`);
        await new Promise((r) => setTimeout(r, delay));
        if (!this._page) return { success: false, summary: "No page — Chrome closed during retry backoff", steps: allSteps, state: "failed" };
      }

      wlog(`Join attempt ${attempt + 1}/${ChromeLauncher.MAX_JOIN_ATTEMPTS} — ${url}`);
      last = await this._joinAttempt(url, opts);
      for (const s of last.steps) allSteps.push(s);

      // Success or waiting room → done (never retry a legitimate outcome).
      if (last.success || last.state === "waiting_room") {
        return { ...last, steps: allSteps };
      }

      // Failed → classify.
      const cls = classifyJoinFailure(last.summary);
      wlog(`Attempt ${attempt + 1} failed (${cls}): ${last.summary}`);
      if (cls === "terminal") {
        return { ...last, steps: allSteps };
      }
      // retryable → loop again if attempts remain.
    }

    wlog(`All ${ChromeLauncher.MAX_JOIN_ATTEMPTS} join attempts exhausted`);
    return { ...last, steps: allSteps, summary: `${last.summary} (after ${ChromeLauncher.MAX_JOIN_ATTEMPTS} attempts)` };
  }

  /**
   * A single join attempt (the original join logic). Called by joinGoogleMeet's
   * retry wrapper. Returns state:"failed" with a descriptive summary on failure
   * so the wrapper can classify terminal vs retryable.
   */
  private async _joinAttempt(
    url: string,
    opts?: {
      displayName?: string;
      muteCamera?: boolean;
      muteMic?: boolean;
      onStep?: (step: string) => void;
    },
  ): Promise<JoinResult> {
    if (!this._page) return { success: false, summary: "No page — call launch() first", steps: [], state: "failed" };

    let page = this._getActivePage() || this._page;
    const displayName = opts?.displayName || "CallingClaw";
    const muteCamera = opts?.muteCamera ?? true;
    const muteMic = opts?.muteMic ?? false;
    const steps: string[] = [];
    const log = (msg: string) => { steps.push(msg); opts?.onStep?.(msg); console.log(`[MeetJoin] ${msg}`); };
    const refreshPage = (reason: string) => {
      const next = this._getActivePage(true);
      if (!next) throw new Error(`No active meeting page after ${reason}`);
      if (next !== page) log(`Using refreshed page after ${reason}`);
      page = next;
      return page;
    };

    try {
      // Step 1: Navigate
      log("Navigating...");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Step 1b: Zoom — navigate directly to web client (skip landing page)
      const isZoom = url.includes("zoom.us");
      if (isZoom) {
        log("Zoom detected — navigating to web client...");
        // Extract meeting ID and password from URL, then go straight to web client
        const zoomMatch = url.match(/\/j\/(\d+)/);
        const pwdMatch = url.match(/pwd=([^&]+)/);
        if (zoomMatch) {
          const meetingId = zoomMatch[1];
          const pwd = pwdMatch ? pwdMatch[1] : "";
          const webClientUrl = `https://app.zoom.us/wc/join/${meetingId}${pwd ? `?pwd=${pwd}` : ""}`;
          log(`Navigating to Zoom Web Client: ${webClientUrl}`);
          await page.goto(webClientUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

          // Hardening: wait for the web client to actually render (name input,
          // Join button, or an in-meeting toolbar) instead of a blind sleep.
          // Zoom's SPA bundle + WASM init can take 5–15s; a fixed wait either
          // wastes time or fires before the DOM exists.
          const zoomReady = await this._waitForZoomWebClient(page, 25000);
          log(`Zoom web client: ${zoomReady}`);
          if (zoomReady === "timeout" || zoomReady === "error") {
            // Clear, classifiable failure reason (retryable — transient load).
            return {
              success: false,
              summary: "Zoom web client did not load (name/Join controls never appeared)",
              steps,
              state: "failed",
            };
          }
          // Enter the display name on the pre-join screen if one is requested.
          if (zoomReady === "name_required") {
            const named = await this._fillZoomName(page, displayName);
            log(`Zoom name entry: ${named}`);
          }
        } else {
          // Can't parse URL — try the landing page approach, then wait for the
          // in-browser client controls to appear (no blind sleep).
          await page.waitForTimeout(2000);
          const zoomLanding = await page.evaluate(`(() => {
            var els = document.querySelectorAll('a, button, [role="button"]');
            for (var i = 0; i < els.length; i++) {
              var t = (els[i].textContent || '').trim().toLowerCase();
              if (t.includes('join from your browser') || t.includes('join from browser')) {
                els[i].click();
                return 'clicked_browser_join';
              }
            }
            return 'no_browser_join_found';
          })()`);
          log(`Zoom landing: ${zoomLanding}`);
          if (String(zoomLanding).includes("clicked")) {
            const zoomReady = await this._waitForZoomWebClient(page, 25000);
            log(`Zoom web client: ${zoomReady}`);
            if (zoomReady === "timeout" || zoomReady === "error") {
              return {
                success: false,
                summary: "Zoom web client did not load after landing-page join (controls never appeared)",
                steps,
                state: "failed",
              };
            }
            if (zoomReady === "name_required") {
              const named = await this._fillZoomName(page, displayName);
              log(`Zoom name entry: ${named}`);
            }
          } else {
            return {
              success: false,
              summary: "Zoom 'Join from browser' link not found on landing page",
              steps,
              state: "failed",
            };
          }
        }
      }

      // Step 2: Dismiss + detect + configure
      log("Detecting + configuring...");
      const configResult = await page.evaluate(`(() => {
        var R = { state: 'unknown', config: [], hasJoinBtn: false };

        // 1. Dismiss blocking dialogs
        var dismiss = ['got it', 'dismiss', 'continue without', 'not now', 'block', 'deny'];
        document.querySelectorAll('button, [role="button"]').forEach(function(b) {
          var t = (b.textContent || '').trim().toLowerCase();
          if (dismiss.some(function(d) { return t === d || t.includes(d); })) b.click();
        });

        // 2. Detect page state
        var body = document.body ? (document.body.innerText || '') : '';
        var btns = Array.from(document.querySelectorAll('button'));
        var btnTexts = btns.map(function(b) { return b.textContent.trim(); });

        if (document.querySelector('[aria-label*="Leave call" i], [aria-label*="End call" i], [aria-label*="退出通话"], [aria-label*="结束通话"], [aria-label*="離開通話"], [aria-label*="結束通話"]') || document.querySelector('[aria-label="Call controls"], [aria-label="通话控件"]') || document.querySelector('.meeting-app')) {
          R.state = 'already_in'; return JSON.stringify(R);
        }
        if (body.includes('This meeting has ended') || body.includes('会议已结束')) {
          R.state = 'ended'; return JSON.stringify(R);
        }
        if (body.includes('not allowed') || body.includes('Check your meeting code')) {
          R.state = 'error'; return JSON.stringify(R);
        }

        // 3. Handle "Switch here"
        var switchBtn = btns.find(function(b) { return ['Switch here', '切换到这里'].indexOf(b.textContent.trim()) !== -1; });
        if (switchBtn) { switchBtn.click(); R.state = 'switch_here'; return JSON.stringify(R); }

        // 4. Camera OFF (Meet aria-label selectors + Zoom text-based fallback)
        ${muteCamera ? `
        var camOff = document.querySelector(
          '[aria-label="Turn off camera"], [aria-label="关闭摄像头"],' +
          '[aria-label*="Stop Video"], [aria-label*="stop video"]'
        );
        if (!camOff) {
          // Zoom fallback: find button by text content "Stop Video"
          var allBtns = document.querySelectorAll('button, [role="button"]');
          for (var i = 0; i < allBtns.length; i++) {
            var txt = (allBtns[i].textContent || '').trim();
            if (txt === 'Stop Video' || txt === 'Stop Camera' || txt === '停止视频') {
              camOff = allBtns[i]; break;
            }
          }
        }
        if (camOff) { camOff.click(); R.config.push('cam:off'); }
        else R.config.push('cam:already_off');
        ` : `R.config.push('cam:skip');`}

        // 5. Mic — leave unmuted for audio injection
        ${muteMic ? `
        var micOff = document.querySelector(
          '[aria-label="Turn off microphone"], [aria-label="关闭麦克风"],' +
          '[aria-label*="Mute"], [aria-label*="mute my audio"]'
        );
        if (micOff) { micOff.click(); R.config.push('mic:muted'); }
        ` : `
        R.config.push('mic:already_on');
        `}

        // 6. Set display name (Meet + Zoom)
        // Try multiple selectors: aria-label, placeholder, then any visible input near "Your Name" text
        var nameInput = document.querySelector(
          'input[aria-label="Your name"], input[placeholder*="name" i],' +
          'input#inputname, input[aria-label*="name" i]'
        );
        if (!nameInput) {
          // Zoom fallback: find input near "Your Name" or "Enter Meeting Info" text
          var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].offsetWidth > 0) { nameInput = inputs[i]; break; }
          }
        }
        if (nameInput && (!nameInput.value || nameInput.value === 'Guest' || nameInput.value.trim() === '')) {
          nameInput.focus();
          var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(nameInput, ${JSON.stringify(displayName)});
          } else {
            nameInput.value = ${JSON.stringify(displayName)};
          }
          nameInput.dispatchEvent(new Event('input', {bubbles:true}));
          nameInput.dispatchEvent(new Event('change', {bubbles:true}));
          R.config.push('name:set');
        } else if (nameInput) {
          R.config.push('name:already_set');
        }

        // 7. Check if join button exists
        var joinTargets = ['Join now', 'Ask to join', 'Join', 'Join Meeting', 'Join Audio by Computer', '加入会议', '请求加入', '立即加入', '加入音频'];
        for (var i = 0; i < btns.length; i++) {
          if (joinTargets.indexOf(btns[i].textContent.trim()) !== -1) { R.hasJoinBtn = true; break; }
        }

        R.state = R.hasJoinBtn ? 'ready_to_join' : (btnTexts.length > 0 ? 'no_join_button' : 'loading');
        return JSON.stringify(R);
      })()`);

      let parsed: any;
      try { parsed = JSON.parse(configResult); } catch { parsed = { state: "parse_error" }; }
      log(`State: ${parsed.state} config=[${(parsed.config || []).join(',')}]`);

      if (parsed.state === "already_in") {
        return { success: true, summary: "Already in meeting", steps, state: "in_meeting" };
      }
      if (parsed.state === "ended") {
        return { success: false, summary: "Meeting has ended", steps, state: "failed" };
      }
      if (parsed.state === "error") {
        return { success: false, summary: "Cannot access meeting", steps, state: "failed" };
      }

      // Retry if loading
      if (parsed.state === "loading" || parsed.state === "no_join_button") {
        log("Page loading — retrying in 4s...");
        await page.waitForTimeout(4000);
        const retry = await page.evaluate(`(() => {
          var btns = Array.from(document.querySelectorAll('button'));
          for (var i = 0; i < btns.length; i++) {
            if (['Join now','Ask to join','Join','Join Meeting','Join Audio by Computer','加入会议','请求加入','立即加入','加入音频'].indexOf(btns[i].textContent.trim()) !== -1) return 'found';
          }
          return 'still_no_button';
        })()`);
        log(`Retry: ${retry}`);
        if (String(retry).includes("still_no_button")) {
          // Agentic fallback: use DOM extraction to find ANY clickable join-like button
          log("Hardcoded selectors failed — trying agentic DOM scan...");
          const agenticResult = await page.evaluate(`(() => {
            var btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            var joinPatterns = /join|enter|start|connect|participate|加入|进入|开始/i;
            var excludePatterns = /zoom.*app|workplace|download|install|open zoom/i;
            for (var i = 0; i < btns.length; i++) {
              var t = (btns[i].textContent || '').trim();
              var label = btns[i].getAttribute('aria-label') || '';
              if (excludePatterns.test(t)) continue; // Skip "Join from Zoom app" etc.
              if (t.length > 1 && t.length < 40 && (joinPatterns.test(t) || joinPatterns.test(label))) {
                btns[i].click();
                return 'agentic_clicked:' + t;
              }
            }
            return 'agentic_no_match';
          })()`);
          log(`Agentic: ${agenticResult}`);
          if (String(agenticResult).includes("agentic_no_match")) {
            return { success: false, summary: "Join button not found (hardcoded + agentic)", steps, state: "failed" };
          }
        }
      }

      // Step 3: Click join button
      if (parsed.state !== "switch_here") {
        log("Clicking join...");
        const joinResult = await page.evaluate(`(() => {
          var btns = Array.from(document.querySelectorAll('button'));
          var joinTargets = ['Join now', 'Ask to join', 'Join', 'Join Meeting', 'Join Audio by Computer', '加入会议', '请求加入', '立即加入', '加入音频'];
          for (var i = 0; i < btns.length; i++) {
            var t = btns[i].textContent.trim();
            if (joinTargets.indexOf(t) !== -1) {
              if (btns[i].disabled) { btns[i].disabled = false; btns[i].removeAttribute('disabled'); }
              btns[i].click();
              return 'joined:' + t;
            }
          }
          return 'no_join_button';
        })()`);
        log(`Join: ${joinResult}`);
        if (String(joinResult).includes("no_join_button")) {
          return { success: false, summary: "Join button disappeared", steps, state: "failed" };
        }
      }

      // Step 4: Verify join state (poll up to 20s) — language-agnostic selectors
      log("Verifying join state...");
      await page.waitForTimeout(2000);

      for (let attempt = 0; attempt < 6; attempt++) {
        let state = "loading";
        try {
          state = await page.evaluate(`(() => {
            // Language-agnostic: check for leave button or control bar (Meet + Zoom)
            var leaveBtn = document.querySelector('[aria-label*="Leave"],[aria-label*="退出"],[aria-label*="離開"],[aria-label*="End Meeting"],[aria-label*="End"]');
            var callEnd = document.querySelector('[aria-label*="call_end"],[aria-label*="Call controls"],[aria-label*="通话控件"]');
            // Zoom web client: footer toolbar with meeting controls
            var zoomToolbar = document.querySelector('.meeting-info-container,.footer__inner,.meeting-client');
            // Generic: does the page have mic+camera buttons?
            var micBtn = document.querySelector('[aria-label*="microphone"],[aria-label*="麦克风"],[aria-label*="Mute"],[aria-label*="mute"]');
            var camBtn = document.querySelector('[aria-label*="camera"],[aria-label*="摄像头"],[aria-label*="Turn on camera"],[aria-label*="Turn off camera"],[aria-label*="Start Video"],[aria-label*="Stop Video"]');
            var hasControls = (micBtn && camBtn) || zoomToolbar;
            if (leaveBtn || callEnd || hasControls) return 'in_meeting';
            var t = document.body ? (document.body.innerText || '') : '';
            var lower = t.toLowerCase();
            // Host denial / ejection — TERMINAL (do NOT re-knock). Checked before the
            // waiting-room test and using phrases that cannot appear on a
            // waiting-room-only screen ("asking to be let in" / "waiting for someone
            // to let you in"), so a legitimate waiting room is never mis-flagged.
            var denialPhrases = [
              'request was denied', 'request to join was denied', 'denied your request',
              "you can't join this call", "you can't join this video call", "can't join this call",
              "you've been removed", 'you were removed', 'you have been removed',
              'removed from the meeting', 'removed you from', 'not admitted',
              '请求被拒绝', '拒绝了你的加入请求', '无法加入此通话', '你已被移出', '移出会议'
            ];
            for (var d = 0; d < denialPhrases.length; d++) {
              if (lower.indexOf(denialPhrases[d]) !== -1) return 'denied';
            }
            if (t.includes('Waiting for the host') || t.includes('Someone will let you in') || t.includes('等待主持人') || t.includes('等待主办人')) return 'waiting_room';
            return 'loading';
          })()`);
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (/Execution context was destroyed|Cannot find context|Target closed/i.test(msg)) {
            log(`Verify transient navigation (${attempt + 1}/6) — retrying`);
            refreshPage("verify navigation");
            if (attempt < 5) await page.waitForTimeout(3000);
            continue;
          }
          throw e;
        }

        if (String(state).includes("in_meeting")) {
          log("Joined!");

          // Zoom post-join: dismiss the "Join Audio by Computer" modal so our
          // virtual mic actually connects (Zoom stays audio-muted otherwise).
          if (isZoom) {
            for (let audioRetry = 0; audioRetry < 3; audioRetry++) {
              const audioJoin = await page.evaluate(`(() => {
                var all = Array.from(document.querySelectorAll('button, [role="button"]'));
                var btn = all.find(function(b) {
                  var t = (b.textContent || '').trim();
                  var a = (b.getAttribute('aria-label') || '');
                  return t === 'Join Audio by Computer' || t === 'Join with Computer Audio'
                    || t === '加入音频' || t === '通过电脑音频加入' || a.indexOf('Computer Audio') !== -1;
                });
                if (btn) { btn.click(); return 'audio_joined'; }
                return 'no_audio_modal';
              })()`);
              log(`Zoom audio (attempt ${audioRetry + 1}): ${audioJoin}`);
              if (audioJoin === "audio_joined") break;
              await page.waitForTimeout(1200);
            }
          }

          // Post-join: ensure mic is unmuted (retry — Meet may auto-mute on entry)
          if (!muteMic) {
            for (let micRetry = 0; micRetry < 3; micRetry++) {
              await page.waitForTimeout(1500);
              const micState = await page.evaluate(`(() => {
                // Check all possible mic button selectors (EN + ZH)
                var micOff = document.querySelector('[aria-label*="Turn on microphone"], [aria-label*="打开麦克风"], [aria-label*="Unmute"], [data-is-muted="true"] [aria-label*="microphone"], [data-is-muted="true"] [aria-label*="麦克风"]');
                if (micOff) { micOff.click(); return 'unmuted'; }
                var micOn = document.querySelector('[aria-label*="Turn off microphone"], [aria-label*="关闭麦克风"], [data-is-muted="false"] [aria-label*="microphone"]');
                if (micOn) return 'already_on';
                return 'not_found';
              })()`);
              log(`Post-join mic (attempt ${micRetry + 1}): ${micState}`);
              if (micState === 'already_on' || micState === 'unmuted') break;
            }
          }

          return { success: true, summary: "Joined meeting — camera off, mic on", steps, state: "in_meeting" };
        }
        if (String(state).includes("denied")) {
          // Host denied the "Ask to join" request (or ejected us). This is
          // terminal — re-knocking just spams the host. Summary contains "denied"
          // so classifyJoinFailure() → "terminal" and the retry wrapper stops.
          log("Join request denied by host — terminal, will not retry");
          return { success: false, summary: "Join request was denied by the host", steps, state: "failed" };
        }
        if (String(state).includes("waiting_room")) {
          log("In waiting room");
          return { success: false, summary: "In waiting room — waiting for host", steps, state: "waiting_room" };
        }
        if (attempt < 5) await page.waitForTimeout(3000);
      }

      // Fallback: if still on meet.google.com, assume we're in the meeting
      // (verify selectors may not match non-English UI)
      const currentUrl = page.url();
      if (currentUrl.includes("meet.google.com")) {
        log("Verify timeout but still on Meet — assuming in_meeting (i18n fallback)");
        return { success: true, summary: "Joined meeting (verify fallback)", steps, state: "in_meeting" };
      }
      return { success: false, summary: "Could not confirm join state", steps, state: "failed" };

    } catch (err: any) {
      log(`Error: ${err.message}`);
      return { success: false, summary: `Error: ${err.message}`, steps, state: "failed" };
    }
  }

  // ── Zoom web-client helpers (used by _joinAttempt) ───────────────

  /**
   * Wait for the Zoom web client to render actual controls instead of a blind
   * sleep. Resolves to:
   *   "in_meeting"    — meeting toolbar already present
   *   "name_required" — pre-join name input visible and empty (needs filling)
   *   "ready_to_join" — a Join button (or filled name input) is present
   *   "timeout"       — controls never appeared within `timeoutMs`
   *   "error"         — page.waitForFunction threw for another reason
   */
  private async _waitForZoomWebClient(
    page: any,
    timeoutMs: number,
  ): Promise<"in_meeting" | "name_required" | "ready_to_join" | "timeout" | "error"> {
    try {
      const handle = await page.waitForFunction(
        `(() => {
          // In-meeting toolbar already up?
          var inMeeting = document.querySelector(
            '.meeting-client, .footer__inner, .meeting-info-container,' +
            '[aria-label*="Leave"], [aria-label*="Mute"], [aria-label*="mute" i]'
          );
          if (inMeeting) return 'in_meeting';
          // Pre-join name input?
          var nameInput = document.querySelector(
            '#input-for-name, input#inputname, input[aria-label*="name" i], input[placeholder*="name" i]'
          );
          // Join button by text?
          var joinBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(b) {
            var t = (b.textContent || '').trim().toLowerCase();
            return t === 'join' || t === 'join meeting' || t === 'join audio by computer'
              || t === '加入' || t === '加入会议' || t === '加入音频';
          });
          if (nameInput && (!nameInput.value || nameInput.value.trim() === '')) return 'name_required';
          if (joinBtn || nameInput) return 'ready_to_join';
          return false; // keep polling
        })()`,
        { timeout: timeoutMs, polling: 500 },
      );
      const val = await handle.jsonValue();
      return val as "in_meeting" | "name_required" | "ready_to_join";
    } catch {
      // waitForFunction rejects on timeout — treat as a (retryable) load failure.
      return "timeout";
    }
  }

  /** Fill the Zoom pre-join display-name input. Returns a status string for logging. */
  private async _fillZoomName(page: any, displayName: string): Promise<string> {
    try {
      return String(await page.evaluate(`(() => {
        var nameInput = document.querySelector(
          '#input-for-name, input#inputname, input[aria-label*="name" i], input[placeholder*="name" i]'
        );
        if (!nameInput) {
          var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].offsetWidth > 0) { nameInput = inputs[i]; break; }
          }
        }
        if (!nameInput) return 'no_name_input';
        nameInput.focus();
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(nameInput, ${JSON.stringify(displayName)});
        else nameInput.value = ${JSON.stringify(displayName)};
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
        return 'name_set';
      })()`));
    } catch (e: any) {
      return "error:" + e.message;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Admission Monitor (replaces playwright-cli admission monitor)
  // ══════════════════════════════════════════════════════════════

  private _admissionInterval: ReturnType<typeof setInterval> | null = null;
  private _admittedSet = new Set<string>();
  private _meetingEndCallback: (() => void) | null = null;
  private _endCheckFailures = 0;
  private _consecutiveEndedChecks = 0;
  private static readonly MAX_END_CHECK_FAILURES = 20; // 20 × 3s = 60s of consecutive failures → force trigger
  private static readonly CONSECUTIVE_END_CHECKS_REQUIRED = 3; // 3 × 3s = 9s of confirmed "ended" before leaving

  /**
   * Monitor for attendee admission requests in Google Meet.
   * Uses Playwright library page.evaluate() directly (no playwright-cli).
   */
  startAdmissionMonitor(
    attendeeNames: string[],
    intervalMs = 3000,
    onFallback?: (instruction: string) => Promise<void>,
  ): void {
    if (!this._page) return;
    if (this._admissionInterval) this.stopAdmissionMonitor();
    this._admittedSet.clear();

    const admitAll = attendeeNames.length === 0;
    const page = this._page;
    console.log(`[MeetAdmit] Monitoring (${intervalMs}ms)${admitAll ? " admit-all" : ` for ${attendeeNames.length}: ${attendeeNames.join(", ")}`}`);

    let consecutiveFailures = 0;

    this._admissionInterval = setInterval(async () => {
      try {
        // Check if meeting has ended (3 consecutive ticks required)
        if (this._meetingEndCallback) {
          try {
            const ended = await this._meetingEndConfirmed();
            if (ended) {
              this._consecutiveEndedChecks++;
              if (this._consecutiveEndedChecks >= ChromeLauncher.CONSECUTIVE_END_CHECKS_REQUIRED) {
                console.log(`[MeetAdmit] Meeting ended (confirmed after ${this._consecutiveEndedChecks} consecutive checks) — triggering cleanup`);
                this._consecutiveEndedChecks = 0;
                this._endCheckFailures = 0;
                const cb = this._meetingEndCallback;
                this._meetingEndCallback = null;
                this.stopAdmissionMonitor();
                cb();
                return;
              }
              console.log(`[MeetAdmit] Meeting may have ended (${this._consecutiveEndedChecks}/${ChromeLauncher.CONSECUTIVE_END_CHECKS_REQUIRED}) — waiting to confirm`);
            } else {
              if (this._consecutiveEndedChecks > 0) {
                console.log(`[MeetAdmit] Meeting-end signal cleared (was ${this._consecutiveEndedChecks}/${ChromeLauncher.CONSECUTIVE_END_CHECKS_REQUIRED}) — false positive`);
              }
              this._consecutiveEndedChecks = 0;
              this._endCheckFailures = 0;
            }
          } catch (e: any) {
            this._consecutiveEndedChecks = 0;
            this._endCheckFailures++;
            console.warn(`[MeetAdmit] Meeting-end check failed (${this._endCheckFailures}/${ChromeLauncher.MAX_END_CHECK_FAILURES}): ${e.message}`);
            if (this._endCheckFailures >= ChromeLauncher.MAX_END_CHECK_FAILURES) {
              console.error("[MeetAdmit] Too many consecutive failures — force-triggering meeting end");
              this._endCheckFailures = 0;
              const cb = this._meetingEndCallback;
              this._meetingEndCallback = null;
              this.stopAdmissionMonitor();
              if (cb) cb();
              return;
            }
          }
        }

        // L1: Pure JS eval
        const result = await this._admitEvalLib();

        if (result.startsWith("admitted:")) {
          consecutiveFailures = 0;
          this._recordAdmitted(result.slice(9));
          await page.waitForTimeout(500);
          await this._dismissAdmitConfirmationLib();
          return;
        }

        if (result.startsWith("opened_")) {
          consecutiveFailures = 0;
          console.log(`[MeetAdmit] ${result} → chaining Step B...`);
          await page.waitForTimeout(800);
          const step2 = await this._admitEvalLib();
          if (step2.startsWith("admitted:")) {
            this._recordAdmitted(step2.slice(9));
            await page.waitForTimeout(500);
            await this._dismissAdmitConfirmationLib();
          } else {
            await page.waitForTimeout(600);
            const step3 = await this._admitEvalLib();
            if (step3.startsWith("admitted:")) {
              this._recordAdmitted(step3.slice(9));
              await page.waitForTimeout(500);
              await this._dismissAdmitConfirmationLib();
            } else {
              console.log(`[MeetAdmit] Panel open but Admit button not found after 2 retries`);
            }
          }
          return;
        }

        if (result === "has_notification_no_button") {
          consecutiveFailures++;
          console.log(`[MeetAdmit] Notification visible but no button (${consecutiveFailures}/3)`);
        } else {
          consecutiveFailures = 0;
        }

        // Fallback
        if (consecutiveFailures >= 3 && onFallback) {
          consecutiveFailures = 0;
          console.log("[MeetAdmit] L1 failed 3x → automation fallback...");
          const names = admitAll ? "all pending participants" : attendeeNames.join(", ");
          onFallback(
            `In Google Meet, someone is asking to join the meeting. ` +
            `Click the green admit notification or open the People panel, then click "Admit" to let in: ${names}`
          ).catch((e) => console.warn("[MeetAdmit] Fallback failed:", e.message));
        }
      } catch {}
    }, intervalMs);
  }

  private async _admitEvalLib(): Promise<string> {
    if (!this._page) return "none";
    return String(await this._page.evaluate(`(() => {
      var all = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex]'));

      // Step B: Individual "Admit" first
      var admit = all.find(function(b) {
        var t = (b.textContent || '').trim();
        var a = (b.getAttribute('aria-label') || '');
        return t === 'Admit' || t === '准许' || t === '允许加入' || a.includes('允许') || a.includes('Admit');
      });
      if (admit) { admit.click(); return 'admitted:' + admit.textContent.trim().substring(0, 60); }

      // Step B2: "Admit all" fallback
      var admitAll = all.find(function(b) {
        var t = (b.textContent || '').trim();
        return t === 'Admit all' || t === '全部准许' || t === '全部允许';
      });
      if (admitAll) { admitAll.click(); return 'admitted:' + admitAll.textContent.trim().substring(0, 60); }

      // Step A: Green notification
      var notif = all.find(function(b) {
        var t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
        return t.includes('Admit') && t.includes('guest');
      });
      if (notif) { notif.click(); return 'opened_admit_panel:' + notif.textContent.trim().substring(0, 60); }

      // "View all"
      var viewAll = all.find(function(b) {
        var t = (b.textContent || '').trim();
        return t === 'View all' || t === '查看全部';
      });
      if (viewAll) { viewAll.click(); return 'opened_view_all'; }

      // Detect join notification → open People panel
      var body = document.body.innerText;
      var hasNotif = body.includes('wants to join') || body.includes('asking to join') ||
        body.includes('请求加入') || body.includes('想加入') || body.includes('Someone wants to join');
      if (hasNotif) {
        var peopleBtn = all.find(function(b) {
          var a = (b.getAttribute('aria-label') || '');
          return a === 'People' || a.includes('Show everyone') || a.includes('参与者');
        });
        if (peopleBtn) { peopleBtn.click(); return 'opened_people_panel'; }
        return 'has_notification_no_button';
      }

      return 'none';
    })()`));
  }

  private async _dismissAdmitConfirmationLib(): Promise<void> {
    if (!this._page) return;
    const page = this._page;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await page.evaluate(`(() => {
          var all = Array.from(document.querySelectorAll('button, [role="button"], [role="dialog"] button, div[role="alertdialog"] button'));
          var confirmBtn = all.find(function(b) {
            var t = (b.textContent || '').trim();
            return t === 'Admit all' || t === '全部准许' || t === 'Confirm' || t === '确认' || t === 'OK' || t === '确定';
          });
          if (confirmBtn) { confirmBtn.click(); return 'confirmed'; }
          return 'no_dialog';
        })()`);
        if (String(result).includes("confirmed")) {
          console.log(`[MeetAdmit] Confirmation dialog dismissed (attempt ${attempt + 1})`);
          return;
        }
      } catch {}
      await page.waitForTimeout(500 + attempt * 300);
    }
  }

  private async _checkMeetingEndedLib(): Promise<boolean> {
    if (!this._page) return false;
    const result = await this._page.evaluate(`(() => {
      if (!location.hostname.includes('meet.google.com') && !location.hostname.includes('zoom.us')) return 'ended';
      var text = document.body.innerText || '';
      // Waiting room / pre-join lobby: no Leave button, no call controls, no
      // video grid — but the meeting has NOT ended. Without this check the
      // structural fallback below declared 'ended' while waiting for admission.
      var waitingSignals = [
        'Asking to be let in', 'asking to be let in',
        "when someone lets you in", 'Ready to join', 'Ask to join',
        '请求加入', '等待加入', '准备加入', '有人允许后即可加入',
      ];
      if (waitingSignals.some(function(s) { return text.includes(s); })) return 'active';
      var endedSignals = [
        'This meeting has ended', '会议已结束', '會議已結束',
        'You were removed from the meeting', '您已被移出会议',
        'Your meeting code has expired', '会议代码已过期',
        'Return to home screen', '返回主屏幕',
        'The meeting has ended for everyone', '所有人的会议已结束',
        'You left the meeting', '你已退出会议', '您已離開會議',
      ];
      var hasEndedText = endedSignals.some(function(s) { return text.includes(s); });
      if (hasEndedText) return 'ended';
      // 'Rejoin' only counts as an exact button label — a body-text substring
      // match fired on any page that merely mentioned rejoining.
      var rejoinBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some(function(b) {
        var t = (b.textContent || '').trim();
        return t === 'Rejoin' || t === '重新加入';
      });
      if (rejoinBtn) return 'ended';
      var leaveBtn = document.querySelector('[aria-label*="Leave call" i], [aria-label*="End call" i], [aria-label*="退出通话"], [aria-label*="结束通话"], [aria-label*="離開通話"], [aria-label*="結束通話"]');
      var callControls = document.querySelector('[aria-label="Call controls"], [aria-label="通话控件"]');
      var videoGrid = document.querySelector('[data-allocation-index], [data-requested-participant-id]');
      // Zoom: check for meeting-end indicators
      if (location.hostname.includes('zoom.us')) {
        var zoomText = document.body.innerText || '';
        if (zoomText.includes('This meeting has been ended') || zoomText.includes('The host has ended this meeting')) return 'ended';
        // Zoom is active if the meeting client container exists
        var zoomActive = document.querySelector('.meeting-client, .meeting-app, [class*="meeting"]');
        if (zoomActive) return 'active';
        return 'active'; // Default to active for Zoom (avoid false positives)
      }
      if (!leaveBtn && !callControls && !videoGrid) return 'ended';
      return 'active';
    })()`);
    return result === "ended";
  }

  private _endedTickCount = 0;

  /**
   * Require N consecutive 'ended' ticks (3s apart) before declaring the
   * meeting over. Single-tick detection false-positived on transient DOM
   * states (page loads, layout shifts) and triggered the full post-meeting
   * pipeline — summary, delivery, voice teardown — on a live meeting.
   */
  private async _meetingEndConfirmed(consecutiveRequired = 3): Promise<boolean> {
    const ended = await this._checkMeetingEndedLib();
    if (!ended) {
      this._endedTickCount = 0;
      return false;
    }
    this._endedTickCount++;
    if (this._endedTickCount < consecutiveRequired) {
      console.log(`[MeetEnd] ended signal ${this._endedTickCount}/${consecutiveRequired} — waiting for confirmation`);
      return false;
    }
    this._endedTickCount = 0;
    return true;
  }

  private _recordAdmitted(text: string) {
    const names = text.split(",").map(n => n.trim()).filter(Boolean);
    for (const name of names) {
      if (!this._admittedSet.has(name)) {
        this._admittedSet.add(name);
        console.log(`[MeetAdmit] ✅ Admitted: ${name}`);
      }
    }
  }

  stopAdmissionMonitor(): string[] {
    if (this._admissionInterval) {
      clearInterval(this._admissionInterval);
      this._admissionInterval = null;
    }
    this._meetingEndCallback = null;
    this._endCheckFailures = 0;
    const admitted = [...this._admittedSet];
    console.log(`[MeetAdmit] Monitor stopped. Admitted ${admitted.length} attendees.`);
    return admitted;
  }

  get isAdmissionMonitoring(): boolean {
    return this._admissionInterval !== null;
  }

  onMeetingEnd(callback: () => void): void {
    this._meetingEndCallback = callback;
    this._endedTickCount = 0;
    if (!this._admissionInterval) {
      console.log("[MeetEnd] Starting standalone meeting-end watcher (3s interval)");
      this._endCheckFailures = 0;
      this._consecutiveEndedChecks = 0;
      this._admissionInterval = setInterval(async () => {
        try {
          const ended = await this._meetingEndConfirmed();
          if (ended) {
            this._consecutiveEndedChecks++;
            if (this._consecutiveEndedChecks >= ChromeLauncher.CONSECUTIVE_END_CHECKS_REQUIRED) {
              console.log(`[MeetEnd] Meeting ended (confirmed after ${this._consecutiveEndedChecks} checks) — triggering cleanup`);
              this._consecutiveEndedChecks = 0;
              this._endCheckFailures = 0;
              const cb = this._meetingEndCallback;
              this._meetingEndCallback = null;
              this.stopAdmissionMonitor();
              if (cb) cb();
            } else {
              console.log(`[MeetEnd] Meeting may have ended (${this._consecutiveEndedChecks}/${ChromeLauncher.CONSECUTIVE_END_CHECKS_REQUIRED}) — waiting to confirm`);
            }
          } else {
            this._consecutiveEndedChecks = 0;
            this._endCheckFailures = 0;
          }
        } catch (e: any) {
          this._consecutiveEndedChecks = 0;
          this._endCheckFailures++;
          console.warn(`[MeetEnd] Detection failed (${this._endCheckFailures}/${ChromeLauncher.MAX_END_CHECK_FAILURES}): ${e.message}`);
          if (this._endCheckFailures >= ChromeLauncher.MAX_END_CHECK_FAILURES) {
            console.error("[MeetEnd] Too many consecutive failures — force-triggering meeting end");
            this._endCheckFailures = 0;
            const cb = this._meetingEndCallback;
            this._meetingEndCallback = null;
            this.stopAdmissionMonitor();
            if (cb) cb();
          }
        }
      }, 3000);
    }
  }

  clearMeetingEndCallback(): void {
    this._meetingEndCallback = null;
  }

  /**
   * Leave the current Google Meet meeting by clicking the hangup button.
   * Returns true if successfully left, false if no meeting page or button not found.
   */
  async leaveMeeting(): Promise<boolean> {
    if (!this._page) return false;
    const page = this._page;

    // Audio pipeline is torn down when we leave — stop reporting stale health.
    this.stopAudioHealthMonitor();

    try {
      // Find the Leave/Hangup button.
      // Current Meet UI labels it "End call" (结束通话); older UI used
      // "Leave call" (退出通话) — match both, case-insensitively.
      // String-form eval: this runs in the page, where DOM globals exist.
      const left = await page.evaluate(`(() => {
        var selectors = [
          '[aria-label*="Leave call" i]',
          '[aria-label*="End call" i]',
          '[aria-label*="退出通话"]',
          '[aria-label*="结束通话"]',
          '[aria-label*="離開通話"]',
          '[aria-label*="結束通話"]',
          '[data-tooltip*="Leave call" i]',
          '[data-tooltip*="End call" i]',
          '[data-tooltip*="退出通话"]',
          '[data-tooltip*="结束通话"]',
        ];
        for (var i = 0; i < selectors.length; i++) {
          var btn = document.querySelector(selectors[i]);
          if (btn) { btn.click(); return true; }
        }
        // Last resort: the red hangup is the only control containing the
        // call_end font-icon text
        var all = Array.from(document.querySelectorAll("button, [role='button']"));
        var iconBtn = all.find(function (b) { return (b.textContent || "").includes("call_end"); });
        if (iconBtn) { iconBtn.click(); return true; }
        return false;
      })()`) as boolean;

      if (left) {
        console.log("[ChromeLauncher] Leave button clicked");
        // Wait a moment then navigate away to ensure full disconnect
        await new Promise((r) => setTimeout(r, 1000));
        await page.goto("about:blank").catch(() => {});
        console.log("[ChromeLauncher] Left meeting, navigated to about:blank");
        return true;
      }

      console.warn("[ChromeLauncher] Leave button not found, navigating away as fallback");
      await page.goto("about:blank").catch(() => {});
      return true;
    } catch (e: any) {
      console.warn("[ChromeLauncher] leaveMeeting error:", e.message);
      // Last resort: navigate away
      try { await page.goto("about:blank"); } catch {}
      return false;
    } finally {
      // Clean up orphaned pages (presenting tab, stale blank tabs)
      if (this._presentingPage) {
        try { await this._presentingPage.close(); } catch {}
        this._presentingPage = null;
      }
      if (this._context) {
        const pages = this._context.pages();
        const mainPage = this._page;
        for (const p of pages) {
          if (p === mainPage) continue;
          try {
            const url = p.url();
            if (url === "about:blank" || url === "") {
              await p.close();
            }
          } catch {}
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Screen Sharing (Meet "Present now")
  // ══════════════════════════════════════════════════════════════

  // The presenting tab — kept alive for screen sharing
  private _presentingPage: any = null;
  private _isSharing = false;  // True when Meet is actively screen sharing

  /**
   * Share a URL or the current screen in Google Meet.
   *
   * How it works:
   *   1. Opens the target URL in a new tab titled "CallingClaw Presenting"
   *   2. Switches back to Meet tab and clicks "Share screen"
   *   3. Chrome's --auto-select-desktop-capture-source=CallingClaw Presenting
   *      auto-selects that tab (no dialog, no manual step)
   *
   * @param url - URL to present (http, file://, or localhost). If omitted, opens Meeting Stage dashboard.
   */
  async shareScreen(url?: string): Promise<{ success: boolean; message: string }> {
    if (!this._page || !this._context) return { success: false, message: "No page — call launch() first" };
    const meetPage = this._page;

    try {
      // Default to Meeting Stage when no URL specified
      const presentUrl = url || `http://localhost:${CONFIG.port}/stage`;

      // Step 1: Open target URL in a "presenting" tab
      if (presentUrl) {
        // Close previous presenting tab if still alive
        if (this._presentingPage) {
          try {
            // Verify page is still alive before closing
            await this._presentingPage.evaluate("1");
            await this._presentingPage.close();
          } catch {
            // Page already dead, just clear the reference
          }
          this._presentingPage = null;
        }
        this._presentingPage = await this._context.newPage();
        await this._presentingPage.goto(presentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        // Rename tab title to match Chrome's auto-select flag
        await this._presentingPage.evaluate(`document.title = "CallingClaw Presenting"`);
        // Inject virtual cursor overlay for click effects (must be AFTER title set)
        await this._presentingPage.evaluate(CURSOR_INJECT_JS);
        console.log(`[ShareScreen] Opened presenting tab: ${presentUrl}`);

        // Switch back to Meet
        await meetPage.bringToFront();
        await meetPage.waitForTimeout(500);
      }

      // Step 2: Click "Share screen" in Meet
      const clicked = String(await meetPage.evaluate(`(() => {
        var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        var btn = btns.find(function(b) {
          var label = (b.getAttribute('aria-label') || '').toLowerCase();
          return label === 'share screen' || label.includes('present') || label.includes('投屏')
            || label.includes('展示') || label.includes('共享屏幕');
        });
        if (btn) { btn.click(); return 'clicked'; }
        return 'not_found';
      })()`));

      if (clicked === "not_found") {
        return { success: false, message: "Share screen button not found — are you in a meeting?" };
      }

      // Step 3: Chrome auto-selects "CallingClaw Presenting" tab (or entire screen if no URL)
      // Wait for sharing to initialize
      console.log("[ShareScreen] Waiting for Chrome auto-select...");
      await meetPage.waitForTimeout(4000);

      // Step 4: Verify sharing is active
      const status = String(await meetPage.evaluate(`(() => {
        var stop = document.querySelector('[aria-label*="Stop sharing"], [aria-label*="停止共享"], [aria-label*="Stop presenting"], [aria-label*="停止展示"]');
        if (stop) return 'sharing';
        var label = document.querySelector('[aria-label*="Presentation is"], [aria-label*="presenting"]');
        if (label) return 'presenting';
        if (document.body.innerText.includes('presenting') || document.body.innerText.includes('Presentation')) return 'presenting_text';
        return 'not_sharing';
      })()`));

      const success = status !== "not_sharing";
      this._isSharing = success;
      console.log(`[ShareScreen] Status: ${status} (${success ? "✅" : "❌"})`);

      // After sharing starts, switch focus to the presenting tab.
      // Human presenters look at what they're sharing, not the meeting room.
      // This also ensures BrowserCapture/VisionModule target the right tab.
      if (success && this._presentingPage) {
        try {
          await this._presentingPage.bringToFront();
          console.log("[ShareScreen] Switched focus to presenting tab");
        } catch (e: any) {
          console.warn("[ShareScreen] Could not switch to presenting tab:", e.message);
        }
      }

      return {
        success,
        message: success
          ? `Presenting${url ? ': ' + url : ' (Meeting Stage)'}`
          : "Sharing may not have started — check macOS Screen Recording permission",
      };
    } catch (e: any) {
      console.warn("[ShareScreen] Failed:", e.message);
      return { success: false, message: e.message };
    }
  }

  /** Stop screen sharing and close the presenting tab */
  async stopSharing(): Promise<{ success: boolean }> {
    if (!this._page) return { success: false };
    try {
      const result = String(await this._page.evaluate(`(() => {
        var btn = document.querySelector('[aria-label*="Stop sharing"], [aria-label*="停止共享"], [aria-label*="Stop presenting"], [aria-label*="停止展示"]');
        if (btn) { btn.click(); return 'stopped'; }
        return 'no_button';
      })()`));
      // Close presenting tab and wait for Meet to settle
      this._isSharing = false;
      if (this._presentingPage) {
        try { await this._presentingPage.close(); } catch {}
        this._presentingPage = null;
      }
      // Wait for Meet to process the stop (dismiss "You stopped presenting" banner)
      if (result === "stopped") {
        await this._page.waitForTimeout(1500);
      }
      console.log(`[ShareScreen] Stop: ${result}`);
      return { success: result === "stopped" || result === "no_button" };
    } catch {
      return { success: false };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Presenting Tab Operations (content tab, NOT Meet tab)
  // ══════════════════════════════════════════════════════════════

  /** Get the presenting page (the tab showing shared content) */
  get presentingPage(): any { return this._presentingPage; }
  get isSharing(): boolean { return this._isSharing; }

  /** Check Meet's actual sharing state by querying the DOM (not the stale _isSharing flag) */
  async checkSharingStatus(): Promise<boolean> {
    if (!this._page) return false;
    try {
      const status = String(await this._page.evaluate(`(() => {
        var stop = document.querySelector('[aria-label*="Stop sharing"], [aria-label*="停止共享"], [aria-label*="Stop presenting"], [aria-label*="停止展示"]');
        return stop ? 'sharing' : 'not_sharing';
      })()`));
      const sharing = status === "sharing";
      this._isSharing = sharing; // sync the flag
      return sharing;
    } catch {
      return false;
    }
  }

  /** Execute JavaScript on the presenting tab */
  async evaluateOnPresentingPage(code: string): Promise<any> {
    if (!this._presentingPage) return null;
    try { return await this._presentingPage.evaluate(code); }
    catch (e: any) { console.warn("[ChromeLauncher] Presenting page evaluate failed:", e.message); return null; }
  }

  /** Click element on presenting page by CSS selector */
  async clickOnPresentingPage(selector: string): Promise<boolean> {
    if (!this._presentingPage) return false;
    try {
      await this._presentingPage.click(selector, { timeout: 5000 });
      return true;
    } catch (e: any) {
      console.warn(`[ChromeLauncher] Click failed on presenting page: ${selector}`, e.message);
      return false;
    }
  }

  /** Navigate presenting page to a new URL */
  async navigatePresentingPage(url: string): Promise<boolean> {
    if (!this._context) return false;
    if (!this._presentingPage) {
      this._presentingPage = await this._context.newPage();
    }
    try {
      await this._presentingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await this._presentingPage.evaluate(`document.title = "CallingClaw Presenting"`);
      // Re-inject virtual cursor overlay (destroyed by navigation)
      await this._presentingPage.evaluate(CURSOR_INJECT_JS);
      return true;
    } catch (e: any) {
      console.warn("[ChromeLauncher] Presenting page navigate failed:", e.message);
      // Close the failed page before retrying (prevents orphaned blank tabs)
      try { await this._presentingPage?.close(); } catch {}
      this._presentingPage = null;
      // Try once more with a fresh page
      try {
        this._presentingPage = await this._context.newPage();
        await this._presentingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await this._presentingPage.evaluate(`document.title = "CallingClaw Presenting"`);
        console.log("[ChromeLauncher] Presenting page recreated successfully");
        return true;
      } catch (e2: any) {
        console.warn("[ChromeLauncher] Presenting page recreate also failed:", e2.message);
        try { await this._presentingPage?.close(); } catch {}
        this._presentingPage = null;
      }
      return false;
    }
  }

  /** Get accessibility snapshot of presenting page (for Haiku action loop) */
  async snapshotPresentingPage(): Promise<string> {
    if (!this._presentingPage) return "No presenting page";
    try {
      return String(await this._presentingPage.evaluate(`(() => {
        function snap(el, depth) {
          if (depth > 4) return '';
          var tag = el.tagName || '';
          var text = (el.textContent || '').trim().substring(0, 60);
          var label = el.getAttribute('aria-label') || '';
          var role = el.getAttribute('role') || '';
          var href = el.getAttribute('href') || '';
          var parts = [];
          if (role) parts.push('role=' + role);
          if (label) parts.push('label="' + label + '"');
          if (href) parts.push('href="' + href.substring(0, 40) + '"');
          if (text && text.length > 2 && !el.children.length) parts.push('"' + text + '"');
          var line = parts.length > 0 ? '<' + tag + ' ' + parts.join(' ') + '>' : '';
          var children = '';
          for (var c of el.children) { children += snap(c, depth + 1); }
          return (line ? '  '.repeat(depth) + line + '\\n' : '') + children;
        }
        return snap(document.body, 0).substring(0, 4000);
      })()`));
    } catch { return "Snapshot failed"; }
  }

  // ══════════════════════════════════════════════════════════════
  // Stage iframe Control (slide frame inside /stage page)
  // ══════════════════════════════════════════════════════════════

  /** Check if the presenting page is currently showing the Meeting Stage */
  private _isOnStage(): boolean {
    if (!this._presentingPage) return false;
    try { return String(this._presentingPage.url()).includes("/stage"); } catch { return false; }
  }

  /** Load a URL into the stage's slide iframe. Returns false if not on stage or load failed. */
  async loadSlideFrame(url: string): Promise<boolean> {
    if (!this._presentingPage) return false;
    // Navigate to stage first if not already there
    if (!this._isOnStage()) {
      const ok = await this.navigatePresentingPage(`http://localhost:${CONFIG.port}/stage`);
      if (!ok) return false;
      // Wait for the stage page to fully render the iframe element
      await this._presentingPage.waitForTimeout(2000);
    }
    try {
      // Ensure the iframe element exists before trying to set its src
      await this._presentingPage.waitForSelector('#slideFrame', { timeout: 5000 });
      await this._presentingPage.evaluate(`(() => {
        var frame = document.getElementById('slideFrame');
        var placeholder = document.getElementById('slidePlaceholder');
        var nav = document.getElementById('slideNav');
        if (!frame) return false;
        frame.src = ${JSON.stringify(url)};
        if (placeholder) placeholder.style.display = 'none';
        if (nav) nav.style.display = '';
        return true;
      })()`);
      console.log(`[ChromeLauncher] Loaded slide frame: ${url}`);
      return true;
    } catch (e: any) {
      console.warn("[ChromeLauncher] loadSlideFrame failed:", e.message);
      return false;
    }
  }

  /** Execute JavaScript inside the stage iframe's document (same-origin only) */
  async evaluateOnSlideFrame(code: string): Promise<any> {
    if (!this._presentingPage || !this._isOnStage()) return null;
    try {
      return await this._presentingPage.evaluate(`(() => {
        var doc = document.getElementById('slideFrame')?.contentDocument;
        if (!doc) return null;
        return (function() { ${code} }).call(doc);
      })()`);
    } catch (e: any) {
      console.warn("[ChromeLauncher] evaluateOnSlideFrame failed:", e.message);
      return null;
    }
  }

  /** Click element inside the stage iframe by CSS selector */
  async clickOnSlideFrame(selector: string): Promise<boolean> {
    if (!this._presentingPage || !this._isOnStage()) return false;
    try {
      const result = await this._presentingPage.evaluate(`(() => {
        var doc = document.getElementById('slideFrame')?.contentDocument;
        if (!doc) return 'no_doc';
        var el = doc.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not_found';
        el.click();
        return 'clicked';
      })()`);
      return result === "clicked";
    } catch (e: any) {
      console.warn(`[ChromeLauncher] clickOnSlideFrame failed: ${selector}`, e.message);
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Google Account Check
  // ══════════════════════════════════════════════════════════════

  /**
   * Check if the Chrome profile is signed into a Google account.
   * Navigates to myaccount.google.com and checks for signed-in indicators.
   */
  async checkGoogleLogin(): Promise<{ loggedIn: boolean; email: string | null }> {
    if (!this._page) return { loggedIn: false, email: null };

    // Return cached result if checked within 10 minutes
    if (this._googleLoginCache && Date.now() - this._googleLoginCache.checkedAt < 600000) {
      return { loggedIn: this._googleLoginCache.loggedIn, email: this._googleLoginCache.email };
    }

    const page = this._page;
    const context = this._context;

    try {
      // FAST PATH: check Google cookies via browser context (no page navigation needed!)
      // Google sets cookies on .google.com when signed in (SID, HSID, SSID, etc.)
      if (context) {
        const cookies = await context.cookies("https://accounts.google.com");
        const hasSID = cookies.some((c: any) => c.name === "SID" || c.name === "HSID" || c.name === "SSID");
        if (hasSID) {
          // Extract email from SAPISID or other cookies if possible
          const lsid = cookies.find((c: any) => c.name === "LSID");
          const result = { loggedIn: true, email: null as string | null };
          this._googleLoginCache = { ...result, checkedAt: Date.now() };
          console.log("[ChromeLauncher] Google login check: logged in (cookie check, fast)");
          return result;
        }
        // No Google session cookies → not logged in
        const result = { loggedIn: false, email: null };
        this._googleLoginCache = { ...result, checkedAt: Date.now() };
        return result;
      }

      // SLOW FALLBACK: navigate to myaccount.google.com (only if context.cookies unavailable)
      const currentUrl = page.url();
      await page.goto("https://myaccount.google.com", { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(2000);

      const evalResult = await page.evaluate(`(() => {
        if (location.hostname === 'accounts.google.com' && location.pathname.includes('/signin')) {
          return JSON.stringify({ loggedIn: false, email: null });
        }
        if (location.hostname === 'myaccount.google.com') {
          var emailEl = document.querySelector('[data-email]');
          var email = emailEl ? emailEl.getAttribute('data-email') : null;
          if (!email) {
            var profileBtn = document.querySelector('[aria-label*="@"]');
            if (profileBtn) {
              var match = profileBtn.getAttribute('aria-label').match(/[\\w.-]+@[\\w.-]+/);
              if (match) email = match[0];
            }
          }
          return JSON.stringify({ loggedIn: true, email: email });
        }
        return JSON.stringify({ loggedIn: false, email: null });
      })()`);

      const parsed = JSON.parse(String(evalResult));
      this._googleLoginCache = { loggedIn: parsed.loggedIn, email: parsed.email, checkedAt: Date.now() };

      if (currentUrl && currentUrl !== "about:blank" && !currentUrl.includes("google.com")) {
        await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      }

      return parsed;
    } catch (e: any) {
      console.warn("[ChromeLauncher] Google login check failed:", e.message);
      return { loggedIn: false, email: null };
    }
  }

  /** Clear the Google login cache (e.g. after user signs in) */
  clearGoogleLoginCache(): void {
    this._googleLoginCache = null;
  }

  /**
   * Launch a standalone Playwright browser for presentation test mode.
   * Creates a browser context WITHOUT joining Google Meet — just a plain Chrome window.
   * After calling this, navigatePresentingPage() / evaluateOnPresentingPage() work normally.
   */
  async launchStandalone(): Promise<void> {
    if (this._context) {
      console.log("[ChromeLauncher] Already launched, reusing for standalone");
      return;
    }
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      // --disable-blink-features=AutomationControlled omitted (triggers infobar);
      // navigator.webdriver hidden via WEBDRIVER_STEALTH_SCRIPT instead.
      args: ["--no-sandbox", "--disable-web-security"],
      viewport: { width: 1280, height: 900 },
      bypassCSP: true,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    await context.addInitScript(WEBDRIVER_STEALTH_SCRIPT);
    this._context = context;
    this._page = context.pages()[0] || await context.newPage();
    console.log("[ChromeLauncher] Standalone browser launched");
  }

  /** Clean shutdown */
  async close(): Promise<void> {
    this.stopAudioHealthMonitor();
    if (this._context) {
      this._intentionalContextClose = true; // suppress crash-detection callback
      await this._context.close().catch(() => {});
      this._context = null;
      this._page = null;
      console.log("[ChromeLauncher] Chrome closed");
    }
  }

  get debuggingPort(): number { return this.port; }
  get page(): any { return this._page; }
  get context(): any { return this._context; }

  /**
   * Import Google cookies from the user's main Chrome profile into the CallingClaw profile.
   * Copies the Cookies SQLite DB rows for google.com domains.
   * Only runs if: (a) main Chrome profile exists, (b) CallingClaw profile has no Google cookies yet.
   */
  private async importGoogleCookies(): Promise<void> {
    const srcCookies = resolve(MAIN_CHROME_PROFILE, "Default", "Cookies");
    const dstDir = resolve(this.profileDir, "Default");
    const dstCookies = resolve(dstDir, "Cookies");

    // Skip if main Chrome doesn't exist
    if (!existsSync(srcCookies)) {
      console.log("[ChromeLauncher] No main Chrome profile found — skipping cookie import");
      return;
    }

    // Skip if CallingClaw already has cookies (don't overwrite)
    if (existsSync(dstCookies)) {
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dstCookies, { readonly: true });
        const count = db.query("SELECT COUNT(*) as c FROM cookies WHERE host_key LIKE '%google.com%'").get() as any;
        db.close();
        if (count?.c > 0) {
          console.log(`[ChromeLauncher] CallingClaw profile already has ${count.c} Google cookies — skipping import`);
          return;
        }
      } catch {}
    }

    // Copy Google cookies from main Chrome → CallingClaw profile
    try {
      mkdirSync(dstDir, { recursive: true });

      // Chrome encrypts cookies with Keychain on macOS. We can't decrypt them directly.
      // Instead, copy the ENTIRE Cookies file (it's SQLite, ~50KB).
      // This works because both profiles use the same macOS Keychain for decryption.
      const { copyFileSync } = await import("fs");
      copyFileSync(srcCookies, dstCookies);
      console.log("[ChromeLauncher] Imported cookies from main Chrome profile");
    } catch (e: any) {
      console.warn("[ChromeLauncher] Cookie import failed:", e.message);
    }
  }

  /**
   * Clear saved audio device preferences from Chrome profile.
   * Prevents Meet from selecting BlackHole (removed in v2.7.12) as mic/speaker.
   * Sets to empty string = system default device.
   */
  private clearAudioDevicePrefs(): void {
    const prefsPath = resolve(this.profileDir, "Default", "Preferences");
    const fs = require("fs");
    try {
      // Create Default directory + minimal Preferences if it doesn't exist (first launch)
      const defaultDir = resolve(this.profileDir, "Default");
      if (!existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      const prefs = existsSync(prefsPath)
        ? JSON.parse(fs.readFileSync(prefsPath, "utf-8"))
        : {};
      let changed = false;

      // Clear default audio devices → system default (prevents BlackHole from being cached)
      if (!prefs.media) prefs.media = {};
      if (prefs.media.default_audio_capture_device !== "") {
        prefs.media.default_audio_capture_device = "";
        changed = true;
      }
      if (prefs.media.default_audio_render_device !== "") {
        prefs.media.default_audio_render_device = "";
        changed = true;
      }

      // Suppress session restore — prevents blank tabs from previous session
      if (!prefs.session) prefs.session = {};
      if (prefs.session.restore_on_startup !== 5) {  // 5 = don't restore
        prefs.session.restore_on_startup = 5;
        changed = true;
      }
      // Also clear startup URLs to prevent blank tab restoration
      if (!prefs.session.startup_urls) prefs.session.startup_urls = [];
      if (prefs.session.startup_urls.length > 0) {
        prefs.session.startup_urls = [];
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        console.log("[ChromeLauncher] Cleared audio device prefs + session restore (reset to system default)");
      }
    } catch (e: any) {
      console.warn(`[ChromeLauncher] clearAudioDevicePrefs failed: ${e.message}`);
    }
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data() {},
          open(socket) { socket.end(); },
        },
      });
      const port = server.port;
      server.stop();
      resolve(port);
    });
  }
}
