// CallingClaw REST client — thin fetch wrappers around the localhost:4000 API.
// Shared by the MCP tool handlers so the server stays transport-only.

function httpBase(): string {
  return process.env.CALLINGCLAW_HTTP || "http://localhost:4000";
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${httpBase()}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postJson(path: string, body: any): Promise<any> {
  const res = await fetch(`${httpBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const callingclaw = {
  get httpBase() { return httpBase(); },

  /** System status (backend health, voice/meeting flags). */
  status: () => getJson("/api/status"),

  /** Current meeting state (active meeting, platform, participants). */
  meetingStatus: () => getJson("/api/meeting/status"),

  /** Live or last meeting transcript. */
  transcript: () => getJson("/api/meeting/transcript"),

  /** Meeting summary + action items. */
  summary: () => getJson("/api/meeting/summary"),

  /** Upcoming calendar meetings. */
  calendar: () => getJson("/api/calendar/events"),

  /** 拉起会议: join a Google Meet / Zoom URL as the CallingClaw participant.
   * Optional topic + instructions shape the voice persona for this meeting
   * (e.g. onboarding self-introduction). */
  joinMeeting: (url: string, opts?: { topic?: string; instructions?: string }) =>
    postJson("/api/meeting/join", { url, ...(opts?.topic ? { topic: opts.topic } : {}), ...(opts?.instructions ? { instructions: opts.instructions } : {}) }),

  /** 会议议程/prep: generate a meeting prep brief by topic or calendar eventId. */
  prepareMeeting: (opts: { topic?: string; eventId?: string }) =>
    postJson("/api/meeting/prepare", opts),

  /** Create a calendar event with a Google Meet link. Returns the event (incl. meet link). */
  createMeeting: (opts: { summary: string; start?: string; end?: string; description?: string; attendees?: string[] }) =>
    postJson("/api/calendar/create", opts),

  /** macOS permission status (screen recording, accessibility). */
  permissions: () => getJson("/api/onboarding/permissions"),

  /** Open a macOS System Settings privacy pane: screenRecording | accessibility | microphone | camera. */
  openPermissionPane: (panel: string) => postJson("/api/onboarding/permissions/open", { panel }),

  /** Google auth status (calendar connection + Chrome profile login). */
  googleAuthStatus: () => getJson("/api/google/auth-status"),

  /** Open Chrome to the Google sign-in page (user completes login). */
  googleChromeLogin: () => postJson("/api/google/chrome-login", {}),

  /** Pin a file into CallingClaw's shared context (voice AI can reference it). */
  pinContext: (path: string, summary?: string) => postJson("/api/context/pin", { path, summary }),
};
