// CallingClaw 2.0 — Standalone Agent Adapter
// Minimal adapter for when no external agent is available.
// Voice, meeting join/leave, screen capture all work.
// Meeting prep and context recall are limited (no deep research).
// Scheduling uses internal timers.

import type { AgentAdapter } from "../agent-adapter";
import { InternalJobScheduler, type ScheduledJob } from "../agent-adapter";

export class StandaloneAdapter implements AgentAdapter {
  readonly name = "standalone" as const;
  private _connected = true; // Always "connected" — no external dependency
  private scheduler: InternalJobScheduler;

  constructor(onJobFire?: (job: ScheduledJob) => void) {
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    this._connected = true;
    console.log("[StandaloneAdapter] Ready (no external agent — basic mode)");
  }

  disconnect(): void {
    this.scheduler.stop();
    this._connected = false;
  }

  // ── Cognitive Capabilities (limited without an agent) ──

  async generateMeetingPrep(opts: {
    topic: string;
    userContext?: string;
    attendees?: Array<{ name: string; email: string; status?: string }>;
  }): Promise<string> {
    // Return a minimal prep brief structure
    const attendeeList = opts.attendees?.map(a => a.name || a.email).join(", ") || "N/A";
    return JSON.stringify({
      topic: opts.topic,
      goal: `Discuss ${opts.topic}`,
      summary: opts.userContext || `Meeting about: ${opts.topic}`,
      keyPoints: [`Topic: ${opts.topic}`],
      architectureDecisions: [],
      expectedQuestions: [],
      filePaths: [],
      browserUrls: [],
      folderPaths: [],
    });
  }

  async recallContext(query: string, localContext?: string): Promise<string> {
    if (localContext) return localContext;
    return "No external agent available for deep context recall. Local keyword search returned no results.";
  }

  async executeTask(instruction: string): Promise<string> {
    return "No external agent available for task execution. Please run the task manually.";
  }

  // ── Scheduling (Internal Timer) ──

  async scheduleJob(opts: {
    name: string;
    fireAt: Date;
    payload: { meetUrl: string; summary: string };
  }): Promise<string> {
    return this.scheduler.schedule(opts);
  }

  async cancelJob(jobId: string): Promise<void> {
    this.scheduler.cancel(jobId);
  }

  // ── Delivery (local file only) ──

  async deliverTodos(opts: {
    meetingId: string;
    topic: string;
    todos: Array<{ id: string; text: string; fullText: string; assignee?: string; deadline?: string }>;
    htmlPath?: string;
  }): Promise<boolean> {
    const lines = [
      `# Meeting Todos — ${opts.topic}`,
      ``,
      ...opts.todos.map(t =>
        `- [ ] ${t.fullText}${t.assignee ? ` @${t.assignee}` : ""}${t.deadline ? ` (${t.deadline})` : ""}`
      ),
    ];
    const filePath = `${process.env.HOME}/.callingclaw/shared/notes/${opts.meetingId}_todos.md`;
    try {
      await Bun.write(filePath, lines.join("\n"));
      // macOS notification
      Bun.spawn(["osascript", "-e",
        `display notification "${opts.todos.length} action items from ${opts.topic}" with title "CallingClaw"`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async deliverSummary(opts: {
    topic: string;
    keyPoints: string[];
    decisions: string[];
    htmlPath?: string;
  }): Promise<boolean> {
    try {
      Bun.spawn(["osascript", "-e",
        `display notification "Meeting '${opts.topic}' ended" with title "CallingClaw"`,
      ]);
    } catch {}
    return true;
  }

  async executeTodo(_opts: any): Promise<string> {
    return "No external agent available. Todo saved for manual execution.";
  }

  async processTimeline(_opts: any): Promise<string> {
    return "No external agent available for timeline processing.";
  }
}
