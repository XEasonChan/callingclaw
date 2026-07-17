// CallingClaw 2.0 — TranscriptAuditor (System 2 Intent Classification)
//
// Replaces OpenAI Realtime's unreliable tool-calling for automation during meetings.
// Monitors the live transcript and uses Claude (Haiku) to classify user intent
// with meeting context awareness, then dispatches to AutomationRouter.
//
// Architecture:
//   User speaks → Whisper STT → SharedContext.transcript
//                                       ↓
//                            TranscriptAuditor (debounced)
//                                       ↓
//                            Claude Haiku intent classification
//                            (transcript + meeting brief context)
//                                       ↓
//                     confidence ≥ 0.85 → auto-execute via AutomationRouter
//                     confidence 0.6-0.85 → suggest via Voice AI liveNote
//                     confidence < 0.6 → ignore

import type { SharedContext, TranscriptEntry } from "./shared-context";
import type { EventBus } from "./event-bus";
import type { AutomationRouter } from "./automation-router";
import type { ComputerUseModule } from "./computer-use";
import type { VoiceModule } from "./voice";
import type { MeetJoiner } from "../meet_joiner";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { notifyTaskCompletion, pushContextUpdate } from "../voice-persona";
import { callModel, parseJSON } from "../ai_gateway/llm-client";
import { CONFIG } from "../config";
import { PAGE_EXTRACT_JS, formatPageContext } from "../utils/page-extract";
import { extractMatchTokens, countTokenHits } from "../utils/text-match";

// ── Types ──

export interface AuditResult {
  action: string | null;
  params: Record<string, any>;
  confidence: number;
  reasoning: string;
  targetTab?: "presenting" | "meet";
}

// Tools that the auditor takes over during meetings (removed from OpenAI session)
export const AUDITOR_MANAGED_TOOLS = new Set([
  "computer_action",
  "browser_action",
  // share_screen & stop_sharing: kept in Realtime tool list — users say "投屏/share screen"
  // directly, and Realtime should handle it (not routed through Auditor's async pipeline).
  // open_file: also kept — users say "打开文件" directly.
  // Auditor manages only the autonomous tools (computer_action, browser_action).
]);

// ── Cross-lane dedup: action families (pure helpers, unit-tested) ──

/** Entry in the recent-actions ring buffer. Both lanes (Realtime voice tools
 * and Auditor fast/medium lane) normalize into this shape so an action
 * executed by one lane suppresses the other lane re-executing it. */
export interface RecentActionEntry {
  action: string;        // tool/action name as executed (either lane)
  family: string | null; // action family (see ACTION_FAMILIES); null = exact-key dedup only
  key: string;           // exact dedup key (action + params snippet)
  target: string;        // distinguishing target text (url/query/path/selector) for family dedup
  ts: number;            // execution timestamp (ms)
}

/** An action executed within this window suppresses a same-family, same-target
 * execution from the other lane (Realtime handles "打开定价页" in 200ms; the
 * Auditor classifies it ~1.5-3s later — without this it opens the same page
 * twice). 8s covers that Realtime→Auditor lag with margin; a wider window
 * (was 15s) started swallowing genuinely new requests. */
export const DEDUP_WINDOW_MS = 8_000;

// Action families for cross-lane dedup. Two actions in the same family
// within DEDUP_WINDOW_MS with overlapping targets are "the same thing already
// handled" (see isDuplicateAction — a family match alone is NOT enough).
// Groupings:
// - present: everything that changes WHAT is shown to the meeting. In this
//   codebase open_file / open_url / search_and_open all funnel to
//   /api/screen/share just like share_* — so Realtime open_file must suppress
//   Auditor share_file / search_and_open (same page would land twice).
//   search_files is deliberately NOT here: it only LISTS matching paths (its
//   result instructs "Use open_file to open one"), so it must not suppress
//   the follow-up open_file/share_file that actually presents something.
// - navigate: own family — navigating the presenting page to a NEW url right
//   after a share is legitimate, so it must not collide with `present`.
// - research: recall_context (Realtime, internal memory) and research_task
//   (Auditor, external web) answer the same user question — never run both.
// - stop_share / mute / camera: toggles — firing twice undoes the action.
// Repeatable actions (scroll*, clicks, tab switches) are exempt from dedup
// entirely (see isRepeatableAction) and intentionally have no family.
const ACTION_FAMILIES: Record<string, string> = {
  // present: open/search/share all end up presenting content
  open_file: "present",
  open_url: "present",
  search_and_open: "present",
  share_screen: "present",
  share_url: "present",
  share_file: "present",
  "zoom:start_share": "present",
  // navigate: presenting-tab URL change, separate from present (see above)
  navigate: "navigate",
  // stop sharing
  stop_sharing: "stop_share",
  "zoom:stop_share": "stop_share",
  // meeting toggles
  meet_mute: "mute",
  "meet:toggle_mute": "mute",
  "zoom:toggle_mute": "mute",
  meet_camera: "camera",
  "meet:toggle_video": "camera",
  "zoom:toggle_video": "camera",
  // research: internal recall + external research answer the same question
  research_task: "research",
  recall_context: "research",
};

export function actionFamily(action: string): string | null {
  return ACTION_FAMILIES[action] ?? null;
}

/** Repeatable actions are never dedup-suppressed — "scroll down" x3 means
 * scroll 3 times, and "next tab" x2 means advance two tabs. */
export function isRepeatableAction(action: string): boolean {
  return (
    action.startsWith("scroll") ||
    action === "browser_click" ||
    action === "click" ||
    action === "next_tab" ||
    action === "prev_tab" ||
    action === "switch_tab"
  );
}

/** Distinguishing target text for an action — what the action operates ON
 * (url/query/path/selector, falling back to a raw instruction). Used by the
 * family dedup to tell "打开PRD" apart from "打开pitch deck". */
export function actionTarget(params: Record<string, any> | undefined): string {
  if (!params) return "";
  return String(params.url ?? params.query ?? params.path ?? params.selector ?? params.instruction ?? "");
}

/** Pure dedup check: is `action` a duplicate of a recent execution?
 * Same FAMILY within the window → duplicate ONLY if the targets overlap
 * (share match tokens) or the new action carries no distinguishing target —
 * "打开PRD" then "打开pitch deck" are both `present` but must BOTH run.
 * Unfamilied actions fall back to exact-key match within the window. */
export function isDuplicateAction(
  action: string,
  key: string,
  ring: readonly RecentActionEntry[],
  now: number = Date.now(),
  target: string = "",
): boolean {
  if (isRepeatableAction(action)) return false;
  const family = actionFamily(action);
  const targetTokens = extractMatchTokens(target);
  for (const e of ring) {
    if (now - e.ts > DEDUP_WINDOW_MS) continue;
    if (family !== null && e.family === family) {
      // No distinguishing target on the new action ("share the screen") →
      // trust the family match. Otherwise require token overlap with the
      // recent entry's target before suppressing.
      if (targetTokens.length === 0) return true;
      if (countTokenHits(targetTokens, e.target) > 0) return true;
      continue; // same family, different target → not a duplicate
    }
    if (e.key === key) return true;
  }
  return false;
}

// ── Pre-gate: ack/filler utterances (pure helper, unit-tested) ──

// Single ack/filler token — bare acknowledgments never carry actionable intent
const ACK_TOKEN_RE = /^(嗯+|哦+|噢|好的?|好啊|好呀|是的?|对的?|对啊|ok|okay|yep|yes|yeah|sure|没问题|行|可以|谢谢|thanks|thank you)$/i;

/** Pure ack/filler utterances ("嗯", "好的，没问题", "OK") skip the audit
 * pipeline entirely — no fast lane, no LLM call. Compound utterances are
 * gated only if EVERY comma-separated segment is an ack, so
 * "好的，帮我打开PRD" is NOT gated (it carries a verb after the ack). */
export function isAckOrFiller(text: string): boolean {
  const segments = (text || "")
    .split(/[,，、;；]+/)
    .map((s) => s.replace(/[。.!！?？~～\s]+$/g, "").trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every((s) => ACK_TOKEN_RE.test(s));
}

// ── Static system block for intent classification ──
// Built once at module load and sent via `callModel({ system, cacheSystem })`
// so OpenRouter/Anthropic prompt caching can reuse it across audits (the
// per-meeting context — prep files, presentation state, transcript — goes in
// the dynamic user message instead). Keep this block STABLE: any edit
// invalidates the cache.
//
// CACHING STATUS: this block is ~1.4K tokens, BELOW Anthropic's minimum
// cacheable prefix of 4096 tokens for Haiku-tier models (Sonnet-tier: 1024).
// cache_control is accepted but silently ignored, so caching is currently
// INERT for this prompt — it activates only if this block grows past the
// minimum or a Sonnet-tier ANALYSIS_MODEL is configured. Watch the
// "[LLM] cache: created=X read=Y" log line (llm-client.ts) for activation.
const CLASSIFY_SYSTEM = `You are CallingClaw's meeting agent — a fast background assistant. You monitor the conversation and execute actions when the voice AI or participants request something.

## Your Tools (choose the RIGHT one)

### File & URL Tools
- **search_and_open**: Search for a file by fuzzy name, then open it in browser. Use when someone asks to open/show/find a file but doesn't give an exact path. Params: { "query": "keywords to search for", "app": "browser" }
- **open_url**: Open an exact URL. Use when a full URL is mentioned. Params: { "url": "https://..." }
- **open_file**: Open a file by exact path. Only use if you know the full path. Params: { "path": "/abs/path", "app": "browser"|"vscode" }

### Screen Sharing Tools
- **share_url**: Open a URL and present it in the meeting (screen share). Params: { "url": "https://..." }
- **share_file**: Search for a SPECIFIC named file and present it in the meeting. Only when concrete content is named. Params: { "query": "keywords" }
- **stop_sharing**: Stop presenting. Params: {}

### Presenting Tab Tools (operate on the currently shared content)
- **click**: Click a button/link on the presenting page. Params: { "selector": "button text or link text", "targetTab": "presenting" }
- **scroll**: Scroll the presenting page. Params: { "direction": "up"|"down", "targetTab": "presenting" }
- **navigate**: Navigate the presenting page to a new URL. Params: { "url": "https://...", "targetTab": "presenting" }

### Meeting Control Tools
- **share_screen**: Start sharing (no URL = entire screen). "共享一下屏幕" / "share the screen" with no specific file or page named → share_screen, NOT share_file. Params: {}
- **meet_mute**: Toggle mute. Params: {}
- **meet_camera**: Toggle camera. Params: {}

### Research Tools (background, 10-30s)
- **research_task**: Delegate web research to the background agent. ONLY for genuinely EXTERNAL/current information. Params: { "query": "what to research" }
  USE research_task for:
    - "search X/Twitter for Y" (external web search)
    - "what are people saying about Z" (public opinion)
    - "find recent news about Q" (current events)
  DO NOT use research_task for INTERNAL-memory questions — our own products, our meetings, past decisions, our metrics, or competitor analyses the team already did. Those belong to recall_context (handled elsewhere, NOT your job) → action=null:
    - "what did we discuss about X" → null (meeting history)
    - "what was the decision on Y" → null (meeting history)
    - "竞品有哪些？他们和我们的差异是什么？" → null (the team's own competitive analysis)
    - "look up in our files" → search_and_open (local files), not research

## When to Act
1. Someone asks to open, show, display, share screen, or find something → ACT (search_and_open, share_file, open_url)
2. Someone says "点击/click/登录/login/下一步/next" → ACT (click on presenting tab)
3. Someone says "往下/scroll down/翻页" → ACT (scroll)
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT (your cue!)
5. Discussion/opinion (expressing views, suggestions for future) → DO NOT ACT, confidence=0
6. Bare acknowledgments AND acceptances of an action the AI itself just OFFERED → DO NOT ACT, action=null. The Realtime voice AI owns actions it offered; if you also act, the action executes twice. Example: AI says "需要我把定价页打开吗？", user replies "好的，没问题" → action=null. Same for "是/好的/对/嗯/OK/sure/没问题".
7. **ALREADY HANDLED**: If you see [Tool Call] or [Tool Result] in the transcript for the same action → DO NOT ACT, confidence=0. The voice AI already executed it.
8. **When in doubt, don't act.** A bad action (clicking the wrong thing, opening the wrong file) is worse than a missed action. Only act when you're confident the user wants something done.
9. **Internal vs external research**: Questions about OUR OWN products, meetings, past decisions, metrics, or analyses the team already did are internal-memory questions → action=null. research_task is ONLY for live web/social/news. When uncertain between internal and external → action=null.
10. "共享一下屏幕" / "share the screen" with no specific content named → share_screen, NOT share_file.

## STT Name Aliases (speech-to-text often mangles these)
The transcription is from live STT, which frequently misspells proper nouns. Default examples (a meeting-specific list may appear in the user message):
- CallingClaw = "calling claw" / "colin claw" / "calling call" / "calling clause"
- OpenClaw = "open claw" / "open call" / "open clause"
When a fuzzy match to a known product/person/term appears, interpret it as the canonical name.

## File Name Resolution Examples
- "landing page html" / "官网html" → search "callingclaw-landing.html" or "callingclaw-landing"
- "vision page" → search "vision.html"
- "meeting summary" → search "meeting-summary"
- "PRD" / "需求文档" → search "PRD" or "callingclaw-v2.5-PRD"
- "prep file" / "会议准备" → search in ~/.callingclaw/shared/prep/

Respond with JSON only. Keep "reasoning" to 10 words or fewer:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<≤10 words>","targetTab":"presenting"|"meet"}`;

// ── Agent-Address Fast Lane (deterministic, no LLM) ──
//
// When a user EXPLICITLY addresses the background agent
// ("让agent查一下X" / "ask the agent to look up X"), the classification is
// unambiguous — waiting 1200ms of debounce plus a 0.3-1.2s Haiku round-trip
// is pure overhead. These patterns detect that explicit address and route
// straight to the research_task execution path with confidence 1.0.
//
// Precision rules (false positives auto-trigger research, so be strict):
//   - An explicit agent/AI/助手 token is REQUIRED. A bare "查一下X" or
//     "search for X" must NOT match — those go through the normal Haiku lane.
//   - Queries that reference local files / meeting recall fall through to the
//     Haiku lane (it has prep + screen context to pick search_and_open /
//     recall_context instead of web research).
//   - Hypothetical / deferred phrasing ("如果…", "比如…", "how do we get the
//     AI to search…") falls through to the Haiku lane.

// Research verbs. zh: reduplications + compound verbs first, then bare 查/搜/找.
// 查(?!看) so "查看一下屏幕" (view the screen) never reads as bare 查.
// The trailing (?!了) rejects past/completed aspect — "查了一下竞品" reports past
// research, it doesn't request new research (and used to extract the garbage
// query "了一下竞品"). The extra per-verb lookaheads (查(?!…询), 搜(?!…索))
// stop the bare verb from re-matching the first char of a compound that the
// trailing (?!了) just rejected (e.g. "查询了" must not become 查 + "询了…").
const AGENT_VERBS_ZH =
  "(?:查查|找找|搜搜|查询|查詢|搜索|搜寻|搜尋|研究|调研|調研|查(?!看|查|询|詢|了)|搜(?!索|寻|尋|搜|了)|找(?!找|了))(?:一下|下)?(?!了)";
// en: longer forms before bare "find".
const AGENT_VERBS_EN =
  "look\\s+up|look\\s+into|search(?:\\s+(?:for|about))?|research|find\\s+out(?:\\s+about)?|investigate|dig\\s+into|check\\s+out|find";
// Agent tokens — compound forms first so "AI助手" doesn't stop at "AI".
// The IMPERATIVE form drops bare 助手/助理: "麻烦助理查一下会议室安排" almost
// certainly addresses a HUMAN assistant. Unambiguous AI compounds stay.
const AGENT_TOKEN_IMPERATIVE = "(?:ai\\s*助手|智能助手|agent|ai|智能体|智能體)";
// The punctuation-anchored VOCATIVE form ("助手，查一下…") keeps 助手/助理 —
// an utterance-initial token followed by punctuation is unambiguous enough.
const AGENT_TOKEN_VOCATIVE = "(?:ai\\s*助手|智能助手|agent|ai|助手|助理|智能体|智能體)";

// Internal matcher list. `checkPrefix: true` marks the imperative forms whose
// regex is not ^-anchored: matchAgentResearchAddress() additionally requires
// the trigger to sit at (or near) the utterance start AND runs the
// negation/reported-speech guard on the text before the trigger.
const ADDRESS_MATCHERS: Array<{ re: RegExp; checkPrefix: boolean }> = [
  // zh imperative: 让/叫/请/麻烦 + agent/AI (+去/来/帮我/帮忙/再) + verb + query
  //   "让agent查一下竞品定价" / "请AI搜索最新的行业报告"
  {
    checkPrefix: true,
    re: new RegExp(
      `(?:让|讓|叫|请|請|麻烦|麻煩)\\s*(?:那个|那個|这个|這個|你的|你们的|你們的|我们的|我們的|咱们的|咱們的)?\\s*${AGENT_TOKEN_IMPERATIVE}\\s*(?:去|来|來)?\\s*(?:帮我|幫我|帮忙|幫忙)?\\s*(?:再)?\\s*(?:${AGENT_VERBS_ZH})\\s*(.*)`,
      "i",
    ),
  },
  // zh direct address (needs punctuation after the token): "agent，查一下X" / "助手：搜索一下Y"
  {
    checkPrefix: false,
    re: new RegExp(
      `^\\s*${AGENT_TOKEN_VOCATIVE}\\s*[,，:：、]\\s*(?:请|請)?\\s*(?:帮我|幫我|帮忙|幫忙)?\\s*(?:${AGENT_VERBS_ZH})\\s*(.*)`,
      "i",
    ),
  },
  // en imperative: ask/tell/get the agent TO <verb> + query, or have the agent (to) <verb>.
  // "to" is REQUIRED for ask/tell/get — without it, incidental "get AI search
  // working" phrasings match with no actual address.
  {
    checkPrefix: true,
    re: new RegExp(
      `\\b(?:(?:ask|tell|get)\\s+(?:the\\s+|your\\s+|our\\s+)?(?:agent|ai|assistant)\\s+to\\b|have\\s+(?:the\\s+|your\\s+|our\\s+)?(?:agent|ai|assistant)\\s+(?:to\\s+)?)\\s*(?:please\\s+)?(?:go\\s+)?(?:${AGENT_VERBS_EN})\\s+(.+)`,
      "i",
    ),
  },
  // en direct address with punctuation: "Agent, look up X" / "AI: search for Y"
  {
    checkPrefix: false,
    re: new RegExp(
      `^\\s*(?:hey\\s+|okay\\s+|ok\\s+)?(?:agent|ai|assistant)\\s*[,，:：]\\s*(?:please\\s+)?(?:can\\s+you\\s+)?(?:${AGENT_VERBS_EN})\\s+(.+)`,
      "i",
    ),
  },
  // en "hey agent …" is unambiguous even without punctuation
  {
    checkPrefix: false,
    re: new RegExp(
      `^\\s*hey\\s+(?:agent|ai|assistant)[,，]?\\s+(?:please\\s+)?(?:${AGENT_VERBS_EN})\\s+(.+)`,
      "i",
    ),
  },
];

export const AGENT_ADDRESS_PATTERNS: RegExp[] = ADDRESS_MATCHERS.map((m) => m.re);

// Queries about local files / meeting memory → NOT web research. Fall through
// to the Haiku lane, which has context to route search_and_open/recall_context.
const LOCAL_CONTEXT_GUARD =
  /(?:文件|文档|文檔|档案|檔案|资料库|資料庫|会议记录|會議記錄|会议纪要|會議紀要|刚才|剛才|之前(?:说|說|讨论|討論|提到)|\bfiles?\b|\bfolders?\b|\bdocs?\b|\bdocuments?\b|\bour\s+(?:notes?|meetings?|repo)\b|\bwhat\s+we\s+(?:discussed|said|decided)\b)/i;

// Hypothetical / deferred / meta discussion / declarative plans → don't
// auto-fire research NOW. (Matched against the FULL utterance, not just the
// query — "让AI搜索变得更快是我们的目标" carries the plan marker AFTER the trigger.)
const DISCUSSION_GUARD =
  /(?:how\s+(?:do|would|can|could)\s+(?:we|you|i)\b|how\s+to\b|can\s+we\b|could\s+we\b|should\s+we\b|would\s+be\b|it'?d\s+be\b|it\s+would\b|imagine\b|for\s+example|e\.g\.|whether\b|we\s+want\s+to\b|we'?re\s+(?:trying|planning|hoping)\s+to\b|let'?s\b|要是|如果|假如|比如|比方|例如|以后|以後|将来|將來|下次|回头|回頭|我们的目标|我們的目標|目标是|目標是)/i;

// Negation / reported-speech / instructional phrasing scanned in the window
// BEFORE the trigger. Any hit means the utterance is not a live request:
//   "别让agent搜索这个" / "不用让agent查了" / "don't ask the agent to search"
//   "当用户说让agent搜索…" / "she says ask the agent to…" / "你可以让agent查…"
const PRE_TRIGGER_GUARD =
  /(?:别|別|不要|不用|甭|无需|無需|不必|先不|说|說|你可以|您可以|\bdon'?t\b|\bdo\s+not\b|\bdidn'?t\b|\bdid\s+not\b|\bnever\b|\bwon'?t\b|\bwouldn'?t\b|\bshouldn'?t\b|\bno\s+need\b|\bsays?\b|\bsaid\b|\bsaying\b)/i;

// The imperative (non-^-anchored) forms must sit at or near the utterance
// start. Allowed lead-in: short spoken fillers, then an optional first-person
// subject ("我让agent查一下X" is a live request; "昨天我让agent查了…" is not).
const LEADING_FILLER_RE =
  /^(?:(?:那个|那個|那|嗯+|好的|好|呃+|哦|欸|诶|誒|嘿|okay|ok|so|um+|uh+|well|alright|right|yeah|yes|please|hey|hi|hello)[\s,，、!！.。:：]*)*(?:我们|我們|咱们|咱們|我)?[\s,，、]*$/i;

/** True when a mid-sentence-capable trigger is effectively utterance-initial. */
function isTriggerAnchored(prefix: string): boolean {
  if (LEADING_FILLER_RE.test(prefix)) return true;
  // A fresh clause right after sentence punctuation also counts as
  // utterance-initial ("关于竞品定价的情况，让agent查一下").
  return /[,，。;；!！?？:：、]\s*$/.test(prefix);
}

/** Strip leading/trailing punctuation and trailing politeness filler. */
function cleanExtractedQuery(raw: string): string {
  let q = (raw || "").trim();
  q = q.replace(/^[\s,，.。:：;；、!！?？'"''""()（）\-—]+/, "");
  // Two passes: filler can hide behind trailing punctuation ("…吧。", "…, thanks")
  for (let i = 0; i < 2; i++) {
    q = q.replace(/[\s,，.。:：;；、!！?？'"''""]+$/, "");
    q = q.replace(/(?:吧|呗|呢|哈|啊|好吗|好嗎|行吗|行嗎|可以吗|可以嗎|谢谢|謝謝|thanks|thank\s+you|please)$/i, "");
  }
  return q.trim();
}

/**
 * Detect an explicit agent-address research request. Deterministic — no LLM.
 * Returns the extracted query, or null when the utterance should go through
 * the normal (regex fast lane + debounced Haiku) pipeline instead.
 */
export function matchAgentResearchAddress(text: string): { query: string } | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length < 4) return null;
  if (DISCUSSION_GUARD.test(t)) return null;

  for (const { re, checkPrefix } of ADDRESS_MATCHERS) {
    const m = t.match(re);
    if (!m) continue;
    if (checkPrefix) {
      const prefix = t.slice(0, m.index ?? 0);
      // Precision over recall: a mid-sentence trigger ("在demo里你可以让agent
      // 查一下天气") is NOT a live address — fall through to the Haiku lane,
      // which still handles genuine requests, just slower.
      if (!isTriggerAnchored(prefix)) continue;
      // Negation / reported speech before the trigger → not a live request.
      if (PRE_TRIGGER_GUARD.test(prefix)) continue;
    }
    let query = cleanExtractedQuery(m[1] || "");
    if (!query) {
      // Fallback: current sentence minus the trigger phrase
      const trigger = m[0].slice(0, m[0].length - (m[1]?.length || 0));
      query = cleanExtractedQuery(t.replace(trigger, " "));
    }
    if (!query || query.length < 2) return null; // nothing to research
    if (LOCAL_CONTEXT_GUARD.test(query)) return null; // local files / recall → Haiku lane
    return { query };
  }
  return null;
}

// ── Module ──

export class TranscriptAuditor {
  private context: SharedContext;
  private eventBus: EventBus;
  private automationRouter: AutomationRouter;
  private computerUse: ComputerUseModule;
  private meetingPrepSkill: MeetingPrepSkill;
  private meetJoiner: MeetJoiner;
  private chromeLauncher: any = null; // ChromeLauncher instance for presenting tab operations
  private voice: VoiceModule | null = null;
  private orchestrator: import("./action-orchestrator").ActionOrchestrator | null = null;
  private agentAdapter: any = null; // AgentAdapter for research_task delegation

  private _active = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastAuditedTs = 0;
  private _processing = false;
  private _recentActions: RecentActionEntry[] = []; // cross-lane dedup ring buffer (last 8)
  private _lastExecutionTs = 0;
  private _fastLaneProcessing = false; // prevent concurrent fast lane executions
  private _lastAgentFastLaneTs = 0; // cooldown anchor for the agent-address fast lane
  private _researchGeneration = 0; // incremented on deactivate() to cancel stale research callbacks
  private _activeResearch = new Map<string, number>(); // in-flight research: normalized query → taskId timestamp
  private _consumedUtterances = new Set<string>(); // agent fast-lane consumed entries (ts:text) — excluded from Haiku audit window

  // ── Tuning knobs ──
  private DEBOUNCE_MS = 1200;         // Wait 1.2s after last user utterance (was 2.5s, reduced for meeting responsiveness)
  private FAST_LANE_CONFIDENCE = 0.95; // Regex match threshold for immediate execution (no LLM)
  private CONFIDENCE_AUTO = 0.85;     // Auto-execute threshold
  private CONFIDENCE_SUGGEST = 0.6;   // Suggest to Voice AI threshold
  private WINDOW_ENTRIES = 15;        // Transcript entries to analyze
  private COOLDOWN_MS = 3000;          // Short cooldown (3s) to batch rapid speech. Dedup relies on ring buffer, not this timer.

  constructor(opts: {
    context: SharedContext;
    eventBus: EventBus;
    automationRouter: AutomationRouter;
    computerUse: ComputerUseModule;
    meetingPrepSkill: MeetingPrepSkill;
    meetJoiner: MeetJoiner;
    chromeLauncher?: any;
    orchestrator?: import("./action-orchestrator").ActionOrchestrator;
    agentAdapter?: any;
  }) {
    this.context = opts.context;
    this.eventBus = opts.eventBus;
    this.automationRouter = opts.automationRouter;
    this.computerUse = opts.computerUse;
    this.meetingPrepSkill = opts.meetingPrepSkill;
    this.meetJoiner = opts.meetJoiner;
    this.chromeLauncher = opts.chromeLauncher || null;
    this.orchestrator = opts.orchestrator || null;
    this.agentAdapter = opts.agentAdapter || null;
  }

  get active() {
    return this._active;
  }

  // ── Lifecycle ──

  /** Activate auditor when a meeting starts */
  activate(voice: VoiceModule) {
    if (this._active) return;
    this.voice = voice;
    this._active = true;
    this._lastAuditedTs = Date.now();
    this._recentActions = [];
    this._lastExecutionTs = 0;
    this._lastAgentFastLaneTs = 0;
    this._consumedUtterances.clear();

    // Subscribe to transcript events
    this.context.on("transcript", this._onTranscript);

    // Listen for Realtime tool calls → add to dedup ring buffer so Auditor
    // doesn't re-execute the same action that Realtime already handled.
    // Without this, user says "打开MCP文档" → Realtime calls open_file (200ms)
    // → Auditor classifies as search_and_open (1.5s later) → opens same file again.
    // Stored as a field so deactivate() can unsubscribe (was leaking one
    // listener per meeting).
    this.eventBus.on("voice.tool_call", this._onVoiceToolCall);

    // Build file alias index with prep context so AutomationRouter can instantly
    // resolve file paths the voice AI references from the meeting prep brief
    const brief = this.meetingPrepSkill.currentBrief;
    if (brief) {
      const prepFiles = [
        ...(brief.filePaths || []).map((f: any) => ({ path: f.path, description: f.description || "" })),
        ...(brief.browserUrls || []).map((u: any) => ({ path: u.url, description: u.description || "" })),
      ];
      this.automationRouter.fileIndex.build({ prepFilePaths: prepFiles }).catch(() => {});
    } else {
      // No prep yet — build with directory scan only, rebuild when prep arrives
      this.automationRouter.fileIndex.build().catch(() => {});
    }

    console.log("[TranscriptAuditor] Activated — monitoring transcript for automation intent");
    this.eventBus.emit("auditor.activated", {});
  }

  /** Rebuild file index when prep arrives mid-meeting */
  refreshPrepContext() {
    if (!this._active) return;
    const brief = this.meetingPrepSkill.currentBrief;
    if (!brief) return;
    const prepFiles = [
      ...(brief.filePaths || []).map((f: any) => ({ path: f.path, description: f.description || "" })),
      ...(brief.browserUrls || []).map((u: any) => ({ path: u.url, description: u.description || "" })),
    ];
    this.automationRouter.fileIndex.build({ prepFilePaths: prepFiles }).catch(() => {});
    console.log("[TranscriptAuditor] Rebuilt file index with prep context");
  }

  /** Deactivate auditor when meeting ends */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    // Unsubscribe listeners to prevent leaking handlers across meetings
    this.context.off("transcript", this._onTranscript);
    this.eventBus.off("voice.tool_call", this._onVoiceToolCall);
    this.automationRouter.fileIndex.clear();
    this._researchGeneration++; // Cancel any in-flight research callbacks from this meeting
    this._activeResearch.clear();
    this._consumedUtterances.clear();
    this.voice = null;
    console.log("[TranscriptAuditor] Deactivated (research gen: ${this._researchGeneration})");
    this.eventBus.emit("auditor.deactivated", {});
  }

  // ── Event handlers (arrow fns to preserve `this`) ──

  private _onVoiceToolCall = (data: any) => {
    const tool = data?.tool || "";
    const key = `realtime:${tool}:${JSON.stringify(data?.summary || data?.instruction || "").slice(0, 80)}`;
    // Target text for family dedup — voice.tool_call emitters pass the payload
    // as summary (share_screen/open_file/search_files), instruction
    // (computer_action) or query (recall_context)
    const target = String(data?.summary ?? data?.instruction ?? data?.query ?? "").slice(0, 120);
    this.rememberAction(tool, key, target);
    // Don't set global cooldown here — ring buffer handles dedup for same actions.
    // Global cooldown would block DIFFERENT actions (e.g., "open PRD" → "open Pika")
    console.log(`[TranscriptAuditor] Dedup: Realtime executed ${tool} — added to ring buffer`);
  };

  /** Push an executed action into the cross-lane dedup ring (max 8 entries) */
  private rememberAction(action: string, key: string, target: string = "") {
    this._recentActions.push({ action, family: actionFamily(action), key, target, ts: Date.now() });
    if (this._recentActions.length > 8) this._recentActions.shift();
  }

  private _onTranscript = (entry: TranscriptEntry) => {
    if (!this._active) return;
    if (entry.role !== "user") return; // Only audit on user speech

    // ── PRE-GATE: pure ack/filler ("嗯", "好的", "OK") never carries intent ──
    // Skip both lanes — no fast lane, no scheduleAudit (saves an LLM call).
    // Deliberately does NOT touch the debounce timer: an ack right after
    // substantive speech must not reset (or cancel) the already-scheduled audit.
    if (isAckOrFiller(entry.text)) return;

    // ── AGENT FAST LANE: explicit agent address → research_task, no debounce, no LLM ──
    // "让agent查一下X" / "ask the agent to look up X": the user explicitly
    // addressed the background agent, so classification is unambiguous.
    // Dispatch immediately (async — never blocks this handler) and consume
    // the utterance: skip both the regex fast lane and the debounced Haiku
    // audit. Saves ~1.7-2.4s (1200ms debounce + 0.3-1.2s Haiku round-trip).
    const agentAddress = matchAgentResearchAddress(entry.text);
    if (agentAddress) {
      // Mark the utterance consumed BEFORE the async dispatch: a debounce
      // timer from a previous utterance may fire in between, and its Haiku
      // window would otherwise still contain "让agent查一下X" — the prompt
      // tells the model to research such requests, so it would re-dispatch
      // with rephrased params that byte-compare dedup can't catch.
      this.markUtteranceConsumed(entry);
      void this.tryAgentFastLane(entry.text, agentAddress.query);
      return;
    }

    // ── FAST LANE: regex pre-check, 0ms debounce ──
    // If AutomationRouter regex matches with high confidence, execute immediately
    // without waiting for Haiku LLM call. Target: <500ms from utterance to action.
    const intent = this.automationRouter.classify(entry.text);
    if (intent.confidence >= this.FAST_LANE_CONFIDENCE && intent.layer !== "computer_use") {
      this.tryFastLane(entry.text, intent);
      // Don't return — medium lane still runs (action + retrieval are not exclusive)
      // but scheduleAudit will be skipped via dedup if fast lane executed the same action
    }

    this.scheduleAudit();
  };

  private scheduleAudit() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.runAudit(), this.DEBOUNCE_MS);
  }

  /** Key matching a transcript entry in the consumed-utterance set. */
  private utteranceKey(e: TranscriptEntry): string {
    return `${e.ts}:${e.text}`;
  }

  /**
   * Record an utterance the agent fast lane consumed so subsequent Haiku
   * audits exclude it from their transcript window (FINDING-3 fix: prevents
   * the next audit from re-dispatching the same research with rephrased params).
   */
  private markUtteranceConsumed(e: TranscriptEntry) {
    this._consumedUtterances.add(this.utteranceKey(e));
    // Bound the set — the audit window is only WINDOW_ENTRIES long
    while (this._consumedUtterances.size > 40) {
      const oldest = this._consumedUtterances.values().next().value;
      if (oldest === undefined) break;
      this._consumedUtterances.delete(oldest);
    }
  }

  // ── Fast Lane: regex-only execution, no LLM call ──

  /**
   * Execute an action immediately based on regex match, bypassing the Haiku LLM call.
   * Only fires for high-confidence patterns (click, scroll, mute, etc.).
   * Target latency: <500ms from utterance to execution.
   */
  private async tryFastLane(
    text: string,
    intent: import("./automation-router").ClassifiedIntent,
  ) {
    if (this._fastLaneProcessing) return;

    // Action-level dedup (not utterance-level — a single utterance can trigger
    // both fast lane action AND slow lane retrieval).
    // Same action FAMILY + overlapping target executed by either lane within
    // DEDUP_WINDOW_MS → skip. Repeatable actions (scroll/click/tab) are
    // exempt — "scroll down" x3 means scroll 3 times.
    const actionKey = `${intent.action}:${JSON.stringify(intent.params)}`;
    const target = actionTarget(intent.params);
    if (isDuplicateAction(intent.action, actionKey, this._recentActions, Date.now(), target)) {
      console.log(`[TranscriptAuditor] Skipping duplicate: ${actionKey}`);
      return;
    }
    // For repeatable actions, enforce a 2s cooldown to prevent STT chunk duplication
    if (isRepeatableAction(intent.action) && Date.now() - this._lastExecutionTs < 2000) return;

    this._fastLaneProcessing = true;
    const startTs = Date.now();

    try {
      this.eventBus.emit("auditor.fast_lane", {
        action: intent.action,
        layer: intent.layer,
        confidence: intent.confidence,
        text: text.slice(0, 60),
      });

      // For click/scroll on presenting tab, use ChromeLauncher directly
      if (
        (intent.action === "browser_click" || intent.action.startsWith("scroll")) &&
        this.chromeLauncher?.presentingPage
      ) {
        const result = await this.executeAction({
          action: intent.action === "browser_click" ? "click" : "scroll",
          params: {
            selector: text,
            direction: intent.action === "scroll_up" ? "up" : "down",
            targetTab: "presenting",
          },
          confidence: intent.confidence,
          reasoning: `fast_lane: ${intent.reason}`,
          targetTab: "presenting",
        });
      } else {
        // Route through AutomationRouter for other actions (meet shortcuts,
        // tab management, etc.) — serialized via the orchestrator so the fast
        // lane can't race a running ComputerUse loop, and an identical
        // voice-originated instruction coalesces instead of double-executing
        const runRouter = async () => {
          const r = await this.automationRouter.execute(text);
          return r.success ? r.result : `Error: ${r.result}`;
        };
        const summary = this.orchestrator
          ? await this.orchestrator.submit("auditor", text, runRouter)
          : await runRouter();

        if (!summary.startsWith("Error:") && this.voice?.connected && this.meetingPrepSkill.currentBrief) {
          // 方向A: silent injection only — the model picks up the [DONE] note on
          // its next natural turn instead of interrupting mid-sentence
          notifyTaskCompletion(this.voice, this.meetingPrepSkill, text, summary, this.eventBus);
        }
      }

      // Add to dedup ring buffer
      this.rememberAction(intent.action, actionKey, target);
      this._lastExecutionTs = Date.now();

      console.log(`[TranscriptAuditor] Fast lane: ${intent.action} (${Date.now() - startTs}ms)`);
    } catch (err: any) {
      console.error(`[TranscriptAuditor] Fast lane error: ${err.message}`);
    } finally {
      this._fastLaneProcessing = false;
    }
  }

  // ── Agent Fast Lane: explicit agent address → research_task, no LLM ──

  /**
   * Dispatch research immediately when the user explicitly addressed the
   * agent ("让agent查一下X" / "ask the agent to look up X"). Bypasses both
   * the 1200ms debounce and the Haiku classification — the query was already
   * extracted deterministically by matchAgentResearchAddress().
   *
   * Protections (mirrors the existing lanes):
   *   - dedup ring: exact query already dispatched recently → skip
   *   - COOLDOWN_MS between agent fast-lane dispatches — STT often re-emits
   *     the same sentence in expanding chunks with slightly different text,
   *     which exact-key dedup can't catch
   *   - in-flight guard + generation check live inside dispatchResearchTask
   */
  private async tryAgentFastLane(text: string, query: string) {
    if (!this._active || !query) return;

    const actionKey = `research_task:${JSON.stringify({ query })}`;
    // Exact-query dedup within the ring: only an IDENTICAL agent-address query
    // is a duplicate (different queries — "A股走势" vs "欧股走势" — must BOTH
    // dispatch). Rapid same/different STT re-chunks are gated by COOLDOWN_MS
    // below. rememberAction() stores entries as RecentActionEntry objects, so
    // match on `.key` (the string ring was replaced by the cross-lane object
    // ring in the intent-recognition refactor).
    if (this._recentActions.some((e) => e.key === actionKey)) {
      console.log(`[TranscriptAuditor] Agent fast lane: skipping duplicate ${actionKey}`);
      return;
    }
    if (Date.now() - this._lastAgentFastLaneTs < this.COOLDOWN_MS) {
      console.log(`[TranscriptAuditor] Agent fast lane: cooldown active, skipping "${query}"`);
      return;
    }
    this._lastAgentFastLaneTs = Date.now();
    const startTs = Date.now();

    try {
      this.eventBus.emit("auditor.fast_lane", {
        action: "research_task",
        layer: "agent",
        confidence: 1.0,
        text: text.slice(0, 60),
      });
      this.eventBus.emit("auditor.executing", {
        action: "research_task",
        params: { query },
        confidence: 1.0,
      });

      const { started, status } = await this.dispatchResearchTask(query);

      if (started) {
        this.rememberAction("research_task", actionKey, query);
        this._lastExecutionTs = Date.now();
      }
      console.log(
        `[TranscriptAuditor] Agent fast lane: research_task "${query}" → ${status} (${Date.now() - startTs}ms)`
      );
    } catch (err: any) {
      console.error(`[TranscriptAuditor] Agent fast lane error: ${err.message}`);
      this.eventBus.emit("auditor.error", { action: "research_task", error: err.message });
    }
  }

  // ── Research dispatch (shared by medium lane + agent fast lane) ──

  /**
   * Dispatch a research_task to the background agent. Returns quickly —
   * the agent work itself is fire-and-forget; results land via
   * voice.injectContext / replaceContext and research.* EventBus events.
   * Codex findings #1-16: full production-safe implementation.
   */
  /**
   * Normalization for the in-flight research guard. Whitespace-split
   * normalization is useless for Chinese (no word spaces): strip ALL
   * whitespace + punctuation and compare the raw char sequence instead.
   */
  private normalizeResearchQuery(q: string): string {
    const n = q
      .toLowerCase()
      .replace(/[\s　,，.。:：;；、!！?？'"''""()（）\[\]【】《》<>\-—_·~`]+/g, "");
    return n || q.toLowerCase().trim();
  }

  private async dispatchResearchTask(query: string): Promise<{ started: boolean; status: string }> {
    const taskId = `research_${Date.now()}`;
    const normalizedQuery = this.normalizeResearchQuery(query);

    // #6: Agent disconnected → emit proper research events, not generic done
    if (!this.agentAdapter?.connected) {
      this.eventBus.emit("research.started", { taskId, query });
      this.eventBus.emit("research.completed", { taskId, query, error: "No agent connected" });
      // #12: Don't push to dedup ring on failure
      return { started: false, status: "No agent available for research" };
    }

    // #11: In-flight guard — prevent duplicate research. Containment-based:
    // "查一下竞品定价" and "竞品定价" are the same request rephrased, and
    // exact-compare on a whitespace split never catches that in Chinese.
    for (const [existingQuery, ts] of this._activeResearch) {
      if (Date.now() - ts >= 120000) continue;
      if (
        existingQuery === normalizedQuery ||
        existingQuery.includes(normalizedQuery) ||
        normalizedQuery.includes(existingQuery)
      ) {
        return { started: false, status: `Research already running: "${query}"` };
      }
    }
    this._activeResearch.set(normalizedQuery, Date.now());

    // Capture generation for stale callback detection (#4)
    const gen = this._researchGeneration;

    // 1. Emit started → S2 panel shows task card
    this.eventBus.emit("research.started", { taskId, query });

    // 2. Tell voice AI (non-blocking)
    if (this.voice?.connected) {
      this.voice.injectContext(`[RESEARCH_STARTED] Searching: ${query}`);
    }

    // 3. Delegate to slow brain (fire-and-forget, don't block the auditor)
    this.agentAdapter.executeTask(
      `Search the web for: "${query}". Find relevant posts, articles, or discussions. ` +
      `Summarize the top 3-5 findings with key opinions and sources. Be concise.`
    ).then(async (result: string) => {
      // #4: Check generation — if meeting changed, discard stale result
      if (gen !== this._researchGeneration) {
        console.log(`[Auditor] Research result discarded (stale, gen ${gen} vs ${this._researchGeneration})`);
        return;
      }
      this._activeResearch.delete(normalizedQuery);

      // #5: Check for error/timeout patterns in result string
      const ERROR_PATTERNS = /timed out|no external agent|failed|error:|unavailable|billing error/i;
      if (ERROR_PATTERNS.test(result) && result.length < 200) {
        if (this.voice?.connected) {
          this.voice.injectContext(`[RESEARCH] Search for "${query}" returned an error: ${result.slice(0, 200)}`);
        }
        this.eventBus.emit("research.completed", { taskId, query, error: result.slice(0, 200) });
        console.warn(`[Auditor] Research error detected: "${query}" → ${result.slice(0, 100)}`);
        return;
      }

      // 4. Save as Working Document
      const filePath = `${process.env.HOME}/.callingclaw/shared/research-${Date.now()}.md`;
      await Bun.write(filePath, `# Research: ${query}\n\n${result}`);
      this.context.addStageDocument(filePath, "new");
      // #7: Emit EventBus event so Stage WS listener picks up the new doc
      this.eventBus.emit("stage.documents_updated", { filePath, badge: "new" });

      // #15: Use replaceContext with fixed ID — don't accumulate in FIFO
      if (this.voice?.connected) {
        this.voice.replaceContext(`[RESEARCH] ${query}\n\n${result.slice(0, 1200)}`, "ctx_research_result");
        // #2/#3: Don't force response.create — queue it, only flush when voice is idle
        if (this.voice.audioState === "listening") {
          this.voice.client.sendEvent("response.create", {});
        } else {
          this.voice.client.queuePendingResponse();
        }
      }

      // 6. Emit completed → S2 shows ✅
      this.eventBus.emit("research.completed", {
        taskId, query, filePath,
        resultPreview: result.slice(0, 200),
      });
      console.log(`[Auditor] Research completed: "${query}" → ${filePath}`);
    }).catch((err: any) => {
      if (gen !== this._researchGeneration) return; // #4: Stale
      this._activeResearch.delete(normalizedQuery);
      if (this.voice?.connected) {
        this.voice.injectContext(`[RESEARCH] Search for "${query}" failed: ${err.message}`);
      }
      this.eventBus.emit("research.completed", { taskId, query, error: err.message });
      console.error(`[Auditor] Research failed: "${query}"`, err.message);
    });

    return { started: true, status: `Research dispatched: "${query}"` };
  }

  // ── Core audit loop (medium lane — Haiku LLM) ──

  private async runAudit() {
    if (!this._active || this._processing) return;

    // Cooldown: don't fire too rapidly
    if (Date.now() - this._lastExecutionTs < this.COOLDOWN_MS) return;

    // Exclude utterances the agent fast lane already consumed — they were
    // fully handled; letting Haiku see them again causes duplicate dispatch.
    const entries = this.context
      .getRecentTranscript(this.WINDOW_ENTRIES)
      .filter((e) => !this._consumedUtterances.has(this.utteranceKey(e)));

    // Only audit if there are new user entries since last audit
    const hasNewUserSpeech = entries.some(
      (e) => e.role === "user" && e.ts > this._lastAuditedTs
    );
    if (!hasNewUserSpeech) return;

    this._processing = true;
    this._lastAuditedTs = Date.now();

    try {
      const result = await this.classifyIntent(entries);

      if (!result.action) return; // No actionable intent

      // Dedup: skip if either lane just executed this action's FAMILY with an
      // overlapping target (repeatable actions exempt — see isDuplicateAction)
      const actionKey = `${result.action}:${JSON.stringify(result.params)}`;
      const target = actionTarget(result.params);
      if (isDuplicateAction(result.action, actionKey, this._recentActions, Date.now(), target)) {
        console.log(`[TranscriptAuditor] Skipping duplicate: ${actionKey}`);
        return;
      }

      this.eventBus.emit("auditor.intent", {
        action: result.action,
        params: result.params,
        confidence: result.confidence,
        reasoning: result.reasoning,
      });

      if (result.confidence >= this.CONFIDENCE_AUTO) {
        // ── High confidence → auto-execute ──
        console.log(
          `[TranscriptAuditor] Auto-executing: ${result.action} (confidence: ${result.confidence})`
        );
        await this.executeAction(result);
        this.rememberAction(result.action, actionKey, target);
        this._lastExecutionTs = Date.now();
      } else if (result.confidence >= this.CONFIDENCE_SUGGEST) {
        // ── Medium confidence → suggest to Voice AI ──
        console.log(
          `[TranscriptAuditor] Suggesting: ${result.action} (confidence: ${result.confidence})`
        );
        this.suggestAction(result);
      }
      // Below threshold → silent ignore
    } catch (err: any) {
      console.error("[TranscriptAuditor] Audit error:", err.message);
      this.eventBus.emit("auditor.error", { error: err.message });
    } finally {
      this._processing = false;
    }
  }

  // ── Intent Classification (Claude Haiku) ──

  private async classifyIntent(
    entries: TranscriptEntry[]
  ): Promise<AuditResult> {
    const brief = this.meetingPrepSkill.currentBrief;

    const transcriptText = entries
      .map(
        (e) =>
          `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`
      )
      .join("\n");

    // Context enrichment: give Haiku full picture (screen + prep + recent actions)
    const screenDesc = this.context?.screen?.description || "";
    const pageUrl = this.context?.screen?.url || "";
    const recentActions = this._recentActions.slice(-3).map((e) => e.action).join(", ");
    const prepTopic = brief?.topic || "";
    const enrichment = [
      screenDesc ? `[Current screen: ${screenDesc.slice(0, 120)}]` : "",
      pageUrl ? `[Page URL: ${pageUrl}]` : "",
      recentActions ? `[Recent actions: ${recentActions}]` : "",
      prepTopic ? `[Meeting topic: ${prepTopic}]` : "",
    ].filter(Boolean).join("\n");
    const enrichedTranscript = enrichment ? `${enrichment}\n\n${transcriptText}` : transcriptText;

    // Dynamic per-meeting context only — the static role/tools/rules block
    // lives in CLASSIFY_SYSTEM (module constant) so prompt caching can reuse it
    const prompt = `## Known Files & URLs (from meeting prep)
${
  brief
    ? [
        ...(brief.filePaths || []).map((f: any) => `- File: ${f.path} (${f.description})`),
        ...(brief.browserUrls || []).map((u: any) => `- URL: ${u.url} (${u.description})`),
        ...(brief.scenes || []).map((s: any, i: number) => `- Scene ${i + 1}: ${s.url}${s.scrollTarget ? ` → ${s.scrollTarget}` : ""}`),
      ].join("\n") || "- (no files or URLs in prep)"
    : "- (no meeting brief)"
}
- Shared files: ~/.callingclaw/shared/

## Current Presentation State
${(() => {
  const scene = this.context.currentScene;
  if (scene) {
    return `ACTIVELY PRESENTING Scene ${scene.index + 1}/${scene.total}: ${scene.url}
Current scroll target: ${scene.scrollTarget || "top"}
When user says "click/scroll" — operate on THIS page (${scene.url})`;
  }
  return "Not currently presenting any page.";
})()}

## Meeting Context
${
  brief
    ? `Topic: ${brief.topic}
Goal: ${brief.goal}
Recent actions: ${
        (brief.liveNotes || [])
          .filter((n: string) => n.startsWith("[DONE]"))
          .join("; ") || "none"
      }`
    : "No meeting brief loaded."
}
${(() => {
  const bc = this.context.browserContext;
  return bc ? `Active page: ${bc.title} (${bc.url})` : "";
})()}
${
  brief?.sttAliases && brief.sttAliases.length > 0
    ? `\n## STT Name Aliases (from prep — treat as equivalent)
${brief.sttAliases.map((a: any) => `- ${a.canonical} = ${a.variants.map((v: string) => `"${v}"`).join(" / ")}`).join("\n")}\n`
    : ""
}
## Transcript (most recent at bottom, with current screen + action context)
${enrichedTranscript}`;

    // Use shared LLM client instead of duplicated API call code
    try {
      const text = await callModel(prompt, {
        model: CONFIG.analysis.model,
        // 192, not 128: params with long URLs + the JSON envelope can exceed
        // 128 tokens, and parseJSON needs the closing brace to survive
        maxTokens: 192,
        system: CLASSIFY_SYSTEM,
        cacheSystem: true, // static block → Anthropic prompt caching via OpenRouter
      });
      const parsed = parseJSON<{
        action?: string;
        params?: Record<string, any>;
        confidence?: number;
        reasoning?: string;
        targetTab?: string;
      }>(text);
      if (!parsed) {
        return { action: null, params: {}, confidence: 0, reasoning: "parse_error: no JSON found" };
      }
      return {
        action: parsed.action || null,
        params: parsed.params || {},
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reasoning: parsed.reasoning || "",
        targetTab: (parsed.targetTab as "presenting" | "meet") || "presenting",
      };
    } catch (err: any) {
      console.warn(`[TranscriptAuditor] LLM call failed: ${err.message}`);
      return { action: null, params: {}, confidence: 0, reasoning: `llm_error: ${err.message}` };
    }
  }

  // ── DOM-Aware Click Resolution ──

  /**
   * Two-step click: snapshot clickable elements from live DOM, then use Haiku
   * to pick the right one based on user intent. Clicks by index — no guessing.
   *
   * Flow:
   *   1. Playwright snapshots all clickable elements (text + aria-label + tag)
   *   2. Haiku sees the list + user's intent → returns the index to click
   *   3. Playwright clicks element[index] — guaranteed correct target
   *
   * Fallback: if Haiku is unavailable or snapshot fails, falls back to
   * naive text matching (the old behavior).
   */
  private async resolveAndClick(userIntent: string): Promise<string> {
    if (!this.chromeLauncher?.presentingPage) return "not_found: no presenting page";

    // Step 1: Snapshot clickable elements from live DOM
    let elements: Array<{ text: string; aria: string; tag: string; href?: string }>;
    try {
      const raw = await this.chromeLauncher.evaluateOnPresentingPage(`(() => {
        var els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], [onclick]'));
        return JSON.stringify(els.slice(0, 30).map(function(el, i) {
          return {
            text: (el.textContent || '').trim().substring(0, 60),
            aria: (el.getAttribute('aria-label') || ''),
            tag: el.tagName.toLowerCase(),
            href: el.getAttribute('href') || undefined,
          };
        }));
      })()`);
      elements = JSON.parse(String(raw));
    } catch (e: any) {
      console.warn(`[Auditor] Click snapshot failed: ${e.message}`);
      return "not_found: snapshot failed";
    }

    if (elements.length === 0) return "not_found: no clickable elements";

    // Step 2: Haiku picks the right element
    const elementList = elements.map((el, i) =>
      `${i + 1}. [${el.tag}] "${el.text}"${el.aria ? ` aria="${el.aria}"` : ""}${el.href ? ` href="${el.href}"` : ""}`
    ).join("\n");

    let clickIndex = -1;
    try {
      const response = await callModel({
        model: "fast",
        system: "You are a click resolver. Given a user's intent and a list of clickable DOM elements, return ONLY the number of the element to click. If no element matches, return 0.",
        prompt: `User wants to click: "${userIntent}"\n\nClickable elements on page:\n${elementList}`,
        maxTokens: 10,
        temperature: 0,
      });
      clickIndex = parseInt(String(response).trim()) - 1;
    } catch {
      // Haiku unavailable — fall back to naive text match
      clickIndex = elements.findIndex(el =>
        el.text.toLowerCase().includes(userIntent.toLowerCase()) ||
        el.aria.toLowerCase().includes(userIntent.toLowerCase())
      );
    }

    if (clickIndex < 0 || clickIndex >= elements.length) {
      console.log(`[Auditor] Click resolve: no match for "${userIntent}" in ${elements.length} elements`);
      return `not_found: "${userIntent}" — ${elements.length} clickable elements checked`;
    }

    // Step 3: Click by index with cursor animation — guaranteed correct target
    const target = elements[clickIndex]!;
    const clickResult = await this.chromeLauncher.evaluateOnPresentingPage(`(async () => {
      var els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], [onclick]'));
      var el = els[${clickIndex}];
      if (!el) return 'not_found: index out of range';
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (window.__ccCursor) { await window.__ccCursor.flyTo(x, y); window.__ccCursor.ripple(x, y); }
      el.click();
      return 'clicked:' + (el.textContent || '').trim().substring(0, 40);
    })()`);

    console.log(`[Auditor] Click resolved: "${userIntent}" → #${clickIndex + 1} [${target.tag}] "${target.text}" → ${clickResult}`);
    return String(clickResult);
  }

  // ── Action Execution ──

  private async executeAction(result: AuditResult) {
    const { action, params } = result;

    this.eventBus.emit("auditor.executing", {
      action,
      params,
      confidence: result.confidence,
    });

    let instruction = "";
    let executionResult = "";

    try {
      // Auditor medium-lane actions run through the ActionOrchestrator so
      // they serialize against voice-originated computer_action / HTTP tasks
      // (and get an AbortSignal slot for cooperative cancellation).
      const runSwitch = async (task?: import("./action-orchestrator").ActionTask) => {
      switch (action) {
        // ── File search + open (fuzzy name) ──
        case "search_and_open": {
          const query = params.query || "";
          instruction = `search and open: ${query}`;
          console.log(`[Auditor] Searching for file: "${query}"`);
          const searchResult = await this.automationRouter.execute(`open file: ${query}`);
          executionResult = searchResult.success ? searchResult.result : `File not found: "${query}"`;
          // Register found file as a stage document (avoids re-searching next time)
          if (searchResult.success && searchResult.filePath) {
            this.context.addStageDocument(searchResult.filePath, "new");
          }
          break;
        }

        // ── Share file (search + present in meeting) ──
        case "share_file": {
          const shareQuery = params.query || "";
          instruction = `share file: ${shareQuery}`;
          console.log(`[Auditor] Searching and sharing: "${shareQuery}"`);
          const shareResult = await this.automationRouter.execute(`share_screen file: ${shareQuery}`);
          if (!shareResult.success) {
            // Fallback: try direct share API with file search
            try {
              const resp = await fetch(`http://localhost:${CONFIG.port}/api/screen/share`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: undefined }), // will trigger file search in shareScreen
              });
              const data = await resp.json() as any;
              executionResult = data.success ? `Sharing: ${data.message}` : `Share failed`;
            } catch { executionResult = shareResult.result; }
          } else {
            executionResult = shareResult.result;
          }
          break;
        }

        // ── Share exact URL (open + present) ──
        case "share_url": {
          const shareUrl = params.url || "";
          instruction = `share URL: ${shareUrl}`;
          try {
            const resp = await fetch(`http://localhost:${CONFIG.port}/api/screen/share`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: shareUrl }),
            });
            const data = await resp.json() as any;
            executionResult = data.success ? `Presenting: ${shareUrl}` : `Share failed: ${data.message}`;
          } catch (e: any) { executionResult = `Share error: ${e.message}`; }
          break;
        }

        case "open_url": {
          const openUrl = params.url || "";
          instruction = `open ${openUrl} in browser`;
          // Prefer Playwright Chrome (same window as Meet) over system browser
          try {
            const resp = await fetch("http://localhost:4000/api/screen/share", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: openUrl }),
            });
            const data = await resp.json() as any;
            executionResult = data.success ? `Opened ${openUrl}` : `Share failed: ${data.message}`;
          } catch (e: any) {
            // Fallback: system browser
            const r = await this.automationRouter.execute(instruction);
            executionResult = r.success ? r.result : `Router failed: ${r.result}`;
          }
          break;
        }

        case "open_file": {
          // Fast path: use AutomationRouter's file search + open (not legacy osascript)
          const fileQuery = params.path || params.query || "";
          instruction = `open file: ${fileQuery}`;
          const fileResult = await this.automationRouter.execute(instruction);
          if (!fileResult.success) {
            // Fallback: try legacy meetJoiner
            try {
              await this.meetJoiner.openFile(params.path, params.app || "browser");
              executionResult = `Opened ${params.path}`;
            } catch { executionResult = fileResult.result; }
          } else {
            executionResult = fileResult.result;
          }
          break;
        }

        case "share_screen": {
          // Fast path: use ChromeLauncher screen share API (not legacy osascript)
          instruction = "start screen sharing";
          const shareUrl = params.url || undefined;
          try {
            const resp = await fetch(`http://localhost:${CONFIG.port}/api/screen/share`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: shareUrl }),
            });
            const shareData = await resp.json() as any;
            executionResult = shareData.success ? "Screen sharing started" : `Share failed: ${shareData.message}`;
          } catch {
            // Fallback: legacy meetJoiner
            const ok = await this.meetJoiner.shareScreen();
            executionResult = ok ? "Screen sharing started (legacy)" : "Failed to start screen sharing";
          }
          break;
        }

        case "stop_sharing": {
          instruction = "stop screen sharing";
          try {
            await fetch(`http://localhost:${CONFIG.port}/api/screen/stop`, { method: "POST" });
            executionResult = "Screen sharing stopped";
          } catch {
            await this.meetJoiner.stopSharing();
            executionResult = "Screen sharing stopped (legacy)";
          }
          break;
        }

        // ── Meeting controls (mute/camera via ChromeLauncher DOM) ──
        case "meet_mute": {
          instruction = "toggle mute";
          if (this.chromeLauncher?.page) {
            const r = await this.chromeLauncher.page.evaluate(`(() => {
              var btn = document.querySelector('[aria-label*="microphone" i], [aria-label*="麦克风"], [aria-label*="Mute" i], [aria-label*="静音"]');
              if (btn) { btn.click(); return 'toggled'; }
              return 'not_found';
            })()`);
            executionResult = String(r) === "toggled" ? "Toggled mute" : "Mute button not found";
          } else {
            executionResult = "No active meeting page";
          }
          break;
        }

        case "meet_camera": {
          instruction = "toggle camera";
          if (this.chromeLauncher?.page) {
            const r = await this.chromeLauncher.page.evaluate(`(() => {
              var btn = document.querySelector('[aria-label*="camera" i], [aria-label*="摄像头"], [aria-label*="视频"], [aria-label*="Turn off video" i], [aria-label*="Turn on video" i]');
              if (btn) { btn.click(); return 'toggled'; }
              return 'not_found';
            })()`);
            executionResult = String(r) === "toggled" ? "Toggled camera" : "Camera button not found";
          } else {
            executionResult = "No active meeting page";
          }
          break;
        }

        // ── Research delegation (background, async) ──
        // Dispatch body lives in dispatchResearchTask() — shared with the
        // explicit agent-address fast lane (tryAgentFastLane).
        case "research_task": {
          const query = params.query || "";
          if (!query) { executionResult = "No research query provided"; break; }
          await this.dispatchResearchTask(query);
          // #1: Return early — do NOT fall through to generic post-switch done path
          return;
        }

        case "click": {
          // Two-step click: snapshot clickable elements → resolve target → click by index
          instruction = `click: ${params.selector || params.instruction || ""}`;
          const clickTarget = params.selector || params.instruction || "";
          const targetClick = params.targetTab || result.targetTab || "presenting";
          if (targetClick === "presenting" && this.chromeLauncher?.presentingPage) {
            executionResult = await this.resolveAndClick(clickTarget);
          } else {
            const r = await this.automationRouter.execute(instruction);
            executionResult = r.result;
          }
          break;
        }

        case "scroll": {
          const scrollTarget = params.target || params.selector || "";
          const targetScroll = params.targetTab || result.targetTab || "presenting";
          instruction = scrollTarget ? `scroll to: ${scrollTarget}` : `scroll ${params.direction || "down"}`;

          if (targetScroll === "presenting" && this.chromeLauncher?.presentingPage) {
            if (scrollTarget) {
              // Smart scroll: find element by text and scrollIntoView
              const scrollResult = await this.chromeLauncher.evaluateOnPresentingPage(`(() => {
                var target = ${JSON.stringify(scrollTarget)};
                var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6,section,[id],p,div,span');
                for (var el of all) {
                  var text = (el.textContent || '').trim();
                  if (text.toLowerCase().includes(target.toLowerCase()) && text.length < 200) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return 'scrolled_to:' + text.substring(0, 60);
                  }
                }
                return 'not_found:' + target;
              })()`);
              executionResult = String(scrollResult);
              console.log(`[Auditor] Scroll to "${scrollTarget}": ${executionResult}`);
            } else {
              // Simple directional scroll
              await this.chromeLauncher.evaluateOnPresentingPage(
                `window.scrollBy({ top: ${params.direction === 'up' ? -500 : 500}, behavior: 'smooth' })`
              );
              executionResult = `Scrolled ${params.direction || "down"} on presenting tab`;
            }
          } else {
            const r = await this.automationRouter.execute(instruction);
            executionResult = r.result;
          }
          break;
        }

        case "navigate":
        case "computer_action":
        default: {
          instruction =
            params.instruction ||
            `${action} ${JSON.stringify(params)}`;

          // Check if action should target presenting tab
          const targetNav = params.targetTab || result.targetTab || "meet";
          if (targetNav === "presenting" && this.chromeLauncher?.presentingPage) {
            // Execute on presenting tab via ChromeLauncher
            const snapshot = await this.chromeLauncher.snapshotPresentingPage();
            console.log(`[Auditor] Presenting tab snapshot (${snapshot.length} chars)`);
            // For simple instructions, try direct evaluate
            const evalResult = await this.chromeLauncher.evaluateOnPresentingPage(`(() => {
              var instruction = ${JSON.stringify(instruction)};
              // Try clicking buttons/links matching the instruction
              var all = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], [tabindex]'));
              for (var el of all) {
                var t = (el.textContent || '').trim().toLowerCase();
                var a = (el.getAttribute('aria-label') || '').toLowerCase();
                var words = instruction.toLowerCase().split(/\\s+/);
                var matchCount = words.filter(function(w) { return w.length > 2 && (t.includes(w) || a.includes(w)); }).length;
                if (matchCount >= 2 || (words.length === 1 && (t.includes(words[0]) || a.includes(words[0])))) {
                  el.click();
                  return 'clicked:' + t.substring(0, 40);
                }
              }
              return 'no_match';
            })()`);
            executionResult = String(evalResult) !== 'no_match' ? String(evalResult) : `Presenting tab: no element matched "${instruction}"`;
            break;
          }

          // Default: route through L1→L2→L3, fallback to L4 Computer Use
          const r = await this.automationRouter.execute(instruction);

          if (r.success) {
            executionResult = r.result;
          } else if (this.computerUse.isConfigured) {
            // L4 fallback: full Computer Use agent loop (abortable when
            // running under the orchestrator)
            this.eventBus.emit("computer.task_started", {
              instruction,
              source: "auditor_l4",
            });
            const cuResult = await this.computerUse.execute(instruction, 15, task ? {
              signal: task.abort.signal,
              onStep: (d) => this.orchestrator?.progress(task.id, d),
            } : undefined);
            executionResult = cuResult.summary;
          } else {
            executionResult =
              "No automation layer could handle this instruction.";
          }
          break;
        }
      }
      return executionResult;
      };

      if (this.orchestrator) {
        executionResult = await this.orchestrator.submit(
          "auditor",
          `${action}: ${JSON.stringify(params).slice(0, 100)}`,
          (task) => runSwitch(task),
        );
      } else {
        executionResult = await runSwitch();
      }

      this.eventBus.emit("computer.task_done", {
        instruction,
        summary: executionResult,
        layer: "auditor",
        source: "transcript_auditor",
      });

      // ── Close the loop: inject result + DOM context → trigger voice to continue ──
      if (this.voice?.connected) {
        // 1. Push completion as live note (existing behavior)
        if (this.meetingPrepSkill.currentBrief) {
          notifyTaskCompletion(
            this.voice,
            this.meetingPrepSkill,
            instruction,
            executionResult,
            this.eventBus
          );
        } else {
          // No prep brief — inject directly
          this.voice.injectContext(`[DONE] ${action}: ${executionResult}`);
        }

        // 2. For visual actions: re-extract DOM and inject page context
        const visualActions = new Set(["click", "scroll", "navigate", "share_url", "share_file", "share_screen", "open_url"]);
        if (action && visualActions.has(action) && this.chromeLauncher?.presentingPage) {
          try {
            await new Promise(r => setTimeout(r, 500)); // wait for page settle
            const raw = await this.chromeLauncher.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
            const pageCtx = formatPageContext(raw);
            if (pageCtx) {
              this.voice.injectContext(pageCtx);
              console.log(`[TranscriptAuditor] DOM context injected after ${action} (${pageCtx.length} chars)`);
            }
          } catch (e: any) {
            console.warn(`[TranscriptAuditor] DOM extract failed after ${action}: ${e.message}`);
          }
        }

        // 3. Context already injected above (silent). NO response.create.
        // Model sees [DONE] + [PAGE] on next natural turn (user speech or presenter advance).
        // This prevents background actions from interrupting AI mid-sentence.
        console.log(`[TranscriptAuditor] Action done → context injected silently (no response.create)`);
      }

      console.log(
        `[TranscriptAuditor] Executed: ${action} → ${executionResult}`
      );
    } catch (err: any) {
      console.error(
        `[TranscriptAuditor] Execution failed: ${err.message}`
      );
      this.eventBus.emit("auditor.error", {
        action,
        error: err.message,
      });
    }
  }

  // ── Suggestion (medium confidence) ──

  private suggestAction(result: AuditResult) {
    if (!this.meetingPrepSkill.currentBrief) return;

    const note = `[SUGGEST] 检测到可能的意图: ${result.action} (${result.reasoning})。置信度: ${(result.confidence * 100).toFixed(0)}%。如需执行请向用户确认。`;
    this.meetingPrepSkill.addLiveNote(note);

    // Push updated context to Voice AI so it can ask the user
    if (this.voice?.connected) {
      pushContextUpdate(this.voice, this.meetingPrepSkill, this.eventBus);
    }

    this.eventBus.emit("auditor.suggest", {
      action: result.action,
      params: result.params,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
  }
}
