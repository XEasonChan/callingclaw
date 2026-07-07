// CallingClaw 2.0 — OpenClaw Agent Adapter
// Wraps existing OpenClawBridge + OC protocol into the AgentAdapter interface.
// This preserves all existing behavior: Gateway WS, session management, cron jobs.

import { InternalJobScheduler, type AgentAdapter, type ScheduledJob } from "../agent-adapter";
import type { OpenClawBridge } from "../openclaw_bridge";
import { recordUsage } from "../modules/cost-meter";
import {
  OC001_PROMPT, type OC001_Request,
  OC002_PROMPT, type OC002_Request,
  OC004_PROMPT, type OC004_Request,
  OC005_PROMPT, type OC005_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw" as const;
  private bridge: OpenClawBridge;
  private scheduler: InternalJobScheduler;

  constructor(bridge: OpenClawBridge, onJobFire?: (job: ScheduledJob) => void) {
    this.bridge = bridge;
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this.bridge.connected; }

  /**
   * CostMeter (Finding 3b): the OpenClaw path is the DOMINANT `agent` cost when
   * AGENT_PLATFORM=openclaw, yet the Gateway/OC protocol returns only a text
   * result — no token counts, no total_cost_usd. So we can only count the CALL
   * (tokens-unknown), mirroring the plain-text CLI adapters (Hermes/Codex).
   * Recorded at the adapter method level (never reaching into OpenClawBridge),
   * attributed via the active meeting / withAttribution() scope. Fail-soft:
   * metering must never break the underlying task, so the usage is recorded in a
   * `finally` and the sendTask result/rejection is returned untouched.
   */
  private async sendTaskMetered(prompt: string): Promise<string> {
    try {
      return await this.bridge.sendTask(prompt);
    } finally {
      try {
        recordUsage({
          component: "agent",
          // OpenClaw's model lives in ~/.openclaw/openclaw.json (not exposed by
          // the bridge); OPENCLAW_MODEL is an optional hint, else undefined.
          model: process.env.OPENCLAW_MODEL || undefined,
          meta: { adapter: "openclaw" },
        });
      } catch { /* metering must never break a task */ }
    }
  }

  async connect(): Promise<void> {
    await this.bridge.connect();
  }

  disconnect(): void {
    this.bridge.disconnect();
  }

  // ── Cognitive Capabilities ──

  async generateMeetingPrep(opts: {
    topic: string;
    userContext?: string;
    attendees?: Array<{ name: string; email: string; status?: string }>;
  }): Promise<string> {
    const req: OC001_Request = {
      id: "OC-001",
      topic: opts.topic,
      userContext: opts.userContext,
      attendees: opts.attendees,
    };
    return this.sendTaskMetered(OC001_PROMPT(req));
  }

  async recallContext(query: string, localContext?: string): Promise<string> {
    const req: OC002_Request = {
      id: "OC-002",
      query,
      localContext,
      language: "auto",
    };
    return this.sendTaskMetered(OC002_PROMPT(req));
  }

  async executeTask(instruction: string): Promise<string> {
    return this.sendTaskMetered(instruction);
  }

  // ── Scheduling (InternalJobScheduler — reliable setTimeout + disk persistence) ──
  // OC-003 cron was removed: LLM-in-the-scheduling-loop was fragile.
  // Scheduling is deterministic and should never depend on an LLM.

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

  // ── Post-Meeting Delivery (OpenClaw → Telegram) ──

  async deliverTodos(opts: {
    meetingId: string;
    topic: string;
    todos: Array<{ id: string; text: string; fullText: string; assignee?: string; deadline?: string }>;
    htmlPath?: string;
  }): Promise<boolean> {
    const req: OC004_Request = {
      id: "OC-004",
      topic: opts.topic,
      meetingId: opts.meetingId,
      todos: opts.todos,
      htmlPath: opts.htmlPath,
    };
    const result = await this.sendTaskMetered(OC004_PROMPT(req));
    return result.toLowerCase().includes("sent");
  }

  async deliverSummary(opts: {
    topic: string;
    keyPoints: string[];
    decisions: string[];
    htmlPath?: string;
  }): Promise<boolean> {
    const req: OC005_Request = {
      id: "OC-005",
      topic: opts.topic,
      keyPoints: opts.keyPoints,
      decisions: opts.decisions,
      htmlPath: opts.htmlPath,
    };
    const result = await this.sendTaskMetered(OC005_PROMPT(req));
    return result.toLowerCase().includes("sent");
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
    return this.sendTaskMetered(OC006_PROMPT(req));
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
    const req: OC010_Request = {
      id: "OC-010",
      ...opts,
    };
    return this.sendTaskMetered(OC010_PROMPT(req));
  }

  // ── Activity Feed ──

  onActivity(fn: (kind: string, summary: string, detail?: string) => void): void {
    this.bridge.onActivity(fn);
  }
}
