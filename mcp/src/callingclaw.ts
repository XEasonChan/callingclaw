/**
 * CallingClaw Desktop API Client
 * Communicates with the locally running CallingClaw Desktop app on localhost:4000
 */

import type {
  CallingClawStatus,
  TranscriptEntry,
  ActionItem,
  JoinMeetingParams,
  JoinMeetingResponse,
  LeaveResponse,
  VoiceProvider,
  PrepareParams,
  ScreenShareParams,
  AutomationParams,
  HealthStatus,
  ApiKeysResponse,
  SetApiKeysParams,
  GoogleAuthStatus,
  GoogleCredentialScan,
  GoogleOAuthSetParams,
  ChromeLoginStatus,
  ConfigResponse,
  ConfigUpdateParams,
  SearchPathsResponse,
  Capabilities,
  AudioStatus,
  PermissionsResponse,
  OpenPermissionsParams,
  ReadinessResponse,
  CalendarEventsResponse,
  ScheduleAutoJoinParams,
  SchedulerStatusResponse,
  ValidateMeetingUrlParams,
  ValidateMeetingUrlResponse,
  GetMeetingSummaryParams,
  MeetingSummary,
  TalkLocallyResponse,
  ListPromptsResponse,
  UpdatePromptParams,
  UpdatePromptResponse,
  ResetPromptParams,
  ResetPromptResponse,
  RecoveryHealthResponse,
  RecoveryResponse,
} from "./types.js";

const BASE_URL = "http://localhost:4000";
const DEFAULT_TIMEOUT = 10000;
const JOIN_TIMEOUT = 90000; // 90 seconds for joining meetings

export class CallingClawClient {
  private baseUrl: string;
  private lastTranscriptOffset: number = 0;

  constructor(baseUrl: string = BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Make an HTTP request with timeout
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeout: number = DEFAULT_TIMEOUT
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if CallingClaw Desktop is running and reachable
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current CallingClaw status
   */
  async getStatus(): Promise<CallingClawStatus> {
    return this.request<CallingClawStatus>("/api/status");
  }

  /**
   * Join a video meeting
   */
  async joinMeeting(params: JoinMeetingParams): Promise<JoinMeetingResponse> {
    // If topic is provided, prepare the meeting first
    if (params.topic) {
      await this.prepareMeeting({ topic: params.topic });
    }

    return this.request<JoinMeetingResponse>(
      "/api/meeting/join",
      {
        method: "POST",
        body: JSON.stringify({
          meetUrl: params.meetUrl,
          botName: params.botName || "CoCo",
        }),
      },
      JOIN_TIMEOUT
    );
  }

  /**
   * Leave the current meeting
   */
  async leaveMeeting(): Promise<LeaveResponse> {
    return this.request<LeaveResponse>("/api/meeting/leave", {
      method: "POST",
    });
  }

  /**
   * Prepare meeting with topic and brief
   */
  async prepareMeeting(params: PrepareParams): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/meeting/prepare", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Speak text through the AI voice
   */
  async speak(text: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/voice/text", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Inject context into AI memory without speaking
   */
  async injectContext(text: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/voice/inject", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Share screen with a URL or navigate via instruction
   */
  async shareScreen(params: ScreenShareParams): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/screen/share", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Run an automation action
   */
  async runAutomation(
    params: AutomationParams
  ): Promise<{ success: boolean; result?: string }> {
    return this.request<{ success: boolean; result?: string }>(
      "/api/automation/run",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  /**
   * Get the full transcript
   */
  async getTranscript(): Promise<TranscriptEntry[]> {
    return this.request<TranscriptEntry[]>("/api/transcript");
  }

  /**
   * Get new transcript entries since last call
   */
  async getNewTranscriptEntries(): Promise<TranscriptEntry[]> {
    const transcript = await this.getTranscript();
    const newEntries = transcript.slice(this.lastTranscriptOffset);
    this.lastTranscriptOffset = transcript.length;
    return newEntries;
  }

  /**
   * Reset transcript offset (e.g., when starting a new meeting)
   */
  resetTranscriptOffset(): void {
    this.lastTranscriptOffset = 0;
  }

  /**
   * Send a chat message in the meeting
   */
  async sendChatMessage(message: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/automation/run", {
      method: "POST",
      body: JSON.stringify({
        instruction: `Send chat message: ${message}`,
      }),
    });
  }

  /**
   * Extract action items from the transcript
   */
  async getActionItems(): Promise<ActionItem[]> {
    const transcript = await this.getTranscript();

    // Simple action item extraction from transcript
    // In a real implementation, this might call an AI endpoint
    const actionItems: ActionItem[] = [];
    const actionPatterns = [
      /(?:action item|todo|task|follow up|next step)[:.]?\s*(.+)/i,
      /(?:will|going to|need to|should)\s+(.+?)(?:\.|$)/i,
      /(?:assigned to|owner)[:.]?\s*(\w+).*?[:.]?\s*(.+)/i,
    ];

    for (const entry of transcript) {
      for (const pattern of actionPatterns) {
        const match = entry.text.match(pattern);
        if (match) {
          actionItems.push({
            task: match[1]?.trim() || match[0],
            assignee: entry.speaker,
          });
        }
      }
    }

    return actionItems;
  }

  /**
   * Set the voice AI provider
   */
  async setVoiceProvider(
    provider: VoiceProvider
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("/api/voice/provider", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
  }

  // ============================================
  // Onboarding & Setup Methods
  // ============================================

  /**
   * Check health status - is CallingClaw running and what version?
   */
  async checkHealth(): Promise<HealthStatus> {
    try {
      const status = await this.getStatus();
      return {
        running: true,
        version: (status as unknown as { version?: string }).version,
        message: "CallingClaw Desktop is running",
      };
    } catch {
      return {
        running: false,
        message:
          "CallingClaw Desktop is not running. Please install and launch it from https://callingclaw.com",
      };
    }
  }

  /**
   * Check which API keys are configured
   */
  async checkApiKeys(): Promise<ApiKeysResponse> {
    return this.request<ApiKeysResponse>("/api/keys");
  }

  /**
   * Set API keys (OpenAI, Google, etc.)
   */
  async setApiKeys(
    params: SetApiKeysParams
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Check Google Calendar OAuth and Chrome login status
   */
  async checkGoogleAuth(): Promise<GoogleAuthStatus> {
    return this.request<GoogleAuthStatus>("/api/google/auth-status");
  }

  /**
   * Scan for existing Google OAuth credentials on disk
   */
  async scanGoogleCredentials(): Promise<GoogleCredentialScan> {
    return this.request<GoogleCredentialScan>("/api/google/scan");
  }

  /**
   * Apply found Google credentials
   */
  async applyGoogleCredentials(): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/google/apply",
      { method: "POST" }
    );
  }

  /**
   * Manually set Google OAuth credentials
   */
  async setGoogleCredentials(
    params: GoogleOAuthSetParams
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/google/set",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  /**
   * Open Chrome to Google sign-in page
   */
  async startChromeLogin(): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/google/chrome-login",
      { method: "POST" }
    );
  }

  /**
   * Check if Chrome login succeeded
   */
  async checkChromeLogin(): Promise<ChromeLoginStatus> {
    return this.request<ChromeLoginStatus>("/api/google/chrome-login/check");
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<ConfigResponse> {
    return this.request<ConfigResponse>("/api/config");
  }

  /**
   * Update configuration
   */
  async setConfig(
    params: ConfigUpdateParams
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>("/api/config", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Get user email
   */
  async getUserEmail(): Promise<{ email?: string }> {
    return this.request<{ email?: string }>("/api/config/user-email");
  }

  /**
   * Set user email
   */
  async setUserEmail(
    email: string
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/config/user-email",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      }
    );
  }

  /**
   * Get search paths
   */
  async getSearchPaths(): Promise<SearchPathsResponse> {
    return this.request<SearchPathsResponse>("/api/config/paths");
  }

  /**
   * Set search paths
   */
  async setSearchPaths(
    paths: string[]
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/config/paths",
      {
        method: "POST",
        body: JSON.stringify({ paths }),
      }
    );
  }

  /**
   * Check what capabilities are available
   */
  async checkCapabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/api/capabilities");
  }

  /**
   * Check audio pipeline status
   */
  async checkAudio(): Promise<AudioStatus> {
    return this.request<AudioStatus>("/api/audio/status");
  }

  // ============================================
  // Permissions & Readiness Methods
  // ============================================

  /**
   * Check macOS permission status
   */
  async checkPermissions(): Promise<PermissionsResponse> {
    return this.request<PermissionsResponse>("/api/onboarding/permissions");
  }

  /**
   * Open macOS System Settings to a specific permission panel
   */
  async openPermissions(
    params: OpenPermissionsParams
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      "/api/onboarding/permissions/open",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  /**
   * Check full readiness (all prerequisites in one call)
   */
  async checkReady(): Promise<ReadinessResponse> {
    return this.request<ReadinessResponse>("/api/onboarding/ready");
  }

  // ============================================
  // Calendar & Scheduler Methods
  // ============================================

  /**
   * List upcoming calendar events
   */
  async listCalendarEvents(): Promise<CalendarEventsResponse> {
    return this.request<CalendarEventsResponse>("/api/calendar/events");
  }

  /**
   * Schedule CallingClaw to auto-join a future meeting
   */
  async scheduleAutoJoin(
    params: ScheduleAutoJoinParams
  ): Promise<{ success: boolean; id?: string; message?: string }> {
    return this.request<{ success: boolean; id?: string; message?: string }>(
      "/api/scheduler/schedule",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  /**
   * Get scheduler status (scheduled meetings, next join)
   */
  async getSchedulerStatus(): Promise<SchedulerStatusResponse> {
    return this.request<SchedulerStatusResponse>("/api/scheduler/status");
  }

  // ============================================
  // Additional Methods (v1.1.0)
  // ============================================

  /**
   * Validate a meeting URL before attempting to join
   */
  async validateMeetingUrl(
    params: ValidateMeetingUrlParams
  ): Promise<ValidateMeetingUrlResponse> {
    return this.request<ValidateMeetingUrlResponse>("/api/meeting/validate", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /**
   * Get a meeting summary (current or past meeting)
   */
  async getMeetingSummary(params: GetMeetingSummaryParams): Promise<MeetingSummary> {
    if (params.meetingId) {
      return this.request<MeetingSummary>(
        `/api/meeting/summary/${params.meetingId}`
      );
    }
    return this.request<MeetingSummary>("/api/meeting/summary", {
      method: "POST",
    });
  }

  /**
   * Start local voice chat (no meeting join)
   */
  async startLocalVoice(): Promise<TalkLocallyResponse> {
    return this.request<TalkLocallyResponse>("/api/meeting/talk-locally", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
  }

  /**
   * Stop local voice chat
   */
  async stopLocalVoice(): Promise<TalkLocallyResponse> {
    return this.request<TalkLocallyResponse>("/api/meeting/talk-locally/stop", {
      method: "POST",
    });
  }

  /**
   * List all prompt templates
   */
  async listPrompts(): Promise<ListPromptsResponse> {
    return this.request<ListPromptsResponse>("/api/prompts");
  }

  /**
   * Update a prompt template
   */
  async updatePrompt(params: UpdatePromptParams): Promise<UpdatePromptResponse> {
    return this.request<UpdatePromptResponse>(
      `/api/prompts/${params.promptId}`,
      {
        method: "PUT",
        body: JSON.stringify({ content: params.content }),
      }
    );
  }

  /**
   * Reset a prompt template to default
   */
  async resetPrompt(params: ResetPromptParams): Promise<ResetPromptResponse> {
    return this.request<ResetPromptResponse>(
      `/api/prompts/${params.promptId}/reset`,
      { method: "POST" }
    );
  }

  /**
   * Get health status of all subsystems
   */
  async getRecoveryHealth(): Promise<RecoveryHealthResponse> {
    return this.request<RecoveryHealthResponse>("/api/recovery/health");
  }

  /**
   * Restart Playwright browser
   */
  async recoverBrowser(): Promise<RecoveryResponse> {
    return this.request<RecoveryResponse>("/api/recovery/browser", {
      method: "POST",
    });
  }

  /**
   * Restart voice session
   */
  async recoverVoice(): Promise<RecoveryResponse> {
    return this.request<RecoveryResponse>("/api/recovery/voice", {
      method: "POST",
    });
  }
}

// Singleton instance
export const callingClaw = new CallingClawClient();
