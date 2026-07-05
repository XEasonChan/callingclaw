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
  /** Opt-in Anthropic prompt caching for the system block. On the OpenRouter
   * path with an anthropic/* model, the system content is sent as a content
   * array with cache_control (OpenRouter passes it through to Anthropic);
   * on the Anthropic direct path, the native system array form is used.
   * When unset, system stays a plain string — existing callers unchanged.
   *
   * MINIMUM PREFIX: Anthropic only caches prefixes of at least 4096 tokens
   * on Haiku-tier models (1024 on Sonnet-tier). A shorter system block is
   * accepted but silently NOT cached — cache_control becomes a no-op and
   * every call pays full input price. When this flag is set, cache activity
   * is logged per call as "[LLM] cache: created=X read=Y" (both 0 = inert). */
  cacheSystem?: boolean;
}

/**
 * Shape the system content for a request. Plain string unless `cacheSystem`
 * is set AND the target supports Anthropic prompt caching — then wrap it in
 * a content array with an ephemeral cache_control breakpoint.
 */
export function buildSystemContent(
  system: string,
  cacheSystem: boolean | undefined,
  supportsCache: boolean,
): string | Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }> {
  if (cacheSystem && supportsCache) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return system;
}

/** When caching was requested, log the cache counters from the response usage
 * (both OpenRouter and Anthropic direct surface the Anthropic field names) so
 * activation — or the silent below-minimum-prefix no-op — is observable in
 * production logs. */
function logCacheUsage(usage: any) {
  if (!usage) return;
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  console.log(`[LLM] cache: created=${created} read=${read}`);
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
    const messages: Array<{ role: string; content: ReturnType<typeof buildSystemContent> }> = [];
    if (opts.system) {
      // cache_control only reaches Anthropic prompt caching for anthropic/* models
      messages.push({
        role: "system",
        content: buildSystemContent(opts.system, opts.cacheSystem, model.startsWith("anthropic/")),
      });
    }
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
    if (opts.cacheSystem) logCacheUsage(data.usage);
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
        // Anthropic direct only serves Claude models — native system array
        // form with cache_control when caching is requested
        ...(opts.system ? { system: buildSystemContent(opts.system, opts.cacheSystem, true) } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as any;
    if (opts.cacheSystem) logCacheUsage(data.usage);
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
