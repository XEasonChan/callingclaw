#!/usr/bin/env bun
// CallingClaw 2.0 — Pre-deploy Wiring Check
// Verifies that all modules are properly instantiated and connected.
// Run: bun scripts/check-wiring.ts

const SRC = `${import.meta.dir}/../../callingclaw-backend/src`;

interface Check {
  name: string;
  file: string;
  pattern: RegExp;
  description: string;
}

const checks: Check[] = [
  // ── Module Instantiation ──
  {
    name: "MeetingPrepSkill instantiated",
    file: "callingclaw.ts",
    pattern: /new MeetingPrepSkill\(/,
    description: "MeetingPrepSkill must be created with openclawBridge to generate meeting prep briefs",
  },
  {
    name: "ContextSync instantiated",
    file: "callingclaw.ts",
    pattern: /new ContextSync\(/,
    description: "ContextSync aggregates MEMORY.md + pinned files into voice/computer briefs",
  },
  {
    name: "OpenClawBridge instantiated",
    file: "callingclaw.ts",
    pattern: /new OpenClawBridge\(/,
    description: "OpenClawBridge delegates tasks to System 2 (OpenClaw) via WebSocket",
  },
  {
    name: "EventBus instantiated",
    file: "callingclaw.ts",
    pattern: /new EventBus\(/,
    description: "EventBus provides pub/sub + WebSocket event streaming",
  },
  {
    name: "VoiceModule instantiated",
    file: "callingclaw.ts",
    pattern: /new VoiceModule\(/,
    description: "VoiceModule wraps OpenAI Realtime for bidirectional voice",
  },

  // ── Wiring / Callbacks ──
  {
    name: "contextSync.onUpdate() wired",
    file: "callingclaw.ts",
    pattern: /contextSync\.onUpdate\(/,
    description: "Must push context to voice immediately when pin/note/memory changes",
  },
  {
    name: "openclawBridge.onActivity() wired",
    file: "callingclaw.ts",
    pattern: /openclawBridge\.onActivity\(/,
    description: "Must forward OpenClaw activity events to EventBus for visibility",
  },
  {
    name: "MeetingPrepSkill passed to config server",
    file: "callingclaw.ts",
    pattern: /meetingPrepSkill[,\s]/,
    description: "Config server needs MeetingPrepSkill for /api/meeting/prepare and /api/meeting/join",
  },
  {
    name: "openclawBridge passed to config server",
    file: "callingclaw.ts",
    pattern: /openclawBridge[,\s]/,
    description: "Config server needs OpenClawBridge for meeting prep generation",
  },

  // ── Meeting Flow Integration ──
  {
    name: "prepareMeeting() called in join_meeting handler",
    file: "callingclaw.ts",
    pattern: /prepareMeeting\(meetingPrepSkill/,
    description: "Must generate meeting prep brief before joining meeting",
  },
  {
    name: "notifyTaskCompletion() called in computer_action",
    file: "callingclaw.ts",
    pattern: /notifyTaskCompletion\(voice,\s*meetingPrepSkill/,
    description: "Must push [DONE] live notes to voice when CU completes tasks during meetings",
  },
  {
    name: "meetingPrepSkill.clear() on leave_meeting",
    file: "callingclaw.ts",
    pattern: /meetingPrepSkill\.clear\(\)/,
    description: "Must clear prep state when leaving a meeting",
  },
  {
    name: "Voice reverted to DEFAULT_PERSONA on leave",
    file: "callingclaw.ts",
    pattern: /buildVoiceInstructions\(\)/,
    description: "Must revert voice to default persona after meeting ends",
  },

  // ── Config Server ──
  {
    name: "ContextSync brief injected in /api/meeting/join",
    file: "config_server.ts",
    pattern: /contextSync\?\.getBrief\(\)\.voice/,
    description: "Meeting join must inject ContextSync voice brief into voice instructions",
  },
  {
    name: "MeetingPrepSkill in Services interface",
    file: "config_server.ts",
    pattern: /meetingPrepSkill\??: MeetingPrepSkill/,
    description: "Services interface must include meetingPrepSkill",
  },
  {
    name: "prepareMeeting() in /api/meeting/prepare",
    file: "config_server.ts",
    pattern: /prepareMeeting\(services\.meetingPrepSkill/,
    description: "/api/meeting/prepare must generate a real MeetingPrepBrief via OpenClaw",
  },

  // ── Voice Persona ──
  {
    name: "buildVoiceInstructions exports both personas",
    file: "voice-persona.ts",
    pattern: /MEETING_PERSONA/,
    description: "voice-persona.ts must define MEETING_PERSONA for meeting mode",
  },
  {
    name: "pushContextUpdate exported",
    file: "voice-persona.ts",
    pattern: /export function pushContextUpdate/,
    description: "pushContextUpdate must be exported for callingclaw.ts to call",
  },
  {
    name: "notifyTaskCompletion exported",
    file: "voice-persona.ts",
    pattern: /export function notifyTaskCompletion/,
    description: "notifyTaskCompletion must be exported for CU completion notifications",
  },

  // ── Skills ──
  {
    name: "MeetingPrepSkill class exported",
    file: "skills/meeting-prep.ts",
    pattern: /export class MeetingPrepSkill/,
    description: "MeetingPrepSkill must be exported for instantiation in callingclaw.ts",
  },

  // ── Tool Definitions ──
  {
    name: "recall_context tool registered",
    file: "callingclaw.ts",
    pattern: /name:\s*"recall_context"/,
    description: "recall_context tool must be registered for Voice AI memory access",
  },
];

// ── Run Checks ──

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log("╔══════════════════════════════════════════════════════╗");
console.log("║  CallingClaw 2.0 — Pre-deploy Wiring Check          ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

for (const check of checks) {
  const filePath = `${SRC}/${check.file}`;
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    if (check.pattern.test(content)) {
      console.log(`  ✓ ${check.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${check.name}`);
      console.log(`    → ${check.description}`);
      console.log(`    → Pattern not found in ${check.file}: ${check.pattern}`);
      failures.push(check.name);
      failed++;
    }
  } catch (e: any) {
    console.log(`  ✗ ${check.name}`);
    console.log(`    → File not found: ${check.file}`);
    failures.push(check.name);
    failed++;
  }
}

console.log(`\n────────────────────────────────────────────────────`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${checks.length} total`);

if (failed > 0) {
  console.log(`\n  ⚠ FAILED checks:`);
  failures.forEach((f) => console.log(`    - ${f}`));
  console.log(`\n  Fix these before deploying.`);
  process.exit(1);
} else {
  console.log(`\n  ✓ All wiring checks passed — safe to deploy.`);
  process.exit(0);
}
