import { test, expect, describe } from "bun:test";
import { extractMatchTokens, keywordOverlapScore, countTokenHits } from "../../src/utils/text-match";

describe("extractMatchTokens", () => {
  test("Chinese run: overlapping character bigrams", () => {
    expect(extractMatchTokens("定价策略")).toEqual(["定价", "价策", "策略"]);
  });

  test("single-char CJK run yields the single char (when not a stopword)", () => {
    const tokens = extractMatchTokens("A猫B"); // 猫 = cat, isolated by latin letters
    expect(tokens).toContain("猫");
  });

  test("single-char CJK stopword run is dropped", () => {
    expect(extractMatchTokens("的")).toEqual([]);
  });

  test("latin words longer than 2 chars are kept, shorter ones dropped", () => {
    const tokens = extractMatchTokens("Hi CallingClaw is great");
    expect(tokens).toContain("callingclaw");
    expect(tokens).toContain("great");
    expect(tokens).not.toContain("hi"); // length 2
    expect(tokens).not.toContain("is"); // length 2 + stopword
  });

  test("mixed CJK + latin + digits text", () => {
    const tokens = extractMatchTokens("定价策略 pricing $19.99");
    expect(tokens).toEqual(expect.arrayContaining(["定价", "价策", "策略", "pricing"]));
    // "19" and "99" are digit runs but not longer than 2 chars, so dropped
    expect(tokens).not.toContain("19");
    expect(tokens).not.toContain("99");
  });

  test("English stopwords filtered even though longer than 2 chars", () => {
    const tokens = extractMatchTokens("the cat and the dog");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).toContain("cat");
    expect(tokens).toContain("dog");
  });

  test("empty string yields no tokens", () => {
    expect(extractMatchTokens("")).toEqual([]);
  });

  test("punctuation-only / whitespace-only text yields no tokens", () => {
    expect(extractMatchTokens("   ,，。!!  ")).toEqual([]);
  });

  test("CJK interrogatives are stripped before bigramming", () => {
    // "是什么情况" scaffolding must not leak bigrams (是什/什么/么情) that
    // coincidentally match any context containing a question
    expect(extractMatchTokens("竞品是什么情况")).toEqual(["竞品", "情况"]);
    expect(extractMatchTokens("为什么")).toEqual([]);
    expect(extractMatchTokens("是什么")).toEqual([]);
    expect(extractMatchTokens("有没有多少")).toEqual([]);
  });

  test("CJK runs split on single-char function words before bigramming", () => {
    // 的 splits the run — no 们的/的定 bigrams spanning it
    const tokens = extractMatchTokens("我们的定价");
    expect(tokens).toContain("我们");
    expect(tokens).toContain("定价");
    expect(tokens).not.toContain("们的");
    expect(tokens).not.toContain("的定");
  });
});

describe("keywordOverlapScore", () => {
  test("full overlap -> 1", () => {
    const tokens = extractMatchTokens("CallingClaw pricing");
    expect(keywordOverlapScore(tokens, "CallingClaw pricing plan")).toBe(1);
  });

  test("no overlap -> 0", () => {
    const tokens = extractMatchTokens("CallingClaw pricing");
    expect(keywordOverlapScore(tokens, "completely unrelated text")).toBe(0);
  });

  test("partial overlap is a fraction of query tokens", () => {
    const tokens = extractMatchTokens("alpha beta"); // 2 tokens
    expect(keywordOverlapScore(tokens, "alpha only")).toBeCloseTo(0.5);
  });

  test("empty query tokens -> 0", () => {
    expect(keywordOverlapScore([], "anything")).toBe(0);
  });

  test("empty text -> 0", () => {
    const tokens = extractMatchTokens("alpha");
    expect(keywordOverlapScore(tokens, "")).toBe(0);
  });
});

describe("countTokenHits", () => {
  test("counts absolute hits, not fraction", () => {
    const tokens = extractMatchTokens("alpha beta gamma");
    expect(countTokenHits(tokens, "alpha and gamma here")).toBe(2);
  });

  test("case-insensitive", () => {
    const tokens = extractMatchTokens("CallingClaw");
    expect(countTokenHits(tokens, "I love CALLINGCLAW")).toBe(1);
  });

  test("zero hits when nothing overlaps", () => {
    const tokens = extractMatchTokens("alpha beta");
    expect(countTokenHits(tokens, "xyz unrelated")).toBe(0);
  });
});

describe("Chinese phrase matching (regression: naive `.split(/\\s+/)` collapses CJK into one unmatchable token)", () => {
  test("bigram overlap lets a Chinese query match text containing the phrase", () => {
    const query = "定价策略是什么";
    const tokens = extractMatchTokens(query);
    // With the old `query.toLowerCase().split(/\s+/)` approach, the whole query would be
    // ONE token ("定价策略是什么") that never substring-matches unless repeated verbatim.
    const text = "我们的定价策略是一次性付费 $19.99 买断";
    expect(countTokenHits(tokens, text)).toBeGreaterThanOrEqual(2);
    expect(keywordOverlapScore(tokens, text)).toBeGreaterThanOrEqual(0.3);
  });

  test("function-word bigrams no longer produce coincidental hits", () => {
    // 是 splits the run and 多少 is stripped → tokens: 定价,价策,策略,略费,钱.
    // The old tokenizer emitted 费是/是多 — "收费是全年最低" matched via 费是.
    const tokens = extractMatchTokens("定价策略费是多少钱");
    const text = "这次收费是全年最低的价格，非常划算"; // unrelated topic
    expect(countTokenHits(tokens, text)).toBe(0);
  });

  test("a single coincidental bigram hit does not clear a >=2-hits / >=30% bar", () => {
    const query = "定价策略方案文档"; // bigrams: 定价,价策,策略,略方,方案,案文,文档
    const tokens = extractMatchTokens(query);
    // Shares only "方案" by coincidence — unrelated topic.
    const text = "这个方案大家回头再对一下细节";
    const hits = countTokenHits(tokens, text);
    const score = keywordOverlapScore(tokens, text);
    expect(hits).toBe(1);
    expect(score).toBeLessThan(0.3);
    expect(hits >= 2 || score >= 0.3).toBe(false);
  });

  test("interrogative scaffolding alone cannot match a context (竞品是什么情况)", () => {
    const tokens = extractMatchTokens("竞品是什么情况");
    // Context that would have matched via 是什/什么 bigrams under the old tokenizer
    const text = "我们看一下这是什么原因导致的";
    expect(countTokenHits(tokens, text)).toBe(0);
    expect(keywordOverlapScore(tokens, text)).toBe(0);
  });

  test("English queries still match English text via whole-word tokens", () => {
    const tokens = extractMatchTokens("pricing model question");
    const text = "Q: What is the pricing model? A: One-time purchase at $19.99";
    expect(countTokenHits(tokens, text)).toBeGreaterThanOrEqual(2);
  });
});
