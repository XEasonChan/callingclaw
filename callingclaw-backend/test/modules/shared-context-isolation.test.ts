// Cross-meeting transcript isolation (s1s2 §8, P0.6).
//
// Two layers under test:
//   1. SharedContext.applyMeetingStart / meetUrl — the real production policy
//      that decides reset-vs-preserve at meeting start (previously dead code
//      because the guard read a non-existent WorkspaceContext.meetUrl field).
//   2. An EventBus integration that mirrors the callingclaw.ts meeting.started /
//      meeting.ended handlers verbatim (callingclaw.ts is a runnable entrypoint
//      with top-level side effects, so it cannot be imported into a unit test;
//      the handler closures below are byte-for-byte the logic that ships there).

import { test, expect, describe } from "bun:test";
import { SharedContext } from "../../src/modules/shared-context";
import { EventBus } from "../../src/modules/event-bus";

function addLine(ctx: SharedContext, text: string) {
  ctx.addTranscript({ role: "user", text, ts: Date.now() });
}

describe("SharedContext.applyMeetingStart (real production policy)", () => {
  test("meetUrl API: default empty, setter/getter round-trips", () => {
    const ctx = new SharedContext();
    expect(ctx.meetUrl).toBe("");
    ctx.setMeetUrl("https://meet.google.com/aaa-bbbb-ccc");
    expect(ctx.meetUrl).toBe("https://meet.google.com/aaa-bbbb-ccc");
  });

  test("different-URL start clears meeting A's transcript", () => {
    const ctx = new SharedContext();
    ctx.setMeetUrl("https://meet.google.com/aaa-aaaa-aaa"); // meeting A
    addLine(ctx, "hello from meeting A");
    addLine(ctx, "second line from A");
    expect(ctx.transcript.length).toBe(2);

    const disposition = ctx.applyMeetingStart("https://meet.google.com/bbb-bbbb-bbb"); // meeting B
    expect(disposition).toBe("reset");
    expect(ctx.transcript.length).toBe(0); // A's transcript gone
    expect(ctx.meetUrl).toBe("https://meet.google.com/bbb-bbbb-bbb"); // now tracking B
  });

  test("same-URL re-join preserves conversation history (v2.8.14)", () => {
    const ctx = new SharedContext();
    const url = "https://meet.google.com/aaa-aaaa-aaa";
    ctx.setMeetUrl(url);
    addLine(ctx, "history line 1");
    addLine(ctx, "history line 2");

    const disposition = ctx.applyMeetingStart(url); // re-join SAME meeting
    expect(disposition).toBe("preserved");
    expect(ctx.transcript.length).toBe(2); // history kept
    expect(ctx.meetUrl).toBe(url);
  });

  test("fresh start (no prior transcript) returns 'fresh' and records URL", () => {
    const ctx = new SharedContext();
    const disposition = ctx.applyMeetingStart("https://meet.google.com/ccc-cccc-ccc");
    expect(disposition).toBe("fresh");
    expect(ctx.transcript.length).toBe(0);
    expect(ctx.meetUrl).toBe("https://meet.google.com/ccc-cccc-ccc");
  });

  test("empty URL never mistakenly triggers a reset and does not overwrite meetUrl", () => {
    const ctx = new SharedContext();
    ctx.setMeetUrl("https://meet.google.com/aaa-aaaa-aaa");
    addLine(ctx, "keep me");
    // Emitters that pass {} (no URL) must not clobber the tracked URL or nuke history.
    const disposition = ctx.applyMeetingStart("");
    expect(disposition).toBe("preserved");
    expect(ctx.transcript.length).toBe(1);
    expect(ctx.meetUrl).toBe("https://meet.google.com/aaa-aaaa-aaa");
  });

  test("reset() clears meetUrl too", () => {
    const ctx = new SharedContext();
    ctx.setMeetUrl("https://meet.google.com/aaa-aaaa-aaa");
    addLine(ctx, "x");
    ctx.reset();
    expect(ctx.meetUrl).toBe("");
    expect(ctx.transcript.length).toBe(0);
  });
});

describe("meeting.started / meeting.ended handlers via real EventBus", () => {
  // Mirror of the callingclaw.ts handlers (payload-alias read + applyMeetingStart
  // on start; resetTranscript on ended). Wired to a real EventBus + SharedContext.
  function wire(ctx: SharedContext, bus: EventBus) {
    bus.on("meeting.started", (data) => {
      const currentUrl = data?.meetUrl || data?.url || data?.meet_url || "";
      ctx.applyMeetingStart(currentUrl);
    });
    bus.on("meeting.ended", () => {
      ctx.resetTranscript();
    });
  }

  test("payload aliases: url / meet_url / meetUrl are all read for the meeting URL", () => {
    for (const field of ["url", "meet_url", "meetUrl"]) {
      const ctx = new SharedContext();
      const bus = new EventBus();
      wire(ctx, bus);
      ctx.setMeetUrl("https://meet.google.com/old-old-old");
      addLine(ctx, "meeting A line");
      bus.emit("meeting.started", { [field]: "https://meet.google.com/new-new-new" });
      expect(ctx.transcript.length).toBe(0); // different URL via `${field}` → reset
      expect(ctx.meetUrl).toBe("https://meet.google.com/new-new-new");
    }
  });

  test("full lifecycle: A ends → B (different url) starts clean → same-url rejoin preserved", () => {
    const ctx = new SharedContext();
    const bus = new EventBus();
    wire(ctx, bus);

    // Meeting A
    bus.emit("meeting.started", { meet_url: "https://meet.google.com/aaa-aaaa-aaa" });
    addLine(ctx, "A: quarterly numbers");
    addLine(ctx, "A: hiring plan");
    expect(ctx.transcript.length).toBe(2);

    // Meeting A ends → transcript cleared so it can't bleed into B
    bus.emit("meeting.ended", {});
    expect(ctx.transcript.length).toBe(0);

    // Meeting B (different URL) starts clean
    bus.emit("meeting.started", { url: "https://meet.google.com/bbb-bbbb-bbb" });
    addLine(ctx, "B: unrelated topic");
    expect(ctx.transcript.length).toBe(1);
    expect(ctx.transcript[0]!.text).toBe("B: unrelated topic"); // no A bleed

    // Re-join SAME meeting B (no meeting.ended between) → history preserved
    bus.emit("meeting.started", { url: "https://meet.google.com/bbb-bbbb-bbb" });
    expect(ctx.transcript.length).toBe(1);
  });

  test("meeting.ended resets transcript even with no URL in payload", () => {
    const ctx = new SharedContext();
    const bus = new EventBus();
    wire(ctx, bus);
    addLine(ctx, "line 1");
    addLine(ctx, "line 2");
    bus.emit("meeting.ended", {}); // e.g. autoLeave catch-path fallback payload
    expect(ctx.transcript.length).toBe(0);
  });
});
