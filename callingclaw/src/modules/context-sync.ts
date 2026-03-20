// CallingClaw 2.0 — ContextSync Module
// Bridges context between OpenClaw memory, pinned files, Voice AI, and Computer Use.
//
// Problem: Voice (OpenAI), ComputerUse (Claude), and OpenClaw (Claude) each have
// separate context windows with no shared memory.
//
// Solution: Central context aggregator that:
//   1. Reads OpenClaw's MEMORY.md as base context
//   2. Allows pinning files (PRD, notes, etc.) to shared context
//   3. Generates tiered briefs: short for Voice, full for ComputerUse
//   4. Pushes updates to live Voice sessions via session.update

const OPENCLAW_MEMORY_PATH = `${process.env.HOME}/.openclaw/workspace/MEMORY.md`;
const OPENCLAW_SANDBOX_DIR = `${process.env.HOME}/.openclaw/sandboxes`;
const MAX_VOICE_BRIEF_CHARS = 4000;  // ~1000 tokens — enough for project summaries
const MAX_COMPUTER_BRIEF_CHARS = 8000; // ~2000 tokens
const MAX_FILE_CONTENT_CHARS = 4000;  // Per pinned file

export interface PinnedFile {
  path: string;
  content: string;       // raw content (truncated if large)
  summary?: string;      // optional short summary
  pinnedAt: number;
}

export interface ContextBrief {
  voice: string;     // short version for Voice system prompt
  computer: string;  // full version for ComputerUse system prompt
  raw: {
    openclawMemory: string | null;
    pinnedFiles: PinnedFile[];
    customNotes: string[];
  };
}

export class ContextSync {
  private openclawMemory: string | null = null;
  private openclawSoul: string | null = null;
  private pinnedFiles: PinnedFile[] = [];
  private customNotes: string[] = [];
  private _lastLoadedAt = 0;
  private _onUpdate: (() => void) | null = null;

  /** Register a callback fired whenever context changes (for pushing to Voice) */
  onUpdate(fn: () => void) {
    this._onUpdate = fn;
  }

  // ── OpenClaw Memory ──

  /** Load OpenClaw's MEMORY.md from disk */
  async loadOpenClawMemory(): Promise<boolean> {
    try {
      const file = Bun.file(OPENCLAW_MEMORY_PATH);
      if (!(await file.exists())) {
        console.log("[ContextSync] OpenClaw MEMORY.md not found");
        return false;
      }
      this.openclawMemory = await file.text();
      this._lastLoadedAt = Date.now();
      console.log(`[ContextSync] Loaded OpenClaw memory (${this.openclawMemory.length} chars)`);
      // Also load soul/persona files from OpenClaw sandbox
      await this.loadOpenClawSoul();
      return true;
    } catch (e: any) {
      console.warn("[ContextSync] Failed to load OpenClaw memory:", e.message);
      return false;
    }
  }

  /** Load OpenClaw's soul/persona files (SOUL.md, USER.md) from sandbox */
  private async loadOpenClawSoul(): Promise<void> {
    try {
      const { readdirSync } = await import("node:fs");
      // Find the latest sandbox directory
      const entries = readdirSync(OPENCLAW_SANDBOX_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith("agent-main"))
        .map(e => e.name);
      if (entries.length === 0) return;
      const sandboxDir = `${OPENCLAW_SANDBOX_DIR}/${entries[entries.length - 1]}`;

      const soulParts: string[] = [];
      for (const name of ["SOUL.md", "USER.md"]) {
        const f = Bun.file(`${sandboxDir}/${name}`);
        if (await f.exists()) {
          const text = await f.text();
          if (text.trim()) soulParts.push(text.trim());
        }
      }
      if (soulParts.length > 0) {
        this.openclawSoul = soulParts.join("\n\n---\n\n");
        console.log(`[ContextSync] Loaded OpenClaw soul (${this.openclawSoul.length} chars from ${soulParts.length} files)`);
      }
    } catch (e: any) {
      console.warn("[ContextSync] Failed to load soul files:", e.message);
    }
  }

  /** Get OpenClaw's soul/persona text (for Voice persona enrichment) */
  getSoul(): string | null {
    return this.openclawSoul;
  }

  /** Reload memory if file changed (check mtime) */
  async refreshIfChanged(): Promise<boolean> {
    try {
      const file = Bun.file(OPENCLAW_MEMORY_PATH);
      if (!(await file.exists())) return false;
      // Bun.file doesn't expose mtime easily, just reload
      const content = await file.text();
      if (content !== this.openclawMemory) {
        this.openclawMemory = content;
        this._lastLoadedAt = Date.now();
        console.log("[ContextSync] OpenClaw memory updated");
        this._onUpdate?.();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Pinned Files ──

  /** Pin a file to shared context. Reads content from disk. */
  async pinFile(filePath: string, summary?: string): Promise<PinnedFile | null> {
    // Avoid duplicates
    if (this.pinnedFiles.some((f) => f.path === filePath)) {
      console.log(`[ContextSync] File already pinned: ${filePath}`);
      return this.pinnedFiles.find((f) => f.path === filePath)!;
    }

    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        console.warn(`[ContextSync] File not found: ${filePath}`);
        return null;
      }

      let content = await file.text();
      if (content.length > MAX_FILE_CONTENT_CHARS) {
        content = content.slice(0, MAX_FILE_CONTENT_CHARS) + "\n...(truncated)";
      }

      const pinned: PinnedFile = {
        path: filePath,
        content,
        summary,
        pinnedAt: Date.now(),
      };

      this.pinnedFiles.push(pinned);
      console.log(`[ContextSync] Pinned: ${filePath} (${content.length} chars)`);
      this._onUpdate?.();
      return pinned;
    } catch (e: any) {
      console.warn(`[ContextSync] Failed to pin ${filePath}:`, e.message);
      return null;
    }
  }

  /** Unpin a file from shared context */
  unpinFile(filePath: string): boolean {
    const idx = this.pinnedFiles.findIndex((f) => f.path === filePath);
    if (idx === -1) return false;
    this.pinnedFiles.splice(idx, 1);
    console.log(`[ContextSync] Unpinned: ${filePath}`);
    this._onUpdate?.();
    return true;
  }

  /** Clear all pinned files (called on meeting end to prevent cross-meeting leakage) */
  clearPinnedFiles() {
    if (this.pinnedFiles.length > 0) {
      console.log(`[ContextSync] Clearing ${this.pinnedFiles.length} pinned files`);
      this.pinnedFiles = [];
      this._onUpdate?.();
    }
  }

  /** Get list of pinned files (without full content) */
  getPinnedFiles(): Array<{ path: string; summary?: string; pinnedAt: number; contentLength: number }> {
    return this.pinnedFiles.map((f) => ({
      path: f.path,
      summary: f.summary,
      pinnedAt: f.pinnedAt,
      contentLength: f.content.length,
    }));
  }

  // ── Custom Notes ──

  /** Add a free-text note to context (e.g. "We're discussing the CallingClaw 2.0 PRD") */
  addNote(note: string) {
    this.customNotes.push(note);
    this._onUpdate?.();
  }

  clearNotes() {
    this.customNotes = [];
    this._onUpdate?.();
  }

  // ── Brief Generation ──

  /** Generate context briefs for Voice and ComputerUse */
  getBrief(): ContextBrief {
    return {
      voice: this.buildVoiceBrief(),
      computer: this.buildComputerBrief(),
      raw: {
        openclawMemory: this.openclawMemory,
        pinnedFiles: this.pinnedFiles,
        customNotes: this.customNotes,
      },
    };
  }

  // ── Memory Search (for recall_context tool) ──

  /** Get the raw OpenClaw memory text (for full delegation to OpenClaw) */
  getRawMemory(): string | null {
    return this.openclawMemory;
  }

  /**
   * Search OpenClaw's MEMORY.md locally by keywords.
   * Returns relevant sections (fast, <100ms, no external call).
   * Used by the recall_context tool's "quick" path.
   */
  searchMemory(query: string): string {
    if (!this.openclawMemory) return "";

    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return "";

    const lines = this.openclawMemory.split("\n");
    const scoredSections: Array<{ heading: string; content: string; score: number }> = [];

    let currentHeading = "";
    let currentLines: string[] = [];

    const flushSection = () => {
      if (currentLines.length === 0) return;
      const content = currentLines.join("\n");
      const lower = (currentHeading + " " + content).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        // Count occurrences of each keyword
        const matches = lower.split(kw).length - 1;
        score += matches;
      }
      if (score > 0) {
        scoredSections.push({ heading: currentHeading, content, score });
      }
    };

    for (const line of lines) {
      if (line.match(/^#{1,3}\s/)) {
        flushSection();
        currentHeading = line;
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    flushSection();

    // Sort by relevance, take top 3 sections
    scoredSections.sort((a, b) => b.score - a.score);
    const topSections = scoredSections.slice(0, 3);

    if (topSections.length === 0) return "";

    return topSections
      .map((s) => `${s.heading}\n${s.content.slice(0, 1500)}`)
      .join("\n\n");
  }

  /**
   * Short brief for Voice AI system prompt.
   * Includes: user profile, active projects, recent work, pinned files.
   */
  private buildVoiceBrief(): string {
    const parts: string[] = [];

    if (this.openclawMemory) {
      const lines = this.openclawMemory.split("\n");
      // Extract key sections — broader than before to give Voice more context
      const userSection = this.extractSection(lines, "About", 15);
      const workSection = this.extractSection(lines, "Current Work", 15);
      const projectsSection = this.extractSection(lines, "Active Projects", 20) ||
                              this.extractSection(lines, "Projects", 20);
      const recentSection = this.extractSection(lines, "Recent", 10);
      if (userSection) parts.push(`User profile:\n${userSection}`);
      if (projectsSection) parts.push(`Active projects:\n${projectsSection}`);
      if (workSection) parts.push(`Current work:\n${workSection}`);
      if (recentSection) parts.push(`Recent activity:\n${recentSection}`);
    }

    // Custom notes
    if (this.customNotes.length > 0) {
      parts.push(`Session notes:\n${this.customNotes.map((n) => `- ${n}`).join("\n")}`);
    }

    // Pinned files — summaries only for Voice (too token-heavy for full content)
    if (this.pinnedFiles.length > 0) {
      const fileSummaries = this.pinnedFiles.map((f) => {
        const name = f.path.split("/").pop() || f.path;
        if (f.summary) return `- ${name}: ${f.summary}`;
        const firstLine = f.content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || "";
        return `- ${name}: ${firstLine.slice(0, 100)}`;
      });
      parts.push(`Pinned reference files:\n${fileSummaries.join("\n")}`);
    }

    let brief = parts.join("\n\n");
    if (brief.length > MAX_VOICE_BRIEF_CHARS) {
      brief = brief.slice(0, MAX_VOICE_BRIEF_CHARS) + "\n...(context truncated)";
    }
    return brief;
  }

  /**
   * Full brief for ComputerUse system prompt.
   * Includes: user profile, pinned file contents, notes, file paths.
   */
  private buildComputerBrief(): string {
    const parts: string[] = [];

    // OpenClaw memory — more generous inclusion
    if (this.openclawMemory) {
      const lines = this.openclawMemory.split("\n");
      const userSection = this.extractSection(lines, "About", 20);
      const workSection = this.extractSection(lines, "Current Work", 20);
      const infraSection = this.extractSection(lines, "Infrastructure", 15);
      if (userSection) parts.push(`## User Profile\n${userSection}`);
      if (workSection) parts.push(`## Current Work\n${workSection}`);
      if (infraSection) parts.push(`## Infrastructure\n${infraSection}`);
    }

    // Custom notes
    if (this.customNotes.length > 0) {
      parts.push(`## Session Notes\n${this.customNotes.map((n) => `- ${n}`).join("\n")}`);
    }

    // Pinned files — include actual content for ComputerUse
    if (this.pinnedFiles.length > 0) {
      parts.push("## Pinned Files");
      for (const f of this.pinnedFiles) {
        const name = f.path.split("/").pop() || f.path;
        parts.push(`### ${name}\nPath: ${f.path}\n${f.summary ? `Summary: ${f.summary}\n` : ""}Content:\n${f.content}`);
      }
    }

    let brief = parts.join("\n\n");
    if (brief.length > MAX_COMPUTER_BRIEF_CHARS) {
      brief = brief.slice(0, MAX_COMPUTER_BRIEF_CHARS) + "\n...(context truncated)";
    }
    return brief;
  }

  /** Extract a markdown section by heading keyword, up to maxLines */
  private extractSection(lines: string[], headingKeyword: string, maxLines: number): string | null {
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^#+\s/) && lines[i].toLowerCase().includes(headingKeyword.toLowerCase())) {
        start = i + 1;
        break;
      }
    }
    if (start === -1) return null;

    const result: string[] = [];
    for (let i = start; i < lines.length && result.length < maxLines; i++) {
      // Stop at next same-or-higher-level heading
      if (i > start && lines[i].match(/^#{1,2}\s/)) break;
      result.push(lines[i]);
    }
    return result.join("\n").trim() || null;
  }

  // ── Status ──

  getStatus() {
    return {
      openclawMemory: this.openclawMemory ? {
        loaded: true,
        chars: this.openclawMemory.length,
        loadedAt: this._lastLoadedAt,
      } : { loaded: false },
      pinnedFiles: this.getPinnedFiles(),
      customNotes: this.customNotes,
      briefLengths: {
        voice: this.buildVoiceBrief().length,
        computer: this.buildComputerBrief().length,
      },
    };
  }

  /** Reset all context */
  reset() {
    this.openclawMemory = null;
    this.pinnedFiles = [];
    this.customNotes = [];
    this._lastLoadedAt = 0;
  }
}
