import { test, expect } from "bun:test";
import { ActionOrchestrator } from "../../src/modules/action-orchestrator";
import { SharedContext } from "../../src/modules/shared-context";
import { EventBus } from "../../src/modules/event-bus";

function setup() {
  const ctx = new SharedContext();
  const bus = new EventBus();
  return { ctx, bus, orch: new ActionOrchestrator(ctx, bus) };
}

test("serializes tasks: one active at a time", async () => {
  const { orch, ctx } = setup();
  const order: string[] = [];
  const p1 = orch.submit("voice", "open file A", async () => {
    order.push("a-start");
    await new Promise(r => setTimeout(r, 50));
    order.push("a-end");
    return "A done";
  });
  const p2 = orch.submit("auditor", "open file B", async () => {
    order.push("b-start");
    return "B done";
  });
  expect(ctx.activeTask?.instruction).toContain("open file A");
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
  expect(r1).toBe("A done");
  expect(r2).toBe("B done");
  expect(ctx.activeTask).toBeNull();
});

test("coalesces duplicate instruction across sources", async () => {
  const { orch } = setup();
  let runs = 0;
  const exec = async () => { runs++; await new Promise(r => setTimeout(r, 30)); return "done"; };
  const p1 = orch.submit("voice", "打开 Q3 budget", exec);
  const p2 = orch.submit("auditor", "打开 q3 BUDGET", exec); // same normalized key
  await Promise.all([p1, p2]);
  expect(runs).toBe(1);
});

test("coalesces with recently completed task", async () => {
  const { orch } = setup();
  let runs = 0;
  const exec = async () => { runs++; return "done"; };
  await orch.submit("voice", "share screen", exec);
  await orch.submit("auditor", "share screen", exec); // within 10s window
  expect(runs).toBe(1);
});

test("abortActive cancels the running task and flushes queue", async () => {
  const { orch, bus } = setup();
  const events: string[] = [];
  bus.on("task.cancelled", () => events.push("cancelled"));
  const p1 = orch.submit("voice", "long task", async (task) => {
    for (let i = 0; i < 50; i++) {
      if (task.abort.signal.aborted) throw new Error("aborted");
      await new Promise(r => setTimeout(r, 10));
    }
    return "finished";
  });
  const p2 = orch.submit("voice", "queued task", async () => "should not run");
  await new Promise(r => setTimeout(r, 25));
  expect(orch.abortActive("test")).toBe(true);
  const r1 = await p1;
  const r2 = await p2;
  expect(r1).toContain("Cancelled");
  expect(r2).toContain("Cancelled before starting");
  expect(events).toContain("cancelled");
});

test("failed executor resolves with error string, queue continues", async () => {
  const { orch } = setup();
  const r1 = await orch.submit("voice", "boom", async () => { throw new Error("kaput"); });
  expect(r1).toContain("kaput");
  const r2 = await orch.submit("voice", "next", async () => "ok");
  expect(r2).toBe("ok");
});

test("progress steps surface in SharedContext prompt", async () => {
  const { orch, ctx } = setup();
  const p = orch.submit("voice", "stepped task", async (task) => {
    orch.progress(task.id, "clicked Finder");
    expect(ctx.getActiveTaskPrompt()).toContain("clicked Finder");
    return "ok";
  });
  await p;
  expect(ctx.getActiveTaskPrompt()).toBe("");
});
