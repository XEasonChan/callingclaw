// CallingClaw 2.0 — Meeting Prep Skill
// ═══════════════════════════════════════════════════════════════════
// This is the "slow thinking" (System 2) component.
// The agent adapter reads its full memory + relevant files, then generates a
// structured Meeting Prep Brief that becomes the single context source
// for the "fast thinking" Voice AI and Computer Use layers.
//
// Flow:
//   User: "Prepare a meeting about CallingClaw PRD"
//   → AgentAdapter reads memory + PRD + project files
//   → Generates MeetingPrepBrief (this file)
//   → Brief injected into Voice AI system prompt
//   → Brief's file paths/URLs available to Computer Use 4-layer automation
//
// Works with any agent backend: OpenClaw, Claude Code, standalone.
//
// Usage:
//   const skill = new MeetingPrepSkill(adapter);
//   const brief = await skill.generate("CallingClaw 2.0 PRD review");
//   voiceModule.updateInstructions(buildVoiceInstructions(brief));
// ═══════════════════════════════════════════════════════════════════

import type { AgentAdapter } from "../agent-adapter";
import type { CalendarAttendee } from "../mcp_client/google_cal";
import { savePrepBrief, startLiveLog, appendToLiveLog, stopLiveLog, generateMeetingId } from "../modules/shared-documents";
import { parseOC001 } from "../openclaw-protocol";

// ── Meeting Prep Brief Structure ──
// This is the output that feeds into Voice AI + Computer Use

export interface MeetingPrepBrief {
  // Basic info
  topic: string;                    // meeting topic
  goal: string;                     // what the meeting should achieve
  generatedAt: number;              // timestamp

  // Content for Voice AI (conversational context)
  summary: string;                  // 2-3 paragraph overview of what will be presented
  keyPoints: string[];              // list of key talking points
  architectureDecisions: Array<{    // architecture decisions and rationale
    decision: string;
    rationale: string;
  }>;
  expectedQuestions: Array<{        // expected questions + suggested answers
    question: string;
    suggestedAnswer: string;
  }>;
  previousContext?: string;         // brief review of the previous meeting (if any)

  // Content for Computer Use (executable references)
  filePaths: Array<{               // local file paths — Peekaboo/Finder
    path: string;
    description: string;
    action?: "open" | "scroll" | "present";  // suggested action
  }>;
  browserUrls: Array<{            // browser URLs — Playwright L2
    url: string;
    description: string;
    action?: "navigate" | "demo" | "show";
  }>;
  folderPaths: Array<{            // folder directories — Finder
    path: string;
    description: string;
  }>;

  // Attendees from calendar (for admission monitoring + context)
  attendees: CalendarAttendee[];

  // Dynamic updates during meeting (OpenClaw can append)
  liveNotes: string[];             // notes added dynamically during the meeting
  _liveNoteTimestamps?: number[];  // parallel array: when each liveNote was added (for TTL eviction)

  // ── Playbook fields (optional, present when OpenClaw produces playbook format) ──
  // When present, the voice AI follows the speaking plan instead of passively knowing facts.
  // PresentationEngine uses scenes[] for cross-file screen sharing.
  speakingPlan?: Array<{
    phase: string;           // "开场" | "首页设计" | "讨论" | "总结"
    durationMin: number;     // time budget in minutes
    points: string;          // what to say (1-2 sentences)
    sceneIndices?: number[]; // which scenes to show during this phase
  }>;
  scenes?: Array<{
    url: string;             // absolute URL or local file path
    scrollTarget?: string;   // CSS selector or text anchor to scroll to
    talkingPoints: string;   // what to say while this scene is showing
    durationMs: number;      // how long to stay on this scene
  }>;
  decisionPoints?: string[];  // decisions the voice AI should explicitly drive

  // STT aliases: unusual keywords from prep that STT will likely mangle
  // Generated pre-meeting by Haiku scanning the brief for proper nouns,
  // product names, technical terms, and non-English words.
  sttAliases?: Array<{
    canonical: string;          // correct spelling: "CallingClaw"
    variants: string[];         // likely STT outputs: ["calling claw", "colin claw", ...]
  }>;
}

// Prompt template moved to openclaw-protocol.ts (OC-001)
// Use OC001_PROMPT(req) to generate the prompt.

// ── Meeting Prep Skill ──

export class MeetingPrepSkill {
  private adapter: AgentAdapter;
  private _currentBrief: MeetingPrepBrief | null = null;
  private _onLiveNote?: (note: string, topic: string) => void;
  private _onPrepReady?: (brief: MeetingPrepBrief, meetingId: string, filePath: string) => void;
  private _liveLogPath: string | null = null;
  private _sessionManager: import("../modules/session-manager").SessionManager | null = null;

  constructor(adapter: AgentAdapter) {
    this.adapter = adapter;
  }

  /** Inject SessionManager for atomic file+session updates */
  setSessionManager(sm: import("../modules/session-manager").SessionManager) {
    this._sessionManager = sm;
  }

  /** Get the current live log file path (for external writers) */
  get liveLogPath(): string | null {
    return this._liveLogPath;
  }

  /** Register a callback for when a live note is added (for EventBus forwarding) */
  onLiveNote(callback: (note: string, topic: string) => void) {
    this._onLiveNote = callback;
  }

  /** Register a callback for when prep brief is saved to disk (for EventBus forwarding) */
  onPrepReady(callback: (brief: MeetingPrepBrief, meetingId: string, filePath: string) => void) {
    this._onPrepReady = callback;
  }

  get currentBrief(): MeetingPrepBrief | null {
    return this._currentBrief;
  }

  /** Set the brief directly (e.g., loaded from a prep JSON file on disk) */
  setBrief(brief: MeetingPrepBrief) {
    this._currentBrief = brief;
    console.log(`[MeetingPrep] Brief set: "${brief.topic}" (${brief.speakingPlan?.length || 0} phases, ${brief.scenes?.length || 0} scenes)`);
  }

  /**
   * Generate a Meeting Prep Brief by delegating to OpenClaw.
   * OpenClaw will read its MEMORY.md + relevant files and produce the brief.
   *
   * @param topic - What the meeting is about (e.g., "CallingClaw 2.0 PRD review")
   * @param userContext - Any additional instructions from the user
   */
  async generate(topic: string, userContext?: string, attendees?: CalendarAttendee[], meetingId?: string): Promise<MeetingPrepBrief> {
    const filteredAttendees = attendees
      ?.filter((a) => !a.self)
      .map((a) => ({
        name: a.displayName || "",
        email: a.email,
        status: a.responseStatus,
      }));

    console.log(`[MeetingPrep] Generating brief for: "${topic}" (${attendees?.length || 0} attendees, meetingId=${meetingId || "auto"}, adapter=${this.adapter.name})`);
    const startTime = Date.now();

    // Delegate to agent adapter (OpenClaw, Claude Code, or standalone)
    const rawResult = await this.adapter.generateMeetingPrep({
      topic,
      userContext,
      attendees: filteredAttendees,
    });

    console.log(`[MeetingPrep] ${this.adapter.name} responded in ${Date.now() - startTime}ms`);

    // Parse with typed parser
    const brief = parseOC001(rawResult, topic) as any as MeetingPrepBrief;
    brief.generatedAt = Date.now();
    brief.liveNotes = [];
    brief.attendees = attendees || [];

    // Generate STT aliases: scan brief for unusual keywords that STT will mangle.
    // Runs in parallel with file save (non-blocking, ~1-2s Haiku call).
    this.generateSttAliases(brief).then((aliases) => {
      brief.sttAliases = aliases;
      console.log(`[MeetingPrep] STT aliases ready: ${aliases.length} terms`);
    }).catch(() => {});

    this._currentBrief = brief;
    console.log(`[MeetingPrep] Brief ready: ${brief.keyPoints.length} key points, ${brief.filePaths.length} files, ${brief.browserUrls.length} URLs`);

    // Persist prep brief to shared directory (non-blocking)
    // SessionManager is always wired at startup (callingclaw.ts) — use it for atomic file + session update
    const actualId = meetingId || (this._sessionManager ? this._sessionManager.generateId() : generateMeetingId());
    if (this._sessionManager) {
      const { renderPrepBriefMarkdown } = await import("../modules/shared-documents");
      const md = renderPrepBriefMarkdown(brief);
      this._sessionManager.attachPrep(actualId, md, brief.topic).then((filePath) => {
        this._onPrepReady?.(brief, actualId, filePath);
      }).catch((e: any) => {
        console.warn(`[MeetingPrep] Failed to save prep brief to disk: ${e.message}`);
      });
      // Attach live log (does NOT change status — just creates the file)
      this._sessionManager.attachLiveLog(actualId, topic).then((logPath) => {
        this._liveLogPath = logPath;
        console.log(`[MeetingPrep] Live log started: ${logPath}`);
      }).catch((e: any) => {
        console.warn(`[MeetingPrep] Failed to start live log: ${e.message}`);
      });
    } else {
      console.warn(`[MeetingPrep] No SessionManager — prep brief will not be persisted. ID: ${actualId}`);
    }

    return brief;
  }

  /**
   * Scan the prep brief for unusual keywords (product names, technical terms,
   * people names, non-English words) and generate likely STT misheard variants.
   * Called once after prep generation (~1-2s Haiku call, non-blocking).
   */
  private async generateSttAliases(brief: MeetingPrepBrief): Promise<MeetingPrepBrief["sttAliases"] & {}> {
    const { callModel, parseJSON } = await import("../ai_gateway/llm-client");

    // Collect all text from the brief for Haiku to scan
    const briefText = [
      `Topic: ${brief.topic}`,
      `Goal: ${brief.goal}`,
      brief.summary,
      ...brief.keyPoints,
      ...(brief.architectureDecisions || []).map(d => `${d.decision}: ${d.rationale}`),
      ...(brief.filePaths || []).map(f => f.description),
      ...(brief.browserUrls || []).map(u => u.description),
      ...(brief.attendees || []).filter(a => a.displayName).map(a => a.displayName),
      ...(brief.speakingPlan || []).map(s => s.points),
    ].filter(Boolean).join("\n");

    const result = await callModel({
      model: "fast",
      system: "You extract unusual keywords from meeting documents and predict how speech-to-text (Whisper/Google STT) will mishear them. Focus on: product names, brand names, technical terms, people names, non-English words, acronyms spoken aloud, and any word a general-purpose STT model would not have in its common vocabulary.",
      prompt: `Scan this meeting brief and extract keywords that STT will likely mishear. For each, list 3-6 plausible STT misheard variants (how it might sound phonetically to an English STT model, including mixed-language cases).

${briefText}

Respond with JSON array only, no explanation:
[{"canonical":"CallingClaw","variants":["calling claw","colin claw","calling clah","calling call"]},...]

Rules:
- Only include words that STT will ACTUALLY struggle with (skip common English words)
- Include Chinese/Japanese/Korean terms if present (STT often romanizes them wrong)
- Include people's names (especially non-English names)
- Include product names, frameworks, libraries that aren't dictionary words
- For each variant, think: "what would Whisper output if it heard this word?"`,
      maxTokens: 500,
      temperature: 0,
    });

    const aliases = parseJSON(result) as Array<{ canonical: string; variants: string[] }>;
    if (!Array.isArray(aliases)) return [];
    // Filter out invalid entries
    return aliases.filter(a => a.canonical && Array.isArray(a.variants) && a.variants.length > 0);
  }

  // TTL for liveNotes eviction (5 minutes)
  private static readonly LIVE_NOTE_TTL_MS = 5 * 60 * 1000;

  /**
   * Add a live note during the meeting (OpenClaw pushes context updates).
   * This gets synced to Voice AI via session.update.
   * Notes older than 5 minutes are evicted to prevent unbounded context growth.
   */
  addLiveNote(note: string): void {
    if (!this._currentBrief) return;

    // Initialize timestamps array if needed
    if (!this._currentBrief._liveNoteTimestamps) {
      this._currentBrief._liveNoteTimestamps = [];
    }

    this._currentBrief.liveNotes.push(note);
    this._currentBrief._liveNoteTimestamps.push(Date.now());

    // Evict expired notes (keep [DONE] notes forever — they're action records)
    this.evictExpiredNotes();

    console.log(`[MeetingPrep] Live note added: "${note.slice(0, 60)}" (${this._currentBrief.liveNotes.length} total)`);

    // Append to live log file on disk
    if (this._liveLogPath) {
      appendToLiveLog(this._liveLogPath, `[NOTE] ${note}`);
    }

    this._onLiveNote?.(note, this._currentBrief.topic);
  }

  /**
   * Evict liveNotes older than TTL.
   * Preserves [DONE] notes (action completion records) and [CONTEXT] notes
   * that are still within TTL. Removes stale [SUGGEST] and [CONTEXT] notes.
   */
  private evictExpiredNotes(): void {
    const brief = this._currentBrief;
    if (!brief || !brief._liveNoteTimestamps) return;

    const now = Date.now();
    const ttl = MeetingPrepSkill.LIVE_NOTE_TTL_MS;
    const keepIndices: number[] = [];

    for (let i = 0; i < brief.liveNotes.length; i++) {
      const age = now - (brief._liveNoteTimestamps[i] || 0);
      const note = brief.liveNotes[i]!;
      // Always keep [DONE] notes (action completion records)
      if (note.startsWith("[DONE]") || age < ttl) {
        keepIndices.push(i);
      }
    }

    if (keepIndices.length < brief.liveNotes.length) {
      const evicted = brief.liveNotes.length - keepIndices.length;
      brief.liveNotes = keepIndices.map((i) => brief.liveNotes[i]!);
      brief._liveNoteTimestamps = keepIndices.map((i) => brief._liveNoteTimestamps![i]!);
      console.log(`[MeetingPrep] Evicted ${evicted} expired liveNotes (${brief.liveNotes.length} remaining)`);
    }
  }

  /**
   * Record a Computer Use task completion so Voice AI knows what happened.
   * Returns a formatted string suitable for injecting into Voice context.
   */
  recordTaskCompletion(task: string, result: string): string {
    const entry = `[DONE] ${task}: ${result.slice(0, 200)}`;
    this.addLiveNote(entry);
    return entry;
  }

  /**
   * Get a compact text version of the brief for Voice AI system prompt.
   * Optimized for token efficiency — summaries only, no full file contents.
   */
  getVoiceBrief(): string {
    if (!this._currentBrief) return "";
    const b = this._currentBrief;
    const parts: string[] = [];

    parts.push(`## Meeting Topic: ${b.topic}`);
    parts.push(`Goal: ${b.goal}`);
    parts.push(`\n${b.summary}`);

    if (b.keyPoints.length > 0) {
      parts.push(`\n### Key Points`);
      b.keyPoints.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    }

    if (b.architectureDecisions.length > 0) {
      parts.push(`\n### Architecture Decisions`);
      b.architectureDecisions.forEach((d) =>
        parts.push(`- ${d.decision}\n  Rationale: ${d.rationale}`)
      );
    }

    if (b.expectedQuestions.length > 0) {
      parts.push(`\n### Expected Questions`);
      b.expectedQuestions.forEach((q) =>
        parts.push(`Q: ${q.question}\nA: ${q.suggestedAnswer}`)
      );
    }

    if (b.attendees.length > 0) {
      const others = b.attendees.filter((a) => !a.self);
      if (others.length > 0) {
        parts.push(`\n### Meeting Attendees`);
        others.forEach((a) =>
          parts.push(`- ${a.displayName || a.email}${a.displayName ? ` (${a.email})` : ""}`)
        );
        parts.push(`\nYou should admit these attendees if they are waiting to join.`);
      }
    }

    if (b.previousContext) {
      parts.push(`\n### Previous Meeting Review\n${b.previousContext}`);
    }

    if (b.liveNotes.length > 0) {
      parts.push(`\n### Live Updates`);
      b.liveNotes.forEach((n) => parts.push(`- ${n}`));
    }

    return parts.join("\n");
  }

  /**
   * Get a version of the brief optimized for Computer Use.
   * Emphasizes file paths, URLs, and actionable references.
   */
  getComputerBrief(): string {
    if (!this._currentBrief) return "";
    const b = this._currentBrief;
    const parts: string[] = [];

    parts.push(`Task context: ${b.topic} — ${b.goal}`);

    if (b.filePaths.length > 0) {
      parts.push(`\n## Local Files`);
      b.filePaths.forEach((f) =>
        parts.push(`- ${f.path}\n  ${f.description}${f.action ? ` [${f.action}]` : ""}`)
      );
    }

    if (b.browserUrls.length > 0) {
      parts.push(`\n## Browser URLs`);
      b.browserUrls.forEach((u) =>
        parts.push(`- ${u.url}\n  ${u.description}${u.action ? ` [${u.action}]` : ""}`)
      );
    }

    if (b.folderPaths.length > 0) {
      parts.push(`\n## Folders`);
      b.folderPaths.forEach((f) =>
        parts.push(`- ${f.path} — ${f.description}`)
      );
    }

    if (b.liveNotes.length > 0) {
      parts.push(`\n## Completed Tasks`);
      b.liveNotes.filter((n) => n.startsWith("[DONE]")).forEach((n) => parts.push(`- ${n}`));
    }

    return parts.join("\n");
  }

  /** Clear the current brief and stop the live log */
  clear() {
    // Stop live log if active
    if (this._liveLogPath) {
      stopLiveLog(this._liveLogPath).catch(() => {});
      this._liveLogPath = null;
    }
    this._currentBrief = null;
  }

  // parseResponse removed — now uses parseOC001 from openclaw-protocol.ts
  // Kept for backwards compat if needed externally
  private _parseResponseLegacy(raw: string, fallbackTopic: string): MeetingPrepBrief {
    return {
      ...parseOC001(raw, fallbackTopic),
      generatedAt: Date.now(),
      attendees: [],
      liveNotes: [],
    };
  }
}
