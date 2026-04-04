// CallingClaw — Prompt Registrations
// Registers all AI prompts into the PromptRegistry at startup.
// Called once from callingclaw.ts.

import { registerPrompt } from "./prompt-registry";
import { CORE_IDENTITY, LANGUAGE_RULE, MISSION_CONTEXT_PREFIX, MISSION_CONTEXT_SUFFIX } from "./prompt-constants";

export function registerAllPrompts() {
  // ══════════════════════════════════════════════════════
  // VOICE MODEL — Layer 0 (System Instructions)
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "voice.core_identity",
    name: "Core Identity (Layer 0)",
    category: "voice",
    model: "OpenAI Realtime / Gemini / Grok",
    scenario: "System prompt for voice session. Set once via session.update. Budget: <260 tokens.",
    file: "src/prompt-constants.ts",
    line: 39,
    dynamic: true,
    defaultValue: CORE_IDENTITY,
  });

  registerPrompt({
    id: "voice.language_rule",
    name: "Language Rule",
    category: "voice",
    model: "All models",
    scenario: "Embedded in CORE_IDENTITY and other prompts. Controls bilingual behavior.",
    file: "src/prompt-constants.ts",
    line: 13,
    dynamic: false,
    defaultValue: LANGUAGE_RULE,
  });

  registerPrompt({
    id: "voice.mission_prefix",
    name: "Mission Context Prefix",
    category: "voice",
    model: "All voice providers",
    scenario: "Wraps Layer 2 meeting brief injection.",
    file: "src/prompt-constants.ts",
    line: 77,
    dynamic: false,
    defaultValue: MISSION_CONTEXT_PREFIX,
  });

  // ══════════════════════════════════════════════════════
  // VOICE MODEL — Filler & Presentation
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "voice.slow_tool_filler",
    name: "Slow Tool Filler Prompt",
    category: "voice",
    model: "OpenAI / Grok (response.create)",
    scenario: "When a slow tool is executing, the model generates a natural filler phrase.",
    file: "src/modules/voice.ts",
    line: 350,
    dynamic: true,
    defaultValue: `You just called the "{name}" tool. Briefly and naturally acknowledge you're working on it. One short sentence. Match the conversation language.`,
  });

  registerPrompt({
    id: "voice.gemini_filler",
    name: "Gemini Slow Tool Filler",
    category: "voice",
    model: "Gemini (injectContext)",
    scenario: "Gemini auto-responds to context, so we inject a system message instead of response.create.",
    file: "src/modules/voice.ts",
    line: 348,
    dynamic: true,
    defaultValue: `[SYSTEM] You just started the "{name}" tool. Briefly acknowledge you're working on it, one short sentence.`,
  });

  registerPrompt({
    id: "voice.presentation_mode",
    name: "Presentation Mode Context",
    category: "voice",
    model: "All voice providers",
    scenario: "Injected when share_screen is called. Tells voice to present naturally.",
    file: "src/tool-definitions/meeting-tools.ts",
    line: 620,
    dynamic: true,
    defaultValue: `[PRESENTATION MODE] You are now presenting to the meeting. Present naturally — scroll, click, and navigate using your tools. Here is your narrative guide:\n\n{narrativePlan}`,
  });

  registerPrompt({
    id: "voice.presenter_mode_suffix",
    name: "Presenter Mode Instruction (Playbook)",
    category: "voice",
    model: "All voice providers",
    scenario: "Appended to playbook context when brief has speakingPlan.",
    file: "src/voice-persona.ts",
    line: 193,
    dynamic: false,
    defaultValue: "You are in PRESENTER mode. Follow the speaking plan. You can see the screen — use scroll/click/navigate tools to advance through content naturally. Drive decisions explicitly.",
  });

  registerPrompt({
    id: "voice.idle_nudge",
    name: "Idle Nudge (Offer to Present)",
    category: "voice",
    model: "All voice providers",
    scenario: "Injected after ~30s silence when presentation materials are available.",
    file: "src/voice-persona.ts",
    line: 0,
    dynamic: false,
    defaultValue: `[IDLE NUDGE] The meeting has been quiet for a while. Proactively offer to start presenting. Say something natural like "I have some materials prepared — would you like me to share my screen and walk you through them?" or "要不我开始演示？我准备了一些材料。"`,
  });

  // ══════════════════════════════════════════════════════
  // ANALYSIS — Transcript Auditor (Intent Classification)
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "auditor.classification",
    name: "Intent Classification Prompt",
    category: "analysis",
    model: "Haiku 4.5",
    scenario: "Runs every 1.2s during meetings. Classifies user speech for automation. Confidence thresholds: >=0.85 auto-execute, 0.6-0.85 suggest, <0.6 ignore.",
    file: "src/modules/transcript-auditor.ts",
    line: 344,
    dynamic: true,
    defaultValue: `You are a real-time intent classifier for a voice AI meeting assistant.
Analyze the transcript and determine if the user wants CallingClaw's AGENT to perform an ACTION.

## WHEN TO ACT (confidence > 0)
1. User says "open/show/pull up/打开/展示/看一下" + file/URL → ACT
2. User asks to share screen, navigate, scroll, click → ACT
3. User wants information found/searched → ACT
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT (your cue!)
5. Discussion/opinion ("我觉得.../this should be.../下次需要...") → DO NOT ACT, confidence=0
6. Response to AI question ("是/好的/对/嗯") → DO NOT ACT, confidence=0
7. **ALREADY HANDLED**: If you see [Tool Call] or [Tool Result] in the transcript for the same action → DO NOT ACT, confidence=0. The voice AI already executed it.`,
  });

  // ══════════════════════════════════════════════════════
  // ANALYSIS — Context Retriever (Gap Detection)
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "retriever.topic_classify",
    name: "Topic Classification",
    category: "analysis",
    model: "Haiku 4.5",
    scenario: "Runs every 20-30s. Detects topic shifts to trigger context retrieval. ~50 token output.",
    file: "src/modules/context-retriever.ts",
    line: 376,
    dynamic: true,
    defaultValue: `What specific topic is being discussed RIGHT NOW in this conversation?
Focus on the most recent 2-3 exchanges, not the overall theme.
Return JSON: {"topic": "specific topic", "direction": "what aspect", "shifted": true/false}`,
  });

  registerPrompt({
    id: "retriever.need_inference",
    name: "Need Inference",
    category: "analysis",
    model: "Haiku 4.5",
    scenario: "Only runs on topic shift. Determines what context the AI needs. ~100 token output.",
    file: "src/modules/context-retriever.ts",
    line: 424,
    dynamic: true,
    defaultValue: `Based on this conversation topic, what SPECIFIC information would help the AI respond better?
Think about: data points, past decisions, file contents, metrics, people involved.
Generate NEEDS-BASED queries (not keywords): "memdex blog conversion metrics Q1" not "memdex"
Return JSON: {"needsRetrieval": true/false, "queries": ["query1", "query2"], "reasoning": "why"}`,
  });

  registerPrompt({
    id: "retriever.agentic_search",
    name: "Agentic Search System Prompt",
    category: "analysis",
    model: "Haiku 4.5 (with tools)",
    scenario: "Autonomous search over workspace files. Tools: list_workspace, read_file, search_files. Max 5 rounds, 15s timeout.",
    file: "src/modules/context-retriever.ts",
    line: 574,
    dynamic: false,
    defaultValue: `You are a research assistant searching a personal knowledge workspace for specific information.
You have tools to list files, read files, and search across files. Use them to find answers.

RULES:
- Be efficient: start with search_files or read MEMORY.md, don't read every file
- Match semantically across languages
- Return ONLY the relevant content you found, no commentary
- Separate results for each query with "---"
- If nothing found for a query, write "NO_MATCH"`,
  });

  // ══════════════════════════════════════════════════════
  // ANALYSIS — STT Alias Generation
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "prep.stt_aliases",
    name: "STT Alias Generation",
    category: "analysis",
    model: "Haiku 4.5",
    scenario: "Pre-meeting. Predicts how speech-to-text will mishear unusual keywords.",
    file: "src/skills/meeting-prep.ts",
    line: 214,
    dynamic: false,
    defaultValue: `You extract unusual keywords from meeting documents and predict how speech-to-text (Whisper/Google STT) will mishear them.
Focus on: product names, brand names, technical terms, people names, non-English words, acronyms, spoken aloud.
Return JSON array: [{"canonical": "CallingClaw", "variants": ["calling claw", "calling clock", "calling clog"]}]`,
  });

  // ══════════════════════════════════════════════════════
  // AUTOMATION — Browser Action Loop
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "browser.action_loop",
    name: "Browser Action Loop",
    category: "automation",
    model: "Haiku 4.5",
    scenario: "Real-time browser automation. 15 max steps, 120s timeout. Actions: click, type, pressKey, scroll, wait, navigate, done, fail.",
    file: "src/modules/browser-action-loop.ts",
    line: 237,
    dynamic: true,
    defaultValue: `You are a browser automation agent. You control a browser via an accessibility tree with @ref IDs.

## Rules
1. Elements have @eNNN refs — use these for click/type targets
2. Check "What Changed" first — if your last action worked, move on
3. If loading, use "wait". If complete, use "done". If stuck, use "fail"
4. Be precise — pick exact refs from the snapshot
5. Dismiss blocking dialogs first (cookie banners, modals, etc.)
6. Don't repeat failed actions — try a different approach

Return JSON: {"action": "click|type|pressKey|scroll|wait|navigate|done|fail", "ref": "@eNNN", "text": "...", "reason": "..."}`,
  });

  // ══════════════════════════════════════════════════════
  // AUTOMATION — OpenCLI Command Generation
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "opencli.command_gen",
    name: "OpenCLI Command Generator",
    category: "automation",
    model: "Haiku 4.5",
    scenario: "Translates natural language to OpenCLI commands for 66+ web adapters.",
    file: "src/modules/opencli-command-gen.ts",
    line: 47,
    dynamic: true,
    defaultValue: `Pick the SINGLE best command from the catalog. Fill all required args. Add --format json. Add --limit 5 for list commands.
If no command matches the intent, return {"command": "NONE", "confidence": 0}.
Return JSON: {"command": "opencli ...", "confidence": 0.0-1.0, "reasoning": "..."}`,
  });

  // ══════════════════════════════════════════════════════
  // MEETING — Summary Generation
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "meeting.summary_haiku",
    name: "Meeting Summary (Haiku Fallback)",
    category: "meeting",
    model: "Haiku 4.5",
    scenario: "Fallback when OpenClaw is unavailable. Generates structured meeting summary.",
    file: "src/modules/meeting.ts",
    line: 217,
    dynamic: false,
    defaultValue: `Generate meeting summary as JSON: {title, participants[], keyPoints[], actionItems[{task,assignee,deadline}], decisions[], followUps[]}`,
  });

  registerPrompt({
    id: "meeting.action_items_haiku",
    name: "Action Item Extraction (Haiku)",
    category: "meeting",
    model: "Haiku 4.5",
    scenario: "Every 2 min during meeting. Extracts action items from transcript.",
    file: "src/modules/meeting.ts",
    line: 120,
    dynamic: false,
    defaultValue: `Extract action items from meeting transcript.
Return JSON: {"items": [{"type":"todo"|"decision"|"action_item","text":"...","assignee":"..."}]}`,
  });

  // ══════════════════════════════════════════════════════
  // MEETING — OpenClaw Protocols
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "oc001.meeting_prep",
    name: "OC-001: Meeting Prep Brief",
    category: "meeting",
    model: "Claude Opus (OpenClaw)",
    scenario: "Pre-meeting. OpenClaw generates structured brief from memory + files.",
    file: "src/openclaw-protocol.ts",
    line: 38,
    dynamic: true,
    defaultValue: `Generate a meeting prep brief for the upcoming meeting.

**CRITICAL: Surface Past Mistakes**
Search MEMORY.md "Lessons Learned" section and daily memory files for past mistakes, failures, and debugging experiences related to this topic. These learnings MUST be surfaced — put them in keyPoints (prefixed "⚠️ Past lesson:") and expectedQuestions. The goal: ensure the same errors are never repeated.

Return JSON with: topic, goal, summary, keyPoints[], architectureDecisions[], expectedQuestions[], filePaths[], browserUrls[], speakingPlan[] (optional)`,
  });

  // ══════════════════════════════════════════════════════
  // TOOL DESCRIPTIONS (part of voice model prompt)
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "tool.recall_context",
    name: "Tool: recall_context",
    category: "tools",
    model: "Voice model (tool definition)",
    scenario: "Silently fetches facts from memory. The description IS the prompt that guides when the model calls this tool.",
    file: "src/tool-definitions/ai-tools.ts",
    line: 36,
    dynamic: false,
    defaultValue: `Silently fetch specific facts from memory. Only call when you GENUINELY don't know something relevant to the conversation. Never announce you are searching. If you genuinely don't know, ask the participant directly.`,
  });

  registerPrompt({
    id: "tool.computer_action",
    name: "Tool: computer_action",
    category: "tools",
    model: "Voice model (tool definition)",
    scenario: "Screen automation trigger. Model calls this to click, type, open apps.",
    file: "src/tool-definitions/automation-tools.ts",
    line: 43,
    dynamic: false,
    defaultValue: `Perform an action on the computer screen. Call when user asks to click, type, open, share screen, or interact with applications.`,
  });

  registerPrompt({
    id: "tool.browser_action",
    name: "Tool: browser_action",
    category: "tools",
    model: "Voice model (tool definition)",
    scenario: "Browser automation via Playwright. Faster than computer_action for web tasks.",
    file: "src/tool-definitions/automation-tools.ts",
    line: 77,
    dynamic: false,
    defaultValue: `Control the browser via Playwright CLI. Much faster and more token-efficient than Computer Use. Uses accessibility tree snapshots with @ref identifiers for precise element targeting.`,
  });

  registerPrompt({
    id: "tool.open_file",
    name: "Tool: open_file",
    category: "tools",
    model: "Voice model (tool definition)",
    scenario: "Opens files on screen. After opening, file content is injected into voice context.",
    file: "src/tool-definitions/meeting-tools.ts",
    line: 162,
    dynamic: false,
    defaultValue: `Open a file on CallingClaw's screen for discussion or presentation. Use during meetings to show code, documents, or web pages. After opening, the file content will be injected into your context.`,
  });

  registerPrompt({
    id: "tool.share_screen",
    name: "Tool: share_screen",
    category: "tools",
    model: "Voice model (tool definition)",
    scenario: "Shares screen in Meet. Opens presenting tab with URL.",
    file: "src/tool-definitions/meeting-tools.ts",
    line: 125,
    dynamic: false,
    defaultValue: `Share CallingClaw's screen in the current Google Meet call. Optionally provide a URL to share.`,
  });

  // ══════════════════════════════════════════════════════
  // CONFIG — Model Parameters
  // ══════════════════════════════════════════════════════

  registerPrompt({
    id: "config.voice_provider",
    name: "Default Voice Provider",
    category: "config",
    model: "N/A (configuration)",
    scenario: "Which voice model to use by default. Options: openai, openai15, grok, gemini",
    file: "src/config.ts",
    line: 54,
    dynamic: false,
    defaultValue: process.env.VOICE_PROVIDER || "gemini",
  });

  registerPrompt({
    id: "config.analysis_model",
    name: "Analysis Model (Haiku)",
    category: "config",
    model: "N/A (configuration)",
    scenario: "Model for fast classification: context retrieval, intent classification, browser automation.",
    file: "src/config.ts",
    line: 114,
    dynamic: false,
    defaultValue: process.env.ANALYSIS_MODEL || "anthropic/claude-haiku-4-5",
  });

  registerPrompt({
    id: "config.vision_model",
    name: "Vision Model (Screenshot Analysis)",
    category: "config",
    model: "N/A (configuration)",
    scenario: "Model for screenshot analysis. Runs every ~40s during meetings.",
    file: "src/config.ts",
    line: 135,
    dynamic: false,
    defaultValue: process.env.VISION_MODEL || "google/gemini-3-flash-preview",
  });

  console.log("[PromptRegistry] All prompts registered");
}
