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

// Default: use the user's main Chrome profile so Google account / cookies are available.
// On macOS this is ~/Library/Application Support/Google/Chrome.
// Falls back to ~/.callingclaw/browser-profile if the main profile doesn't exist.
const CHROME_PROFILE = resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
const FALLBACK_PROFILE = resolve(homedir(), ".callingclaw", "browser-profile");
const DEFAULT_PROFILE = existsSync(CHROME_PROFILE) ? CHROME_PROFILE : FALLBACK_PROFILE;
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
    aiSpeaking: false,
    aiSpeakingTimer: null,
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
  // Cycles through audio receivers by index. If amp=0 after 5s,
  // disconnects and tries the NEXT receiver (not the same one).
  function setupCapture(pc) {
    if (cc.captureActive) return;
    var receivers = pc.getReceivers();
    var audioRecvs = receivers.filter(function(r) { return r.track && r.track.kind === 'audio' && r.track.readyState === 'live'; });
    if (audioRecvs.length === 0) return;

    // Sort: prefer unmuted first, then by index
    audioRecvs.sort(function(a, b) { return (a.track.muted ? 1 : 0) - (b.track.muted ? 1 : 0); });

    // Pick receiver at current triedReceiverIdx (wraps around)
    var idx = cc.triedReceiverIdx % audioRecvs.length;
    var audioRecv = audioRecvs[idx];
    var track = audioRecv.track;

    console.log('[CC-Audio] Trying receiver ' + idx + '/' + audioRecvs.length + ' (track: ' + track.id.substring(0, 10) + ', muted=' + track.muted + ')');

    // Disconnect previous capture if any
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

      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // ── Echo cancellation: suppress mic during AI playback ──
      // When AI is speaking, the captured remote audio includes the AI's own voice
      // (Meet mixes all streams). Sending this back would cause: AI hears echo →
      // VAD triggers → self-interrupt → repeat. Suppress for 500ms after last AI audio.
      if (cc.aiSpeaking) return;

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

    // Track mute/unmute events
    track.onmute = function() { console.log('[CC-Audio] Track MUTED → will retry next receiver'); };
    track.onunmute = function() { console.log('[CC-Audio] Track UNMUTED'); };

    // Self-check: if maxAmp stays 0 after 5s, disconnect and try NEXT receiver
    setTimeout(function() {
      if (cc.captureMaxAmp === 0 && cc.captureChunks > 50) {
        console.log('[CC-Audio] Self-check FAILED: amp=0 on receiver ' + idx + ', cycling to next...');
        try { source.disconnect(); } catch(e) {}
        try { worklet.disconnect(); } catch(e) {}
        cc.captureActive = false;
        cc.triedReceiverIdx++;
        setupCapture(pc);
      } else if (cc.captureMaxAmp > 0) {
        console.log('[CC-Audio] Self-check PASSED: maxAmp=' + cc.captureMaxAmp + ' on receiver ' + idx);
      }
    }, 5000);

    cc.captureActive = true;
    console.log('[CC-Audio] Capture active (receiver ' + idx + ', track: ' + track.id.substring(0, 10) + ', muted=' + track.muted + ')');
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
          // ── Echo cancellation: mark AI as speaking ──
          // Suppress captured audio during playback + 500ms tail guard
          cc.aiSpeaking = true;
          if (cc.aiSpeakingTimer) clearTimeout(cc.aiSpeakingTimer);
          cc.aiSpeakingTimer = setTimeout(function() { cc.aiSpeaking = false; }, 500);

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
          cc.aiSpeaking = false;
          if (cc.aiSpeakingTimer) { clearTimeout(cc.aiSpeakingTimer); cc.aiSpeakingTimer = null; }
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
    // If already launched, return existing port
    if (this._context && this._page) {
      console.log(`[ChromeLauncher] Already launched (port=${this.port}), reusing`);
      return { port: this.port };
    }

    // Dynamic import to avoid loading playwright-core at module level
    const { chromium } = await import("playwright-core");

    // If using the user's main Chrome profile, we must close existing Chrome first
    // (Chrome only allows one instance per profile)
    const isMainChromeProfile = this.profileDir.includes("Google/Chrome");
    if (isMainChromeProfile) {
      try {
        const { execSync } = await import("child_process");
        // Check if Chrome is running
        const ps = execSync("pgrep -x 'Google Chrome' 2>/dev/null || true", { encoding: "utf8" }).trim();
        if (ps) {
          console.log("[ChromeLauncher] Closing existing Chrome (need exclusive profile access)...");
          execSync("osascript -e 'tell application \"Google Chrome\" to quit' 2>/dev/null || true");
          await new Promise(r => setTimeout(r, 2000)); // Wait for graceful quit
        }
      } catch {}
    }

    // Clean up stale locks (prevents profile lock conflict)
    const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of locks) {
      const p = resolve(this.profileDir, lock);
      if (existsSync(p)) try { rmSync(p); } catch {}
    }

    // Only clear crash state for CallingClaw-specific profiles (NOT user's main Chrome)
    if (!isMainChromeProfile) {
      const crashFiles = ["Last Session", "Last Tabs", "Current Session", "Current Tabs"];
      for (const f of crashFiles) {
        const p = resolve(this.profileDir, f);
        if (existsSync(p)) try { rmSync(p); } catch {}
      }
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
        "--disable-session-crashed-bubble",      // Suppress "profile error" dialog
        "--hide-crash-restore-bubble",            // Suppress "restore pages" bar
        "--noerrdialogs",                         // Suppress error dialogs
        `--remote-debugging-port=${port}`,
      ],
      permissions: ["microphone", "camera"],
      ignoreDefaultArgs: ["--mute-audio", "--enable-automation", "--no-sandbox"],
    });

    // Install the audio injection init script
    await context.addInitScript(AUDIO_INIT_SCRIPT);
    console.log("[ChromeLauncher] Init script installed (getUserMedia + RTC interception)");

    // Use first page (close any extras Chrome opened from previous session)
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    // Close extra tabs that Chrome may have restored
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close(); } catch {}
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

        if (document.querySelector('[aria-label*="Leave call"]') || document.querySelector('[aria-label="Call controls"]')) {
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
        var joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入'];
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
            if (['Join now','Ask to join','Join','加入会议','请求加入'].indexOf(btns[i].textContent.trim()) !== -1) return 'found';
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
          var joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入'];
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

      // Step 4: Verify join state (poll up to 20s)
      log("Verifying join state...");
      await page.waitForTimeout(2000);

      for (let attempt = 0; attempt < 6; attempt++) {
        const state = await page.evaluate(`(() => {
          if (document.querySelector('[aria-label*="Leave call"]') || document.querySelector('[aria-label="Call controls"]')) return 'in_meeting';
          var t = document.body.innerText;
          if (t.includes('Waiting for the host') || t.includes('Someone will let you in') || t.includes('等待主持人')) return 'waiting_room';
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
        return t === 'Admit' || t === '准许';
      });
      if (admit) { admit.click(); return 'admitted:' + admit.textContent.trim().substring(0, 60); }

      // Step B2: "Admit all" fallback
      var admitAll = all.find(function(b) {
        var t = (b.textContent || '').trim();
        return t === 'Admit all' || t === '全部准许';
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
