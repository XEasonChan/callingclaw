// CallingClaw 2.0 — Module 5: Meeting Notes & Follow-up
// Handles: meeting recording, action items, todo extraction, summary, markdown export
// Consumes: SharedContext (transcript)
// Produces: meeting notes, action items, post-meeting markdown file
//
// Summary & extraction delegate to OpenClaw (richer context: MEMORY.md, project files, git).
// Falls back to OpenRouter/OpenAI only if OpenClaw is unavailable.

import type { SharedContext, MeetingNote } from "./shared-context";
import { CONFIG, SHARED_NOTES_DIR } from "../config";
import { registerNotesFile, listAllNoteFiles, readNoteFile as readSharedNoteFile } from "./shared-documents";
import type { OpenClawBridge } from "../openclaw_bridge";

const NOTES_DIR = SHARED_NOTES_DIR;
// Legacy directory kept for backward compatibility reads
const LEGACY_NOTES_DIR = `${import.meta.dir}/../../meeting_notes`;

export interface MeetingSummary {
  title: string;
  duration: string;
  participants: string[];
  keyPoints: string[];
  actionItems: Array<{ task: string; assignee?: string; deadline?: string }>;
  decisions: string[];
  followUps: string[];
}

export class MeetingModule {
  private context: SharedContext;
  private _openclawBridge: OpenClawBridge | null = null;
  private _meetingStartTime: number | null = null;
  private _extractionTimer: Timer | null = null;
  private _transcriptHandler: ((entry: any) => void) | null = null;

  constructor(context: SharedContext) {
    this.context = context;
  }

  /** Inject OpenClaw bridge for delegation (set after construction in callingclaw.ts) */
  set openclawBridge(bridge: OpenClawBridge | null) {
    this._openclawBridge = bridge;
  }

  /**
   * Start meeting recording mode.
   * Periodically extracts action items from the transcript.
   */
  startRecording() {
    this._meetingStartTime = Date.now();
    this._summaryCount = 0;
    this._lastSummaryHash = "";
    console.log("[Meeting] Recording started");

    // Extract action items every 2 minutes
    this._extractionTimer = setInterval(() => {
      this.extractActionItems();
    }, 120_000);

    // Also listen for new transcript entries
    this._transcriptHandler = (entry) => {
      // Auto-detect explicit action items in speech
      const text = entry.text.toLowerCase();
      if (
        text.includes("action item") ||
        text.includes("todo") ||
        text.includes("follow up") ||
        text.includes("待办") ||
        text.includes("跟进")
      ) {
        this.context.addNote({
          type: "action_item",
          text: entry.text,
          ts: Date.now(),
        });
      }
    };
    this.context.on("transcript", this._transcriptHandler);
  }

  /**
   * Stop recording
   */
  stopRecording() {
    if (this._extractionTimer) clearInterval(this._extractionTimer);
    if (this._transcriptHandler) {
      this.context.off("transcript", this._transcriptHandler);
      this._transcriptHandler = null;
    }
    this._meetingStartTime = null;
    console.log("[Meeting] Recording stopped");
  }

  /**
   * Extract action items — delegates to OpenClaw for richer context.
   * Falls back to direct LLM if OpenClaw unavailable.
   */
  async extractActionItems(): Promise<MeetingNote[]> {
    const transcript = this.context.getTranscriptText(50);
    if (!transcript) return [];

    try {
      let text: string;

      if (this._openclawBridge?.connected) {
        // Delegate to OpenClaw — it has MEMORY.md, project context, knows the people
        text = await this._openclawBridge.sendTaskIsolated(
          `Extract action items, decisions, and follow-ups from this meeting transcript.\n` +
          `Use your MEMORY.md and project knowledge to determine assignees and priorities.\n` +
          `**CRITICAL: Check MEMORY.md Lessons Learned for past mistakes or failures related to topics discussed.\n` +
          `Add prevention items (type: "action_item", text: "⚠️ Prevent repeat: ...") for relevant past failures.**\n` +
          `Return ONLY JSON: {"items": [{"type": "todo"|"decision"|"action_item", "text": "...", "assignee": "..."}]}\n\n` +
          `Transcript (last 50 entries):\n${transcript}`
        );
      } else if (CONFIG.openrouter.apiKey) {
        // Fallback: direct LLM call
        const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
          body: JSON.stringify({
            model: CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
            messages: [
              { role: "system", content: `Extract action items from meeting transcript. Return JSON: {"items": [{"type":"todo"|"decision"|"action_item","text":"...","assignee":"..."}]}` },
              { role: "user", content: transcript },
            ],
            max_tokens: 500, temperature: 0,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json() as any;
        text = data.choices?.[0]?.message?.content || "{}";
      } else {
        return [];
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || "{}");
      const items = parsed.items || parsed.action_items || [];

      for (const item of items) {
        this.context.addNote({
          type: item.type || "action_item",
          text: item.text,
          assignee: item.assignee,
          ts: Date.now(),
        });
      }

      console.log(`[Meeting] Extracted ${items.length} action items` + (this._openclawBridge?.connected ? " (via OpenClaw)" : " (via LLM)"));
      return items;
    } catch (e: any) {
      console.error("[Meeting] Extraction error:", e.message);
      return [];
    }
  }

  /**
   * Generate a full meeting summary — delegates to OpenClaw for deep context.
   * OpenClaw can cross-reference MEMORY.md, project files, and meeting history.
   */
  private _summaryGenerating = false;
  private _summaryCount = 0;
  private _lastSummaryHash = "";

  async generateSummary(): Promise<MeetingSummary> {
    // Circuit breaker: prevent infinite extraction loop (P0 bug — was consuming Opus tokens)
    if (this._summaryGenerating) {
      console.warn("[Meeting] Summary already generating — skipping duplicate request");
      return { title: "Meeting", duration: "unknown", participants: [], keyPoints: ["Summary in progress"], actionItems: [], decisions: [], followUps: [] };
    }
    if (this._summaryCount >= 3) {
      console.warn(`[Meeting] Circuit breaker: ${this._summaryCount} summaries already generated — refusing`);
      return { title: "Meeting", duration: "unknown", participants: [], keyPoints: ["Circuit breaker: too many summary attempts"], actionItems: [], decisions: [], followUps: [] };
    }

    const transcript = this.context.getConversationText(1000); // Full meeting transcript (was 200, ~5min only)

    // Idempotency: skip if transcript hasn't changed
    const hash = Bun.hash(transcript).toString(16);
    if (hash === this._lastSummaryHash && this._summaryCount > 0) {
      console.warn(`[Meeting] Transcript unchanged (hash ${hash}) — skipping duplicate summary`);
      return { title: "Meeting", duration: "unknown", participants: [], keyPoints: ["Duplicate request (same transcript)"], actionItems: [], decisions: [], followUps: [] };
    }

    this._summaryGenerating = true;
    this._summaryCount++;
    this._lastSummaryHash = hash;
    const notes = this.context.meetingNotes;
    const duration = this._meetingStartTime
      ? `${Math.round((Date.now() - this._meetingStartTime) / 60000)} minutes`
      : "unknown";

    try {
      let text: string;

      if (this._openclawBridge?.connected) {
        // Delegate to OpenClaw — richest context available
        console.log("[Meeting] Generating summary via OpenClaw (full context)...");
        text = await this._openclawBridge.sendTaskIsolated(
          `Generate a structured meeting summary from this transcript and notes.\n` +
          `Use your MEMORY.md and project knowledge to enrich the summary.\n\n` +
          `**CRITICAL: Search MEMORY.md Lessons Learned for past mistakes and failures related to this meeting's topics.\n` +
          `Add "⚠️ Past lesson:" items in keyPoints. Add prevention measures in followUps.\n` +
          `This ensures every summary carries forward past learnings so the same errors are never repeated.**\n\n` +
          `Return ONLY JSON:\n` +
          `{"title":"string","participants":["names"],"keyPoints":["points","⚠️ Past lesson: ..."],"actionItems":[{"task":"string","assignee":"name","deadline":"date"}],"decisions":["items"],"followUps":["items","Prevent repeat: ..."]}\n\n` +
          `Duration: ${duration}\n\n` +
          `Transcript:\n${transcript}\n\n` +
          `Existing notes:\n${JSON.stringify(notes)}`
        );
      } else if (CONFIG.openrouter.apiKey) {
        // Fallback: direct LLM call
        console.log("[Meeting] Generating summary via OpenRouter (no OpenClaw)...");
        const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-6",
            messages: [
              { role: "system", content: `Generate meeting summary as JSON: {title, participants[], keyPoints[], actionItems[{task,assignee,deadline}], decisions[], followUps[]}` },
              { role: "user", content: `Duration: ${duration}\n\nTranscript:\n${transcript}\n\nNotes:\n${JSON.stringify(notes)}` },
            ],
            max_tokens: 2000, temperature: 0,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await resp.json() as any;
        text = data.choices?.[0]?.message?.content || "{}";
      } else {
        return {
          title: "Meeting", duration, participants: [],
          keyPoints: ["No API available (OpenClaw or OpenRouter)"],
          actionItems: [], decisions: [], followUps: [],
        };
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const summary = JSON.parse(jsonMatch?.[0] || "{}") as MeetingSummary;
      summary.duration = duration;

      console.log("[Meeting] Summary generated" + (this._openclawBridge?.connected ? " (via OpenClaw)" : " (via LLM)"));
      return summary;
    } catch (e: any) {
      return {
        title: "Meeting Summary Error", duration, participants: [],
        keyPoints: [`Error: ${e.message}`],
        actionItems: [], decisions: [], followUps: [],
      };
    } finally {
      this._summaryGenerating = false;
    }
  }

  /**
   * Export meeting summary to a markdown file
   */
  async exportToMarkdown(summary?: MeetingSummary, filename?: string): Promise<string> {
    if (!summary) {
      summary = await this.generateSummary();
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
    const safeTitle = (summary.title || "meeting").replace(/[^a-zA-Z0-9\u4e00-\u9fff-_ ]/g, "").slice(0, 50);
    const fname = filename || `${dateStr}_${timeStr}_${safeTitle}.md`;
    const filepath = `${NOTES_DIR}/${fname}`;

    // Build markdown content — conversation only (no tool/system noise)
    const transcript = this.context.getConversationText(1000); // Full meeting (was 200)
    const md = `# ${summary.title}

**Date:** ${now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
**Duration:** ${summary.duration}
**Participants:** ${summary.participants?.length > 0 ? summary.participants.join(", ") : "N/A"}

---

## Key Points

${(summary.keyPoints || []).map((p) => `- ${p}`).join("\n")}

## Decisions

${(summary.decisions || []).length > 0 ? summary.decisions.map((d) => `- ${d}`).join("\n") : "_No decisions recorded._"}

## Action Items

| Task | Assignee | Deadline |
|------|----------|----------|
${(summary.actionItems || []).length > 0
  ? summary.actionItems.map((a) => `| ${a.task} | ${a.assignee || "TBD"} | ${a.deadline || "TBD"} |`).join("\n")
  : "| _No action items_ | — | — |"}

## Follow-ups

${(summary.followUps || []).length > 0 ? summary.followUps.map((f, i) => `${i + 1}. ${f}`).join("\n") : "_No follow-ups recorded._"}

---

## Full Transcript

\`\`\`
${transcript || "(No transcript captured)"}
\`\`\`

---

_Generated by CallingClaw 2.0 at ${now.toISOString()}_
`;

    // Ensure directory exists
    try {
      await Bun.$`mkdir -p ${NOTES_DIR}`;
    } catch {}

    await Bun.write(filepath, md);
    console.log(`[Meeting] Notes saved to: ${filepath}`);

    // Register in shared manifest (non-blocking)
    registerNotesFile(fname, summary.title || "Meeting").catch(() => {});

    return filepath;
  }

  /**
   * Get all captured notes and todos
   */
  getNotes() {
    return {
      notes: [...this.context.meetingNotes],
      todos: this.context.getTodos(),
      isRecording: this._meetingStartTime !== null,
      recordingDuration: this._meetingStartTime
        ? Math.round((Date.now() - this._meetingStartTime) / 1000)
        : 0,
    };
  }

  /**
   * List all saved meeting note files
   */
  async listSavedNotes(): Promise<string[]> {
    return listAllNoteFiles(LEGACY_NOTES_DIR);
  }

  /**
   * Read a specific meeting note file content
   */
  async readNoteFile(filename: string): Promise<string> {
    return readSharedNoteFile(filename, LEGACY_NOTES_DIR);
  }
}
