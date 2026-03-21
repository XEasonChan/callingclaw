// CallingClaw 2.0 — Typed Voice Event Schema
// Decouples business logic from provider-specific JSON payloads.
// RealtimeClient normalizes provider events → these typed events.

/** Audio data frame (mic input or AI output) */
export interface AudioFrame {
  type: "audio";
  direction: "input" | "output";
  data: string;        // base64 PCM16
  samples: number;     // sample count
  sampleRate: number;  // Hz
  timestamp: number;   // ms since epoch
}

/** Text content (user speech transcript, AI response transcript) */
export interface TextFrame {
  type: "text";
  role: "user" | "assistant" | "system";
  text: string;
  isFinal: boolean;    // false = streaming delta, true = complete
  timestamp: number;
}

/** Context injection or update */
export interface ContextFrame {
  type: "context";
  action: "inject" | "remove" | "clear";
  id?: string;
  text?: string;
  source: string;      // e.g. "retriever", "computer_use", "meeting_prep"
  tokenEstimate?: number;
  timestamp: number;
}

/** Tool invocation event */
export interface ToolEvent {
  type: "tool";
  phase: "call" | "result" | "error";
  name: string;
  callId: string;
  args?: any;
  result?: string;
  durationMs?: number;
  isAsync: boolean;    // true = slow tool dispatched async
  timestamp: number;
}

/** Session lifecycle event */
export interface SessionEvent {
  type: "session";
  action: "connected" | "disconnected" | "reconnecting" | "resumed" | "error";
  provider: string;
  reason?: string;
  timestamp: number;
}

/** Audio state transition */
export interface AudioStateEvent {
  type: "audio_state";
  from: string;
  to: string;
  timestamp: number;
}

/** Union of all voice events */
export type VoiceEvent =
  | AudioFrame
  | TextFrame
  | ContextFrame
  | ToolEvent
  | SessionEvent
  | AudioStateEvent;

/** Helper to create events with auto-timestamp */
export function createVoiceEvent<T extends VoiceEvent>(event: Omit<T, 'timestamp'> & { timestamp?: number }): T {
  return { ...event, timestamp: event.timestamp || Date.now() } as T;
}
