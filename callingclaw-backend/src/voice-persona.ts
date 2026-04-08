// CallingClaw 2.0 — Voice AI Persona & Meeting Context Sync
// ═══════════════════════════════════════════════════════════════════
// This is the "fast thinking" (System 1) component configuration.
//
// The Voice AI (OpenAI Realtime) is optimized for:
//   - Low latency real-time conversation
//   - Inspirational dialogue — guiding discussion, asking clarifying questions
//   - Recording user requirements and decisions
//   - Narrating Computer Use actions
//
// It does NOT do deep reasoning or file reading — that's OpenClaw's job.
// Instead, it receives a Meeting Prep Brief from OpenClaw and uses that
// as its conversational context.
//
// ── Sync Mechanism ──
//
//   1. PRE-MEETING:  MeetingPrepSkill.generate() → brief
//                    buildVoiceInstructions(brief) → system prompt
//                    VoiceModule.start(instructions)  [session.update, set ONCE]
//
//   2. DURING MEETING: OpenClaw adds live notes → MeetingPrepSkill.addLiveNote()
//                      pushContextUpdate() → conversation.item.create (INCREMENTAL)
//                      Computer Use completes task → recordTaskCompletion()
//                      → pushContextUpdate() → Voice AI sees it on next turn
//                      NOTE: No more session.update during meetings — avoids audio breaks
//
//   3. POST-MEETING:  Voice transcript → OpenClaw processes
//                     Meeting notes saved to OpenClaw memory
//
// ── Files ──
//   meeting-prep.ts  → Generates the brief (slow thinking)
//   voice-persona.ts → This file: consumes the brief (fast thinking)
//   computer-use.ts  → Gets file paths/URLs from brief (execution layer)
// ═══════════════════════════════════════════════════════════════════

import type { VoiceModule } from "./modules/voice";
import type { MeetingPrepSkill, MeetingPrepBrief } from "./skills/meeting-prep";
import type { CalendarAttendee } from "./mcp_client/google_cal";
import type { EventBus } from "./modules/event-bus";
import {
  CORE_IDENTITY,
  MISSION_CONTEXT_PREFIX,
  MISSION_CONTEXT_SUFFIX,
  PREP_TOOL_HINT,
} from "./prompt-constants";

// ══════════════════════════════════════════════════════════════
// 1. LAYER 0 — CORE IDENTITY (re-exported for convenience)
//    See prompt-constants.ts for the canonical definition.
//    This is the ONLY content sent via session.update instructions.
//    Budget: <200 tokens.
// ══════════════════════════════════════════════════════════════

export { CORE_IDENTITY };

// Legacy aliases — deprecated, use CORE_IDENTITY directly.
// These exist so callers that import DEFAULT_PERSONA / MEETING_PERSONA
// continue to compile, but they now return the same Layer 0 identity.
/** @deprecated Use CORE_IDENTITY instead */
export const DEFAULT_PERSONA = CORE_IDENTITY;
/** @deprecated Use CORE_IDENTITY instead */
export const MEETING_PERSONA = CORE_IDENTITY;

// ══════════════════════════════════════════════════════════════
// 3. BUILD VOICE INSTRUCTIONS (combines persona + brief)
// ══════════════════════════════════════════════════════════════

/**
 * Build Layer 0 system instructions for Voice AI.
 *
 * ALWAYS returns CORE_IDENTITY — the brief is no longer bundled here.
 * Meeting context (brief) is injected separately as Layer 2 via
 * injectMeetingBrief() → conversation.item.create.
 *
 * See CONTEXT-ENGINEERING.md for the full 5-layer strategy.
 *
 * @param brief - Ignored (kept for backward compatibility). Use injectMeetingBrief() instead.
 * @returns Layer 0 system prompt string for session.update instructions
 */
export function buildVoiceInstructions(_brief?: MeetingPrepBrief | null): string {
  return CORE_IDENTITY;
}

/**
 * Build the Layer 2 meeting brief text for injection via conversation.item.create.
 * This is injected ONCE after session starts — not in session.update instructions.
 *
 * @param brief - Meeting Prep Brief from MeetingPrepSkill
 * @returns Formatted meeting context string, or null if no brief
 */
export function buildMeetingBriefContext(brief: MeetingPrepBrief | null | undefined): string | null {
  if (!brief) return null;

  // ── Playbook path: if speakingPlan exists, inject slim speaking plan ──
  if (brief.speakingPlan && brief.speakingPlan.length > 0) {
    return buildPlaybookContext(brief);
  }

  // ── Slim brief: ~250 tokens, details available on-demand via read_prep tool ──
  const parts: string[] = [];

  parts.push(MISSION_CONTEXT_PREFIX);
  parts.push(`Topic: ${brief.topic}`);
  parts.push(`Goal: ${brief.goal}`);

  // Resources promoted to top — most actionable info for tool calls
  const hasFiles = brief.filePaths?.length > 0;
  const hasUrls = brief.browserUrls?.length > 0;
  if (hasFiles || hasUrls) {
    parts.push("\nRESOURCES:");
    if (hasFiles) {
      for (const f of brief.filePaths) {
        const name = f.path.split("/").pop() || f.path;
        parts.push(`📎 ${name} — ${f.description}`);
      }
    }
    if (hasUrls) {
      for (const u of brief.browserUrls) {
        parts.push(`🔗 ${u.description} — ${u.url}`);
      }
    }
  }

  // Top 3 key points only (full list via read_prep("all_points"))
  if (brief.keyPoints?.length > 0) {
    parts.push("\nKEY POINTS:");
    for (const pt of brief.keyPoints.slice(0, 3)) {
      parts.push(`- ${pt}`);
    }
    if (brief.keyPoints.length > 3) {
      parts.push(`(${brief.keyPoints.length - 3} more via read_prep)`);
    }
  }

  // Attendees
  if (brief.attendees?.length > 0) {
    const others = brief.attendees.filter((a) => !a.self);
    if (others.length > 0) {
      parts.push(`\nAttendees: ${others.map((a) => a.displayName || a.email).join(", ")}`);
    }
  }

  parts.push(`\n${PREP_TOOL_HINT}`);
  parts.push(MISSION_CONTEXT_SUFFIX);

  return parts.join("\n");
}

/**
 * Build Layer 2 context from a playbook-format brief.
 * Injects the speaking plan (phase 0 + scene 0-1) for progressive injection.
 * Subsequent phases are injected by PresentationEngine.runScenes() as scenes advance.
 */
function buildPlaybookContext(brief: MeetingPrepBrief): string {
  const parts: string[] = [];
  const plan = brief.speakingPlan!;
  const scenes = brief.scenes || [];

  parts.push(MISSION_CONTEXT_PREFIX);
  parts.push(`Topic: ${brief.topic}`);
  parts.push(`Goal: ${brief.goal}`);

  // Speaking plan overview (phase names + time budgets)
  parts.push(`\nSPEAKING PLAN (${plan.length} phases):`);
  for (const phase of plan) {
    parts.push(`- ${phase.phase} (~${phase.durationMin}min): ${phase.points}`);
  }

  // Current scene only (subsequent scenes via read_prep("scene", n))
  if (scenes.length > 0) {
    parts.push(`\nCURRENT SCENE [1/${scenes.length}]:`);
    parts.push(scenes[0]!.talkingPoints);
    if (scenes.length > 1) {
      parts.push(`(${scenes.length - 1} more scenes — use read_prep("scene", n) to load)`);
    }
  }

  // Decision points
  if (brief.decisionPoints && brief.decisionPoints.length > 0) {
    parts.push(`\nDECISIONS TO DRIVE:`);
    for (const dp of brief.decisionPoints) {
      parts.push(`- ${dp}`);
    }
  }

  parts.push(`\n${PREP_TOOL_HINT}`);
  parts.push(MISSION_CONTEXT_SUFFIX);
  parts.push("PRESENTER mode. Follow the speaking plan. Use read_prep for Q&A strategies and scene details.");

  return parts.join("\n");
}

// buildSceneContext deleted — voice model drives presentation natively with screenshot feedback

/**
 * Inject the meeting brief into the live voice session as a Layer 2 context item.
 * Call this ONCE after session starts (after session.updated event).
 *
 * @returns The context item ID if injected, false if not connected or no brief
 */
export function injectMeetingBrief(
  voiceModule: VoiceModule,
  brief: MeetingPrepBrief | null | undefined,
): string | false {
  const briefText = buildMeetingBriefContext(brief);
  if (!briefText) return false;
  return voiceModule.injectContext(briefText);
}

// ══════════════════════════════════════════════════════════════
// 4. DYNAMIC CONTEXT PUSH (during meeting) — INCREMENTAL
// ══════════════════════════════════════════════════════════════

// Track the last injected liveNote index to avoid re-injecting old notes
let _lastInjectedNoteIndex = -1;

/** Reset the injection tracker (call when a new meeting starts) */
export function resetContextInjectionState() {
  _lastInjectedNoteIndex = -1;
}

/**
 * Push the latest context to the live Voice session — incrementally.
 *
 * Instead of rebuilding the entire system prompt (session.update),
 * this injects only NEW liveNotes as conversation items (conversation.item.create).
 * This avoids interrupting in-progress responses and audio breaks.
 *
 * Call this when:
 *   - ContextRetriever finds new context → addLiveNote() → pushContextUpdate()
 *   - TranscriptAuditor completes/suggests → addLiveNote() → pushContextUpdate()
 *   - Computer Use completes a task → notifyTaskCompletion() → pushContextUpdate()
 *
 * @returns true if at least one new note was injected
 */
export function pushContextUpdate(
  voiceModule: VoiceModule,
  prepSkill: MeetingPrepSkill,
  eventBus?: EventBus,
): boolean {
  const brief = prepSkill.currentBrief;
  if (!brief) return false;
  if (!voiceModule.connected) return false;

  const notes = brief.liveNotes;
  if (notes.length === 0) return false;

  // Only inject notes that haven't been injected yet
  const startIdx = _lastInjectedNoteIndex + 1;
  if (startIdx >= notes.length) return false; // No new notes

  let injected = 0;
  for (let i = startIdx; i < notes.length; i++) {
    const note = notes[i]!;
    const itemId = voiceModule.injectContext(note);
    if (itemId) {
      injected++;
      console.log(`[VoicePersona] Injected context #${i}: ${note.slice(0, 80)}...`);
    }
  }

  _lastInjectedNoteIndex = notes.length - 1;

  if (injected > 0) {
    eventBus?.emit("meeting.context_pushed", {
      topic: brief.topic,
      liveNotesCount: notes.length,
      injectedCount: injected,
      method: "incremental",
      timestamp: Date.now(),
    });
  }

  return injected > 0;
}

/**
 * Notify Voice AI that a Computer Use task has completed.
 * This adds a live note AND pushes the updated context to Voice.
 *
 * @param task - What was requested (e.g., "open CallingClaw PRD")
 * @param result - What happened (e.g., "opened in Chrome")
 * @returns The formatted completion message
 */
export function notifyTaskCompletion(
  voiceModule: VoiceModule,
  prepSkill: MeetingPrepSkill,
  task: string,
  result: string,
  eventBus?: EventBus,
): string {
  const entry = prepSkill.recordTaskCompletion(task, result);
  pushContextUpdate(voiceModule, prepSkill, eventBus);
  return entry;
}

// ══════════════════════════════════════════════════════════════
// 5. MEETING LIFECYCLE HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Start a meeting session with a prep brief.
 * This is the main entry point — call this before Voice.start()
 *
 * Returns Layer 0 instructions (for session.update) AND the brief (for Layer 2 injection).
 * Callers should:
 *   1. voice.start(instructions)            → sets Layer 0
 *   2. injectMeetingBrief(voice, brief)     → sets Layer 2
 */
export async function prepareMeeting(
  prepSkill: MeetingPrepSkill,
  topic: string,
  userContext?: string,
  attendees?: CalendarAttendee[],
  meetingId?: string,
): Promise<{ brief: MeetingPrepBrief; instructions: string; briefContext: string | null }> {
  const brief = await prepSkill.generate(topic, userContext, attendees, meetingId);
  const instructions = buildVoiceInstructions();
  const briefContext = buildMeetingBriefContext(brief);
  return { brief, instructions, briefContext };
}

/**
 * Get post-meeting summary data for OpenClaw to process.
 * Returns: brief + live notes + what to save to memory.
 */
export function getPostMeetingSummary(prepSkill: MeetingPrepSkill): {
  topic: string;
  liveNotes: string[];
  completedTasks: string[];
  requirements: string[];
} | null {
  const brief = prepSkill.currentBrief;
  if (!brief) return null;

  return {
    topic: brief.topic,
    liveNotes: brief.liveNotes,
    completedTasks: brief.liveNotes.filter((n) => n.startsWith("[DONE]")),
    requirements: brief.liveNotes.filter((n) => n.startsWith("[REQ]")),
  };
}

/**
 * Build a self-introduction message for when CallingClaw joins a meeting.
 * Tells participants: who it is, whose assistant, and what it will do.
 *
 * The message is sent as text to the Voice AI, which speaks it aloud.
 * Keep it concise — ~15 seconds of speech max.
 */
export function buildMeetingIntro(ownerName: string, topic: string): string {
  // No hardcoded language templates. The voice model speaks whatever language
  // the meeting title implies (57+ languages on OpenAI, 97+ on Gemini).
  // If participants speak a different language, switch to match them.
  return [
    `Introduce yourself briefly as CallingClaw${ownerName ? `, ${ownerName}'s AI meeting assistant` : ", an AI meeting assistant"}.`,
    topic ? `Today's topic: "${topic}".` : "",
    `You take notes, track action items, and review context from memory.`,
    `Keep it to 2-3 natural sentences. Start in the language of the meeting title, but always switch to match whatever language the participants actually speak.`,
  ].filter(Boolean).join(" ");
}

// ── Standalone Presentation Context (test mode, no meeting brief) ────

/**
 * Build Layer 2 context for standalone presentation test mode.
 * Gives the voice AI full story context so it can present intelligently
 * and handle questions/interruptions about the content.
 */
export function buildTestPresentationContext(
  brief: { goal?: string; summary?: string; keyPoints?: string[]; architectureDecisions?: Array<{ decision: string; rationale: string }>; expectedQuestions?: Array<{ question: string; suggestedAnswer: string }> },
  plan: { topic: string; slides: Array<{ sectionTitle: string; talkingPoints: string }> },
): string {
  const parts: string[] = [];
  parts.push(`═══ PRESENTATION CONTEXT ═══`);
  parts.push(`Topic: ${plan.topic}`);
  if (brief.goal) parts.push(`Goal: ${brief.goal}`);
  if (brief.summary) parts.push(`Summary: ${brief.summary}`);

  if (plan.slides.length > 0) {
    parts.push(`\nSPEAKING PLAN (${plan.slides.length} slides):`);
    for (const [i, s] of plan.slides.entries()) {
      parts.push(`${i + 1}. ${s.sectionTitle}: ${s.talkingPoints.slice(0, 80)}...`);
    }
  }

  if (brief.keyPoints?.length) {
    parts.push(`\nKEY POINTS (order of importance):`);
    for (const p of brief.keyPoints) parts.push(`- ${p}`);
  }

  if (brief.architectureDecisions?.length) {
    parts.push(`\nKEY DECISIONS:`);
    for (const d of brief.architectureDecisions) parts.push(`- ${d.decision} — because: ${d.rationale}`);
  }

  if (brief.expectedQuestions?.length) {
    parts.push(`\nQ&A STRATEGIES:`);
    for (const q of brief.expectedQuestions.slice(0, 5)) parts.push(`Q: ${q.question} → ${q.suggestedAnswer}`);
  }

  parts.push(`\n═══ END PRESENTATION CONTEXT ═══`);
  parts.push(`You are in PRESENTER mode. The user is watching your screen (Playwright browser).`);
  parts.push(`Present each slide naturally. The user may interrupt to ask questions — answer from the context above.`);
  parts.push(`The user may request actions: "scroll up", "click that button", "go back" — the system will execute these automatically.`);

  return parts.join("\n");
}

// ── Small Talk → Presentation transition prompts ──────────────────
// Provider-agnostic: injected into any voice model (Gemini, Grok, OpenAI)
// when a meeting has prepared scenes but should start with casual chat.

/**
 * Build the "presentation ready" context injection.
 * Tells the voice AI that slides are available but it should chat first.
 * The AI decides when to call share_screen based on conversation flow.
 */
export function buildPresentationReadyContext(scenes: Array<{ url: string; talkingPoints?: string }>): string {
  return (
    `[PRESENTATION READY] You have ${scenes.length} prepared slides for this meeting.\n` +
    `First slide: ${scenes[0]?.url || "unknown"}\n` +
    `DO NOT present yet — start with small talk. Greet participants, confirm the agenda, ` +
    `ask if everyone is ready. When they express intent to start (e.g. "let's start", ` +
    `"show me", "go ahead", "dive in"), call share_screen with the first scene URL.\n` +
    `If nobody has real conversation for ~30 seconds, proactively offer to start presenting.`
  );
}

/**
 * Build the idle nudge injection.
 * Sent after ~30s of no real conversation to prompt AI to offer presenting.
 */
export function buildIdleNudgeContext(): string {
  return (
    `[IDLE NUDGE] The meeting has been quiet for a while. Proactively offer to start ` +
    `presenting. Say something natural like "I have some materials prepared, shall I share my screen?"`
  );
}
