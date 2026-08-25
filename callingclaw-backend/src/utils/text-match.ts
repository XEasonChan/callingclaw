// CallingClaw 2.0 — Lightweight Text Matching Utilities
// ═══════════════════════════════════════════════════════════════════
// Keyword-overlap matching for query/text pairs that may mix English
// and Chinese. Naive `.toLowerCase().split(/\s+/)` (used historically
// in a few recall paths) is broken for CJK text: there are no spaces,
// so an entire Chinese phrase collapses into ONE token that can never
// substring-match unless it's an exact phrase repeat.
//
// This module tokenizes CJK runs into overlapping character bigrams
// (the standard trick for whitespace-free languages — see also
// session-manager.ts's topicSimilarity) so partial phrase overlap
// ("定价策略" vs "...定价策略是...") still scores hits. Interrogatives and
// single-char function words are stripped/split BEFORE bigramming (mirrors
// context-retriever.ts's extractOverlapTokens) so question scaffolding like
// "是什么情况" cannot produce coincidental bigram matches.
//
// No external dependencies.
// ═══════════════════════════════════════════════════════════════════

/** Small zh+en stopword set — same spirit as context-retriever.ts's searchCache(). */
const STOPWORDS = new Set([
  // English
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in", "to", "for", "of", "with",
  // Chinese
  "的", "了", "在", "是", "有", "和", "就", "不", "也", "都", "这", "那", "你", "我", "他", "她", "吗", "呢",
]);

/** Interrogative words carry no topical signal — stripped before bigramming.
 * Longer forms first so "为什么" doesn't get partially eaten by "什么". */
const CJK_INTERROGATIVES = /为什么|是不是|有没有|能不能|怎么样|什么|怎么|怎样|多少|哪个|哪些|哪里|如何|来着/g;

/** Single-char CJK function words — runs are split on these so bigrams never
 * span them ("我们的定价" must not emit 们的/的定). */
const CJK_FUNCTION_SPLIT = /[\s的了是在有和就不也都这那吗呢吧啊]+/;

const CJK_CHAR = /[一-鿿]/;
const RUN_PATTERN = /[一-鿿]+|[a-z0-9]+/g;

/**
 * Extract match tokens from free-form text (lowercased first).
 * - CJK runs: interrogatives stripped, split on single-char function words,
 *   then overlapping character bigrams per segment (a 1-char segment yields
 *   the single char).
 * - Latin/digit runs: whole words longer than 2 chars.
 * - Stopwords (small zh+en set) are dropped from the result.
 */
export function extractMatchTokens(text: string): string[] {
  if (!text) return [];
  const runs = text.toLowerCase().match(RUN_PATTERN) || [];
  const tokens: string[] = [];

  for (const run of runs) {
    if (CJK_CHAR.test(run)) {
      for (const seg of run.replace(CJK_INTERROGATIVES, " ").split(CJK_FUNCTION_SPLIT)) {
        if (seg.length === 0) continue;
        if (seg.length === 1) {
          tokens.push(seg);
        } else {
          for (let i = 0; i < seg.length - 1; i++) {
            tokens.push(seg.slice(i, i + 2));
          }
        }
      }
    } else if (run.length > 2) {
      tokens.push(run);
    }
  }

  return tokens.filter((t) => !STOPWORDS.has(t));
}

/** Fraction (0..1) of queryTokens found as substrings in `text` (case-insensitive). */
export function keywordOverlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0 || !text) return 0;
  return countTokenHits(queryTokens, text) / queryTokens.length;
}

/** Absolute count of queryTokens found as substrings in `text` (case-insensitive). */
export function countTokenHits(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0 || !text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) hits++;
  }
  return hits;
}
