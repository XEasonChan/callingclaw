import { test, expect, describe } from "bun:test";
import { SharedContext } from "./shared-context";

describe("SharedContext", () => {
  test("addTranscript and getRecentTranscript", () => {
    const ctx = new SharedContext();
    ctx.addTranscript({ role: "user", text: "Hello", ts: 1000 });
    ctx.addTranscript({ role: "assistant", text: "Hi there", ts: 2000 });

    expect(ctx.transcript.length).toBe(2);
    expect(ctx.getRecentTranscript(1)).toHaveLength(1);
    expect(ctx.getRecentTranscript(1)[0].text).toBe("Hi there");
  });

  test("getTranscriptText formats correctly", () => {
    const ctx = new SharedContext();
    ctx.addTranscript({ role: "user", text: "Test message", ts: 1000 });
    ctx.addTranscript({ role: "participant", speaker: "Bob", text: "I agree", ts: 2000 });

    const text = ctx.getTranscriptText();
    expect(text).toContain("[user] Test message");
    expect(text).toContain("[participant (Bob)] I agree");
  });

  test("updateScreen stores latest screenshot", () => {
    const ctx = new SharedContext();
    ctx.updateScreen("base64data", "Chrome browser open");

    expect(ctx.screen.latestScreenshot).toBe("base64data");
    expect(ctx.screen.description).toBe("Chrome browser open");
    expect(ctx.screen.capturedAt).toBeGreaterThan(0);
  });

  test("addNote and getTodos", () => {
    const ctx = new SharedContext();
    ctx.addNote({ type: "note", text: "General note", ts: 1000 });
    ctx.addNote({ type: "todo", text: "Buy milk", ts: 2000 });
    ctx.addNote({ type: "action_item", text: "Review PR", assignee: "Alice", ts: 3000 });
    ctx.addNote({ type: "decision", text: "Ship v2", ts: 4000 });

    expect(ctx.meetingNotes.length).toBe(4);
    expect(ctx.getTodos()).toHaveLength(2);
    expect(ctx.getTodos()[0].text).toBe("Buy milk");
  });

  test("event listeners fire on changes", () => {
    const ctx = new SharedContext();
    const events: string[] = [];

    ctx.on("transcript", (entry) => events.push(`t:${entry.text}`));
    ctx.on("screen", (screen) => events.push(`s:${screen.description}`));
    ctx.on("note", (note) => events.push(`n:${note.text}`));

    ctx.addTranscript({ role: "user", text: "hello", ts: 1 });
    ctx.updateScreen("img", "Desktop");
    ctx.addNote({ type: "todo", text: "task1", ts: 2 });

    expect(events).toEqual(["t:hello", "s:Desktop", "n:task1"]);
  });

  test("transcript auto-trims at 200 entries", () => {
    const ctx = new SharedContext();
    for (let i = 0; i < 250; i++) {
      ctx.addTranscript({ role: "user", text: `msg${i}`, ts: i });
    }
    expect(ctx.transcript.length).toBe(200);
    expect(ctx.transcript[0].text).toBe("msg50");
  });

  test("exportSummary returns all data", () => {
    const ctx = new SharedContext();
    ctx.addTranscript({ role: "user", text: "hi", ts: 1 });
    ctx.updateScreen("img", "Test screen");
    ctx.addNote({ type: "todo", text: "Do thing", ts: 2 });

    const summary = ctx.exportSummary();
    expect(summary.transcriptLength).toBe(1);
    expect(summary.screenDescription).toBe("Test screen");
    expect(summary.todos).toHaveLength(1);
  });

  test("reset clears all state", () => {
    const ctx = new SharedContext();
    ctx.addTranscript({ role: "user", text: "hi", ts: 1 });
    ctx.updateScreen("img", "desc");
    ctx.addNote({ type: "todo", text: "task", ts: 2 });

    ctx.reset();

    expect(ctx.transcript.length).toBe(0);
    expect(ctx.screen.latestScreenshot).toBeNull();
    expect(ctx.meetingNotes.length).toBe(0);
  });
});
