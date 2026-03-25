// CallingClaw 2.0 — Module Registry
// All modules are independently testable and share context via SharedContext

export { SharedContext } from "./shared-context";
export { AuthModule } from "./auth";
export { VoiceModule } from "./voice";
export { VoiceTracer, type VoiceTurnTrace } from "./voice-trace";
export { VisionModule } from "./vision";
export { ComputerUseModule } from "./computer-use";
export { MeetingModule } from "./meeting";
export { EventBus } from "./event-bus";
export { TaskStore } from "./task-store";
export { AutomationRouter } from "./automation-router";
export { ContextSync } from "./context-sync";
export { TranscriptAuditor, AUDITOR_MANAGED_TOOLS } from "./transcript-auditor";
export { BrowserActionLoop } from "./browser-action-loop";
export { MeetingScheduler } from "./meeting-scheduler";
export { SessionManager } from "./session-manager";
export { PostMeetingDelivery } from "./post-meeting-delivery";
export { ContextRetriever } from "./context-retriever";
export * from "./shared-documents";
