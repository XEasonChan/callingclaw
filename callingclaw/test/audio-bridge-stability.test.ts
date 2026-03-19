/**
 * Audio Bridge Stability Tests
 *
 * Tests the fix for the sidecar reconnect loop that caused audio to never
 * stay running. The root cause was:
 * 1. Bridge replaces "stale" connections → sidecar disconnects → cleanup
 * 2. Sidecar reconnects immediately (3s) → bridge sees new connection while
 *    still processing old → replaces again → infinite loop
 * 3. Config guard clause (audio_mode != new_mode) skipped restart when
 *    bridge re-sent the same config on reconnect
 *
 * Fixes:
 * - Sidecar: remove guard clause, force restart audio on every config
 * - Sidecar: increase reconnect backoff from 3s to 5s
 * - Bridge: send config once on reconnect (no verify loop)
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SIDECAR_PATH = resolve(__dirname, "../python_sidecar/main.py");
const BRIDGE_PATH = resolve(__dirname, "../src/bridge.ts");

const sidecarCode = readFileSync(SIDECAR_PATH, "utf-8");
const bridgeCode = readFileSync(BRIDGE_PATH, "utf-8");

describe("Audio Bridge Stability", () => {

  // ── Sidecar fixes ──────────────────────────────────────────────

  describe("Sidecar: config handler (Fix A)", () => {
    test("T1: no guard clause — config always triggers audio restart", () => {
      // The old code had: `audio_mode != new_mode` guard that skipped restart
      // when the same mode was re-sent. The fix removes this guard.
      const configBlock = sidecarCode.slice(
        sidecarCode.indexOf('elif msg_type == "config"'),
        sidecarCode.indexOf('elif msg_type == "ping"')
      );

      // Should NOT have the old guard clause pattern
      expect(configBlock).not.toContain("audio_mode != new_mode");

      // Should have unconditional restart: `if new_mode in ("direct", "meet_bridge"):`
      // without the `and audio_mode != new_mode` part
      const forceRestartPattern = /if new_mode in \("direct", "meet_bridge"\):/;
      expect(forceRestartPattern.test(configBlock)).toBe(true);

      // Should stop existing audio before restart
      expect(configBlock).toContain("audio_bridge.running");
      expect(configBlock).toContain("audio_bridge.stop()");
    });

    test("T1b: config handler sends audio_mode_changed confirmation", () => {
      const configBlock = sidecarCode.slice(
        sidecarCode.indexOf('elif msg_type == "config"'),
        sidecarCode.indexOf('elif msg_type == "ping"')
      );

      // Must send confirmation so bridge knows audio started
      expect(configBlock).toContain('"audio_mode_changed"');
      expect(configBlock).toContain('"success": True');
    });

    test("T1c: config handler cancels existing capture task before restart", () => {
      const configBlock = sidecarCode.slice(
        sidecarCode.indexOf('elif msg_type == "config"'),
        sidecarCode.indexOf('elif msg_type == "ping"')
      );

      // Must cancel old task to avoid orphan capture loops
      expect(configBlock).toContain("audio_capture_task.cancel()");
      // Should check if task is done before cancelling
      expect(configBlock).toContain("audio_capture_task.done()");
    });
  });

  describe("Sidecar: reconnect backoff (Fix B)", () => {
    test("T2: reconnect delay is 5 seconds (not 3)", () => {
      // The finally block should sleep 5s before reconnecting
      const finallyBlock = sidecarCode.slice(
        sidecarCode.lastIndexOf("finally:"),
        sidecarCode.indexOf('if __name__')
      );
      expect(finallyBlock).toContain("asyncio.sleep(5)");
      expect(finallyBlock).not.toContain("asyncio.sleep(3)");
    });

    test("T2b: initial connection retry is also 5 seconds", () => {
      const connectBlock = sidecarCode.slice(
        sidecarCode.indexOf("while True:"),
        sidecarCode.indexOf("Connected to Bun bridge")
      );
      expect(connectBlock).toContain("retrying in 5s");
    });

    test("T3: finally block resets audio_mode to default", () => {
      // This ensures next config message will always trigger audio start
      const finallyBlock = sidecarCode.slice(
        sidecarCode.lastIndexOf("finally:"),
        sidecarCode.indexOf('if __name__')
      );
      expect(finallyBlock).toContain('audio_mode = "default"');
    });

    test("T3b: finally block stops audio bridge and cancels capture task", () => {
      const finallyBlock = sidecarCode.slice(
        sidecarCode.lastIndexOf("finally:"),
        sidecarCode.indexOf('if __name__')
      );
      expect(finallyBlock).toContain("audio_bridge.stop()");
      expect(finallyBlock).toContain("audio_capture_task.cancel()");
    });
  });

  // ── Bridge fixes ───────────────────────────────────────────────

  describe("Bridge: config replay on reconnect (Fix D)", () => {
    test("T4: reconnect sends config once (no verify loop)", () => {
      // The open handler should send config via self.send(), not
      // sendConfigAndVerify() which does a 3-attempt retry loop
      const openBlock = bridgeCode.slice(
        bridgeCode.indexOf("open(ws)"),
        bridgeCode.indexOf("message(ws")
      );

      // Should contain single send
      expect(openBlock).toContain('self.send("config"');

      // Should NOT call sendConfigAndVerify in the reconnect path
      expect(openBlock).not.toContain("sendConfigAndVerify");
    });

    test("T5: sendConfigAndVerify still exists for initial config", () => {
      // The verify method should still exist for first-time config
      expect(bridgeCode).toContain("async sendConfigAndVerify(");
      expect(bridgeCode).toContain("Config verified on attempt");
    });

    test("T5b: bridge still handles stale connection replacement", () => {
      // Defensive stale replacement should remain
      const openBlock = bridgeCode.slice(
        bridgeCode.indexOf("open(ws)"),
        bridgeCode.indexOf("message(ws")
      );
      expect(openBlock).toContain("Replacing stale sidecar connection");
      expect(openBlock).toContain("self.client.close()");
    });
  });

  // ── Audio chain invariants ─────────────────────────────────────

  describe("Audio chain invariants", () => {
    test("BlackHole device selection uses correct indices", () => {
      // Sidecar must capture from BlackHole 2ch and play to BlackHole 16ch
      expect(sidecarCode).toContain('self._find_device("BlackHole 2ch", need_input=True)');
      expect(sidecarCode).toContain('self._find_device("BlackHole 16ch", need_output=True)');
    });

    test("capture_loop sends audio_chunk messages", () => {
      expect(sidecarCode).toContain('"type": "audio_chunk"');
    });

    test("bridge forwards audio_chunk to registered handlers", () => {
      // Bridge dispatches messages by type to registered handlers
      expect(bridgeCode).toContain("audio_chunk");
      expect(bridgeCode).toContain("handlers.get(msg.type)");
    });

    test("ping response uses status type for pong tracking", () => {
      // Sidecar responds to ping with type="status" (not "pong")
      // Bridge tracks _lastPong on any status message
      const pingHandler = sidecarCode.slice(
        sidecarCode.indexOf('msg_type == "ping"'),
        sidecarCode.indexOf('json.JSONDecodeError')
      );
      expect(pingHandler).toContain('"type": "status"');
      expect(pingHandler).toContain('"status": "alive"');

      // Bridge updates _lastPong on status
      expect(bridgeCode).toContain('msg.type === "status"');
      expect(bridgeCode).toContain("_lastPong = Date.now()");
    });
  });
});
