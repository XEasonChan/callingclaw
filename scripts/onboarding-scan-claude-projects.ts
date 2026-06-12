#!/usr/bin/env bun
// CallingClaw — Onboarding: shallow scan of the user's Claude Code projects.
//
// "Work-memory lite": reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// transcripts the same way the Tanka work-memory plugin discovers them, but
// extracts only a SHALLOW summary (project paths, activity recency, first
// user message per recent session). No code, no file contents, no tool logs.
//
// Output: ~/.callingclaw/shared/onboarding-context.md — picked up by the
// meeting prep / pinned-context pipeline so the CallingClaw digital human
// can reference what the user has been working on during the onboarding call.
//
// Usage: bun scripts/onboarding-scan-claude-projects.ts [--max-projects N] [--dry-run]

import { readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_PROJECTS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--max-projects") || "5");
const DRY_RUN = process.argv.includes("--dry-run");

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const OUT_DIR = process.env.CALLINGCLAW_SHARED_DIR || join(homedir(), ".callingclaw", "shared");
const OUT_FILE = join(OUT_DIR, "onboarding-context.md");

const SNIPPET_LEN = 140;
const RECENT_SESSIONS_PER_PROJECT = 3;

interface SessionInfo {
  file: string;
  mtimeMs: number;
  cwd?: string;
  firstUserMessage?: string;
}

interface ProjectInfo {
  encodedName: string;
  cwd: string;
  sessionCount: number;
  lastActiveMs: number;
  recentTopics: string[];
}

function extractFromJsonl(path: string): { cwd?: string; firstUserMessage?: string } {
  // Stream-read the first ~200 lines: the `cwd` field appears on most
  // entries; the first human-typed user message is usually near the top.
  let cwd: string | undefined;
  let firstUserMessage: string | undefined;
  try {
    const text = require("node:fs").readFileSync(path, "utf-8");
    const lines = text.split("\n", 200);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
      if (!firstUserMessage && obj.type === "user" && obj.message) {
        const content = obj.message.content;
        const textPart = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((c: any) => c.type === "text")?.text
            : undefined;
        // Skip harness-injected content (commands, system reminders)
        if (textPart && !textPart.startsWith("<") && !textPart.startsWith("Caveat:")) {
          firstUserMessage = textPart.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN);
        }
      }
      if (cwd && firstUserMessage) break;
    }
  } catch {}
  return { cwd, firstUserMessage };
}

function scan(): ProjectInfo[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const projects: ProjectInfo[] = [];

  for (const entry of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, entry);
    let sessions: SessionInfo[] = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      sessions = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const p = join(dir, f);
          return { file: p, mtimeMs: statSync(p).mtimeMs };
        });
    } catch { continue; }
    if (sessions.length === 0) continue;

    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent = sessions.slice(0, RECENT_SESSIONS_PER_PROJECT);

    let cwd = "";
    const recentTopics: string[] = [];
    for (const s of recent) {
      const { cwd: c, firstUserMessage } = extractFromJsonl(s.file);
      if (!cwd && c) cwd = c;
      if (firstUserMessage) recentTopics.push(firstUserMessage);
    }

    projects.push({
      encodedName: entry,
      // Fallback: the encoded dir name with dashes (lossy) if no cwd found
      cwd: cwd || entry.replace(/^-/, "/").replace(/-/g, "/"),
      sessionCount: sessions.length,
      lastActiveMs: sessions[0]!.mtimeMs,
      recentTopics,
    });
  }

  projects.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return projects.slice(0, MAX_PROJECTS);
}

function render(projects: ProjectInfo[]): string {
  const now = new Date();
  const lines: string[] = [
    "# Onboarding Context — User's Recent Claude Code Work",
    "",
    `_Shallow scan of ~/.claude/projects on ${now.toISOString().slice(0, 16)} (project paths + recent session openers only; no code or file contents)._`,
    "",
  ];
  if (projects.length === 0) {
    lines.push("No Claude Code projects found on this machine.");
  }
  for (const p of projects) {
    const ago = Math.round((Date.now() - p.lastActiveMs) / 3_600_000);
    const agoStr = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
    lines.push(`## ${p.cwd}`);
    lines.push(`- Sessions: ${p.sessionCount}, last active: ${agoStr}`);
    if (p.recentTopics.length > 0) {
      lines.push("- Recent session openers:");
      for (const t of p.recentTopics) lines.push(`  - “${t}”`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("Use this during onboarding to personalize the conversation: mention the user's active projects by name, and offer concrete examples of how CallingClaw could help (e.g. prep a meeting about their most active project).");
  return lines.join("\n");
}

const projects = scan();
const md = render(projects);

if (DRY_RUN) {
  console.log(md);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  await Bun.write(OUT_FILE, md);
  console.log(`Wrote ${OUT_FILE} (${projects.length} projects, ${md.length} chars)`);
  for (const p of projects) console.log(`  - ${p.cwd} (${p.sessionCount} sessions)`);
}
