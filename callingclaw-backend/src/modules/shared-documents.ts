// CallingClaw 2.0 — Shared Document Directory
// ═══════════════════════════════════════════════════════════════════
// All meeting files follow a unified naming convention:
//
//   ~/.callingclaw/shared/{meetingId}_prep.md      ← 会前调研 (OpenClaw writes)
//   ~/.callingclaw/shared/{meetingId}_live.md      ← 会中实时日志
//   ~/.callingclaw/shared/{meetingId}_summary.md   ← 会后总结
//   ~/.callingclaw/shared/{meetingId}_transcript.md← 完整记录
//   ~/.callingclaw/shared/sessions.json            ← 会议索引
//
// meetingId = Google Calendar Event ID (e.g., "tnkfge7gfvnhit4cmc09no4hjc")
//   or fallback: "{date}_{safeTopic}" if no calendar event
//
// OpenClaw writes _prep.md directly. CallingClaw writes _summary.md and _live.md.
// Desktop renders by looking up meetingId → reading the corresponding .md files.
// ═══════════════════════════════════════════════════════════════════

import { SHARED_DIR, SHARED_NOTES_DIR } from "../config";
import { appendFileSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { MeetingPrepBrief } from "../skills/meeting-prep";
import type { EventBus } from "./event-bus";

const SESSIONS_PATH = resolve(SHARED_DIR, "sessions.json");

// ── File Suffixes (convention shared with OpenClaw skill) ──

export const FILE_SUFFIXES = {
  prep: "_prep.md",        // 会前调研 — OpenClaw writes
  live: "_live.md",        // 会中实时日志 — CallingClaw appends
  summary: "_summary.md",  // 会后总结 — CallingClaw writes
  transcript: "_transcript.md", // 完整对话记录
} as const;

// ── Meeting Session ──

export interface MeetingSession {
  meetingId: string;         // CallingClaw-generated: cc_{ts}_{rand} (stable from first moment)
  topic: string;
  meetUrl?: string;
  startTime?: string;
  endTime?: string;
  calendarEventId?: string;
  status: "preparing" | "ready" | "active" | "ended";
  files: {
    prep?: string;           // filename (not full path)
    live?: string;
    summary?: string;
    transcript?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SessionsIndex {
  lastUpdated: string;
  sharedDir: string;
  sessions: MeetingSession[];
}

// ── Utility ──

export function safeFilename(topic: string): string {
  return topic.replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 60);
}

function isoNow(): string { return new Date().toISOString(); }

/** Generate a stable meetingId at request time.
 * Format: cc_{timestamp}_{random} — always available before calendar creation.
 * CalendarEventId is linked later in sessions.json after calendar succeeds. */
export function generateMeetingId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `cc_${ts}_${rand}`;
}

/** Get the full file path for a meeting document */
export function getMeetingFilePath(meetingId: string, suffix: keyof typeof FILE_SUFFIXES): string {
  return resolve(SHARED_DIR, meetingId + FILE_SUFFIXES[suffix]);
}

// ── Sessions Index ──

export function readSessions(): SessionsIndex {
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
  } catch {
    return { lastUpdated: isoNow(), sharedDir: SHARED_DIR, sessions: [] };
  }
}

export function saveSessions(index: SessionsIndex): void {
  index.lastUpdated = isoNow();
  index.sharedDir = SHARED_DIR;
  Bun.write(SESSIONS_PATH, JSON.stringify(index, null, 2)).catch(() => {});
}

/**
 * Optional MeetingDB sync callback.
 * Set by callingclaw.ts at startup to keep SQLite in sync with sessions.json.
 */
let _dbSyncFn: ((session: MeetingSession) => void) | null = null;

/** Register the MeetingDB sync function (call once at startup) */
export function setMeetingDBSync(fn: (session: MeetingSession) => void) {
  _dbSyncFn = fn;
}

/** Register or update a meeting session */
export function upsertSession(session: Partial<MeetingSession> & { meetingId: string }): MeetingSession {
  const index = readSessions();
  let existing = index.sessions.find(s => s.meetingId === session.meetingId);
  if (existing) {
    Object.assign(existing, session, { updatedAt: isoNow() });
  } else {
    existing = {
      meetingId: session.meetingId,
      topic: session.topic || "Meeting",
      status: session.status || "preparing",
      files: session.files || {},
      createdAt: isoNow(),
      updatedAt: isoNow(),
      ...session,
    } as MeetingSession;
    index.sessions.unshift(existing);
  }
  // Keep last 50 sessions
  if (index.sessions.length > 50) index.sessions = index.sessions.slice(0, 50);
  saveSessions(index);

  // Sync to MeetingDB (SQLite) if registered
  if (_dbSyncFn && existing) {
    try { _dbSyncFn(existing); } catch {}
  }

  return existing;
}

/** Delete a meeting session by meetingId */
export function deleteSession(meetingId: string): boolean {
  const index = readSessions();
  const before = index.sessions.length;
  index.sessions = index.sessions.filter(s => s.meetingId !== meetingId);
  if (index.sessions.length < before) {
    saveSessions(index);
    console.log(`[Sessions] Deleted: ${meetingId}`);
    return true;
  }
  return false;
}

/** Find session by meetingId */
export function findSession(meetingId: string): MeetingSession | undefined {
  return readSessions().sessions.find(s => s.meetingId === meetingId);
}

/** List all sessions */
export function listSessions(): MeetingSession[] {
  return readSessions().sessions;
}

// ── Also keep old updateManifest for backward compat ──
export async function updateManifest(_mutate?: any): Promise<any> {
  // Now a no-op — sessions.json replaces manifest.json
  return readSessions();
}

// ── Prep Brief Persistence ──

/**
 * Save a MeetingPrepBrief using meetingId-based filename.
 * Path: ~/.callingclaw/shared/{meetingId}_prep.md
 */
export async function savePrepBrief(brief: MeetingPrepBrief, meetingId?: string): Promise<string> {
  const id = meetingId || generateMeetingId();
  const filePath = getMeetingFilePath(id, "prep");
  const md = renderPrepBriefMarkdown(brief);
  await Bun.write(filePath, md);

  // Update sessions index
  upsertSession({
    meetingId: id,
    topic: brief.topic,
    status: "ready",
    files: { prep: id + FILE_SUFFIXES.prep },
  });

  console.log(`[SharedDocs] Prep saved: ${filePath}`);
  return filePath;
}

function renderPrepBriefMarkdown(brief: MeetingPrepBrief): string {
  const p: string[] = [];
  const time = new Date(brief.generatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // Header
  p.push(`# ${brief.topic}`);
  p.push("");
  if (brief.goal) p.push(`> ${brief.goal}`);
  p.push("");
  const meta: string[] = [`${time}`];
  if (brief.attendees?.length > 0) {
    const others = brief.attendees.filter((a) => !a.self);
    if (others.length > 0) meta.push(others.map((a) => a.displayName || a.email).join(", "));
  }
  p.push(`*${meta.join(" · ")}*`);
  p.push("");
  p.push("---");
  p.push("");

  // Summary
  if (brief.summary) {
    p.push(brief.summary);
    p.push("");
  }

  // Key Points
  if (brief.keyPoints.length > 0) {
    p.push("## 📌 要点");
    p.push("");
    brief.keyPoints.forEach((pt, i) => p.push(`${i + 1}. ${pt}`));
    p.push("");
  }

  // Architecture Decisions
  if (brief.architectureDecisions.length > 0) {
    p.push("## 🏗️ 架构决策");
    p.push("");
    brief.architectureDecisions.forEach((d) => {
      p.push(`### ${d.decision}`);
      p.push(d.rationale);
      p.push("");
    });
  }

  // Expected Q&A
  if (brief.expectedQuestions.length > 0) {
    p.push("## ❓ 预期问题");
    p.push("");
    brief.expectedQuestions.forEach((q, i) => {
      p.push(`### Q${i + 1}: ${q.question}`);
      p.push("");
      p.push(`> ${q.suggestedAnswer}`);
      p.push("");
    });
  }

  // Previous Context
  if (brief.previousContext) {
    p.push("## 📜 历史背景");
    p.push("");
    p.push(brief.previousContext);
    p.push("");
  }

  // Files & Links
  const hasFiles = brief.filePaths.length > 0;
  const hasUrls = brief.browserUrls.length > 0;
  if (hasFiles || hasUrls) {
    p.push("## 📎 相关资源");
    p.push("");
    if (hasFiles) {
      p.push("**文件**");
      p.push("");
      brief.filePaths.forEach((f) => {
        const name = f.path.split("/").pop() || f.path;
        p.push(`- \`${name}\` — ${f.description}`);
      });
      p.push("");
    }
    if (hasUrls) {
      p.push("**链接**");
      p.push("");
      brief.browserUrls.forEach((u) => {
        p.push(`- [${u.description}](${u.url})`);
      });
      p.push("");
    }
  }

  p.push("---");
  p.push(`*Generated by CallingClaw × OpenClaw*`);

  return p.join("\n");
}

// ── HTML Rendering ──

/**
 * Convert markdown content to a standalone HTML file with inline CSS.
 * Used for Vercel deployment — produces a self-contained HTML document.
 */
export function renderToHtml(markdown: string, title: string): string {
  // Simple markdown → HTML conversion (covers our meeting document patterns)
  let html = markdown
    // Headers
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold + italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Blockquotes
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    // Ordered lists
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    // Unordered lists
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    // Horizontal rules
    .replace(/^---$/gm, "<hr>")
    // Wrap consecutive <li> in <ul> (simple heuristic)
    .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
    // Paragraphs: non-tag lines with content
    .replace(/^(?!<[a-z])((?!<\/)[^\n]+)$/gm, "<p>$1</p>");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — CallingClaw</title>
<style>
  :root { --bg: #fafafa; --fg: #1c1c1e; --accent: #E63946; --muted: #8e8e93; --surface: #f0f0f0; --border: #e5e5ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f5f5f7; --surface: #2c2c2e; --border: #3a3a3c; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); max-width: 720px; margin: 0 auto; padding: 40px 24px; line-height: 1.7; font-size: 15px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 600; margin: 28px 0 12px; color: var(--accent); }
  h3 { font-size: 16px; font-weight: 600; margin: 20px 0 8px; }
  p { margin: 8px 0; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin: 4px 0; }
  blockquote { border-left: 3px solid var(--accent); padding: 8px 16px; margin: 12px 0; color: var(--muted); background: var(--surface); border-radius: 0 8px 8px 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
  code { background: var(--surface); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }
  em { font-style: italic; color: var(--muted); }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
${html}
<div class="footer">Generated by CallingClaw × OpenClaw</div>
</body>
</html>`;
}

/**
 * Save an HTML version of a meeting document alongside the markdown.
 * Returns the HTML file path.
 */
export async function saveHtml(markdown: string, title: string, meetingId: string, suffix: "prep" | "summary"): Promise<string> {
  const htmlPath = resolve(SHARED_DIR, `${meetingId}_${suffix}.html`);
  const html = renderToHtml(markdown, title);
  await Bun.write(htmlPath, html);
  console.log(`[SharedDocs] HTML saved: ${htmlPath}`);
  return htmlPath;
}

// ── Live Log Management ──

/**
 * Start a live log file for a meeting. Returns the log filepath.
 */
export async function startLiveLog(topic: string, meetingId?: string): Promise<string> {
  const id = meetingId || generateMeetingId();
  const filepath = getMeetingFilePath(id, "live");

  const header = `# Live Meeting Log: ${topic}\n\n**Started:** ${new Date().toLocaleString()}\n\n---\n\n`;
  await Bun.write(filepath, header);

  upsertSession({
    meetingId: id,
    topic,
    status: "active",
    files: { live: id + FILE_SUFFIXES.live },
  });

  console.log(`[SharedDocs] Live log started: ${filepath}`);
  return filepath;
}

/**
 * Append a line to the active live log file.
 * Appends synchronously for minimal latency.
 * If eventBus + meetingId provided, also emits meeting.live_entry for real-time frontend updates.
 */
export function appendToLiveLog(filepath: string, entry: string, eventBus?: EventBus, meetingId?: string): void {
  try {
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    appendFileSync(filepath, `[${timestamp}] ${entry}\n`);
    if (eventBus && meetingId) {
      eventBus.emit("meeting.live_entry", { meetingId, entry, timestamp });
    }
  } catch (e: any) {
    console.warn(`[SharedDocs] Failed to append live log: ${e.message}`);
  }
}

/**
 * Stop the live log: mark as inactive in manifest and add footer.
 */
export async function stopLiveLog(filepath: string, meetingId?: string): Promise<void> {
  try {
    appendFileSync(filepath, `\n---\n\n**Ended:** ${new Date().toLocaleString()}\n`);
  } catch {}

  if (meetingId) {
    upsertSession({ meetingId, status: "ended" });
  }

  console.log(`[SharedDocs] Live log stopped: ${filepath}`);
}

// ── Notes Directory (for meeting.ts migration) ──

/**
 * Register a meeting notes file in the manifest.
 * Called after exportToMarkdown writes to SHARED_NOTES_DIR.
 */
export async function registerNotesFile(filename: string, topic: string): Promise<void> {
  await updateManifest((m) => {
    // Avoid duplicates
    if (!m.notes.some((n) => n.file === filename)) {
      m.notes.unshift({
        file: filename,
        topic,
        createdAt: isoNow(),
      });
    }
  });
}

/**
 * List all note files from SHARED_NOTES_DIR.
 * Also includes files from the legacy meeting_notes/ directory.
 */
export async function listAllNoteFiles(legacyDir?: string): Promise<string[]> {
  const files: string[] = [];

  // Shared notes directory
  try {
    const glob = new Bun.Glob("*.md");
    for await (const file of glob.scan(SHARED_NOTES_DIR)) {
      files.push(file);
    }
  } catch {}

  // Legacy directory (if provided and different from shared)
  if (legacyDir && legacyDir !== SHARED_NOTES_DIR) {
    try {
      const glob = new Bun.Glob("*.md");
      for await (const file of glob.scan(legacyDir)) {
        if (!files.includes(file)) {
          files.push(file);
        }
      }
    } catch {}
  }

  return files.sort().reverse();
}

/**
 * Read a note file, checking SHARED_NOTES_DIR first, then legacy dir.
 */
export async function readNoteFile(filename: string, legacyDir?: string): Promise<string> {
  const safeName = filename.replace(/[/\\]/g, "");

  // Check shared dir first
  const sharedFile = Bun.file(resolve(SHARED_NOTES_DIR, safeName));
  if (await sharedFile.exists()) {
    return await sharedFile.text();
  }

  // Check legacy dir
  if (legacyDir && legacyDir !== SHARED_NOTES_DIR) {
    const legacyFile = Bun.file(resolve(legacyDir, safeName));
    if (await legacyFile.exists()) {
      return await legacyFile.text();
    }
  }

  throw new Error(`Note file not found: ${safeName}`);
}

/**
 * Read any file from the shared directory by relative path.
 * Validates the path is within SHARED_DIR to prevent traversal.
 */
export async function readSharedFile(pathOrRelative: string): Promise<string> {
  let fullPath: string;

  if (pathOrRelative.startsWith("/")) {
    // Absolute path (from SQLite DB) — validate it's within SHARED_DIR
    fullPath = pathOrRelative;
    if (!fullPath.startsWith(SHARED_DIR)) {
      throw new Error("Path traversal not allowed");
    }
  } else {
    // Relative path (legacy) — resolve against SHARED_DIR
    const safePath = pathOrRelative.replace(/\.\./g, "").replace(/^\/+/, "");
    fullPath = resolve(SHARED_DIR, safePath);
    if (!fullPath.startsWith(SHARED_DIR)) {
      throw new Error("Path traversal not allowed");
    }
  }

  const f = Bun.file(fullPath);
  if (!(await f.exists())) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return await f.text();
}

/**
 * List available prep brief files from SHARED_PREP_DIR.
 */
export async function listPrepFiles(): Promise<string[]> {
  const files: string[] = [];
  try {
    const glob = new Bun.Glob("*.md");
    for await (const file of glob.scan(SHARED_PREP_DIR)) {
      files.push(file);
    }
  } catch {}
  return files.sort().reverse();
}
