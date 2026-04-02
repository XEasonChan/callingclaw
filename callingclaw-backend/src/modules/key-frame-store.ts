// CallingClaw 2.0 — KeyFrameStore: Meeting Screenshot Persistence
// ═══════════════════════════════════════════════════════════════════
//
// Saves all CDP frames (1s interval, deduped) as low-res JPEG during meetings.
// Generates timeline.jsonl (structured) + timeline.md (human-readable) + timeline.html (shareable).
// Post-meeting: OC-010 sends folder path → OpenClaw reads images + correlates with transcript.
//
// Architecture:
//   BrowserCapture (CDP) ──→ KeyFrameStore.saveFrame(image, metadata)
//                                 │
//                                 ├── Jaccard image dedup (skip identical frames)
//                                 ├── sips resize async (640x400, quality 40)
//                                 ├── Write {ts}.jpg to frames/
//                                 └── Append to timeline.jsonl
//
//   SharedContext transcript ──→ KeyFrameStore.saveTranscript(entry)
//                                 └── Append to timeline.jsonl
//
//   Meeting end ──→ KeyFrameStore.finalize()
//                       ├── Generate timeline.md (merge frames + transcript)
//                       ├── Generate timeline.html (shareable viewer)
//                       └── Return { meetingDir, frameCount, ... } for OC-010
//
// See CONTEXT-ENGINEERING.md + project_multimodal_timeline.md for design rationale.
// ═══════════════════════════════════════════════════════════════════

import type { TranscriptEntry } from "./shared-context";

// ── Config ──

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 400;
const JPEG_QUALITY = 40;
const DEDUP_THRESHOLD = 0.7; // Jaccard similarity > 0.7 = skip
const MAX_AGE_DAYS = 30;     // Auto-cleanup meetings older than 30 days
const BASE_DIR = `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/meetings`;

// ── Types ──

export interface TimelineEntry {
  ts: number;
  type: "frame" | "transcript";
  // Frame fields
  file?: string;
  description?: string;
  url?: string;
  title?: string;
  priority?: "high" | "normal";
  // Transcript fields
  role?: string;
  text?: string;
}

export interface FrameSaveResult {
  saved: boolean;
  path?: string;
  skippedReason?: "dedup" | "error";
}

export interface TimelineSummary {
  meetingId: string;
  meetingDir: string;
  frameCount: number;
  transcriptEntries: number;
  priorityFrameCount: number;
  timelineFile: string;
  htmlFile: string;
  durationMs: number;
}

// ── Priority trigger words (reused from ContextRetriever pattern) ──

const PRIORITY_TRIGGERS_ZH = /这里|这个|改一下|参考|看一下|修改|调整|换成/;
const PRIORITY_TRIGGERS_EN = /look at|this one|change|modify|reference|adjust|fix this|here/i;

// ── Module ──

export class KeyFrameStore {
  private _meetingId: string | null = null;
  private _meetingDir: string | null = null;
  private _framesDir: string | null = null;
  private _startTs = 0;
  private _frameCount = 0;
  private _transcriptCount = 0;
  private _priorityFrameCount = 0;
  private _lastFrameHash = "";  // Simple hash for dedup
  private _timelineEntries: TimelineEntry[] = [];
  private _recentTranscript: string[] = []; // Last 3 transcript texts for priority detection

  get active(): boolean { return this._meetingId !== null; }
  get meetingId(): string | null { return this._meetingId; }
  get meetingDir(): string | null { return this._meetingDir; }
  get frameCount(): number { return this._frameCount; }
  get startTs(): number { return this._startTs; }
  get timelineEntries(): readonly TimelineEntry[] { return this._timelineEntries; }

  // ══════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════

  async start(meetingId: string): Promise<string> {
    this._meetingId = meetingId;
    this._meetingDir = `${BASE_DIR}/${meetingId}`;
    this._framesDir = `${this._meetingDir}/frames`;
    this._startTs = Date.now();
    this._frameCount = 0;
    this._transcriptCount = 0;
    this._priorityFrameCount = 0;
    this._lastFrameHash = "";
    this._timelineEntries = [];
    this._recentTranscript = [];

    // Create directories
    await Bun.$`mkdir -p ${this._framesDir}`.quiet();

    console.log(`[KeyFrameStore] Started for meeting ${meetingId} → ${this._meetingDir}`);

    // Run cleanup of old meetings in background (non-blocking)
    this.cleanup(MAX_AGE_DAYS).catch(() => {});

    return this._meetingDir;
  }

  async stop(): Promise<void> {
    if (!this._meetingId) return;
    console.log(`[KeyFrameStore] Stopped — ${this._frameCount} frames, ${this._transcriptCount} transcript entries`);
    this._meetingId = null;
  }

  // ══════════════════════════════════════════════════════════════
  // Frame Persistence
  // ══════════════════════════════════════════════════════════════

  /**
   * Save a frame to disk. Called on every CDP capture cycle (1s).
   * Skips if identical to previous frame (Jaccard dedup on base64 prefix).
   * Resize is async fire-and-forget (non-blocking).
   */
  async saveFrame(
    base64Image: string,
    metadata?: { url?: string; title?: string; description?: string },
  ): Promise<FrameSaveResult> {
    if (!this._meetingId || !this._framesDir) {
      return { saved: false, skippedReason: "error" };
    }

    // ── Dedup: compare first 2KB of base64 (fast proxy for image similarity) ──
    const hash = base64Image.slice(0, 2048);
    if (this._lastFrameHash && this.jaccard(hash, this._lastFrameHash) > DEDUP_THRESHOLD) {
      return { saved: false, skippedReason: "dedup" };
    }
    this._lastFrameHash = hash;

    const ts = Date.now();
    const filename = `${ts}.jpg`;
    const rawPath = `${this._framesDir}/${ts}_raw.png`;
    const finalPath = `${this._framesDir}/${filename}`;

    try {
      // Write raw PNG to temp file
      await Bun.write(rawPath, Buffer.from(base64Image, "base64"));

      // Async sips resize (fire-and-forget — non-blocking)
      Bun.$`sips --resampleWidth ${FRAME_WIDTH} --setProperty format jpeg --setProperty formatOptions ${JPEG_QUALITY} ${rawPath} --out ${finalPath} && rm -f ${rawPath}`.quiet().catch(() => {
        // Fallback: if sips fails, just rename the raw file
        Bun.$`mv ${rawPath} ${finalPath}`.quiet().catch(() => {});
      });

      this._frameCount++;

      // Check if this frame should be high priority (recent transcript has trigger words)
      const priority = this.detectPriority() ? "high" : "normal";
      if (priority === "high") this._priorityFrameCount++;

      // Append to timeline
      const entry: TimelineEntry = {
        ts,
        type: "frame",
        file: filename,
        description: metadata?.description,
        url: metadata?.url,
        title: metadata?.title,
        priority,
      };
      this._timelineEntries.push(entry);
      this.appendJsonl(entry);

      return { saved: true, path: finalPath };
    } catch (e: any) {
      console.error(`[KeyFrameStore] Frame save error: ${e.message}`);
      return { saved: false, skippedReason: "error" };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Transcript Persistence
  // ══════════════════════════════════════════════════════════════

  /**
   * Record a transcript entry in the timeline.
   * Called from SharedContext.on("transcript") listener.
   */
  saveTranscript(entry: TranscriptEntry): void {
    if (!this._meetingId) return;
    if (entry.role === "system") return; // Skip tool call logs

    const timelineEntry: TimelineEntry = {
      ts: entry.ts,
      type: "transcript",
      role: entry.role,
      text: entry.text,
    };
    this._timelineEntries.push(timelineEntry);
    this._transcriptCount++;
    this.appendJsonl(timelineEntry);

    // Track recent transcript for priority detection
    this._recentTranscript.push(entry.text);
    if (this._recentTranscript.length > 3) this._recentTranscript.shift();
  }

  // ══════════════════════════════════════════════════════════════
  // Finalize: Generate timeline.md + timeline.html
  // ══════════════════════════════════════════════════════════════

  async finalize(topic: string): Promise<TimelineSummary | null> {
    if (!this._meetingId || !this._meetingDir) return null;

    const durationMs = Date.now() - this._startTs;
    const meetingDir = this._meetingDir;

    // Generate timeline.md
    const md = this.generateTimelineMd(topic, durationMs);
    const mdPath = `${meetingDir}/timeline.md`;
    await Bun.write(mdPath, md);

    // Generate timeline.html
    const html = this.generateTimelineHtml(topic, durationMs);
    const htmlPath = `${meetingDir}/timeline.html`;
    await Bun.write(htmlPath, html);

    console.log(`[KeyFrameStore] Finalized: ${this._frameCount} frames, ${this._transcriptCount} transcript, ${this._priorityFrameCount} priority → ${meetingDir}`);

    return {
      meetingId: this._meetingId,
      meetingDir,
      frameCount: this._frameCount,
      transcriptEntries: this._transcriptCount,
      priorityFrameCount: this._priorityFrameCount,
      timelineFile: mdPath,
      htmlFile: htmlPath,
      durationMs,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Timeline Generation
  // ══════════════════════════════════════════════════════════════

  private generateTimelineMd(topic: string, durationMs: number): string {
    const lines: string[] = [];
    const duration = `${Math.round(durationMs / 60000)}min`;
    const date = new Date(this._startTs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

    lines.push(`# Meeting Timeline: ${topic}`);
    lines.push(`Date: ${date} | Duration: ${duration} | Frames: ${this._frameCount} | Priority: ${this._priorityFrameCount}\n`);

    let lastMinute = "";
    for (const entry of this._timelineEntries) {
      const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
      const minute = time.slice(0, 5); // HH:MM

      if (minute !== lastMinute) {
        lines.push(`\n## ${minute}`);
        lastMinute = minute;
      }

      if (entry.type === "transcript") {
        const icon = entry.role === "user" ? "👤" : entry.role === "assistant" ? "🤖" : "📋";
        lines.push(`${icon} [${time}] ${entry.text}`);
      } else if (entry.type === "frame") {
        const priorityTag = entry.priority === "high" ? " ⭐" : "";
        lines.push(`📷 [${time}] frames/${entry.file}${priorityTag} — ${entry.description || entry.title || entry.url || "screenshot"}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  private generateTimelineHtml(topic: string, durationMs: number): string {
    const duration = `${Math.round(durationMs / 60000)}min`;
    const date = new Date(this._startTs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

    let body = "";
    for (const entry of this._timelineEntries) {
      const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

      if (entry.type === "transcript") {
        const cls = entry.role === "user" ? "user" : entry.role === "assistant" ? "ai" : "system";
        body += `<div class="entry ${cls}"><span class="time">${time}</span><span class="text">${this.escapeHtml(entry.text || "")}</span></div>\n`;
      } else if (entry.type === "frame") {
        const priorityCls = entry.priority === "high" ? " priority" : "";
        body += `<div class="entry frame${priorityCls}"><span class="time">${time}</span><img src="frames/${entry.file}" loading="lazy" /><span class="desc">${this.escapeHtml(entry.description || "")}</span></div>\n`;
      }
    }

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meeting Timeline: ${this.escapeHtml(topic)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; color: #1d1d1f; line-height: 1.6; }
  .header { padding: 24px; background: #fff; border-bottom: 1px solid #e5e5e5; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header .meta { font-size: 13px; color: #86868b; margin-top: 4px; }
  .timeline { max-width: 800px; margin: 24px auto; padding: 0 16px; }
  .entry { padding: 8px 0; border-bottom: 1px solid #f0f0f0; display: flex; gap: 12px; align-items: flex-start; }
  .entry.frame { flex-direction: column; }
  .entry.frame img { max-width: 100%; border-radius: 8px; border: 1px solid #e5e5e5; }
  .entry.priority { background: #fffbeb; border-left: 3px solid #f59e0b; padding-left: 12px; }
  .time { font-size: 12px; color: #86868b; font-family: monospace; min-width: 70px; }
  .text { font-size: 14px; }
  .desc { font-size: 12px; color: #86868b; }
  .entry.user .text { font-weight: 500; }
  .entry.ai .text { color: #6e6e73; }
  .stats { padding: 16px 24px; background: #fff; border-top: 1px solid #e5e5e5; font-size: 13px; color: #86868b; text-align: center; }
</style>
</head>
<body>
<div class="header">
  <h1>${this.escapeHtml(topic)}</h1>
  <div class="meta">${date} · ${duration} · ${this._frameCount} frames · ${this._priorityFrameCount} priority</div>
</div>
<div class="timeline">
${body}
</div>
<div class="stats">Generated by CallingClaw · ${this._frameCount} screenshots · ${this._transcriptCount} transcript entries</div>
</body>
</html>`;
  }

  // ══════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════

  /** Append a timeline entry to timeline.jsonl (atomic line) */
  private appendJsonl(entry: TimelineEntry): void {
    if (!this._meetingDir) return;
    const line = JSON.stringify(entry) + "\n";
    const path = `${this._meetingDir}/timeline.jsonl`;
    // Append synchronously to avoid write ordering issues
    try {
      Bun.write(path, line, { mode: "append" } as any).catch(() => {
        // Fallback: use Bun.$ for atomic append
        Bun.$`echo ${line.trim()} >> ${path}`.quiet().catch(() => {});
      });
    } catch {}
  }

  /** Simple Jaccard similarity on character bigrams */
  private jaccard(a: string, b: string): number {
    if (!a || !b) return 0;
    const bigramsA = new Set<string>();
    const bigramsB = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
    for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
    let intersection = 0;
    for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
    const union = new Set([...bigramsA, ...bigramsB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /** Check if recent transcript contains priority trigger words */
  private detectPriority(): boolean {
    const recent = this._recentTranscript.join(" ");
    return PRIORITY_TRIGGERS_ZH.test(recent) || PRIORITY_TRIGGERS_EN.test(recent);
  }

  /** Escape HTML entities */
  private escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Clean up meeting directories older than maxAgeDays */
  async cleanup(maxAgeDays: number): Promise<number> {
    try {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const glob = new Bun.Glob("*");
      const dirs = await Array.fromAsync(glob.scan({ cwd: BASE_DIR, onlyFiles: false }));
      let removed = 0;
      for (const dir of dirs) {
        const fullPath = `${BASE_DIR}/${dir}`;
        try {
          const stat = Bun.file(`${fullPath}/timeline.jsonl`);
          if (await stat.exists()) {
            // Use file modification time as proxy for meeting age
            const mtimeMs = (stat as any).lastModified;
            if (mtimeMs && mtimeMs < cutoff) {
              await Bun.$`rm -rf ${fullPath}`.quiet();
              removed++;
              console.log(`[KeyFrameStore] Cleaned up old meeting: ${dir}`);
            }
          }
        } catch {}
      }
      if (removed > 0) console.log(`[KeyFrameStore] Cleanup: removed ${removed} meetings older than ${maxAgeDays} days`);
      return removed;
    } catch {
      return 0;
    }
  }
}
