// CallingClaw 2.0 — Hermes Agent Adapter
// Uses `hermes -z "<prompt>"` subprocess for all cognitive tasks.
// Internal setTimeout for scheduling (no external cron dependency).
//
// This adapter enables CallingClaw to use Hermes Agent (NousResearch) as its
// agentic backend — no OpenClaw / Claude Code installation needed.
//
// Hermes headless invocation:
//   hermes -z "<prompt>"            → final answer as plain text only
//   hermes -z "<prompt>" -m <model> → per-run model/provider override
//
// Channels:
//   - Meeting prep:    hermes -z -m <HERMES_PREP_MODEL>   (deep research)
//   - Context recall:  hermes -z -m <HERMES_RECALL_MODEL> (fast)
//   - Task execution:  hermes -z -m <HERMES_TASK_MODEL>
//   - Scheduling:      Internal setTimeout + disk persistence
//   - Delivery:        Local file + macOS notification (Hermes polls events)

import type { AgentAdapter } from "../agent-adapter";
import { InternalJobScheduler, type ScheduledJob } from "../agent-adapter";
import { recordUsage } from "../modules/cost-meter";
import {
  OC001_PROMPT, type OC001_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";

const WORKSPACE_DIR = `${process.env.HOME}/.callingclaw/shared`;

// Resolve the hermes executable. The installer puts it at ~/.local/bin, which
// isn't always on a daemon's PATH, so fall back to the known install location.
// `HERMES_BIN` lets users point at a custom install (and tests at a stub).
function resolveHermesBin(): string {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  const local = `${process.env.HOME}/.local/bin/hermes`;
  try {
    if (require("fs").existsSync(local)) return local;
  } catch {}
  return "hermes"; // rely on PATH
}

// Model selection — bare model ids; provider (e.g. openrouter) comes from
// Hermes config / HERMES_PROVIDER. Override via env (read lazily so changes
// apply without a restart).
const prepModel = () => process.env.HERMES_PREP_MODEL || "anthropic/claude-sonnet-4.6";
const recallModel = () => process.env.HERMES_RECALL_MODEL || "anthropic/claude-haiku-4.5";
const taskModel = () => process.env.HERMES_TASK_MODEL || prepModel();
// Optional inference provider override (e.g. "openrouter"); falls back to Hermes config.
const provider = () => process.env.HERMES_PROVIDER || "";

export class HermesAdapter implements AgentAdapter {
  readonly name = "hermes" as const;
  private _connected = false;
  private scheduler: InternalJobScheduler;
  private _onActivity: ((kind: string, summary: string, detail?: string) => void) | null = null;

  constructor(onJobFire?: (job: ScheduledJob) => void) {
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    // Verify hermes CLI is available
    try {
      const proc = Bun.spawn([resolveHermesBin(), "--version"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      if (stdout.trim()) {
        this._connected = true;
        console.log(`[HermesAdapter] Connected (${stdout.trim()})`);
      } else {
        throw new Error("hermes CLI not found");
      }
    } catch (e: any) {
      this._connected = false;
      throw new Error(`Hermes not available: ${e.message}`);
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
    const result = await this.runHermes(OC001_PROMPT(req), {
      model: prepModel(),
      timeout: 120000, // 2 min for deep research
    });
    this._onActivity?.("adapter.prep_done", `Prep complete: ${opts.topic}`);
    return result;
  }

  async recallContext(query: string, localContext?: string): Promise<string> {
    const prompt = localContext
      ? `The user asked: "${query}"\n\nPre-fetched context:\n${localContext}\n\nExpand with more details from files in the workspace. Return concise answer under 500 words. ${LANGUAGE_RULE}`
      : `Search files and memory for: "${query}". Return concise factual answer under 500 words. ${LANGUAGE_RULE}`;

    return this.runHermes(prompt, {
      model: recallModel(),
      timeout: 30000,
    });
  }

  async executeTask(instruction: string): Promise<string> {
    this._onActivity?.("adapter.task_start", instruction.slice(0, 80));
    const result = await this.runHermes(instruction, {
      model: taskModel(),
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
    const lines = [
      `# Meeting Todos — ${opts.topic}`,
      ``,
      `Meeting ID: ${opts.meetingId}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
    ];

    opts.todos.forEach((t) => {
      lines.push(`- [ ] ${t.fullText}${t.assignee ? ` @${t.assignee}` : ""}${t.deadline ? ` (${t.deadline})` : ""}`);
    });

    if (opts.htmlPath) {
      lines.push(``, `HTML Summary: ${opts.htmlPath}`);
    }

    const filePath = `${WORKSPACE_DIR}/notes/${opts.meetingId}_todos.md`;
    try {
      await Bun.write(filePath, lines.join("\n"));
      console.log(`[HermesAdapter] Todos written to ${filePath}`);

      try {
        Bun.spawn(["osascript", "-e",
          `display notification "Meeting '${opts.topic}' ended with ${opts.todos.length} action items" with title "CallingClaw"`,
        ]);
      } catch {}

      return true;
    } catch (e: any) {
      console.error(`[HermesAdapter] Failed to write todos: ${e.message}`);
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
    const req: OC006_Request = {
      id: "OC-006",
      todo: opts.todo,
      meeting: opts.meeting,
    };
    return this.runHermes(OC006_PROMPT(req), {
      model: taskModel(),
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
    return this.runHermes(OC010_PROMPT(req), {
      model: prepModel(),
      timeout: 120000,
    });
  }

  // ── Activity Feed ──

  onActivity(fn: (kind: string, summary: string, detail?: string) => void): void {
    this._onActivity = fn;
  }

  // ── Hermes CLI Runner ──

  private async runHermes(prompt: string, opts: {
    model?: string;
    timeout?: number;
    cwd?: string;
  } = {}): Promise<string> {
    const timeout = opts.timeout || 30000;

    // `-z PROMPT`: single prompt in, final response text out. The prompt must
    // come immediately after -z (argparse treats -z as taking exactly one arg).
    const args: string[] = [resolveHermesBin(), "-z", prompt];
    if (opts.model) {
      args.push("-m", opts.model);
    }
    const prov = provider();
    if (prov) {
      args.push("--provider", prov);
    }

    const cwd = opts.cwd || WORKSPACE_DIR;

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`hermes -z timeout (${timeout}ms)`));
        }, timeout);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;
    if (exitCode !== 0 && !stdout) {
      throw new Error(`hermes -z exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // CostMeter: `agent` cost. `hermes -z` emits plain text only (no usage), so
    // record the call with tokens unknown — at least it's counted. Fail-soft.
    recordUsage({
      component: "agent",
      model: opts.model || "hermes",
      meta: { adapter: "hermes" },
    });

    // `-z` emits plain text only — no JSON envelope to parse.
    return stdout.trim();
  }
}
