import { test, expect, describe } from "bun:test";
import {
  actionFamily,
  isAckOrFiller,
  isDuplicateAction,
  isRepeatableAction,
  DEDUP_WINDOW_MS,
  type RecentActionEntry,
} from "../../src/modules/transcript-auditor";

// Pure-function tests — no LLM, no network. Covers the cross-lane dedup
// (Realtime voice tools vs Auditor actions) and the ack/filler pre-gate.

const NOW = 1_750_000_000_000;

// Build a ring entry as rememberAction() would — `agoMs` before NOW
const entry = (action: string, agoMs: number, key?: string, target?: string): RecentActionEntry => ({
  action,
  family: actionFamily(action),
  key: key ?? `${action}:{}`,
  target: target ?? "",
  ts: NOW - agoMs,
});

// ── Cross-lane dedup: action families ──

describe("isDuplicateAction (cross-lane family dedup)", () => {
  test("realtime open_file suppresses auditor search_and_open for the SAME target", () => {
    // Realtime lane stores keys as `realtime:{tool}:{json snippet}` — the
    // family+target match must suppress despite the totally different key format
    const ring = [entry("open_file", 3_000, 'realtime:open_file:"/tmp/pricing.html"', "/tmp/pricing.html")];
    expect(
      isDuplicateAction("search_and_open", 'search_and_open:{"query":"pricing"}', ring, NOW, "pricing")
    ).toBe(true);
  });

  test("realtime open_file suppresses auditor share_file (same present family, overlapping target)", () => {
    const ring = [entry("open_file", 5_000, 'realtime:open_file:"prd.md"', "prd.md")];
    expect(isDuplicateAction("share_file", 'share_file:{"query":"prd"}', ring, NOW, "prd")).toBe(true);
  });

  test("same family with a DIFFERENT target is NOT suppressed (打开PRD → 打开pitch deck)", () => {
    const ring = [entry("open_file", 3_000, 'realtime:open_file:"PRD需求文档"', "PRD需求文档")];
    expect(
      isDuplicateAction("search_and_open", 'search_and_open:{"query":"pitch deck"}', ring, NOW, "pitch deck")
    ).toBe(false);
  });

  test("share_screen (no target) does NOT suppress share_url with a concrete URL", () => {
    const ring = [entry("share_screen", 2_000, 'realtime:share_screen:""', "")];
    expect(
      isDuplicateAction("share_url", 'share_url:{"url":"https://callingclaw.com"}', ring, NOW, "https://callingclaw.com")
    ).toBe(false);
  });

  test("new action with NO distinguishing target IS suppressed on family match", () => {
    // "share the screen" right after Realtime opened a file — nothing to
    // disambiguate on, trust the family match (old conservative behavior)
    const ring = [entry("open_file", 3_000, 'realtime:open_file:"prd.md"', "prd.md")];
    expect(isDuplicateAction("share_screen", "share_screen:{}", ring, NOW, "")).toBe(true);
    expect(isDuplicateAction("share_screen", "share_screen:{}", ring, NOW)).toBe(true);
  });

  test("different family is NOT suppressed", () => {
    const ring = [entry("open_file", 3_000)];
    expect(isDuplicateAction("meet_mute", "meet_mute:{}", ring, NOW)).toBe(false);
    expect(isDuplicateAction("stop_sharing", "stop_sharing:{}", ring, NOW)).toBe(false);
    expect(
      isDuplicateAction("research_task", 'research_task:{"query":"news"}', ring, NOW, "news")
    ).toBe(false);
  });

  test("realtime recall_context suppresses auditor research_task for the same query", () => {
    const ring = [entry("recall_context", 4_000, 'realtime:recall_context:"competitors"', "competitors")];
    expect(
      isDuplicateAction("research_task", 'research_task:{"query":"competitors"}', ring, NOW, "competitors")
    ).toBe(true);
    // ...but a research_task on a DIFFERENT question runs
    expect(
      isDuplicateAction("research_task", 'research_task:{"query":"voice AI pricing news"}', ring, NOW, "voice AI pricing news")
    ).toBe(false);
  });

  test("realtime search_files does NOT suppress auditor open_file (list-only, no family)", () => {
    // search_files only LISTS paths ("Use open_file to open one") — the
    // follow-up open that actually presents something must go through
    const ring = [entry("search_files", 2_000, 'realtime:search_files:"PRD"', "PRD")];
    expect(
      isDuplicateAction("open_file", 'open_file:{"path":"/docs/PRD.md"}', ring, NOW, "/docs/PRD.md")
    ).toBe(false);
  });

  test("repeatable actions (scroll/click) are never suppressed", () => {
    const ring = [
      entry("scroll", 1_000, 'scroll:{"direction":"down"}'),
      entry("browser_click", 1_000),
      entry("click", 1_000, 'click:{"selector":"login"}'),
    ];
    expect(isDuplicateAction("scroll", 'scroll:{"direction":"down"}', ring, NOW)).toBe(false);
    expect(isDuplicateAction("scroll_down", "scroll_down:{}", ring, NOW)).toBe(false);
    expect(isDuplicateAction("browser_click", "browser_click:{}", ring, NOW)).toBe(false);
    expect(isDuplicateAction("click", 'click:{"selector":"login"}', ring, NOW)).toBe(false);
  });

  test("suppression expires after DEDUP_WINDOW_MS (8s — actual Realtime→auditor lag is 1.5-3s)", () => {
    expect(DEDUP_WINDOW_MS).toBe(8_000);
    const ring = [entry("open_file", DEDUP_WINDOW_MS + 1_000, 'realtime:open_file:"pricing.html"', "pricing.html")];
    expect(
      isDuplicateAction("search_and_open", 'search_and_open:{"query":"pricing"}', ring, NOW, "pricing")
    ).toBe(false);
    // ...but is still suppressed just inside the window
    const fresh = [entry("open_file", DEDUP_WINDOW_MS - 1_000, 'realtime:open_file:"pricing.html"', "pricing.html")];
    expect(
      isDuplicateAction("search_and_open", 'search_and_open:{"query":"pricing"}', fresh, NOW, "pricing")
    ).toBe(true);
  });

  test("unfamilied actions fall back to exact-key dedup", () => {
    const key = 'computer_action:{"instruction":"close popup"}';
    const ring = [entry("computer_action", 2_000, key)];
    expect(isDuplicateAction("computer_action", key, ring, NOW)).toBe(true);
    expect(
      isDuplicateAction("computer_action", 'computer_action:{"instruction":"other"}', ring, NOW)
    ).toBe(false);
  });

  test("empty ring never suppresses", () => {
    expect(isDuplicateAction("share_file", 'share_file:{"query":"prd"}', [], NOW)).toBe(false);
  });
});

describe("actionFamily / isRepeatableAction", () => {
  test("present family covers open + search + share", () => {
    for (const a of ["open_file", "open_url", "search_and_open", "share_screen", "share_url", "share_file"]) {
      expect(actionFamily(a)).toBe("present");
    }
  });

  test("navigate has its own family (navigate-after-share stays legal)", () => {
    expect(actionFamily("navigate")).toBe("navigate");
    expect(actionFamily("navigate")).not.toBe(actionFamily("share_url"));
  });

  test("unknown actions have no family", () => {
    expect(actionFamily("computer_action")).toBeNull();
    expect(actionFamily("browser_action")).toBeNull();
    // search_files is list-only (returns paths, doesn't present) — no family
    expect(actionFamily("search_files")).toBeNull();
  });

  test("repeatable: scroll variants + clicks + tab navigation", () => {
    expect(isRepeatableAction("scroll")).toBe(true);
    expect(isRepeatableAction("scroll_down")).toBe(true);
    expect(isRepeatableAction("scroll_top")).toBe(true);
    expect(isRepeatableAction("browser_click")).toBe(true);
    expect(isRepeatableAction("click")).toBe(true);
    expect(isRepeatableAction("next_tab")).toBe(true);
    expect(isRepeatableAction("prev_tab")).toBe(true);
    expect(isRepeatableAction("switch_tab")).toBe(true);
    expect(isRepeatableAction("share_file")).toBe(false);
  });

  test("tab navigation is never dedup-suppressed ('next tab' x2 advances two tabs)", () => {
    const ring = [entry("next_tab", 1_000)];
    expect(isDuplicateAction("next_tab", "next_tab:{}", ring, NOW)).toBe(false);
  });
});

// ── Ack/filler pre-gate ──

describe("isAckOrFiller (audit pre-gate)", () => {
  const positives = [
    "嗯",
    "嗯嗯",
    "哦",
    "噢",
    "好",
    "好的",
    "好的。",
    "好啊",
    "好呀",
    "是",
    "是的",
    "对",
    "对的",
    "对啊",
    "OK",
    "ok!",
    "Okay",
    "yep",
    "yes",
    "Yeah~",
    "sure",
    "没问题",
    "行",
    "可以",
    "谢谢",
    "thanks",
    "Thank you.",
    "好的，没问题", // compound of two acks — still gated (eval failure case)
    "好的，好的",
    "嗯，可以",
  ];
  for (const text of positives) {
    test(`gates: "${text}"`, () => {
      expect(isAckOrFiller(text)).toBe(true);
    });
  }

  const negatives = [
    "好的，帮我打开PRD", // ack + verb — must NOT be gated
    "打开定价页",
    "share the screen",
    "嗯，然后往下滚动",
    "可以打开那个文件吗",
    "好的没问题那我们开始共享屏幕吧",
    "thanks, now open the roadmap",
    "yes please open the pricing page",
    "", // empty → not gated (nothing to gate; existing pipeline handles it)
    "   ",
  ];
  for (const text of negatives) {
    test(`does not gate: "${text || "(empty)"}"`, () => {
      expect(isAckOrFiller(text)).toBe(false);
    });
  }
});
