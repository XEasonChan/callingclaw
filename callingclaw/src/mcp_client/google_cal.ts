// CallingClaw 2.0 — Google Calendar Client (Direct REST API)
// Uses OAuth2 refresh tokens — no MCP package dependency

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

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

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID || "";
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    this.refreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";
  }

  get connected() {
    return this._connected;
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
      console.log("[Calendar] Google Calendar connected");
    } catch (e: any) {
      console.warn("[Calendar] Failed to connect:", e.message);
      this._connected = false;
    }
  }

  /** Refresh the OAuth2 access token using the refresh token */
  private async refreshAccessToken(): Promise<void> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
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
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /** Make an authenticated request to the Google Calendar API */
  private async calendarFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = await this.getToken();
    const res = await fetch(`${CALENDAR_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Calendar API error (${res.status}): ${err}`);
    }

    return res.json();
  }

  async listUpcomingEvents(maxResults = 10): Promise<CalendarEvent[]> {
    if (!this._connected) return [];

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
      console.error("[Calendar] listUpcomingEvents error:", e.message);
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
    if (!this._connected) return "Calendar not connected";

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

  async findFreeSlots(duration: number = 30, withinHours: number = 24): Promise<string[]> {
    if (!this._connected) return [];

    try {
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + withinHours * 3600000).toISOString();

      const token = await this.getToken();
      const res = await fetch(`${CALENDAR_API}/freeBusy`, {
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
}
