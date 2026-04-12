/**
 * Session Prep Resilience — Integration Tests
 *
 * Tests the prepare-then-join flow when Google OAuth is down:
 *   - Prep session created without meetUrl (OAuth unavailable)
 *   - Join arrives with meetUrl → fuzzy topic match → session reused
 *   - meetUrl adopted onto matched session (Fix 2)
 *   - Tier 1 (exact meetUrl) still takes priority over fuzzy match
 *   - Old/expired sessions not matched (2h window)
 *
 * Run: bun test test/modules/session-prep-resilience.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const SHARED_DIR = resolve(homedir(), ".callingclaw", "shared");
const SESSIONS_PATH = resolve(SHARED_DIR, "sessions.json");

// Backup and restore sessions.json around tests
let originalSessions: string | null = null;

function backupSessions() {
  try {
    originalSessions = require("fs").readFileSync(SESSIONS_PATH, "utf-8");
  } catch {
    originalSessions = null;
  }
}

function restoreSessions() {
  if (originalSessions !== null) {
    writeFileSync(SESSIONS_PATH, originalSessions);
  }
}

function writeSessionsJson(sessions: any[]) {
  mkdirSync(SHARED_DIR, { recursive: true });
  writeFileSync(SESSIONS_PATH, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    sharedDir: SHARED_DIR,
    sessions,
  }));
}

function makePrepSession(overrides: Record<string, any> = {}) {
  const meetingId = overrides.meetingId || `cc_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    meetingId,
    topic: overrides.topic || "CoCo Launch Video — Personal Version 讨论",
    status: overrides.status || "ready",
    files: overrides.files || { prep: `${meetingId}_prep.md` },
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    // Deliberately NO meetUrl — simulates OAuth-down scenario
    ...(overrides.meetUrl ? { meetUrl: overrides.meetUrl } : {}),
  };
}

describe("Session Prep Resilience (OAuth-down)", () => {
  // Import SessionManager fresh for each test suite
  let SessionManager: any;

  beforeEach(async () => {
    backupSessions();
    // Dynamic import to get fresh module state
    const mod = await import("../../src/modules/session-manager");
    SessionManager = mod.SessionManager;
  });

  // Note: can't use afterEach in bun:test easily, so we clean up in beforeEach

  test("Tier 4: fuzzy topic match finds prep session without meetUrl", () => {
    const prepSession = makePrepSession({ topic: "CoCo Launch Video — Personal Version 讨论" });
    writeSessionsJson([prepSession]);

    const sm = new SessionManager();
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video",
      meetUrl: "https://meet.google.com/test-test-test",
    });

    expect(result.meetingId).toBe(prepSession.meetingId);
    restoreSessions();
  });

  test("Fix 2: meetUrl adopted onto matched prep session", () => {
    const prepSession = makePrepSession({ topic: "CoCo Launch Video — Personal Version 讨论" });
    writeSessionsJson([prepSession]);

    const sm = new SessionManager();
    const meetUrl = "https://meet.google.com/abc-def-ghi";
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video",
      meetUrl,
    });

    expect(result.meetUrl).toBe(meetUrl);

    // Verify persisted to disk
    const sessions = JSON.parse(require("fs").readFileSync(SESSIONS_PATH, "utf-8")).sessions;
    const persisted = sessions.find((s: any) => s.meetingId === prepSession.meetingId);
    expect(persisted.meetUrl).toBe(meetUrl);
    restoreSessions();
  });

  test("Tier 1 takes priority: exact meetUrl match beats fuzzy topic", () => {
    const meetUrl = "https://meet.google.com/exact-match";
    const exactSession = makePrepSession({
      meetingId: "cc_exact",
      topic: "Unrelated Topic",
      meetUrl,
    });
    const fuzzySession = makePrepSession({
      meetingId: "cc_fuzzy",
      topic: "CoCo Launch Video — Personal Version",
    });
    writeSessionsJson([exactSession, fuzzySession]);

    const sm = new SessionManager();
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video",
      meetUrl,
    });

    // Should match by meetUrl (Tier 1), not by topic (Tier 4)
    expect(result.meetingId).toBe("cc_exact");
    restoreSessions();
  });

  test("expired sessions (>2h) not matched by Tier 4", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const oldSession = makePrepSession({
      topic: "CoCo Launch Video",
      createdAt: threeHoursAgo,
    });
    writeSessionsJson([oldSession]);

    const sm = new SessionManager();
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video Discussion",
      meetUrl: "https://meet.google.com/new-new-new",
    });

    // Should NOT match the old session, should create new
    expect(result.meetingId).not.toBe(oldSession.meetingId);
    restoreSessions();
  });

  test("sessions without files.prep not matched by Tier 4", () => {
    const noPrep = makePrepSession({
      topic: "CoCo Launch Video",
      files: {},
    });
    writeSessionsJson([noPrep]);

    const sm = new SessionManager();
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video Discussion",
      meetUrl: "https://meet.google.com/xyz-xyz-xyz",
    });

    expect(result.meetingId).not.toBe(noPrep.meetingId);
    restoreSessions();
  });

  test("Tier 4 not activated without meetUrl (prepare-only call)", () => {
    const prepSession = makePrepSession({ topic: "CoCo Launch Video" });
    writeSessionsJson([prepSession]);

    const sm = new SessionManager();
    // No meetUrl — should NOT use Tier 4 fuzzy matching
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video Discussion",
      // No meetUrl!
    });

    // Different topic, no meetUrl → should create new session
    expect(result.meetingId).not.toBe(prepSession.meetingId);
    restoreSessions();
  });

  test("ended sessions not matched by any tier", () => {
    const ended = makePrepSession({
      topic: "CoCo Launch Video",
      status: "ended",
    });
    writeSessionsJson([ended]);

    const sm = new SessionManager();
    const result = sm.findOrCreate({
      topic: "CoCo Launch Video",
      meetUrl: "https://meet.google.com/end-end-end",
    });

    expect(result.meetingId).not.toBe(ended.meetingId);
    restoreSessions();
  });
});
