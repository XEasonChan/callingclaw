// CallingClaw 2.0 — Computer Use Context & Memory Architecture
// ═══════════════════════════════════════════════════════════════════
//
// ── Memory Hierarchy ──
//
// Computer Use has TWO execution paths with DIFFERENT memory access:
//
//   Path A: Via OpenClaw (delegated tasks)
//   ┌─────────────────────────────────────────────────────┐
//   │  Voice AI → "open the PRD file"                     │
//   │  → ComputerUseModule.execute()                      │
//   │    → Claude sees instruction + calls `openclaw` tool│
//   │      → OpenClawBridge.sendTask()                    │
//   │        → OpenClaw agent (has FULL memory)           │
//   │          - MEMORY.md ✓                              │
//   │          - File system access ✓                     │
//   │          - Browser automation ✓                     │
//   │          - All conversation history ✓               │
//   │        → Returns result                             │
//   │    → Claude receives result, continues              │
//   └─────────────────────────────────────────────────────┘
//   Memory: OpenClaw's FULL context (no extra work needed)
//
//   Path B: Direct Computer Use (vision + pyautogui)
//   ┌─────────────────────────────────────────────────────┐
//   │  Voice AI → "scroll down on the screen"             │
//   │  → ComputerUseModule.execute()                      │
//   │    → Claude gets:                                   │
//   │      - Screenshot (current screen)                  │
//   │      - Last 15 transcript entries                   │
//   │      - Meeting Prep Brief (file paths + URLs)  ←NEW│
//   │    → Claude uses computer tool directly             │
//   │      - click, type, scroll, screenshot              │
//   └─────────────────────────────────────────────────────┘
//   Memory: LIMITED — only transcript + brief's file paths/URLs
//
// ── Key Insight ──
// Path A (OpenClaw) already has full memory — no extra processing needed.
// Path B (direct CU) needs the Meeting Prep Brief's file paths and URLs
// to know WHERE things are on the filesystem and in the browser.
//
// ── Task Completion → Voice Callback ──
// After EITHER path completes, Voice AI needs to know:
//   1. What task was requested
//   2. What was the result
//   3. What the screen looks like now
//
// This is handled by:
//   notifyTaskCompletion(voiceModule, prepSkill, task, result)
//   → Adds a liveNote to the Meeting Prep Brief
//   → Pushes updated context to Voice via session.update
//   → Voice AI sees "[DONE] open PRD: opened in Chrome"
//   → Voice AI can narrate: "Alright, the PRD is now open"
//
// ═══════════════════════════════════════════════════════════════════

import type { MeetingPrepSkill } from "./skills/meeting-prep";

/**
 * Build the context block that gets injected into ComputerUseModule's system prompt.
 * This replaces the old ContextSync approach with the Meeting Prep Brief's
 * file paths and URLs — exactly what Computer Use needs for navigation.
 *
 * @param prepSkill - The MeetingPrepSkill instance (may or may not have a current brief)
 * @returns A context block string, or empty string if no brief
 */
export function buildComputerUseContext(prepSkill: MeetingPrepSkill | null): string {
  if (!prepSkill?.currentBrief) return "";
  return prepSkill.getComputerBrief();
}

/**
 * Format a task completion event for the transcript.
 * This gets added to SharedContext.transcript so both Voice and ComputerUse can see it.
 *
 * @param task - Description of what was done
 * @param result - Outcome
 * @param durationMs - How long it took
 */
export function formatTaskCompletion(
  task: string,
  result: string,
  durationMs: number,
): string {
  const seconds = Math.round(durationMs / 1000);
  return `[Computer Use Done] ${task} → ${result} (${seconds}s)`;
}

// ── Integration Points ──
//
// These are the exact code changes needed to wire this into the existing system.
// See inline comments for where each change goes.

/**
 * INTEGRATION 1: ComputerUseModule.execute()
 *
 * In computer-use.ts, the system prompt already has a contextBlock injection point.
 * Replace the ContextSync-based brief with the Meeting Prep Brief:
 *
 *   // OLD (ContextSync):
 *   const contextBrief = this._contextSync?.getBrief().computer || "";
 *
 *   // NEW (Meeting Prep):
 *   import { buildComputerUseContext } from "../computer-use-context";
 *   const contextBrief = buildComputerUseContext(this._meetingPrep);
 *
 * The _meetingPrep is set via a setter, same pattern as _contextSync.
 */

/**
 * INTEGRATION 2: After ComputerUseModule.execute() returns
 *
 * In callingclaw.ts, after a computer_action tool call completes:
 *
 *   const result = await computerUse.execute(instruction);
 *   // Notify Voice AI that the task is done
 *   if (meetingPrepSkill.currentBrief) {
 *     notifyTaskCompletion(voiceModule, meetingPrepSkill, instruction, result.summary);
 *   }
 *   // Also add to transcript for persistence
 *   context.addTranscript({
 *     role: "system",
 *     text: formatTaskCompletion(instruction, result.summary, durationMs),
 *     ts: Date.now(),
 *   });
 */

/**
 * INTEGRATION 3: OpenClaw task delegation
 *
 * When ComputerUse delegates to OpenClaw (Path A), the task + result
 * are already logged in the transcript by computer-use.ts.
 * Voice AI sees these via its tool call results.
 *
 * For extra clarity, we can ALSO push a liveNote:
 *
 *   // In the openclaw tool handler in computer-use.ts:
 *   if (this._meetingPrep?.currentBrief) {
 *     this._meetingPrep.addLiveNote(`[OpenClaw] ${task.slice(0, 100)}: ${result.slice(0, 100)}`);
 *   }
 */
