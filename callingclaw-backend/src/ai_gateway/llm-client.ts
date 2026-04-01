// CallingClaw 2.0 — Shared LLM Client
// Unified plain-completion API for fast models (Haiku, Gemini Flash).
// Used by TranscriptAuditor (intent classification) and ContextRetriever (gap analysis).
// Supports OpenRouter (all models) with Anthropic direct API fallback.

import { CONFIG } from "../config";

export interface LLMCallOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * Call a fast model via OpenRouter or Anthropic direct API.
 * Returns the raw text response.
 */
export async function callModel(
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  const model = opts.model || CONFIG.analysis.searchModel || CONFIG.analysis.model;
  const maxTokens = opts.maxTokens || 512;

  // Prefer OpenRouter (supports all models uniformly)
  if (CONFIG.openrouter.apiKey) {
    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
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
        messages: [{ role: "user", content: prompt }],
      }),
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
