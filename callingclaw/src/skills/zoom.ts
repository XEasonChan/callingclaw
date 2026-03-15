// CallingClaw 2.0 — Skill: Zoom Desktop App Control
// Fast, deterministic Zoom operations via keyboard shortcuts + AppleScript.
// No AI vision needed — these are 100% reliable native macOS commands.

import type { PythonBridge } from "../bridge";

// ── Zoom Keyboard Shortcuts ──────────────────────────────────────
// Reference: https://support.zoom.us/hc/en-us/articles/205683899

export const ZOOM_SHORTCUTS = {
  // Audio & Video
  toggleMute:       "command+shift+a",
  toggleVideo:      "command+shift+v",
  pushToTalk:       "space",               // hold to temporarily unmute

  // Screen Sharing
  startShare:       "command+shift+s",
  pauseShare:       "command+shift+t",
  // stopShare uses the same toggle: command+shift+s when sharing

  // Meeting Controls
  endMeeting:       "command+w",
  toggleFullScreen: "command+shift+f",
  raiseHand:        "option+y",

  // Views
  galleryView:      "command+shift+w",     // toggle gallery/speaker
  toggleChat:       "command+shift+h",
  toggleParticipants: "command+u",

  // Recording
  startRecording:   "command+shift+r",
  pauseRecording:   "command+shift+p",

  // Navigation
  nextTab:          "command+shift+right",
  prevTab:          "command+shift+left",

  // Misc
  toggleMinimize:   "command+shift+m",
  switchToPortrait: "command+shift+l",
} as const;

// ── AppleScript commands for operations that need more than shortcuts ──

const ZOOM_SCRIPTS = {
  /** Activate Zoom (bring to front) */
  activate: `tell application "zoom.us" to activate`,

  /** Check if Zoom is running */
  isRunning: `tell application "System Events" to (name of processes) contains "zoom.us"`,

  /** Launch Zoom */
  launch: `open -a "zoom.us"`,

  /** Join meeting by URL */
  joinUrl: (url: string) => `open "${url}"`,

  /** Join meeting by ID */
  joinById: (meetingId: string, password?: string) =>
    `tell application "System Events"
      tell process "zoom.us"
        keystroke "j" using {command down}
        delay 0.5
        keystroke "${meetingId}"
        delay 0.3
        keystroke return
        ${password ? `delay 2\nkeystroke "${password}"\ndelay 0.3\nkeystroke return` : ""}
      end tell
    end tell`,

  /** Click a specific UI element via AX (System Events) */
  clickButton: (buttonTitle: string) =>
    `tell application "System Events"
      tell process "zoom.us"
        set frontmost to true
        delay 0.3
        try
          click button "${buttonTitle}" of window 1
        on error
          click button "${buttonTitle}" of group 1 of window 1
        end try
      end tell
    end tell`,

  /** Select screen to share in the Share picker dialog */
  selectShareTarget: (target: string) =>
    `tell application "System Events"
      tell process "zoom.us"
        delay 0.5
        try
          click radio button "${target}" of window 1
        on error
          -- Try scrolling through share targets
          click static text "${target}" of window 1
        end try
        delay 0.3
        click button "Share" of window 1
      end tell
    end tell`,

  /** Send chat message */
  sendChat: (message: string) =>
    `tell application "System Events"
      tell process "zoom.us"
        keystroke "h" using {command down, shift down}
        delay 0.5
        keystroke "${message.replace(/"/g, '\\"')}"
        keystroke return
      end tell
    end tell`,
} as const;

// ── Zoom Skill Class ──

export type ZoomAction =
  | "activate" | "launch" | "join_url" | "join_id"
  | "mute" | "unmute" | "toggle_mute"
  | "video_on" | "video_off" | "toggle_video"
  | "start_share" | "stop_share" | "pause_share"
  | "share_screen" | "share_window"
  | "end_meeting" | "leave_meeting"
  | "raise_hand" | "lower_hand"
  | "gallery_view" | "speaker_view"
  | "toggle_chat" | "toggle_participants"
  | "start_recording" | "pause_recording"
  | "fullscreen" | "send_chat";

export interface ZoomActionResult {
  success: boolean;
  action: ZoomAction;
  detail: string;
  durationMs: number;
}

export class ZoomSkill {
  private bridge: PythonBridge;

  constructor(bridge: PythonBridge) {
    this.bridge = bridge;
  }

  /** Execute a Zoom action. Returns result in <5ms for shortcuts, <1s for AppleScript. */
  async execute(action: ZoomAction, params?: Record<string, string>): Promise<ZoomActionResult> {
    const start = performance.now();

    try {
      let detail = "";

      switch (action) {
        // ── App lifecycle ──
        case "activate":
          await this.runScript(ZOOM_SCRIPTS.activate);
          detail = "Zoom activated";
          break;

        case "launch":
          await this.runCommand(ZOOM_SCRIPTS.launch);
          detail = "Zoom launched";
          break;

        case "join_url":
          if (!params?.url) throw new Error("Missing url parameter");
          await this.runCommand(ZOOM_SCRIPTS.joinUrl(params.url));
          detail = `Joining: ${params.url}`;
          break;

        case "join_id":
          if (!params?.meeting_id) throw new Error("Missing meeting_id parameter");
          await this.runScript(ZOOM_SCRIPTS.joinById(params.meeting_id, params.password));
          detail = `Joining meeting: ${params.meeting_id}`;
          break;

        // ── Audio ──
        case "mute":
        case "unmute":
        case "toggle_mute":
          this.sendKey(ZOOM_SHORTCUTS.toggleMute);
          detail = "Toggled mute";
          break;

        // ── Video ──
        case "video_on":
        case "video_off":
        case "toggle_video":
          this.sendKey(ZOOM_SHORTCUTS.toggleVideo);
          detail = "Toggled video";
          break;

        // ── Screen sharing ──
        case "start_share":
          this.sendKey(ZOOM_SHORTCUTS.startShare);
          detail = "Screen share dialog opened";
          break;

        case "stop_share":
          this.sendKey(ZOOM_SHORTCUTS.startShare); // same shortcut toggles
          detail = "Screen sharing stopped";
          break;

        case "pause_share":
          this.sendKey(ZOOM_SHORTCUTS.pauseShare);
          detail = "Screen sharing paused/resumed";
          break;

        case "share_screen":
          // Open share picker → select Desktop → click Share
          this.sendKey(ZOOM_SHORTCUTS.startShare);
          await this.wait(1000);
          await this.runScript(ZOOM_SCRIPTS.selectShareTarget(params?.target || "Desktop 1"));
          detail = `Sharing: ${params?.target || "Desktop 1"}`;
          break;

        case "share_window":
          // Open share picker → select a specific window
          this.sendKey(ZOOM_SHORTCUTS.startShare);
          await this.wait(1000);
          if (params?.window_name) {
            await this.runScript(ZOOM_SCRIPTS.selectShareTarget(params.window_name));
          }
          detail = `Sharing window: ${params?.window_name || "selected"}`;
          break;

        // ── Meeting lifecycle ──
        case "end_meeting":
        case "leave_meeting":
          this.sendKey(ZOOM_SHORTCUTS.endMeeting);
          detail = "Ending/leaving meeting";
          break;

        // ── Reactions & UI ──
        case "raise_hand":
        case "lower_hand":
          this.sendKey(ZOOM_SHORTCUTS.raiseHand);
          detail = "Toggled hand raise";
          break;

        case "gallery_view":
        case "speaker_view":
          this.sendKey(ZOOM_SHORTCUTS.galleryView);
          detail = "Toggled view mode";
          break;

        case "toggle_chat":
          this.sendKey(ZOOM_SHORTCUTS.toggleChat);
          detail = "Toggled chat panel";
          break;

        case "toggle_participants":
          this.sendKey(ZOOM_SHORTCUTS.toggleParticipants);
          detail = "Toggled participants panel";
          break;

        // ── Recording ──
        case "start_recording":
          this.sendKey(ZOOM_SHORTCUTS.startRecording);
          detail = "Recording started/stopped";
          break;

        case "pause_recording":
          this.sendKey(ZOOM_SHORTCUTS.pauseRecording);
          detail = "Recording paused/resumed";
          break;

        // ── Others ──
        case "fullscreen":
          this.sendKey(ZOOM_SHORTCUTS.toggleFullScreen);
          detail = "Toggled fullscreen";
          break;

        case "send_chat":
          if (!params?.message) throw new Error("Missing message parameter");
          await this.runScript(ZOOM_SCRIPTS.sendChat(params.message));
          detail = `Chat sent: "${params.message.slice(0, 40)}"`;
          break;

        default:
          throw new Error(`Unknown Zoom action: ${action}`);
      }

      return {
        success: true,
        action,
        detail,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (e: any) {
      return {
        success: false,
        action,
        detail: `Error: ${e.message}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Send a keyboard shortcut via the Python bridge */
  private sendKey(shortcut: string) {
    this.bridge.sendAction("key", { key: shortcut });
  }

  /** Run an AppleScript via osascript */
  private async runScript(script: string): Promise<string> {
    const result = await Bun.$`osascript -e ${script}`.quiet().nothrow();
    return result.stdout?.toString?.() || "";
  }

  /** Run a shell command */
  private async runCommand(cmd: string): Promise<string> {
    const result = await Bun.$`bash -c ${cmd}`.quiet().nothrow();
    return result.stdout?.toString?.() || "";
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── Meet Skill (same pattern) ──

export const MEET_SHORTCUTS = {
  toggleMute:   "command+d",
  toggleVideo:  "command+e",
  raiseHand:    "command+alt+h",
  toggleChat:   "command+alt+c",
  endCall:      "command+shift+h",   // custom, assigned in MeetJoiner
} as const;
