// CallingClaw 2.0 — Meeting Prep Skill
// ═══════════════════════════════════════════════════════════════════
// This is the "slow thinking" (System 2) component.
// OpenClaw reads its full memory + relevant files, then generates a
// structured Meeting Prep Brief that becomes the single context source
// for the "fast thinking" Voice AI and Computer Use layers.
//
// Flow:
//   User: "Prepare a meeting about CallingClaw PRD"
//   → OpenClaw reads MEMORY.md + PRD + project files
//   → Generates MeetingPrepBrief (this file)
//   → Brief injected into Voice AI system prompt
//   → Brief's file paths/URLs available to Computer Use 4-layer automation
//
// Usage:
//   const skill = new MeetingPrepSkill(openclawBridge);
//   const brief = await skill.generate("CallingClaw 2.0 PRD review");
//   voiceModule.updateInstructions(buildVoiceInstructions(brief));
// ═══════════════════════════════════════════════════════════════════

import type { OpenClawBridge } from "../openclaw_bridge";
import type { CalendarAttendee } from "../mcp_client/google_cal";
import { savePrepBrief, startLiveLog, appendToLiveLog, stopLiveLog, generateMeetingId } from "../modules/shared-documents";
import { OC001_PROMPT, parseOC001, type OC001_Request } from "../openclaw-protocol";

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
}

// Prompt template moved to openclaw-protocol.ts (OC-001)
// Use OC001_PROMPT(req) to generate the prompt.

// ── Meeting Prep Skill ──

export class MeetingPrepSkill {
  private bridge: OpenClawBridge;
  private _currentBrief: MeetingPrepBrief | null = null;
  private _onLiveNote?: (note: string, topic: string) => void;
  private _onPrepReady?: (brief: MeetingPrepBrief, meetingId: string, filePath: string) => void;
  private _liveLogPath: string | null = null;
  private _sessionManager: import("../modules/session-manager").SessionManager | null = null;

  constructor(bridge: OpenClawBridge) {
    this.bridge = bridge;
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

  /**
   * Generate a Meeting Prep Brief by delegating to OpenClaw.
   * OpenClaw will read its MEMORY.md + relevant files and produce the brief.
   *
   * @param topic - What the meeting is about (e.g., "CallingClaw 2.0 PRD review")
   * @param userContext - Any additional instructions from the user
   */
  async generate(topic: string, userContext?: string, attendees?: CalendarAttendee[], meetingId?: string): Promise<MeetingPrepBrief> {
    // Build typed request (OC-001)
    const req: OC001_Request = {
      id: "OC-001",
      topic,
      userContext,
      attendees: attendees
        ?.filter((a) => !a.self)
        .map((a) => ({
          name: a.displayName || "",
          email: a.email,
          status: a.responseStatus,
        })),
    };

    console.log(`[MeetingPrep] Generating brief for: "${topic}" (${attendees?.length || 0} attendees, meetingId=${meetingId || "auto"})`);
    const startTime = Date.now();

    // Delegate to OpenClaw via OC-001 protocol
    const rawResult = await this.bridge.sendTask(OC001_PROMPT(req));

    console.log(`[MeetingPrep] OpenClaw responded in ${Date.now() - startTime}ms`);

    // Parse with typed parser
    const brief = parseOC001(rawResult, topic) as any as MeetingPrepBrief;
    brief.generatedAt = Date.now();
    brief.liveNotes = [];
    brief.attendees = attendees || [];

    this._currentBrief = brief;
    console.log(`[MeetingPrep] Brief ready: ${brief.keyPoints.length} key points, ${brief.filePaths.length} files, ${brief.browserUrls.length} URLs`);

    // Persist prep brief to shared directory (non-blocking)
    // Use SessionManager if available (atomic file + session update), fallback to legacy
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
      // Legacy fallback
      savePrepBrief(brief, actualId).then((filePath) => {
        this._onPrepReady?.(brief, actualId, filePath);
      }).catch((e: any) => {
        console.warn(`[MeetingPrep] Failed to save prep brief to disk: ${e.message}`);
      });
      startLiveLog(topic, actualId).then((logPath) => {
        this._liveLogPath = logPath;
      }).catch((e: any) => {
        console.warn(`[MeetingPrep] Failed to start live log: ${e.message}`);
      });
    }

    return brief;
  }

  /**
   * Add a live note during the meeting (OpenClaw pushes context updates).
   * This gets synced to Voice AI via session.update.
   */
  addLiveNote(note: string): void {
    if (!this._currentBrief) return;
    this._currentBrief.liveNotes.push(note);
    console.log(`[MeetingPrep] Live note added: "${note.slice(0, 60)}"`);

    // Append to live log file on disk
    if (this._liveLogPath) {
      appendToLiveLog(this._liveLogPath, `[NOTE] ${note}`);
    }

    this._onLiveNote?.(note, this._currentBrief.topic);
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
