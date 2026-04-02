// CallingClaw 2.0 — OpenCLI Command Generator (Strategy B)
//
// Uses a single Haiku call to translate natural language into the correct
// opencli command. This avoids regex pattern matching entirely — Haiku
// understands any phrasing and maps to the right command from a catalog
// of 100 available commands.
//
// Flow: user intent → Haiku (~300ms) → opencli command string → execute ($0)
// Total: ~1.3s for ANY web task, even without pre-built patterns.
//
// The catalog is loaded once at startup from opencli-catalog-compact.txt
// and injected into the Haiku prompt as available commands.

import { readFileSync } from "fs";
import { resolve } from "path";
import { CONFIG } from "../config";

const CATALOG_PATH = resolve(import.meta.dir, "opencli-catalog-compact.txt");

let _catalog: string | null = null;

function getCatalog(): string {
  if (!_catalog) {
    try {
      _catalog = readFileSync(CATALOG_PATH, "utf-8");
    } catch {
      _catalog = "(catalog not available)";
    }
  }
  return _catalog;
}

/**
 * Generate an opencli command from a natural language instruction.
 *
 * Returns:
 *   { command: "opencli hackernews best --limit 5 --format json", confidence: 0.9 }
 *   or null if no suitable command found.
 *
 * Uses Haiku (~300ms, ~$0.0003) for a single classification call.
 */
export async function generateOpenCLICommand(
  instruction: string,
): Promise<{ command: string; confidence: number; reasoning: string } | null> {
  const catalog = getCatalog();

  const prompt = `You are a CLI command router. Given a user's intent, pick the best opencli command from the catalog below. If no command matches, respond with "NONE".

## Available Commands
${catalog}

## Rules
1. Pick the SINGLE best matching command.
2. Fill in required args from the user's intent.
3. Always add --format json for structured output.
4. Add --limit 5 by default unless the user specifies a number.
5. For "gh" commands, use --json with relevant fields (title,state,url).
6. If the intent doesn't match ANY command, respond with exactly: NONE

## User Intent
"${instruction}"

Respond with ONLY a JSON object (no markdown, no explanation):
{"command": "opencli ...", "confidence": 0.0-1.0, "reasoning": "one line why"}`;

  try {
    // Use OpenRouter for Haiku (reliable for this project)
    if (CONFIG.openrouter?.apiKey) {
      const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4-5",
          max_tokens: 150,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) throw new Error(`OpenRouter API ${resp.status}`);
      const data = (await resp.json()) as any;
      return parseResponse(data.choices?.[0]?.message?.content || "");
    }

    // Fallback: direct Anthropic API
    if (CONFIG.anthropic?.apiKey) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.anthropic.apiKey,
          "anthropic-version": "2024-01-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 150,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) throw new Error(`Anthropic API ${resp.status}`);
      const data = (await resp.json()) as any;
      return parseResponse(data.content?.[0]?.text || "");
    }

    return null; // No API key available
  } catch (e: any) {
    console.warn(`[OpenCLI-CommandGen] Failed: ${e.message}`);
    return null;
  }
}

function parseResponse(text: string): { command: string; confidence: number; reasoning: string } | null {
  if (!text || text.includes("NONE")) return null;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.command || !parsed.command.startsWith("opencli")) return null;

    return {
      command: parsed.command,
      confidence: parsed.confidence || 0.7,
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return null;
  }
}

/**
 * Reload the catalog (e.g., after opencli adapters are updated).
 */
export function reloadCatalog(): void {
  _catalog = null;
  getCatalog();
}
