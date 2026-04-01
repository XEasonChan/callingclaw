// CallingClaw 2.0 — Google Calendar Client (Direct REST API)
// Uses OAuth2 refresh tokens — no MCP package dependency

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Fetch that bypasses HTTPS_PROXY for Google APIs.
 * Bun caches HTTPS_PROXY at startup (from .env) and ignores runtime changes.
 * Google OAuth/Calendar endpoints need direct access (proxy breaks TLS).
 * Solution: shell out to curl which doesn't inherit Bun's proxy config.
 */
async function googleFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method || "GET";
  const headers = init?.headers as Record<string, string> || {};
  const body = init?.body?.toString() || "";

  const args = ["curl", "-s", "-X", method, url, "--noproxy", "*"];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (body) {
    args.push("-d", body);
  }
  args.push("-w", "\n%{http_code}");
  console.log(`[googleFetch] ${method} ${url}`);
  console.log(`[googleFetch] body: ${body.slice(0, 300)}`);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop()!) || 500;
  const responseBody = lines.join("\n");

  return new Response(responseBody, {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
}

export interface CalendarEvent {
  id?: string;
  summary: string;
  start: string;
  end: string;
  attendees?: CalendarAttendee[];
  meetLink?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Well-known paths where Google OAuth credentials may be stored */
const CREDENTIAL_SEARCH_PATHS = [
  "~/.openclaw/workspace/google-credentials.json",
  "~/.openclaw/workspace/google-token.json",
  "~/.config/gcloud/application_default_credentials.json",
  "~/.callingclaw/google-credentials.json",
  "~/.callingclaw/google-token.json",
];

function expandHome(p: string): string {
  return p.replace(/^~/, process.env.HOME || "/tmp");
}

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Scan the local filesystem for existing Google OAuth credentials.
 * Returns found credentials or null.
 */
export async function scanForGoogleCredentials(): Promise<{
  credentials: GoogleOAuthCredentials | null;
  sources: { path: string; found: boolean; type: string }[];
}> {
  const sources: { path: string; found: boolean; type: string }[] = [];
  let clientId = "";
  let clientSecret = "";
  let refreshToken = "";

  for (const rawPath of CREDENTIAL_SEARCH_PATHS) {
    const path = expandHome(rawPath);
    const file = Bun.file(path);
    const exists = await file.exists();
    const type = rawPath.includes("token") ? "token" : "credentials";
    sources.push({ path: rawPath, found: exists, type });

    if (!exists) continue;

    try {
      const data = await file.json();

      // Desktop OAuth credentials file (installed.client_id)
      if (data.installed?.client_id) {
        clientId = data.installed.client_id;
        clientSecret = data.installed.client_secret;
      }

      // Token file with refresh_token
      if (data.refresh_token) {
        refreshToken = data.refresh_token;
        // Token files often also contain client_id/secret
        if (data.client_id) clientId = data.client_id;
        if (data.client_secret) clientSecret = data.client_secret;
      }

      // GCloud application default credentials
      if (data.type === "authorized_user" && data.refresh_token) {
        clientId = data.client_id;
        clientSecret = data.client_secret;
        refreshToken = data.refresh_token;
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  if (clientId && clientSecret && refreshToken) {
    return {
      credentials: { clientId, clientSecret, refreshToken },
      sources,
    };
  }

  return { credentials: null, sources };
}

export class GoogleCalendarClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private accessToken: string = "";
  private tokenExpiry: number = 0;
  private _connected = false;
  private _authError: string | null = null;

  /** Called when an auth error is detected at runtime (e.g. refresh token expired) */
  onAuthError?: (error: string) => void;

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID || "";
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    this.refreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";
  }

  get connected() {
    return this._connected;
  }

  /** Returns the current auth error message, or null if healthy */
  get authError(): string | null {
    return this._authError;
  }

  /**
   * Connect by validating credentials and fetching an access token.
   * If env vars are empty, attempts auto-scan of local credential files.
   */
  async connect() {
    // Auto-scan if no env vars set
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.log("[Calendar] No Google env vars — scanning local credentials...");
      const { credentials, sources } = await scanForGoogleCredentials();

      for (const s of sources) {
        console.log(`[Calendar]   ${s.found ? "✓" : "✗"} ${s.path} (${s.type})`);
      }

      if (credentials) {
        this.clientId = credentials.clientId;
        this.clientSecret = credentials.clientSecret;
        this.refreshToken = credentials.refreshToken;
        console.log("[Calendar] Found Google OAuth credentials via auto-scan");
      } else {
        console.warn("[Calendar] No Google credentials found. Calendar features disabled.");
        this._connected = false;
        return;
      }
    }

    try {
      await this.refreshAccessToken();
      this._connected = true;
      this._authError = null;
      console.log("[Calendar] Google Calendar connected");
    } catch (e: any) {
      console.warn("[Calendar] Failed to connect:", e.message);
      this._connected = false;
      this._authError = e.message;
    }
  }

  /** Refresh the OAuth2 access token using the refresh token */
  private async refreshAccessToken(): Promise<void> {
    const res = await googleFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Connection: "close" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000 - 60_000; // 1 min buffer
  }

  /** Get a valid access token, refreshing if expired */
  private async getToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      try {
        await this.refreshAccessToken();
        // Clear any previous auth error on successful refresh
        if (this._authError) {
          this._authError = null;
          console.log("[Calendar] Token refreshed successfully — auth error cleared");
        }
      } catch (e: any) {
        // Runtime auth failure — mark disconnected and notify
        const msg = e.message || "Unknown auth error";
        console.error("[Calendar] Runtime auth failure:", msg);
        this._connected = false;
        this._authError = msg;
        this.onAuthError?.(msg);
        throw e;
      }
    }
    return this.accessToken;
  }

  /** Make an authenticated request to the Google Calendar API.
   *  Includes timeout + retry on socket close (Bun fetch keep-alive issue). */
  private async calendarFetch(path: string, options: RequestInit = {}, retry = 1): Promise<any> {
    const token = await this.getToken();
    try {
      const res = await googleFetch(`${CALENDAR_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connection": "close", // Avoid keep-alive socket reuse issues
          ...options.headers,
        },
        signal: AbortSignal.timeout(15000), // 15s timeout
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Calendar API error (${res.status}): ${err}`);
      }

      return res.json();
    } catch (e: any) {
      // Retry once on socket close errors (Bun keep-alive issue)
      if (retry > 0 && (e.message?.includes("socket") || e.message?.includes("closed unexpectedly"))) {
        console.warn("[Calendar] Socket closed, retrying...");
        return this.calendarFetch(path, options, retry - 1);
      }
      throw e;
    }
  }

  private _listErrorCount = 0;

  async listUpcomingEvents(maxResults = 10): Promise<CalendarEvent[]> {
    if (!this._connected) return [];

    // Back off after repeated failures (stop log flooding)
    if (this._listErrorCount >= 3) {
      // Only retry every 10th call after 3 consecutive failures
      this._listErrorCount++;
      if (this._listErrorCount % 10 !== 0) return [];
    }

    try {
      const data = await this.calendarFetch(
        `/calendars/primary/events?` +
          new URLSearchParams({
            maxResults: String(maxResults),
            timeMin: new Date().toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
          })
      );

      this._listErrorCount = 0; // Reset on success
      return (data.items || []).map((item: any) => ({
        id: item.id || "",
        summary: item.summary || "(no title)",
        start: item.start?.dateTime || item.start?.date || "",
        end: item.end?.dateTime || item.end?.date || "",
        attendees: (item.attendees || []).map((a: any) => ({
          email: a.email,
          displayName: a.displayName || undefined,
          responseStatus: a.responseStatus || undefined,
          self: a.self || undefined,
        })),
        meetLink: item.hangoutLink || item.conferenceData?.entryPoints?.[0]?.uri || undefined,
      }));
    } catch (e: any) {
      this._listErrorCount++;
      if (this._listErrorCount <= 3) {
        console.error("[Calendar] listUpcomingEvents error:", e.message);
      } else if (this._listErrorCount === 4) {
        console.error("[Calendar] listUpcomingEvents repeated failures — suppressing logs (will retry periodically)");
      }
      return [];
    }
  }

  /**
   * Find a calendar event by its Google Meet URL.
   * Searches upcoming events (next 24h) and matches the hangoutLink.
   */
  async findEventByMeetUrl(meetUrl: string): Promise<CalendarEvent | null> {
    if (!this._connected) return null;

    try {
      // Extract the Meet code (abc-defg-hij) for flexible matching
      const meetCode = meetUrl.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1];
      if (!meetCode) return null;

      const events = await this.listUpcomingEvents(20);
      return events.find((e) => e.meetLink?.includes(meetCode)) || null;
    } catch (e: any) {
      console.error("[Calendar] findEventByMeetUrl error:", e.message);
      return null;
    }
  }

  async createEvent(event: CalendarEvent): Promise<string> {
    if (!this._connected) return this._authError
      ? `Calendar auth error: ${this._authError}`
      : "Calendar not connected";

    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const body: any = {
        summary: event.summary,
        start: { dateTime: event.start, timeZone: tz },
        end: { dateTime: event.end, timeZone: tz },
        conferenceData: {
          createRequest: {
            requestId: `cc-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      };

      if (event.attendees?.length) {
        body.attendees = event.attendees.map((a) => ({ email: a.email }));
      }

      const data = await this.calendarFetch(
        `/calendars/primary/events?conferenceDataVersion=1`,
        { method: "POST", body: JSON.stringify(body) }
      );

      const meetLink = data.hangoutLink || data.conferenceData?.entryPoints?.[0]?.uri || "";
      return JSON.stringify({
        id: data.id,
        summary: data.summary,
        start: data.start?.dateTime,
        end: data.end?.dateTime,
        meetLink,
        htmlLink: data.htmlLink,
      });
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  /**
   * Patch an existing calendar event (partial update).
   * Used to add meeting notes URL to event description after meeting ends.
   */
  async patchEvent(eventId: string, updates: { description?: string }): Promise<boolean> {
    if (!this._connected || !eventId) return false;

    try {
      await this.calendarFetch(
        `/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", body: JSON.stringify(updates) }
      );
      console.log(`[Calendar] Event ${eventId} patched`);
      return true;
    } catch (e: any) {
      console.warn(`[Calendar] patchEvent failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Accept a calendar invite by patching CallingClaw's attendee status to "accepted".
   * Google Calendar API requires sending the full attendees array with the updated status.
   */
  async acceptInvite(eventId: string, selfEmail: string): Promise<boolean> {
    if (!this._connected || !eventId) return false;

    try {
      // Fetch the full event to get the current attendees list
      const event = await this.calendarFetch(
        `/calendars/primary/events/${encodeURIComponent(eventId)}`
      );

      const attendees = event.attendees || [];
      const selfLower = selfEmail.toLowerCase();
      let found = false;

      // Update CallingClaw's responseStatus to "accepted"
      for (const a of attendees) {
        if (a.email?.toLowerCase() === selfLower || a.self === true) {
          a.responseStatus = "accepted";
          found = true;
          break;
        }
      }

      if (!found) {
        console.warn(`[Calendar] acceptInvite: ${selfEmail} not found in attendees for event ${eventId}`);
        return false;
      }

      await this.calendarFetch(
        `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "PATCH", body: JSON.stringify({ attendees }) }
      );
      console.log(`[Calendar] Accepted invite for event ${eventId}`);
      return true;
    } catch (e: any) {
      console.warn(`[Calendar] acceptInvite failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Get the authenticated user's email address from the calendar API.
   * Used to identify CallingClaw's own attendee entry in events.
   */
  private _selfEmail: string | null = null;
  async getSelfEmail(): Promise<string | null> {
    if (this._selfEmail) return this._selfEmail;
    if (!this._connected) return null;

    try {
      const data = await this.calendarFetch("/calendars/primary");
      this._selfEmail = data.id || null; // Google Calendar "primary" id = owner email
      return this._selfEmail;
    } catch {
      return null;
    }
  }

  async findFreeSlots(duration: number = 30, withinHours: number = 24): Promise<string[]> {
    if (!this._connected) return [];

    try {
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + withinHours * 3600000).toISOString();

      const token = await this.getToken();
      const res = await googleFetch(`${CALENDAR_API}/freeBusy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin,
          timeMax,
          items: [{ id: "primary" }],
        }),
      });

      if (!res.ok) return [];

      const data = await res.json();
      const busy = data.calendars?.primary?.busy || [];

      const slots: string[] = [];
      let cursor = new Date(timeMin);
      const end = new Date(timeMax);

      for (const period of busy) {
        const busyStart = new Date(period.start);
        const gap = (busyStart.getTime() - cursor.getTime()) / 60000;
        if (gap >= duration) {
          slots.push(`${cursor.toISOString()} — ${busyStart.toISOString()} (${Math.round(gap)} min free)`);
        }
        cursor = new Date(period.end);
      }

      const remaining = (end.getTime() - cursor.getTime()) / 60000;
      if (remaining >= duration) {
        slots.push(`${cursor.toISOString()} — ${end.toISOString()} (${Math.round(remaining)} min free)`);
      }

      return slots;
    } catch {
      return [];
    }
  }

  /** Update credentials at runtime (e.g., from scan or user input) */
  setCredentials(creds: GoogleOAuthCredentials) {
    this.clientId = creds.clientId;
    this.clientSecret = creds.clientSecret;
    this.refreshToken = creds.refreshToken;
    this.accessToken = "";
    this.tokenExpiry = 0;
  }

  disconnect() {
    this._connected = false;
    this.accessToken = "";
  }

  /**
   * Start a background reconnection loop.
   * If calendar is disconnected, retries connect() every intervalMs.
   * Stops once connected. Safe to call multiple times (no-ops if already running).
   */
  private _reconnectTimer: ReturnType<typeof setInterval> | null = null;
  startAutoReconnect(intervalMs = 5 * 60_000) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setInterval(async () => {
      if (this._connected) {
        // Already connected, stop retrying
        if (this._reconnectTimer) {
          clearInterval(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        return;
      }
      console.log("[Calendar] Auto-reconnect attempt...");
      try {
        await this.connect();
        if (this._connected) {
          console.log("[Calendar] Auto-reconnect succeeded");
          if (this._reconnectTimer) {
            clearInterval(this._reconnectTimer);
            this._reconnectTimer = null;
          }
        }
      } catch (e: any) {
        console.warn("[Calendar] Auto-reconnect failed:", e.message);
      }
    }, intervalMs);
  }
}
