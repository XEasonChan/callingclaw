// CallingClaw 2.0 — Central Configuration

import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

// ── Shared local document directory ──
// Used by CallingClaw, OpenClaw, and Desktop UI for meeting artifacts
export const SHARED_DIR = resolve(homedir(), ".callingclaw", "shared");
export const SHARED_PREP_DIR = resolve(SHARED_DIR, "prep");
export const SHARED_NOTES_DIR = resolve(SHARED_DIR, "notes");
export const SHARED_LOGS_DIR = resolve(SHARED_DIR, "logs");
export const SHARED_MANIFEST_PATH = resolve(SHARED_DIR, "manifest.json");

// Ensure shared directories exist on import (startup)
try {
  mkdirSync(SHARED_PREP_DIR, { recursive: true });
  mkdirSync(SHARED_NOTES_DIR, { recursive: true });
  mkdirSync(SHARED_LOGS_DIR, { recursive: true });
} catch {
  // Permissions issue — will fail gracefully on write
}

// ── Load persistent user config from ~/.callingclaw/user-config.json ──
const USER_CONFIG_PATH = `${process.env.HOME}/.callingclaw/user-config.json`;
let _userConfig: Record<string, string> = {};
try {
  const f = Bun.file(USER_CONFIG_PATH);
  if (await f.exists()) {
    _userConfig = await f.json();
  }
} catch {
  // File doesn't exist yet or is invalid — use defaults
}

export const CONFIG = {
  // Server
  port: parseInt(process.env.PORT || "4000"),
  bridgePort: parseInt(process.env.BRIDGE_PORT || "4001"),

  // Voice provider selection: "openai" | "grok" (A/B testing)
  voiceProvider: (process.env.VOICE_PROVIDER || "openai") as "openai" | "grok",

  // OpenAI (Realtime voice + GPT-4o vision)
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    realtimeModel: "gpt-4o-realtime-preview-2024-12-17",
    realtimeUrl: "wss://api.openai.com/v1/realtime",
    voice: "marin",
  },

  // Grok (xAI Voice Agent — A/B test alternative)
  // Pricing: $0.05/min vs OpenAI ~$0.30/min (6x cheaper)
  // Limit: 30min per session (auto-reconnect handles this)
  grok: {
    apiKey: process.env.XAI_API_KEY || "",
    realtimeUrl: "wss://api.x.ai/v1/realtime",
    voice: "Ara",  // Warm tone; options: Eve, Ara, Rex, Sal, Leo
  },

  // Anthropic Computer Use (direct API — optional)
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-6-20250627",
  },

  // OpenRouter (alternative gateway for Claude — no Anthropic key needed)
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.6",
  },

  // Meeting intelligence — fast models for gap detection + semantic search
  // All routed through OpenRouter for unified model switching
  analysis: {
    // Gap analysis: reads transcript, decides what context is missing
    model: process.env.ANALYSIS_MODEL || "anthropic/claude-haiku-4-5",
    // Semantic search: reads MEMORY.md, finds relevant sections for queries
    // Set to a different model for A/B testing (defaults to same as analysis)
    searchModel: process.env.SEARCH_MODEL || "",
    // Both used by ContextRetriever + TranscriptAuditor via OpenRouter
    //
    // Quick switch examples (.env):
    //   ANALYSIS_MODEL=anthropic/claude-haiku-4-5    # Haiku for gap detection
    //   SEARCH_MODEL=google/gemini-3.1-flash-lite-preview  # Gemini for search
    //   SEARCH_MODEL=anthropic/claude-haiku-4-5      # or same Haiku for both
  },

  // Vision analysis (screen/meeting screenshots → Gemini Flash via OpenRouter)
  vision: {
    model: process.env.VISION_MODEL || "google/gemini-3-flash-preview",
    // Falls back to OpenRouter config for API key/base URL
  },

  // Google OAuth (Calendar + Meet)
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  },

  // Screen
  screen: {
    width: parseInt(process.env.SCREEN_WIDTH || "1920"),
    height: parseInt(process.env.SCREEN_HEIGHT || "1080"),
    captureFps: 1,
    ssimThreshold: 0.95,
  },

  // Audio
  audio: {
    sampleRate: 16000,
    channels: 1,
    chunkMs: 20,
  },

  // Automation Layers
  playwright: {
    // Path to a persistent Chrome user-data-dir (for staying logged into Google, etc.)
    userDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR || "",
    headless: process.env.PLAYWRIGHT_HEADLESS === "true",
  },

  peekaboo: {
    // Peekaboo CLI path (defaults to system PATH)
    cliPath: process.env.PEEKABOO_PATH || "peekaboo",
  },

  // User identity — auto-added as attendee to every calendar event
  userEmail: process.env.USER_EMAIL || _userConfig.userEmail || "",
};

export type CallingClawConfig = typeof CONFIG;

export { USER_CONFIG_PATH };
