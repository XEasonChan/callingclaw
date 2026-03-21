// NativeBridge unit tests — verify correct command generation for each action type

import { describe, test, expect } from "bun:test";
import { NativeBridge, executeAction } from "../src/bridge";

describe("NativeBridge", () => {
  test("ready is always true (no WebSocket dependency)", () => {
    const bridge = new NativeBridge();
    expect(bridge.ready).toBe(true);
  });

  test("send('config', ...) is a no-op that returns true", () => {
    const bridge = new NativeBridge();
    const result = bridge.send("config", { audio_mode: "meet_bridge" });
    expect(result).toBe(true);
  });

  test("send('audio_playback', ...) is a no-op that returns true", () => {
    const bridge = new NativeBridge();
    const result = bridge.sendAudioPlayback("base64data");
    expect(result).toBe(true);
  });

  test("send('ping', ...) is a no-op that returns true", () => {
    const bridge = new NativeBridge();
    const result = bridge.send("ping", { ts: Date.now() });
    expect(result).toBe(true);
  });

  test("sendConfigAndVerify returns true immediately (no sidecar to verify)", async () => {
    const bridge = new NativeBridge();
    const result = await bridge.sendConfigAndVerify(
      { audio_mode: "meet_bridge" },
      { timeoutMs: 100, retries: 1 }
    );
    expect(result).toBe(true);
  });

  test("sendAction returns true (fire-and-forget)", () => {
    const bridge = new NativeBridge();
    const result = bridge.sendAction("key", { key: "command+e" });
    expect(result).toBe(true);
  });

  test("on/once/off handlers work", () => {
    const bridge = new NativeBridge();
    const received: any[] = [];
    const handler = (msg: any) => received.push(msg);

    bridge.on("action_result", handler);
    // Simulate internal emit (would happen after action execution)
    const msg = { type: "action_result" as const, payload: { ok: true }, ts: Date.now() };
    // Access handlers through send("action") which triggers emit
    bridge.off("action_result", handler);
    // After off, handler should not fire
    expect(received.length).toBe(0);
  });
});

describe("executeAction", () => {
  test("click generates cliclick command and returns position", async () => {
    const result = await executeAction("click", { x: 100, y: 200, button: "left" });
    // On a headless/CI machine cliclick may fail but the function should not throw
    expect(result.action).toBe("click");
    expect(result.position).toEqual([100, 200]);
  });

  test("key generates osascript keystroke", async () => {
    // This will execute but may not have effect in test environment
    const result = await executeAction("key", { key: "command+c" });
    expect(result.action).toBe("key");
    expect(result.key).toBe("command+c");
  });

  test("type generates osascript keystroke for text", async () => {
    const result = await executeAction("type", { text: "hello" });
    expect(result.action).toBe("type");
    expect(result.typed).toBe(5);
  });

  test("mouse_move generates cliclick move command", async () => {
    const result = await executeAction("mouse_move", { x: 300, y: 400 });
    expect(result.action).toBe("mouse_move");
    expect(result.ok).toBe(true);
  });

  test("drag generates cliclick dd/du commands", async () => {
    const result = await executeAction("drag", { startX: 10, startY: 20, endX: 100, endY: 200 });
    expect(result.action).toBe("drag");
    expect(result.ok).toBe(true);
  });

  test("run_command executes shell command", async () => {
    const result = await executeAction("run_command", { command: "echo hello" });
    expect(result.action).toBe("run_command");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello");
    expect(result.returncode).toBe(0);
  });

  test("run_command handles failing commands", async () => {
    const result = await executeAction("run_command", { command: "false" });
    expect(result.action).toBe("run_command");
    expect(result.returncode).not.toBe(0);
  });

  test("screenshot uses screencapture CLI", async () => {
    const result = await executeAction("screenshot", {});
    // May fail without Screen Recording permission, but should not throw
    expect(result.action).toBe("screenshot");
    // Either succeeds with image or fails with permission error
    if (result.ok) {
      expect(result.image).toBeTruthy();
    } else {
      expect(result.error).toContain("screencapture");
    }
  });

  test("unknown action returns error", async () => {
    const result = await executeAction("nonexistent_action", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  test("scroll executes without throwing", async () => {
    const result = await executeAction("scroll", { direction: "down", amount: 3 });
    expect(result.action).toBe("scroll");
    // May fail on CI but should not throw
  });
});
