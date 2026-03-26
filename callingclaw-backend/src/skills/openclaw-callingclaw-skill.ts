// CallingClaw 2.0 — /callingclaw Skill Definition for OpenClaw
// ═══════════════════════════════════════════════════════════════════
// This defines the /callingclaw command that OpenClaw can invoke.
// OpenClaw calls CallingClaw's REST API on localhost:4000.
//
// Usage in OpenClaw:
//   /callingclaw voice start       — Start voice session
//   /callingclaw voice stop        — Stop voice session
//   /callingclaw prepare <topic>   — Create meeting (calendar + Meet link + deep research)
//   /callingclaw join <url>        — Join a meeting
//   /callingclaw leave             — Leave meeting + generate follow-up
//   /callingclaw status            — Check CallingClaw status
//   /callingclaw screen <action>   — Computer use / screen control
//   /callingclaw calendar          — Check upcoming events
//   /callingclaw say <text>        — Send text to voice AI
//   /callingclaw tasks             — List pending tasks
//   /callingclaw confirm <id>      — Confirm a task for execution
//   /callingclaw context <note>    — Add context note to shared memory
//   /callingclaw pin <filepath>    — Pin a file to shared context
//   /callingclaw health            — Health check all subsystems
//   /callingclaw recover <target>  — Self-recovery: browser|sidecar|voice|all
//
// ═══════════════════════════════════════════════════════════════════

const CALLINGCLAW_BASE = "http://localhost:4000";

export interface CallingClawSkillResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * /callingclaw skill — callable from OpenClaw.
 * Parses the subcommand and calls the appropriate REST endpoint.
 */
export async function executeCallingClawSkill(args: string): Promise<CallingClawSkillResult> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();
  const rest = parts.slice(1).join(" ");

  try {
    switch (subcommand) {
      case "status":
        return await apiGet("/api/status");

      case "voice": {
        const action = parts[1]?.toLowerCase();
        if (action === "start") {
          const instructions = parts.slice(2).join(" ") || undefined;
          return await apiPost("/api/voice/start", { instructions, audio_mode: "direct" });
        }
        if (action === "stop") {
          return await apiPost("/api/voice/stop", {});
        }
        return { success: false, error: "Usage: /callingclaw voice start|stop [instructions]" };
      }

      case "prep-result": {
        // Submit completed prep brief to CallingClaw for rendering
        // OpenClaw calls this after deep research is done
        if (!rest) return { success: false, error: "Usage: /callingclaw prep-result <JSON>" };
        try {
          const briefJson = JSON.parse(rest);
          return await apiPost("/api/meeting/prep-result", briefJson);
        } catch {
          return { success: false, error: "Invalid JSON. Send the full MeetingPrepBrief object." };
        }
      }

      case "prepare":
      case "create": {
        // Create a meeting: calendar event + Meet link + background deep research
        // Auto-adds CONFIG.userEmail as attendee
        if (!rest) return { success: false, error: "Usage: /callingclaw prepare <topic> [--attendees email1,email2] [--time 2026-03-17T20:00]" };
        const body: any = { topic: rest };
        // Parse optional flags
        const attendeeMatch = rest.match(/--attendees?\s+([\w@.,]+)/);
        if (attendeeMatch) {
          body.attendees = attendeeMatch[1].split(",").map((e: string) => e.trim());
          body.topic = rest.replace(/--attendees?\s+[\w@.,]+/, "").trim();
        }
        const timeMatch = rest.match(/--time\s+([\d\-T:+]+)/);
        if (timeMatch) {
          body.start_time = timeMatch[1];
          body.topic = body.topic.replace(/--time\s+[\d\-T:+]+/, "").trim();
        }
        return await apiPost("/api/meeting/prepare", body);
      }

      case "join": {
        const url = parts[1];
        if (!url) return { success: false, error: "Usage: /callingclaw join <meeting-url>" };
        const instructions = parts.slice(2).join(" ") || undefined;
        const joinResult = await apiPost("/api/meeting/join", { url, instructions });
        // Handle auth-required response: try auto-applying OpenClaw's Google OAuth first
        if (!joinResult.success && joinResult.data?.needsAuth) {
          console.log("[CallingClaw Skill] Meeting join requires Google auth — attempting auto-setup from OpenClaw OAuth...");
          // Step 1: Try to apply OpenClaw's existing Google credentials
          const scanResult = await apiGet("/api/google/scan");
          if (scanResult.data?.found) {
            const applyResult = await apiPost("/api/google/apply", {});
            if (applyResult.success) {
              console.log("[CallingClaw Skill] Google OAuth applied from OpenClaw credentials");
            }
          }
          // Step 2: Open Chrome for Google sign-in (required for Meet)
          const loginResult = await apiPost("/api/google/chrome-login", {});
          if (loginResult.success) {
            return {
              success: false,
              error: "Google sign-in required",
              data: {
                needsAuth: true,
                message: "Please sign into your Google account in the Chrome window that just opened. " +
                  "After signing in, run /callingclaw join again.",
                calendarStatus: scanResult.data?.found
                  ? "Calendar OAuth applied from OpenClaw credentials ✓"
                  : "Calendar OAuth not found — run /callingclaw google-auth to set up",
              },
            };
          }
          return joinResult;
        }
        return joinResult;
      }

      case "google-auth": {
        // Google OAuth setup for CallingClaw
        // Priority: 1) Reuse OpenClaw's existing OAuth  2) Fallback to CallingClaw's own OAuth link
        //
        // OpenClaw stores Google credentials at:
        //   ~/.openclaw/workspace/google-credentials.json
        //   ~/.openclaw/workspace/google-token.json
        //
        // CallingClaw scans these paths automatically via /api/google/scan.
        // If found, /api/google/apply writes them to CallingClaw's .env and connects calendar.
        // If NOT found, user must run the OAuth flow: bun scripts/ts/google-auth.ts

        // Step 1: Scan for existing credentials (OpenClaw, gcloud, etc.)
        const scanResult = await apiGet("/api/google/scan");
        if (scanResult.data?.found) {
          // Auto-apply from OpenClaw's existing OAuth
          const applyResult = await apiPost("/api/google/apply", {});
          if (applyResult.success) {
            return {
              success: true,
              data: {
                message: "Google OAuth applied from OpenClaw credentials",
                calendar: applyResult.data?.connected ? "connected ✓" : "not connected",
                source: scanResult.data?.sources,
                nextStep: "Chrome Google sign-in is separate. Run: /callingclaw google-chrome-login",
              },
            };
          }
        }

        // Step 2: No existing credentials — guide user to generate
        return {
          success: false,
          error: "No Google OAuth credentials found",
          data: {
            message: "Google Calendar OAuth not configured. Two options:",
            options: [
              "1. If you have OpenClaw with Google Calendar: run 'openclaw configure' and enable Google Calendar, then run /callingclaw google-auth again",
              "2. Generate CallingClaw's own OAuth token: cd callingclaw-backend && bun scripts/ts/google-auth.ts",
            ],
            scannedPaths: scanResult.data?.sources || [],
            chromeNote: "Chrome Google sign-in (for Meet) is separate from Calendar OAuth. After setting up Calendar, run: /callingclaw google-chrome-login",
          },
        };
      }

      case "google-chrome-login": {
        // Open Chrome for Google sign-in (required for Meet joining)
        const loginResult = await apiPost("/api/google/chrome-login", {});
        if (loginResult.success) {
          return {
            success: true,
            data: {
              message: "Chrome opened to Google sign-in page. Please sign in with your Google account.",
              pollUrl: "/api/google/chrome-login/check",
              note: "After signing in, run /callingclaw join <url> to join a meeting.",
            },
          };
        }
        return loginResult;
      }

      case "leave":
        return await apiPost("/api/meeting/leave", {});

      case "say": {
        if (!rest) return { success: false, error: "Usage: /callingclaw say <text>" };
        return await apiPost("/api/voice/text", { text: rest });
      }

      case "screen":
      case "do": {
        if (!rest) return { success: false, error: "Usage: /callingclaw screen <instruction>" };
        return await apiPost("/api/computer/run", { instruction: rest });
      }

      case "calendar": {
        // /callingclaw calendar — list upcoming events
        // /callingclaw calendar create <JSON> — create event with Meet link
        const calSub = parts[1];
        if (calSub === "create") {
          const jsonStr = args.slice(args.indexOf("create") + "create".length).trim();
          if (!jsonStr) return { success: false, error: 'Usage: /callingclaw calendar create {"summary":"title","start":"ISO","end":"ISO"}' };
          try {
            const eventData = JSON.parse(jsonStr);
            return await apiPost("/api/calendar/create", eventData);
          } catch (e: any) {
            return { success: false, error: `Invalid JSON: ${e.message}` };
          }
        }
        return await apiGet("/api/calendar/events");
      }

      case "user-email":
      case "email":
        // Get or set the user's default email (used for calendar invites)
        if (rest) return await apiPost("/api/config/user-email", { email: rest });
        return await apiGet("/api/config/user-email");

      case "tasks":
        return await apiGet("/api/tasks?status=pending");

      case "confirm": {
        const taskId = parts[1];
        if (!taskId) return { success: false, error: "Usage: /callingclaw confirm <task-id>" };
        return await apiPatch(`/api/tasks/${taskId}`, { status: "in_progress" });
      }

      case "context":
      case "note": {
        if (!rest) return { success: false, error: "Usage: /callingclaw context <note>" };
        return await apiPost("/api/context/note", { note: rest });
      }

      case "pin": {
        const filepath = parts[1];
        const summary = parts.slice(2).join(" ") || undefined;
        if (!filepath) return { success: false, error: "Usage: /callingclaw pin <filepath> [summary]" };
        return await apiPost("/api/context/pin", { path: filepath, summary });
      }

      case "screenshot":
        return await apiPost("/api/bridge/action", { action: "screenshot" });

      case "notes":
        // Reads from ~/.callingclaw/shared/notes/ (+ legacy meeting_notes/)
        return await apiGet("/api/meeting/notes");

      case "prep-files":
      case "preps": {
        // List available prep briefs from ~/.callingclaw/shared/prep/
        return await apiGet("/api/shared/prep");
      }

      case "manifest": {
        // Get shared directory manifest for quick file discovery
        return await apiGet("/api/shared/manifest");
      }

      case "shared": {
        // Read a file from the shared directory
        // Usage: /callingclaw shared prep/2026-03-17_topic.md
        const sharedPath = rest;
        if (!sharedPath) return { success: false, error: "Usage: /callingclaw shared <relative-path>" };
        return await apiGet(`/api/shared/file?path=${encodeURIComponent(sharedPath)}`);
      }

      case "transcript": {
        const count = parseInt(parts[1]) || 20;
        return await apiGet(`/api/meeting/transcript?count=${count}`);
      }

      // ── Self-Recovery Commands ──
      case "health":
        return await apiGet("/api/recovery/health");

      case "recover":
      case "reset": {
        const target = parts[1]?.toLowerCase();
        if (target === "browser") return await apiPost("/api/recovery/browser", {});
        if (target === "sidecar") return await apiPost("/api/recovery/sidecar", {});
        if (target === "voice") return await apiPost("/api/recovery/voice", {});
        if (target === "all") {
          const results: Record<string, any> = {};
          results.browser = await apiPost("/api/recovery/browser", {});
          results.sidecar = await apiPost("/api/recovery/sidecar", {});
          results.voice = await apiPost("/api/recovery/voice", {});
          return { success: true, data: results };
        }
        return { success: false, error: "Usage: /callingclaw recover browser|sidecar|voice|all" };
      }

      case "help":
        return {
          success: true,
          data: {
            commands: [
              "/callingclaw status              — Check if CallingClaw is running",
              "/callingclaw voice start|stop     — Start/stop voice session",
              "/callingclaw prepare <topic>      — Create meeting (calendar + Meet + research)",
              "/callingclaw join <url>           — Join a meeting",
              "/callingclaw leave                — Leave meeting + follow-up",
              "/callingclaw say <text>           — Send text to voice AI",
              "/callingclaw screen <instruction> — Computer use task",
              "/callingclaw calendar             — Check upcoming events",
              "/callingclaw tasks                — List pending tasks",
              "/callingclaw confirm <id>         — Confirm task for execution",
              "/callingclaw context <note>       — Add shared context note",
              "/callingclaw pin <path> [summary] — Pin file to shared context",
              "/callingclaw screenshot           — Take screenshot",
              "/callingclaw notes                — List saved meeting notes (from ~/.callingclaw/shared/notes/)",
              "/callingclaw prep-files           — List available prep briefs (from ~/.callingclaw/shared/prep/)",
              "/callingclaw manifest             — Get shared directory file index",
              "/callingclaw shared <path>        — Read a file from ~/.callingclaw/shared/ by relative path",
              "/callingclaw transcript [count]   — Get live transcript",
              "/callingclaw health               — Health check all subsystems",
              "/callingclaw recover browser      — Kill + restart browser",
              "/callingclaw recover sidecar      — Kill + restart Python sidecar",
              "/callingclaw recover voice        — Restart voice session",
              "/callingclaw recover all          — Reset all subsystems",
              "/callingclaw google-auth          — Setup Google OAuth (reuse OpenClaw's, or generate new)",
              "/callingclaw google-chrome-login   — Open Chrome to sign in with Google (for Meet)",
            ],
            sharedDir: "~/.callingclaw/shared/",
            sharedSubdirs: {
              prep: "Meeting prep briefs (.md + .json)",
              notes: "Meeting notes/summaries (.md)",
              logs: "Live meeting logs (.md)",
              "manifest.json": "File index for quick discovery",
            },
          },
        };

      default:
        return { success: false, error: `Unknown subcommand: ${subcommand}. Use /callingclaw help for usage.` };
    }
  } catch (e: any) {
    return { success: false, error: `CallingClaw unreachable: ${e.message}. Is it running?` };
  }
}

// ── HTTP helpers ──

async function apiGet(path: string): Promise<CallingClawSkillResult> {
  const res = await fetch(`${CALLINGCLAW_BASE}${path}`);
  const data = await res.json();
  return { success: res.ok, data, error: data.error };
}

async function apiPost(path: string, body: any): Promise<CallingClawSkillResult> {
  const res = await fetch(`${CALLINGCLAW_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { success: res.ok, data, error: data.error };
}

async function apiPatch(path: string, body: any): Promise<CallingClawSkillResult> {
  const res = await fetch(`${CALLINGCLAW_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { success: res.ok, data, error: data.error };
}

// ── OpenClaw Skill Manifest ──
// This is the metadata OpenClaw uses to register the /callingclaw command.

export const CALLINGCLAW_SKILL_MANIFEST = {
  name: "callingclaw",
  version: "2.2.4",
  description: "Control CallingClaw — voice AI, computer use, meetings, screen capture, self-recovery, shared documents",
  trigger: "/callingclaw",
  examples: [
    "/callingclaw status",
    "/callingclaw voice start",
    "/callingclaw join https://meet.google.com/abc-defg-hij",
    "/callingclaw say 帮我查一下明天的日程",
    "/callingclaw screen Open Chrome and go to github.com",
    "/callingclaw leave",
    "/callingclaw health",
    "/callingclaw recover browser",
    "/callingclaw prep-files",
    "/callingclaw manifest",
    "/callingclaw shared prep/2026-03-17_topic.md",
  ],
  capabilities: [
    "voice_conversation",
    "meeting_join_leave",
    "meeting_attendee_admission",
    "computer_use",
    "calendar_management",
    "screen_capture",
    "task_management",
    "context_sharing",
    "self_recovery",
    "shared_documents",
    "google_auth",
  ],

  // ── Google OAuth Strategy ──
  // Priority 1: Reuse OpenClaw's existing Google OAuth credentials
  //   - Scans ~/.openclaw/workspace/google-credentials.json + google-token.json
  //   - If found, auto-applies to CallingClaw .env → calendar connected
  // Priority 2: Fallback to CallingClaw's own OAuth flow
  //   - User runs: bun scripts/ts/google-auth.ts
  //   - Generates CallingClaw-specific refresh token
  // Chrome Google Sign-in (for Meet):
  //   - Separate from Calendar OAuth — requires browser cookie auth
  //   - /callingclaw google-chrome-login opens Chrome to accounts.google.com
  //   - User signs in once, cookies persist in Chrome profile
  googleOAuth: {
    strategy: "openclaw_first",
    scanPaths: [
      "~/.openclaw/workspace/google-credentials.json",
      "~/.openclaw/workspace/google-token.json",
      "~/.config/gcloud/application_default_credentials.json",
      "~/.callingclaw/google-credentials.json",
    ],
    fallbackScript: "bun scripts/ts/google-auth.ts",
  },
  endpoint: "http://localhost:4000",
  healthCheck: "http://localhost:4000/api/recovery/health",

  // ── Shared Document Convention ──
  sharedDir: "~/.callingclaw/shared/",
  sessionsIndex: "~/.callingclaw/shared/sessions.json",
  fileSuffixes: {
    prep: "_prep.md",
    live: "_live.md",
    summary: "_summary.md",
    transcript: "_transcript.md",
  },

  // ── OpenClaw ↔ CallingClaw Protocol Schemas ──
  // Source of truth: src/openclaw-protocol.ts
  protocolSchemas: [
    { id: "OC-001", name: "Meeting Prep Brief Generation", responseFormat: "JSON", latency: "5-15s" },
    { id: "OC-002", name: "Context Recall", responseFormat: "text <500w", latency: "2-10s" },
    { id: "OC-003", name: "Calendar Cron Registration", responseFormat: "jobId (regex)", latency: "2-5s" },
    { id: "OC-004", name: "Todo Delivery (Telegram)", responseFormat: '"sent"', latency: "3-8s" },
    { id: "OC-005", name: "Summary Delivery", responseFormat: '"sent"', latency: "3-8s" },
    { id: "OC-006", name: "Todo Execution Handoff", responseFormat: "JSON {status, summary}", latency: "10-60s" },
    { id: "OC-007", name: "Meeting Vision Push", responseFormat: '"ok" (fire & forget)', latency: "2-5s" },
    { id: "OC-008", name: "Computer Use Delegation", responseFormat: "text (capped 10K)", latency: "5-30s" },
    { id: "OC-009", name: "Follow-up Fallback", responseFormat: '"ok" (fire & forget)', latency: "2-5s" },
  ],
};

// Re-export protocol for OpenClaw integration
export { OPENCLAW_PROTOCOL, type OpenClawProtocolId } from "../openclaw-protocol";
