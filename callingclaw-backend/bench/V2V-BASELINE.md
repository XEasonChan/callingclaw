# CallingClaw — Voice-to-Voice (v2v) Latency Baseline

**First-party latency numbers for CallingClaw's real-time voice providers.**
Measured with `bench/v2v-probe.ts`, which drives the *production* `RealtimeClient`
(`src/ai_gateway/realtime_client.ts`) with the real provider configs — so these
are the latencies CallingClaw actually experiences in a meeting, not a reimplemented
wire protocol.

- **Date:** 2026-07-17
- **Branch:** `feat/v2v-latency-probe`
- **Motivation:** the research synthesis (`tmp/research-20260717/final-report.md`, gap §B.3)
  flagged the *measurement gap* — CallingClaw had **zero** first-party v2v numbers — and a
  decision-critical unresolved conflict: Gemini 3.1 Flash Live at **~960ms** (voice §1.2) vs
  **~2.98s** (cu §5), with wire-compatible Grok reportedly ~0.78s. This probe exists to settle
  that with our own data.

---

## TL;DR verdict

| Provider | Key present? | Measured? | v2v p50 | Notes |
|---|---|---|---|---|
| **OpenAI** `gpt-realtime-2` | yes (`OPENAI_API_KEY`) | **yes — 5/5** | **1478 ms** experienced / **566 ms** model-only | Clean baseline. Model-only is *faster* than the published ~0.82s. |
| **Gemini** `gemini-3.1-flash-live-preview` | present but **INVALID** (`GEMINI_API_KEY`) | **no — 0/5** | — | Key rejected by Google: REST `401`, Live WS close `1008` (invalid auth). Cannot measure. See "Blocker". |
| **Grok / xAI** | **absent** (`XAI_API_KEY`) | no — skipped | — | Skipped gracefully — no key in `.env`. |

**Bottom line:** the harness works and produced a solid first-party OpenAI baseline. The
Gemini vs 960ms/2.98s conflict is **still not resolved by first-party data** — but not for
lack of a probe: the Gemini credential in this deployment is invalid, so Google refuses the
session before a single audio frame flows. Drop in a valid `GEMINI_API_KEY` and
`bun bench/v2v-probe.ts --provider gemini` resolves it in ~60s.

---

## Numbers

### OpenAI `gpt-realtime-2` (5 trials, all succeeded)

| Metric | p50 | p95 | min |
|---|---|---|---|
| **v2v** (first-audio − t0, *includes endpointing* — what a meeting feels like) | **1478 ms** | 1957 ms | 1432 ms |
| **first-text** (first transcript delta − t0) | 1234 ms | 1693 ms | 1182 ms |
| *[diag]* endpointing (VAD speech-stopped − t0) | 911 ms | — | 876 ms |
| *[diag]* model-only (first-audio − VAD speech-stopped) | **566 ms** | 1066 ms | 487 ms |

Per-trial v2v: `1473, 1478, 1503, 1957, 1432 ms` (one ~1.96s outlier; the other four cluster at 1.43–1.50s).

**Reading it:** the ~1.48s a user *feels* decomposes into ~0.9s of VAD/endpointing (semantic_vad
waiting out the trailing silence) + ~0.57s of actual model time-to-first-audio. The **model-only
566 ms p50** is the intrinsic provider speed and is *faster* than the ~0.82s figure the research cited.

### Gemini `gemini-3.1-flash-live-preview` — BLOCKED (0/5)

Not measurable in this environment. Evidence gathered:
- **REST probe** (`GET /v1beta/models?key=…`, proxy off): **HTTP 401** — *"Request had invalid
  authentication credentials. Expected OAuth 2 access token, login cookie or other valid
  authentication credential."*
- **Live WS** (production path, `HTTPS_PROXY` set): closes **1006** ("Connection ended") — proxy
  drops it.
- **Live WS** (proxy off): reaches Google, then closes **1008** with the same invalid-auth reason;
  RealtimeClient's reconnect loop churns and no audio ever arrives → 30s trial timeout.

The key stored as `GEMINI_API_KEY` is not a working Generative Language API key (it is not the
usual `AIza…` form and Google rejects it outright). This is a **credential/environment problem,
not a harness problem** — the same harness measured OpenAI cleanly and the Gemini WS handshake
itself reaches Google.

### Grok / xAI — SKIPPED

No `XAI_API_KEY` in `.env`. Reported as skipped, not measured.

---

## Conflict resolution: Gemini 960 ms vs 2.98 s (and vs Grok)

**Status: NOT resolved by first-party Gemini data** (invalid key). But the OpenAI baseline lets us
resolve the *structure* of the conflict, which is likely a **definition mismatch, not a 3× speed
difference between two Gemini tests:**

- Our OpenAI run separates the two things those third-party numbers are probably each measuring:
  - **model-only** (end-of-speech → first audio) = **~0.57s p50**
  - **experienced** (actual end of user speech → first audio, incl. VAD endpointing) = **~1.48s p50**
- The gap between "model-only" and "experienced" here is **~0.9s of endpointing alone** — before
  any network or measurement overhead.
- So on a wire-compatible provider on this machine/network, the *same event* reads as either
  ~0.57s or ~1.48s depending purely on **where you start the clock**. The Gemini **960ms** claim
  is consistent with a **model-only** measurement (clock starts at VAD end-of-speech); the **2.98s**
  claim is consistent with an **experienced/full-turn** measurement (clock starts at end of user
  audio) that additionally carries a longer VAD silence window, network, and possibly a
  cascaded/turn-complete path.

**Therefore:** the ~3× spread is almost certainly *what was measured*, not Gemini running 3× slower
in one benchmark than another. It does **not**, on its own, justify switching the default away from
Gemini. The honest resolution still requires one first-party Gemini run with a valid key — the harness
is ready.

**Gemini vs Grok as default:** cannot be answered first-party here (Gemini key invalid, Grok key
absent). What the OpenAI data *does* establish: (1) sub-600ms model-only v2v is real and reproducible
on this stack, so any provider materially above that is leaving live-feel on the table; (2) the
dominant, tunable cost in the experienced number is the **~0.9s endpointing tax** — lowering VAD
`silence_duration_ms` / using tighter semantic-VAD would cut more perceived latency than a provider
swap, and applies to *every* provider. Measure Gemini and Grok before changing the default (matches
research Part D decision #2: "measure first, then decide").

---

## Methodology (repeatable)

Per trial:
1. **Synthesize** a short spoken question with macOS `say`, convert to **24 kHz PCM16 mono** with
   `afconvert` (WAV → parsed to raw PCM). 24 kHz is `RealtimeClient`'s canonical input rate; the
   Gemini adapter downsamples 24k→16k internally, exactly as in production.
2. **Stream** the audio to the provider via `RealtimeClient.sendAudio()` in **real-time-paced 20 ms
   frames** (mimics a live mic), then stream **1200 ms of trailing silence** so the provider's own
   VAD / activity detection endpoints the turn.
3. **Timestamp** (monotonic `performance.now()`):
   - `t0` = end of the real-speech audio (the instant the "user" stops speaking = "end of audio
     input commit").
   - `t_speechEnd` = provider VAD end-of-speech (`input_audio_buffer.speech_stopped`; OpenAI/Grok
     only — Gemini surfaces none).
   - `t_firstAudio` = first `response.audio.delta`.
   - `t_firstText` = first `response.audio_transcript.delta` / `response.text.delta`.
4. **Metrics:** `v2v = t_firstAudio − t0` (headline, uniform across providers). Diagnostics where
   the provider emits VAD events: `endpointing = t_speechEnd − t0`, `model_only = t_firstAudio − t_speechEnd`.
5. **5 trials/provider**, one persistent session per provider, `response.done` + ~1.2s spacing between
   trials so each starts from a clean VAD state. Any auto-greeting (Gemini speaks first) is waited out
   before trial 1. **30s/trial timeout** → recorded as a failure, never blocks the run.
6. Providers are auto-selected by API-key presence in `.env`; missing keys are skipped and reported.

Question set (varied to avoid "you already asked" behavior): simple single-digit sums
("What is two plus two?", …), ~1.1–1.4s each.

### Run it

```bash
cd callingclaw-backend

# All providers with a key present (auto-detected), 5 trials each:
bun bench/v2v-probe.ts

# Specific providers / trial count / raw JSON dump:
bun bench/v2v-probe.ts --provider gemini,openai --trials 5 --json bench/last-run.json

# Verbose event trace (debug a provider's handshake):
bun bench/v2v-probe.ts --provider gemini --trials 1 --verbose
```

To measure Gemini, set a **valid** `GEMINI_API_KEY` (or `GOOGLE_AI_API_KEY`, `AIza…` form) in the
repo-root `.env`. Note: on the proxy-required path the Gemini WS uses `ws + HttpsProxyAgent`; if the
proxy is flaky, unset `HTTPS_PROXY` for a direct connection (OpenAI/Grok use Bun's native WebSocket,
which ignores the proxy regardless).

---

## Caveats

- **Machine/network:** Apple M4 Pro, 12 cores, 24 GB, macOS 26.5.1, Bun 1.3.13. TCP connect to
  `api.openai.com` ≈ 51 ms. Numbers are single-machine, single-network, one session — treat as a
  **baseline snapshot**, not a cross-provider leaderboard. Re-run on the target deployment.
- **Headline v2v includes endpointing.** It reflects lived latency but bakes in each provider's VAD
  config (a CallingClaw choice, not an intrinsic model property). Use the `model_only` diagnostic to
  compare intrinsic provider speed.
- **Real-time pacing** means trailing silence is fed over wall-clock time, so VAD fires realistically
  rather than off a pre-buffered dump.
- **`say` voice quality** is synthetic TTS, not a human voice — fine for latency, not for transcription
  accuracy assessment.
- **OpenAI network path:** Bun's native WebSocket ignored `HTTPS_PROXY`; OpenAI was measured on the
  direct egress path (which is up here, ~51 ms).
- **`openai15` provider** resolves to the same model (`gpt-realtime-2`) and same `OPENAI_API_KEY` as
  `openai`, so it is not probed separately — the `openai` row represents `gpt-realtime`.

---

## Surprises worth escalating

1. **CallingClaw's hard-coded default voice provider (Gemini) has an invalid key in this deployment.**
   `config.ts` defaults `VOICE_PROVIDER` to `gemini`; a fresh setup that keeps the default + this
   `.env` would get a **permanently mute bot** (RealtimeClient loops on 1008/1006, never emits audio).
   This deployment only works because `.env` overrides `VOICE_PROVIDER=openai`. Recommend: (a) validate
   the shipped Gemini key or fix the setup flow, and (b) fail loudly on repeated auth-close (1008)
   instead of silently reconnecting — this is exactly the "deaf/mute bot ships as success" class the
   research P0s (audit §R1/R2) warned about.
2. **The endpointing tax (~0.9s) dominates the experienced number** over model compute (~0.57s). The
   biggest live-feel lever is VAD tuning, and it is provider-independent — measure it before betting
   on a provider swap.
3. **Model-only v2v (566 ms p50) beats the cited ~0.82s** for gpt-realtime on this hardware, i.e. the
   stack is not the bottleneck; endpointing + provider choice are.
