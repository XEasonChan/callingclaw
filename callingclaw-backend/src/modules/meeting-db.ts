// CallingClaw 2.0 — Meeting Database (SQLite)
//
// Replaces sessions.json with a proper database for meeting metadata.
// Markdown files stay on disk for AI agents to read — DB stores metadata only.
//
// Schema:
//   meetings: id, topic, start_time, end_time, status, calendar_id, meet_url, created_at
//   meeting_files: meeting_id, type (prep|notes|summary|live|transcript), path, created_at
//
// Migration: on first run, imports existing files from ~/.callingclaw/shared/

import { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = resolve(process.env.HOME || "~", ".callingclaw", "callingclaw.db");
const SHARED_DIR = resolve(process.env.HOME || "~", ".callingclaw", "shared");

export interface Meeting {
  id: string;
  topic: string;
  start_time: string | null;
  end_time: string | null;
  status: string; // preparing | ready | active | ended
  calendar_id: string | null;
  meet_url: string | null;
  created_at: string;
}

export interface MeetingFile {
  meeting_id: string;
  type: string; // prep | notes | summary | live | transcript
  path: string;
  title: string | null;
  created_at: string;
}

export class MeetingDB {
  private db: Database;

  constructor() {
    this.db = new Database(DB_PATH, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this._migrate();
  }

  // ── Schema ──

  private _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        calendar_id TEXT,
        meet_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(meeting_id, type, path)
      );

      CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
      CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
      CREATE INDEX IF NOT EXISTS idx_files_meeting ON meeting_files(meeting_id);
    `);

    // Import legacy data on first run
    const count = this.db.query("SELECT COUNT(*) as c FROM meetings").get() as any;
    if (count.c === 0) {
      console.log("[MeetingDB] Empty database — running legacy import...");
      this._importLegacy();
    }
  }

  // ── Legacy Import ──

  private _importLegacy() {
    let imported = 0;

    // 1. Import from sessions.json (meetingId-based sessions)
    const sessionsPath = resolve(SHARED_DIR, "sessions.json");
    if (existsSync(sessionsPath)) {
      try {
        const data = JSON.parse(require("fs").readFileSync(sessionsPath, "utf-8"));
        const sessions = data.sessions || [];
        for (const s of sessions) {
          this._upsertMeeting({
            id: s.meetingId,
            topic: s.topic || "Untitled",
            start_time: s.startTime || s.createdAt || null,
            end_time: s.endTime || null,
            status: s.status === "active" ? "ended" : s.status, // old "active" sessions are actually ended
            calendar_id: s.calendarEventId || null,
            meet_url: s.meetUrl || null,
            created_at: s.createdAt || new Date().toISOString(),
          });
          // Link any existing files
          if (s.files?.prep) this._addFile(s.meetingId, "prep", resolve(SHARED_DIR, s.files.prep));
          if (s.files?.live) this._addFile(s.meetingId, "live", resolve(SHARED_DIR, s.files.live));
          if (s.files?.summary) this._addFile(s.meetingId, "summary", resolve(SHARED_DIR, s.files.summary));
          if (s.files?.transcript) this._addFile(s.meetingId, "transcript", resolve(SHARED_DIR, s.files.transcript));
          imported++;
        }
        console.log(`[MeetingDB] Imported ${imported} sessions from sessions.json`);
      } catch (e: any) {
        console.warn("[MeetingDB] Failed to import sessions.json:", e.message);
      }
    }

    // 2. Import root prep files (cc_*_prep.md)
    try {
      const rootFiles = readdirSync(SHARED_DIR).filter(f => f.match(/^cc_.*_prep\.md$/));
      for (const f of rootFiles) {
        const meetingId = f.replace(/_prep\.md$/, "");
        const fullPath = resolve(SHARED_DIR, f);
        // Ensure meeting exists
        const existing = this.getMeeting(meetingId);
        if (existing) {
          this._addFile(meetingId, "prep", fullPath);
        }
      }
    } catch {}

    // 3. Import notes/ directory (date-based files → create meetings from filenames)
    const notesDir = resolve(SHARED_DIR, "notes");
    if (existsSync(notesDir)) {
      try {
        const noteFiles = readdirSync(notesDir).filter(f => f.endsWith(".md")).sort();
        for (const f of noteFiles) {
          // Parse filename: 2026-03-17_1705_Project Standards and Expectations Meeting.md
          const match = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})_(.+)\.md$/);
          if (!match) continue;
          const [, date, time, title] = match;
          const startTime = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00`;
          const meetingId = `legacy_${date}_${time}`;
          const fullPath = resolve(notesDir, f);

          // Check if this note is already linked to a session (by time proximity)
          const alreadyLinked = this._isFileLinked(fullPath);
          if (alreadyLinked) continue;

          // Create a meeting entry
          this._upsertMeeting({
            id: meetingId,
            topic: title.replace(/_/g, " "),
            start_time: startTime,
            end_time: null,
            status: "ended",
            calendar_id: null,
            meet_url: null,
            created_at: startTime,
          });
          this._addFile(meetingId, "notes", fullPath, title.replace(/_/g, " "));
          imported++;
        }
        console.log(`[MeetingDB] Imported ${noteFiles.length} note files from notes/`);
      } catch (e: any) {
        console.warn("[MeetingDB] Failed to import notes:", e.message);
      }
    }

    // 4. Import prep/ directory (date-based files)
    const prepDir = resolve(SHARED_DIR, "prep");
    if (existsSync(prepDir)) {
      try {
        const prepFiles = readdirSync(prepDir).filter(f => f.endsWith(".md")).sort();
        for (const f of prepFiles) {
          const match = f.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.md$/);
          if (!match) continue;
          const [, date, title] = match;
          const fullPath = resolve(prepDir, f);

          // Try to match to an existing meeting by date + topic similarity
          const meetings = this._getMeetingsByDate(date);
          if (meetings.length > 0) {
            // Link to first meeting on that date (best effort)
            this._addFile(meetings[0].id, "prep", fullPath, title);
          }
        }
        console.log(`[MeetingDB] Linked ${prepFiles.length} prep files from prep/`);
      } catch (e: any) {
        console.warn("[MeetingDB] Failed to import prep:", e.message);
      }
    }

    // 5. Try to match sessions to notes by timestamp proximity
    this._matchSessionsToNotes();

    console.log(`[MeetingDB] Legacy import complete: ${this.stats().totalMeetings} meetings, ${this.stats().totalFiles} files`);
  }

  /** Try to match meetingId-based sessions (no files) to date-based notes by createdAt proximity */
  private _matchSessionsToNotes() {
    const unlinked = this.db.query(
      `SELECT m.id, m.topic, m.created_at FROM meetings m
       WHERE m.id LIKE 'cc_%'
       AND NOT EXISTS (SELECT 1 FROM meeting_files f WHERE f.meeting_id = m.id AND f.type = 'notes')
       ORDER BY m.created_at`
    ).all() as any[];

    const notesDir = resolve(SHARED_DIR, "notes");
    if (!existsSync(notesDir)) return;
    const noteFiles = readdirSync(notesDir).filter(f => f.endsWith(".md")).sort();

    for (const session of unlinked) {
      const sessionTime = new Date(session.created_at).getTime();
      // Find closest note file within 30 minutes
      let bestMatch: string | null = null;
      let bestDiff = 30 * 60 * 1000; // 30 min max

      for (const f of noteFiles) {
        const match = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})_/);
        if (!match) continue;
        const [, date, time] = match;
        const noteTime = new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00`).getTime();
        const diff = Math.abs(sessionTime - noteTime);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestMatch = f;
        }
      }

      if (bestMatch) {
        const fullPath = resolve(notesDir, bestMatch);
        if (!this._isFileLinked(fullPath)) {
          this._addFile(session.id, "notes", fullPath);
          // Also update start_time from filename if missing
          const tm = bestMatch.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})_/);
          if (tm) {
            const startTime = `${tm[1]}T${tm[2].slice(0, 2)}:${tm[2].slice(2)}:00`;
            this.db.query("UPDATE meetings SET start_time = ? WHERE id = ? AND start_time IS NULL")
              .run(startTime, session.id);
          }
        }
      }
    }
  }

  // ── CRUD ──

  private _upsertMeeting(m: Meeting) {
    this.db.query(`
      INSERT INTO meetings (id, topic, start_time, end_time, status, calendar_id, meet_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        topic = excluded.topic,
        start_time = COALESCE(excluded.start_time, meetings.start_time),
        end_time = COALESCE(excluded.end_time, meetings.end_time),
        status = excluded.status,
        calendar_id = COALESCE(excluded.calendar_id, meetings.calendar_id),
        meet_url = COALESCE(excluded.meet_url, meetings.meet_url)
    `).run(m.id, m.topic, m.start_time, m.end_time, m.status, m.calendar_id, m.meet_url, m.created_at);
  }

  private _addFile(meetingId: string, type: string, path: string, title?: string) {
    try {
      this.db.query(`
        INSERT OR IGNORE INTO meeting_files (meeting_id, type, path, title, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(meetingId, type, path, title || null, new Date().toISOString());
    } catch {}
  }

  private _isFileLinked(path: string): boolean {
    const row = this.db.query("SELECT 1 FROM meeting_files WHERE path = ?").get(path);
    return !!row;
  }

  private _getMeetingsByDate(date: string): Meeting[] {
    return this.db.query(
      "SELECT * FROM meetings WHERE start_time LIKE ? OR created_at LIKE ? ORDER BY created_at"
    ).all(`${date}%`, `${date}%`) as Meeting[];
  }

  // ── Public API ──

  /** Create or update a meeting */
  upsert(m: Partial<Meeting> & { id: string; topic: string }) {
    this._upsertMeeting({
      id: m.id,
      topic: m.topic,
      start_time: m.start_time || null,
      end_time: m.end_time || null,
      status: m.status || "active",
      calendar_id: m.calendar_id || null,
      meet_url: m.meet_url || null,
      created_at: m.created_at || new Date().toISOString(),
    });
  }

  /** Add a file to a meeting */
  addFile(meetingId: string, type: string, path: string, title?: string) {
    this._addFile(meetingId, type, path, title);
  }

  /** Update meeting status */
  updateStatus(id: string, status: string) {
    this.db.query("UPDATE meetings SET status = ? WHERE id = ?").run(status, id);
  }

  /** Set meeting end time */
  endMeeting(id: string) {
    this.db.query("UPDATE meetings SET status = 'ended', end_time = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  /** Get a single meeting with its files */
  getMeeting(id: string): (Meeting & { files: MeetingFile[] }) | null {
    const m = this.db.query("SELECT * FROM meetings WHERE id = ?").get(id) as Meeting | null;
    if (!m) return null;
    const files = this.db.query("SELECT * FROM meeting_files WHERE meeting_id = ? ORDER BY created_at")
      .all(id) as MeetingFile[];
    return { ...m, files };
  }

  /** List all meetings, newest first, with files */
  listMeetings(limit = 50): Array<Meeting & { files: MeetingFile[] }> {
    const meetings = this.db.query(
      "SELECT * FROM meetings ORDER BY COALESCE(start_time, created_at) DESC LIMIT ?"
    ).all(limit) as Meeting[];

    return meetings.map(m => {
      const files = this.db.query("SELECT * FROM meeting_files WHERE meeting_id = ? ORDER BY type")
        .all(m.id) as MeetingFile[];
      return { ...m, files };
    });
  }

  /** Delete a meeting and its files from the database */
  delete(meetingId: string) {
    this.db.run("DELETE FROM meeting_files WHERE meeting_id = ?", meetingId);
    this.db.run("DELETE FROM meetings WHERE id = ?", meetingId);
  }

  /** Get meetings as manifest format (compatible with existing frontend) */
  getManifest() {
    const meetings = this.listMeetings(50);
    return {
      lastUpdated: new Date().toISOString(),
      sharedDir: SHARED_DIR,
      sessions: meetings.map(m => ({
        meetingId: m.id,
        topic: m.topic,
        startTime: m.start_time,
        endTime: m.end_time,
        status: m.status,
        calendarEventId: m.calendar_id,
        meetUrl: m.meet_url,
        createdAt: m.created_at,
        files: (() => {
          const dbPrep = m.files.find(f => f.type === "prep")?.path || null;
          const dbNotes = m.files.find(f => f.type === "notes")?.path || null;
          const dbSummary = m.files.find(f => f.type === "summary")?.path || null;
          const dbLive = m.files.find(f => f.type === "live")?.path || null;
          // Fallback: check disk for convention-based files
          const { existsSync } = require("fs");
          const { resolve } = require("path");
          const checkDisk = (suffix: string) => {
            const p = resolve(SHARED_DIR, m.id + suffix);
            return existsSync(p) ? m.id + suffix : null;
          };
          return {
            prep: dbPrep || checkDisk("_prep.md"),
            notes: dbNotes || checkDisk("_notes.md"),
            summary: dbSummary || checkDisk("_summary.md"),
            live: dbLive || checkDisk("_live.md"),
            transcript: null,
          };
        })(),
      })),
    };
  }

  /** Stats for debugging */
  stats() {
    const meetings = this.db.query("SELECT COUNT(*) as c FROM meetings").get() as any;
    const files = this.db.query("SELECT COUNT(*) as c FROM meeting_files").get() as any;
    const withFiles = this.db.query(
      "SELECT COUNT(DISTINCT meeting_id) as c FROM meeting_files"
    ).get() as any;
    return {
      totalMeetings: meetings.c,
      totalFiles: files.c,
      meetingsWithFiles: withFiles.c,
    };
  }

  close() {
    this.db.close();
  }
}
