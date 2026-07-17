// CallingClaw 2.0 — Voice-to-Voice (v2v) Latency Probe
//
// First-party latency measurement for the real-time voice providers CallingClaw
// ships. Drives the PRODUCTION RealtimeClient with the real provider configs
// (src/ai_gateway/realtime_client.ts) so the numbers reflect what CallingClaw
// actually experiences in a meeting — no wire-protocol reimplementation.
//
// Method (per trial):
//   1. Synthesize a short spoken question with macOS `say`, convert to 24kHz
//      PCM16 mono with `afconvert` (RealtimeClient's canonical input rate; the
//      Gemini adapter downsamples 24k->16k internally, exactly as in prod).
//   2. Stream the audio to the provider in real-time-paced 20ms frames via
//      RealtimeClient.sendAudio(), then stream ~1.2s of trailing silence so the
//      provider's own VAD / activity detection endpoints the turn — same as a
//      live mic going quiet.
//   3. Timestamp (monotonic, performance.now()):
//        t0            = end of audio input (last real-speech frame sent = the
//                        instant the "user" stops speaking). This is the
//                        "end of audio input commit" reference.
//        t_speechEnd   = provider VAD end-of-speech event, when emitted
//                        (input_audio_buffer.speech_stopped — OpenAI/Grok only;
//                        Gemini does not surface one).
//        t_firstAudio  = first response audio delta received.
//        t_firstText   = first transcript/text delta received.
//   4. v2v = t_firstAudio - t0  (headline; includes provider endpointing, i.e.
//      what CallingClaw experiences). Diagnostics where available:
//        endpointing  = t_speechEnd - t0
//        model_only   = t_firstAudio - t_speechEnd  (comparable to published
//                       "model latency" figures that exclude endpointing).
//
// 5 trials/provider, ~1.2s spacing, 30s/trial timeout -> recorded as failure.
// Probes every provider whose API key is present in .env; skips others.
//
// Usage:
//   cd callingclaw-backend && bun bench/v2v-probe.ts
//   bun bench/v2v-probe.ts --provider gemini,openai --trials 5
//   bun bench/v2v-probe.ts --json out.json   # also write raw results
//
// NOTE: additive-only. No src/ behavior changes. Imports the real RealtimeClient.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealtimeClient, type VoiceProviderName } from "../src/ai_gateway/realtime_client";
import { CONFIG } from "../src/config";

// ── Config ──────────────────────────────────────────────────────────
const SAMPLE_RATE = 24000;              // RealtimeClient canonical input rate
const FRAME_MS = 20;                    // real-time pacing frame size
const TRAILING_SILENCE_MS = 1200;       // trailing silence to trigger VAD endpointing
const TRIAL_TIMEOUT_MS = 30_000;        // per-trial hard timeout
const TRIAL_GAP_MS = 1200;              // spacing between trials
const CONNECT_TIMEOUT_MS = 40_000;      // allow for Gemini's internal retry loop
const SETTLE_QUIET_MS = 2500;           // "audio quiet for this long" = settled
const SETTLE_MAX_MS = 12_000;           // cap on the settle wait (Gemini greeting)
const ANSWER_QUIET_MS = 1500;           // answer considered done after this much quiet
const ANSWER_MAX_MS = 10_000;           // cap on waiting for the answer to finish

const QUESTIONS = [
  "What is two plus two?",
  "What is three plus four?",
  "What is five plus six?",
  "What is seven plus eight?",
  "What is one plus nine?",
];

const SHORT_INSTRUCTIONS = "You are a test assistant. Answer each question in one short spoken sentence.";

// ── Log suppression (RealtimeClient/GeminiAdapter are very chatty) ──────
const _origLog = console.log;
const _origWarn = console.warn;
const _origErr = console.error;
let _quiet = false;
let VERBOSE = false;
function quiet() { if (VERBOSE) return; _quiet = true; console.log = () => {}; console.warn = () => {}; }
function unquiet() { _quiet = false; console.log = _origLog; console.warn = _origWarn; console.error = _origErr; }
// keep real errors visible on stderr even while quiet
console.error = (...a: any[]) => { _origErr(...a); };
// our own clean stdout channel (bypasses the console.log override)
function out(s = "") { process.stdout.write(s + "\n"); }

// ── Audio synthesis (say -> afconvert -> WAV -> PCM16 base64 frames) ────
interface Clip { text: string; frames: string[]; durationMs: number }

function synthClip(text: string, idx: number, dir: string): Clip {
  const aiff = join(dir, `q${idx}.aiff`);
  const wav = join(dir, `q${idx}.wav`);
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", [aiff, wav, "-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1"]);
  const pcm = extractWavPcm(readFileSync(wav));
  const frames = pcmToFrames(pcm);
  const durationMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
  return { text, frames, durationMs };
}

/** Extract the raw PCM samples from a WAV file buffer (skips RIFF/fmt chunks). */
function extractWavPcm(buf: Buffer): Buffer {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "data") return buf.subarray(body, body + size);
    off = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk in WAV");
}

/** Split PCM16 buffer into base64-encoded FRAME_MS frames. */
function pcmToFrames(pcm: Buffer): string[] {
  const bytesPerFrame = (SAMPLE_RATE * FRAME_MS / 1000) * 2; // samples*2
  const frames: string[] = [];
  for (let i = 0; i < pcm.length; i += bytesPerFrame) {
    frames.push(pcm.subarray(i, Math.min(i + bytesPerFrame, pcm.length)).toString("base64"));
  }
  return frames;
}

const SILENCE_FRAME = Buffer.alloc((SAMPLE_RATE * FRAME_MS / 1000) * 2).toString("base64");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Per-trial capture ───────────────────────────────────────────────
interface Capture {
  t0: number | null;          // end of real audio input (set by driver)
  tSpeechEnd: number | null;  // VAD speech_stopped
  tResponseCreated: number | null;
  tFirstAudio: number | null;
  tFirstText: number | null;
  tResponseDone: number | null;
  lastAudioTs: number;        // for answer-quiet detection
}
function freshCapture(): Capture {
  return { t0: null, tSpeechEnd: null, tResponseCreated: null, tFirstAudio: null, tFirstText: null, tResponseDone: null, lastAudioTs: 0 };
}

interface TrialResult {
  ok: boolean;
  reason?: string;
  question: string;
  v2vMs?: number;             // tFirstAudio - t0  (headline)
  firstTextMs?: number;       // tFirstText - t0
  endpointingMs?: number;     // tSpeechEnd - t0 (VAD providers)
  modelOnlyMs?: number;       // tFirstAudio - tSpeechEnd (VAD providers)
}

interface ProviderReport {
  provider: string;
  model: string;
  trials: TrialResult[];
  skipped?: string;
}

// ── Connect with timeout ────────────────────────────────────────────
async function connectWithTimeout(client: RealtimeClient, instr: string, name: VoiceProviderName) {
  await Promise.race([
    client.connect(instr, name),
    sleep(CONNECT_TIMEOUT_MS).then(() => { throw new Error(`connect timeout ${CONNECT_TIMEOUT_MS}ms`); }),
  ]);
}

// Wait until audio has been quiet for `quietMs`, capped at `maxMs`.
async function waitQuiet(cap: Capture, quietMs: number, maxMs: number) {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    const sinceAudio = cap.lastAudioTs ? performance.now() - cap.lastAudioTs : Infinity;
    if (sinceAudio >= quietMs) return;
    await sleep(100);
  }
}

// ── Feed audio frames at real-time pace ─────────────────────────────
async function feedFrames(client: RealtimeClient, frames: string[]) {
  for (const f of frames) {
    client.sendAudio(f);
    await sleep(FRAME_MS);
  }
}
async function feedSilence(client: RealtimeClient, ms: number) {
  const n = Math.round(ms / FRAME_MS);
  for (let i = 0; i < n; i++) {
    client.sendAudio(SILENCE_FRAME);
    await sleep(FRAME_MS);
  }
}

// ── Probe one provider ──────────────────────────────────────────────
async function probeProvider(name: VoiceProviderName, model: string, clips: Clip[], trials: number): Promise<ProviderReport> {
  const report: ProviderReport = { provider: name, model, trials: [] };
  const client = new RealtimeClient();
  let cap: Capture = freshCapture();

  client.on("*", (ev: any) => {
    const now = performance.now();
    const t = ev?.type as string;
    if (!t) return;
    if (VERBOSE) out(`    <ev ${t}${cap.t0 !== null ? ` +${Math.round(now - cap.t0)}ms` : ""}>`);
    if (t === "response.audio.delta") {
      cap.lastAudioTs = now;
      if (cap.t0 !== null && cap.tFirstAudio === null) cap.tFirstAudio = now;
    } else if (t === "response.audio_transcript.delta" || t === "response.text.delta") {
      if (cap.t0 !== null && cap.tFirstText === null) cap.tFirstText = now;
    } else if (t === "input_audio_buffer.speech_stopped") {
      if (cap.t0 !== null && cap.tSpeechEnd === null) cap.tSpeechEnd = now;
    } else if (t === "response.created") {
      if (cap.t0 !== null && cap.tResponseCreated === null) cap.tResponseCreated = now;
    } else if (t === "response.done") {
      if (cap.t0 !== null && cap.tResponseDone === null) cap.tResponseDone = now;
    }
  });

  try {
    quiet();
    await connectWithTimeout(client, SHORT_INSTRUCTIONS, name);
    unquiet();
  } catch (e: any) {
    unquiet();
    report.skipped = `connect failed: ${e?.message || e}`;
    try { quiet(); client.disconnect(); unquiet(); } catch {}
    return report;
  }

  out(`  connected to ${name} (${model}) — settling...`);
  quiet();
  // Let any auto-greeting (Gemini speaks first) finish before measuring.
  await waitQuiet(cap, SETTLE_QUIET_MS, SETTLE_MAX_MS);
  unquiet();

  for (let i = 0; i < trials; i++) {
    const clip = clips[i % clips.length];
    cap = freshCapture();
    quiet();
    // Stream the spoken question at real-time pace, then mark t0 (end of speech).
    await feedFrames(client, clip.frames);
    cap.t0 = performance.now();
    // Trailing silence so the provider VAD endpoints the turn.
    await feedSilence(client, TRAILING_SILENCE_MS);

    // Wait for first audio (or timeout).
    const deadline = cap.t0 + TRIAL_TIMEOUT_MS;
    while (cap.tFirstAudio === null && performance.now() < deadline) await sleep(15);
    unquiet();

    if (cap.tFirstAudio === null) {
      report.trials.push({ ok: false, reason: `no audio within ${TRIAL_TIMEOUT_MS}ms`, question: clip.text });
      out(`  trial ${i + 1}/${trials}: TIMEOUT (no audio in ${TRIAL_TIMEOUT_MS}ms)`);
    } else {
      const r: TrialResult = {
        ok: true,
        question: clip.text,
        v2vMs: Math.round(cap.tFirstAudio - cap.t0!),
        firstTextMs: cap.tFirstText !== null ? Math.round(cap.tFirstText - cap.t0!) : undefined,
        endpointingMs: cap.tSpeechEnd !== null ? Math.round(cap.tSpeechEnd - cap.t0!) : undefined,
        modelOnlyMs: cap.tSpeechEnd !== null ? Math.round(cap.tFirstAudio - cap.tSpeechEnd) : undefined,
      };
      report.trials.push(r);
      out(`  trial ${i + 1}/${trials}: v2v=${r.v2vMs}ms  firstText=${r.firstTextMs ?? "-"}ms` +
        (r.endpointingMs !== undefined ? `  (endpoint=${r.endpointingMs}ms model=${r.modelOnlyMs}ms)` : ""));
    }

    // Let the answer finish + spacing, so the next trial starts from a clean VAD state.
    quiet();
    await waitQuiet(cap, ANSWER_QUIET_MS, ANSWER_MAX_MS);
    await sleep(TRIAL_GAP_MS);
    unquiet();
  }

  quiet();
  try { client.disconnect(); } catch {}
  await sleep(300);
  unquiet();
  return report;
}

// ── Stats ───────────────────────────────────────────────────────────
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}
function summarize(vals: number[]) {
  return { n: vals.length, p50: pct(vals, 50), p95: pct(vals, 95), min: Math.min(...vals) };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
  const trials = parseInt(getArg("--trials") || "5", 10);
  const jsonOut = getArg("--json");
  VERBOSE = args.includes("--verbose");

  // Candidate providers and their key presence (env var names from src/config.ts).
  const CANDIDATES: Array<{ name: VoiceProviderName; model: string; key: string; keyEnv: string }> = [
    { name: "gemini", model: CONFIG.gemini.realtimeModel, key: CONFIG.gemini.apiKey, keyEnv: "GOOGLE_AI_API_KEY / GEMINI_API_KEY" },
    { name: "openai", model: CONFIG.openai.realtimeModel, key: CONFIG.openai.apiKey, keyEnv: "OPENAI_API_KEY" },
    { name: "grok", model: "grok-realtime", key: CONFIG.grok.apiKey, keyEnv: "XAI_API_KEY" },
  ];

  const requested = getArg("--provider");
  const wanted = requested ? requested.split(",").map((s) => s.trim()) : null;

  out("=".repeat(64));
  out("CallingClaw v2v latency probe");
  out(`sample_rate=${SAMPLE_RATE}Hz frame=${FRAME_MS}ms trailing_silence=${TRAILING_SILENCE_MS}ms trials=${trials}`);
  out("=".repeat(64));

  // Synthesize question clips once.
  const clipDir = join(tmpdir(), "v2v-probe-clips");
  if (!existsSync(clipDir)) mkdirSync(clipDir, { recursive: true });
  out("synthesizing question clips via `say` + `afconvert`...");
  const clips = QUESTIONS.map((q, i) => synthClip(q, i, clipDir));
  out(`  ${clips.length} clips (durations: ${clips.map((c) => c.durationMs + "ms").join(", ")})`);
  out("");

  const reports: ProviderReport[] = [];
  for (const c of CANDIDATES) {
    if (wanted && !wanted.includes(c.name)) continue;
    if (!c.key) {
      out(`[${c.name}] SKIP — no API key (${c.keyEnv} not set)`);
      reports.push({ provider: c.name, model: c.model, trials: [], skipped: `no API key (${c.keyEnv})` });
      continue;
    }
    out(`[${c.name}] probing ${trials} trials...`);
    const rep = await probeProvider(c.name, c.model, clips, trials);
    if (rep.skipped) out(`[${c.name}] FAILED — ${rep.skipped}`);
    reports.push(rep);
    out("");
  }

  // ── Summary table ──────────────────────────────────────────────
  out("=".repeat(64));
  out("RESULTS");
  out("=".repeat(64));
  for (const r of reports) {
    if (r.skipped && r.trials.length === 0) {
      out(`\n${r.provider} (${r.model}): SKIPPED — ${r.skipped}`);
      continue;
    }
    const ok = r.trials.filter((t) => t.ok);
    const v2v = ok.map((t) => t.v2vMs!).filter((x) => Number.isFinite(x));
    const txt = ok.map((t) => t.firstTextMs).filter((x): x is number => Number.isFinite(x as number));
    const model = ok.map((t) => t.modelOnlyMs).filter((x): x is number => Number.isFinite(x as number));
    const endp = ok.map((t) => t.endpointingMs).filter((x): x is number => Number.isFinite(x as number));
    out(`\n${r.provider} (${r.model})`);
    out(`  trials ok: ${ok.length}/${r.trials.length}`);
    if (v2v.length) {
      const s = summarize(v2v);
      out(`  v2v (first-audio - t0):   p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms`);
    }
    if (txt.length) {
      const s = summarize(txt);
      out(`  first-text - t0:          p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms`);
    }
    if (endp.length) {
      const s = summarize(endp);
      out(`  [diag] endpointing (VAD): p50=${s.p50}ms  min=${s.min}ms`);
    }
    if (model.length) {
      const s = summarize(model);
      out(`  [diag] model-only:        p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms`);
    }
    const fails = r.trials.filter((t) => !t.ok);
    if (fails.length) out(`  failures: ${fails.map((f) => f.reason).join("; ")}`);
  }
  out("");

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ meta: { sampleRate: SAMPLE_RATE, frameMs: FRAME_MS, trailingSilenceMs: TRAILING_SILENCE_MS, trials, at: new Date().toISOString() }, reports }, null, 2));
    out(`raw results written to ${jsonOut}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { unquiet(); console.error(e); process.exit(1); });
