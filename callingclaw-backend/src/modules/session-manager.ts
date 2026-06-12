// CallingClaw 2.0 — SessionManager
// ═══════════════════════════════════════════════════════════════════
// Single entry point for ALL meeting session mutations.
// Replaces scattered upsertSession/generateMeetingId calls.
//
// Guarantees:
//   - Deduplication by meetUrl or calendarEventId
//   - Status transition validation (preparing→ready→active→ended)
//   - Atomic file + session updates (files field MERGED, not overwritten)
//   - EventBus emission on every state change
// ═══════════════════════════════════════════════════════════════════

import { SHARED_DIR } from "../config";
import type { EventBus } from "./event-bus";
import { readFileSync, appendFileSync } from "fs";
import { resolve } from "path";

// ── Status Enum ──

export const SESSION_STATUS = {
  PREPARING: "preparing",
  READY: "ready",
  ACTIVE: "active",
  ENDED: "ended",
} as const;

export type SessionStatus = typeof SESSION_STATUS[keyof typeof SESSION_STATUS];

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  preparing: ["ready", "active", "ended"],
  ready: ["active", "ended"],
  active: ["ended"],
  ended: [],
};

// ── File Suffixes (shared with OpenClaw convention) ──

export const FILE_SUFFIXES = {
  prep: "_prep.md",
  live: "_live.md",
  summary: "_summary.md",
  transcript: "_transcript.md",
} as const;

export type FileType = keyof typeof FILE_SUFFIXES;

// ── Data Model ──

export interface MeetingSession {
  meetingId: string;
  topic: string;
  meetUrl?: string;
  startTime?: string;
  endTime?: string;
  calendarEventId?: string;
  status: SessionStatus;
  files: {
    prep?: string;
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

// ── SessionManager ──

const SESSIONS_PATH = resolve(SHARED_DIR, "sessions.json");
const MAX_SESSIONS = 50;

function isoNow(): string { return new Date().toISOString(); }

/** Fuzzy topic similarity: containment check + word overlap + bigram Jaccard.
 *  Returns 0.0–1.0. Use threshold > 0.3 for prep-to-meeting matching.
 *  Handles CJK characters natively via bigram scoring. */
export function topicSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, "").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  // Containment: one topic is a substring of the other
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  // Word overlap
  const wa = new Set(na.split(/\s+/).filter(w => w.length > 1));
  const wb = new Set(nb.split(/\s+/).filter(w => w.length > 1));
  if (wa.size > 0 && wb.size > 0) {
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    const overlap = shared / Math.max(wa.size, wb.size);
    if (overlap > 0.5) return 0.4 + overlap * 0.4;
  }
  // Bigram Jaccard (handles CJK)
  const ba = new Set<string>(), bb = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) ba.add(na.slice(i, i + 2));
  for (let i = 0; i < nb.length - 1; i++) bb.add(nb.slice(i, i + 2));
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  const union = new Set([...ba, ...bb]).size;
  return union === 0 ? 0 : inter / union;
}

export class SessionManager {
  private eventBus: EventBus;
  private _dbSyncFn: ((session: MeetingSession) => void) | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /** Register MeetingDB sync callback (called once at startup) */
  setDBSync(fn: (session: MeetingSession) => void): void {
    this._dbSyncFn = fn;
  }

  // ── ID Generation ──

  generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `cc_${ts}_${rand}`;
  }

  // ── Create / Find ──

  /** Create a new session. Always generates a new meetingId. */
  create(opts: {
    topic: string;
    meetUrl?: string;
    startTime?: string;
    endTime?: string;
    calendarEventId?: string;
    status?: SessionStatus;
  }): MeetingSession {
    const meetingId = this.generateId();
    const session: MeetingSession = {
      meetingId,
      topic: opts.topic,
      status: opts.status || SESSION_STATUS.PREPARING,
      files: {},
      createdAt: isoNow(),
      updatedAt: isoNow(),
      ...(opts.meetUrl ? { meetUrl: opts.meetUrl } : {}),
      ...(opts.startTime ? { startTime: opts.startTime } : {}),
      ...(opts.endTime ? { endTime: opts.endTime } : {}),
      ...(opts.calendarEventId ? { calendarEventId: opts.calendarEventId } : {}),
    };

    const index = this._read();
    index.sessions.unshift(session);
    this._trimAndSave(index);
    this._syncDB(session);

    console.log(`[SessionManager] Created: ${meetingId} (${opts.topic.slice(0, 40)}, ${session.status})`);
    return session;
  }

  /** Find existing non-ended session by meetUrl OR calendarEventId, or create new. */
  findOrCreate(opts: {
    topic: string;
    meetUrl?: string;
    calendarEventId?: string;
    startTime?: string;
  }): MeetingSession {
    const existing = this._findExisting(opts.meetUrl, opts.calendarEventId, opts.topic);
    if (existing) {
      // Adopt meetUrl if the matched session doesn't have one (bridges prepare → join gap)
      if (opts.meetUrl && !existing.meetUrl) {
        console.log(`[SessionManager] Adopting meetUrl for prep session: ${existing.meetingId} → ${opts.meetUrl}`);
        const index = this._read();
        const s = index.sessions.find(s => s.meetingId === existing.meetingId);
        if (s) {
          s.meetUrl = opts.meetUrl;
          s.updatedAt = isoNow();
          this._save(index);
          this._syncDB(s);
        }
        existing.meetUrl = opts.meetUrl;
      }
      // Update stale "Meeting" topic if we now have a better one
      const hasRealTopic = opts.topic && opts.topic !== "Meeting" && !opts.topic.startsWith("Meeting at ");
      const hasStaleGenericTopic = existing.topic === "Meeting" || existing.topic.startsWith("Meeting at ");
      if (hasRealTopic && hasStaleGenericTopic) {
        console.log(`[SessionManager] Updating stale topic: "${existing.topic}" → "${opts.topic.slice(0, 40)}"`);
        // Mutate within a fresh read of the index — mutating `existing` and
        // then saving a separate _read() silently discarded the update
        existing.topic = opts.topic;
        const index = this._read();
        const stored = index.sessions.find(s => s.meetingId === existing.meetingId);
        if (stored) {
          stored.topic = opts.topic;
          stored.updatedAt = isoNow();
          this._save(index);
          this._syncDB(stored);
        }
      }
      console.log(`[SessionManager] Found existing: ${existing.meetingId} for ${(existing.topic || opts.topic).slice(0, 40)}`);
      return existing;
    }
    return this.create(opts);
  }

  /** Find session by meetUrl (non-ended only) */
  findByMeetUrl(url: string): MeetingSession | null {
    return this._read().sessions.find(s =>
      s.status !== SESSION_STATUS.ENDED && s.meetUrl === url
    ) || null;
  }

  /** Find session by calendarEventId (non-ended only) */
  findByCalendarEventId(id: string): MeetingSession | null {
    return this._read().sessions.find(s =>
      s.status !== SESSION_STATUS.ENDED && s.calendarEventId === id
    ) || null;
  }

  /** Find session by meetingId (any status) */
  get(meetingId: string): MeetingSession | null {
    return this._read().sessions.find(s => s.meetingId === meetingId) || null;
  }

  // ── Status Transitions ──

  /** Transition to "ready" (typically after prep/calendar creation) */
  markReady(meetingId: string, opts?: {
    topic?: string; meetUrl?: string; startTime?: string; endTime?: string; calendarEventId?: string;
  }): MeetingSession {
    return this._transition(meetingId, SESSION_STATUS.READY, opts);
  }

  /** Transition to "active" (meeting joined / recording started) */
  markActive(meetingId: string, opts?: {
    topic?: string; meetUrl?: string;
  }): MeetingSession {
    return this._transition(meetingId, SESSION_STATUS.ACTIVE, opts);
  }

  /** Transition to "ended" (meeting over) */
  markEnded(meetingId: string): MeetingSession {
    return this._transition(meetingId, SESSION_STATUS.ENDED);
  }

  // ── Atomic File + Session Updates ──

  /** Write prep markdown to disk AND merge files.prep into session. Transitions to "ready". */
  async attachPrep(meetingId: string, content: string, topic?: string): Promise<string> {
    const filename = meetingId + FILE_SUFFIXES.prep;
    const filePath = resolve(SHARED_DIR, filename);
    // Guard: don't overwrite existing non-empty prep (recovery retry race condition)
    try {
      const existing = Bun.file(filePath);
      // .size is a property, not a method — calling it threw and the catch
      // below silently disabled this overwrite guard entirely
      if (await existing.exists() && existing.size > 100) {
        console.log(`[SessionManager] Prep already exists, skipping overwrite: ${meetingId}`);
        this._mergeFile(meetingId, "prep", filename);
        const session = this.get(meetingId);
        if (session && session.status === SESSION_STATUS.PREPARING) {
          this._transition(meetingId, SESSION_STATUS.READY, topic ? { topic } : undefined);
        }
        return filePath;
      }
    } catch { /* proceed to write */ }
    await Bun.write(filePath, content);
    this._mergeFile(meetingId, "prep", filename);
    // Auto-transition to ready if still preparing
    const session = this.get(meetingId);
    if (session && session.status === SESSION_STATUS.PREPARING) {
      this._transition(meetingId, SESSION_STATUS.READY, topic ? { topic } : undefined);
    }
    console.log(`[SessionManager] Prep attached: ${meetingId} → ${filename}`);
    return filePath;
  }

  /** Create live log file AND merge files.live into session. Does NOT change status. */
  async attachLiveLog(meetingId: string, topic?: string): Promise<string> {
    const filename = meetingId + FILE_SUFFIXES.live;
    const filePath = resolve(SHARED_DIR, filename);
    const t = topic || this.get(meetingId)?.topic || "Meeting";
    const header = `# Live Meeting Log: ${t}\n\n**Started:** ${new Date().toLocaleString()}\n\n---\n\n`;
    await Bun.write(filePath, header);
    this._mergeFile(meetingId, "live", filename);
    console.log(`[SessionManager] Live log attached: ${meetingId}`);
    return filePath;
  }

  /** Append entry to live log file (sync for minimal latency). */
  appendToLiveLog(meetingId: string, filePath: string, entry: string): void {
    try {
      const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      appendFileSync(filePath, `[${timestamp}] ${entry}\n`);
      this.eventBus.emit("meeting.live_entry", { meetingId, entry, timestamp });
    } catch (e: any) {
      console.warn(`[SessionManager] Failed to append live log: ${e.message}`);
    }
  }

  /** Close live log file with footer. Does NOT change status (caller does markEnded). */
  async closeLiveLog(meetingId: string, filePath: string): Promise<void> {
    try {
      appendFileSync(filePath, `\n---\n\n**Ended:** ${new Date().toLocaleString()}\n`);
    } catch {}
    console.log(`[SessionManager] Live log closed: ${meetingId}`);
  }

  /** Write summary markdown to disk AND merge files.summary into session. */
  async attachSummary(meetingId: string, content: string): Promise<string> {
    const filename = meetingId + FILE_SUFFIXES.summary;
    const filePath = resolve(SHARED_DIR, filename);
    await Bun.write(filePath, content);
    this._mergeFile(meetingId, "summary", filename);
    console.log(`[SessionManager] Summary attached: ${meetingId} → ${filename}`);
    return filePath;
  }

  /** Register an externally-written file (e.g., OpenClaw wrote prep to disk). */
  registerFile(meetingId: string, type: FileType, filename: string): void {
    this._mergeFile(meetingId, type, filename);
    console.log(`[SessionManager] File registered: ${meetingId} [${type}] → ${filename}`);
  }

  // ── Field Updates ──

  /** Update metadata fields without changing status. */
  update(meetingId: string, fields: Partial<Pick<MeetingSession, "topic" | "meetUrl" | "startTime" | "endTime" | "calendarEventId">>): MeetingSession {
    const index = this._read();
    const session = index.sessions.find(s => s.meetingId === meetingId);
    if (!session) {
      console.warn(`[SessionManager] update: session ${meetingId} not found`);
      return this.create({ topic: fields.topic || "Meeting", ...fields });
    }
    if (fields.topic !== undefined) session.topic = fields.topic;
    if (fields.meetUrl !== undefined) session.meetUrl = fields.meetUrl;
    if (fields.startTime !== undefined) session.startTime = fields.startTime;
    if (fields.endTime !== undefined) session.endTime = fields.endTime;
    if (fields.calendarEventId !== undefined) session.calendarEventId = fields.calendarEventId;
    session.updatedAt = isoNow();
    this._save(index);
    this._syncDB(session);
    return session;
  }

  // ── Delete / Query ──

  /** Delete a session by meetingId. Returns true if found and deleted. */
  delete(meetingId: string): boolean {
    const index = this._read();
    const before = index.sessions.length;
    index.sessions = index.sessions.filter(s => s.meetingId !== meetingId);
    if (index.sessions.length < before) {
      this._save(index);
      console.log(`[SessionManager] Deleted: ${meetingId}`);
      return true;
    }
    return false;
  }

  /** List sessions, optionally filtered by status. */
  list(filter?: { status?: SessionStatus }): MeetingSession[] {
    const sessions = this._read().sessions;
    if (filter?.status) return sessions.filter(s => s.status === filter.status);
    return sessions;
  }

  /** Get manifest format for /api/shared/manifest (compatible with frontend). */
  getManifest(): SessionsIndex {
    return this._read();
  }

  // ── Internal ──

  private _findExisting(meetUrl?: string, calendarEventId?: string, topic?: string): MeetingSession | null {
    const sessions = this._read().sessions;
    // Primary: match by meetUrl or calendarEventId (strongest identifiers)
    const byKey = sessions.find(s =>
      s.status !== SESSION_STATUS.ENDED && (
        (meetUrl && s.meetUrl && s.meetUrl === meetUrl) ||
        (calendarEventId && s.calendarEventId && s.calendarEventId === calendarEventId)
      )
    );
    if (byKey) return byKey;

    // Tier 3: exact topic match for sessions without meetUrl/calendarEventId
    // Prevents duplicate sessions from delegate API and talk-locally
    if (topic && topic !== "Meeting" && !topic.startsWith("Meeting at ")) {
      const exactTopic = sessions.find(s =>
        s.status !== SESSION_STATUS.ENDED &&
        !s.meetUrl && !s.calendarEventId &&
        s.topic === topic
      );
      if (exactTopic) return exactTopic;
    }

    // Tier 4: fuzzy topic match for recent prep sessions (OAuth-down resilience)
    // Only when caller provides a meetUrl (join flow), not during prepare-only calls.
    // Matches prep sessions that have files.prep, are preparing/ready, and < 2h old.
    if (meetUrl && topic && topic !== "Meeting" && !topic.startsWith("Meeting at ")) {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const prepSessions = sessions.filter(s =>
        s.status !== SESSION_STATUS.ENDED &&
        (s.status === SESSION_STATUS.PREPARING || s.status === SESSION_STATUS.READY) &&
        s.files?.prep &&
        s.createdAt > twoHoursAgo
      );
      if (prepSessions.length > 0) {
        const scored = prepSessions
          .map(s => ({ session: s, score: topicSimilarity(topic, s.topic) }))
          .filter(x => x.score > 0.3)
          .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {
          console.log(`[SessionManager] Fuzzy topic match: "${topic.slice(0, 40)}" ↔ "${scored[0].session.topic.slice(0, 40)}" (score=${scored[0].score.toFixed(2)})`);
          return scored[0].session;
        }
      }
    }

    return null;
  }

  private _transition(meetingId: string, target: SessionStatus, fields?: Record<string, any>): MeetingSession {
    const index = this._read();
    let session = index.sessions.find(s => s.meetingId === meetingId);
    if (!session) {
      console.warn(`[SessionManager] transition ${target}: session ${meetingId} not found, creating`);
      session = {
        meetingId, topic: (fields as any)?.topic || "Meeting",
        status: target, files: {}, createdAt: isoNow(), updatedAt: isoNow(),
      };
      index.sessions.unshift(session);
    } else {
      const valid = VALID_TRANSITIONS[session.status];
      if (!valid.includes(target)) {
        console.warn(`[SessionManager] Invalid transition: ${session.status} → ${target} (${meetingId}), allowing anyway`);
      }
      session.status = target;
    }
    // Apply optional field updates
    if (fields) {
      if ((fields as any).topic) session.topic = (fields as any).topic;
      if ((fields as any).meetUrl) session.meetUrl = (fields as any).meetUrl;
      if ((fields as any).startTime) session.startTime = (fields as any).startTime;
      if ((fields as any).endTime) session.endTime = (fields as any).endTime;
      if ((fields as any).calendarEventId) session.calendarEventId = (fields as any).calendarEventId;
    }
    session.updatedAt = isoNow();
    this._trimAndSave(index);
    this._syncDB(session);
    return session;
  }

  /** Merge a file reference into session.files (does NOT overwrite other file types). */
  private _mergeFile(meetingId: string, type: FileType, filename: string): void {
    const index = this._read();
    const session = index.sessions.find(s => s.meetingId === meetingId);
    if (!session) {
      console.warn(`[SessionManager] _mergeFile: session ${meetingId} not found`);
      return;
    }
    session.files = { ...session.files, [type]: filename };
    session.updatedAt = isoNow();
    this._save(index);
    this._syncDB(session);
  }

  private _read(): SessionsIndex {
    try {
      return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
    } catch {
      return { lastUpdated: isoNow(), sharedDir: SHARED_DIR, sessions: [] };
    }
  }

  private _save(index: SessionsIndex): void {
    index.lastUpdated = isoNow();
    index.sharedDir = SHARED_DIR;
    Bun.write(SESSIONS_PATH, JSON.stringify(index, null, 2)).catch(() => {});
  }

  private _trimAndSave(index: SessionsIndex): void {
    if (index.sessions.length > MAX_SESSIONS) {
      index.sessions = index.sessions.slice(0, MAX_SESSIONS);
    }
    this._save(index);
  }

  private _syncDB(session: MeetingSession): void {
    if (this._dbSyncFn) {
      try { this._dbSyncFn(session); } catch {}
    }
  }
}
