// CallingClaw 2.0 — ActionOrchestrator ("one hand, one ledger")
// ═══════════════════════════════════════════════════════════════════
// Single serialized executor for every screen/browser action, regardless
// of which actor requested it (Realtime tool call, TranscriptAuditor fast
// or medium lane, HTTP API, external agent).
//
// Why this exists (see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §3.1):
//   - Four independent actors previously executed actions with no shared
//     state — the same utterance could be acted on twice, two ComputerUse
//     loops could kill each other, and Playwright contention was unmanaged.
//   - The voice layer had no visibility into in-flight actions ("你在干嘛?"
//     was unanswerable) and no way to stop one (cancel() had zero call sites).
//
// Guarantees:
//   - ONE active task at a time; later submissions queue FIFO
//   - Duplicate instructions (any source, within COALESCE_WINDOW_MS) are
//     coalesced into the existing task's promise — structural dedup that
//     replaces fragile string-key ring buffers
//   - Every task carries an AbortController; abortActive() stops the hand
//   - task.started / task.progress / task.completed / task.failed /
//     task.cancelled events on the EventBus, plus SharedContext.activeTask
//     for Layer-3 visibility
// ═══════════════════════════════════════════════════════════════════

import type { EventBus } from "./event-bus";
import type { SharedContext } from "./shared-context";

export type TaskSource = "voice" | "auditor" | "http" | "agent";
export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ActionTask {
  id: string;
  source: TaskSource;
  instruction: string;
  state: TaskState;
  steps: Array<{ ts: number; desc: string }>;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  abort: AbortController;
}

/** Executor receives the task (for abort.signal + progress reporting via orchestrator.progress) */
export type TaskExecutor = (task: ActionTask) => Promise<string>;

interface QueueEntry {
  task: ActionTask;
  executor: TaskExecutor;
  promise: Promise<string>;
  resolve: (r: string) => void;
  reject: (e: any) => void;
}

const COALESCE_WINDOW_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 6_000;
const HEARTBEAT_MIN_RUNTIME_MS = 4_000;
const MAX_QUEUE = 5;
/**
 * Upper bound on a single executor await (`_runExecutor`'s `Promise.race`).
 * A stuck fetch / hung Playwright evaluate must never wedge `_active` forever —
 * that would fill MAX_QUEUE and kill the orchestrator for the rest of the
 * meeting. See docs/s1s2-conversation-architecture.md P0.3.
 */
const TASK_EXECUTOR_TIMEOUT_MS = 45_000;

/** Internal sentinel thrown when the timeout wins the race — never surfaced
 *  to callers, only used inside `_runExecutor` to distinguish a timeout from
 *  a genuine executor rejection. */
class TaskTimeoutError extends Error {
  constructor(taskId: string, timeoutMs: number) {
    super(`task ${taskId} exceeded ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
  }
}

export class ActionOrchestrator {
  private context: SharedContext;
  private eventBus: EventBus;
  private _queue: QueueEntry[] = [];
  private _active: QueueEntry | null = null;
  private _recentKeys: Array<{ key: string; ts: number; entry: QueueEntry }> = [];
  private _heartbeat: ReturnType<typeof setInterval> | null = null;
  private _idCounter = 0;
  private _taskTimeoutMs: number;

  /**
   * @param taskTimeoutMs Override for TASK_EXECUTOR_TIMEOUT_MS — production
   *   code should never pass this; it exists so tests can exercise the
   *   timeout path without waiting 45s.
   */
  constructor(context: SharedContext, eventBus: EventBus, taskTimeoutMs: number = TASK_EXECUTOR_TIMEOUT_MS) {
    this.context = context;
    this.eventBus = eventBus;
    this._taskTimeoutMs = taskTimeoutMs;
  }

  get activeTask(): ActionTask | null {
    return this._active?.task || null;
  }

  get queueLength(): number {
    return this._queue.length;
  }

  /**
   * Submit an action. Returns the task's result promise.
   * A duplicate instruction (normalized, any source) submitted while the
   * original is queued/running or completed < 10s ago returns the SAME
   * promise — the action runs once, both actors get the result.
   */
  submit(source: TaskSource, instruction: string, executor: TaskExecutor): Promise<string> {
    const key = this._normalize(instruction);

    // Coalesce with active/queued task
    const inFlight =
      (this._active && this._normalize(this._active.task.instruction) === key) ? this._active
      : this._queue.find((e) => this._normalize(e.task.instruction) === key);
    if (inFlight) {
      console.log(`[Orchestrator] Coalesced duplicate (${source}): "${instruction.slice(0, 50)}" → ${inFlight.task.id}`);
      this.eventBus.emit("task.coalesced", { taskId: inFlight.task.id, source, instruction: instruction.slice(0, 120) });
      return inFlight.promise;
    }

    // Coalesce with recently-completed task (the second actor usually fires
    // 1-3s after the first — re-running would double the action)
    const now = Date.now();
    this._recentKeys = this._recentKeys.filter((r) => now - r.ts < COALESCE_WINDOW_MS);
    const recent = this._recentKeys.find((r) => r.key === key);
    if (recent) {
      console.log(`[Orchestrator] Coalesced with recent (${source}): "${instruction.slice(0, 50)}" → ${recent.entry.task.id}`);
      this.eventBus.emit("task.coalesced", { taskId: recent.entry.task.id, source, instruction: instruction.slice(0, 120) });
      return recent.entry.promise;
    }

    if (this._queue.length >= MAX_QUEUE) {
      return Promise.resolve(
        `Action queue is full (${MAX_QUEUE} pending). "${instruction.slice(0, 60)}" was not started — finish or cancel the current task first.`
      );
    }

    const task: ActionTask = {
      id: `task_${Date.now().toString(36)}_${++this._idCounter}`,
      source,
      instruction,
      state: "queued",
      steps: [],
      createdAt: now,
      abort: new AbortController(),
    };

    let resolve!: (r: string) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const entry: QueueEntry = { task, executor, promise, resolve, reject };

    this._queue.push(entry);
    this._recentKeys.push({ key, ts: now, entry });
    console.log(`[Orchestrator] Queued ${task.id} (${source}): "${instruction.slice(0, 60)}" (queue: ${this._queue.length})`);
    this._drain();
    return promise;
  }

  /** Report a progress step for a running task (executors call this). */
  progress(taskId: string, desc: string) {
    const task = this._active?.task;
    if (!task || task.id !== taskId) return;
    task.steps.push({ ts: Date.now(), desc });
    this._syncContext();
  }

  /**
   * Abort the active task (and optionally flush the queue).
   * Used by voice interruption (stop-intent) and HTTP cancel.
   */
  abortActive(reason = "user request", flushQueue = true): boolean {
    if (flushQueue && this._queue.length > 0) {
      for (const e of this._queue) {
        e.task.state = "cancelled";
        e.resolve(`Cancelled before starting (${reason}).`);
      }
      this._queue = [];
    }
    const active = this._active;
    if (!active) return false;
    console.log(`[Orchestrator] Aborting ${active.task.id}: ${reason}`);
    active.task.abort.abort(new Error(reason));
    // The executor decides how fast it can stop; state transition happens
    // in _drain's completion handling (cancelled beats failed).
    return true;
  }

  // ── Internals ──

  private _normalize(instruction: string): string {
    return instruction.toLowerCase().replace(/[\s，。、,.!?？！]+/g, " ").trim().slice(0, 120);
  }

  private _drain() {
    if (this._active || this._queue.length === 0) return;
    const entry = this._queue.shift()!;
    this._active = entry;
    const { task } = entry;
    task.state = "running";
    task.startedAt = Date.now();
    this._syncContext();
    this.eventBus.emit("task.started", {
      taskId: task.id,
      source: task.source,
      instruction: task.instruction.slice(0, 200),
    });
    this._startHeartbeat();

    this._runExecutor(entry);
  }

  /**
   * Runs the executor bounded by TASK_EXECUTOR_TIMEOUT_MS via Promise.race so
   * a stuck executor can never wedge the queue: if it hasn't settled in time,
   * we abort its signal, settle the caller's promise with a timeout result,
   * and let _finish() clear `_active` so draining continues with the next
   * queued task. `finally` clears the timer on every path (including the
   * happy path) so a stray timer never holds the process/tests open.
   */
  private async _runExecutor(entry: QueueEntry) {
    const { task } = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TaskTimeoutError(task.id, this._taskTimeoutMs)), this._taskTimeoutMs);
      });
      const result = await Promise.race([entry.executor(task), timeout]);
      task.result = result;
      task.state = task.abort.signal.aborted ? "cancelled" : "done";
      this._finish(entry, result);
    } catch (e: any) {
      if (e instanceof TaskTimeoutError) {
        console.warn(
          `[Orchestrator] ${task.id} (${task.source}) timed out after ${this._taskTimeoutMs}ms: "${task.instruction.slice(0, 60)}" — aborting executor, freeing queue`
        );
        task.abort.abort(new Error("executor timeout"));
        task.state = "failed";
        task.result = `Action timed out after ${Math.round(this._taskTimeoutMs / 1000)}s and was abandoned so the queue could continue.`;
        this._finish(entry, task.result);
        return;
      }
      const aborted = task.abort.signal.aborted;
      task.state = aborted ? "cancelled" : "failed";
      task.result = aborted ? `Cancelled: ${e?.message || "aborted"}` : `Error: ${e?.message || String(e)}`;
      this._finish(entry, task.result);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private _finish(entry: QueueEntry, result: string) {
    const { task } = entry;
    task.endedAt = Date.now();
    this._active = null;
    this._stopHeartbeat();
    this._syncContext();

    const eventName = task.state === "done" ? "task.completed"
      : task.state === "cancelled" ? "task.cancelled"
      : "task.failed";
    this.eventBus.emit(eventName, {
      taskId: task.id,
      source: task.source,
      instruction: task.instruction.slice(0, 200),
      result: result.slice(0, 500),
      durationMs: task.endedAt - (task.startedAt || task.createdAt),
      steps: task.steps.length,
    });
    console.log(`[Orchestrator] ${task.id} ${task.state} in ${task.endedAt - (task.startedAt || task.createdAt)}ms`);

    entry.resolve(result);
    this._drain();
  }

  /** Mirror the active task into SharedContext for Layer-3 visibility */
  private _syncContext() {
    const task = this._active?.task || null;
    this.context.setActiveTask(
      task
        ? {
            id: task.id,
            source: task.source,
            instruction: task.instruction.slice(0, 160),
            startedAt: task.startedAt || task.createdAt,
            lastStep: task.steps.length > 0 ? task.steps[task.steps.length - 1]!.desc.slice(0, 120) : undefined,
          }
        : null
    );
  }

  private _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      const task = this._active?.task;
      if (!task || !task.startedAt) return;
      const runtime = Date.now() - task.startedAt;
      if (runtime < HEARTBEAT_MIN_RUNTIME_MS) return;
      this.eventBus.emit("task.progress", {
        taskId: task.id,
        source: task.source,
        instruction: task.instruction.slice(0, 120),
        runtimeMs: runtime,
        step: task.steps.length > 0 ? task.steps[task.steps.length - 1]!.desc.slice(0, 160) : "working…",
        steps: task.steps.length,
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }
}
