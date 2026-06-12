// CallingClaw Eval — TranscriptAuditor Intent Classification Suite
// Tests the Haiku LLM medium lane: transcript → action classification.
// Requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env.
// Run: bun eval/suites/transcript-auditor.eval.ts

import { describe, test, expect } from "bun:test";
import { transcriptAuditorCases } from "../datasets/transcript-auditor-scenarios";
import { runSuite, scoreToolCall } from "../runner";
import type {
  EvalSuite,
  EvalCase,
  EvalResult,
  TranscriptAuditorInput,
  TranscriptAuditorExpected,
  ToolCallActual,
} from "../types";
import { callModel, parseJSON } from "../../src/ai_gateway/llm-client";
import { CONFIG } from "../../src/config";

// ── Build the classification prompt (extracted from TranscriptAuditor.classifyIntent) ──
// We replicate the exact prompt the auditor uses so eval results reflect real behavior.

function buildClassificationPrompt(
  input: TranscriptAuditorInput,
): string {
  const brief = input.meetingBrief;

  const transcriptText = input.transcript
    .map(
      (e) =>
        `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`
    )
    .join("\n");

  return `You are CallingClaw's meeting agent — a fast background assistant. You monitor the conversation and execute actions when the voice AI or participants request something.

## Your Tools (choose the RIGHT one)

### File & URL Tools
- **search_and_open**: Search for a file by fuzzy name, then open it in browser. Use when someone says "打开那个XX文件" / "show me the XX" / "open the XX page" but doesn't give an exact path. Params: { "query": "keywords to search for", "app": "browser" }
- **open_url**: Open an exact URL. Use when a full URL is mentioned. Params: { "url": "https://..." }
- **open_file**: Open a file by exact path. Only use if you know the full path. Params: { "path": "/abs/path", "app": "browser"|"vscode" }

### Screen Sharing Tools
- **share_url**: Open a URL and present it in the meeting (投屏). Params: { "url": "https://..." }
- **share_file**: Search for a file and present it in the meeting. Params: { "query": "keywords" }
- **stop_sharing**: Stop presenting. Params: {}

### Presenting Tab Tools (operate on the currently shared content)
- **click**: Click a button/link on the presenting page. Params: { "selector": "button text or link text", "targetTab": "presenting" }
- **scroll**: Scroll the presenting page. Params: { "direction": "up"|"down", "targetTab": "presenting" }
- **navigate**: Navigate the presenting page to a new URL. Params: { "url": "https://...", "targetTab": "presenting" }

### Meeting Control Tools
- **share_screen**: Start sharing (no URL = entire screen). Params: {}
- **meet_mute**: Toggle mute. Params: {}
- **meet_camera**: Toggle camera. Params: {}

## Known Files & URLs (from meeting prep)
${
  brief
    ? [
        ...(brief.filePaths || []).map((f) => `- File: ${f.path} (${f.description})`),
        ...(brief.browserUrls || []).map((u) => `- URL: ${u.url} (${u.description})`),
      ].join("\n") || "- (no files or URLs in prep)"
    : "- (no meeting brief)"
}
- Shared files: ~/.callingclaw/shared/

## Current Presentation State
Not currently presenting any page.

## Meeting Context
${
  brief
    ? `Topic: ${brief.topic}
Goal: ${brief.goal}`
    : "No meeting brief loaded."
}

## Transcript (most recent at bottom)
${transcriptText}

## When to Act
1. Someone says "打开/open/show/展示/投屏/看看/找到" + a thing → ACT (search_and_open, share_file, open_url)
2. Someone says "点击/click/登录/login/下一步/next" → ACT (click on presenting tab)
3. Someone says "往下/scroll down/翻页" → ACT (scroll)
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT (your cue!)
5. Discussion/opinion ("我觉得.../this should be.../下次需要...") → DO NOT ACT, confidence=0
6. Response to AI question ("是/好的/对/嗯") → DO NOT ACT, confidence=0
7. **ALREADY HANDLED**: If you see [Tool Call] or [Tool Result] in the transcript for the same action → DO NOT ACT, confidence=0.

## STT Name Aliases (speech-to-text often mangles these)
- CallingClaw = "calling claw" / "colin claw" / "calling call" / "calling clause"
- OpenClaw = "open claw" / "open call" / "open clause"

Respond with JSON only:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<brief>","targetTab":"presenting"|"meet"}`;
}

// ── Eval Suite ──

const transcriptAuditorSuite: EvalSuite<TranscriptAuditorInput, TranscriptAuditorExpected, ToolCallActual> = {
  name: "TranscriptAuditor (Haiku LLM)",
  description: "Tests intent classification via Haiku — requires API key",
  cases: transcriptAuditorCases,

  async run(evalCase: EvalCase<TranscriptAuditorInput, TranscriptAuditorExpected>): Promise<EvalResult<TranscriptAuditorInput, TranscriptAuditorExpected, ToolCallActual>> {
    const startMs = Date.now();

    const prompt = buildClassificationPrompt(evalCase.input);

    let actual: ToolCallActual;
    try {
      const text = await callModel(prompt, {
        model: CONFIG.analysis.model,
        maxTokens: 256,
      });
      const parsed = parseJSON<{
        action?: string;
        params?: Record<string, any>;
        confidence?: number;
        reasoning?: string;
      }>(text);

      actual = {
        toolName: parsed?.action || null,
        params: parsed?.params || {},
        confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0,
        reasoning: parsed?.reasoning || "",
      };
    } catch (err: any) {
      actual = {
        toolName: null,
        params: {},
        confidence: 0,
        reasoning: `error: ${err.message}`,
      };
    }

    const latencyMs = Date.now() - startMs;

    // Score: check tool name match + params match
    const { score, toolNameMatch, paramsScore } = scoreToolCall(
      { toolName: evalCase.expected.action, params: evalCase.expected.params },
      { toolName: actual.toolName, params: actual.params },
    );

    // Confidence checks
    const minConfOk = evalCase.expected.minConfidence
      ? actual.confidence >= evalCase.expected.minConfidence
      : true;
    const maxConfOk = evalCase.expected.maxConfidence !== undefined
      ? actual.confidence <= evalCase.expected.maxConfidence
      : true;

    const passed = toolNameMatch && minConfOk && maxConfOk;

    let reason = "";
    if (!toolNameMatch) {
      reason = `expected action="${evalCase.expected.action}" got="${actual.toolName}"`;
    } else if (!minConfOk) {
      reason = `confidence ${actual.confidence.toFixed(2)} < min ${evalCase.expected.minConfidence}`;
    } else if (!maxConfOk) {
      reason = `confidence ${actual.confidence.toFixed(2)} > max ${evalCase.expected.maxConfidence} (false positive)`;
    } else if (paramsScore < 1.0 && evalCase.expected.params) {
      reason = `params partial match (${(paramsScore * 100).toFixed(0)}%)`;
    }

    // Estimate cost (~200 input tokens + 50 output tokens for Haiku)
    const costUsd = 0.00003; // ~$0.03/1K tokens for Haiku

    return {
      caseId: evalCase.id,
      name: evalCase.name,
      passed,
      score: passed ? score : 0,
      actual,
      expected: evalCase.expected,
      input: evalCase.input,
      reason,
      latencyMs,
      costUsd,
    };
  },
};

// ── Run as bun test (only when invoked via `bun test`) ──

const isBunTest = typeof globalThis.Bun !== "undefined" && process.argv.some((a) => a.includes("test"));
if (isBunTest) {
  const hasApiKey = !!process.env.OPENROUTER_API_KEY || !!process.env.ANTHROPIC_API_KEY;

  describe("TranscriptAuditor Eval", () => {
    if (!hasApiKey) {
      test.skip("Skipped: no API key (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)", () => {});
      return;
    }

    for (const c of transcriptAuditorCases) {
      test(`[${c.id}] ${c.name}`, async () => {
        const result = await transcriptAuditorSuite.run(c);
        expect(result.passed).toBe(true);
      }, 15_000); // 15s timeout per case (LLM call)
    }
  });
}

// ── Export for CLI runner ──
export { transcriptAuditorSuite };
