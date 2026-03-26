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

const DEFAULT_PROFILE = resolve(homedir(), ".callingclaw", "browser-profile");
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

  var PB_CODE = 'class P extends AudioWorkletProcessor{constructor(){super();this._b=new Float32Array(24000*10);this._w=0;this._r=0;this.port.onmessage=e=>{if(e.data==="clear"){this._w=0;this._r=0;return}var s=e.data;for(var i=0;i<s.length;i++){this._b[this._w%this._b.length]=s[i];this._w++}}}process(i,o){var out=o[0][0];if(!out)return true;for(var i=0;i<out.length;i++){if(this._r<this._w){out[i]=this._b[this._r%this._b.length];this._r++}else out[i]=0}return true}}registerProcessor("playback-processor",P);';
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
  function setupCapture(pc) {
    if (cc.captureActive) return;
    var receivers = pc.getReceivers();
    var audioRecv = receivers.find(function(r) { return r.track && r.track.kind === 'audio' && !r.track.muted && r.track.readyState === 'live'; })
      || receivers.find(function(r) { return r.track && r.track.kind === 'audio' && r.track.readyState === 'live'; });
    if (!audioRecv) return;

    var track = audioRecv.track;
    var stream = new MediaStream([track]);
    var source = captureCtx.createMediaStreamSource(stream);
    var worklet = new AudioWorkletNode(captureCtx, 'pcm-processor');
    source.connect(worklet);

    worklet.port.onmessage = function(e) {
      cc.captureChunks++;
      var int16 = e.data;
      var maxAmp = 0;
      for (var i = 0; i < int16.length; i++) { var a = Math.abs(int16[i]); if (a > maxAmp) maxAmp = a; }
      if (maxAmp > cc.captureMaxAmp) cc.captureMaxAmp = maxAmp;

      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Downsample to 24kHz if needed
      if (captureRate !== SAMPLE_RATE && captureRate > SAMPLE_RATE) {
        var ratio = captureRate / SAMPLE_RATE;
        var newLen = Math.round(int16.length / ratio);
        var resampled = new Int16Array(newLen);
        for (var j = 0; j < newLen; j++) resampled[j] = int16[Math.round(j * ratio)] || 0;
        int16 = resampled;
      }
      ws.send(JSON.stringify({ type: 'audio', audio: audioToBase64(int16) }));
    };

    // Self-check: if maxAmp stays 0 after 5s, try next receiver
    setTimeout(function() {
      if (cc.captureMaxAmp === 0 && cc.captureChunks > 100) {
        console.log('[CC-Audio] Self-check: maxAmp=0, re-scanning receivers...');
        cc.captureActive = false;
        cc.captureChunks = 0;
        setupCapture(pc);
      }
    }, 5000);

    cc.captureActive = true;
    console.log('[CC-Audio] Capture active (track: ' + track.id.substring(0, 10) + ', muted=' + track.muted + ')');
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

  // Also listen for future track events on all PCs
  for (var i = 0; i < cc.pcs.length; i++) {
    cc.pcs[i].addEventListener('track', function() {
      var pc = this;
      setTimeout(function() { if (!cc.captureActive) setupCapture(pc); }, 500);
    });
  }

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
    // Dynamic import to avoid loading playwright-core at module level
    const { chromium } = await import("playwright-core");

    // Clean up stale locks
    const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of locks) {
      const p = resolve(this.profileDir, lock);
      if (existsSync(p)) try { rmSync(p); } catch {}
    }

    // Ensure profile dir exists
    mkdirSync(this.profileDir, { recursive: true });

    // Find a free port
    const port = await this.findFreePort();
    this.port = port;

    console.log(`[ChromeLauncher] Starting Chrome (port=${port}, profile=${this.profileDir})...`);

    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      channel: "chrome",
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-infobars",
        "--disable-blink-features=AutomationControlled",
        `--remote-debugging-port=${port}`,
      ],
      permissions: ["microphone", "camera"],
      ignoreDefaultArgs: ["--mute-audio", "--enable-automation"],
    });

    // Install the audio injection init script
    await context.addInitScript(AUDIO_INIT_SCRIPT);
    console.log("[ChromeLauncher] Init script installed (getUserMedia + RTC interception)");

    // Navigate to about:blank to ensure Chrome is ready
    const page = context.pages()[0] || await context.newPage();
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
