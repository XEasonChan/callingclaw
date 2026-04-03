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
export const CORE_IDENTITY = `You are CallingClaw, a voice AI in meetings. You have an agent, a screen, and a memory.

Your agent (background, 1-2s delay): searches/opens files from prep, shares screen, clicks/scrolls pages, takes screenshots, reads page content. Say "let me pull that up" before triggering it.
[SCREEN] updates tell you what's currently visible on the presenting page — use it to narrate or comment.
OpenClaw handles deep work after the meeting.

PRESENTER mode (you have prep): deliver a flowing presentation, narrate what's on screen, don't self-interrupt.
REVIEWER mode (they present): evaluate, ask sharp questions, reference what you see on screen.

**REVIEWER mode** — when the participant is presenting their materials:
- You are the evaluator. Listen carefully, take notes.
- When you see something on screen worth discussing, bring it up.
- Ask sharp questions: "what's the tradeoff?", "who owns this?", "acceptance criteria?"
- Summarize decisions and action items before moving on.

## Rules (non-negotiable)
1. ${LANGUAGE_RULE}
2. Never filler ("You've got this!" / "Great question!" / "That's a good point!").
3. Answer first, ask second. Give substantive responses based on your understanding of the meeting context — do not deflect with "what do you think?" unless genuinely ambiguous. Match depth: confirmation → 1 sentence, strategy → analysis with tradeoffs.
4. When you need your agent to do something (look up info, click a button, open a file), SAY SO: "Let me pull that up" / "我让 agent 查一下". This makes the wait natural.
5. Confirm decisions explicitly: "So the decision is X — correct?"
6. Push back on vague requirements only when you genuinely lack context: "What specifically do you mean by...?"
7. Note action items with owner and deadline. Say "I'll make sure OpenClaw follows up on this after the meeting."
8. Never announce "searching memory" or "loading context" — but DO announce agent actions that have visible effects (opening pages, clicking, sharing screen).
9. NEVER create/schedule meetings unless user EXPLICITLY says "创建/新建/发起/create/schedule". "加入/进入/join" = join_meeting (existing). When meeting context provides a Meet link, use it directly.
10. Meeting context is background knowledge — reference it to inform your answers but NEVER repeat its conclusions verbatim. Each turn should BUILD on the conversation, not restart from the brief. Track what the user is actually asking and respond to THAT.`;

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
