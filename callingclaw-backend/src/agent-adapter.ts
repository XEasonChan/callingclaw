// CallingClaw 2.0 — Agent Adapter Interface
// ═══════════════════════════════════════════════════════════════════
//
// Abstracts the "cognitive backend" so CallingClaw works with any
// agentic platform: OpenClaw, Claude Code, Manus Desktop, or standalone.
//
// CallingClaw's core value (voice, audio, screen, meeting lifecycle)
// lives in the REST API on localhost:4000. The AgentAdapter provides:
//   - Meeting prep generation (research + structured brief)
//   - Context recall (memory/file search for voice AI)
//   - Task execution (computer use, browser automation, file editing)
//   - Job scheduling (internal timer or external cron)
//   - Post-meeting delivery (Telegram, local file, etc.)
//
// Implementations:
//   OpenClawAdapter   — Gateway WS + subprocess fallback (original)
//   ClaudeCodeAdapter — claude -p subprocess for all cognitive tasks
//   StandaloneAdapter — No external agent, internal scheduling only
//
// ═══════════════════════════════════════════════════════════════════

import type { MeetingPrepBrief } from "./skills/meeting-prep";
import type { CalendarAttendee, CalendarEvent } from "./mcp_client/google_cal";
import type { MeetingSummary } from "./modules/meeting";

// ── Agent Adapter Interface ──

export type AgentPlatform = "openclaw" | "claude-code" | "standalone";

export interface AgentAdapter {
  /** Platform identifier */
  readonly name: AgentPlatform;

  /** Whether the adapter is connected and ready */
  readonly connected: boolean;

  // ── Lifecycle ──

  /** Initialize connection (WebSocket, health check, etc.) */
  connect(): Promise<void>;

  /** Graceful shutdown */
  disconnect(): void;

  // ── Cognitive Capabilities ──

  /**
   * Generate a meeting prep brief.
   * Agent reads its memory + relevant files → produces structured JSON brief.
   */
  generateMeetingPrep(opts: {
    topic: string;
    userContext?: string;
    attendees?: Array<{ name: string; email: string; status?: string }>;
  }): Promise<string>;

  /**
   * Recall context for a voice AI query.
   * Returns concise factual answer (<500 words).
   */
  recallContext(query: string, localContext?: string): Promise<string>;

  /**
   * Execute a free-form task (computer use delegation, file editing, etc.)
   * Returns the agent's text response.
   */
  executeTask(instruction: string): Promise<string>;

  // ── Scheduling ──

  /**
   * Schedule a job to fire at a specific time.
   * Returns a job ID for cancellation.
   */
  scheduleJob(opts: {
    name: string;
    fireAt: Date;
    payload: { meetUrl: string; summary: string };
  }): Promise<string>;

  /** Cancel a previously scheduled job */
  cancelJob(jobId: string): Promise<void>;

  // ── Post-Meeting Delivery ──

  /**
   * Deliver post-meeting todos to the user.
   * Implementation varies: Telegram (OpenClaw), local file, notification, etc.
   */
  deliverTodos(opts: {
    meetingId: string;
    topic: string;
    todos: Array<{ id: string; text: string; fullText: string; assignee?: string; deadline?: string }>;
    htmlPath?: string;
  }): Promise<boolean>;

  /**
   * Deliver a summary-only message (no action items).
   */
  deliverSummary(opts: {
    topic: string;
    keyPoints: string[];
    decisions: string[];
    htmlPath?: string;
  }): Promise<boolean>;

  /**
   * Hand off a confirmed todo for execution.
   * Agent reads meeting notes + memory → spawns sub-agent to execute.
   */
  executeTodo(opts: {
    todo: { fullText: string; assignee?: string; deadline?: string };
    meeting: {
      topic: string;
      time: string;
      notesFilePath: string;
      decisions: string[];
      requirements: string[];
      liveNotes: string[];
    };
  }): Promise<string>;

  /**
   * Process multimodal meeting timeline (screenshots + transcript → action items).
   */
  processTimeline(opts: {
    meetingId: string;
    meetingDir: string;
    topic: string;
    duration: string;
    frameCount: number;
    transcriptEntries: number;
    priorityFrameCount: number;
    timelineFile: string;
    notesFilePath?: string;
  }): Promise<string>;

  // ── Activity Feed (optional) ──

  /** Register callback for real-time activity events (streaming deltas, completions) */
  onActivity?(fn: (kind: string, summary: string, detail?: string) => void): void;
}

// ── Scheduled Job Store (internal timer-based scheduling) ──

export interface ScheduledJob {
  id: string;
  name: string;
  fireAt: Date;
  payload: { meetUrl: string; summary: string };
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Internal job scheduler using setTimeout.
 * Used by ClaudeCodeAdapter and StandaloneAdapter (no external cron dependency).
 * Persists jobs to disk so they survive restarts.
 */
export class InternalJobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private onFire: (job: ScheduledJob) => void;
  private persistPath: string;

  constructor(onFire: (job: ScheduledJob) => void) {
    this.onFire = onFire;
    this.persistPath = `${process.env.HOME}/.callingclaw/scheduled-jobs.json`;
    this.loadPersistedJobs();
  }

  schedule(opts: { name: string; fireAt: Date; payload: { meetUrl: string; summary: string } }): string {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const delayMs = Math.max(opts.fireAt.getTime() - Date.now(), 1000); // At least 1s

    const timer = setTimeout(() => {
      const job = this.jobs.get(id);
      if (job) {
        this.jobs.delete(id);
        this.persist();
        this.onFire(job);
      }
    }, delayMs);

    const job: ScheduledJob = { id, name: opts.name, fireAt: opts.fireAt, payload: opts.payload, timer };
    this.jobs.set(id, job);
    this.persist();

    console.log(`[JobScheduler] Scheduled "${opts.name}" at ${opts.fireAt.toLocaleTimeString("zh-CN")} (in ${Math.round(delayMs / 1000)}s)`);
    return id;
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      clearTimeout(job.timer);
      this.jobs.delete(jobId);
      this.persist();
      console.log(`[JobScheduler] Cancelled "${job.name}"`);
    }
  }

  get activeJobs(): ScheduledJob[] {
    return [...this.jobs.values()];
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
    }
    this.jobs.clear();
  }

  private persist(): void {
    try {
      const data = [...this.jobs.values()].map(j => ({
        id: j.id,
        name: j.name,
        fireAt: j.fireAt.toISOString(),
        payload: j.payload,
      }));
      Bun.write(this.persistPath, JSON.stringify(data, null, 2)).catch(() => {});
    } catch {}
  }

  private loadPersistedJobs(): void {
    try {
      const raw = require("fs").readFileSync(this.persistPath, "utf-8");
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const entry of data) {
        const fireAt = new Date(entry.fireAt);
        if (fireAt.getTime() > now) {
          // Re-schedule
          this.schedule({ name: entry.name, fireAt, payload: entry.payload });
        }
      }
    } catch { /* no persisted jobs or corrupt — start fresh */ }
  }
}

// ── Factory ──

export function createAgentAdapter(platform: AgentPlatform, deps?: any): AgentAdapter {
  switch (platform) {
    case "openclaw": {
      const { OpenClawAdapter } = require("./adapters/openclaw-adapter");
      return new OpenClawAdapter(deps?.openclawBridge);
    }
    case "claude-code": {
      const { ClaudeCodeAdapter } = require("./adapters/claude-code-adapter");
      return new ClaudeCodeAdapter(deps?.onJobFire);
    }
    case "standalone": {
      const { StandaloneAdapter } = require("./adapters/standalone-adapter");
      return new StandaloneAdapter(deps?.onJobFire);
    }
    default:
      throw new Error(`Unknown agent platform: ${platform}`);
  }
}
