// CallingClaw 2.0 — Shared LLM Client
// Unified plain-completion API for fast models (Haiku, Gemini Flash).
// Used by TranscriptAuditor (intent classification) and ContextRetriever (gap analysis).
// Supports OpenRouter (all models) with Anthropic direct API fallback.

import { CONFIG } from "../config";

export interface LLMCallOptions {
  /** Model id, or the alias "fast" for the configured fast analysis model */
  model?: string;
  maxTokens?: number;
  system?: string;
  temperature?: number;
  /** Abort the request after this many ms (default 10s). A hung OpenRouter
   * socket previously froze the auditor/retriever for the rest of a meeting. */
  timeoutMs?: number;
}

/**
 * Call a fast model via OpenRouter or Anthropic direct API.
 * Returns the raw text response.
 *
 * Accepts either `callModel(prompt, opts)` or a single options object
 * `callModel({ prompt, system, model, ... })` — both forms are in use.
 */
export async function callModel(
  promptOrOpts: string | (LLMCallOptions & { prompt: string }),
  opts: LLMCallOptions = {},
): Promise<string> {
  let prompt: string;
  if (typeof promptOrOpts === "string") {
    prompt = promptOrOpts;
  } else {
    prompt = promptOrOpts.prompt;
    opts = { ...promptOrOpts, ...opts };
  }

  const model = (!opts.model || opts.model === "fast")
    ? (CONFIG.analysis.searchModel || CONFIG.analysis.model)
    : opts.model;
  const maxTokens = opts.maxTokens || 512;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);

  // Prefer OpenRouter (supports all models uniformly)
  if (CONFIG.openrouter.apiKey) {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        messages,
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content || "";
  }

  // Fallback: Anthropic direct (only works for Claude models)
  if (CONFIG.anthropic.apiKey) {
    const anthropicModel = model.replace(/^anthropic\//, "");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.anthropic.apiKey,
        "anthropic-version": "2024-01-01",
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: maxTokens,
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return data.content?.[0]?.text || "";
  }

  throw new Error("No API key (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)");
}

/**
 * Parse a JSON object from LLM text response.
 * Handles models that wrap JSON in markdown fences or add extra text.
 */
export function parseJSON<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
