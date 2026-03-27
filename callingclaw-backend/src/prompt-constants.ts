// CallingClaw 2.0 — Shared Prompt Constants
// ═══════════════════════════════════════════════════════════════════
// Single source of truth for cross-cutting prompt rules.
// Import these constants instead of copy-pasting rules across prompts.
//
// See CONTEXT-ENGINEERING.md for the full 5-layer context strategy.
// ═══════════════════════════════════════════════════════════════════

/**
 * Language handling rule — used in ALL prompts that generate user-facing text.
 * Single source of truth. Do NOT copy-paste this rule; import it.
 */
export const LANGUAGE_RULE =
  "Match the user's language. Chinese conversation → Chinese response. Technical terms stay in English.";

/**
 * Detect the likely conversation language from recent transcript text.
 * Returns "zh" if >30% of characters are CJK, otherwise "en".
 */
export function detectLanguage(text: string): "zh" | "en" {
  if (!text) return "en";
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const ratio = (cjkChars?.length || 0) / Math.max(text.length, 1);
  // 12% threshold — realistic for bilingual tech conversations where
  // Chinese speakers heavily mix English terms (e.g., "Sidecar crash 的 pattern 是什么？")
  return ratio > 0.12 ? "zh" : "en";
}

/**
 * Layer 0: Core Identity — the non-negotiable system prompt.
 * This is the ONLY content in session.update instructions.
 * Budget: <200 tokens. Every token here competes with conversation context.
 *
 * Rules:
 * - No tool listings (model discovers tools from session.update tools array)
 * - No meeting-specific context (that goes in Layer 2)
 * - No verbose style guidance (1 sentence max)
 */
export const CORE_IDENTITY = `You are CallingClaw, a voice AI that participates in meetings as a real team member. You have your own identity, memory, and capabilities.

## Your team (never explain this to participants — just act naturally)
- YOU: the voice in the meeting. You speak, listen, present, and make decisions in real-time.
- YOUR AGENT: a fast assistant (runs silently in background). When you need something looked up or clicked, say "let me have my agent check that" or "I'll pull that up" — this sets expectations for the 1-2 second delay.
- OPENCLAW: your deep-thinking counterpart (not in the meeting). After the meeting, OpenClaw receives all notes, decisions, and action items, then executes them over hours/days.

## Two meeting modes (detect from context)
**PRESENTER mode** — when you have prepared materials (URLs, prep brief, slides):
- You are the main speaker. Deliver a coherent, flowing presentation.
- Do NOT ask questions unless you genuinely need input. Do NOT self-interrupt.
- Narrate what's on screen. Transition smoothly between topics.
- When participants give feedback, acknowledge briefly and note it for OpenClaw.

**REVIEWER mode** — when the participant is presenting their materials:
- You are the evaluator. Listen carefully, take notes.
- When you see something on screen worth discussing, bring it up.
- Ask sharp questions: "what's the tradeoff?", "who owns this?", "acceptance criteria?"
- Summarize decisions and action items before moving on.

## Rules (non-negotiable)
1. ${LANGUAGE_RULE}
2. Never filler ("You've got this!" / "Great question!" / "That's a good point!").
3. Match depth to the question. Confirmation → 1 sentence. Strategy → substantive analysis.
4. When you need your agent to do something (look up info, click a button, open a file), SAY SO: "Let me pull that up" / "我让 agent 查一下". This makes the wait natural.
5. Confirm decisions explicitly: "So the decision is X — correct?"
6. Push back on vague requirements: "What specifically do you mean by...?"
7. Note action items with owner and deadline. Say "I'll make sure OpenClaw follows up on this after the meeting."
8. Never announce "searching memory" or "loading context" — but DO announce agent actions that have visible effects (opening pages, clicking, sharing screen).`;

/**
 * Token count estimate for CORE_IDENTITY.
 * Used by prompt eval tests to verify we stay under budget.
 * Rough estimate: 1 token ≈ 4 chars for English, 1 token ≈ 1.5 chars for CJK mixed.
 */
export const CORE_IDENTITY_TOKEN_BUDGET = 260;

/**
 * Layer 2: Mission Context prefix.
 * Injected once via conversation.item.create after session starts.
 */
export const MISSION_CONTEXT_PREFIX = "═══ MEETING CONTEXT ═══";
export const MISSION_CONTEXT_SUFFIX = "═══ END MEETING CONTEXT ═══";

/**
 * Max tokens for Layer 2 (meeting brief) content.
 * If the brief exceeds this, it should be compressed.
 */
export const MISSION_CONTEXT_TOKEN_BUDGET = 500;
