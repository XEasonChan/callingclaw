// CallingClaw 2.0 — Shared Document Directory
// ═══════════════════════════════════════════════════════════════════
// Manages the shared local document directory at ~/.callingclaw/shared/
// Provides persistence for meeting prep briefs, meeting notes, and live logs.
// Accessible by CallingClaw, OpenClaw, and the Desktop UI.
//
// Directory structure:
//   ~/.callingclaw/shared/
//     ├── prep/           ← meeting prep briefs (.md + .json)
//     ├── notes/          ← meeting notes/summaries (.md)
//     ├── logs/           ← meeting live logs (.md)
//     └── manifest.json   ← file index for quick discovery
// ═══════════════════════════════════════════════════════════════════

import {
  SHARED_DIR,
  SHARED_PREP_DIR,
  SHARED_NOTES_DIR,
  SHARED_LOGS_DIR,
  SHARED_MANIFEST_PATH,
} from "../config";
import { appendFileSync } from "fs";
import { resolve } from "path";
import type { MeetingPrepBrief } from "../skills/meeting-prep";

// ── Manifest Types ──

export interface ManifestEntry {
  file: string;
  topic: string;
  createdAt: string;
}

export interface ManifestLogEntry extends ManifestEntry {
  active: boolean;
}

export interface SharedManifest {
  lastUpdated: string;
  sharedDir: string;
  prep: ManifestEntry[];
  notes: ManifestEntry[];
  logs: ManifestLogEntry[];
}

// ── Utility: safe filename from topic ──

export function safeFilename(topic: string): string {
  return topic
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function datePrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── Manifest Management ──

export async function readManifest(): Promise<SharedManifest> {
  try {
    const f = Bun.file(SHARED_MANIFEST_PATH);
    if (await f.exists()) {
      return await f.json();
    }
  } catch {}
  return {
    lastUpdated: isoNow(),
    sharedDir: SHARED_DIR,
    prep: [],
    notes: [],
    logs: [],
  };
}

export async function updateManifest(
  mutate: (manifest: SharedManifest) => void
): Promise<SharedManifest> {
  const manifest = await readManifest();
  mutate(manifest);
  manifest.lastUpdated = isoNow();
  manifest.sharedDir = SHARED_DIR;
  await Bun.write(SHARED_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

// ── Prep Brief Persistence ──

/**
 * Save a MeetingPrepBrief to SHARED_PREP_DIR as both .md and .json.
 * Updates manifest.json.
 * Returns the markdown filepath.
 */
export async function savePrepBrief(brief: MeetingPrepBrief): Promise<string> {
  const prefix = datePrefix();
  const safeTopic = safeFilename(brief.topic);
  const baseName = `${prefix}_${safeTopic}`;
  const mdFile = `${baseName}.md`;
  const jsonFile = `${baseName}.json`;

  // Build readable markdown
  const md = renderPrepBriefMarkdown(brief);
  const mdPath = resolve(SHARED_PREP_DIR, mdFile);
  const jsonPath = resolve(SHARED_PREP_DIR, jsonFile);

  await Bun.write(mdPath, md);
  // Only markdown — no JSON file (Desktop reads .md directly)

  // Update manifest
  await updateManifest((m) => {
    // Remove duplicate for same base name
    m.prep = m.prep.filter((e) => !e.file.startsWith(baseName));
    m.prep.unshift({
      file: mdFile,
      topic: brief.topic,
      createdAt: isoNow(),
    });
  });

  console.log(`[SharedDocs] Prep brief saved: ${mdPath}`);
  return mdPath;
}

function renderPrepBriefMarkdown(brief: MeetingPrepBrief): string {
  const parts: string[] = [];

  parts.push(`# Meeting Prep Brief: ${brief.topic}`);
  parts.push("");
  parts.push(`**Goal:** ${brief.goal}`);
  parts.push(`**Generated:** ${new Date(brief.generatedAt).toLocaleString()}`);
  if (brief.attendees?.length > 0) {
    const others = brief.attendees.filter((a) => !a.self);
    if (others.length > 0) {
      parts.push(`**Attendees:** ${others.map((a) => a.displayName || a.email).join(", ")}`);
    }
  }
  parts.push("");
  parts.push("---");
  parts.push("");

  // Summary
  parts.push("## Summary");
  parts.push("");
  parts.push(brief.summary || "(no summary)");
  parts.push("");

  // Key Points
  if (brief.keyPoints.length > 0) {
    parts.push("## Key Points");
    parts.push("");
    brief.keyPoints.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push("");
  }

  // Architecture Decisions
  if (brief.architectureDecisions.length > 0) {
    parts.push("## Architecture Decisions");
    parts.push("");
    brief.architectureDecisions.forEach((d) => {
      parts.push(`- **${d.decision}**`);
      parts.push(`  Rationale: ${d.rationale}`);
    });
    parts.push("");
  }

  // Expected Questions
  if (brief.expectedQuestions.length > 0) {
    parts.push("## Expected Questions");
    parts.push("");
    brief.expectedQuestions.forEach((q) => {
      parts.push(`**Q:** ${q.question}`);
      parts.push(`**A:** ${q.suggestedAnswer}`);
      parts.push("");
    });
  }

  // Previous Context
  if (brief.previousContext) {
    parts.push("## Previous Meeting Context");
    parts.push("");
    parts.push(brief.previousContext);
    parts.push("");
  }

  // File Paths
  if (brief.filePaths.length > 0) {
    parts.push("## Relevant Files");
    parts.push("");
    brief.filePaths.forEach((f) => {
      parts.push(`- \`${f.path}\` — ${f.description}${f.action ? ` [${f.action}]` : ""}`);
    });
    parts.push("");
  }

  // Browser URLs
  if (brief.browserUrls.length > 0) {
    parts.push("## Browser URLs");
    parts.push("");
    brief.browserUrls.forEach((u) => {
      parts.push(`- [${u.description}](${u.url})${u.action ? ` [${u.action}]` : ""}`);
    });
    parts.push("");
  }

  // Folder Paths
  if (brief.folderPaths?.length > 0) {
    parts.push("## Project Directories");
    parts.push("");
    brief.folderPaths.forEach((f) => {
      parts.push(`- \`${f.path}\` — ${f.description}`);
    });
    parts.push("");
  }

  parts.push("---");
  parts.push(`_Generated by CallingClaw 2.0 at ${new Date().toISOString()}_`);

  return parts.join("\n");
}

// ── Live Log Management ──

/**
 * Start a live log file for a meeting. Returns the log filepath.
 */
export async function startLiveLog(topic: string): Promise<string> {
  const prefix = datePrefix();
  const safeTopic = safeFilename(topic);
  const filename = `${prefix}_${safeTopic}_live.md`;
  const filepath = resolve(SHARED_LOGS_DIR, filename);

  const header = `# Live Meeting Log: ${topic}\n\n**Started:** ${new Date().toLocaleString()}\n\n---\n\n`;
  await Bun.write(filepath, header);

  // Update manifest
  await updateManifest((m) => {
    // Mark all other logs as inactive
    m.logs.forEach((l) => { l.active = false; });
    m.logs.unshift({
      file: filename,
      topic,
      createdAt: isoNow(),
      active: true,
    });
  });

  console.log(`[SharedDocs] Live log started: ${filepath}`);
  return filepath;
}

/**
 * Append a line to the active live log file.
 * Appends synchronously for minimal latency.
 */
export function appendToLiveLog(filepath: string, entry: string): void {
  try {
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    appendFileSync(filepath, `[${timestamp}] ${entry}\n`);
  } catch (e: any) {
    console.warn(`[SharedDocs] Failed to append live log: ${e.message}`);
  }
}

/**
 * Stop the live log: mark as inactive in manifest and add footer.
 */
export async function stopLiveLog(filepath: string): Promise<void> {
  try {
    appendFileSync(filepath, `\n---\n\n**Ended:** ${new Date().toLocaleString()}\n`);
  } catch {}

  // Extract filename from path
  const filename = filepath.split("/").pop() || "";

  await updateManifest((m) => {
    const entry = m.logs.find((l) => l.file === filename);
    if (entry) entry.active = false;
  });

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
export async function readSharedFile(relativePath: string): Promise<string> {
  // Normalize and prevent traversal
  const safePath = relativePath.replace(/\.\./g, "").replace(/^\/+/, "");
  const fullPath = resolve(SHARED_DIR, safePath);

  // Ensure it's still within SHARED_DIR
  if (!fullPath.startsWith(SHARED_DIR)) {
    throw new Error("Path traversal not allowed");
  }

  const f = Bun.file(fullPath);
  if (!(await f.exists())) {
    throw new Error(`File not found: ${safePath}`);
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
