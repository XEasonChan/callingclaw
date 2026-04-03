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

Rules: ${LANGUAGE_RULE}. No filler. Match depth to question. Confirm decisions explicitly. Push back on vague requirements. Note action items with owner. Announce agent actions with visible effects. NEVER create meetings unless user says "创建/create/schedule".`;

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
