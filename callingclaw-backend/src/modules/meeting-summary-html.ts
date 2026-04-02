// CallingClaw 2.0 — Module: MeetingSummaryHtml
// ═══════════════════════════════════════════════════════════════════
//
// Generates branded HTML meeting summary after meeting ends.
// Includes: header, summary card, review items (screenshot + action),
// action items table, key transcript, known issues.
//
// Called from callingclaw.ts after generateSummary() + keyFrameStore.finalize().
// Output: {meetingDir}/summary.html
//
// Design: CallingClaw light theme (Space Grotesk, Inter, accent #dc4a3a)
// Reference: public/meeting-summary-20260326.html
// ═══════════════════════════════════════════════════════════════════

import type { MeetingSummary } from "./meeting";
import type { TimelineEntry } from "./key-frame-store";
import type { TranscriptEntry } from "./shared-context";

export interface SummaryHtmlInput {
  summary: MeetingSummary;
  meetingId: string;
  meetingDir: string;
  /** Timeline entries from KeyFrameStore (frames + transcript interleaved) */
  timelineEntries?: TimelineEntry[];
  /** Raw transcript from SharedContext */
  transcript?: TranscriptEntry[];
  /** Start timestamp of the meeting */
  startTs?: number;
  /** End timestamp (defaults to Date.now()) */
  endTs?: number;
  /** CallingClaw version string */
  version?: string;
}

/**
 * Generate a branded HTML meeting summary and write it to disk.
 * Returns the file path of the generated HTML.
 */
export async function generateMeetingSummaryHtml(input: SummaryHtmlInput): Promise<string> {
  const {
    summary,
    meetingId,
    meetingDir,
    timelineEntries = [],
    transcript = [],
    startTs = Date.now(),
    endTs = Date.now(),
    version = "2.0",
  } = input;

  const html = renderHtml(summary, meetingId, timelineEntries, transcript, startTs, endTs, version);
  const htmlPath = `${meetingDir}/summary.html`;

  await Bun.write(htmlPath, html);
  console.log(`[MeetingSummaryHtml] Generated: ${htmlPath}`);

  return htmlPath;
}

// ── Render ──────────────────────────────────────────────────────

function renderHtml(
  summary: MeetingSummary,
  meetingId: string,
  timelineEntries: TimelineEntry[],
  transcript: TranscriptEntry[],
  startTs: number,
  endTs: number,
  version: string,
): string {
  const date = new Date(startTs).toISOString().slice(0, 10);
  const startTime = fmtTime(startTs);
  const endTime = fmtTime(endTs);
  const durationMin = Math.round((endTs - startTs) / 60000);
  const participants = summary.participants?.length > 0
    ? summary.participants.join(", ")
    : "N/A";

  // Build sections
  const summaryCard = renderSummaryCard(summary);
  const reviewItems = renderReviewItems(timelineEntries, meetingId);
  const actionItems = renderActionItems(summary);
  const keyTranscript = renderKeyTranscript(transcript);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meeting Summary — ${esc(summary.title || "Meeting")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #ffffff;
    --bg-subtle: #faf9f9;
    --surface: #ffffff;
    --text: #1f2937;
    --text2: #6b7280;
    --text3: #9ca3af;
    --accent: #dc4a3a;
    --accent-light: #fef2f1;
    --success: #4aa682;
    --success-light: #e6f4ee;
    --warning: #f59e0b;
    --warning-light: #fef3c7;
    --border: #e5e7eb;
    --border-light: #f3f4f6;
    --font-display: "Space Grotesk", system-ui, sans-serif;
    --font-body: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", monospace;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.03);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.04);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.06);
    --radius: 12px;
    --radius-sm: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; scroll-behavior: smooth; }
  body { font-family: var(--font-body); color: var(--text); background: var(--bg); line-height: 1.6; }

  .container { max-width: 960px; margin: 0 auto; padding: 48px 24px; }

  /* Header */
  .header { margin-bottom: 40px; }
  .header-logo { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .header-logo svg { width: 28px; height: 28px; }
  .header-logo span { font-family: var(--font-display); font-weight: 700; font-size: 16px; color: var(--accent); letter-spacing: -0.02em; }
  .header h1 { font-family: var(--font-display); font-size: 32px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; margin-bottom: 12px; }
  .header-meta { display: flex; flex-wrap: wrap; gap: 16px; color: var(--text2); font-size: 14px; }
  .header-meta .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .badge-accent { background: var(--accent-light); color: var(--accent); }
  .badge-success { background: var(--success-light); color: var(--success); }

  /* Section */
  .section { margin-bottom: 40px; }
  .section-title { font-family: var(--font-display); font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

  /* Summary card */
  .summary-card { background: var(--bg-subtle); border: 1px solid var(--border-light); border-radius: var(--radius); padding: 24px; }
  .summary-card p { margin-bottom: 10px; font-size: 15px; }
  .summary-card ul { padding-left: 20px; margin: 8px 0; }
  .summary-card li { margin-bottom: 4px; font-size: 14px; }

  /* Tables */
  .review-table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-sm); }
  .review-table th { background: var(--bg-subtle); font-family: var(--font-display); font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text2); padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); }
  .review-table td { padding: 16px; border-bottom: 1px solid var(--border-light); vertical-align: top; font-size: 14px; }
  .review-table tr:last-child td { border-bottom: none; }
  .review-table .frame-cell { width: 320px; padding: 12px; }
  .review-table .frame-cell img { width: 100%; border-radius: var(--radius-sm); display: block; box-shadow: var(--shadow-sm); }
  .review-table .content-cell { padding: 16px 20px; }
  .review-table .content-cell h4 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .review-table .content-cell p { color: var(--text2); font-size: 14px; line-height: 1.6; }
  .review-table .time-badge { font-family: var(--font-mono); font-size: 12px; color: var(--text3); margin-bottom: 6px; display: block; }
  .priority { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 6px; }
  .p1 { background: var(--accent-light); color: var(--accent); }
  .p2 { background: var(--warning-light); color: #92400e; }
  .p3 { background: var(--border-light); color: var(--text2); }

  /* Transcript */
  .transcript { background: var(--bg-subtle); border: 1px solid var(--border-light); border-radius: var(--radius); padding: 20px; }
  .msg { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-light); }
  .msg:last-child { border-bottom: none; }
  .msg-role { flex-shrink: 0; width: 48px; font-family: var(--font-mono); font-size: 11px; font-weight: 600; text-transform: uppercase; padding-top: 2px; }
  .msg-role.ai { color: var(--accent); }
  .msg-role.user { color: #2563eb; }
  .msg-text { flex: 1; font-size: 14px; }
  .msg-time { flex-shrink: 0; font-family: var(--font-mono); color: var(--text3); font-size: 12px; }

  /* Footer */
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text3); font-size: 12px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="container">

<!-- Header -->
<div class="header">
  <div class="header-logo">
    <svg viewBox="0 0 20 20" fill="none"><path d="M14 5.5C14 5.5 12.5 4 10 4C6.5 4 4 6.69 4 10C4 13.31 6.5 16 10 16C12.5 16 14 14.5 14 14.5" stroke="#dc4a3a" stroke-width="2.2" stroke-linecap="round"/></svg>
    <span>CallingClaw</span>
  </div>
  <h1>${esc(summary.title || "Meeting Summary")}</h1>
  <div class="header-meta">
    <span>${date} &middot; ${startTime} – ${endTime} (${durationMin} min)</span>
    <span>${esc(participants)}</span>
    <span class="badge badge-success">v${esc(version)}</span>
  </div>
</div>

${summaryCard}
${reviewItems}
${actionItems}
${keyTranscript}

<div class="footer">
  <span>Generated by CallingClaw v${esc(version)}</span>
  <span>Meeting ID: ${esc(meetingId)} &middot; ${date}</span>
</div>

</div>
</body>
</html>`;
}

// ── Section Renderers ───────────────────────────────────────────

function renderSummaryCard(summary: MeetingSummary): string {
  const keyPoints = (summary.keyPoints || [])
    .map((p) => `      <li>${esc(p)}</li>`)
    .join("\n");

  const decisions = (summary.decisions || [])
    .map((d) => `      <li>${esc(d)}</li>`)
    .join("\n");

  const followUps = (summary.followUps || [])
    .map((f) => `      <li>${esc(f)}</li>`)
    .join("\n");

  return `
<!-- Summary -->
<div class="section">
  <div class="section-title">Meeting Summary</div>
  <div class="summary-card">
    ${keyPoints ? `<p><strong>Key Points:</strong></p>\n    <ul>\n${keyPoints}\n    </ul>` : ""}
    ${decisions ? `<p><strong>Decisions:</strong></p>\n    <ul>\n${decisions}\n    </ul>` : ""}
    ${followUps ? `<p><strong>Follow-ups:</strong></p>\n    <ul>\n${followUps}\n    </ul>` : ""}
  </div>
</div>`;
}

function renderReviewItems(entries: TimelineEntry[], meetingId: string): string {
  // Pick frames with descriptions or priority=high as review items
  const frames = entries.filter((e) => e.type === "frame" && (e.priority === "high" || e.description));
  if (frames.length === 0) return "";

  const rows = frames.map((f) => {
    const time = fmtTime(f.ts);
    const desc = f.description || f.title || "";
    const priorityCls = f.priority === "high" ? "p1" : "p3";
    const priorityLabel = f.priority === "high" ? "Key" : "Info";

    return `      <tr>
        <td class="frame-cell"><img src="frames/${esc(f.file || "")}" alt="${esc(desc)}" loading="lazy"></td>
        <td class="content-cell">
          <span class="time-badge">${time}</span>
          <h4>${esc(desc || "Screenshot")}</h4>
          <p style="margin-top:8px;"><span class="priority ${priorityCls}">${priorityLabel}</span>${esc(f.url || "")}</p>
        </td>
      </tr>`;
  }).join("\n");

  return `
<!-- Review Items -->
<div class="section">
  <div class="section-title">Review Items</div>
  <table class="review-table">
    <thead>
      <tr><th style="width:320px">Screenshot</th><th>Discussion &amp; Action</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

function renderActionItems(summary: MeetingSummary): string {
  const items = summary.actionItems || [];
  if (items.length === 0) return "";

  const rows = items.map((a, i) => {
    const priority = i === 0 ? "p1" : i < 3 ? "p2" : "p3";
    const label = i === 0 ? "P1" : i < 3 ? "P2" : "P3";
    return `      <tr><td><span class="priority ${priority}">${label}</span></td><td>${esc(a.task)}</td><td>${esc(a.assignee || "TBD")}</td><td>${esc(a.deadline || "TBD")}</td></tr>`;
  }).join("\n");

  return `
<!-- Action Items -->
<div class="section">
  <div class="section-title">Action Items</div>
  <table class="review-table">
    <thead><tr><th style="width:60px">Priority</th><th>Task</th><th style="width:120px">Owner</th><th style="width:100px">Deadline</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

function renderKeyTranscript(transcript: TranscriptEntry[]): string {
  // Filter to user + assistant only, take last 20 meaningful entries
  const conversational = transcript
    .filter((e) => (e.role === "user" || e.role === "assistant") && e.text?.trim().length > 5)
    .slice(-20);

  if (conversational.length === 0) return "";

  const msgs = conversational.map((e) => {
    const roleCls = e.role === "assistant" ? "ai" : "user";
    const roleLabel = e.role === "assistant" ? "AI" : "User";
    const time = fmtTime(e.ts);
    return `    <div class="msg"><span class="msg-role ${roleCls}">${roleLabel}</span><span class="msg-text">${esc(e.text)}</span><span class="msg-time">${time}</span></div>`;
  }).join("\n");

  return `
<!-- Key Transcript -->
<div class="section">
  <div class="section-title">Key Transcript</div>
  <div class="transcript">
${msgs}
  </div>
</div>`;
}

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }).slice(0, 5);
}
