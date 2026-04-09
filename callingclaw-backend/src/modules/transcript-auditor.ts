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
  private agentAdapter: any = null; // AgentAdapter for research_task delegation

  private _active = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastAuditedTs = 0;
  private _processing = false;
  private _recentActions: string[] = []; // dedup ring buffer (last 5)
  private _lastExecutionTs = 0;
  private _fastLaneProcessing = false; // prevent concurrent fast lane executions
  private _researchGeneration = 0; // incremented on deactivate() to cancel stale research callbacks
  private _activeResearch = new Map<string, number>(); // in-flight research: normalized query → taskId timestamp

  // ── Tuning knobs ──
  private DEBOUNCE_MS = 1200;         // Wait 1.2s after last user utterance (was 2.5s, reduced for meeting responsiveness)
  private FAST_LANE_CONFIDENCE = 0.95; // Regex match threshold for immediate execution (no LLM)
  private CONFIDENCE_AUTO = 0.85;     // Auto-execute threshold
  private CONFIDENCE_SUGGEST = 0.6;   // Suggest to Voice AI threshold
  private WINDOW_ENTRIES = 15;        // Transcript entries to analyze
  private COOLDOWN_MS = 10000;        // Min gap between executions (BUG-028: extended from 5s to 10s to prevent double-execution)

  constructor(opts: {
    context: SharedContext;
    eventBus: EventBus;
    automationRouter: AutomationRouter;
    computerUse: ComputerUseModule;
    meetingPrepSkill: MeetingPrepSkill;
    meetJoiner: MeetJoiner;
    chromeLauncher?: any;
    agentAdapter?: any;
  }) {
    this.context = opts.context;
    this.eventBus = opts.eventBus;
    this.automationRouter = opts.automationRouter;
    this.computerUse = opts.computerUse;
    this.meetingPrepSkill = opts.meetingPrepSkill;
    this.meetJoiner = opts.meetJoiner;
    this.chromeLauncher = opts.chromeLauncher || null;
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

    // Subscribe to transcript events
    this.context.on("transcript", this._onTranscript);

    // Listen for Realtime tool calls → add to dedup ring buffer so Auditor
    // doesn't re-execute the same action that Realtime already handled.
    // Without this, user says "打开MCP文档" → Realtime calls open_file (200ms)
    // → Auditor classifies as search_and_open (1.5s later) → opens same file again.
    this.eventBus.on("voice.tool_call", (data: any) => {
      const tool = data?.tool || "";
      const key = `realtime:${tool}:${JSON.stringify(data?.summary || data?.instruction || "").slice(0, 80)}`;
      if (!this._recentActions.includes(key)) {
        this._recentActions.push(key);
        if (this._recentActions.length > 5) this._recentActions.shift();
      }
      this._lastExecutionTs = Date.now();
      console.log(`[TranscriptAuditor] Dedup: Realtime executed ${tool}, suppressing auditor for ${this.COOLDOWN_MS}ms`);
    });

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
    // Unsubscribe listener to prevent leaking handlers across meetings
    this.context.off("transcript", this._onTranscript);
    this.automationRouter.fileIndex.clear();
    this._researchGeneration++; // Cancel any in-flight research callbacks from this meeting
    this._activeResearch.clear();
    this.voice = null;
    console.log("[TranscriptAuditor] Deactivated (research gen: ${this._researchGeneration})");
    this.eventBus.emit("auditor.deactivated", {});
  }

  // ── Event handler (arrow fn to preserve `this`) ──

  private _onTranscript = (entry: TranscriptEntry) => {
    if (!this._active) return;
    if (entry.role !== "user") return; // Only audit on user speech

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
    // both fast lane action AND slow lane retrieval)
    const actionKey = `${intent.action}:${JSON.stringify(intent.params)}`;
    if (this._recentActions.includes(actionKey)) return;

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
        // Route through AutomationRouter for other actions (meet shortcuts, tab management, etc.)
        const result = await this.automationRouter.execute(text);

        if (result.success && this.voice?.connected && this.meetingPrepSkill.currentBrief) {
          notifyTaskCompletion(this.voice, this.meetingPrepSkill, text, result.result, this.eventBus);
        }
      }

      // Add to dedup ring buffer
      this._recentActions.push(actionKey);
      if (this._recentActions.length > 5) this._recentActions.shift();
      this._lastExecutionTs = Date.now();

      console.log(`[TranscriptAuditor] Fast lane: ${intent.action} (${Date.now() - startTs}ms)`);
    } catch (err: any) {
      console.error(`[TranscriptAuditor] Fast lane error: ${err.message}`);
    } finally {
      this._fastLaneProcessing = false;
    }
  }

  // ── Core audit loop (medium lane — Haiku LLM) ──

  private async runAudit() {
    if (!this._active || this._processing) return;

    // Cooldown: don't fire too rapidly
    if (Date.now() - this._lastExecutionTs < this.COOLDOWN_MS) return;

    const entries = this.context.getRecentTranscript(this.WINDOW_ENTRIES);

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

      // Dedup: skip if we just did this exact action
      const actionKey = `${result.action}:${JSON.stringify(result.params)}`;
      if (this._recentActions.includes(actionKey)) {
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
        this._recentActions.push(actionKey);
        if (this._recentActions.length > 5) this._recentActions.shift();
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
    const recentActions = this._dedupRing?.slice(-3).map((d: string) => d.split(":")[0]).join(", ") || "";
    const prepTopic = brief?.topic || "";
    const enrichment = [
      screenDesc ? `[Current screen: ${screenDesc.slice(0, 120)}]` : "",
      pageUrl ? `[Page URL: ${pageUrl}]` : "",
      recentActions ? `[Recent actions: ${recentActions}]` : "",
      prepTopic ? `[Meeting topic: ${prepTopic}]` : "",
    ].filter(Boolean).join("\n");
    const enrichedTranscript = enrichment ? `${enrichment}\n\n${transcriptText}` : transcriptText;

    const prompt = `You are CallingClaw's meeting agent — a fast background assistant. You monitor the conversation and execute actions when the voice AI or participants request something.

## Your Tools (choose the RIGHT one)

### File & URL Tools
- **search_and_open**: Search for a file by fuzzy name, then open it in browser. Use when someone asks to open/show/find a file but doesn't give an exact path. Params: { "query": "keywords to search for", "app": "browser" }
- **open_url**: Open an exact URL. Use when a full URL is mentioned. Params: { "url": "https://..." }
- **open_file**: Open a file by exact path. Only use if you know the full path. Params: { "path": "/abs/path", "app": "browser"|"vscode" }

### Screen Sharing Tools
- **share_url**: Open a URL and present it in the meeting (screen share). Params: { "url": "https://..." }
- **share_file**: Search for a file and present it in the meeting. Params: { "query": "keywords" }
- **stop_sharing**: Stop presenting. Params: {}

### Presenting Tab Tools (operate on the currently shared content)
- **click**: Click a button/link on the presenting page. Params: { "selector": "button text or link text", "targetTab": "presenting" }
- **scroll**: Scroll the presenting page. Params: { "direction": "up"|"down", "targetTab": "presenting" }
- **navigate**: Navigate the presenting page to a new URL. Params: { "url": "https://...", "targetTab": "presenting" }

### Meeting Control Tools
- **share_screen**: Start sharing (no URL = entire screen). Params: {}
- **meet_mute**: Toggle mute. Params: {}
- **meet_camera**: Toggle camera. Params: {}

### Research Tools (background, 10-30s)
- **research_task**: Delegate web/deep research to the background agent. Params: { "query": "what to research" }
  USE research_task for:
    - "search X/Twitter for Y" (external web search)
    - "what are people saying about Z" (public opinion)
    - "research competitors of W" (market research)
    - "find recent news about Q" (current events)
  DO NOT use research_task for:
    - "what did we discuss about X" → this is recall_context (internal memory)
    - "look up in our files" → this is search_and_open (local files)
    - "what was the decision on Y" → this is recall_context (meeting history)

## Known Files & URLs (from meeting prep)
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

## Transcript (most recent at bottom, with current screen + action context)
${enrichedTranscript}

## When to Act
1. Someone asks to open, show, display, share screen, or find something → ACT (search_and_open, share_file, open_url)
2. Someone says "点击/click/登录/login/下一步/next" → ACT (click on presenting tab)
3. Someone says "往下/scroll down/翻页" → ACT (scroll)
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT (your cue!)
5. Discussion/opinion (expressing views, suggestions for future) → DO NOT ACT, confidence=0
6. Response to AI question ("是/好的/对/嗯") → DO NOT ACT, confidence=0
7. **ALREADY HANDLED**: If you see [Tool Call] or [Tool Result] in the transcript for the same action → DO NOT ACT, confidence=0. The voice AI already executed it.
8. **When in doubt, don't act.** A bad action (clicking the wrong thing, opening the wrong file) is worse than a missed action. Only act when you're confident the user wants something done.

## STT Name Aliases (speech-to-text often mangles these)
The transcription is from live STT, which frequently misspells proper nouns. Treat these as equivalent:
${
  brief?.sttAliases && brief.sttAliases.length > 0
    ? brief.sttAliases.map((a: any) => `- ${a.canonical} = ${a.variants.map((v: string) => `"${v}"`).join(" / ")}`).join("\n")
    : `- CallingClaw = "calling claw" / "colin claw" / "calling call" / "calling clause"
- OpenClaw = "open claw" / "open call" / "open clause"`
}
When a fuzzy match to a known product/person/term appears, interpret it as the canonical name above.

## File Name Resolution Examples
- "landing page html" / "官网html" → search "callingclaw-landing.html" or "callingclaw-landing"
- "vision page" → search "vision.html"
- "meeting summary" → search "meeting-summary"
- "PRD" / "需求文档" → search "PRD" or "callingclaw-v2.5-PRD"
- "prep file" / "会议准备" → search in ~/.callingclaw/shared/prep/

Respond with JSON only:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<brief>","targetTab":"presenting"|"meet"}`;

    // Use shared LLM client instead of duplicated API call code
    try {
      const text = await callModel(prompt, {
        model: CONFIG.analysis.model,
        maxTokens: 256,
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

    // Step 3: Click by index — guaranteed correct target
    const target = elements[clickIndex]!;
    const clickResult = await this.chromeLauncher.evaluateOnPresentingPage(`(() => {
      var els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], [onclick]'));
      var el = els[${clickIndex}];
      if (el) { el.click(); return 'clicked:' + (el.textContent || '').trim().substring(0, 40); }
      return 'not_found: index out of range';
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
      switch (action) {
        // ── File search + open (fuzzy name) ──
        case "search_and_open": {
          const query = params.query || "";
          instruction = `search and open: ${query}`;
          console.log(`[Auditor] Searching for file: "${query}"`);
          const searchResult = await this.automationRouter.execute(`open file: ${query}`);
          executionResult = searchResult.success ? searchResult.result : `File not found: "${query}"`;
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
              const resp = await fetch("http://localhost:4000/api/screen/share", {
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
            const resp = await fetch("http://localhost:4000/api/screen/share", {
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
            const resp = await fetch("http://localhost:4000/api/screen/share", {
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
            await fetch("http://localhost:4000/api/screen/stop", { method: "POST" });
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
        // Codex findings #1-16: full production-safe implementation
        case "research_task": {
          const query = params.query || "";
          if (!query) { executionResult = "No research query provided"; break; }

          const taskId = `research_${Date.now()}`;
          const normalizedQuery = query.toLowerCase().split(/\s+/).slice(0, 5).join(" ");

          // #6: Agent disconnected → emit proper research events, not generic done
          if (!this.agentAdapter?.connected) {
            this.eventBus.emit("research.started", { taskId, query });
            this.eventBus.emit("research.completed", { taskId, query, error: "No agent connected" });
            executionResult = "No agent available for research";
            // #12: Don't push to dedup ring on failure
            return; // #1: Early return — skip generic post-switch done path
          }

          // #11: In-flight guard — prevent duplicate research
          for (const [existingQuery, ts] of this._activeResearch) {
            if (existingQuery === normalizedQuery && Date.now() - ts < 120000) {
              executionResult = `Research already running: "${query}"`;
              return; // Skip generic done path
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
            // L4 fallback: full Computer Use agent loop
            this.eventBus.emit("computer.task_started", {
              instruction,
              source: "auditor_l4",
            });
            const cuResult = await this.computerUse.execute(instruction);
            executionResult = cuResult.summary;
          } else {
            executionResult =
              "No automation layer could handle this instruction.";
          }
          break;
        }
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
