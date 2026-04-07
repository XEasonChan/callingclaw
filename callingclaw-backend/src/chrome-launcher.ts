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
//     └── WebSocket ws://localhost:4000/ws/voice-test
//           ├── sends: captured meeting audio (PCM16 24kHz base64)
//           └── receives: AI response audio (PCM16 24kHz base64)

import { resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, rmSync } from "fs";
import { CONFIG } from "./config";

// Always use dedicated CallingClaw profile (lightweight, fast startup).
// Google cookies are imported from the user's main Chrome on first launch.
// Using the main Chrome profile directly causes hangs (huge profile, tab restore).
const DEFAULT_PROFILE = resolve(process.env.CALLINGCLAW_HOME || resolve(homedir(), ".callingclaw"), "browser-profile");
const MAIN_CHROME_PROFILE = resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
const DEFAULT_PORT = 0; // 0 = random free port

// ── Audio injection init script ──────────────────────────────────
// This runs BEFORE any page JavaScript, intercepting getUserMedia
// and wrapping RTCPeerConnection so audio injection works.

const AUDIO_INIT_SCRIPT = `
(function() {
  // Skip non-Meet pages
  if (!location.hostname.includes('meet.google.com') && location.hostname !== 'about:blank') return;

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

  // ── Wrap RTCPeerConnection ──
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
})();
`;

// ── Audio pipeline script (injected via evaluate after page loads) ──
// This connects the intercepted audio to the CallingClaw backend via WebSocket.

const AUDIO_PIPELINE_SCRIPT = `(async function() {
  var cc = window.__cc;
  if (!cc || !cc.outputDest) { console.log('[CC-Audio] No init state'); return 'no_init'; }

  var BACKEND_WS = 'ws://localhost:4000/ws/voice-test';
  var SAMPLE_RATE = 24000;

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
  function setupCapture(pc) {
    if (cc.captureActive) return;
    var receivers = pc.getReceivers();
    var audioRecvs = receivers.filter(function(r) { return r.track && r.track.kind === 'audio' && r.track.readyState === 'live'; });
    if (audioRecvs.length === 0) return;

    // Prefer unmuted receiver
    var audioRecv = audioRecvs.find(function(r) { return !r.track.muted; }) || audioRecvs[0];
    var track = audioRecv.track;

    console.log('[CC-Audio] Receivers: ' + audioRecvs.length + ', using: ' + track.id.substring(0, 10) + ' muted=' + track.muted);

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
      // Log every 50th chunk (~5s)
      if (cc.captureChunks % 50 === 1) {
        console.log('[CC-Audio] chunk#' + cc.captureChunks + ' maxAmp=' + maxAmp + ' peak=' + cc.captureMaxAmp);
      }
      // NO echo suppression — send ALL audio, let server VAD handle it
      sendAudioChunk(int16);
    };

    track.onmute = function() { console.log('[CC-Audio] Track MUTED'); };
    track.onunmute = function() { console.log('[CC-Audio] Track UNMUTED'); };
    track.onended = function() { console.log('[CC-Audio] Track ENDED — will retry'); cc.captureActive = false; };

    cc.captureActive = true;
    console.log('[CC-Audio] Pipeline A active (track: ' + track.id.substring(0, 10) + ')');
  }

  // ── WebSocket to backend ──
  var ws = null;
  function connectWS() {
    ws = new WebSocket(BACKEND_WS);
    ws.onopen = function() {
      console.log('[CC-Audio] WS connected');
      ws.send(JSON.stringify({ type: 'start', provider: undefined }));
    };
    ws.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'audio' && data.audio) {
          // ── Echo suppression: mark AI as speaking ──
          cc.isPlaying = true;
          if (cc._playingTimer) clearTimeout(cc._playingTimer);
          // Tail guard: keep suppression for 500ms after last audio chunk
          // to catch echo propagation delay through Meet's SFU
          cc._playingTimer = setTimeout(function() { cc.isPlaying = false; }, 500);

          var raw = atob(data.audio);
          var bytes = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          var pcm16 = new Int16Array(bytes.buffer);
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
    ws.onclose = function() { setTimeout(connectWS, 3000); };
  }
  connectWS();

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
  };

  return 'pipeline_ready';
})()`;

// ── ChromeLauncher class ─────────────────────────────────────────

export class ChromeLauncher {
  private port: number = 0;
  private profileDir: string;
  private _context: any = null;
  private _page: any = null;
  private _googleLoginCache: { loggedIn: boolean; email: string | null; checkedAt: number } | null = null;

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
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-infobars",
        "--disable-blink-features=AutomationControlled",
        "--disable-session-crashed-bubble",      // Suppress "profile error" dialog
        "--hide-crash-restore-bubble",            // Suppress "restore pages" bar
        "--noerrdialogs",                         // Suppress error dialogs
        "--restore-last-session=false",             // Don't restore previous session tabs
        "--auto-select-desktop-capture-source=Entire screen",  // Share entire screen (supports multi-tab switching)
        "--enable-usermedia-screen-capturing",    // Enable screen capture API
        "--start-maximized",                      // Start Chrome maximized for presentation
        `--remote-debugging-port=${port}`,
      ],
      permissions: ["microphone", "camera"],
      ignoreDefaultArgs: ["--mute-audio", "--enable-automation", "--no-sandbox"],
    });

    // Install the audio injection init script
    await context.addInitScript(AUDIO_INIT_SCRIPT);
    console.log("[ChromeLauncher] Init script installed (getUserMedia + RTC interception)");

    // Use first page (close ALL extras Chrome opened from previous session)
    // Aggressive cleanup: close every page except the one we keep, then navigate to blank
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    if (pages.length > 1) {
      console.log(`[ChromeLauncher] Closing ${pages.length - 1} extra tabs from previous session`);
      for (let i = pages.length - 1; i >= 1; i--) {
        try { await pages[i].close(); } catch {}
      }
    }
    await page.goto("about:blank");

    // Verify init script works
    const check = await page.evaluate(() => !!(window as any).__cc);
    if (!check) {
      console.warn("[ChromeLauncher] Init script verification failed on about:blank");
    }

    // Keep the context alive — Chrome must stay open for playwright-cli to connect.
    // Store the context so it can be cleaned up later, but don't close it.
    // The init script persists in Chrome as long as the browser is open.
    this._context = context;
    this._page = page;

    console.log(`[ChromeLauncher] Chrome ready on port ${port}. playwright-cli can connect now.`);
    return { port };
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
        wsState: p && p.ws() ? p.ws().readyState : -1,
      });
    })()`;
  }

  /** Activate the audio pipeline on the current page (call after joining a meeting) */
  async activateAudioPipeline(): Promise<string> {
    if (!this._page) return "no_page";
    try {
      const result = await this._page.evaluate(AUDIO_PIPELINE_SCRIPT);
      console.log("[ChromeLauncher] Audio pipeline activated:", result);
      return result;
    } catch (e: any) {
      console.warn("[ChromeLauncher] Audio pipeline activation failed:", e.message);
      return "error: " + e.message;
    }
  }

  /** Get audio injection status from the page */
  async getStatus(): Promise<any> {
    if (!this._page) return { error: "no_page" };
    try {
      const raw = await this._page.evaluate(`(function() {
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
          wsState: p && p.ws() ? p.ws().readyState : -1,
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

  /**
   * Join a Google Meet meeting using the Playwright library page directly.
   * Eliminates playwright-cli coexistence conflict (launchPersistentContext holds Chrome).
   */
  async joinGoogleMeet(
    url: string,
    opts?: {
      displayName?: string;
      muteCamera?: boolean;
      muteMic?: boolean;
      onStep?: (step: string) => void;
    },
  ): Promise<{ success: boolean; summary: string; steps: string[]; state: "in_meeting" | "waiting_room" | "failed" }> {
    if (!this._page) return { success: false, summary: "No page — call launch() first", steps: [], state: "failed" };

    const page = this._page;
    const displayName = opts?.displayName || "CallingClaw";
    const muteCamera = opts?.muteCamera ?? true;
    const muteMic = opts?.muteMic ?? false;
    const steps: string[] = [];
    const log = (msg: string) => { steps.push(msg); opts?.onStep?.(msg); console.log(`[MeetJoin] ${msg}`); };

    try {
      // Step 1: Navigate
      log("Navigating...");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

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
        var body = document.body.innerText || '';
        var btns = Array.from(document.querySelectorAll('button'));
        var btnTexts = btns.map(function(b) { return b.textContent.trim(); });

        if (document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"], [aria-label*="離開通話"]') || document.querySelector('[aria-label="Call controls"], [aria-label="通话控件"]')) {
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

        // 4. Camera OFF
        ${muteCamera ? `
        var camOff = document.querySelector('[aria-label="Turn off camera"], [aria-label="关闭摄像头"]');
        if (camOff) { camOff.click(); R.config.push('cam:off'); }
        else R.config.push('cam:already_off');
        ` : `R.config.push('cam:skip');`}

        // 5. Mic
        ${muteMic ? `
        var micOff = document.querySelector('[aria-label="Turn off microphone"], [aria-label="关闭麦克风"]');
        if (micOff) { micOff.click(); R.config.push('mic:muted'); }
        ` : `
        var micOn = document.querySelector('[aria-label="Turn on microphone"], [aria-label="打开麦克风"]');
        if (micOn) { micOn.click(); R.config.push('mic:on'); }
        else R.config.push('mic:already_on');
        `}

        // 6. Set display name
        var nameInput = document.querySelector('input[aria-label="Your name"], input[placeholder*="name"]');
        if (nameInput && (!nameInput.value || nameInput.value === 'Guest')) {
          var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (s && s.set) { s.set.call(nameInput, ${JSON.stringify(displayName)}); nameInput.dispatchEvent(new Event('input', {bubbles:true})); R.config.push('name:set'); }
        }

        // 7. Check if join button exists
        var joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入', '立即加入'];
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
        log("Page loading — retrying in 2s...");
        await page.waitForTimeout(2000);
        const retry = await page.evaluate(`(() => {
          var btns = Array.from(document.querySelectorAll('button'));
          for (var i = 0; i < btns.length; i++) {
            if (['Join now','Ask to join','Join','加入会议','请求加入','立即加入'].indexOf(btns[i].textContent.trim()) !== -1) return 'found';
          }
          return 'still_no_button';
        })()`);
        log(`Retry: ${retry}`);
        if (String(retry).includes("still_no_button")) {
          return { success: false, summary: "Join button not found after retry", steps, state: "failed" };
        }
      }

      // Step 3: Click join button
      if (parsed.state !== "switch_here") {
        log("Clicking join...");
        const joinResult = await page.evaluate(`(() => {
          var btns = Array.from(document.querySelectorAll('button'));
          var joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入', '立即加入'];
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
        const state = await page.evaluate(`(() => {
          // Language-agnostic: check for call_end icon (Material icon), any leave button, or control bar
          var leaveBtn = document.querySelector('[aria-label*="Leave"],[aria-label*="退出"],[aria-label*="離開"]');
          var callEnd = document.querySelector('[aria-label*="call_end"],[aria-label*="Call controls"],[aria-label*="通话控件"]');
          // Also check: does the page have a bottom control bar with mic/camera buttons?
          var micBtn = document.querySelector('[aria-label*="microphone"],[aria-label*="麦克风"]');
          var camBtn = document.querySelector('[aria-label*="camera"],[aria-label*="摄像头"],[aria-label*="Turn on camera"],[aria-label*="Turn off camera"]');
          var hasControls = micBtn && camBtn;
          if (leaveBtn || callEnd || hasControls) return 'in_meeting';
          var t = document.body.innerText;
          if (t.includes('Waiting for the host') || t.includes('Someone will let you in') || t.includes('等待主持人') || t.includes('等待主办人')) return 'waiting_room';
          return 'loading';
        })()`);

        if (String(state).includes("in_meeting")) {
          log("Joined!");

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

  // ══════════════════════════════════════════════════════════════
  // Admission Monitor (replaces playwright-cli admission monitor)
  // ══════════════════════════════════════════════════════════════

  private _admissionInterval: ReturnType<typeof setInterval> | null = null;
  private _admittedSet = new Set<string>();
  private _meetingEndCallback: (() => void) | null = null;

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
        // Check if meeting has ended
        if (this._meetingEndCallback) {
          try {
            const ended = await this._checkMeetingEndedLib();
            if (ended) {
              console.log("[MeetAdmit] Meeting ended detected — triggering cleanup");
              const cb = this._meetingEndCallback;
              this._meetingEndCallback = null;
              this.stopAdmissionMonitor();
              cb();
              return;
            }
          } catch {}
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
      if (!location.hostname.includes('meet.google.com')) return 'ended';
      var leaveBtn = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"], [aria-label*="離開通話"]');
      var callControls = document.querySelector('[aria-label="Call controls"], [aria-label="通话控件"]');
      var text = document.body.innerText || '';
      var endedSignals = [
        'This meeting has ended', '会议已结束', '會議已結束',
        'You were removed from the meeting', '您已被移出会议',
        'Your meeting code has expired', '会议代码已过期',
        'Return to home screen', '返回主屏幕',
        'The meeting has ended for everyone', '所有人的会议已结束',
        'You left the meeting', '你已退出会议', '您已離開會議',
        'Rejoin', '重新加入',
      ];
      var hasEndedText = endedSignals.some(function(s) { return text.includes(s); });
      if (hasEndedText) return 'ended';
      var videoGrid = document.querySelector('[data-allocation-index], [data-requested-participant-id]');
      if (!leaveBtn && !callControls && !videoGrid) return 'ended';
      return 'active';
    })()`);
    return result === "ended";
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
    const admitted = [...this._admittedSet];
    console.log(`[MeetAdmit] Monitor stopped. Admitted ${admitted.length} attendees.`);
    return admitted;
  }

  get isAdmissionMonitoring(): boolean {
    return this._admissionInterval !== null;
  }

  onMeetingEnd(callback: () => void): void {
    this._meetingEndCallback = callback;
    if (!this._admissionInterval) {
      console.log("[MeetEnd] Starting standalone meeting-end watcher (3s interval)");
      this._admissionInterval = setInterval(async () => {
        try {
          const ended = await this._checkMeetingEndedLib();
          if (ended) {
            console.log("[MeetEnd] Meeting ended detected — triggering cleanup");
            const cb = this._meetingEndCallback;
            this._meetingEndCallback = null;
            this.stopAdmissionMonitor();
            if (cb) cb();
          }
        } catch {}
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

    try {
      const left = await page.evaluate(() => {
        // Find the Leave/Hangup button
        const selectors = [
          '[aria-label*="Leave call"]',
          '[aria-label*="退出通话"]',
          '[aria-label*="離開通話"]',
          '[data-tooltip*="Leave call"]',
          '[data-tooltip*="退出通话"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      });

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
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Screen Sharing (Meet "Present now")
  // ══════════════════════════════════════════════════════════════

  // The presenting tab — kept alive for screen sharing
  private _presentingPage: any = null;

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
        // Close previous presenting tab if any
        if (this._presentingPage) {
          try { await this._presentingPage.close(); } catch {}
        }
        this._presentingPage = await this._context.newPage();
        await this._presentingPage.goto(presentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        // Rename tab title to match Chrome's auto-select flag
        await this._presentingPage.evaluate(`document.title = "CallingClaw Presenting"`);
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
      // Close presenting tab
      if (this._presentingPage) {
        try { await this._presentingPage.close(); } catch {}
        this._presentingPage = null;
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
    if (!this._presentingPage) {
      // Create presenting page if it doesn't exist
      if (this._context) {
        this._presentingPage = await this._context.newPage();
      } else return false;
    }
    try {
      await this._presentingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await this._presentingPage.evaluate(`document.title = "CallingClaw Presenting"`);
      return true;
    } catch (e: any) {
      console.warn("[ChromeLauncher] Presenting page navigate failed:", e.message);
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
      args: ["--no-sandbox", "--disable-web-security", "--disable-blink-features=AutomationControlled"],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--enable-automation"],
    });
    this._context = context;
    this._page = context.pages()[0] || await context.newPage();
    console.log("[ChromeLauncher] Standalone browser launched");
  }

  /** Clean shutdown */
  async close(): Promise<void> {
    if (this._context) {
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
