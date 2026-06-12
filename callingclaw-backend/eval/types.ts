// CallingClaw Eval Framework — Core Types
//
// Three-layer eval system:
//   Layer 1: Component Eval (unit-level, CI-runnable)
//   Layer 2: Scenario Eval (bot-to-bot, end-to-end)
//   Layer 3: Live Eval (real meeting metrics auto-collection)

// ── Eval Case (input) ──

export interface EvalCase<TInput = any, TExpected = any> {
  id: string;
  name: string;
  /** Optional tags for filtering: "zh", "en", "tool-calling", "intent", etc. */
  tags?: string[];
  input: TInput;
  expected: TExpected;
}

// ── Eval Result (output) ──

export interface EvalResult<TInput = any, TExpected = any, TActual = any> {
  caseId: string;
  name: string;
  passed: boolean;
  score: number; // 0.0 - 1.0
  actual: TActual;
  expected: TExpected;
  input: TInput;
  /** Human-readable explanation of pass/fail */
  reason: string;
  /** Execution time in ms */
  latencyMs: number;
  /** Optional cost in USD */
  costUsd?: number;
}

// ── Suite ──

export interface EvalSuite<TInput = any, TExpected = any, TActual = any> {
  name: string;
  description: string;
  cases: EvalCase<TInput, TExpected>[];
  /** Run a single eval case, return the result */
  run(evalCase: EvalCase<TInput, TExpected>): Promise<EvalResult<TInput, TExpected, TActual>>;
}

// ── Suite Report ──

export interface SuiteReport {
  suite: string;
  description: string;
  totalCases: number;
  passed: number;
  failed: number;
  /** Aggregate score (average of all case scores) */
  score: number;
  /** p50 latency across all cases */
  p50LatencyMs: number;
  /** p95 latency across all cases */
  p95LatencyMs: number;
  totalCostUsd: number;
  results: EvalResult[];
  startedAt: string;
  durationMs: number;
}

// ── Tool Calling Eval Types ──

export interface ToolCallInput {
  /** The voice command / user utterance */
  utterance: string;
  /** Optional meeting context */
  meetingContext?: {
    topic?: string;
    prepFiles?: Array<{ path: string; description: string }>;
    prepUrls?: Array<{ url: string; description: string }>;
  };
}

export interface ToolCallExpected {
  /** Expected tool name (null = should NOT trigger any tool) */
  toolName: string | null;
  /** Expected params (partial match — only keys present here are checked) */
  params?: Record<string, any>;
  /** Minimum confidence threshold for the match */
  minConfidence?: number;
}

export interface ToolCallActual {
  toolName: string | null;
  params: Record<string, any>;
  confidence: number;
  reasoning?: string;
}

// ── Transcript Auditor Eval Types ──

export interface TranscriptAuditorInput {
  /** Transcript entries to classify */
  transcript: Array<{
    role: "user" | "assistant" | "system" | "participant";
    speaker?: string;
    text: string;
  }>;
  /** Optional meeting brief context */
  meetingBrief?: {
    topic?: string;
    goal?: string;
    filePaths?: Array<{ path: string; description: string }>;
    browserUrls?: Array<{ url: string; description: string }>;
  };
}

export interface TranscriptAuditorExpected {
  /** Expected action (null = should NOT act) */
  action: string | null;
  /** Expected params (partial match) */
  params?: Record<string, any>;
  /** Expected confidence range */
  minConfidence?: number;
  maxConfidence?: number;
}

// ── YouTube Transcript Types ──

export interface YouTubeTranscriptEntry {
  startTime: number; // seconds
  endTime: number;   // seconds
  text: string;
}

export interface YouTubeTranscriptDataset {
  videoId: string;
  title: string;
  language: string;
  entries: YouTubeTranscriptEntry[];
  /** Hand-labeled action intents for evaluation */
  labels?: Array<{
    /** Index range of entries that form this intent */
    entryRange: [number, number];
    expectedAction: string | null;
    expectedParams?: Record<string, any>;
    description: string;
  }>;
}
