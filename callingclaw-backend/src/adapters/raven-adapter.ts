// CallingClaw 2.0 — Raven Agent Adapter
// Uses `raven agent -m "<prompt>"` subprocess for all cognitive tasks.
// Internal setTimeout for scheduling (no external cron dependency).
//
// This adapter enables CallingClaw to use Raven (EverMind-AI's agent CLI) as
// its agentic backend — no OpenClaw / Claude Code installation needed.
//
// Raven headless invocation:
//   raven agent -m "<prompt>"                              → final answer as plain text
//   raven agent -m "<prompt>" -w <workspace> --no-markdown --no-logs
//
// ⚠️  `-m` COLLISION: for hermes/codex/claude `-m` means *model*. For Raven,
//     `-m` is the MESSAGE/PROMPT and there is NO model flag at all. The adapter
//     MUST NOT pass a model on the command line. Raven selects the model from
//     its config file (~/.raven/config.json), seeded once by ./scripts/setup-raven.sh
//     (design Decision 2, "Option B"). The RAVEN_*_MODEL getters below are
//     plumbed for a future per-channel override but are intentionally INERT in v1.
//
// Channels:
//   - Meeting prep:    raven agent -m "<OC-001 prompt>"    (deep research)
//   - Context recall:  raven agent -m "<recall prompt>"    (fast)
//   - Task execution:  raven agent -m "<instruction>"
//   - Scheduling:      Internal setTimeout + disk persistence
//   - Delivery:        Local file + macOS notification (Raven polls events)

import type { AgentAdapter } from "../agent-adapter";
import { InternalJobScheduler, type ScheduledJob } from "../agent-adapter";
import {
  OC001_PROMPT, type OC001_Request,
  OC006_PROMPT, type OC006_Request,
  OC010_PROMPT, type OC010_Request,
} from "../openclaw-protocol";
import { LANGUAGE_RULE } from "../prompt-constants";
import { recordUsage } from "../modules/cost-meter";

// Shared docs dir — read by Desktop and OpenClaw. Todo/notes files land here.
const WORKSPACE_DIR = `${process.env.HOME}/.callingclaw/shared`;

// Dedicated Raven `-w` workspace. Raven scaffolds memory files (agent_memory/,
// user_memory/, TOOLS.md, HEARTBEAT.md) into its workspace root, so it must NOT
// be pointed at the shared dir (that would pollute a directory other tools
// read). Keep Raven's scratch state in its own subdir.
const RAVEN_WORKSPACE_DIR = `${process.env.HOME}/.callingclaw/raven-workspace`;

// Resolve the raven executable. Raven installs as a PyPI wheel; the console
// script can land in several places depending on install method (pip, pipx,
// curl installer, homebrew). A daemon's PATH may not include ~/.local/bin, so
// probe the common locations. `RAVEN_BIN` lets users point at a custom install
// (and tests at a stub).
function resolveRavenBin(): string {
  if (process.env.RAVEN_BIN) return process.env.RAVEN_BIN;         // 1. explicit override / test stub
  try {                                                            // 2. on PATH
    require("child_process").execSync("which raven", { stdio: "ignore" });
    return "raven";
  } catch {}
  const fs = require("fs");
  const candidates = [                                            // 3. common install locations
    `${process.env.HOME}/.local/bin/raven`,                        //    pip --user / curl installer
    `${process.env.HOME}/.local/pipx/venvs/raven/bin/raven`,       //    pipx venv
    `/opt/homebrew/bin/raven`,                                     //    homebrew (Apple Silicon)
    `/usr/local/bin/raven`,                                        //    homebrew (Intel) / system
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return "raven";                                                 // 4. fall back; connect() surfaces the error
}

// Model selection — RESERVED, NOT APPLIED IN v1.
// Raven selects the model from ~/.raven/config.json (NOT via a CLI flag), so
// these getters are intentionally never passed on the command line. They are
// plumbed here so the adapter shape matches its Hermes/Codex siblings and so a
// future per-channel override (or a `--model`-style flag if Raven adds one) can
// be honored without touching call sites. Empty string = "use whatever
// ~/.raven/config.json is configured for" (the Option B default). Read lazily
// so changes apply without a backend restart.
const prepModel = () => process.env.RAVEN_PREP_MODEL || process.env.RAVEN_MODEL || "";
const recallModel = () => process.env.RAVEN_RECALL_MODEL || process.env.RAVEN_MODEL || "";
const taskModel = () => process.env.RAVEN_TASK_MODEL || prepModel();

export class RavenAdapter implements AgentAdapter {
  readonly name = "raven" as const;
  private _connected = false;
  private scheduler: InternalJobScheduler;
  private _onActivity: ((kind: string, summary: string, detail?: string) => void) | null = null;

  constructor(onJobFire?: (job: ScheduledJob) => void) {
    this.scheduler = new InternalJobScheduler(onJobFire || (() => {}));
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    // Verify raven CLI is available. `raven --version` is instant and requires
    // no model/provider config, so it's a cheap liveness probe.
    try {
      const proc = Bun.spawn([resolveRavenBin(), "--version"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      if (stdout.trim()) {
        this._connected = true;
        console.log(`[RavenAdapter] Connected (${stdout.trim()})`);
      } else {
        throw new Error("raven CLI not found");
      }
    } catch (e: any) {
      this._connected = false;
      throw new Error(`Raven not available: ${e.message}`);
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
    const result = await this.runRaven(OC001_PROMPT(req), {
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

    return this.runRaven(prompt, {
      model: recallModel(),
      timeout: 30000,
    });
  }

  async executeTask(instruction: string): Promise<string> {
    this._onActivity?.("adapter.task_start", instruction.slice(0, 80));
    const result = await this.runRaven(instruction, {
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
      console.log(`[RavenAdapter] Todos written to ${filePath}`);

      try {
        Bun.spawn(["osascript", "-e",
          `display notification "Meeting '${opts.topic}' ended with ${opts.todos.length} action items" with title "CallingClaw"`,
        ]);
      } catch {}

      return true;
    } catch (e: any) {
      console.error(`[RavenAdapter] Failed to write todos: ${e.message}`);
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
    return this.runRaven(OC006_PROMPT(req), {
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
    return this.runRaven(OC010_PROMPT(req), {
      model: prepModel(),
      timeout: 120000,
    });
  }

  // ── Activity Feed ──

  onActivity(fn: (kind: string, summary: string, detail?: string) => void): void {
    this._onActivity = fn;
  }

  // ── Raven CLI Runner ──

  private async runRaven(prompt: string, opts: {
    model?: string;
    timeout?: number;
    cwd?: string;
  } = {}): Promise<string> {
    const timeout = opts.timeout || 30000;
    const cwd = opts.cwd || RAVEN_WORKSPACE_DIR;

    // Ensure Raven's dedicated workspace exists — Raven scaffolds memory files
    // (agent_memory/, user_memory/, TOOLS.md, HEARTBEAT.md) into `-w`, so we
    // keep those out of the shared dir that Desktop/OpenClaw read.
    try { require("fs").mkdirSync(cwd, { recursive: true }); } catch {}

    // `agent -m PROMPT`: single message in, final answer text out.
    //   -w <cwd>       Raven's dedicated workspace root (raven-workspace) — NOT
    //                  the shared dir, because Raven scaffolds memory files here
    //   --no-markdown  strip rich/ANSI markup so stdout is clean plain text
    //   --no-logs      suppress Raven's own run logs from stdout (answer only)
    //
    // NOTE: `opts.model` is deliberately NOT passed. Raven has no model flag —
    // the model is resolved from ~/.raven/config.json (design Decision 2). The
    // arg is accepted only to keep the runner signature aligned with the Hermes
    // sibling and to reserve the seam for a future per-channel override.
    const args: string[] = [
      resolveRavenBin(),
      "agent",
      "-m", prompt,
      "-w", cwd,
      "--no-markdown",
      "--no-logs",
    ];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      // NO_COLOR / TERM=dumb ask Raven's Python `rich` layer to emit no ANSI
      // color codes (rich honors NO_COLOR). Defense in depth — the regex strip
      // below is the reliable path, since --no-markdown does NOT strip colors.
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });

    // Read stdout to completion BEFORE awaiting proc.exited: Raven hard-exits
    // via os._exit(0), which can skip stdio flushing in some runtimes, so drain
    // the pipe first.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill(); // reap the child on timeout (no zombies)
          reject(new Error(`raven agent timeout (${timeout}ms)`));
        }, timeout);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    const stderr = await new Response(proc.stderr).text();

    // Strip terminal ANSI color codes: `--no-markdown` does NOT remove them, and
    // Raven's `rich`-based output can still emit `\x1b[..m` sequences (e.g. the
    // red error text on failure). Apply to BOTH the error message and the
    // success value so no escape codes leak into the meeting pipeline.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const cleanStdout = stripAnsi(stdout);

    const exitCode = await proc.exited;
    // Raven exits 0 on success and non-zero on failure — and on failure it
    // prints the error text to STDOUT (empirically confirmed: exit 1 with
    // "Error: No API key configured..." on stdout). So a non-empty stdout is
    // NOT a success signal. Throw whenever the exit code is non-zero, using the
    // (stripped) stdout error text, falling back to stderr.
    if (exitCode !== 0) {
      const msg = (cleanStdout.trim() || stripAnsi(stderr).trim() || "(no output)").slice(0, 500);
      throw new Error(`raven agent exited ${exitCode}: ${msg}`);
    }

    // CostMeter: `agent` cost. `raven agent -m` emits plain text only (no usage
    // block), so record the call with tokens unknown — at least it's counted.
    // Fail-soft. `opts.model` is normally "" (Option B: the model lives in
    // ~/.raven/config.json, not the argv), so fall back to the adapter name.
    recordUsage({
      component: "agent",
      model: opts.model || "raven",
      meta: { adapter: "raven" },
    });

    // Raven emits plain text (with --no-markdown --no-logs) — no JSON to parse.
    // …BUT even with `--no-logs`, Raven's stdout still carries a preamble BEFORE
    // the model answer (empirically confirmed against raven v0.1.1):
    //   • structlog init/warning lines  ("… [info    ] app_created …",
    //     "… [warning ] embedding_not_configured …")
    //   • EverosBackend recall/store degradation messages
    //   • a blank line, then the banner line  "🐦‍⬛ Raven"
    //   • THEN the actual assistant answer (which may span multiple lines)
    // The banner sits on its OWN line — codepoints U+1F426 U+200D U+2B1B ' Raven'.
    // Strip everything up to and including the LAST banner line so cognitive
    // tasks (prep/recall) get the answer only, not noise-prefixed output.
    return stripRavenPreamble(cleanStdout);
  }
}

// Extract only the assistant answer from Raven's cleaned stdout: everything
// AFTER the last "🐦‍⬛ Raven" banner line, trimmed. The banner is matched
// leniently — the raven bird glyph (U+1F426, optionally joined to the black
// square via ZWJ) followed by "Raven" on its own line — so a future glyph tweak
// or a stray leading/trailing space still splits correctly.
// DEFENSIVE: if no banner is present, return the full cleaned (trimmed) stdout
// so we NEVER swallow a real answer that lacked the banner.
function stripRavenPreamble(cleanStdout: string): string {
  // \u{1F426} = 🐦 bird, \u{2B1B} = ⬛ black square, ‍ = ZWJ (joins them).
  // Anchor to a full line so log lines that merely mention "Raven" don't match.
  const bannerLine = /^[ \t]*\u{1F426}(?:‍?\u{2B1B})?[ \t]*Raven[ \t]*$/gmu;
  let lastEnd = -1;
  for (const m of cleanStdout.matchAll(bannerLine)) {
    lastEnd = m.index! + m[0].length;
  }
  if (lastEnd === -1) return cleanStdout.trim(); // no banner → return as-is
  return cleanStdout.slice(lastEnd).trim();
}
