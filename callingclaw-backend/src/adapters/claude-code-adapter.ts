// CallingClaw 2.0 — Claude Code Agent Adapter
// Uses `claude -p` subprocess for all cognitive tasks.
// Internal setTimeout for scheduling (no OpenClaw cron dependency).
//
// This adapter enables CallingClaw to work with Claude Code as its
// agentic backend — no OpenClaw installation needed.
//
// Channels:
//   - Meeting prep:    claude -p --model sonnet (5-15s)
//   - Context recall:  claude -p --model haiku (2-5s)
//   - Task execution:  claude -p --model sonnet (3-30s)
//   - Scheduling:      Internal setTimeout + disk persistence
//   - Delivery:        Local file + EventBus notification

import type { AgentAdapter } from "../agent-adapter";
import { InternalJobScheduler, type ScheduledJob } from "../agent-adapter";
import {
  OC001_PROMPT, type OC001_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";

const WORKSPACE_DIR = `${process.env.HOME}/.callingclaw/shared`;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code" as const;
  private _connected = false;
  private scheduler: InternalJobScheduler;
  private _onActivity: ((kind: string, summary: string, detail?: string) => void) | null = null;

  constructor(onJobFire?: (job: ScheduledJob) => void) {
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    // Verify claude CLI is available
    try {
      const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      if (stdout.trim()) {
        this._connected = true;
        console.log(`[ClaudeCodeAdapter] Connected (${stdout.trim()})`);
      } else {
        throw new Error("claude CLI not found");
      }
    } catch (e: any) {
      this._connected = false;
      throw new Error(`Claude Code not available: ${e.message}`);
    }
  }

  disconnect(): void {
    this.scheduler.stop();
    this._connected = false;
  }

  // ── Cognitive Capabilities ──

  async generateMeetingPrep(opts: {
    topic: string;
    userContext?: string;
    attendees?: Array<{ name: string; email: string; status?: string }>;
  }): Promise<string> {
    // Reuse OC-001 prompt format — it's agent-agnostic
    const req: OC001_Request = {
      id: "OC-001",
      topic: opts.topic,
      userContext: opts.userContext,
      attendees: opts.attendees,
    };
    this._onActivity?.("adapter.prep_start", `Generating prep: ${opts.topic}`);
    const result = await this.runClaude(OC001_PROMPT(req), {
      model: "sonnet",
      maxTurns: 10,
      timeout: 120000, // 2 min for deep research
    });
    this._onActivity?.("adapter.prep_done", `Prep complete: ${opts.topic}`);
    return result;
  }

  async recallContext(query: string, localContext?: string): Promise<string> {
    const prompt = localContext
      ? `The user asked: "${query}"\n\nPre-fetched context:\n${localContext}\n\nExpand with more details from files in the workspace. Return concise answer under 500 words. ${LANGUAGE_RULE}`
      : `Search files and memory for: "${query}". Return concise factual answer under 500 words. ${LANGUAGE_RULE}`;

    return this.runClaude(prompt, {
      model: "haiku",
      maxTurns: 3,
      timeout: 30000,
    });
  }

  async executeTask(instruction: string): Promise<string> {
    this._onActivity?.("adapter.task_start", instruction.slice(0, 80));
    const result = await this.runClaude(instruction, {
      model: "sonnet",
      maxTurns: 10,
      timeout: 60000,
    });
    this._onActivity?.("adapter.task_done", result.slice(0, 80));
    return result;
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

  // ── Post-Meeting Delivery (Local File + Notification) ──

  async deliverTodos(opts: {
    meetingId: string;
    topic: string;
    todos: Array<{ id: string; text: string; fullText: string; assignee?: string; deadline?: string }>;
    htmlPath?: string;
  }): Promise<boolean> {
    // Write todos to a local file in shared directory
    const lines = [
      `# Meeting Todos — ${opts.topic}`,
      ``,
      `Meeting ID: ${opts.meetingId}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
    ];

    opts.todos.forEach((t, i) => {
      lines.push(`- [ ] ${t.fullText}${t.assignee ? ` @${t.assignee}` : ""}${t.deadline ? ` (${t.deadline})` : ""}`);
    });

    if (opts.htmlPath) {
      lines.push(``, `HTML Summary: ${opts.htmlPath}`);
    }

    const filePath = `${WORKSPACE_DIR}/notes/${opts.meetingId}_todos.md`;
    try {
      await Bun.write(filePath, lines.join("\n"));
      console.log(`[ClaudeCodeAdapter] Todos written to ${filePath}`);

      // macOS notification
      try {
        Bun.spawn(["osascript", "-e",
          `display notification "Meeting '${opts.topic}' ended with ${opts.todos.length} action items" with title "CallingClaw"`,
        ]);
      } catch {}

      return true;
    } catch (e: any) {
      console.error(`[ClaudeCodeAdapter] Failed to write todos: ${e.message}`);
      return false;
    }
  }

  async deliverSummary(opts: {
    topic: string;
    keyPoints: string[];
    decisions: string[];
    htmlPath?: string;
  }): Promise<boolean> {
    // macOS notification for summary-only meetings
    try {
      Bun.spawn(["osascript", "-e",
        `display notification "Meeting '${opts.topic}' ended — ${opts.keyPoints.length} key points" with title "CallingClaw"`,
      ]);
    } catch {}
    return true;
  }

  async executeTodo(opts: {
    todo: { fullText: string; assignee?: string; deadline?: string };
    meeting: {
      topic: string;
      time: string;
      notesFilePath: string;
      decisions: string[];
      requirements: string[];
      liveNotes: string[];
    };
  }): Promise<string> {
    // Reuse OC-006 prompt (agent-agnostic)
    const req: OC006_Request = {
      id: "OC-006",
      todo: opts.todo,
      meeting: opts.meeting,
    };
    return this.runClaude(OC006_PROMPT(req), {
      model: "sonnet",
      maxTurns: 15,
      timeout: 300000, // 5 min for deep work
    });
  }

  async processTimeline(opts: {
    meetingId: string;
    meetingDir: string;
    topic: string;
    duration: string;
    frameCount: number;
    transcriptEntries: number;
    priorityFrameCount: number;
    timelineFile: string;
    notesFilePath?: string;
  }): Promise<string> {
    const req: OC010_Request = { id: "OC-010", ...opts };
    return this.runClaude(OC010_PROMPT(req), {
      model: "sonnet",
      maxTurns: 10,
      timeout: 120000,
    });
  }

  // ── Activity Feed ──

  onActivity(fn: (kind: string, summary: string, detail?: string) => void): void {
    this._onActivity = fn;
  }

  // ── Claude CLI Runner ──

  private async runClaude(prompt: string, opts: {
    model?: string;
    maxTurns?: number;
    timeout?: number;
    tools?: string[];
    cwd?: string;
  } = {}): Promise<string> {
    const model = opts.model || "sonnet";
    const maxTurns = opts.maxTurns || 5;
    const timeout = opts.timeout || 30000;

    const args: string[] = [
      "claude", "-p",
      "--disable-slash-commands",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
      "--max-turns", String(maxTurns),
      "--no-session-persistence",
    ];

    if (opts.tools && opts.tools.length > 0) {
      args.push("--tools", opts.tools.join(","));
    }

    args.push(prompt);

    const cwd = opts.cwd || WORKSPACE_DIR;

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    const [stdout, stderr] = await Promise.all([
      Promise.race([
        new Response(proc.stdout).text(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`claude -p timeout (${timeout}ms)`)), timeout)
        ),
      ]),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0 && !stdout) {
      throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Parse JSON output format
    try {
      const parsed = JSON.parse(stdout);
      return parsed.result || parsed.content || parsed.text || stdout;
    } catch {
      return stdout.trim();
    }
  }
}
