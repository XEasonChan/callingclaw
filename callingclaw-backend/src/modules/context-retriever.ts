// CallingClaw 2.0 — ContextRetriever (Event-Driven Meeting Knowledge补充)
//
// Architecture:
//   Realtime Voice ──(Whisper STT)──→ SharedContext.transcript
//                                           ↓
//                              ContextRetriever (event-driven)
//                                           ↓
//                              Fast model (Haiku / Gemini Flash) — two jobs:
//                                Job 1: Gap analysis — "对话提到了什么 prep 里没 cover 的？"
//                                Job 2: Semantic search — 从 MEMORY.md 检索相关内容
//                                           ↓
//                              session.update → 注入回 Realtime 模型
//
// All retrieval runs through fast models (Haiku 4.5 / Gemini 3.1 Flash) via OpenRouter.
// No OpenClaw in the meeting loop — too slow (Opus 2-10s). OpenClaw is for pre-meeting prep only.
//
// Two models configured for A/B testing:
//   CONFIG.analysis.model    — gap analysis (default: Haiku 4.5)
//   CONFIG.analysis.searchModel — semantic search (default: same as analysis model)
//
// Trigger logic (event-driven, NOT fixed-interval):
//   - Accumulate transcript chars since last analysis
//   - When threshold reached (~500 chars, ~2-4 min of dialogue)
//     OR when user asks a question → trigger analysis
//   - Minimum interval between analyses to avoid spam
//   - If model says no retrieval needed → zero extra cost

import type { SharedContext, TranscriptEntry } from "./shared-context";
import type { EventBus } from "./event-bus";
import type { VoiceModule } from "./voice";
import type { ContextSync } from "./context-sync";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { pushContextUpdate } from "../voice-persona";
import { callModel, parseJSON } from "../ai_gateway/llm-client";
import { CONFIG } from "../config";

// ── Types ──

/** Layer 1: What topic is being discussed right now? */
export interface TopicClassification {
  topic: string;        // e.g., "memdex blog performance"
  direction: string;    // e.g., "user asking about metrics and ROI"
  shifted: boolean;     // true if topic changed from last classification
}

/** Layer 2: What information does this topic need? (only runs on topic shift) */
export interface NeedInference {
  needsRetrieval: boolean;
  queries: string[];    // Need-based, not noun-based: "memdex blog conversion metrics Q1"
  reasoning: string;
}

// Combined result (backward-compatible)
export interface GapAnalysis {
  needsRetrieval: boolean;
  queries: string[];
  reasoning: string;
}

export interface RetrievedContext {
  query: string;
  content: string;
  retrievedAt: number;
}

// ── Module ──

export class ContextRetriever {
  private context: SharedContext;
  private eventBus: EventBus;
  private contextSync: ContextSync | null;
  private meetingPrepSkill: MeetingPrepSkill;
  private voice: VoiceModule | null = null;

  private _active = false;
  private _processing = false;

  // ── Accumulation state ──
  private _charsSinceLastAnalysis = 0;
  private _lastAnalysisTs = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastScreenUrl = "";  // Track URL changes to trigger analysis

  // ── Layer 1: Topic tracking ──
  private _currentTopic = "";           // Last classified topic
  private _currentDirection = "";       // What the user is trying to learn/decide
  private _topicStableSince = 0;        // When topic last changed (avoids re-retrieving)
  private _pendingQuestion = false;     // True when user asked a question (triggers cache lookup)

  // ── P1: Topic Prefetch Cache ──
  // When a topic shift triggers retrieval, ALL results are cached under the topic.
  // Follow-up questions within the same topic hit the cache (<1ms) instead of
  // making API calls. VoiceAgentRAG reports 316x speedup with this pattern.
  private _topicCache = new Map<string, RetrievedContext[]>();
  private TOPIC_CACHE_MAX_TOPICS = 5;   // Keep last N topics cached

  // ── Retrieved context accumulator ──
  private _retrievedContexts: RetrievedContext[] = [];

  // ── Tuning knobs ──
  // Strategy: aggressive silent retrieval. Cast a wide net so the Voice AI
  // "just knows" context naturally. Users should feel the AI gets smarter
  // as the meeting progresses, without ever seeing a "let me look that up" moment.
  private CHAR_THRESHOLD = 300;       // ~1-2 min of dialogue (was 500 — more aggressive)
  private MIN_INTERVAL_MS = 20_000;   // Min 20s between analyses (was 30s — faster cycles)
  private QUESTION_BOOST = true;      // Trigger immediately on user questions
  private DEBOUNCE_MS = 2000;         // Wait 2s after last utterance (was 3s — faster response)
  private MAX_RETRIEVED_CONTEXTS = 15; // Keep last N retrieved contexts (was 10 — wider coverage)

  constructor(opts: {
    context: SharedContext;
    eventBus: EventBus;
    contextSync?: ContextSync;
    meetingPrepSkill: MeetingPrepSkill;
  }) {
    this.context = opts.context;
    this.eventBus = opts.eventBus;
    this.contextSync = opts.contextSync ?? null;
    this.meetingPrepSkill = opts.meetingPrepSkill;
  }

  get active() { return this._active; }
  get retrievedContexts(): readonly RetrievedContext[] { return this._retrievedContexts; }

  // ── Lifecycle ──

  activate(voice: VoiceModule) {
    if (this._active) return;
    this.voice = voice;
    this._active = true;
    this._charsSinceLastAnalysis = 0;
    this._lastAnalysisTs = Date.now();
    this._retrievedContexts = [];
    this._lastScreenUrl = "";
    // Reset topic tracking state to prevent leakage from previous meetings
    this._topicCache.clear();
    this._currentTopic = "";
    this._currentDirection = "";
    this._topicStableSince = 0;
    this._pendingQuestion = false;

    this.context.on("transcript", this._onTranscript);
    this.context.on("screen", this._onScreenChange);

    console.log("[ContextRetriever] Activated — monitoring transcript + screen for knowledge gaps");
    this.eventBus.emit("retriever.activated", {});
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    // Unsubscribe listeners to prevent leaking handlers across meetings
    this.context.off("transcript", this._onTranscript);
    this.context.off("screen", this._onScreenChange);
    this.voice = null;
    console.log("[ContextRetriever] Deactivated");
    this.eventBus.emit("retriever.deactivated", {});
  }

  // ── Event handler ──

  private _onTranscript = (entry: TranscriptEntry) => {
    if (!this._active) return;
    if (entry.role === "system") return; // Skip tool call logs

    this._charsSinceLastAnalysis += entry.text.length;

    const isQuestion = this.QUESTION_BOOST && entry.role === "user" && this.looksLikeQuestion(entry.text);
    if (isQuestion) this._pendingQuestion = true;

    const shouldTrigger =
      this._charsSinceLastAnalysis >= this.CHAR_THRESHOLD || isQuestion;

    if (shouldTrigger && !this._processing) {
      this.scheduleAnalysis();
    }
  };

  /** Trigger analysis when screen URL/title changes significantly (e.g., new page shared) */
  private _onScreenChange = (screenState: any) => {
    if (!this._active) return;
    if (!screenState.description) return;

    // Only trigger on URL change (not every 1s screenshot update)
    const url = screenState.url || "";
    if (url && url !== this._lastScreenUrl && this._lastScreenUrl) {
      this._lastScreenUrl = url;
      // Treat as a significant context shift — boost char count to trigger analysis
      this._charsSinceLastAnalysis += this.CHAR_THRESHOLD;
      if (!this._processing) {
        this.scheduleAnalysis();
      }
    }
    this._lastScreenUrl = url;
  };

  /**
   * Detect utterances that signal a context need — not just literal questions,
   * but also discussion triggers like mentioning a project name, referencing
   * a past decision, or bringing up metrics. Cast a wide net so background
   * retrieval stays ahead of the conversation.
   */
  private looksLikeQuestion(text: string): boolean {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    return (
      // Literal questions
      trimmed.endsWith("?") ||
      trimmed.endsWith("？") ||
      /[吗呢么嘛][\s。？?]*$/.test(trimmed) ||
      /^(什么|怎么|为什么|哪|谁|几|多少|是不是|有没有|能不能)/.test(trimmed) ||
      // Discussion triggers — someone is referencing context the AI should have ready
      /之前|上次|当时|那个|记得/.test(trimmed) ||                     // past reference (zh)
      /last time|previously|remember when|back when/i.test(trimmed) || // past reference (en)
      /决定|决策|方案|架构|设计/.test(trimmed) ||                     // decision/architecture reference
      /数据|指标|成本|ROI|转化|metrics|numbers/i.test(trimmed) ||     // metrics reference
      /bug|issue|问题|修了|修复|fix/i.test(trimmed) ||               // bug reference
      /对比|竞品|compare|competitor/i.test(trimmed)                   // competitor reference
    );
  }

  private scheduleAnalysis() {
    const elapsed = Date.now() - this._lastAnalysisTs;
    if (elapsed < this.MIN_INTERVAL_MS) return;

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.runAnalysis(), this.DEBOUNCE_MS);
  }

  // ══════════════════════════════════════════════════════════════
  // Core analysis loop — Two-Layer Gap Detection
  //
  //   Layer 1: classifyTopic (~50 tokens out, ALWAYS runs)
  //     "What specific topic is being discussed right now?"
  //     → If same topic as last time → SKIP (context still adequate)
  //     → If topic shifted → proceed to Layer 2
  //
  //   Layer 2: inferNeeds (~100 tokens out, only on topic shift)
  //     "Given this topic + conversation direction, what information
  //      would help the AI respond better?"
  //     → Need-based queries: "memdex blog conversion metrics" not "memdex"
  //     → Then: semantic search → inject into Voice
  // ══════════════════════════════════════════════════════════════

  private async runAnalysis() {
    if (!this._active || this._processing) return;
    this._processing = true;
    this._lastAnalysisTs = Date.now();
    this._charsSinceLastAnalysis = 0;

    const startTs = Date.now();

    try {
      const entries = this.context.getRecentTranscript(20);
      if (entries.length < 2) return;

      // ── Layer 1: Topic Classification (cheap, always runs) ──
      const topicResult = await this.classifyTopic(entries);

      this.eventBus.emit("retriever.topic", {
        topic: topicResult.topic,
        direction: topicResult.direction,
        shifted: topicResult.shifted,
        durationMs: Date.now() - startTs,
      });

      const hadQuestion = this._pendingQuestion;
      this._pendingQuestion = false;

      if (!topicResult.shifted) {
        // ── Same topic: try cache if user asked a question ──
        if (hadQuestion && this._topicCache.has(this._currentTopic)) {
          const cached = this._topicCache.get(this._currentTopic)!;
          const lastUserText = entries.filter(e => e.role === "user").pop()?.text || "";
          const cacheHits = this.searchCache(cached, lastUserText);
          if (cacheHits.length > 0) {
            this.injectIntoVoice(cacheHits);
            console.log(`[ContextRetriever] Cache hit: ${cacheHits.length} results for question in "${this._currentTopic.slice(0, 30)}" (<1ms)`);
            this.eventBus.emit("retriever.cache_hit", {
              topic: this._currentTopic,
              resultsCount: cacheHits.length,
              question: lastUserText.slice(0, 60),
            });
          } else {
            console.log(`[ContextRetriever] Cache miss for question in "${this._currentTopic.slice(0, 30)}" — no relevant cached content`);
          }
        } else {
          console.log(`[ContextRetriever] L1: Same topic "${this._currentTopic.slice(0, 40)}" — skip (${Date.now() - startTs}ms)`);
        }
        return;
      }

      // ── Topic shifted ──
      this._currentTopic = topicResult.topic;
      this._currentDirection = topicResult.direction;
      this._topicStableSince = Date.now();
      console.log(`[ContextRetriever] L1: Topic shift → "${topicResult.topic}" (${topicResult.direction})`);

      // ── Layer 2: Need Inference (only on topic shift) ──
      const needsResult = await this.inferNeeds(entries, topicResult);

      this.eventBus.emit("retriever.analysis", {
        needsRetrieval: needsResult.needsRetrieval,
        queries: needsResult.queries,
        reasoning: needsResult.reasoning,
        durationMs: Date.now() - startTs,
      });

      if (!needsResult.needsRetrieval || needsResult.queries.length === 0) {
        console.log(`[ContextRetriever] L2: No gaps for "${topicResult.topic}" (${Date.now() - startTs}ms)`);
        return;
      }

      console.log(`[ContextRetriever] L2: ${needsResult.queries.length} need-based queries (${Date.now() - startTs}ms)`);

      // ── P2: Emit searching event for filler mechanism ──
      this.eventBus.emit("retriever.searching", {
        topic: topicResult.topic,
        direction: topicResult.direction,
        queries: needsResult.queries,
      });

      // ── Semantic search + inject + cache ──
      const searchStartTs = Date.now();
      const results = await this.semanticSearch(needsResult.queries);

      if (results.length === 0) {
        console.log(`[ContextRetriever] Search: no results (${Date.now() - searchStartTs}ms)`);
        return;
      }

      for (const r of results) this._retrievedContexts.push(r);
      while (this._retrievedContexts.length > this.MAX_RETRIEVED_CONTEXTS) this._retrievedContexts.shift();

      // ── P1: Cache results under current topic for follow-up questions ──
      this.cacheForTopic(topicResult.topic, results);

      this.injectIntoVoice(results);

      const totalMs = Date.now() - startTs;
      console.log(
        `[ContextRetriever] Done: ${results.length} contexts (L1: ${searchStartTs - startTs}ms, search: ${Date.now() - searchStartTs}ms, total: ${totalMs}ms)`
      );

      this.eventBus.emit("retriever.complete", {
        topic: topicResult.topic,
        queriesCount: needsResult.queries.length,
        resultsCount: results.length,
        totalMs,
      });
    } catch (err: any) {
      console.error("[ContextRetriever] Error:", err.message);
      this.eventBus.emit("retriever.error", { error: err.message });
    } finally {
      this._processing = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LLM calls — all go through OpenRouter for easy model switching
  // ══════════════════════════════════════════════════════════════

  // LLM calls now use shared callModel from ai_gateway/llm-client.ts

  // ══════════════════════════════════════════════════════════════
  // Layer 1: Topic Classification
  // ── Cheap (~50 tokens output), always runs ──
  // Answers: "What specific topic is being discussed RIGHT NOW?"
  // If topic hasn't changed → skip Layer 2 entirely (saves cost)
  // ══════════════════════════════════════════════════════════════

  private async classifyTopic(entries: TranscriptEntry[]): Promise<TopicClassification> {
    // Use only last 8 entries for topic classification (cheaper + more focused)
    const recent = entries.slice(-8);
    const transcriptText = recent
      .map((e) => `[${e.role}] ${e.text}`)
      .join("\n");

    const screen = this.context.screen;
    const screenLine = screen.description
      ? `[screen] ${screen.description}${screen.url ? ` (${screen.url})` : ""}`
      : "";

    const prompt = `What specific topic is being discussed RIGHT NOW in this meeting conversation?

${transcriptText}
${screenLine}

Previous topic: "${this._currentTopic || "none"}"

Reply with JSON only (no other text):
{"topic": "specific topic in 3-8 words", "direction": "what the user wants to know or decide", "shifted": true/false}

"shifted" = true ONLY if the topic is meaningfully different from the previous topic. Subtopic shifts within the same area count as shifted. Small talk → topic = "small talk", shifted = true only if previous wasn't small talk.`;

    try {
      const text = await callModel(prompt, {
        model: CONFIG.analysis.model,
        maxTokens: 100,
      });
      const parsed = parseJSON<{ topic?: string; direction?: string; shifted?: boolean }>(text);
      if (!parsed) return { topic: this._currentTopic, direction: "", shifted: false };
      return {
        topic: parsed.topic || this._currentTopic,
        direction: parsed.direction || "",
        shifted: this._currentTopic === "" ? true : !!parsed.shifted,
      };
    } catch {
      return { topic: this._currentTopic, direction: "", shifted: false };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Layer 2: Need Inference
  // ── Only runs when topic shifted ──
  // Instead of searching for nouns ("memdex"), infers what the
  // conversation NEEDS: "memdex blog conversion metrics Q1 2026"
  // ══════════════════════════════════════════════════════════════

  private async inferNeeds(
    entries: TranscriptEntry[],
    topic: TopicClassification,
  ): Promise<NeedInference> {
    const transcriptText = entries
      .map((e) => `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`)
      .join("\n");

    const screen = this.context.screen;
    const screenContext = screen.description
      ? `\n## Current Screen\n${screen.description}${screen.url ? ` (${screen.url})` : ""}${screen.title ? ` — ${screen.title}` : ""}`
      : "";

    const brief = this.meetingPrepSkill.currentBrief;
    const briefContext = brief
      ? `Meeting topic: ${brief.topic}\nPrep covers: ${brief.keyPoints.join("; ")}`
      : "No meeting brief.";

    const alreadyRetrieved = this._retrievedContexts.map((r) => r.query).join("; ") || "nothing yet";

    const prompt = `The meeting just shifted to a new topic. Determine what specific information would help the AI assistant respond well.

## New Topic
Topic: ${topic.topic}
Direction: ${topic.direction}

## Meeting Context
${briefContext}
Already retrieved: ${alreadyRetrieved}

## Recent Transcript
${transcriptText}
${screenContext}

## Task
Think about what the AI assistant NEEDS to know to be helpful on this topic.
- NOT: search for the noun that was mentioned ("memdex")
- YES: search for what the conversation needs ("memdex blog performance metrics and conversion data")

Ask yourself: "If I were the AI in this conversation, what specific facts, numbers, decisions, or history would I need to answer well?"

Return needsRetrieval=false if ANY of these apply:
- The prep brief already covers this topic adequately
- The topic is opinions/brainstorming (nothing factual to look up)
- The user mentioned something as a passing EXAMPLE to illustrate a point, not as a topic requiring follow-up (e.g., "比如之前的XX" / "like that time with XX" when the point is about something else)
- The reference is casual/parenthetical, not a request for information or action

Only return needsRetrieval=true when the conversation genuinely needs specific facts, numbers, decisions, or history that aren't in the prep brief.

## Output
JSON only:
{"needsRetrieval": true/false, "queries": ["need-based search query 1", "need-based search query 2"], "reasoning": "what info is missing and why it matters for this conversation"}

Max 3 queries. Each query should be a specific information need, not a keyword.`;

    try {
      const text = await callModel(prompt, {
        model: CONFIG.analysis.model,
        maxTokens: 256,
      });
      const parsed = parseJSON<{ needsRetrieval?: boolean; queries?: string[]; reasoning?: string }>(text);
      if (!parsed) return { needsRetrieval: false, queries: [], reasoning: "parse_error" };
      return {
        needsRetrieval: !!parsed.needsRetrieval,
        queries: Array.isArray(parsed.queries) ? parsed.queries.slice(0, 3) : [],
        reasoning: parsed.reasoning || "",
      };
    } catch {
      return { needsRetrieval: false, queries: [], reasoning: "parse_error" };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Step 3: Agentic Search (Haiku/Gemini with tool_use)
  // ══════════════════════════════════════════════════════════════
  //
  // Mini Claude Code agent: the model gets tools to browse the
  // OpenClaw workspace (~/.openclaw/workspace/) and autonomously
  // decides which files to read, searches content, and synthesizes
  // a concise answer. Same capability as OpenClaw but runs on
  // Haiku/Gemini Flash — 10-50x faster, 100x cheaper.

  private static readonly WORKSPACE_DIR = `${process.env.HOME}/.openclaw/workspace`;
  private static readonly MAX_TOOL_ROUNDS = 5; // Max agentic iterations (increased from 3)
  private static readonly AGENT_TIMEOUT_MS = 15_000; // 15s hard cap (increased from 8s)

  /** Get prep dir and knowledge dir from user config, with defaults */
  private static get SHARED_DIR(): string {
    try { return require("../config").SEARCH_PATHS?.prepDir || `${process.env.HOME}/.callingclaw/shared`; } catch { return `${process.env.HOME}/.callingclaw/shared`; }
  }
  private static get PREP_DIR(): string {
    const base = ContextRetriever.SHARED_DIR;
    return `${base}/prep`;
  }
  private static get KNOWLEDGE_DIR(): string {
    try { return require("../config").SEARCH_PATHS?.knowledgeDir || ""; } catch { return ""; }
  }

  /** Tool definitions for the agentic search agent */
  private static readonly SEARCH_TOOLS = [
    {
      name: "list_workspace",
      description: "List all files in the knowledge workspace + meeting prep/shared directories. Returns filenames with sizes. Call this first to see what's available.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "read_file",
      description: "Read a file from the workspace, prep directory, shared directory, or a prep-referenced file. Returns content (truncated if large). Use for MEMORY.md, prep briefs, meeting notes, and files mentioned in the meeting prep.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string" as const, description: "Filename or relative path (e.g. 'MEMORY.md', 'prep/meeting-prep-callingclaw.md', or a full path from prep references)" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_files",
      description: "Search across workspace, prep, and shared files for a keyword/phrase. Returns matching lines with filenames. Good for finding which file contains specific info.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "Search term (case-insensitive)" },
        },
        required: ["query"],
      },
    },
  ];

  /**
   * Agentic search: Haiku/Gemini autonomously browses the workspace.
   * Falls back to simple MEMORY.md keyword search if no API key or agent fails.
   */
  private async semanticSearch(queries: string[]): Promise<RetrievedContext[]> {
    // Path 0: Check prep brief sections first (instant, no API cost)
    const brief = this.meetingPrepSkill.currentBrief;
    if (brief) {
      const prepResults: RetrievedContext[] = [];
      const remainingQueries: string[] = [];
      const sections = [
        brief.architectureDecisions?.map((d) => `${d.decision}: ${d.rationale}`).join("\n") || "",
        brief.expectedQuestions?.map((q) => `Q: ${q.question} → ${q.suggestedAnswer}`).join("\n") || "",
        brief.previousContext || "",
        brief.keyPoints?.join("\n") || "",
      ].filter(Boolean);

      for (const q of queries) {
        const kws = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        let found = false;
        for (const section of sections) {
          const lower = section.toLowerCase();
          const hits = kws.filter((kw) => lower.includes(kw));
          if (hits.length >= Math.min(2, kws.length)) {
            prepResults.push({ query: q, content: section.slice(0, 500), retrievedAt: Date.now() });
            found = true;
            break;
          }
        }
        if (!found) remainingQueries.push(q);
      }

      if (remainingQueries.length === 0) {
        console.log(`[ContextRetriever] All ${queries.length} queries answered from prep brief`);
        return prepResults;
      }
      if (prepResults.length > 0) {
        console.log(`[ContextRetriever] ${prepResults.length}/${queries.length} answered from prep, ${remainingQueries.length} remain`);
      }
      // Fall through to agentic search for remaining queries
      queries = remainingQueries;
    }

    try {
      const agenticResults = await Promise.race([
        this.agenticSearch(queries),
        new Promise<RetrievedContext[]>((_, reject) =>
          setTimeout(() => reject(new Error("agentic search timeout")), ContextRetriever.AGENT_TIMEOUT_MS)
        ),
      ]);
      return brief ? [...([] as RetrievedContext[]), ...agenticResults] : agenticResults;
    } catch (err: any) {
      console.warn(`[ContextRetriever] Agentic search failed: ${err.message}, trying keyword fallback`);
      return this.keywordFallback(queries);
    }
  }

  /** Run the agentic tool-use loop */
  private async agenticSearch(queries: string[]): Promise<RetrievedContext[]> {
    const model = CONFIG.analysis.searchModel || CONFIG.analysis.model;
    const systemPrompt = `You are a research assistant searching a personal knowledge workspace for specific information.
You have tools to list files, read files, and search across files. Use them to find answers.

RULES:
- Be efficient: start with search_files or read MEMORY.md, don't read every file
- Match semantically across languages: "发布计划" = "release plan", "讨论" = "discussed"
- Return ONLY the relevant content you found, no commentary
- Separate results for each query with "---"
- If nothing found for a query, write "NO_MATCH"
- Keep each result concise (under 400 chars)`;

    const userMessage = `Find information for these queries:\n${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;

    // Messages accumulate through the tool-use loop
    const messages: Array<{ role: string; content: any }> = [
      { role: "user", content: userMessage },
    ];

    // Agentic loop: model calls tools, we execute, repeat
    for (let round = 0; round < ContextRetriever.MAX_TOOL_ROUNDS; round++) {
      const response = await this.callModelWithTools(model, systemPrompt, messages);

      // Check if model wants to use tools
      const toolCalls = response.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        // Model is done — extract final text answer
        return this.parseSearchResults(response.text, queries);
      }

      // Execute each tool call
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
      for (const tc of toolCalls) {
        const result = await this.executeTool(tc.name, tc.input);
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
      }

      // Add assistant response + tool results to messages for next round
      messages.push({ role: "assistant", content: response.rawContent });
      messages.push({ role: "user", content: toolResults });
    }

    // Max rounds reached — try to extract whatever we have
    console.warn("[ContextRetriever] Max tool rounds reached");
    return [];
  }

  /** Call model with tool definitions via OpenRouter or Anthropic direct */
  private async callModelWithTools(
    model: string,
    system: string,
    messages: Array<{ role: string; content: any }>,
  ): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; input: any }> | null; rawContent: any }> {
    // OpenRouter path (supports tool_use for Claude models)
    if (CONFIG.openrouter.apiKey) {
      const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages,
          tools: ContextRetriever.SEARCH_TOOLS.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
        }),
      });
      if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = (await resp.json()) as any;
      const choice = data.choices?.[0];
      const msg = choice?.message;

      // Extract tool calls (OpenAI format from OpenRouter)
      const toolCalls = msg?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        input: JSON.parse(tc.function?.arguments || "{}"),
      })) || null;

      return {
        text: msg?.content || "",
        toolCalls: toolCalls?.length ? toolCalls : null,
        rawContent: msg,
      };
    }

    // Anthropic direct path (native tool_use)
    if (CONFIG.anthropic.apiKey) {
      const anthropicModel = model.replace(/^anthropic\//, "");
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.anthropic.apiKey,
          "anthropic-version": "2024-01-01",
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 1024,
          system,
          messages,
          tools: ContextRetriever.SEARCH_TOOLS,
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = (await resp.json()) as any;

      const textBlocks = (data.content || []).filter((b: any) => b.type === "text");
      const toolBlocks = (data.content || []).filter((b: any) => b.type === "tool_use");

      return {
        text: textBlocks.map((b: any) => b.text).join("\n"),
        toolCalls: toolBlocks.length
          ? toolBlocks.map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
          : null,
        rawContent: data.content,
      };
    }

    throw new Error("No API key for agentic search");
  }

  /**
   * Get the list of directories to search, plus prep-referenced file whitelist.
   * Searches: workspace, shared, prep, and any files explicitly referenced in the prep brief.
   */
  private getSearchDirs(): string[] {
    const dirs = [ContextRetriever.WORKSPACE_DIR, ContextRetriever.SHARED_DIR, ContextRetriever.PREP_DIR];
    const knowledgeDir = ContextRetriever.KNOWLEDGE_DIR;
    if (knowledgeDir) dirs.push(knowledgeDir);
    return dirs;
  }

  /**
   * Get absolute paths of files referenced in the current meeting prep brief.
   * These are whitelisted for read_file even though they're outside search dirs.
   */
  private getPrepReferencedFiles(): string[] {
    const brief = this.meetingPrepSkill.currentBrief;
    if (!brief) return [];
    const paths: string[] = [];
    for (const fp of brief.filePaths || []) {
      if (fp.path) paths.push(fp.path.startsWith("/") ? fp.path : `${process.env.HOME}/${fp.path}`);
    }
    return paths;
  }

  /** List files in a directory, returning entries with sizes */
  private async listDir(dir: string, prefix: string): Promise<string[]> {
    const entries: string[] = [];
    try {
      const files = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: true })) as string[];
      for (const f of files.sort()) {
        try {
          const stat = Bun.file(`${dir}/${f}`);
          const size = stat.size;
          entries.push(`${prefix}${f} (${size > 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`})`);
        } catch {
          entries.push(`${prefix}${f}`);
        }
      }
    } catch { /* dir doesn't exist, skip */ }
    return entries;
  }

  /** Execute a tool call against local directories */
  private async executeTool(name: string, input: any): Promise<string> {
    const ws = ContextRetriever.WORKSPACE_DIR;
    const shared = ContextRetriever.SHARED_DIR;
    const prep = ContextRetriever.PREP_DIR;

    switch (name) {
      case "list_workspace": {
        try {
          const entries: string[] = [];
          entries.push(...await this.listDir(ws, "[workspace] "));
          entries.push(...await this.listDir(prep, "[prep] "));
          entries.push(...await this.listDir(shared, "[shared] "));

          // Also list prep-referenced files
          const refFiles = this.getPrepReferencedFiles();
          for (const fp of refFiles) {
            try {
              const file = Bun.file(fp);
              if (await file.exists()) {
                const size = file.size;
                entries.push(`[prep-ref] ${fp} (${size > 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`})`);
              }
            } catch {}
          }

          return entries.join("\n") || "(empty — no files in workspace, prep, or shared)";
        } catch (e: any) {
          return `Error listing: ${e.message}`;
        }
      }

      case "read_file": {
        const path = input.path as string;
        const sanitized = path.replace(/\.\./g, "");

        // Try multiple locations: workspace, shared, prep, then prep-referenced whitelist
        const candidates = [
          `${ws}/${sanitized}`,
          `${shared}/${sanitized}`,
          `${prep}/${sanitized}`,
        ];

        // If the path looks absolute or matches a prep-referenced file, allow it
        const refFiles = this.getPrepReferencedFiles();
        if (path.startsWith("/") && refFiles.some((rf) => rf === path || path.startsWith(rf.replace(/[^/]+$/, "")))) {
          candidates.unshift(path);
        }

        for (const fullPath of candidates) {
          try {
            const file = Bun.file(fullPath);
            if (!(await file.exists())) continue;
            let content = await file.text();
            if (content.length > 6000) {
              content = content.slice(0, 6000) + `\n...(truncated, ${content.length} chars total)`;
            }
            return content;
          } catch { continue; }
        }
        return `File not found: ${path}`;
      }

      case "search_files": {
        const query = (input.query as string).toLowerCase();
        try {
          const results: string[] = [];
          const searchDirs = [
            { dir: ws, prefix: "" },
            { dir: prep, prefix: "prep/" },
            { dir: shared, prefix: "shared/" },
          ];

          for (const { dir, prefix } of searchDirs) {
            try {
              const files = await Array.fromAsync(new Bun.Glob("*.{md,txt,json,jsonl}").scan({ cwd: dir, onlyFiles: true })) as string[];
              for (const f of files) {
                try {
                  const content = await Bun.file(`${dir}/${f}`).text();
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i]!.toLowerCase().includes(query)) {
                      results.push(`${prefix}${f}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
                      if (results.length >= 20) break;
                    }
                  }
                  if (results.length >= 20) break;
                } catch {}
              }
              if (results.length >= 20) break;
            } catch { /* dir doesn't exist, skip */ }
          }

          // Also search prep-referenced files
          if (results.length < 20) {
            for (const fp of this.getPrepReferencedFiles()) {
              try {
                const content = await Bun.file(fp).text();
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i]!.toLowerCase().includes(query)) {
                    results.push(`[ref] ${fp}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
                    if (results.length >= 20) break;
                  }
                }
              } catch {}
              if (results.length >= 20) break;
            }
          }

          return results.length > 0 ? results.join("\n") : `No matches for "${query}"`;
        } catch (e: any) {
          return `Search error: ${e.message}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  /** Parse the model's final text response into RetrievedContexts */
  private parseSearchResults(text: string, queries: string[]): RetrievedContext[] {
    if (!text) return [];
    const sections = text.split(/---+/).map((s) => s.trim());
    const results: RetrievedContext[] = [];
    for (let i = 0; i < queries.length; i++) {
      const content = sections[i] || (i === 0 ? text : "");
      const query = queries[i] ?? `query_${i}`;
      if (content && content.length > 10 && !content.includes("NO_MATCH")) {
        results.push({ query, content: content.slice(0, 1000), retrievedAt: Date.now() });
      }
    }
    if (results.length > 0) {
      console.log(`[ContextRetriever] Agentic search: ${results.length}/${queries.length} queries answered`);
    }
    return results;
  }

  /** Keyword fallback (<1ms, lower accuracy) — last resort */
  private keywordFallback(queries: string[]): RetrievedContext[] {
    if (!this.contextSync) return [];
    const results: RetrievedContext[] = [];
    for (const query of queries) {
      const content = this.contextSync.searchMemory(query);
      if (content && content.length > 10) {
        results.push({ query, content: content.slice(0, 800), retrievedAt: Date.now() });
      }
    }
    if (results.length > 0) {
      console.log(`[ContextRetriever] Keyword fallback: ${results.length}/${queries.length} queries matched`);
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════════
  // Step 5: Inject into Voice AI
  // ══════════════════════════════════════════════════════════════

  private injectIntoVoice(newContexts: RetrievedContext[]) {
    if (!this.voice?.connected || !this.meetingPrepSkill.currentBrief) return;

    // Inject context data as persistent liveNotes (these stay in context)
    for (const ctx of newContexts) {
      const note = `[CONTEXT] ${ctx.query}: ${ctx.content}`;
      this.meetingPrepSkill.addLiveNote(note);
    }
    pushContextUpdate(this.voice, this.meetingPrepSkill, this.eventBus);

    // One-shot conversational hint — injected directly via conversation.item.create.
    // NOT added to liveNotes (ephemeral, no baggage). The realtime model sees this
    // once and can naturally weave it into conversation if relevant.
    const topicSummary = newContexts.map((c) => c.query).join(", ");
    const hint = `[CONTEXT_HINT] You just learned relevant information about: ${topicSummary}. If this connects to the current discussion, naturally mention it — e.g., "刚好联想到之前提到的..." or "that reminds me, we discussed...". If it's not relevant right now, ignore this hint.`;
    this.voice.injectContext(hint);

    console.log(`[ContextRetriever] Injected ${newContexts.length} contexts + conversational hint into Voice AI`);
  }

  // ══════════════════════════════════════════════════════════════
  // P1: Topic Prefetch Cache
  // ── Cache search results per topic. Follow-up questions within
  //    the same topic hit the cache (<1ms) instead of API calls. ──
  //
  // VoiceAgentRAG benchmarks: 110ms (vector DB) → 0.35ms (cache)
  // = 316x speedup. Cache hit rate reaches 86% by turns 5-9.
  // ══════════════════════════════════════════════════════════════

  /** Store search results under the current topic */
  private cacheForTopic(topic: string, results: RetrievedContext[]): void {
    // Merge with existing cache for this topic (don't replace)
    const existing = this._topicCache.get(topic) || [];
    const merged = [...existing, ...results];
    // Dedup by query
    const seen = new Set<string>();
    const deduped = merged.filter((r) => {
      if (seen.has(r.query)) return false;
      seen.add(r.query);
      return true;
    });
    this._topicCache.set(topic, deduped);

    // Evict oldest topics if cache exceeds max
    if (this._topicCache.size > this.TOPIC_CACHE_MAX_TOPICS) {
      const oldest = this._topicCache.keys().next().value;
      if (oldest) this._topicCache.delete(oldest);
    }

    console.log(`[ContextRetriever] Cached ${results.length} results for topic "${topic.slice(0, 30)}" (${deduped.length} total cached)`);
  }

  /**
   * Search the cache for content relevant to a user's question.
   * Uses keyword overlap — no API call, <1ms.
   */
  private searchCache(cached: RetrievedContext[], question: string): RetrievedContext[] {
    if (!question || cached.length === 0) return [];

    // Extract significant words from the question (>2 chars, skip common words)
    const stopWords = new Set(["the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in", "to", "for",
      "的", "了", "在", "是", "有", "和", "就", "不", "也", "都", "这", "那", "你", "我", "他", "她", "吗", "呢"]);
    const questionWords = new Set(
      question.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w))
    );

    if (questionWords.size === 0) return [];

    // Score each cached context by keyword overlap with the question
    const scored = cached.map((ctx) => {
      const ctxText = `${ctx.query} ${ctx.content}`.toLowerCase();
      let hits = 0;
      for (const word of questionWords) {
        if (ctxText.includes(word)) hits++;
      }
      return { ctx, score: hits / questionWords.size };
    });

    // Return contexts with >30% keyword overlap
    return scored
      .filter((s) => s.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => s.ctx);
  }

  // ── Status ──

  getStatus() {
    return {
      active: this._active,
      processing: this._processing,
      charsSinceLastAnalysis: this._charsSinceLastAnalysis,
      lastAnalysisTs: this._lastAnalysisTs,
      currentTopic: this._currentTopic,
      currentDirection: this._currentDirection,
      topicStableSince: this._topicStableSince,
      topicCacheSize: this._topicCache.size,
      topicCacheTopics: [...this._topicCache.keys()],
      retrievedContextsCount: this._retrievedContexts.length,
      retrievedQueries: this._retrievedContexts.map((r) => r.query),
    };
  }
}
