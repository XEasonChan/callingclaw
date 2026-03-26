// CallingClaw 2.0 — Route types
// Shared interfaces for all route modules

import type { InputBridge } from "../bridge";
import type { VoiceModule } from "../modules/voice";
import type { GoogleCalendarClient } from "../mcp_client/google_cal";
import type { SharedContext } from "../modules/shared-context";
import type { MeetingModule } from "../modules/meeting";
import type { ComputerUseModule } from "../modules/computer-use";
import type { MeetJoiner } from "../meet_joiner";
import type { EventBus } from "../modules/event-bus";
import type { TaskStore } from "../modules/task-store";
import type { AutomationRouter } from "../modules/automation-router";
import type { ContextSync } from "../modules/context-sync";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { TranscriptAuditor } from "../modules/transcript-auditor";
import type { BrowserActionLoop } from "../modules/browser-action-loop";
import type { PlaywrightCLIClient } from "../mcp_client/playwright-cli";
import type { MeetingScheduler } from "../modules/meeting-scheduler";
import type { PostMeetingDelivery } from "../modules/post-meeting-delivery";
import type { ChromeLauncher } from "../chrome-launcher";

export interface Services {
  bridge: InputBridge;
  realtime: VoiceModule;
  calendar: GoogleCalendarClient;
  context: SharedContext;
  meeting: MeetingModule;
  computerUse: ComputerUseModule;
  meetJoiner: MeetJoiner;
  eventBus: EventBus;
  taskStore: TaskStore;
  automationRouter?: AutomationRouter;
  contextSync?: ContextSync;
  meetingPrepSkill?: MeetingPrepSkill;
  openclawBridge?: OpenClawBridge;
  transcriptAuditor?: TranscriptAuditor;
  browserLoop?: BrowserActionLoop;
  playwrightCli?: PlaywrightCLIClient;
  chromeLauncher?: ChromeLauncher;
  meetingScheduler?: MeetingScheduler;
  postMeetingDelivery?: PostMeetingDelivery;
  sessionManager?: import("../modules/session-manager").SessionManager;
}

export interface RouteHandler {
  match: (pathname: string, method: string) => boolean;
  handle: (req: Request, url: URL, headers: HeadersInit) => Promise<Response>;
}
