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
//
// Warm workers (per-meeting latency optimization):
//   Every cold `claude -p` call pays ~1-3s of CLI boot (config + MCP
//   discovery + auth). During a meeting that fixed cost dominates recall
//   latency. On meeting.started the adapter spawns two long-lived
//   `claude -p --input-format stream-json --output-format stream-json`
//   processes (haiku for recallContext, sonnet for executeTask — the CLI
//   pins --model per process, so per-tier model switching = per-tier worker).
//   Each request is one JSON user-message line on stdin; the turn completes
//   when a {"type":"result"} event arrives on stdout. On meeting.ended the
//   workers are killed — one meeting's worker never serves another (this
//   replaces the per-call context isolation that --no-session-persistence
//   gave the cold path). meeting.started can also fire again WITHOUT an
//   intervening meeting.ended (acknowledged re-join path in callingclaw.ts),
//   so warmUp() recycles any existing workers before spawning fresh ones —
//   conversation context accumulated for meeting A never serves meeting B.
//   A warm attempt and its cold fallback share ONE request deadline (warm
//   gets min(15s, half the budget), cold gets the remainder of it), so a
//   warm timeout can never stack a second full timeout on top. The cold path
//   remains untouched as the default and the fallback for every warm failure
//   (timeout, crash, busy, error result, malformed stream). Kill-switch:
//   CLAUDE_WARM_WORKER=0.

import { mkdirSync } from "node:fs";
import { recordUsage } from "../modules/cost-meter";
import type { AgentAdapter } from "../agent-adapter";
import { InternalJobScheduler, type ScheduledJob } from "../agent-adapter";
import {
  OC001_PROMPT, type OC001_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";

const WORKSPACE_DIR = `${process.env.HOME}/.callingclaw/shared`;

// ── Warm Worker (persistent streaming claude CLI process) ──

/** All live warm workers — killed on process exit so no orphan CLI processes. */
const LIVE_WARM_WORKERS = new Set<WarmClaudeWorker>();
let _exitHookInstalled = false;
function installExitHook(): void {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  process.on("exit", () => {
    for (const w of LIVE_WARM_WORKERS) {
      try { w.kill(); } catch {}
    }
  });
}

/**
 * One long-lived `claude -p` process in stream-json mode.
 *
 * Protocol: write one JSON line per user turn on stdin
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
 * then read newline-delimited JSON events on stdout until the turn's
 * {"type":"result"} event (other event types — system/assistant/
 * rate_limit_event/etc — are skipped; non-JSON lines are ignored).
 *
 * Serialization: exactly ONE request in flight per worker. An overlapping
 * request is rejected immediately (caller falls back to the cold path) —
 * queueing behind a slow in-meeting call would give unbounded latency,
 * while the cold path is a known bounded cost.
 *
 * Failure policy: on per-request timeout, process death, an error result
 * ({"is_error":true} or an error_* subtype), or a result-less stream, the
 * worker is killed and the pending request rejects — the caller falls back
 * to cold. Conversation context accumulates across turns within
 * the worker (i.e. within one meeting); to bound context growth the worker
 * self-recycles after `recycleAfter` turns (owner respawns a fresh one).
 */
export class WarmClaudeWorker {
  readonly model: string;
  /** true when kill() was a planned recycle (not a failure) */
  recycled = false;

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private pending: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _alive = true;
  private _exitHandled = false;
  private _turnsServed = 0;
  private stderrTail = "";
  private recycleAfter: number;
  private onExit?: () => void;

  constructor(opts: {
    bin: string;
    model: string;
    maxTurns: number;
    cwd: string;
    recycleAfter?: number;
    onExit?: () => void;
  }) {
    this.model = opts.model;
    this.recycleAfter = opts.recycleAfter
      ?? Math.max(1, Number(process.env.CLAUDE_WARM_WORKER_RECYCLE) || 25);
    this.onExit = opts.onExit;
    this.proc = Bun.spawn([
      opts.bin, "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--disable-slash-commands",
      "--model", opts.model,
      "--permission-mode", "bypassPermissions",
      "--max-turns", String(opts.maxTurns),
      "--no-session-persistence",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
    });
    LIVE_WARM_WORKERS.add(this);
    installExitHook();
    this.pumpStdout();
    this.pumpStderr();
    this.proc.exited.then(() => this.handleExit()).catch(() => this.handleExit());
  }

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this.pending !== null; }
  get turnsServed(): number { return this._turnsServed; }

  /** Send one user turn; resolves with the result text or rejects (caller goes cold). */
  run(prompt: string, timeoutMs: number): Promise<string> {
    if (!this._alive) return Promise.reject(new Error("warm worker not alive"));
    if (this.pending) return Promise.reject(new Error("warm worker busy"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending;
        this.pending = null;
        this.kill(); // timed-out worker state is unknown — discard it
        p?.reject(new Error(`warm claude timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.proc.stdin.write(JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        }) + "\n");
        this.proc.stdin.flush();
      } catch (e: any) {
        this.pending = null;
        clearTimeout(timer);
        this.kill();
        reject(new Error(`warm worker stdin write failed: ${e.message}`));
      }
    });
  }

  kill(): void {
    this._alive = false;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill(); } catch {}
  }

  private settle(ev: any): void {
    const p = this.pending;
    if (!p) return; // stray result (e.g. after timeout) — nothing waiting
    this.pending = null;
    clearTimeout(p.timer);
    this._turnsServed++;
    // An error result is NOT an answer. The turn failed and the worker's
    // conversation state is suspect — discard it (owner's unexpected-death
    // respawn policy applies) and reject so this request falls back to cold.
    const isError = ev.is_error === true
      || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"));
    if (isError) {
      this.kill();
      p.reject(new Error(`warm worker returned error result (subtype=${ev.subtype ?? "?"}, is_error=${ev.is_error === true})`));
      return;
    }
    // CostMeter: warm-worker result events carry the same usage + total_cost_usd
    // as the cold JSON path — record the exact cost (fail-soft).
    recordUsage({
      component: "agent",
      model: this.model,
      inputTokens: ev?.usage?.input_tokens,
      outputTokens: ev?.usage?.output_tokens,
      cacheReadTokens: ev?.usage?.cache_read_input_tokens,
      cacheCreationTokens: ev?.usage?.cache_creation_input_tokens,
      costUsd: typeof ev?.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      meta: { adapter: "claude-code", path: "warm" },
    });
    const text = typeof ev.result === "string" ? ev.result : "";
    if (text) p.resolve(text);
    else p.reject(new Error(`warm worker returned empty result (subtype=${ev.subtype ?? "?"})`));
    if (this._turnsServed >= this.recycleAfter && this._alive) {
      this.recycled = true; // planned recycle — owner respawns fresh
      this.kill();
    }
  }

  private handleExit(): void {
    if (this._exitHandled) return;
    this._exitHandled = true;
    this._alive = false;
    LIVE_WARM_WORKERS.delete(this);
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(`warm claude worker exited (stderr: ${this.stderrTail.slice(-300) || "empty"})`));
    }
    try { this.onExit?.(); } catch {}
  }

  private async pumpStdout(): Promise<void> {
    try {
      const reader = this.proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; } // skip non-JSON noise
          if (ev?.type === "result") this.settle(ev);
        }
      }
    } catch { /* stream torn down — proc.exited → handleExit cleans up */ }
  }

  private async pumpStderr(): Promise<void> {
    // Drain stderr (avoids pipe backpressure) keeping a short tail for diagnostics.
    try {
      const reader = this.proc.stderr.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrTail = (this.stderrTail + dec.decode(value, { stream: true })).slice(-2048);
      }
    } catch { /* ignore */ }
  }
}

type WarmRole = "recall" | "task";
const WARM_ROLE_CONFIG: Record<WarmRole, { model: string; maxTurns: number }> = {
  recall: { model: "haiku", maxTurns: 3 },   // mirrors cold recallContext
  task: { model: "sonnet", maxTurns: 10 },   // mirrors cold executeTask
};
/** Unexpected worker deaths tolerated per meeting before staying cold. */
const MAX_WARM_RESPAWNS = 5;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code" as const;
  private _connected = false;
  private scheduler: InternalJobScheduler;
  private _onActivity: ((kind: string, summary: string, detail?: string) => void) | null = null;

  // Warm worker state (per-meeting; see file header)
  private _warm = false;
  private _warmGen = 0;
  private _warmWorkers = new Map<WarmRole, WarmClaudeWorker>();
  private _warmRespawns = 0;
  /** Serializes warmUp/cooldown transitions so lifecycle calls never interleave. */
  private _lifecycle: Promise<void> = Promise.resolve();
  private _streamCapability: Promise<{ supported: boolean; definitive: boolean }> | null = null;
  private _loggedWarmOff = false;

  // Shared per-request deadlines: ONE budget covers the warm attempt AND its
  // cold fallback (prevents warm→cold timeout stacking). Public for tests.
  recallBudgetMs = 30_000;
  taskBudgetMs = 60_000;

  constructor(onJobFire?: (job: ScheduledJob) => void) {
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this._connected; }

  /** CLI binary — same discovery for cold and warm paths (CLAUDE_BIN override for tests). */
  private get bin(): string {
    return process.env.CLAUDE_BIN || "claude";
  }

  async connect(): Promise<void> {
    // Verify claude CLI is available
    try {
      const proc = Bun.spawn([this.bin, "--version"], { stdout: "pipe", stderr: "pipe" });
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
    void this.cooldown();
    this.scheduler.stop();
    this._connected = false;
  }

  // ── Warm Lifecycle (meeting.started → warmUp, meeting.ended → cooldown) ──

  /**
   * Spawn per-meeting warm workers. Runs on the meeting-join path, where the
   * 1-3s CLI boot is invisible. If workers already exist (meeting.started can
   * fire again WITHOUT an intervening meeting.ended — an acknowledged path in
   * callingclaw.ts), they are RECYCLED first (cooldown, then fresh spawn) so
   * the previous meeting's in-process conversation can never serve the new
   * one. warmUp/cooldown are serialized on a lifecycle chain, so concurrent
   * calls cannot interleave; requests in flight on a recycled worker reject
   * and fall back to cold, and the generation counter invalidates their
   * stale onExit respawns. Silently no-ops when disabled/unsupported.
   */
  async warmUp(): Promise<void> {
    const run = this._lifecycle.then(() => this._warmUpLocked());
    this._lifecycle = run.catch(() => {}); // a failed transition must not poison the chain
    return run;
  }

  private async _warmUpLocked(): Promise<void> {
    // Recycle any existing workers first — cross-meeting context isolation
    // must not depend on meeting.ended having fired between two starts.
    this._cooldownLocked();
    if (this.warmDisabled()) {
      if (!this._loggedWarmOff) {
        this._loggedWarmOff = true;
        console.log("[ClaudeCodeAdapter] Warm workers disabled via CLAUDE_WARM_WORKER=0 — cold path only");
      }
      return;
    }
    const supported = await this.streamingSupported();
    if (!supported) {
      if (!this._loggedWarmOff) {
        this._loggedWarmOff = true;
        console.log("[ClaudeCodeAdapter] claude CLI lacks stream-json support — warm workers disabled (cold path only)");
      }
      return;
    }
    try { mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}
    this._warmGen++;
    this._warm = true;
    this._warmRespawns = 0;
    const gen = this._warmGen;
    this.spawnWarmWorker("recall", gen);
    this.spawnWarmWorker("task", gen);
    console.log("[ClaudeCodeAdapter] Warm workers up (recall=haiku, task=sonnet)");
  }

  /** Kill per-meeting warm workers — one meeting's worker never serves another. */
  async cooldown(): Promise<void> {
    const run = this._lifecycle.then(() => { this._cooldownLocked(); });
    this._lifecycle = run.catch(() => {});
    return run;
  }

  private _cooldownLocked(): void {
    if (!this._warm && this._warmWorkers.size === 0) return;
    this._warm = false;
    this._warmGen++; // invalidates in-flight onExit respawns
    for (const w of this._warmWorkers.values()) {
      try { w.kill(); } catch {}
    }
    this._warmWorkers.clear();
    console.log("[ClaudeCodeAdapter] Warm workers cooled down");
  }

  /** Observability + test hook. `gen` increments on every warm lifecycle transition (recycle proof). */
  warmStats(): {
    warm: boolean;
    gen: number;
    workers: Partial<Record<WarmRole, { alive: boolean; busy: boolean; turnsServed: number; model: string }>>;
  } {
    const workers: any = {};
    for (const [role, w] of this._warmWorkers) {
      workers[role] = { alive: w.alive, busy: w.busy, turnsServed: w.turnsServed, model: w.model };
    }
    return { warm: this._warm, gen: this._warmGen, workers };
  }

  private warmDisabled(): boolean {
    const v = (process.env.CLAUDE_WARM_WORKER || "").trim().toLowerCase();
    return v === "0" || v === "false" || v === "off";
  }

  /**
   * Capability check: does this CLI support stream-json in/out?
   * Only DEFINITIVE answers are cached (help text actually produced): a
   * transient probe failure — spawn error, timeout, nonzero exit, empty
   * output — is not cached, so the next warmUp re-probes instead of leaving
   * warm permanently disabled for the process lifetime by one flaky probe.
   */
  private async streamingSupported(): Promise<boolean> {
    if (!this._streamCapability) {
      const probe = this.probeStreamJson();
      this._streamCapability = probe;
      probe.then((r) => {
        if (!r.definitive && this._streamCapability === probe) this._streamCapability = null;
      }).catch(() => {
        if (this._streamCapability === probe) this._streamCapability = null;
      });
    }
    return (await this._streamCapability).supported;
  }

  private async probeStreamJson(): Promise<{ supported: boolean; definitive: boolean }> {
    try {
      const proc = Bun.spawn([this.bin, "--help"], { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const killTimer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, 10000);
      const out = await new Response(proc.stdout).text();
      clearTimeout(killTimer);
      const exitCode = await proc.exited;
      if (out.includes("--input-format") && out.includes("--output-format") && out.includes("stream-json")) {
        return { supported: true, definitive: true };
      }
      // A negative is definitive only when the CLI really printed its help.
      const definitive = !timedOut && exitCode === 0 && out.trim().length > 0;
      return { supported: false, definitive };
    } catch {
      return { supported: false, definitive: false }; // spawn failure — transient
    }
  }

  private spawnWarmWorker(role: WarmRole, gen: number): void {
    const cfg = WARM_ROLE_CONFIG[role];
    try {
      const worker = new WarmClaudeWorker({
        bin: this.bin,
        model: cfg.model,
        maxTurns: cfg.maxTurns,
        cwd: WORKSPACE_DIR,
        onExit: () => {
          // Respawn only if still the current meeting's warm generation.
          if (!this._warm || gen !== this._warmGen) return;
          if (this._warmWorkers.get(role) !== worker) return;
          this._warmWorkers.delete(role);
          if (worker.recycled) {
            this.spawnWarmWorker(role, gen); // planned recycle — free respawn
            return;
          }
          if (this._warmRespawns >= MAX_WARM_RESPAWNS) {
            console.warn(`[ClaudeCodeAdapter] Warm ${role} worker died ${MAX_WARM_RESPAWNS}+ times — staying cold for this meeting`);
            return;
          }
          this._warmRespawns++;
          console.warn(`[ClaudeCodeAdapter] Warm ${role} worker died — respawning (${this._warmRespawns}/${MAX_WARM_RESPAWNS})`);
          this.spawnWarmWorker(role, gen);
        },
      });
      this._warmWorkers.set(role, worker);
    } catch (e: any) {
      console.warn(`[ClaudeCodeAdapter] Failed to spawn warm ${role} worker: ${e.message}`);
    }
  }

  /** Warm attempt's slice of a shared request deadline (the cold fallback keeps the rest). */
  private warmShare(budgetMs: number): number {
    return Math.min(15_000, Math.floor(budgetMs / 2));
  }

  /**
   * Try the warm worker for this role. Returns the result text, or null when
   * the request should use the cold path (not warm, worker busy/dead, timeout,
   * crash, error result, malformed stream). Never throws.
   */
  private async tryWarm(role: WarmRole, prompt: string, timeoutMs: number): Promise<string | null> {
    if (!this._warm) return null;
    const worker = this._warmWorkers.get(role);
    if (!worker || !worker.alive || worker.busy) return null;
    try {
      return await worker.run(prompt, timeoutMs);
    } catch (e: any) {
      console.warn(`[ClaudeCodeAdapter] Warm ${role} failed → cold fallback: ${e.message}`);
      return null;
    }
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

    // Warm path (per-meeting persistent CLI) — any failure falls back to cold.
    // Warm + cold share ONE deadline: the warm attempt gets at most
    // min(15s, budget/2) and the cold fallback gets whatever remains of the
    // original budget (no timeout stacking). With warm inactive the cold
    // path keeps the full budget, exactly as before.
    let timeout = this.recallBudgetMs;
    if (this._warm) {
      const startedAt = Date.now();
      const warm = await this.tryWarm("recall", prompt, this.warmShare(timeout));
      if (warm !== null) return warm;
      timeout = Math.max(1, timeout - (Date.now() - startedAt));
    }

    return this.runClaude(prompt, {
      model: "haiku",
      maxTurns: 3,
      timeout,
    });
  }

  async executeTask(instruction: string): Promise<string> {
    this._onActivity?.("adapter.task_start", instruction.slice(0, 80));

    // Warm path (per-meeting persistent CLI) — any failure falls back to cold.
    // Warm + cold share ONE deadline (see recallContext): warm gets at most
    // min(15s, budget/2), the cold fallback gets the remainder.
    let timeout = this.taskBudgetMs;
    if (this._warm) {
      const startedAt = Date.now();
      const warm = await this.tryWarm("task", instruction, this.warmShare(timeout));
      if (warm !== null) {
        this._onActivity?.("adapter.task_done", warm.slice(0, 80));
        return warm;
      }
      timeout = Math.max(1, timeout - (Date.now() - startedAt));
    }

    const result = await this.runClaude(instruction, {
      model: "sonnet",
      maxTurns: 10,
      timeout,
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
      this.bin, "-p",
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
          setTimeout(() => {
            try { proc.kill(); } catch {} // #16: Kill orphan subprocess on timeout
            reject(new Error(`claude -p timeout (${timeout}ms)`));
          }, timeout)
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
      // CostMeter: the dominant `agent` cost. claude -p --output-format json
      // reports EXACT total_cost_usd + usage — record it verbatim (fail-soft).
      recordUsage({
        component: "agent",
        model,
        inputTokens: parsed?.usage?.input_tokens,
        outputTokens: parsed?.usage?.output_tokens,
        cacheReadTokens: parsed?.usage?.cache_read_input_tokens,
        cacheCreationTokens: parsed?.usage?.cache_creation_input_tokens,
        costUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
        meta: { adapter: "claude-code", path: "cold" },
      });
      return parsed.result || parsed.content || parsed.text || stdout;
    } catch {
      return stdout.trim();
    }
  }
}
