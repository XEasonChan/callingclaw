/**
 * Audio Injection + Grok Realtime — Full E2E Test
 *
 * Combines the verified getUserMedia interception with CallingClaw's
 * voice pipeline. AI speaks in the meeting, participants hear AI.
 *
 * Audio flow:
 *   Meet remote audio → RTCPeerConnection ontrack → AudioWorklet
 *     → PCM16 24kHz → WebSocket → Backend → Grok Realtime API
 *     → AI audio → WebSocket → Ring buffer worklet
 *     → MediaStreamDestination → getUserMedia interception
 *     → Meet broadcasts AI voice to all participants
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx bun run test/test-audio-inject-grok.ts
 */

import { chromium } from "../callingclaw-backend/node_modules/playwright-core";
import { resolve } from "path";
import { homedir } from "os";

const MEET_URL = process.env.MEET_URL || "https://meet.google.com/arf-acrx-rag";
const PROFILE = resolve(homedir(), ".callingclaw", "browser-profile");
const BACKEND_WS = "ws://localhost:4000/ws/voice-test";
const BACKEND_HTTP = "http://localhost:4000";

async function main() {
  console.log("═══ CallingClaw — Grok Realtime + Audio Injection ═══");
  console.log(`Meet: ${MEET_URL}`);

  // Verify backend is running
  try {
    const status = await fetch(`${BACKEND_HTTP}/api/status`).then(r => r.json());
    console.log(`Backend: ${status.callingclaw} v${status.version}`);
  } catch {
    console.error("❌ Backend not running! Start with: cd callingclaw-backend && bun --hot run src/callingclaw.ts");
    process.exit(1);
  }

  // Kill any existing Chrome
  await Bun.$`pkill -f "Google Chrome" 2>/dev/null; sleep 1`.quiet().nothrow();
  await Bun.$`rm -f ${PROFILE}/SingletonLock ${PROFILE}/SingletonSocket ${PROFILE}/SingletonCookie 2>/dev/null`.quiet().nothrow();

  console.log("\n[1] Launching Chrome...");
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: "chrome",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
    ],
    permissions: ["microphone", "camera"],
    ignoreDefaultArgs: ["--mute-audio", "--enable-automation"],
  });

  // ── Init Script: intercept getUserMedia + wrap RTCPeerConnection ──
  console.log("[2] Installing init script...");
  await context.addInitScript(() => {
    (window as any).__cc = {
      gumCalls: 0,
      pcs: [] as RTCPeerConnection[],
      outputDest: null as MediaStreamAudioDestinationNode | null,
      outputCtx: null as AudioContext | null,
      outputTrack: null as MediaStreamTrack | null,
    };

    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const OrigPC = window.RTCPeerConnection;

    // Create output audio context + destination (AI audio → Meet mic)
    function ensureOutput() {
      const cc = (window as any).__cc;
      if (cc.outputDest) return;
      cc.outputCtx = new AudioContext({ sampleRate: 24000 });
      cc.outputDest = cc.outputCtx.createMediaStreamDestination();
      cc.outputTrack = cc.outputDest.stream.getAudioTracks()[0];
      console.log("[CC-Init] Output pipeline ready (24kHz MediaStreamDestination)");
    }

    // Intercept getUserMedia
    navigator.mediaDevices.getUserMedia = async function(c?: MediaStreamConstraints) {
      (window as any).__cc.gumCalls++;
      if (c?.audio) {
        ensureOutput();
        console.log("[CC-Init] getUserMedia #" + (window as any).__cc.gumCalls + " → virtual stream");
        return (window as any).__cc.outputDest!.stream.clone();
      }
      return origGUM(c!);
    };

    // Wrap RTCPeerConnection
    (window as any).RTCPeerConnection = function(this: any, ...args: any[]) {
      const pc = new (OrigPC as any)(...args);
      (window as any).__cc.pcs.push(pc);
      console.log("[CC-Init] PeerConnection #" + (window as any).__cc.pcs.length);
      return pc;
    } as any;
    ((window as any).RTCPeerConnection).prototype = OrigPC.prototype;
    Object.getOwnPropertyNames(OrigPC).forEach(k => {
      if (k !== "prototype" && k !== "name" && k !== "length") {
        try { (window as any).RTCPeerConnection[k] = (OrigPC as any)[k]; } catch {}
      }
    });
  });

  const page = context.pages()[0] || await context.newPage();

  // ── Navigate + Join ──
  console.log("[3] Opening Meet...");
  await page.goto(MEET_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const init = await page.evaluate(() => (window as any).__cc?.gumCalls ?? -1);
  console.log(`    getUserMedia calls so far: ${init}`);

  // Dismiss + camera off + join
  await page.evaluate(() => {
    document.querySelectorAll("button,[role=button]").forEach(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      if (["got it","dismiss","not now","block","deny"].some(d => t.includes(d)))
        (b as HTMLElement).click();
    });
    const cam = document.querySelector('[aria-label*="Turn off camera"],[aria-label*="关闭摄像头"]');
    if (cam) (cam as HTMLElement).click();
  });
  await page.waitForTimeout(1000);

  console.log("[4] Joining meeting...");
  const joined = await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (["Join now","Ask to join","Join","加入会议","请求加入"].includes(b.textContent!.trim())) {
        b.click(); return b.textContent!.trim();
      }
    }
    return "no-btn";
  });
  console.log(`    → ${joined}`);

  // Wait for join
  let inMeeting = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    try {
      inMeeting = await page.evaluate(() =>
        !!document.querySelector('[aria-label*="Leave call"],[aria-label="Call controls"]')
      );
      if (inMeeting) break;
      if (i % 3 === 0) console.log(`    waiting... (${i+1}/20)`);
    } catch {
      console.log("    page navigating...");
    }
  }

  if (!inMeeting) {
    console.error("❌ Could not join meeting. Need to be admitted?");
    await page.waitForTimeout(60000); // Wait 1 min for manual admit
    inMeeting = await page.evaluate(() =>
      !!document.querySelector('[aria-label*="Leave call"]')
    ).catch(() => false);
    if (!inMeeting) { await context.close(); return; }
  }

  const state = await page.evaluate(() => ({
    gum: (window as any).__cc.gumCalls,
    pcs: (window as any).__cc.pcs.length,
    pcStates: (window as any).__cc.pcs.map((p: any) => p.connectionState),
  }));
  console.log(`[5] In meeting! gum=${state.gum} pcs=${state.pcs} states=${state.pcStates}`);

  // ── Step 6: Connect audio pipeline (WebSocket → Grok → back) ──
  console.log("[6] Connecting audio pipeline to backend...");

  await page.evaluate(async (config) => {
    const cc = (window as any).__cc;
    const BACKEND_WS = config.wsUrl;
    const BACKEND_HTTP = config.httpUrl;
    const SAMPLE_RATE = 24000;

    // ── Load playback worklet (inline Blob URL — avoids cross-origin restriction) ──
    const outputCtx = cc.outputCtx as AudioContext;
    if (outputCtx.state === "suspended") await outputCtx.resume();

    const PLAYBACK_CODE = `class PlaybackProcessor extends AudioWorkletProcessor{constructor(){super();this._buf=new Float32Array(24000*10);this._w=0;this._r=0;this.port.onmessage=e=>{if(e.data==="clear"){this._w=0;this._r=0;return}var s=e.data;for(var i=0;i<s.length;i++){this._buf[this._w%this._buf.length]=s[i];this._w++}}}process(i,o){var out=o[0][0];if(!out)return true;for(var i=0;i<out.length;i++){if(this._r<this._w){out[i]=this._buf[this._r%this._buf.length];this._r++}else out[i]=0}return true}}registerProcessor("playback-processor",PlaybackProcessor);`;
    const pbBlob = new Blob([PLAYBACK_CODE], { type: "application/javascript" });
    const pbUrl = URL.createObjectURL(pbBlob);
    await outputCtx.audioWorklet.addModule(pbUrl);
    URL.revokeObjectURL(pbUrl);
    const playbackNode = new AudioWorkletNode(outputCtx, "playback-processor");
    playbackNode.connect(cc.outputDest!);
    console.log("[CC] Playback worklet loaded and connected to output destination");

    // ── Base64 helpers ──
    function audioToBase64(int16: Int16Array): string {
      const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
      const CHUNK = 0x2000;
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
      }
      return btoa(parts.join(""));
    }

    // ── Capture remote audio (what other participants say) ──
    // Find connected PeerConnection and get remote audio tracks
    const captureCtx = new AudioContext(); // native rate
    const captureRate = captureCtx.sampleRate;

    const CAPTURE_CODE = `class PcmProcessor extends AudioWorkletProcessor{process(inputs){var ch=inputs[0][0];if(!ch)return true;var out=new Int16Array(ch.length);for(var i=0;i<ch.length;i++){var s=Math.max(-1,Math.min(1,ch[i]));out[i]=s<0?s*0x8000:s*0x7FFF}this.port.postMessage(out,[out.buffer]);return true}}registerProcessor("pcm-processor",PcmProcessor);`;
    const capBlob = new Blob([CAPTURE_CODE], { type: "application/javascript" });
    const capUrl = URL.createObjectURL(capBlob);
    await captureCtx.audioWorklet.addModule(capUrl);
    URL.revokeObjectURL(capUrl);

    let captureActive = false;
    function setupRemoteCapture(pc: RTCPeerConnection) {
      if (captureActive) return;
      const receivers = pc.getReceivers();
      const audioReceiver = receivers.find(r => r.track?.kind === "audio");
      if (!audioReceiver) {
        console.log("[CC] No remote audio receiver yet");
        return;
      }

      const remoteStream = new MediaStream([audioReceiver.track!]);
      const source = captureCtx.createMediaStreamSource(remoteStream);
      const worklet = new AudioWorkletNode(captureCtx, "pcm-processor");
      source.connect(worklet);

      worklet.port.onmessage = (e: MessageEvent) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        let int16 = e.data as Int16Array;

        // Downsample to 24kHz if needed
        if (captureRate !== SAMPLE_RATE && captureRate > SAMPLE_RATE) {
          const ratio = captureRate / SAMPLE_RATE;
          const newLen = Math.round(int16.length / ratio);
          const resampled = new Int16Array(newLen);
          for (let i = 0; i < newLen; i++) {
            resampled[i] = int16[Math.round(i * ratio)] || 0;
          }
          int16 = resampled;
        }

        ws.send(JSON.stringify({ type: "audio", audio: audioToBase64(int16) }));
      };

      captureActive = true;
      console.log("[CC] Remote audio capture active (rate: " + captureRate + "Hz → 24kHz)");
    }

    // Try to set up capture on existing connected PC
    for (const pc of cc.pcs) {
      if (pc.connectionState === "connected") {
        setupRemoteCapture(pc);
      }
      // Also listen for future track events
      pc.addEventListener("track", () => {
        setTimeout(() => setupRemoteCapture(pc), 500);
      });
    }

    // ── WebSocket to backend ──
    let ws: WebSocket | null = null;
    let sessionStarted = false;

    function connectWS() {
      ws = new WebSocket(BACKEND_WS);

      ws.onopen = () => {
        console.log("[CC] WebSocket connected to backend");
        // Start Grok voice session
        ws!.send(JSON.stringify({ type: "start", provider: "grok" }));
        sessionStarted = true;
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data as string);
          if (data.type === "audio" && data.audio) {
            // AI audio → decode → ring buffer → MediaStreamDestination → Meet
            const raw = atob(data.audio);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let j = 0; j < pcm16.length; j++) float32[j] = pcm16[j] / 32768;

            // Micro fade
            const FADE = 24;
            if (float32.length > FADE * 2) {
              for (let f = 0; f < FADE; f++) {
                const g = f / FADE;
                float32[f] *= g;
                float32[float32.length - 1 - f] *= g;
              }
            }

            playbackNode.port.postMessage(float32, [float32.buffer]);
          } else if (data.type === "interrupt") {
            playbackNode.port.postMessage("clear");
          } else if (data.type === "status") {
            console.log("[CC] Voice status:", data.voiceConnected, data.provider);
          }
        } catch {}
      };

      ws.onclose = () => {
        console.log("[CC] WebSocket closed, reconnecting...");
        setTimeout(connectWS, 3000);
      };
    }

    connectWS();

    // Retry remote capture setup periodically
    setInterval(() => {
      if (!captureActive) {
        for (const pc of cc.pcs) {
          if (pc.connectionState === "connected") setupRemoteCapture(pc);
        }
      }
    }, 3000);

    (window as any).__ccPipeline = { ws: () => ws, playbackNode, captureActive: () => captureActive };

  }, { wsUrl: BACKEND_WS, httpUrl: BACKEND_HTTP });

  console.log("[7] Audio pipeline connected!\n");
  console.log("════════════════════════════════════════════════════");
  console.log("  ✅ Grok Realtime + Audio Injection ACTIVE");
  console.log("");
  console.log("  你说话 → AI 通过 Meet 回答");
  console.log("  （AI 的声音通过 getUserMedia 注入传给所有参与者）");
  console.log("");
  console.log("  Ctrl+C 结束");
  console.log("════════════════════════════════════════════════════\n");

  // Keep alive + status polling
  for (let i = 0; i < 360; i++) { // 30 minutes
    await page.waitForTimeout(5000);
    const s = await page.evaluate(() => {
      const cc = (window as any).__cc;
      const p = (window as any).__ccPipeline;
      return {
        gum: cc?.gumCalls,
        pcStates: cc?.pcs?.map((pc: any) => pc.connectionState),
        wsState: p?.ws()?.readyState,
        capture: p?.captureActive?.(),
      };
    }).catch(() => ({ gum: -1, pcStates: [], wsState: -1, capture: false }));

    if (i % 6 === 0) { // Every 30s
      console.log(`[${new Date().toTimeString().substring(0,8)}] pcs=${JSON.stringify(s.pcStates)} ws=${s.wsState === 1 ? "open" : s.wsState} capture=${s.capture}`);
    }
  }

  await context.close();
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
