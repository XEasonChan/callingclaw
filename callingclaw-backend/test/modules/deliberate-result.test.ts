// deliberate-result — P1 STEP 2 pure contract helpers (no VoiceModule, no client)
//
// Covers the DETERMINISTIC turn-lease (classifyStaleness), the sentinel
// classifier (isDeliberateError / looksLikeErrorSentinel), and the Layer-3
// renderers (renderDeliberateText / renderErrorNote). These are the pieces the
// sink delegates to; unit-testing them in isolation pins the behaviour that the
// live voice loop depends on WITHOUT a session.

import { test, expect, describe } from "bun:test";
import {
  classifyStaleness,
  isDeliberateError,
  looksLikeErrorSentinel,
  renderDeliberateText,
  renderErrorNote,
  DEFAULT_STALENESS,
  type DeliberateResult,
} from "../../src/modules/deliberate-result";

const NOW = 1_000_000_000;

// ═══════════════════════════════════════════════════════════════════
// Turn-lease staleness (the PRIMARY, deterministic mechanism)
// ═══════════════════════════════════════════════════════════════════

describe("classifyStaleness — turn-lease", () => {
  test("fresh proactive (same turn) → speak", () => {
    expect(
      classifyStaleness({ sourceTurnId: 5, currentTurnId: 5, dispatchedAt: NOW, now: NOW, speak: "proactive" }),
    ).toBe("speak");
  });

  test("adjacent turn (1 elapsed) → still speak (lease open)", () => {
    expect(
      classifyStaleness({ sourceTurnId: 5, currentTurnId: 6, dispatchedAt: NOW, now: NOW, speak: "proactive" }),
    ).toBe("speak");
  });

  test("stale proactive (3 turns elapsed) → inject-silent (late-default-silent)", () => {
    expect(
      classifyStaleness({ sourceTurnId: 5, currentTurnId: 8, dispatchedAt: NOW, now: NOW, speak: "proactive" }),
    ).toBe("inject-silent");
  });

  test("very stale proactive (> injectWithinTurns) → drop", () => {
    expect(
      classifyStaleness({ sourceTurnId: 1, currentTurnId: 10, dispatchedAt: NOW, now: NOW, speak: "proactive" }),
    ).toBe("drop");
  });

  test("silent → always inject-silent regardless of turn delta", () => {
    expect(
      classifyStaleness({ sourceTurnId: 5, currentTurnId: 5, dispatchedAt: NOW, now: NOW, speak: "silent" }),
    ).toBe("inject-silent");
    expect(
      classifyStaleness({ sourceTurnId: 1, currentTurnId: 99, dispatchedAt: NOW, now: NOW, speak: "silent" }),
    ).toBe("inject-silent");
  });

  test("unknown sourceTurnId → lease open → speak (proactive)", () => {
    expect(
      classifyStaleness({ currentTurnId: 42, dispatchedAt: NOW, now: NOW, speak: "proactive" }),
    ).toBe("speak");
  });

  test("hard age ceiling: same turn but age > maxAgeMs → drop", () => {
    const dispatchedAt = NOW - (DEFAULT_STALENESS.maxAgeMs + 1000);
    expect(
      classifyStaleness({ sourceTurnId: 5, currentTurnId: 5, dispatchedAt, now: NOW, speak: "proactive" }),
    ).toBe("drop");
  });

  test("config override widens the speak window", () => {
    expect(
      classifyStaleness({
        sourceTurnId: 5, currentTurnId: 8, dispatchedAt: NOW, now: NOW, speak: "proactive",
        config: { speakWithinTurns: 5 },
      }),
    ).toBe("speak");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sentinel safety
// ═══════════════════════════════════════════════════════════════════

describe("sentinel classifier", () => {
  test("looksLikeErrorSentinel matches error-shaped strings, not normal text", () => {
    expect(looksLikeErrorSentinel("Search timed out")).toBe(true);
    expect(looksLikeErrorSentinel("no external agent available")).toBe(true);
    expect(looksLikeErrorSentinel("Error: billing error")).toBe(true);
    expect(looksLikeErrorSentinel("Acme charges $10/mo and bundles analytics")).toBe(false);
    expect(looksLikeErrorSentinel("")).toBe(false);
    expect(looksLikeErrorSentinel(undefined)).toBe(false);
  });

  test("isDeliberateError: explicit error field is the primary signal", () => {
    const r: DeliberateResult = { id: "x", kind: "research", summary: "ok", dispatchedAt: NOW, speak: "proactive", error: "timeout" };
    expect(isDeliberateError(r)).toBe(true);
  });

  // CORRECTED (fix #1): the old assertion here codified the buggy content-sniff
  // backstop — a SHORT success envelope whose body merely reads error-shaped was
  // classified as an error and suppressed. That re-created the original blocker
  // (the AI withholds an answer it has) and overrode the recall producer's precise
  // verdict. The sink now trusts the producer's explicit `error` field ONLY, so a
  // short error-shaped SUCCESS envelope (no `error` set) is NOT an error.
  test("isDeliberateError: a SHORT error-shaped SUCCESS envelope (no error field) is NOT suppressed", () => {
    const r: DeliberateResult = { id: "x", kind: "recall", summary: "recall_context failed", dispatchedAt: NOW, speak: "proactive" };
    expect(isDeliberateError(r)).toBe(false);
  });

  test("isDeliberateError: legit SHORT recall answers that READ error-shaped are NOT sentinels", () => {
    // These are the exact regressions fix #1 targets: real answers a user asked
    // for, ~40 chars, no `error` set. They must be spoken, not muted.
    const deploy: DeliberateResult = { id: "a", kind: "recall", summary: "Deploy failed on the 14th", dispatchedAt: NOW, speak: "proactive" };
    const server: DeliberateResult = { id: "b", kind: "recall", summary: "The server was unavailable", dispatchedAt: NOW, speak: "proactive" };
    expect(isDeliberateError(deploy)).toBe(false);
    expect(isDeliberateError(server)).toBe(false);
  });

  test("isDeliberateError: even a SHORT payload IS an error when the producer set `error`", () => {
    // The producer's explicit verdict is authoritative in BOTH directions.
    const r: DeliberateResult = { id: "x", kind: "recall", summary: "Deploy failed on the 14th", dispatchedAt: NOW, speak: "proactive", error: "All channels failed" };
    expect(isDeliberateError(r)).toBe(true);
  });

  test("isDeliberateError: a LONG legit report merely CONTAINING 'failed' is NOT a sentinel", () => {
    const detail = "The startup failed in 2019. " + "x".repeat(300); // still a success envelope
    const r: DeliberateResult = { id: "x", kind: "research", summary: "startup history", detail, dispatchedAt: NOW, speak: "proactive" };
    expect(isDeliberateError(r)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════

describe("renderDeliberateText", () => {
  test("research: labels the block with the source utterance, body = detail", () => {
    const r: DeliberateResult = {
      id: "x", kind: "research", summary: "one-line", detail: "full result body",
      sourceUtterance: "competitor pricing", dispatchedAt: NOW, speak: "proactive",
    };
    expect(renderDeliberateText(r)).toBe("[RESEARCH] competitor pricing\n\nfull result body");
  });

  test("caps the detail block", () => {
    const r: DeliberateResult = { id: "x", kind: "research", summary: "s", detail: "y".repeat(5000), dispatchedAt: NOW, speak: "proactive" };
    const text = renderDeliberateText(r, 100);
    expect(text).toContain("…(truncated)");
    expect(text.length).toBeLessThan(200);
  });

  test("no detail → uses summary as the body", () => {
    const r: DeliberateResult = { id: "x", kind: "recall", summary: "the decision was to ship Friday", dispatchedAt: NOW, speak: "silent" };
    expect(renderDeliberateText(r)).toBe("[RECALL]\n\nthe decision was to ship Friday");
  });

  test("per-kind prefixes", () => {
    const base = { id: "x", summary: "s", detail: "d", dispatchedAt: NOW, speak: "silent" as const };
    expect(renderDeliberateText({ ...base, kind: "retrieval" })).toStartWith("[CONTEXT]");
    expect(renderDeliberateText({ ...base, kind: "action" })).toStartWith("[DONE]");
  });
});

describe("renderErrorNote", () => {
  test("neutral note names the kind + source but NEVER echoes the raw error", () => {
    const r: DeliberateResult = {
      id: "x", kind: "research", summary: "s", sourceUtterance: "acme pricing",
      dispatchedAt: NOW, speak: "proactive", error: "billing error 402 secret-token-xyz",
    };
    const note = renderErrorNote(r);
    expect(note).toContain("[RESEARCH]");
    expect(note).toContain("acme pricing");
    expect(note.toLowerCase()).toContain("did not return a usable");
    // Sentinel safety: the raw error string must not leak into Layer 3.
    expect(note).not.toContain("secret-token-xyz");
    expect(note).not.toContain("402");
  });
});
