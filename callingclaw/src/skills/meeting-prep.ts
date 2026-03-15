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

// ── OpenClaw Prompt Template ──
// This prompt is sent to OpenClaw to generate the prep brief.
// OpenClaw has full access to its MEMORY.md + file system + tools.

export const MEETING_PREP_PROMPT = `You are preparing a Meeting Prep Brief for CallingClaw's voice AI assistant.

## Your Task
Read the relevant files and your memory, then generate a structured JSON meeting prep brief.

## Meeting Topic
{TOPIC}

## Additional Context from User
{USER_CONTEXT}

## What to Include

1. **summary**: 2-3 paragraphs summarizing what will be presented. Write in the user's preferred language.

2. **keyPoints**: List of 5-8 bullet points covering the main topics to discuss.

3. **architectureDecisions**: For each major technical decision, explain WHAT was decided and WHY. This helps the voice AI explain rationale when asked.

4. **expectedQuestions**: 3-5 questions that might come up, with suggested answers.

5. **previousContext**: If there were previous meetings on this topic, summarize key outcomes and open items.

6. **filePaths**: List all relevant local files with their absolute paths. Include:
   - Source code files that will be discussed
   - Documentation / PRD files
   - Configuration files
   - For each, suggest an action: "open" (view), "scroll" (present), "present" (step through)

7. **browserUrls**: List all relevant web URLs:
   - GitHub repos, PR links
   - Deployed app URLs
   - Design tools (Figma, etc.)
   - Documentation sites

8. **folderPaths**: Key project directories the user might want to show.

## Output Format
Return ONLY valid JSON matching this structure:
\`\`\`json
{
  "topic": "...",
  "goal": "...",
  "summary": "...",
  "keyPoints": ["...", "..."],
  "architectureDecisions": [{"decision": "...", "rationale": "..."}],
  "expectedQuestions": [{"question": "...", "suggestedAnswer": "..."}],
  "previousContext": "...",
  "filePaths": [{"path": "...", "description": "...", "action": "open"}],
  "browserUrls": [{"url": "...", "description": "...", "action": "navigate"}],
  "folderPaths": [{"path": "...", "description": "..."}]
}
\`\`\`

Be thorough with file paths — the voice AI's computer use module relies on these to navigate the screen during the meeting. Use absolute paths.`;

// ── Meeting Prep Skill ──

export class MeetingPrepSkill {
  private bridge: OpenClawBridge;
  private _currentBrief: MeetingPrepBrief | null = null;

  constructor(bridge: OpenClawBridge) {
    this.bridge = bridge;
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
  async generate(topic: string, userContext?: string, attendees?: CalendarAttendee[]): Promise<MeetingPrepBrief> {
    // Build attendee context for the prompt
    const attendeeContext = attendees?.length
      ? `\n## Meeting Attendees\n${attendees
          .filter((a) => !a.self)
          .map((a) => `- ${a.displayName || a.email}${a.displayName ? ` (${a.email})` : ""}${a.responseStatus ? ` — ${a.responseStatus}` : ""}`)
          .join("\n")}`
      : "";

    const prompt = MEETING_PREP_PROMPT
      .replace("{TOPIC}", topic)
      .replace("{USER_CONTEXT}", (userContext || "(no additional context)") + attendeeContext);

    console.log(`[MeetingPrep] Generating brief for: "${topic}" (${attendees?.length || 0} attendees)`);
    const startTime = Date.now();

    // Delegate to OpenClaw — it has full memory + file access
    const rawResult = await this.bridge.sendTask(
      `Generate a meeting prep brief. Follow these instructions exactly:\n\n${prompt}`
    );

    console.log(`[MeetingPrep] OpenClaw responded in ${Date.now() - startTime}ms`);

    // Parse JSON from OpenClaw's response
    const brief = this.parseResponse(rawResult, topic);
    brief.generatedAt = Date.now();
    brief.liveNotes = [];
    brief.attendees = attendees || [];

    this._currentBrief = brief;
    console.log(`[MeetingPrep] Brief ready: ${brief.keyPoints.length} key points, ${brief.filePaths.length} files, ${brief.browserUrls.length} URLs`);

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

  /** Clear the current brief */
  clear() {
    this._currentBrief = null;
  }

  // ── Internal: Parse OpenClaw's response into structured brief ──

  private parseResponse(raw: string, fallbackTopic: string): MeetingPrepBrief {
    // Try to extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          topic: parsed.topic || fallbackTopic,
          goal: parsed.goal || "",
          generatedAt: Date.now(),
          summary: parsed.summary || "",
          keyPoints: parsed.keyPoints || [],
          architectureDecisions: parsed.architectureDecisions || [],
          expectedQuestions: parsed.expectedQuestions || [],
          previousContext: parsed.previousContext || undefined,
          filePaths: parsed.filePaths || [],
          browserUrls: parsed.browserUrls || [],
          folderPaths: parsed.folderPaths || [],
          attendees: [],
          liveNotes: [],
        };
      } catch (e) {
        console.warn("[MeetingPrep] JSON parse failed, using raw text as summary");
      }
    }

    // Fallback: use raw text as summary
    return {
      topic: fallbackTopic,
      goal: "Discuss " + fallbackTopic,
      generatedAt: Date.now(),
      summary: raw.slice(0, 2000),
      keyPoints: [],
      architectureDecisions: [],
      expectedQuestions: [],
      filePaths: [],
      browserUrls: [],
      folderPaths: [],
      attendees: [],
      liveNotes: [],
    };
  }
}
