// CallingClaw Eval — Tool Calling Suite
// Tests AutomationRouter.classify() regex accuracy (fast lane, no LLM calls).
// Run: bun eval/suites/tool-calling.eval.ts

import { describe, test, expect } from "bun:test";
import { toolCallingCases } from "../datasets/tool-calling-scenarios";
import { runSuite, scoreToolCall } from "../runner";
import type {
  EvalSuite,
  EvalCase,
  EvalResult,
  ToolCallInput,
  ToolCallExpected,
  ToolCallActual,
} from "../types";
import type { ClassifiedIntent } from "../../src/modules/automation-router";

// ── Import AutomationRouter class and build a minimal instance for classify() ──

// AutomationRouter.classify() only needs regex patterns — no external deps.
// We import the module and instantiate with minimal mocks.
const { AutomationRouter } = await import("../../src/modules/automation-router");

function createRouter() {
  // classify() is a pure function that only uses ROUTE_PATTERNS regex.
  // It doesn't touch any deps, but the constructor requires them.
  return new AutomationRouter({
    bridge: {} as any,
    eventBus: { emit: () => {}, on: () => {} } as any,
    zoomSkill: null as any,
    playwrightCli: null as any,
    peekaboo: null as any,
    opencliBridge: null as any,
  });
}

// ── Build Eval Suite ──

const router = createRouter();

const toolCallingSuite: EvalSuite<ToolCallInput, ToolCallExpected, ToolCallActual> = {
  name: "Tool Calling (Router Classify)",
  description: "Tests AutomationRouter regex classification accuracy — fast lane, no LLM",
  cases: toolCallingCases,

  async run(evalCase: EvalCase<ToolCallInput, ToolCallExpected>): Promise<EvalResult<ToolCallInput, ToolCallExpected, ToolCallActual>> {
    const startMs = Date.now();

    // Run classification
    const intent: ClassifiedIntent = router.classify(evalCase.input.utterance);

    // Router returns action="generic" with low confidence for unrecognized utterances.
    // Treat "generic" as null (no match) since it means "needs LLM fallback".
    const isNoMatch = intent.action === "generic" || intent.confidence === 0;
    const actual: ToolCallActual = {
      toolName: isNoMatch ? null : intent.action,
      params: intent.params,
      confidence: intent.confidence,
      reasoning: intent.reason,
    };

    const latencyMs = Date.now() - startMs;

    // Score
    const { score, toolNameMatch, paramsScore } = scoreToolCall(
      { toolName: evalCase.expected.toolName, params: evalCase.expected.params },
      { toolName: actual.toolName, params: actual.params },
    );

    // Check confidence threshold
    const confidenceOk = evalCase.expected.minConfidence
      ? actual.confidence >= evalCase.expected.minConfidence
      : true;

    const passed = toolNameMatch && confidenceOk;

    let reason = "";
    if (!toolNameMatch) {
      reason = `expected tool="${evalCase.expected.toolName}" got="${actual.toolName}"`;
    } else if (!confidenceOk) {
      reason = `confidence ${actual.confidence.toFixed(2)} < min ${evalCase.expected.minConfidence}`;
    } else if (paramsScore < 1.0 && evalCase.expected.params) {
      reason = `params partial match (${(paramsScore * 100).toFixed(0)}%)`;
    }

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
    };
  },
};

// ── Run as bun test (only when invoked via `bun test`) ──

const isBunTest = typeof globalThis.Bun !== "undefined" && process.argv.some((a) => a.includes("test"));
if (isBunTest) {
  describe("Tool Calling Eval", () => {
    for (const c of toolCallingCases) {
      test(`[${c.id}] ${c.name}`, async () => {
        const result = await toolCallingSuite.run(c);
        expect(result.passed).toBe(true);
      });
    }
  });
}

// ── Export for CLI runner ──
export { toolCallingSuite };
