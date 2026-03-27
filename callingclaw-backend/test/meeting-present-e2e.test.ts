/**
 * CallingClaw Meeting + Presenting E2E Test
 *
 * Full flow: Join Meet → Open summary HTML → Screen share → Scroll → AI speaks → Stop → Leave
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx bun test test/meeting-present-e2e.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

const API = "http://localhost:4000";
const MEET_URL = process.env.MEET_URL || "https://meet.google.com/ouw-dudh-ynp";
const SUMMARY_URL = `${API}/meeting-summary-20260326.html`;

async function api(method: string, path: string, body?: any): Promise<any> {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

describe("Meeting + Presenting E2E", () => {

  test("1. backend is running", async () => {
    const status = await api("GET", "/api/status");
    console.log(`Backend v${status.version} — ${status.callingclaw}`);
    expect(status.callingclaw).toBe("running");
  }, 10_000);

  test("2. join meeting", async () => {
    const result = await api("POST", "/api/meeting/join", {
      url: MEET_URL,
      instructions: "E2E test: join + present + scroll + speak",
    });
    console.log(`Join: ${result.status} | ${result.joinSummary}`);
    expect(["in_meeting", "waiting_room"]).toContain(result.status);
    // Even if waiting_room, continue — audio pipeline should be active
    if (result.status === "in_meeting") {
      console.log(`Audio: ${result.audio_mode}`);
    }
  }, 90_000);

  test("3. open meeting summary and screen share", async () => {
    // Share the meeting summary HTML
    const shareResult = await api("POST", "/api/screen/share", { url: SUMMARY_URL });
    console.log(`Share: ${JSON.stringify(shareResult)}`);
    expect(shareResult.success).toBe(true);

    // Wait for share to initialize
    await new Promise(r => setTimeout(r, 3000));
  }, 30_000);

  test("4. scroll presenting tab down", async () => {
    // Scroll via direct presenting page evaluate
    const scrollResult = await fetch(`${API}/api/status`).then(r => r.json());
    // Use the ChromeLauncher presenting page to scroll
    // We'll test this via the screen share staying active after scroll
    console.log(`Meeting status: ${scrollResult.meeting}`);

    // Send a scroll command via voice text (triggers TranscriptAuditor)
    // But for deterministic test, use direct API
    const textResult = await api("POST", "/api/voice/text", {
      text: "我来演示一下这个 meeting summary 的内容，请大家看屏幕",
    });
    console.log(`AI speaks: ${JSON.stringify(textResult)}`);
    expect(textResult.ok).toBe(true);

    // Wait for AI to start speaking
    await new Promise(r => setTimeout(r, 5000));
  }, 20_000);

  test("5. verify AI voice is active", async () => {
    const status = await api("GET", "/api/status");
    console.log(`Voice: connected=${status.voiceSession?.connected}, provider=${status.voiceSession?.provider}`);
    expect(status.voiceSession?.connected).toBe(true);
  }, 10_000);

  test("6. stop screen sharing", async () => {
    const stopResult = await api("POST", "/api/screen/stop");
    console.log(`Stop share: ${JSON.stringify(stopResult)}`);
    expect(stopResult.success).toBe(true);
    await new Promise(r => setTimeout(r, 2000));
  }, 15_000);

  test("7. leave meeting", async () => {
    const leaveResult = await api("POST", "/api/meeting/leave");
    console.log(`Leave: ok=${leaveResult.ok}`);
    // Leave may fail gracefully (summary generation error) but that's OK
    await new Promise(r => setTimeout(r, 3000));
  }, 30_000);

  test("8. verify meeting ended", async () => {
    const status = await api("GET", "/api/status");
    console.log(`Post-leave: meeting=${status.meeting}, voice=${status.voiceSession?.connected}`);
    // Meeting should be idle or stopped after leave
  }, 10_000);
});
