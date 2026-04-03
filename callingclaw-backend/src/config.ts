// CallingClaw 2.0 — Central Configuration

import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

// ── Shared local document directory ──
// Used by CallingClaw, OpenClaw, and Desktop UI for meeting artifacts
// Override with CALLINGCLAW_HOME env var (e.g., for dev: a path in your project)
export const CALLINGCLAW_HOME = process.env.CALLINGCLAW_HOME || resolve(homedir(), ".callingclaw");
export const SHARED_DIR = resolve(CALLINGCLAW_HOME, "shared");
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

// ── Load persistent user config ──
const USER_CONFIG_PATH = resolve(CALLINGCLAW_HOME, "user-config.json");
let _userConfig: Record<string, string> = {};
try {
  const f = Bun.file(USER_CONFIG_PATH);
  if (await f.exists()) {
    _userConfig = await f.json();
  }
} catch {
  // File doesn't exist yet or is invalid — use defaults
}

// ── Configurable search paths ──
// Path 1: Meeting prep materials directory (default: SHARED_DIR)
// Path 2: Local knowledge base directory (CallingClaw can search files here)
// Both are persisted in user-config.json and configurable via Desktop UI
export const SEARCH_PATHS = {
  /** Meeting prep materials directory. Default: ~/.callingclaw/shared */
  prepDir: _userConfig.prepDir || SHARED_DIR,
  /** Local knowledge base directory. CallingClaw can search all files here. Default: empty (disabled) */
  knowledgeDir: _userConfig.knowledgeDir || "",
};

export const CONFIG = {
  // Server
  port: parseInt(process.env.PORT || "4000"),
  // bridgePort removed — Python sidecar eliminated in v2.6.0

  // Voice provider selection: "openai" | "openai15" | "grok" | "gemini"
  // Default: gemini (Kore voice, 10x cheaper than OpenAI, best quality)
  voiceProvider: (process.env.VOICE_PROVIDER || "gemini") as "openai" | "openai15" | "grok" | "gemini",

  // OpenAI (Realtime GA — gpt-realtime-1.5, upgraded from legacy preview)
  // Uses GA API: no beta header, new event names, session.type required.
  // Override with OPENAI_REALTIME_MODEL env var to pin a specific version.
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5",
    realtimeUrl: "wss://api.openai.com/v1/realtime",
    voice: "marin",
  },

  // OpenAI 1.5 GA (gpt-realtime-1.5 — flagship, Feb 2026)
  // Same pricing as legacy ($32/$64 audio), but better instruction following,
  // function calling (+34%), and BigBench Audio accuracy (+26%).
  // GA API: no beta header, new event names, session.type required.
  openai15: {
    apiKey: process.env.OPENAI_API_KEY || "",
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5",
    realtimeUrl: "wss://api.openai.com/v1/realtime",
    voice: "marin",  // New voices: marin, cedar
  },

  // Grok (xAI Voice Agent — A/B test alternative)
  // Pricing: $0.05/min vs OpenAI ~$0.30/min (6x cheaper)
  // Limit: 30min per session (auto-reconnect handles this)
  grok: {
    apiKey: process.env.XAI_API_KEY || "",
    realtimeUrl: "wss://api.x.ai/v1/realtime",
    voice: "Eve",  // options: Eve, Ara, Rex, Sal, Leo
  },

  // Gemini 3.1 Flash Live (real-time voice + vision)
  // Pricing: ~$0.02/min (10x cheaper than OpenAI, 2.5x cheaper than Grok)
  // Limit: 15min audio / 2min video per session (session resumption extends transparently)
  // Vision: native real-time screen capture + narration (1 FPS JPEG)
  gemini: {
    apiKey: process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || "",
    realtimeModel: process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
    realtimeUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    voice: "Kore",  // options: Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr
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

  // Meeting automation — model for Computer Use during meetings
  // Haiku is fast (~500ms) vs Sonnet (~2-3s) — prioritize speed during live meetings
  // OpenClaw handles deep reasoning (prep/summary/todo execution) outside meetings
  meetingAutomation: {
    model: process.env.MEETING_AUTOMATION_MODEL || "anthropic/claude-haiku-4-5",
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

  // Audio — Canonical format for ALL CallingClaw audio paths.
  // All input sources (mic, BlackHole, system audio) MUST be normalized
  // to this format before sending to any provider.
  audio: {
    sampleRate: 24000,    // Hz — OpenAI/Grok Realtime native rate
    channels: 1,          // mono
    bitDepth: 16,         // PCM16
    format: "pcm16",      // encoding identifier
    chunkSamples: 4096,   // samples per processing chunk (~170ms)
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

  // Recall.ai Bot API (optional — cloud-based meeting bot alternative)
  recall: {
    apiKey: process.env.RECALL_API_KEY || "",
    baseUrl: process.env.RECALL_BASE_URL || "https://us-west-2.recall.ai/api/v1",
    clientPageUrl: process.env.RECALL_CLIENT_PAGE_URL || "",
    wsUrl: process.env.RECALL_WS_URL || "",
  },

  // Python sidecar REMOVED in v2.6.0 — NativeBridge handles all input actions
  // Audio: Electron AudioWorklet, Input: osascript + cliclick, Screenshots: screencapture + CDP

  // User identity
  userEmail: process.env.USER_EMAIL || _userConfig.userEmail || "",
};

export type CallingClawConfig = typeof CONFIG;

export { USER_CONFIG_PATH };
