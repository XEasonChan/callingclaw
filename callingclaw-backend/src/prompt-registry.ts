// CallingClaw — Prompt Registry
//
// Centralizes ALL AI prompts for runtime inspection and override.
// Dashboard at /prompt-dashboard.html reads and writes through this registry.
// Overrides persist to ~/.callingclaw/prompt-overrides.json.

import { resolve } from "path";
import { existsSync } from "fs";

const OVERRIDES_PATH = resolve((await import("os")).homedir(), ".callingclaw", "prompt-overrides.json");

export interface PromptEntry {
  id: string;
  name: string;
  category: "voice" | "analysis" | "automation" | "meeting" | "tools" | "config";
  model: string;
  scenario: string;
  file: string;
  line: number;
  /** Whether this prompt includes template variables (dynamic parts) */
  dynamic: boolean;
  /** Current value (with overrides applied) */
  value: string;
  /** Original hardcoded value */
  defaultValue: string;
}

// In-memory store
const _prompts = new Map<string, PromptEntry>();
const _overrides = new Map<string, string>();

// Load overrides from disk at startup
function loadOverrides() {
  try {
    if (existsSync(OVERRIDES_PATH)) {
      const data = JSON.parse(require("fs").readFileSync(OVERRIDES_PATH, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") _overrides.set(k, v);
      }
      console.log(`[PromptRegistry] Loaded ${_overrides.size} overrides from ${OVERRIDES_PATH}`);
    }
  } catch (e: any) {
    console.warn(`[PromptRegistry] Failed to load overrides: ${e.message}`);
  }
}
loadOverrides();

function saveOverrides() {
  try {
    const dir = resolve((require("os")).homedir(), ".callingclaw");
    if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of _overrides) obj[k] = v;
    require("fs").writeFileSync(OVERRIDES_PATH, JSON.stringify(obj, null, 2));
  } catch (e: any) {
    console.warn(`[PromptRegistry] Failed to save overrides: ${e.message}`);
  }
}

/** Register a prompt. Call at module load time. */
export function registerPrompt(entry: Omit<PromptEntry, "value">) {
  const existing = _overrides.get(entry.id);
  _prompts.set(entry.id, {
    ...entry,
    value: existing ?? entry.defaultValue,
  });
}

/** Get the current value of a prompt (with override applied). */
export function getPrompt(id: string): string {
  const entry = _prompts.get(id);
  if (!entry) return "";
  return _overrides.get(id) ?? entry.defaultValue;
}

/** Override a prompt value at runtime. Persists to disk. */
export function setPromptOverride(id: string, value: string): boolean {
  const entry = _prompts.get(id);
  if (!entry) return false;
  _overrides.set(id, value);
  entry.value = value;
  saveOverrides();
  return true;
}

/** Reset a prompt to its default value. */
export function resetPrompt(id: string): boolean {
  const entry = _prompts.get(id);
  if (!entry) return false;
  _overrides.delete(id);
  entry.value = entry.defaultValue;
  saveOverrides();
  return true;
}

/** List all registered prompts. */
export function listPrompts(): PromptEntry[] {
  return Array.from(_prompts.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
}

/** Check if a prompt has been overridden. */
export function isOverridden(id: string): boolean {
  return _overrides.has(id);
}
