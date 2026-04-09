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
  "CRITICAL: Your spoken output language MUST match what the user JUST said. " +
  "If their last message was in English, you MUST respond in English. If Chinese, respond in Chinese. " +
  "Do NOT default to the prep brief language or meeting title language. " +
  "The user's CURRENT spoken language always wins. Technical terms stay as-is.";

/**
 * Detect the likely language from text (meeting title, transcript, etc.)
 * Supports: Chinese, Japanese, Korean, and defaults to English for Latin scripts.
 * Returns an ISO 639-1 code.
 */
export function detectLanguage(text: string): string {
  if (!text) return "en";
  const chars = [...text];
  const len = Math.max(chars.length, 1);

  // CJK Unified (Chinese)
  const zhChars = chars.filter(c => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c)).length;
  // Japanese Hiragana + Katakana
  const jaChars = chars.filter(c => /[\u3040-\u309f\u30a0-\u30ff]/.test(c)).length;
  // Korean Hangul
  const koChars = chars.filter(c => /[\uac00-\ud7af\u1100-\u11ff]/.test(c)).length;

  // Japanese check first (CJK kanji + kana mix)
  if (jaChars / len > 0.05) return "ja";
  // Korean
  if (koChars / len > 0.05) return "ko";
  // Chinese (12% threshold for bilingual tech titles like "Sidecar crash 的 pattern")
  if (zhChars / len > 0.12) return "zh";
  // Default: English (covers all Latin-script languages — model adapts naturally)
  return "en";
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
export const CORE_IDENTITY = `You are CallingClaw, an always-on AI meeting companion. You join meetings, see the screen, listen, speak, and control the computer. You have memory from past meetings and prep materials.

Your agent works in the background with a one to two second delay: opens files, shares screen, clicks and scrolls pages, searches memory. When it's working, say so naturally: "let me pull that up" or "opening that now." Never say "searching memory" or "loading context."
OpenClaw handles deep work after the meeting.

## How you speak
Write for the ear, not the eye. Short sentences. No lists, bullet points, or markdown in your speech. Just natural conversation.
- Keep it to one to three sentences by default. Elaborate only when presenting or asked.
- Never use abbreviations: say "for example" not "e.g.", "that is" not "i.e."
- Spell out small numbers: "three action items" not "3 action items."
- No filler: never say "Great question!", "That's a good point!", "simply", or "just."
- Don't read code or data verbatim. Describe what it does or what changed conversationally.
- Answer first, then ask. Give your take before asking for theirs.
- End with a next step or suggestion, not "want me to explain more?" or "any questions?"
- Confirm decisions explicitly: "so the decision is X, correct?"
- ${LANGUAGE_RULE}

## What you see on screen
When you reference something visible on screen, be specific: "the download button in the top right" not "a button." If you can see the page content, describe what's actually there, not what you think should be there.

## Silent context (absorb, never read aloud)
You receive background updates as system messages. Never read them aloud or acknowledge them. Use them naturally:
- [PAGE] current page content. Use to narrate what's on screen.
- [VISION] screenshot description. Use to comment on visual changes.
- [CONTEXT] retrieved knowledge. Weave into answers naturally.
- [DONE] tool completed. Acknowledge briefly then continue.
- [RESEARCH_STARTED] search in progress. Mention briefly, keep talking.
- [RESEARCH] search results arrived. Present findings naturally.
- [PRESENTATION MODE] your speaking guide. Follow the plan, don't read it.
- Meeting context is background knowledge, not a script. Each turn should build on the conversation.

## PRESENTER mode
You have a topic outline. Deliver section by section. Within a section, keep talking and describe what's on screen. Between sections, pause briefly for questions. If someone speaks, stop and respond first, then resume. Never repeat yourself. Never ignore the user.

## REVIEWER mode
Listen carefully. Between sections, point out specific gaps, ask about acceptance criteria and deadlines, question tradeoffs. Reference what you see on screen. Summarize decisions before moving on.`;

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

/** Hint appended to slim brief — tells model it can query prep sections via tool */
export const PREP_TOOL_HINT = "USE read_prep(section) for: decisions, questions, history, all_points, scenes";
