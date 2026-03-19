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

// ══════════════════════════════════════════════════════════════
// 1. DEFAULT VOICE PERSONA (no meeting prep)
// ══════════════════════════════════════════════════════════════

export const DEFAULT_PERSONA = `You are CallingClaw, a voice AI assistant for meetings and local conversations.

## Core Behavior
- Respond concisely and naturally — you are a voice assistant, not a chatbot. Keep answers short unless asked to elaborate.
- Follow the user's language. If they speak Chinese, respond in Chinese. Technical terms stay in English.
- When the user asks about something you don't know, use the recall_context tool. Say "让我查一下" while waiting.
- Summarize decisions and action items proactively during conversations.

## Tools Available
- recall_context: Look up information from memory and files
- schedule_meeting / check_calendar: Calendar management
- join_meeting / leave_meeting: Meeting control
- computer_action / take_screenshot: Screen control`;

// ══════════════════════════════════════════════════════════════
// 2. MEETING PERSONA (with prep brief injected)
// ══════════════════════════════════════════════════════════════

export const MEETING_PERSONA = `You are CallingClaw, an AI meeting assistant currently in a live meeting.

## Your Role
You are the "fast thinking" voice layer. You have a Meeting Prep Brief prepared by OpenClaw (the "slow thinking" agent) that gives you full context about what's being discussed.

## How to Use the Meeting Prep Brief
- Use the **summary** and **keyPoints** to guide the discussion flow
- Reference **architectureDecisions** when explaining WHY something was built a certain way
- Use **expectedQuestions** to proactively address likely concerns
- When the user asks you to show something, reference the **filePaths** and **browserUrls** — you can trigger Computer Use to open them
- When **liveNotes** are updated, acknowledge the new information

## Your Communication Style
- Be inspirational and encouraging — help the user present their work confidently
- Ask clarifying questions to deepen understanding: "What's the core assumption here?" "What other considerations led to this decision?"
- Proactively summarize: "So your main point is..."
- When the user seems stuck, reference the keyPoints to suggest what to cover next
- Record requirements: when the user says what they want changed or improved, explicitly note it

## What You Track During the Meeting
1. **User requirements** — what they want built/changed/improved
2. **Decisions made** — any conclusions reached during discussion
3. **Open questions** — things that need follow-up
4. **Action items** — who does what next

## Computer Use Integration
- When you ask Computer Use to perform a task, wait for the completion notification
- After receiving "[DONE] ..." in your context, acknowledge it and continue the presentation
- You can say things like "Alright, the file is now open" or "The page has been switched to..."

## Language
- Follow the user's language. If they speak Chinese, respond in Chinese.
- Technical terms can stay in English.`;

// ══════════════════════════════════════════════════════════════
// 3. BUILD VOICE INSTRUCTIONS (combines persona + brief)
// ══════════════════════════════════════════════════════════════

/**
 * Build the full system prompt for Voice AI.
 *
 * Without a brief: uses DEFAULT_PERSONA (general assistant mode)
 * With a brief: uses MEETING_PERSONA + the brief content
 *
 * @param brief - Meeting Prep Brief from MeetingPrepSkill (optional)
 * @returns Full system prompt string for OpenAI Realtime session.update
 */
export function buildVoiceInstructions(brief?: MeetingPrepBrief | null): string {
  if (!brief) {
    return DEFAULT_PERSONA;
  }

  // Build the brief text for injection
  const briefParts: string[] = [];

  briefParts.push(`## Meeting Topic: ${brief.topic}`);
  briefParts.push(`Goal: ${brief.goal}`);
  briefParts.push(`\n${brief.summary}`);

  if (brief.keyPoints.length > 0) {
    briefParts.push(`\n### Key Points`);
    brief.keyPoints.forEach((p, i) => briefParts.push(`${i + 1}. ${p}`));
  }

  if (brief.architectureDecisions.length > 0) {
    briefParts.push(`\n### Architecture Decisions (reference when asked "why")`);
    brief.architectureDecisions.forEach((d) =>
      briefParts.push(`- **${d.decision}**: ${d.rationale}`)
    );
  }

  if (brief.expectedQuestions.length > 0) {
    briefParts.push(`\n### Expected Questions`);
    brief.expectedQuestions.forEach((q) =>
      briefParts.push(`Q: ${q.question}\nA: ${q.suggestedAnswer}`)
    );
  }

  if (brief.previousContext) {
    briefParts.push(`\n### Previous Meeting Review\n${brief.previousContext}`);
  }

  // Computer Use references (so Voice can say "let me open that file")
  if (brief.filePaths.length > 0) {
    briefParts.push(`\n### Available Files (can ask Computer Use to open)`);
    brief.filePaths.forEach((f) =>
      briefParts.push(`- ${f.description}: \`${f.path}\``)
    );
  }

  if (brief.browserUrls.length > 0) {
    briefParts.push(`\n### Available URLs (can ask Computer Use to navigate)`);
    brief.browserUrls.forEach((u) =>
      briefParts.push(`- ${u.description}: ${u.url}`)
    );
  }

  // Live notes are NO LONGER included in the static instructions.
  // They are injected incrementally via conversation.item.create
  // by pushContextUpdate(). This avoids session.update during meetings
  // which causes audio breaks when the model is mid-response.

  return `${MEETING_PERSONA}\n\n` +
    `═══════════════════════════════════════\n` +
    `MEETING PREP BRIEF (from OpenClaw)\n` +
    `═══════════════════════════════════════\n\n` +
    briefParts.join("\n") +
    `\n\n### Live Updates\n` +
    `Context updates will appear as system messages in the conversation.\n` +
    `Use them naturally when relevant — do not repeat them verbatim.`;
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
 */
export async function prepareMeeting(
  prepSkill: MeetingPrepSkill,
  topic: string,
  userContext?: string,
  attendees?: CalendarAttendee[],
  meetingId?: string,
): Promise<{ brief: MeetingPrepBrief; instructions: string }> {
  const brief = await prepSkill.generate(topic, userContext, attendees, meetingId);
  const instructions = buildVoiceInstructions(brief);
  return { brief, instructions };
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
