/**
 * CallingClaw API Types
 */

export type MeetingState = "recording" | "idle" | null;

export type VoiceProvider = "openai" | "grok" | "gemini";

export interface VoiceSession {
  connected: boolean;
  active: boolean;
  transport: string;
  topic?: string;
}

export interface AutomationLayer {
  enabled?: boolean;
  status?: string;
}

export interface AutomationStatus {
  shortcuts?: AutomationLayer;
  playwright?: AutomationLayer;
  computer_use?: AutomationLayer;
}

export interface CallingClawStatus {
  meeting: MeetingState;
  voiceSession: VoiceSession | null;
  transcriptLength: number;
  automation: AutomationStatus;
}

export interface TranscriptEntry {
  speaker: string;
  text: string;
  timestamp: string;
  startTime?: number;
  endTime?: number;
}

export interface ActionItem {
  task: string;
  assignee?: string;
  dueDate?: string;
  priority?: "high" | "medium" | "low";
}

export interface JoinMeetingParams {
  meetUrl: string;
  botName?: string;
  topic?: string;
}

export interface JoinMeetingResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface LeaveResponse {
  success: boolean;
  actionItems?: ActionItem[];
  message?: string;
  error?: string;
}

export interface SpeakParams {
  text: string;
}

export interface InjectContextParams {
  text: string;
}

export interface PresentUrlParams {
  url: string;
}

export interface SendChatParams {
  message: string;
}

export interface SetVoiceProviderParams {
  provider: VoiceProvider;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MeetingBrief {
  topic: string;
  agenda?: string[];
  participants?: string[];
  context?: string;
}

export interface PrepareParams {
  topic: string;
  brief?: MeetingBrief;
}

export interface AutomationParams {
  instruction: string;
}

export interface ScreenShareParams {
  url?: string;
  instruction?: string;
}

// ============================================
// Onboarding & Setup Types
// ============================================

export interface HealthStatus {
  running: boolean;
  version?: string;
  uptime?: number;
  message?: string;
}

export interface ApiKeyStatus {
  name: string;
  configured: boolean;
  masked?: string; // e.g., "sk-...abc123"
  required: boolean;
  description: string;
  url?: string; // Where to get the key
}

export interface ApiKeysResponse {
  keys: ApiKeyStatus[];
}

export interface SetApiKeysParams {
  keys: Record<string, string>;
}

export interface GoogleAuthStatus {
  calendarConnected: boolean;
  chromeLoggedIn: boolean;
  email?: string;
  scopes?: string[];
}

export interface GoogleCredentialScan {
  found: boolean;
  paths?: string[];
  credentials?: {
    clientId?: string;
    hasRefreshToken?: boolean;
  };
}

export interface GoogleOAuthSetParams {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
}

export interface ChromeLoginStatus {
  inProgress: boolean;
  success?: boolean;
  email?: string;
}

export interface ConfigResponse {
  voiceProvider?: VoiceProvider;
  language?: string;
  defaultBotName?: string;
  autoJoinAudio?: boolean;
  autoJoinVideo?: boolean;
  [key: string]: unknown;
}

export interface ConfigUpdateParams {
  [key: string]: unknown;
}

export interface UserEmailParams {
  email: string;
}

export interface SearchPathsParams {
  paths: string[];
}

export interface SearchPathsResponse {
  paths: string[];
}

export interface Capabilities {
  voiceProviders: VoiceProvider[];
  meetingPlatforms: string[];
  automationLayers: {
    name: string;
    available: boolean;
    description: string;
  }[];
  features: {
    name: string;
    available: boolean;
  }[];
}

export interface AudioStatus {
  working: boolean;
  inputDevices: {
    id: string;
    name: string;
    isDefault: boolean;
  }[];
  outputDevices: {
    id: string;
    name: string;
    isDefault: boolean;
  }[];
  selectedInput?: string;
  selectedOutput?: string;
  error?: string;
}

// ============================================
// Permissions & Readiness Types
// ============================================

export interface PermissionStatus {
  granted: boolean;
  canRequest: boolean;
}

export interface PermissionsResponse {
  screenRecording: PermissionStatus;
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
  camera: PermissionStatus;
}

export type PermissionPanel = 'screenRecording' | 'accessibility' | 'microphone' | 'camera';

export interface OpenPermissionsParams {
  panel: PermissionPanel;
}

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface ReadinessResponse {
  ready: boolean;
  checks: ReadinessCheck[];
}

// ============================================
// Calendar & Scheduler Types
// ============================================

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO date string
  end: string;
  meetUrl?: string;
  attendees?: string[];
  description?: string;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
}

export interface ScheduleAutoJoinParams {
  meetUrl: string;
  scheduledTime?: string; // ISO date string
  eventId?: string;
}

export interface ScheduledMeeting {
  id: string;
  meetUrl: string;
  scheduledTime: string;
  eventId?: string;
  status: 'pending' | 'joined' | 'missed' | 'cancelled';
}

export interface SchedulerStatusResponse {
  scheduled: ScheduledMeeting[];
  nextJoin?: ScheduledMeeting;
}

// ============================================
// Additional Types (v1.1.0)
// ============================================

export type MeetingPlatform = 'google_meet' | 'zoom' | 'unknown';

export interface ValidateMeetingUrlParams {
  meetUrl: string;
}

export interface ValidateMeetingUrlResponse {
  valid: boolean;
  platform: MeetingPlatform;
  normalized: string;
}

export interface GetMeetingSummaryParams {
  meetingId?: string;
}

export interface MeetingSummary {
  success: boolean;
  title?: string;
  duration?: string;
  keyTopics?: string[];
  decisions?: string[];
  actionItems?: ActionItem[];
  error?: string;
}

export interface TalkLocallyResponse {
  success: boolean;
  error?: string;
  message?: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  content: string;
  isDefault?: boolean;
}

export interface ListPromptsResponse {
  prompts: PromptTemplate[];
}

export interface UpdatePromptParams {
  promptId: string;
  content: string;
}

export interface UpdatePromptResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface ResetPromptParams {
  promptId: string;
}

export interface ResetPromptResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SubsystemHealth {
  healthy: boolean;
  message?: string;
}

export interface RecoveryHealthResponse {
  browser: SubsystemHealth;
  voice: SubsystemHealth;
  sidecar: SubsystemHealth;
}

export interface RecoveryResponse {
  success: boolean;
  message?: string;
  error?: string;
}
