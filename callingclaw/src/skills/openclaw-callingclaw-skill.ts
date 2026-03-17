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
        return await apiPost("/api/meeting/join", { url, instructions });
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

      case "calendar":
        return await apiGet("/api/calendar/events");

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
        return await apiGet("/api/meeting/notes");

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
              "/callingclaw notes                — List saved meeting notes",
              "/callingclaw transcript [count]   — Get live transcript",
              "/callingclaw health               — Health check all subsystems",
              "/callingclaw recover browser      — Kill + restart browser",
              "/callingclaw recover sidecar      — Kill + restart Python sidecar",
              "/callingclaw recover voice        — Restart voice session",
              "/callingclaw recover all          — Reset all subsystems",
            ],
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
  version: "2.2.1",
  description: "Control CallingClaw — voice AI, computer use, meetings, screen capture, self-recovery",
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
  ],
  endpoint: "http://localhost:4000",
  healthCheck: "http://localhost:4000/api/recovery/health",
};
