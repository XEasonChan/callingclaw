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
import { CONFIG } from "../config";

// ── Types ──

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

  // ── Retrieved context accumulator ──
  private _retrievedContexts: RetrievedContext[] = [];

  // ── Tuning knobs ──
  private CHAR_THRESHOLD = 500;       // ~2-4 min of dialogue
  private MIN_INTERVAL_MS = 30_000;   // Min 30s between analyses
  private QUESTION_BOOST = true;      // Trigger immediately on user questions
  private DEBOUNCE_MS = 3000;         // Wait 3s after last utterance before analyzing
  private MAX_RETRIEVED_CONTEXTS = 10; // Keep last N retrieved contexts

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
    this.voice = null;
    console.log("[ContextRetriever] Deactivated");
    this.eventBus.emit("retriever.deactivated", {});
  }

  // ── Event handler ──

  private _onTranscript = (entry: TranscriptEntry) => {
    if (!this._active) return;
    if (entry.role === "system") return; // Skip tool call logs

    this._charsSinceLastAnalysis += entry.text.length;

    const shouldTrigger =
      this._charsSinceLastAnalysis >= this.CHAR_THRESHOLD ||
      (this.QUESTION_BOOST && entry.role === "user" && this.looksLikeQuestion(entry.text));

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

  private looksLikeQuestion(text: string): boolean {
    const trimmed = text.trim();
    return (
      trimmed.endsWith("?") ||
      trimmed.endsWith("？") ||
      /[吗呢么嘛][\s。？?]*$/.test(trimmed) ||
      /^(什么|怎么|为什么|哪|谁|几|多少|是不是|有没有|能不能)/.test(trimmed)
    );
  }

  private scheduleAnalysis() {
    const elapsed = Date.now() - this._lastAnalysisTs;
    if (elapsed < this.MIN_INTERVAL_MS) return;

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.runAnalysis(), this.DEBOUNCE_MS);
  }

  // ── Core analysis loop ──

  private async runAnalysis() {
    if (!this._active || this._processing) return;
    this._processing = true;
    this._lastAnalysisTs = Date.now();
    this._charsSinceLastAnalysis = 0;

    const startTs = Date.now();

    try {
      // Step 1: Get recent transcript
      const entries = this.context.getRecentTranscript(20);
      if (entries.length < 2) return;

      // Step 2: Fast model analyzes for knowledge gaps
      const gapAnalysis = await this.analyzeGaps(entries);

      this.eventBus.emit("retriever.analysis", {
        needsRetrieval: gapAnalysis.needsRetrieval,
        queries: gapAnalysis.queries,
        reasoning: gapAnalysis.reasoning,
        durationMs: Date.now() - startTs,
      });

      if (!gapAnalysis.needsRetrieval || gapAnalysis.queries.length === 0) {
        console.log(`[ContextRetriever] No gaps detected (${Date.now() - startTs}ms)`);
        return;
      }

      console.log(
        `[ContextRetriever] Gaps found: ${gapAnalysis.queries.length} queries (${Date.now() - startTs}ms)`
      );

      // Step 3: Semantic search on MEMORY.md via fast model
      const retrievalStartTs = Date.now();
      const results = await this.semanticSearch(gapAnalysis.queries);

      if (results.length === 0) {
        console.log(`[ContextRetriever] No results found (${Date.now() - retrievalStartTs}ms)`);
        return;
      }

      // Step 4: Accumulate retrieved context
      for (const r of results) {
        this._retrievedContexts.push(r);
      }
      while (this._retrievedContexts.length > this.MAX_RETRIEVED_CONTEXTS) {
        this._retrievedContexts.shift();
      }

      // Step 5: Inject into Voice AI
      this.injectIntoVoice(results);

      const totalMs = Date.now() - startTs;
      console.log(
        `[ContextRetriever] Complete: ${results.length} contexts injected (` +
        `analysis: ${retrievalStartTs - startTs}ms, search: ${Date.now() - retrievalStartTs}ms, ` +
        `total: ${totalMs}ms)`
      );

      this.eventBus.emit("retriever.complete", {
        queriesCount: gapAnalysis.queries.length,
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

  /**
   * Unified LLM call via OpenRouter.
   * Supports any model: Haiku 4.5, Gemini 3.1 Flash, etc.
   * Falls back to Anthropic direct API if no OpenRouter key.
   */
  private async callModel(
    prompt: string,
    opts: { model?: string; maxTokens?: number } = {},
  ): Promise<string> {
    const model = opts.model || CONFIG.analysis.searchModel || CONFIG.analysis.model;
    const maxTokens = opts.maxTokens || 512;

    // Prefer OpenRouter (supports all models uniformly)
    if (CONFIG.openrouter.apiKey) {
      const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as any;
      return data.choices?.[0]?.message?.content || "";
    }

    // Fallback: Anthropic direct (only works for Claude models)
    if (CONFIG.anthropic.apiKey) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.anthropic.apiKey,
          "anthropic-version": "2024-01-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as any;
      return data.content?.[0]?.text || "";
    }

    throw new Error("No API key (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)");
  }

  // ══════════════════════════════════════════════════════════════
  // Step 2: Gap Analysis
  // ══════════════════════════════════════════════════════════════

  private async analyzeGaps(entries: TranscriptEntry[]): Promise<GapAnalysis> {
    const transcriptText = entries
      .map((e) => `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`)
      .join("\n");

    // Include current screen context (what's being shown/presented)
    const screen = this.context.screen;
    const screenContext = screen.description
      ? `\n## Current Screen\n${screen.description}${screen.url ? ` (${screen.url})` : ""}${screen.title ? ` — ${screen.title}` : ""}`
      : "";

    const brief = this.meetingPrepSkill.currentBrief;
    const currentContextSummary = brief
      ? `Topic: ${brief.topic}\nKey Points: ${brief.keyPoints.join("; ")}\n` +
        `Already retrieved: ${this._retrievedContexts.map((r) => r.query).join("; ") || "none"}`
      : "No meeting brief loaded.";

    const prompt = `You analyze a live meeting (conversation + screen content) to detect knowledge gaps that need retrieval from local files and memory.

## Current Context Already Available
${currentContextSummary}

## Recent Transcript
${transcriptText}
${screenContext}

## Task
Analyze BOTH the conversation AND the screen content. Determine if the discussion or the presented content references concepts, projects, decisions, metrics, or history that are NOT covered by the current context.

Context gaps include:
- User or screen mentions a project/feature name not in the context
- Screen shows a document, PRD, or dashboard with unfamiliar references
- User references a past decision, conversation, or metric not covered
- Discussion or screen shifted to a topic the prep brief doesn't cover
- Screen shows code, PR, or architecture diagram that needs background context

NOT gaps (do not flag):
- General discussion within the prep brief's scope
- User's opinions or new ideas (nothing to retrieve)
- Small talk or greetings
- Topics already retrieved (see "Already retrieved" above)
- Screen showing meeting grid / no shared content

## Output
JSON only:
{"needsRetrieval": true/false, "queries": ["specific search query 1", "specific search query 2"], "reasoning": "brief explanation"}

Keep queries specific and searchable. Max 3 queries per analysis.`;

    const text = await this.callModel(prompt, {
      model: CONFIG.analysis.model,
      maxTokens: 256,
    });
    return this.parseGapAnalysis(text);
  }

  private parseGapAnalysis(text: string): GapAnalysis {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { needsRetrieval: false, queries: [], reasoning: "parse_error" };
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        needsRetrieval: !!parsed.needsRetrieval,
        queries: Array.isArray(parsed.queries) ? parsed.queries.slice(0, 3) : [],
        reasoning: parsed.reasoning || "",
      };
    } catch {
      return { needsRetrieval: false, queries: [], reasoning: "json_parse_error" };
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
  private static readonly MAX_TOOL_ROUNDS = 3; // Max agentic iterations
  private static readonly AGENT_TIMEOUT_MS = 8_000; // Hard cap on total search time

  /** Tool definitions for the agentic search agent */
  private static readonly SEARCH_TOOLS = [
    {
      name: "list_workspace",
      description: "List all files in the knowledge workspace. Returns filenames with sizes. Call this first to see what's available.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "read_file",
      description: "Read a file from the workspace. Returns the file content (truncated if large). Use this to read MEMORY.md, project docs, meeting notes, etc.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string" as const, description: "Filename (e.g. 'MEMORY.md', 'callingclaw-architecture-analysis.md')" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_files",
      description: "Search across all workspace files for a keyword/phrase. Returns matching lines with filenames. Good for finding which file contains specific info.",
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
    try {
      return await Promise.race([
        this.agenticSearch(queries),
        new Promise<RetrievedContext[]>((_, reject) =>
          setTimeout(() => reject(new Error("agentic search timeout")), ContextRetriever.AGENT_TIMEOUT_MS)
        ),
      ]);
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

  /** Execute a tool call against the local workspace */
  private async executeTool(name: string, input: any): Promise<string> {
    const ws = ContextRetriever.WORKSPACE_DIR;

    switch (name) {
      case "list_workspace": {
        try {
          const entries: string[] = [];
          const dir = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: ws, onlyFiles: true })) as string[];
          for (const f of dir.sort()) {
            try {
              const stat = Bun.file(`${ws}/${f}`);
              const size = stat.size;
              entries.push(`${f} (${size > 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`})`);
            } catch {
              entries.push(f);
            }
          }
          return entries.join("\n") || "(empty workspace)";
        } catch (e: any) {
          return `Error listing workspace: ${e.message}`;
        }
      }

      case "read_file": {
        const path = input.path as string;
        // Security: only allow reading from workspace dir
        const fullPath = `${ws}/${path.replace(/\.\./g, "")}`;
        try {
          const file = Bun.file(fullPath);
          if (!(await file.exists())) return `File not found: ${path}`;
          let content = await file.text();
          // Truncate large files to keep context manageable
          if (content.length > 6000) {
            content = content.slice(0, 6000) + `\n...(truncated, ${content.length} chars total)`;
          }
          return content;
        } catch (e: any) {
          return `Error reading ${path}: ${e.message}`;
        }
      }

      case "search_files": {
        const query = (input.query as string).toLowerCase();
        try {
          const results: string[] = [];
          const dir = await Array.fromAsync(new Bun.Glob("*.{md,txt}").scan({ cwd: ws, onlyFiles: true })) as string[];
          for (const f of dir) {
            try {
              const content = await Bun.file(`${ws}/${f}`).text();
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (lines[i]!.toLowerCase().includes(query)) {
                  results.push(`${f}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
                  if (results.length >= 20) break;
                }
              }
              if (results.length >= 20) break;
            } catch {}
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

    for (const ctx of newContexts) {
      const note = `[CONTEXT] ${ctx.query}: ${ctx.content}`;
      this.meetingPrepSkill.addLiveNote(note);
    }

    pushContextUpdate(this.voice, this.meetingPrepSkill, this.eventBus);
    console.log(`[ContextRetriever] Injected ${newContexts.length} contexts into Voice AI`);
  }

  // ── Status ──

  getStatus() {
    return {
      active: this._active,
      processing: this._processing,
      charsSinceLastAnalysis: this._charsSinceLastAnalysis,
      lastAnalysisTs: this._lastAnalysisTs,
      retrievedContextsCount: this._retrievedContexts.length,
      retrievedQueries: this._retrievedContexts.map((r) => r.query),
    };
  }
}
