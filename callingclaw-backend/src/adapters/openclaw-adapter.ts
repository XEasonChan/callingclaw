// CallingClaw 2.0 — OpenClaw Agent Adapter
// Wraps existing OpenClawBridge + OC protocol into the AgentAdapter interface.
// This preserves all existing behavior: Gateway WS, session management, cron jobs.

import type { AgentAdapter, ScheduledJob } from "../agent-adapter";
import type { OpenClawBridge } from "../openclaw_bridge";
import {
  OC001_PROMPT, type OC001_Request,
  OC002_PROMPT, type OC002_Request,
  OC003_PROMPT, parseOC003, type OC003_Request,
  OC004_PROMPT, type OC004_Request,
  OC005_PROMPT, type OC005_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw" as const;
  private bridge: OpenClawBridge;

  constructor(bridge: OpenClawBridge) {
    this.bridge = bridge;
  }

  get connected() { return this.bridge.connected; }

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
    return this.bridge.sendTask(OC001_PROMPT(req));
  }

  async recallContext(query: string, localContext?: string): Promise<string> {
    const req: OC002_Request = {
      id: "OC-002",
      query,
      localContext,
      language: "auto",
    };
    return this.bridge.sendTask(OC002_PROMPT(req));
  }

  async executeTask(instruction: string): Promise<string> {
    return this.bridge.sendTask(instruction);
  }

  // ── Scheduling (OpenClaw Cron — OC-003) ──

  async scheduleJob(opts: {
    name: string;
    fireAt: Date;
    payload: { meetUrl: string; summary: string };
  }): Promise<string> {
    const joinAtISO = opts.fireAt.toISOString();
    const eventDescription = [
      `Meeting starting soon — auto-join`,
      ``,
      `**Topic**: ${opts.payload.summary}`,
      `**Meet link**: ${opts.payload.meetUrl}`,
      ``,
      `Steps to execute:`,
      `1. Call CallingClaw API to join the meeting:`,
      `   curl -s -X POST http://localhost:4000/api/meeting/join -H "Content-Type: application/json" -d '{"url": "${opts.payload.meetUrl}"}'`,
      `2. After confirming join success, notify the user the meeting has started`,
      `3. If join fails, inform the user and provide the Meet link for manual join`,
    ].join("\n");

    const req: OC003_Request = {
      id: "OC-003",
      cronName: opts.name,
      joinAtISO,
      eventSummary: opts.payload.summary,
      eventDescription,
    };

    const response = await this.bridge.sendTask(OC003_PROMPT(req));
    const { jobId } = parseOC003(response);
    return jobId;
  }

  async cancelJob(_jobId: string): Promise<void> {
    // OpenClaw cron jobs are one-shot — no cancel API needed
    // (they auto-clean after firing)
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
    const result = await this.bridge.sendTask(OC004_PROMPT(req));
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
    const result = await this.bridge.sendTask(OC005_PROMPT(req));
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
    return this.bridge.sendTask(OC006_PROMPT(req));
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
    return this.bridge.sendTask(OC010_PROMPT(req));
  }

  // ── Activity Feed ──

  onActivity(fn: (kind: string, summary: string, detail?: string) => void): void {
    this.bridge.onActivity(fn);
  }
}
