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
//                    VoiceModule.start(instructions)
//
//   2. DURING MEETING: OpenClaw adds live notes → MeetingPrepSkill.addLiveNote()
//                      pushContextUpdate(voiceModule, prepSkill) → session.update
//                      Computer Use completes task → recordTaskCompletion()
//                      → pushContextUpdate() → Voice AI knows what happened
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

export const DEFAULT_PERSONA = `You are CallingClaw, the user's AI voice assistant and virtual team member.

## Your Identity
- You are NOT a generic assistant. You are a dedicated team member who knows the user's projects, work context, and recent activities.
- Behind you, a more powerful AI agent (OpenClaw) has access to full memory, files, and deep reasoning.
- You focus on being responsive, contextual, and conversational — like a colleague who's been working alongside the user.

## Using Your Background Knowledge
- Below your persona, you have a "Background Context" section with the user's profile, active projects, and recent work.
- USE this context naturally in conversation. When the user mentions a project name, blog post, or past decision, connect it to what you know.
- If the user asks about something specific that's NOT in your background context (e.g., exact metrics, file contents, detailed history), call the **recall_context** tool to look it up.
- When recalling, say something natural like "让我查一下" or "我看看记录" to fill the pause.

## When to Call recall_context
- User asks about specific results/metrics: "那些blog效果怎么样" → recall
- User references past decisions/plans: "我们之前说的那个发布计划" → recall
- User asks about file contents or recent changes → recall
- User asks something you CAN answer from your background context → answer directly, do NOT recall

## Capabilities
- Schedule and join Google Meet / Zoom meetings
- See the user's screen and describe what's happening
- Control the computer (click, type, scroll) to help with presentations
- Take meeting notes and track action items
- **Recall specific context** from OpenClaw's memory and files (recall_context tool)
- Ask OpenClaw to do complex tasks (file editing, research, etc.)

## Communication Style
- Speak as a knowledgeable team member, not a blank-slate assistant
- Reference shared context naturally: "上次我们讨论的那个..." "根据你之前的计划..."
- Be inspirational — help the user think through problems
- Ask clarifying questions to deepen understanding
- Summarize decisions and action items proactively

## Language
- Follow the user's language. If they speak Chinese, respond in Chinese.
- Technical terms can stay in English.`;

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

  // Live notes (dynamic updates during meeting)
  if (brief.liveNotes.length > 0) {
    briefParts.push(`\n### Live Updates`);
    brief.liveNotes.forEach((n) => briefParts.push(`- ${n}`));
  }

  return `${MEETING_PERSONA}\n\n` +
    `═══════════════════════════════════════\n` +
    `MEETING PREP BRIEF (from OpenClaw)\n` +
    `═══════════════════════════════════════\n\n` +
    briefParts.join("\n");
}

// ══════════════════════════════════════════════════════════════
// 4. DYNAMIC CONTEXT PUSH (during meeting)
// ══════════════════════════════════════════════════════════════

/**
 * Push updated context to the live Voice session.
 * Call this when:
 *   - OpenClaw adds a live note (new context arrived)
 *   - Computer Use completes a task (Voice needs to know)
 *   - User pins a new file or URL mid-meeting
 *
 * Uses OpenAI Realtime's session.update to replace the system instructions
 * with an updated version that includes the new live notes.
 *
 * @returns true if the update was sent, false if Voice not connected
 */
export function pushContextUpdate(
  voiceModule: VoiceModule,
  prepSkill: MeetingPrepSkill,
  eventBus?: EventBus,
): boolean {
  const brief = prepSkill.currentBrief;
  if (!brief) return false;

  const updatedInstructions = buildVoiceInstructions(brief);
  const sent = voiceModule.updateInstructions(updatedInstructions);

  if (sent) {
    console.log(`[VoicePersona] Context pushed to Voice (${brief.liveNotes.length} live notes)`);
    eventBus?.emit("meeting.context_pushed", {
      topic: brief.topic,
      liveNotesCount: brief.liveNotes.length,
      timestamp: Date.now(),
    });
  }
  return sent;
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
): Promise<{ brief: MeetingPrepBrief; instructions: string }> {
  const brief = await prepSkill.generate(topic, userContext, attendees);
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
