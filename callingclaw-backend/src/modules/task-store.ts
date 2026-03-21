// CallingClaw 2.0 — Module: Task Store
// Structured task management with persistence.
// Tasks come from meeting action items and can be consumed by agents (OpenClaw).
// Persists to a JSON file so tasks survive restarts.

import type { EventBus } from "./event-bus";

export interface Task {
  id: string;
  task: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
  priority: "high" | "medium" | "low";
  assignee?: string;
  deadline?: string;
  context?: string;        // transcript snippet or discussion context
  sourceMeetingId?: string; // correlation ID of the meeting that created this
  result?: string;          // agent reports back what it did
  createdAt: number;
  updatedAt: number;
}

const DATA_DIR = `${import.meta.dir}/../../data`;
const TASKS_FILE = `${DATA_DIR}/tasks.json`;

export class TaskStore {
  private _tasks = new Map<string, Task>();
  private _eventBus: EventBus | null = null;

  constructor(eventBus?: EventBus) {
    this._eventBus = eventBus || null;
  }

  /** Load tasks from disk */
  async load() {
    try {
      const file = Bun.file(TASKS_FILE);
      if (await file.exists()) {
        const data = await file.json() as Task[];
        for (const task of data) {
          this._tasks.set(task.id, task);
        }
        console.log(`[TaskStore] Loaded ${data.length} tasks from disk`);
      }
    } catch {
      console.log("[TaskStore] No existing tasks file, starting fresh");
    }
  }

  /** Persist tasks to disk */
  private async _save() {
    try {
      await Bun.$`mkdir -p ${DATA_DIR}`;
      const data = [...this._tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
      await Bun.write(TASKS_FILE, JSON.stringify(data, null, 2));
    } catch (e: any) {
      console.error("[TaskStore] Save failed:", e.message);
    }
  }

  /** Create a new task */
  create(input: {
    task: string;
    priority?: Task["priority"];
    assignee?: string;
    deadline?: string;
    context?: string;
    sourceMeetingId?: string;
  }): Task {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();

    const task: Task = {
      id,
      task: input.task,
      status: "pending",
      priority: input.priority || "medium",
      assignee: input.assignee,
      deadline: input.deadline,
      context: input.context,
      sourceMeetingId: input.sourceMeetingId || this._eventBus?.correlationId || undefined,
      createdAt: now,
      updatedAt: now,
    };

    this._tasks.set(id, task);
    this._save();

    this._eventBus?.emit("task.created", { task });
    console.log(`[TaskStore] Created: ${id} — ${input.task}`);

    return task;
  }

  /** Create tasks from meeting action items (batch) */
  createFromMeetingItems(items: Array<{
    task: string;
    assignee?: string;
    deadline?: string;
    priority?: Task["priority"];
  }>, meetingId?: string): Task[] {
    return items.map((item) =>
      this.create({
        ...item,
        sourceMeetingId: meetingId || this._eventBus?.correlationId || undefined,
      })
    );
  }

  /** Update a task */
  update(id: string, updates: Partial<Pick<Task, "status" | "assignee" | "deadline" | "priority" | "result">>): Task | null {
    const task = this._tasks.get(id);
    if (!task) return null;

    Object.assign(task, updates, { updatedAt: Date.now() });
    this._save();

    this._eventBus?.emit("task.updated", { task });
    console.log(`[TaskStore] Updated: ${id} → ${task.status}`);

    return task;
  }

  /** Get a single task */
  get(id: string): Task | null {
    return this._tasks.get(id) || null;
  }

  /** List tasks with filters */
  list(filters?: {
    status?: Task["status"];
    meetingId?: string;
    assignee?: string;
    priority?: Task["priority"];
  }): Task[] {
    let tasks = [...this._tasks.values()];

    if (filters?.status) {
      tasks = tasks.filter((t) => t.status === filters.status);
    }
    if (filters?.meetingId) {
      tasks = tasks.filter((t) => t.sourceMeetingId === filters.meetingId);
    }
    if (filters?.assignee) {
      tasks = tasks.filter((t) => t.assignee === filters.assignee);
    }
    if (filters?.priority) {
      tasks = tasks.filter((t) => t.priority === filters.priority);
    }

    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get pending tasks (for agent consumption) */
  getPending(): Task[] {
    return this.list({ status: "pending" });
  }

  /** Delete a task */
  delete(id: string): boolean {
    const deleted = this._tasks.delete(id);
    if (deleted) this._save();
    return deleted;
  }

  /** Get summary stats */
  stats() {
    const all = [...this._tasks.values()];
    return {
      total: all.length,
      pending: all.filter((t) => t.status === "pending").length,
      in_progress: all.filter((t) => t.status === "in_progress").length,
      done: all.filter((t) => t.status === "done").length,
      cancelled: all.filter((t) => t.status === "cancelled").length,
    };
  }
}
