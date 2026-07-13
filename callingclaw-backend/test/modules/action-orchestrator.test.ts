import { test, expect } from "bun:test";
import { ActionOrchestrator } from "../../src/modules/action-orchestrator";
import { SharedContext } from "../../src/modules/shared-context";
import { EventBus } from "../../src/modules/event-bus";

function setup(taskTimeoutMs?: number) {
  const ctx = new SharedContext();
  const bus = new EventBus();
  return { ctx, bus, orch: new ActionOrchestrator(ctx, bus, taskTimeoutMs) };
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

// ── P0.3: executor timeout must never wedge the orchestrator ──
// A hung executor (stuck fetch / Playwright evaluate that never resolves or
// rejects) must not leave `_active` set forever — that would fill MAX_QUEUE
// and kill the orchestrator for the rest of the meeting.

test("hung executor times out: its awaiter gets a timeout result, and _active frees so the next task drains", async () => {
  const { orch, ctx, bus } = setup(50); // short override so the test doesn't wait 45s
  const failedEvents: any[] = [];
  bus.on("task.failed", (e) => failedEvents.push(e));

  let hungTaskAborted = false;
  const p1 = orch.submit("voice", "hung task", (task) => {
    task.abort.signal.addEventListener("abort", () => { hungTaskAborted = true; });
    // Simulates a stuck fetch / Playwright evaluate: this promise never
    // resolves or rejects on its own.
    return new Promise<string>(() => {});
  });

  let secondRan = false;
  const p2 = orch.submit("voice", "second task", async () => {
    secondRan = true;
    return "second done";
  });

  // The hung task's own awaiter must not be left hanging — it settles with
  // a timeout outcome instead of waiting forever.
  const r1 = await p1;
  expect(r1.toLowerCase()).toContain("timed out");
  expect(hungTaskAborted).toBe(true); // executor's AbortController was aborted
  expect(failedEvents.length).toBe(1);

  // The queue must have kept draining: the second task actually ran and
  // resolved normally — proving no wedge.
  const r2 = await p2;
  expect(secondRan).toBe(true);
  expect(r2).toBe("second done");

  // No task left dangling as "active" after both settle.
  expect(ctx.activeTask).toBeNull();
});

test("happy path regression: executor well under the timeout resolves normally, no premature timeout", async () => {
  const { orch } = setup(50); // same short override — proves it doesn't fire early
  const r = await orch.submit("voice", "quick task", async () => {
    await new Promise((res) => setTimeout(res, 10));
    return "quick done";
  });
  expect(r).toBe("quick done");
});

test("happy path regression: default production timeout does not interfere with a normal executor", async () => {
  const { orch } = setup(); // no override — exercises the real TASK_EXECUTOR_TIMEOUT_MS default
  const r1 = await orch.submit("voice", "normal task one", async () => "one done");
  expect(r1).toBe("one done");
  const r2 = await orch.submit("voice", "normal task two", async () => "two done");
  expect(r2).toBe("two done");
});
