// CallingClaw 2.0 — Module 5: Meeting Notes & Follow-up
// Handles: meeting recording, action items, todo extraction, summary, markdown export
// Consumes: SharedContext (transcript)
// Produces: meeting notes, action items, post-meeting markdown file

import type { SharedContext, MeetingNote } from "./shared-context";
import { CONFIG, SHARED_NOTES_DIR } from "../config";
import { registerNotesFile, listAllNoteFiles, readNoteFile as readSharedNoteFile } from "./shared-documents";

const NOTES_DIR = SHARED_NOTES_DIR;
// Legacy directory kept for backward compatibility reads
const LEGACY_NOTES_DIR = `${import.meta.dir}/../../meeting_notes`;

/** Call OpenRouter (or OpenAI as fallback) for chat completions */
async function llmChat(model: string, messages: Array<{role: string; content: string}>, maxTokens = 2000): Promise<string> {
  // Prefer OpenRouter (works with any model, single key)
  if (CONFIG.openrouter.apiKey) {
    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json() as any;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || "";
  }
  // Fallback to direct OpenAI
  if (CONFIG.openai.apiKey) {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: CONFIG.openai.apiKey });
    const resp = await openai.chat.completions.create({
      model: model.replace("anthropic/", "").replace("openai/", ""),
      messages: messages as any,
      max_tokens: maxTokens,
    });
    return resp.choices[0]?.message?.content || "";
  }
  throw new Error("No API key configured (OpenRouter or OpenAI)");
}

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
  private _meetingStartTime: number | null = null;
  private _extractionTimer: Timer | null = null;
  private _transcriptHandler: ((entry: any) => void) | null = null;

  constructor(context: SharedContext) {
    this.context = context;
  }

  /**
   * Start meeting recording mode.
   * Periodically extracts action items from the transcript.
   */
  startRecording() {
    this._meetingStartTime = Date.now();
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
   * Use GPT-4o to extract action items from recent transcript
   */
  async extractActionItems(): Promise<MeetingNote[]> {
    if (!CONFIG.openrouter.apiKey && !CONFIG.openai.apiKey) return [];

    const transcript = this.context.getTranscriptText(50);
    if (!transcript) return [];

    try {
      const text = await llmChat(
        CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
        [
          {
            role: "system",
            content: `Extract action items, decisions, and follow-ups from this meeting transcript.
Return JSON: {"items": [{"type": "todo"|"decision"|"action_item", "text": "...", "assignee": "..."}]}
Only include items NOT already captured. Be concise.`,
          },
          { role: "user", content: transcript },
        ],
        500,
      );

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

      console.log(`[Meeting] Extracted ${items.length} action items`);
      return items;
    } catch (e: any) {
      console.error("[Meeting] Extraction error:", e.message);
      return [];
    }
  }

  /**
   * Generate a full meeting summary after the meeting ends
   */
  async generateSummary(): Promise<MeetingSummary> {
    // Use conversation-only transcript (user + assistant speech).
    // Excludes system/tool entries to prevent OpenClaw task pollution in summaries.
    const transcript = this.context.getConversationText(200);
    const notes = this.context.meetingNotes;
    const duration = this._meetingStartTime
      ? `${Math.round((Date.now() - this._meetingStartTime) / 60000)} minutes`
      : "unknown";

    if (!CONFIG.openrouter.apiKey && !CONFIG.openai.apiKey) {
      return {
        title: "Meeting",
        duration,
        participants: [],
        keyPoints: ["No API key configured (OpenRouter or OpenAI)"],
        actionItems: [],
        decisions: [],
        followUps: [],
      };
    }

    try {
      // Use Claude Sonnet via OpenRouter for high-quality summaries (cheaper than GPT-4o)
      const text = await llmChat(
        "anthropic/claude-sonnet-4-6",
        [
          {
            role: "system",
            content: `Generate a structured meeting summary from this transcript and notes.
Return JSON with: {title, participants[], keyPoints[], actionItems[{task, assignee, deadline}], decisions[], followUps[]}
Focus on capturing the user's opinions, standards, and expectations for follow-up work.
Be thorough — this will be used for ongoing project tracking.`,
          },
          {
            role: "user",
            content: `Duration: ${duration}\n\nTranscript:\n${transcript}\n\nExisting notes:\n${JSON.stringify(notes)}`,
          },
        ],
        2000,
      );

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const summary = JSON.parse(jsonMatch?.[0] || "{}") as MeetingSummary;
      summary.duration = duration;

      console.log("[Meeting] Summary generated");
      return summary;
    } catch (e: any) {
      return {
        title: "Meeting Summary Error",
        duration,
        participants: [],
        keyPoints: [`Error: ${e.message}`],
        actionItems: [],
        decisions: [],
        followUps: [],
      };
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
    const transcript = this.context.getConversationText(200);
    const md = `# ${summary.title}

**Date:** ${now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
**Duration:** ${summary.duration}
**Participants:** ${summary.participants.length > 0 ? summary.participants.join(", ") : "N/A"}

---

## Key Points

${summary.keyPoints.map((p) => `- ${p}`).join("\n")}

## Decisions

${summary.decisions.length > 0 ? summary.decisions.map((d) => `- ${d}`).join("\n") : "_No decisions recorded._"}

## Action Items

| Task | Assignee | Deadline |
|------|----------|----------|
${summary.actionItems.length > 0
  ? summary.actionItems.map((a) => `| ${a.task} | ${a.assignee || "TBD"} | ${a.deadline || "TBD"} |`).join("\n")
  : "| _No action items_ | — | — |"}

## Follow-ups

${summary.followUps.length > 0 ? summary.followUps.map((f, i) => `${i + 1}. ${f}`).join("\n") : "_No follow-ups recorded._"}

---

## Full Transcript

\`\`\`
${transcript || "(No transcript captured)"}
\`\`\`

---

_Generated by CallingClaw 2.0 at ${now.toISOString()}_
`;

    // Ensure directory exists
    const dir = Bun.file(NOTES_DIR);
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
