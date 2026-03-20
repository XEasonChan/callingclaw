// CallingClaw 2.0 — Module: PostMeetingDelivery
// Sends concise todo list to user via OpenClaw → Telegram after meeting ends.
// User confirms via inline buttons → triggers deep research + sub-agent execution.
//
// Flow:
//   1. Meeting ends → generateSummary() produces actionItems[]
//   2. Compress each actionItem to ≤20 chars → send as Telegram message with inline buttons
//   3. User clicks ✅ → OpenClaw receives callback → triggers execution pipeline:
//      a. Load full meeting notes (markdown file)
//      b. Deep research each confirmed todo: background, acceptance criteria, direction, target
//      c. Cross-reference with MEMORY.md + workspace file structure
//      d. Spawn sub-agent per todo for execution
//
// Design:
//   - Uses OpenClawBridge.sendTask() to tell OpenClaw what to send and how to handle callbacks
//   - Keeps full meeting context (transcript, decisions, requirements) for enriched execution
//   - Each todo gets a unique ID for tracking

import type { OpenClawBridge } from "../openclaw_bridge";
import type { EventBus } from "./event-bus";
import type { MeetingSummary } from "./meeting";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import {
  OC004_PROMPT, parseOC004, type OC004_Request,
  OC005_PROMPT, type OC005_Request,
  OC006_PROMPT, type OC006_Request,
} from "../openclaw-protocol";

interface TodoItem {
  id: string;
  shortText: string;      // ≤20 chars for Telegram display
  fullText: string;        // original full action item
  assignee?: string;
  deadline?: string;
  confirmed: boolean;
  executionStarted: boolean;
}

interface MeetingDelivery {
  meetingId: string;
  topic: string;
  notesFilePath: string;
  todos: TodoItem[];
  fullSummary: MeetingSummary;
  deliveredAt: number;
  liveNotes: string[];
  requirements: string[];
  completedTasks: string[];
}

export class PostMeetingDelivery {
  private openclawBridge: OpenClawBridge;
  private eventBus: EventBus;
  private deliveries = new Map<string, MeetingDelivery>();

  constructor(opts: {
    openclawBridge: OpenClawBridge;
    eventBus: EventBus;
  }) {
    this.openclawBridge = opts.openclawBridge;
    this.eventBus = opts.eventBus;
  }

  /**
   * Deliver post-meeting todos to user via OpenClaw → Telegram.
   * Called after meeting.leave completes summary generation.
   */
  async deliver(opts: {
    summary: MeetingSummary;
    notesFilePath: string;
    prepSummary?: {
      topic: string;
      liveNotes: string[];
      completedTasks: string[];
      requirements: string[];
    } | null;
  }): Promise<MeetingDelivery | null> {
    if (!this.openclawBridge.connected) {
      console.warn("[PostMeeting] OpenClaw not connected — cannot deliver todos");
      return null;
    }

    const { summary, notesFilePath, prepSummary } = opts;
    const meetingId = `mtg_${Date.now()}`;
    const topic = prepSummary?.topic || summary.title || "Meeting";

    // Build todo list from action items
    const todos: TodoItem[] = (summary.actionItems || []).map((item, i) => ({
      id: `${meetingId}_todo_${i}`,
      shortText: this.compressToShort(item.task),
      fullText: item.task,
      assignee: item.assignee,
      deadline: item.deadline,
      confirmed: false,
      executionStarted: false,
    }));

    // Also add follow-ups as todos
    (summary.followUps || []).forEach((f, i) => {
      todos.push({
        id: `${meetingId}_follow_${i}`,
        shortText: this.compressToShort(f),
        fullText: f,
        confirmed: false,
        executionStarted: false,
      });
    });

    if (todos.length === 0) {
      console.log("[PostMeeting] No action items — skipping delivery");
      // Still send a brief summary
      await this.sendSummaryOnly(topic, summary);
      return null;
    }

    const delivery: MeetingDelivery = {
      meetingId,
      topic,
      notesFilePath,
      todos,
      fullSummary: summary,
      deliveredAt: Date.now(),
      liveNotes: prepSummary?.liveNotes || [],
      requirements: prepSummary?.requirements || [],
      completedTasks: prepSummary?.completedTasks || [],
    };

    this.deliveries.set(meetingId, delivery);

    // Trim old deliveries to prevent unbounded Map growth (keep last 10)
    if (this.deliveries.size > 10) {
      const keys = Array.from(this.deliveries.keys());
      for (let i = 0; i < keys.length - 10; i++) {
        this.deliveries.delete(keys[i]!);
      }
    }

    // Send to OpenClaw with instructions to deliver via Telegram with inline buttons
    await this.sendTodoMessage(delivery);

    this.eventBus.emit("postmeeting.delivered", {
      meetingId,
      topic,
      todoCount: todos.length,
    });

    return delivery;
  }

  /**
   * Compress an action item to ≤20 characters for Telegram display.
   * Keeps the core verb + object, drops fluff.
   */
  private compressToShort(text: string): string {
    // Remove common prefixes
    let short = text
      .replace(/^(需要|请|应该|要|Must|Should|Need to|Please)\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    // If still too long, take first meaningful segment
    if (short.length > 20) {
      // Try to cut at a natural break
      const breaks = [
        short.indexOf("，"),
        short.indexOf(","),
        short.indexOf("："),
        short.indexOf(":"),
        short.indexOf("（"),
        short.indexOf("("),
        short.indexOf(" — "),
      ].filter(i => i > 0 && i <= 20);

      if (breaks.length > 0) {
        short = short.slice(0, Math.max(...breaks));
      } else {
        // Hard truncate + ellipsis
        short = short.slice(0, 18) + "…";
      }
    }

    return short;
  }

  /**
   * Send todo list to user via OpenClaw message tool with inline buttons (OC-004).
   */
  private async sendTodoMessage(delivery: MeetingDelivery): Promise<void> {
    const { meetingId, topic, todos } = delivery;

    const req: OC004_Request = {
      id: "OC-004",
      topic,
      meetingId,
      todos: todos.map((t) => ({
        id: t.id,
        text: t.shortText,
        fullText: t.fullText,
        assignee: t.assignee,
        deadline: t.deadline,
      })),
    };

    try {
      await this.openclawBridge.sendTask(OC004_PROMPT(req));
      console.log(`[PostMeeting] Todo message sent to user (${todos.length} items)`);

      this.eventBus.emit("postmeeting.todos_sent", {
        meetingId,
        topic,
        todos: todos.map(t => ({ id: t.id, text: t.shortText, assignee: t.assignee })),
      });
    } catch (e: any) {
      console.error("[PostMeeting] Failed to send todo message:", e.message);
    }
  }

  /**
   * Send summary-only message when there are no action items (OC-005).
   */
  private async sendSummaryOnly(topic: string, summary: MeetingSummary): Promise<void> {
    const req: OC005_Request = {
      id: "OC-005",
      topic,
      keyPoints: (summary.keyPoints || []).slice(0, 5),
      decisions: summary.decisions || [],
    };

    try {
      await this.openclawBridge.sendTask(OC005_PROMPT(req));
    } catch (e: any) {
      console.error("[PostMeeting] Failed to send summary:", e.message);
    }
  }

  /**
   * Handle user confirmation callback from Telegram inline buttons.
   * Called when OpenClaw receives a callback_data starting with "cc_confirm:" or "cc_skip:".
   *
   * This is the entry point for the execution pipeline.
   */
  async handleCallback(callbackData: string): Promise<string> {
    const parts = callbackData.split(":");

    if (parts[0] === "cc_confirm_all") {
      const meetingId = parts[1];
      return this.confirmAll(meetingId);
    }

    if (parts[0] === "cc_confirm") {
      const meetingId = parts[1];
      const todoId = parts[2];
      return this.confirmTodo(meetingId, todoId);
    }

    if (parts[0] === "cc_skip") {
      const meetingId = parts[1];
      const todoId = parts[2];
      return this.skipTodo(meetingId, todoId);
    }

    return `Unknown callback: ${callbackData}`;
  }

  /**
   * Confirm a single todo and trigger execution.
   */
  private async confirmTodo(meetingId: string, todoId: string): Promise<string> {
    const delivery = this.deliveries.get(meetingId);
    if (!delivery) return `Meeting ${meetingId} not found`;

    const todo = delivery.todos.find(t => t.id === todoId);
    if (!todo) return `Todo ${todoId} not found`;

    todo.confirmed = true;

    this.eventBus.emit("postmeeting.todo_confirmed", {
      meetingId,
      todoId: todo.id,
      task: todo.fullText,
      assignee: todo.assignee,
    });

    await this.executeTodo(delivery, todo);
    return `✅ 确认: ${todo.shortText}`;
  }

  /**
   * Skip a todo.
   */
  private skipTodo(meetingId: string, todoId: string): string {
    const delivery = this.deliveries.get(meetingId);
    if (!delivery) return `Meeting ${meetingId} not found`;

    const todo = delivery.todos.find(t => t.id === todoId);
    if (!todo) return `Todo ${todoId} not found`;

    // Just mark it as not confirmed — don't execute
    console.log(`[PostMeeting] Skipped: ${todo.shortText}`);
    return `❌ 跳过: ${todo.shortText}`;
  }

  /**
   * Confirm all todos and trigger batch execution.
   */
  private async confirmAll(meetingId: string): Promise<string> {
    const delivery = this.deliveries.get(meetingId);
    if (!delivery) return `Meeting ${meetingId} not found`;

    const unconfirmed = delivery.todos.filter(t => !t.confirmed && !t.executionStarted);
    for (const todo of unconfirmed) {
      todo.confirmed = true;
      this.eventBus.emit("postmeeting.todo_confirmed", {
        meetingId,
        todoId: todo.id,
        task: todo.fullText,
        assignee: todo.assignee,
      });
    }

    // Execute all confirmed todos
    for (const todo of unconfirmed) {
      await this.executeTodo(delivery, todo);
    }

    return `✅ 全部确认，${unconfirmed.length} 个任务开始执行`;
  }

  /**
   * Execute a confirmed todo by handing off raw meeting data to OpenClaw.
   * CallingClaw does NOT do AI research/analysis — it just delivers the raw material.
   * OpenClaw combines it with its own memory, file structure, and intelligence
   * to spawn sub-agents for deep research + execution.
   */
  private async executeTodo(delivery: MeetingDelivery, todo: TodoItem): Promise<void> {
    if (todo.executionStarted) return;
    todo.executionStarted = true;

    console.log(`[PostMeeting] Handing off todo to OpenClaw: ${todo.fullText}`);
    this.eventBus.emit("postmeeting.todo_executing", {
      meetingId: delivery.meetingId,
      todoId: todo.id,
      task: todo.fullText,
    });

    try {
      // Hand off via OC-006 protocol
      const req: OC006_Request = {
        id: "OC-006",
        todo: {
          fullText: todo.fullText,
          assignee: todo.assignee,
          deadline: todo.deadline,
        },
        meeting: {
          topic: delivery.topic,
          time: new Date(delivery.deliveredAt).toISOString(),
          notesFilePath: delivery.notesFilePath,
          decisions: delivery.fullSummary.decisions || [],
          requirements: delivery.requirements,
          liveNotes: delivery.liveNotes,
        },
      };
      await this.openclawBridge.sendTask(OC006_PROMPT(req));
      console.log(`[PostMeeting] Handed off to OpenClaw: ${todo.shortText}`);
    } catch (e: any) {
      console.error(`[PostMeeting] Handoff failed for "${todo.shortText}":`, e.message);
      this.eventBus.emit("postmeeting.todo_failed", {
        meetingId: delivery.meetingId,
        todoId: todo.id,
        error: e.message,
      });
    }
  }

  // buildHandoff removed — now uses OC006_PROMPT from openclaw-protocol.ts

  /**
   * Get delivery status for API
   */
  getStatus() {
    return {
      deliveries: this.deliveries.size,
      active: [...this.deliveries.values()].map(d => ({
        meetingId: d.meetingId,
        topic: d.topic,
        todoCount: d.todos.length,
        confirmed: d.todos.filter(t => t.confirmed).length,
        executing: d.todos.filter(t => t.executionStarted).length,
        deliveredAt: new Date(d.deliveredAt).toISOString(),
      })),
    };
  }
}
