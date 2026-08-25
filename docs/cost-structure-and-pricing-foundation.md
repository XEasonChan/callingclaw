# CallingClaw Cost Structure & Pricing Foundation

**Date:** 2026-07-06
**Status:** A-priori cost model, grounded in code + published rates. To be empirically validated by the sibling `CostMeter` runtime logger (per-component token JSONL) — see §9.
**Scope:** macOS voice-only meeting participant. No avatar/video generation anywhere in the stack.

---

## 0. TL;DR

1. **Today, CallingClaw has ~$0 direct COGS.** Every model call — voice, vision, Haiku, Sonnet, the personal agent — runs on API keys the *user* supplies in their own `.env` (`callingclaw-backend/.env.example`, `src/config.ts`). This is a bring-your-own-key (BYOK) architecture, not a hosted service. Pricing strategy today is a **software/subscription** question, not a **metered-COGS** question — until/unless CallingClaw offers a managed-keys tier.
2. **The live meeting loop (voice + vision + Haiku auditor/retriever + light computer-use) costs ~$0.07–0.08/min (~$2.10–2.50 for a 30-min meeting)** with the default voice provider (Gemini 3.1 Flash Live). Voice-only is ~$0.02/min.
3. **Pika's PikaStream avatar bot costs $0.275/min ($16.50/hr)** — a price CallingClaw's own competitor research verified directly from their GitHub Skill page (2026-06-11). That's **~14x more than CallingClaw's voice-only cost, ~3–4x more than CallingClaw's full live loop** (which additionally does screen vision + computer control + agent-driven prep that Pika structurally cannot do — no avatar rendering pipeline is required for any of it).
4. **Runway's credit-metered video generation is 85–350x more expensive per minute** than CallingClaw's live loop if used continuously — the structural reason nobody runs full video generation as a 30-minute meeting participant. Runway's own "Characters Meet" developer sample (the closest analog) caps sessions at 5 minutes and burns ~$0.20/min even at trial-tier credit pricing.
5. **The personal agent (Claude Code / OpenClaw / Codex / Hermes) is the dominant AND most variable cost** — a single deep prep or follow-up-execution call can cost more than an entire meeting's live loop. It's also entirely BYOK today. This is where a future managed tier's margin risk — and metering opportunity — lives.
6. **Pricing implication:** a cheap, flat, "pay for the meeting that worked" tier is affordable because the live loop is cheap and predictable; the agent is where usage-based metering (or plan tiers) needs to live if CallingClaw ever fronts API costs.

---

## 1. Method & Scope

- **Cost drivers enumerated from code**, not documentation — `CLAUDE.md`'s "Meeting-Time Model Usage" table is directionally right but stale on one point (see §2.1). Every frequency/trigger claim below cites a file:line.
- **Anthropic pricing is cited fact** (Claude API skill, live model catalog, cached 2026-06-24): Haiku 4.5, Sonnet 5, Opus 4.8.
- **OpenAI Realtime, Gemini Live, Grok Voice, Runway, and screenshot/image token counts are estimates**, explicitly marked. Cross-validated where possible against CallingClaw's own in-code pricing comments (written by whoever last touched `config.ts`) and a live web search — but not independently re-verified against each provider's current pricing page in this session.
- **Pika's $0.275/min is an internally-sourced fact**, not a web estimate — pulled from CallingClaw's own competitor research (`competitor/pika-pikastream.md`), which checked Pika's GitHub Skill page directly on 2026-06-11.
- **The personal-agent cost is the least measurable component** — genuinely can't be pinned down from static code alone (it depends on file sizes read, search breadth, cache hit rate). This doc gives a *reasoned range*; the sibling `CostMeter` lane (runtime per-component token JSONL logger) is the intended empirical validator, referenced but not depended on here.

---

## 2. Cost Drivers, By Component

### 2.1 Correction to `CLAUDE.md`

`CLAUDE.md`'s Meeting-Time Model table says VisionModule uses "Gemini Flash." **The code has moved on**: `src/config.ts:177-180` sets `vision.model = "anthropic/claude-haiku-4-5"` as primary (routed through OpenRouter), with `vision.fallbackModel = "google/gemini-3.5-flash"` as the error fallback only. The comment at `config.ts:173`: *"A/B eval showed Haiku 4.5 matches Sonnet quality (96% vs 100%) at 6x less cost. Haiku also has native vision."* `src/modules/vision.ts:60-72` confirms the client is constructed with `CONFIG.vision.model`. The doc below models vision cost on **Haiku 4.5**, not Gemini Flash.

### 2.2 Component table

| Component | Model (code ref) | Trigger / frequency (code ref) | Nature |
|---|---|---|---|
| **Voice** | Gemini 3.1 Flash Live (default), OpenAI Realtime `gpt-realtime-2`, or Grok — `config.ts:56,67-113` (`voiceProvider` default `"gemini"`) | Continuous bidirectional audio stream for the whole meeting duration | Time-based, not call-based |
| **Vision** | Haiku 4.5 primary, Gemini 3.5 Flash fallback — `config.ts:177-180` | Screenshot every 1s (`CAPTURE_INTERVAL_MS=1000`, `vision.ts:35`); LLM call throttled to every 3s (`GEMINI_MIN_INTERVAL_MS=3000`, `vision.ts:36`); **fires unconditionally once 3s has elapsed, regardless of whether content changed** (`vision.ts:208-212` — the similarity dedup at line 223 only gates whether the description gets *used*, not whether the call is *made*). Runs for the **entire meeting**, started on `meeting.started` (`callingclaw.ts:412-414`), stopped on meeting end. | Fixed-interval, continuous |
| **TranscriptAuditor** | Haiku 4.5 via `CONFIG.analysis.model` — `transcript-auditor.ts:27-28`, `config.ts:139` | Debounced 1.2s after last user utterance (`DEBOUNCE_MS=1200`, `transcript-auditor.ts:247`), 3s cooldown between audits (`COOLDOWN_MS=3000`, line 252). One call per user speaking turn, roughly. | Event-driven, per-utterance |
| **ContextRetriever (Layer 1: topic classify)** | Haiku 4.5 — `context-retriever.ts:433-436` | Triggers on `CHAR_THRESHOLD=300` new transcript chars (~1-2 min of dialogue) or a detected question, floor `MIN_INTERVAL_MS=20_000` (`context-retriever.ts:120-123`) | Event-driven, roughly every 20s-2min of active talk |
| **ContextRetriever (Layer 2: need inference)** | Haiku 4.5 — `context-retriever.ts:512-514` | Only runs when Layer 1 reports `shifted:true` — a subset of Layer 1 triggers | Event-driven, rarer |
| **ContextRetriever (Layer 3: agentic search)** | Haiku 4.5 or configured `searchModel`, tool-use loop up to `MAX_TOOL_ROUNDS=5` — `context-retriever.ts:539,648-707` | Only when Layer 2 reports `needsRetrieval:true` — rarest of the three | Event-driven, multi-round when it fires |
| **Computer-Use (in-meeting)** | Haiku 4.5 default (`meetingAutomation.computerUseModel`, `config.ts:164-169`); Sonnet 5 opt-in A/B via `IN_MEETING_COMPUTERUSE_MODEL` | On-demand — fires only when the voice AI or TranscriptAuditor dispatches `computer_action`/`browser_action` | Fully on-demand, no fixed cadence |
| **Personal agent** (`AgentAdapter`: Claude Code / OpenClaw / Codex / Hermes / standalone) | **Claude Code adapter hardcodes model per task**: `generateMeetingPrep` → sonnet, maxTurns 10, 120s timeout (`claude-code-adapter.ts:507-509`); `recallContext` → haiku, maxTurns 3 (line 534); `executeTask` → sonnet, maxTurns 10 (line 558); `executeTodo` → sonnet, **maxTurns 15**, 300s timeout — "5 min for deep work" (lines 657-659); `processTimeline` → sonnet, maxTurns 10 (line 677). **OpenClaw/Codex/Hermes adapters have no hardcoded model** — they shell out to the user's own CLI, which resolves against the user's own config (`~/.openclaw/openclaw.json`, `~/.codex/config.toml`, `hermes -m <model>`) | Pre-meeting prep (OC-001), in-meeting `recall_context`/`research_task` fallback (rare — only when local + Haiku paths fail per `CLAUDE.md`), post-meeting summary/timeline (OC-004/005), post-meeting follow-up execution (OC-009) | Event-driven, highly variable turn count per event (up to 15) |

### 2.3 BYOK is architectural, not incidental

Every provider client in `config.ts` reads its key from `process.env`: `openai.apiKey`, `anthropic.apiKey`, `openrouter.apiKey`, `gemini.apiKey`. `.env.example` ships placeholder keys (`OPENAI_API_KEY=sk-xxx`, `OPENROUTER_API_KEY=sk-or-v1-xxx`) that the **user** fills in during `./scripts/setup.sh`. The `OpenClawAdapter` (`src/adapters/openclaw-adapter.ts`) is a pure gateway/WebSocket client to the user's own OpenClaw instance — CallingClaw's code never sees or chooses OpenClaw's model. Same for Codex (`~/.codex/config.toml`) and Hermes (per-run `-m` flag, provider = OpenRouter with the user's key). **There is no CallingClaw-hosted key anywhere in this codebase.** This is the single most important framing fact for pricing: CallingClaw is currently a piece of software you run against your own accounts, not a metered service.

---

## 3. Rate Card — Fact vs. Estimate

| Rate | $/1M input | $/1M output | Status |
|---|---|---|---|
| Claude Haiku 4.5 | $1.00 | $5.00 | **FACT** — Anthropic model catalog (cached 2026-06-24) |
| Claude Sonnet 5 | $3.00 (intro $2.00 through 2026-08-31) | $15.00 (intro $10.00) | **FACT** — same source |
| Claude Opus 4.8 | $5.00 | $25.00 | **FACT** — same source (referenced only for context; not used in-meeting per current code) |
| Prompt cache write / read | 1.25x (5-min TTL) / ~0.1x read | — | **FACT** — Anthropic docs |
| OpenAI Realtime `gpt-realtime-2` audio | $32/1M audio-in tokens, $64/1M audio-out tokens; user audio = 1 tok/100ms, assistant audio = 1 tok/50ms | | **ESTIMATE** — cross-validated: `config.ts:96` comment ("OpenAI ~$0.30/min"), external web research ("$32/$64 per 1M," "typical agents $0.18-0.46/min uncached, $0.05-0.10/min with caching") |
| Gemini 3.1 Flash Live | ~$0.005/min audio-in, ~$0.018/min audio-out (≈$0.02/min blended) | | **ESTIMATE** — cross-validated: `config.ts:105` comment ("~$0.02/min ... 10x cheaper than OpenAI") vs. external research ("$3/1M in, $12/1M out audio tokens ≈ $0.005/min in, $0.018/min out") |
| Grok Voice | ~$0.05/min | | **ESTIMATE** — `config.ts:96` comment only, not independently web-verified this session |
| Pika PikaStream (avatar meeting bot) | $0.275/min ($16.50/hr) | | **FACT (internal)** — `competitor/pika-pikastream.md:74,90,107` — checked directly against Pika's GitHub Skill page on 2026-06-11; down from $0.50/min at April 2026 launch |
| Runway API credits | ~$0.01/credit at organization API rate; Gen-4/4.5 video ~10-40 credits/sec of rendered output | | **ESTIMATE** — external web research; Runway Characters Meet trial tier = 600 free credits ≈ 30 min (~20 credits/min), per `docs/competitor-meeting-agents-research.html` |
| Screenshot image tokens (vision, computer-use) | ~1,200–2,800 tokens/image | | **ESTIMATE, widest uncertainty band** — Anthropic's published `(width_px × height_px) / 750` formula applied to the code's actual capture resolution. `browser-capture-provider.ts:65-78` captures full 1920×1080 JPEG q80 client-side (→ ~2,764 tokens by the formula) and sends `detail:"low"` to the API — whether OpenRouter/Anthropic honors that hint with a server-side downscale (which would land closer to ~1,200 tokens) is **not verified in this session**. Flagged as the top candidate for `CostMeter` to resolve, and as a live optimization target (client-side downscale before sending would make this both cheaper and deterministic). |

---

## 4. 30-Minute Meeting Cost Model

### 4.1 Assumptions (explicit)

- Default voice provider (Gemini 3.1 Flash Live); AI speaks ~30% of the 30 minutes, listens the rest.
- Vision runs the full 30 min regardless of screen-sharing status (confirmed: `callingclaw.ts:412-414` starts it on `meeting.started`).
- TranscriptAuditor: ~40 audited utterances in a moderately active 30-min meeting (event-driven; this is the one component whose per-meeting count depends heavily on how talkative the meeting is — a quiet listen-only meeting could be <10, a fast back-and-forth could be >80).
- ContextRetriever: ~30 Layer-1 topic checks, ~8 Layer-2 need-inferences (topic shifts), ~3 Layer-3 agentic-search triggers averaging 3 tool-use rounds each.
- Computer-use: **light** = 2 on-demand calls, **heavy** = 12 on-demand calls (genuinely on-demand; no code-derived base rate exists).
- Personal agent: **light** = prep (OC-001) + post-meeting summary (`processTimeline`), realized at ~4 of the 10-turn cap each = 8 turns total. **Heavy** = light + 2 in-meeting `executeTask` fallbacks (10 turns each) + 2 post-meeting `executeTodo` follow-ups (15 turns each, full cap) = ~70 turns total.
- Agent per-turn effective cost: **$0.03–$0.12/turn** at Sonnet 5 standard rate — a reasoned range, not a measurement, reflecting typical agentic-coding-session token consumption (growing context, tool results, partial prompt-cache hits). Midpoint $0.07/turn used for headline totals.

### 4.2 Per-component table (Gemini Live default, light computer-use + light agent)

| Component | Calls / basis | Est. tokens/call | Est. $ (30 min) |
|---|---|---|---|
| Voice (Gemini Live) | continuous | — | $0.60 |
| Vision (Haiku 4.5) | ~600 (every 3s) | ~1,700–2,800 in / ~100 out | **$1.20–$1.90** (midpoint $1.55) |
| TranscriptAuditor (Haiku 4.5) | ~40 | ~1,400 in / ~120 out | $0.08 |
| ContextRetriever (Haiku 4.5, 3 layers) | ~30 + 8 + 9 rounds | 400-900 in / 60-350 out | $0.05 |
| Computer-Use, light (Haiku 4.5) | 2 | ~2,200 in / ~200 out | $0.01 |
| **Live-loop subtotal** | | | **~$1.94–$2.64 (midpoint ~$2.29)** |
| Personal agent, light (Sonnet 5) | ~8 turns | — | $0.24–$0.96 (midpoint $0.56) |
| **TOTAL — light meeting** | | | **~$2.85 (range ~$2.20–$3.60)** |

### 4.3 Heavy sensitivity (heavier computer-use + heavy agent usage)

| Component | Delta vs. light | Est. $ (30 min) |
|---|---|---|
| Live-loop (computer-use → 12 calls) | +$0.03 | ~$1.97–$2.67 |
| Personal agent, heavy (~70 turns) | — | **$2.10–$8.40 (midpoint $4.90)**; realistic ceiling **$5–$15** once a few turns hit large file reads / low cache-hit rounds |
| **TOTAL — heavy meeting** | | **~$7–$18 (midpoint ~$9–10)** |

### 4.4 Voice-provider sensitivity — the other big lever

| Provider | $/min (est.) | $ for 30 min | Delta vs. Gemini default |
|---|---|---|---|
| Gemini 3.1 Flash Live (default) | ~$0.02 | $0.60 | — |
| Grok Voice | ~$0.05 | $1.50 | +$0.90 |
| OpenAI Realtime, cached + trimmed tools | ~$0.05–$0.10 | $1.50–$3.00 | +$0.90–$2.40 |
| **OpenAI Realtime, uncached (naive default)** | **~$0.30** | **$9.00** | **+$8.40** |

Swapping the voice provider from Gemini to uncached OpenAI Realtime **more than triples the light-meeting total** (~$2.85 → ~$11.25) and, as shown below, can flip the entire "10x cheaper than Pika" claim on its head for that one component. This is a bigger single lever than most usage differences.

---

## 5. Thesis A — Voice-Only Is Structurally Cheaper Than Avatar/Video-Gen Competitors

CallingClaw does no avatar rendering and no video generation at any point in its stack — voice in, voice out, plus cheap text/vision models for screen awareness and automation. That's a structural, not incremental, cost difference from competitors whose core loop is a GPU-rendered talking face or a credit-metered video-diffusion model.

| Product | What it bills for | $/min | 30-min cost | vs. CallingClaw |
|---|---|---|---|---|
| **CallingClaw, voice-only equivalent** | Voice stream only (Gemini Live default) | **$0.02** | **$0.60** | baseline |
| **CallingClaw, full live loop** | Voice + continuous screen vision + Haiku auditor/retriever + light computer-use | **$0.07–0.08** | **~$2.30** | baseline |
| **Pika PikaStream** | Cloud H100-rendered talking avatar (24fps @ 480p) + voice, Google Meet only | **$0.275** | **$8.25** | **13.75x** the voice-only cost; **~3.6x** the full live-loop cost — and PikaStream structurally cannot see the shared screen, cannot control the computer, and has an unresolved 2-month-old audio bug (`competitor/pika-pikastream.md` §3.5, §3.4) |
| **Runway Characters Meet** (dev sample, trial tier) | Avatar video stream, Recall.ai + LiveKit sample, 600 free credits ≈ 30 min | **~$0.20** (est.) | **~$6.00** (est.) | **~10x** voice-only; **~2.6x** live-loop — and this is Runway's *free trial* tier of a product explicitly documented as a 5-minute-session developer sample, not a production meeting worker |
| **Runway full Gen-4/4.5 video generation** | Credit-metered video diffusion, ~10-40 credits/sec | **$6–$24** (est.) | **$180–$720** (est.) | **85–350x** live-loop — the order-of-magnitude gap that explains why nobody runs full video-gen as a continuous 30-minute meeting participant |

**The mechanism, not just the number:** Pika's cost is dominated by a persistent H100 GPU rendering 24fps of a photorealistic face for the full call duration — that cost exists whether or not the "AI" says anything useful. Runway's cost is dominated by diffusion-model video synthesis, which is inherently expensive per output frame and doesn't amortize over a long, mostly-static meeting the way a voice-only loop does (silence is nearly free for CallingClaw; silence is *not* free for a system that must still render a face). CallingClaw's costs are dominated by small, cheap models (Haiku, sub-second audio) making short calls — the kind of workload that keeps getting cheaper as providers compete on inference cost, unlike GPU-seconds of video rendering.

**Caveat that keeps this honest (§4.4):** the 13.75x / 3.6x gap holds cleanly against CallingClaw's *default* voice provider. If a user (or a future managed tier) defaults to uncached OpenAI Realtime instead of Gemini Live, CallingClaw's voice cost alone ($9.00/30min) exceeds Pika's *entire* avatar bill ($8.25/30min). **The "far cheaper than avatar bots" claim is a claim about CallingClaw's default configuration, not an inherent property of voice-only architecture — provider choice matters enormously and should be a deliberate default, not an accident.**

---

## 6. Thesis B — The Personal Agent Is the Dominant, Most Variable Cost

Three independent facts point the same direction:

1. **Turn ceilings are large relative to the live loop.** `executeTodo` (post-meeting follow-up execution) is capped at **15 turns** and a **300-second (5-minute) timeout** — explicitly commented "5 min for deep work" (`claude-code-adapter.ts:659`). A single follow-up execution can run longer, and cost more, than the entire live meeting loop that preceded it.
2. **Model tier is fixed high for every cognitive task.** Every Claude Code adapter method except `recallContext` (Haiku, 3-turn cap) uses **Sonnet 5** — 3x Haiku's input rate, 3x its output rate. The in-meeting live loop deliberately stays on Haiku for latency (`CLAUDE.md` "Meeting-Time Model Usage," `meetingAutomation` comments in `config.ts:151-170`); the agent deliberately does not, because prep/summary/follow-up quality matters more than latency there.
3. **It's the only component with no fixed cadence or ceiling on real-world token growth.** Vision fires exactly every 3s. The auditor debounces to ~1.2s. The agent's turn *count* is capped (10 or 15), but each turn's *token cost* is open-ended — a turn that reads a large file or runs a broad search can dwarf ten cheap turns combined. This is exactly the variability the light/heavy sensitivity in §4.3 tries to capture: **~$0.56 light vs. $5–15 heavy**, a >10x spread from usage pattern alone, on a single meeting.

**And it's the one component the live-loop's cheapness can't offset.** Even in the heavy scenario, live-loop cost barely moves ($2.29 → $2.67) because it's architecturally fixed-cadence. The agent is where a "quiet, well-prepped, low-follow-up" meeting and a "deep-research-heavy, five-action-item" meeting diverge by an order of magnitude in total cost — and that divergence is *entirely* attributable to how much the user leans on the agent, not on the meeting harness.

**Framing for a founder:** the live meeting loop is a fixed-ish cost of doing business (cheap, predictable, gets cheaper as model providers compete). The agent is a *discretionary, high-variance* cost the user chooses to spend by asking for deep prep, in-meeting research delegation, or thorough follow-up execution. That's exactly the shape of cost structure you want if you're about to design a pricing tier: charge a low flat rate for the thing that's cheap and predictable, and meter (or gate behind a plan) the thing that's expensive and elective.

---

## 7. GTM / Pricing Implications

### 7.1 Where the margin is (and isn't)

- **Today: no margin risk, because no COGS.** BYOK means every dollar of the §4 cost model is paid by the user directly to Anthropic/OpenAI/Google/OpenRouter. CallingClaw's revenue (if any, today) is decoupled from usage entirely.
- **The moment CallingClaw fronts API costs (managed-keys tier), margin risk is concentrated almost entirely in the agent.** The live loop's worst case (~$2.67/meeting) is a rounding error next to the agent's worst case ($5–15+/meeting, uncapped by any hard token ceiling — only turn-count ceilings). A managed tier that doesn't meter or cap agent usage is pricing blind into its single largest and most volatile cost line.
- **Vision is the biggest live-loop line item and the easiest one to compress.** At ~$1.2–1.9/meeting it's 60-70% of the live-loop subtotal, and the range itself (§3 image-token uncertainty) suggests real, uncaptured margin sitting in "does OpenRouter actually downscale the `detail:low` hint." Worth instrumenting before setting managed-tier pricing, not after.

### 7.2 What to meter and charge for

- **Meter the agent, not the meeting.** Turn count and/or output tokens per agent invocation (prep / recall / task / follow-up) is the single highest-leverage metering unit — it's where 80%+ of a heavy meeting's cost sits, and it's already discretely bucketed by the adapter's own method calls (`generateMeetingPrep`, `executeTask`, `executeTodo`, `processTimeline`), which map cleanly to product-visible actions ("deep prep," "research this," "handle my follow-ups").
- **Don't meter the live loop — flat-rate or bundle it.** At ~$0.07-0.08/min in the default configuration, the live loop is cheap enough that per-minute metering would be more overhead (billing complexity, user anxiety about "the clock running") than it's worth. This is the basis for "pay only for meetings that worked" (§7.3, Tier 1) being affordable: the thing you're eating the cost of not charging for is a $2-3 line item, not a $20 one.
- **Make voice-provider choice a pricing lever, not just a config toggle.** §4.4 and §5's caveat show OpenAI Realtime uncached can cost more than Pika's entire avatar bill. If/when a managed tier exists, default every paying customer to the cheap provider (Gemini/Grok) and gate the expensive one (OpenAI Realtime, uncached) behind an explicit "premium voice" opt-in or a plan tier — this alone protects more margin than most usage caps would.

### 7.3 Concrete tiering ideas

1. **Free / cheap voice-only base + metered agent usage.** A flat low price (or free) tier covers the live loop unmetered (voice + vision + auditor + retriever + light computer-use, defaulted to the cheap voice provider) — genuinely affordable per §4.2's ~$2.30/meeting midpoint. Agent-heavy actions (deep prep beyond a basic brief, in-meeting research delegation, automated follow-up execution) are metered separately or gated to a paid plan. This directly matches the cost shape: cheap+predictable stays free/flat, expensive+discretionary gets priced.
2. **"Pay only for meetings that worked" as the headline, backed by the live-loop number, not the agent number.** Given the live loop is ~$2-3/meeting even on the heavy side, a per-successful-meeting price (e.g., a flat fee triggered only on a completed join + transcript + summary) is affordable to eat as a acquisition/retention cost even before charging anything — it's a rounding error against typical SaaS CAC. Reserve any success-based refund/credit guarantee for the live loop's failure modes (join failures, audio dropouts) specifically, since that's the bounded-cost surface; don't extend the same guarantee to agent-driven follow-up work, whose cost (and hence refund exposure) is unbounded by comparison.
3. **Usage-based add-on for "agent depth," sold as a capability not a token count.** Rather than exposing raw tokens/turns (meaningless to a buyer), sell tiers like "Standard prep" (capped turns, Haiku-tier or capped Sonnet-tier, ~$0.50-1/meeting COGS) vs. "Deep prep + follow-through" (full 10-15 turn Sonnet ceiling, multi-meeting research carryover, ~$5-15/meeting COGS) as distinct plan features. This keeps the pricing story simple for the buyer while mapping 1:1 to the actual cost driver identified in §6, and gives room to raise the ceiling (more turns, higher-tier model) as a premium-plan lever without re-architecting anything.

---

## 8. Validation Path

This is an a-priori model built from code constants, Anthropic's published rate card, and cross-validated third-party estimates for OpenAI/Gemini/Runway. The widest uncertainty bands are (a) actual image-token cost for screenshots (§3), and (b) actual per-turn agent token consumption (§4.1, §6) — both are exactly the kind of thing that's unmeasurable from static code and needs runtime data.

A sibling engineering lane is building a **CostMeter** that logs actual per-component token usage to JSONL at runtime (per-meeting, per-component: voice minutes, vision calls, auditor calls, retriever calls, computer-use calls, agent turns — each with real token counts and computed $ at the rates in §3). Once that lands, the empirical validation path is: replace every "ESTIMATE" range in §3-§4 with the observed distribution from real meetings, keep the FACT rows (Anthropic rate card) as-is, and re-derive §7's tiering thresholds against real cost distributions rather than reasoned ranges. This doc does not depend on CostMeter's code or existence — it's the model CostMeter will confirm or correct.

---

## 9. Appendix — Assumptions Ledger

| Assumption | Where used | Confidence |
|---|---|---|
| AI speaks ~30% of meeting duration | Voice cost split (in vs. out audio) | Medium — reasonable for a participant that mostly listens/assists |
| Vision runs for full meeting regardless of sharing | §2.2, §4 | **High** — confirmed in code (`callingclaw.ts:412-414`) |
| Vision call fires unconditionally every 3s | §2.2, §4 | **High** — confirmed in code (`vision.ts:208-212`), similarity dedup only affects usage not billing |
| ~40 auditor calls / 30-min meeting | §4.1 | Low-medium — genuinely meeting-dependent; stated as a working assumption, not derived from a fixed rate |
| ~30/8/3 ContextRetriever layer triggers | §4.1 | Low-medium — same caveat; derived loosely from the char-threshold/interval constants, not measured |
| Computer-use light=2, heavy=12 calls | §4.1 | Low — fully on-demand, no code-derived base rate; purely illustrative bookends |
| Agent light=8 turns, heavy=~70 turns | §4.1, §6 | Low-medium — turn *ceilings* are code facts (10/15 max per call type); turns *realized* in practice are a guess |
| $0.03-$0.12 effective $/agent-turn | §4.1, §6, §7 | **Lowest confidence in the doc** — no per-turn token measurement exists yet; flagged explicitly as the #1 target for CostMeter |
| Screenshot image tokens 1,200-2,800 | §3 | Low-medium — formula is Anthropic-documented fact, but whether OpenRouter/Anthropic honors the `detail:"low"` hint for a non-OpenAI model, and thus which end of the range applies, is unverified |
| Runway $/credit and credits/sec | §3, §5 | Low — third-party web estimate, not from Runway's own current pricing page in this session, and not specific to a "Characters Meet" avatar-stream product (general Gen-4/4.5 video credit rates) |
| Grok Voice ~$0.05/min | §3, §4.4 | Low — sourced only from an in-code comment, not independently web-verified this session |
