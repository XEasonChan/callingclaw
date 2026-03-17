// CallingClaw 2.0 — Meeting Auto-Joiner (Google Meet + Zoom)
// Uses scripted browser/app automation (no Anthropic API needed)
// Joins a meeting link, mutes camera, and enables virtual audio routing

import type { PythonBridge } from "./bridge";

// ── System Audio Device Management ──────────────────────────────
// Uses SwitchAudioSource CLI to change macOS system default audio devices.
// Chrome/Meet follows system defaults, so this avoids any in-browser config.

interface SavedAudioDevices {
  input: string;
  output: string;
}

async function getCurrentAudioDevices(): Promise<SavedAudioDevices> {
  try {
    const output = await Bun.$`SwitchAudioSource -c`.text();
    const input = await Bun.$`SwitchAudioSource -c -t input`.text();
    return { output: output.trim(), input: input.trim() };
  } catch {
    return { output: "", input: "" };
  }
}

async function switchAudioToBlackHole(): Promise<SavedAudioDevices | null> {
  try {
    // Check if SwitchAudioSource is installed
    await Bun.$`which SwitchAudioSource`.quiet();
  } catch {
    console.log("[Audio] SwitchAudioSource not found. Install: brew install switchaudio-osx");
    console.log("[Audio] Skipping system audio device switch.");
    return null;
  }

  try {
    // Check if BlackHole devices exist
    const devices = await Bun.$`SwitchAudioSource -a`.text();
    const hasBH2 = devices.includes("BlackHole 2ch");
    const hasBH16 = devices.includes("BlackHole 16ch");

    if (!hasBH2 || !hasBH16) {
      console.log(`[Audio] BlackHole not fully available (2ch:${hasBH2} 16ch:${hasBH16})`);
      console.log("[Audio] Install: brew install blackhole-2ch blackhole-16ch && reboot");
      return null;
    }

    // Save current devices before switching
    const saved = await getCurrentAudioDevices();
    console.log(`[Audio] Saving current devices — output: "${saved.output}", input: "${saved.input}"`);

    // Switch system defaults to BlackHole
    // Input (mic) → BlackHole 16ch: AI voice output feeds into Meet's mic
    // Output (speaker) → BlackHole 2ch: Meet audio captured by AI
    await Bun.$`SwitchAudioSource -s "BlackHole 16ch" -t input`.quiet();
    await Bun.$`SwitchAudioSource -s "BlackHole 2ch" -t output`.quiet();

    console.log("[Audio] ✅ System audio switched to BlackHole (mic→16ch, speaker→2ch)");
    return saved;
  } catch (e: any) {
    console.error("[Audio] Failed to switch audio devices:", e.message);
    return null;
  }
}

async function restoreAudioDevices(saved: SavedAudioDevices): Promise<void> {
  try {
    if (saved.output) {
      await Bun.$`SwitchAudioSource -s ${saved.output} -t output`.quiet();
    }
    if (saved.input) {
      await Bun.$`SwitchAudioSource -s ${saved.input} -t input`.quiet();
    }
    console.log(`[Audio] ✅ Restored audio devices — output: "${saved.output}", input: "${saved.input}"`);
  } catch (e: any) {
    console.error("[Audio] Failed to restore audio devices:", e.message);
  }
}

// ── Meeting URL Validation Regexes ──────────────────────────────

// Google Meet: https://meet.google.com/xxx-xxxx-xxx (3-4-3 lowercase letters)
// Also supports query params: ?authuser=0, ?hs=122, etc.
export const MEET_URL_REGEX = /^https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#].*)?$/;
export const MEET_URL_LOOSE = /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;

// Zoom URLs:
//   https://zoom.us/j/12345678901?pwd=xxxxx
//   https://us02web.zoom.us/j/12345678901?pwd=xxxxx
//   https://COMPANY.zoom.us/j/12345678901
//   https://zoom.us/my/username
//   zoommtg://zoom.us/join?confno=12345678901&pwd=xxxxx
export const ZOOM_URL_REGEX = /^(?:https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my)\/[\w./?=&%-]+|zoommtg:\/\/zoom\.us\/join\?[\w=&%-]+)$/;
export const ZOOM_URL_LOOSE = /https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my)\/[\w./?=&%-]+/;

export type MeetingPlatform = "google_meet" | "zoom" | "unknown";

/** Detect meeting platform from a URL */
export function detectPlatform(url: string): MeetingPlatform {
  if (MEET_URL_LOOSE.test(url)) return "google_meet";
  if (ZOOM_URL_LOOSE.test(url) || url.startsWith("zoommtg://")) return "zoom";
  return "unknown";
}

/** Validate and normalize a meeting URL. Returns null if invalid. */
export function validateMeetingUrl(raw: string): {
  url: string;
  platform: MeetingPlatform;
} | null {
  const trimmed = raw.trim();

  // Try Google Meet
  const meetMatch = trimmed.match(MEET_URL_LOOSE);
  if (meetMatch) return { url: meetMatch[0], platform: "google_meet" };

  // Try Zoom
  const zoomMatch = trimmed.match(ZOOM_URL_LOOSE);
  if (zoomMatch) return { url: zoomMatch[0], platform: "zoom" };

  // Try zoommtg:// protocol
  if (trimmed.startsWith("zoommtg://")) return { url: trimmed, platform: "zoom" };

  return null;
}

export interface MeetJoinOptions {
  meetUrl: string;
  displayName?: string;
  muteMic?: boolean;     // mute real mic (AI will use virtual audio)
  muteCamera?: boolean;  // usually true for AI agent
}

export interface MeetSession {
  meetUrl: string;
  platform: MeetingPlatform;
  joinedAt: number;
  status: "joining" | "in_meeting" | "left" | "error";
  error?: string;
}

/**
 * MeetJoiner handles the scripted flow of:
 * 1. Detecting platform (Google Meet or Zoom)
 * 2. Opening the meeting in Chrome (Meet) or Zoom app (Zoom)
 * 3. Clicking through the join flow
 * 4. Configuring virtual audio device routing
 *
 * The audio flow after joining:
 *   Meeting speakers → System audio capture → Python sidecar → Bun → OpenAI Realtime
 *   OpenAI Realtime → Bun → Python sidecar → Virtual mic → Meeting input
 */
export class MeetJoiner {
  private bridge: PythonBridge;
  private currentSession: MeetSession | null = null;
  private _isSharing = false;
  private savedAudioDevices: SavedAudioDevices | null = null;

  constructor(bridge: PythonBridge) {
    this.bridge = bridge;
  }

  get session() {
    return this.currentSession;
  }

  get isSharing() {
    return this._isSharing;
  }

  /**
   * Join any meeting by URL. Auto-detects platform (Google Meet or Zoom).
   */
  async joinMeeting(options: MeetJoinOptions): Promise<MeetSession> {
    const { meetUrl, muteMic = false, muteCamera = true } = options;

    const validated = validateMeetingUrl(meetUrl);
    const platform = validated?.platform || "unknown";

    this.currentSession = {
      meetUrl: validated?.url || meetUrl,
      platform,
      joinedAt: Date.now(),
      status: "joining",
    };

    if (platform === "unknown") {
      this.currentSession.status = "error";
      this.currentSession.error = `Unrecognized meeting URL. Supported: Google Meet (meet.google.com/xxx-xxxx-xxx) or Zoom (zoom.us/j/xxx)`;
      return this.currentSession;
    }

    console.log(`[Meet] Joining ${platform}: ${this.currentSession.meetUrl}`);

    if (platform === "zoom") {
      return this.joinZoom(this.currentSession.meetUrl, muteMic, muteCamera);
    }

    return this.joinGoogleMeet(this.currentSession.meetUrl, muteMic, muteCamera);
  }

  // ── Google Meet Join Flow ──────────────────────────────────────

  private async joinGoogleMeet(meetUrl: string, muteMic: boolean, muteCamera: boolean): Promise<MeetSession> {
    if (!this.bridge.ready) {
      this.currentSession!.status = "error";
      this.currentSession!.error = "Python sidecar not connected";
      return this.currentSession!;
    }

    try {
      // Step 0: Switch system audio to BlackHole BEFORE opening Meet
      // Chrome will inherit system defaults when it opens the Meet tab
      console.log("[Meet] Switching system audio to BlackHole for Meet bridging...");
      this.savedAudioDevices = await switchAudioToBlackHole();

      // Step 1: Open Meet URL in Chrome
      console.log("[Meet] Opening Chrome with Meet URL...");
      this.bridge.send("action", {
        action: "run_command",
        command: `open -a "Google Chrome" "${meetUrl}"`,
      });
      await this.wait(5000);

      // Step 2: Dismiss any permission/sign-in dialogs via JavaScript
      // Meet often shows "Do you want people to see and hear you?" or "Sign in" dialogs
      console.log("[Meet] Dismissing permission dialogs...");
      this.bridge.send("action", {
        action: "run_command",
        command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
          // Dismiss all dialogs: Got it, Allow, Continue without mic/camera
          document.querySelectorAll(\\"button\\").forEach(function(b) {
            var t = (b.innerText || \\"\\").trim().toLowerCase();
            if (t === \\"got it\\" || t === \\"dismiss\\" || t.includes(\\"continue without\\")) b.click();
          });
        "'`
      });
      await this.wait(2000);

      // Step 3: Configure audio devices in Meet settings BEFORE joining
      // Navigate to Meet settings and set BlackHole devices for audio bridging
      console.log("[Meet] Configuring BlackHole audio devices in Meet...");
      this.bridge.send("action", {
        action: "run_command",
        command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
          (async function() {
            // Enumerate audio devices visible to the browser
            try {
              var devices = await navigator.mediaDevices.enumerateDevices();
              var audioInputs = devices.filter(function(d) { return d.kind === \\"audioinput\\"; });
              var audioOutputs = devices.filter(function(d) { return d.kind === \\"audiooutput\\"; });
              
              // Find BlackHole devices
              var bh16 = audioInputs.find(function(d) { return d.label.includes(\\"BlackHole 16ch\\"); });
              var bh2out = audioOutputs.find(function(d) { return d.label.includes(\\"BlackHole 2ch\\"); });
              
              console.log(\\"[CallingClaw] Audio inputs:\\", audioInputs.map(function(d){return d.label}));
              console.log(\\"[CallingClaw] Audio outputs:\\", audioOutputs.map(function(d){return d.label}));
              console.log(\\"[CallingClaw] BlackHole 16ch (mic):\\", bh16 ? bh16.deviceId : \\"NOT FOUND\\");
              console.log(\\"[CallingClaw] BlackHole 2ch (speaker):\\", bh2out ? bh2out.deviceId : \\"NOT FOUND\\");
              
              // Store device IDs for Meet settings
              window.__callingclaw_mic = bh16 ? bh16.deviceId : null;
              window.__callingclaw_speaker = bh2out ? bh2out.deviceId : null;
              window.__callingclaw_devices = {mic: bh16, speaker: bh2out, allInputs: audioInputs, allOutputs: audioOutputs};
            } catch(e) {
              console.error(\\"[CallingClaw] Device enumeration failed:\\", e);
            }
          })();
        "'`
      });
      await this.wait(2000);

      // Step 4: Open Meet settings panel and change audio devices
      // Click the three-dot menu → Settings → Audio tab
      console.log("[Meet] Opening Meet audio settings...");
      this.bridge.send("action", {
        action: "run_command",
        command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
          (async function() {
            // Click the More options (three dots) button
            var btns = document.querySelectorAll(\\"button\\");
            for (var i = 0; i < btns.length; i++) {
              var ariaLabel = (btns[i].getAttribute(\\"aria-label\\") || \\"\\").toLowerCase();
              if (ariaLabel.includes(\\"more options\\") || ariaLabel.includes(\\"更多选项\\")) {
                btns[i].click();
                break;
              }
            }
            
            // Wait for menu to appear, then click Settings
            await new Promise(function(r) { setTimeout(r, 1000); });
            var menuItems = document.querySelectorAll(\\"li[role=menuitem], div[role=menuitem]\\");
            for (var i = 0; i < menuItems.length; i++) {
              var text = (menuItems[i].textContent || \\"\\").toLowerCase();
              if (text.includes(\\"settings\\") || text.includes(\\"设置\\")) {
                menuItems[i].click();
                break;
              }
            }
            
            // Wait for settings dialog to open, then click Audio tab
            await new Promise(function(r) { setTimeout(r, 1500); });
            var tabs = document.querySelectorAll(\\"div[role=tab], button[role=tab]\\");
            for (var i = 0; i < tabs.length; i++) {
              var text = (tabs[i].textContent || \\"\\").toLowerCase();
              if (text.includes(\\"audio\\") || text.includes(\\"音频\\")) {
                tabs[i].click();
                break;
              }
            }
            
            // Wait for audio tab content
            await new Promise(function(r) { setTimeout(r, 1000); });
            
            // Find and change audio device dropdowns
            // Meet uses select elements or custom dropdowns for audio devices
            var selects = document.querySelectorAll(\\"select\\");
            selects.forEach(function(sel) {
              var label = sel.getAttribute(\\"aria-label\\") || sel.closest(\\"div\\")?.textContent || \\"\\";
              var opts = sel.querySelectorAll(\\"option\\");
              
              opts.forEach(function(opt) {
                // Set microphone to BlackHole 16ch
                if ((label.toLowerCase().includes(\\"microphone\\") || label.toLowerCase().includes(\\"麦克风\\")) 
                    && opt.textContent.includes(\\"BlackHole 16ch\\")) {
                  sel.value = opt.value;
                  sel.dispatchEvent(new Event(\\"change\\", {bubbles: true}));
                  console.log(\\"[CallingClaw] Set microphone to BlackHole 16ch\\");
                }
                // Set speaker to BlackHole 2ch
                if ((label.toLowerCase().includes(\\"speaker\\") || label.toLowerCase().includes(\\"扬声器\\"))
                    && opt.textContent.includes(\\"BlackHole 2ch\\")) {
                  sel.value = opt.value;
                  sel.dispatchEvent(new Event(\\"change\\", {bubbles: true}));
                  console.log(\\"[CallingClaw] Set speaker to BlackHole 2ch\\");
                }
              });
            });
            
            // Close settings dialog
            await new Promise(function(r) { setTimeout(r, 500); });
            var closeBtn = document.querySelector(\\"button[aria-label=Close], button[aria-label=关闭]\\");
            if (closeBtn) closeBtn.click();
          })();
        "'`
      });
      await this.wait(4000);

      // Step 5: Enter name if needed (for guest joining)
      console.log("[Meet] Entering display name...");
      this.bridge.send("action", {
        action: "run_command",
        command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
          var nameInput = document.querySelector(\\"input[placeholder*=name], input[placeholder*=名字], input[aria-label*=name]\\");
          if (nameInput && !nameInput.value) {
            nameInput.focus();
            nameInput.value = \\"CallingClaw\\";
            nameInput.dispatchEvent(new Event(\\"input\\", {bubbles: true}));
            nameInput.dispatchEvent(new Event(\\"change\\", {bubbles: true}));
          }
        "'`
      });
      await this.wait(1000);

      // Step 6: Configure audio/video via Meet keyboard shortcuts
      if (muteCamera) {
        this.bridge.sendAction("key", { key: "command+e" });
        await this.wait(500);
      }
      if (muteMic) {
        this.bridge.sendAction("key", { key: "command+d" });
        await this.wait(500);
      } else {
        // Ensure mic is ON — Chrome/Meet may default to muted.
        // Unmute via JS: click the "Turn on microphone" button if present.
        console.log("[Meet] Ensuring mic is unmuted for BlackHole bridge...");
        this.bridge.send("action", {
          action: "run_command",
          command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
            var micOn = document.querySelector(\\"[aria-label*=\\\\\\"Turn on microphone\\\\\\"], [aria-label*=\\\\\\"打开麦克风\\\\\\"]\\");
            if (micOn) { micOn.click(); \\\\\\"unmuted\\\\\\"; } else { \\\\\\"already_on_or_not_found\\\\\\"; }
          "'`
        });
        await this.wait(500);
      }

      // Step 7: Click "Join now" or "Ask to join" button
      console.log("[Meet] Clicking Join button...");
      this.bridge.send("action", {
        action: "run_command",
        command: `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "
          var btns = document.querySelectorAll(\\"button\\");
          var clicked = false;
          for (var i = 0; i < btns.length; i++) {
            var text = (btns[i].textContent || \\"\\").trim().toLowerCase();
            if ((text === \\"join now\\" || text === \\"ask to join\\" || text === \\"加入会议\\" || text === \\"请求加入\\") && !btns[i].disabled) {
              btns[i].click();
              clicked = true;
              console.log(\\"[CallingClaw] Clicked: \\" + text);
              break;
            }
          }
          if (!clicked) {
            // Enable disabled buttons and try again
            btns.forEach(function(b) {
              var t = (b.textContent || \\"\\").trim().toLowerCase();
              if (t === \\"join now\\" || t === \\"ask to join\\" || t === \\"加入会议\\" || t === \\"请求加入\\") {
                b.disabled = false;
                b.removeAttribute(\\"disabled\\");
                b.click();
                console.log(\\"[CallingClaw] Force-clicked: \\" + t);
              }
            });
          }
        "'`
      });
      await this.wait(5000);

      // Step 8: Setup virtual audio routing on the sidecar (with verification + retry)
      const audioOk = await this.bridge.sendConfigAndVerify(
        { audio_mode: "meet_bridge", capture_system_audio: true, virtual_mic_output: true },
        { timeoutMs: 3000, retries: 3 }
      );
      if (audioOk) {
        console.log("[Meet] ✅ Audio bridge confirmed: meet_bridge");
      } else {
        console.error("[Meet] ⚠️ Audio bridge config NOT confirmed — voice may not work!");
      }

      this.currentSession!.status = "in_meeting";
      console.log("[Meet] Successfully joined Google Meet with BlackHole audio bridging");
      return this.currentSession!;
    } catch (e: any) {
      this.currentSession!.status = "error";
      this.currentSession!.error = e.message;
      console.error("[Meet] Google Meet join failed:", e.message);
      return this.currentSession!;
    }
  }

  // ── Zoom Join Flow ─────────────────────────────────────────────

  private async joinZoom(zoomUrl: string, muteMic: boolean, muteCamera: boolean): Promise<MeetSession> {
    try {
      // Step 0: Switch system audio to BlackHole for audio bridging
      console.log("[Meet] Switching system audio to BlackHole for Zoom bridging...");
      this.savedAudioDevices = await switchAudioToBlackHole();

      // Step 1: Open the Zoom URL — macOS will launch the Zoom desktop app
      // `open` command handles both https://zoom.us/j/ and zoommtg:// links
      await Bun.$`open ${zoomUrl}`.quiet().nothrow();
      console.log("[Meet] Zoom URL opened, waiting for app...");
      await this.wait(5000); // Zoom app needs time to launch + show the join dialog

      // Step 2: Zoom may show a "Open zoom.us?" browser dialog — dismiss it
      // On macOS, pressing Enter typically confirms "Open zoom.us"
      if (this.bridge.ready) {
        this.bridge.sendAction("key", { key: "return" });
        await this.wait(3000);
      }

      // Step 3: Mute audio/video via Zoom keyboard shortcuts
      // These work once the Zoom meeting window has focus
      if (this.bridge.ready) {
        if (muteCamera) {
          // Cmd+Shift+V toggles video in Zoom
          this.bridge.sendAction("key", { key: "command+shift+v" });
          await this.wait(300);
        }
        if (muteMic) {
          // Cmd+Shift+A toggles audio in Zoom
          this.bridge.sendAction("key", { key: "command+shift+a" });
          await this.wait(300);
        }
      }

      // Step 4: Setup virtual audio routing (same as Meet, with verification)
      if (this.bridge.ready) {
        const audioOk = await this.bridge.sendConfigAndVerify(
          { audio_mode: "meet_bridge", capture_system_audio: true, virtual_mic_output: true },
          { timeoutMs: 3000, retries: 3 }
        );
        if (audioOk) {
          console.log("[Meet] ✅ Zoom audio bridge confirmed: meet_bridge");
        } else {
          console.error("[Meet] ⚠️ Zoom audio bridge config NOT confirmed!");
        }
      }

      this.currentSession!.status = "in_meeting";
      console.log("[Meet] Successfully joined Zoom meeting");
      return this.currentSession!;
    } catch (e: any) {
      this.currentSession!.status = "error";
      this.currentSession!.error = e.message;
      console.error("[Meet] Zoom join failed:", e.message);
      return this.currentSession!;
    }
  }

  /**
   * Leave the current meeting (auto-detects platform)
   */
  async leaveMeeting(): Promise<void> {
    if (!this.currentSession || this.currentSession.status !== "in_meeting") {
      return;
    }

    const platform = this.currentSession.platform;
    console.log(`[Meet] Leaving ${platform} meeting...`);

    if (platform === "zoom") {
      // Zoom: Cmd+W to end/leave
      this.bridge.sendAction("key", { key: "command+w" });
      await this.wait(500);
      // Confirm "Leave Meeting" dialog if it appears
      this.bridge.sendAction("key", { key: "return" });
    } else {
      // Google Meet: hangup shortcut
      this.bridge.sendAction("key", { key: "command+shift+h" });
    }

    // Stop virtual audio routing + reset screen capture to mouse-tracking
    this.bridge.send("config", {
      audio_mode: "default",
      capture_system_audio: false,
      virtual_mic_output: false,
      capture_mode: "mouse",
    });

    // Restore original audio devices
    if (this.savedAudioDevices) {
      console.log("[Meet] Restoring original audio devices...");
      await restoreAudioDevices(this.savedAudioDevices);
      this.savedAudioDevices = null;
    }

    this.currentSession.status = "left";
  }

  /**
   * Create a meeting via Google Calendar MCP, get the Meet link,
   * and auto-join it.
   */
  async createAndJoinMeeting(
    calendarClient: any,
    summary: string,
    durationMinutes: number = 30,
    attendees: string[] = []
  ): Promise<MeetSession> {
    const now = new Date();
    const end = new Date(now.getTime() + durationMinutes * 60000);

    console.log(`[Meet] Creating meeting: "${summary}"`);

    const result = await calendarClient.createEvent({
      summary,
      start: now.toISOString(),
      end: end.toISOString(),
      attendees: attendees.map((email: string) => ({ email })),
    });

    // Extract Meet link from calendar event result
    const meetUrlMatch = result.match(MEET_URL_LOOSE);

    if (!meetUrlMatch) {
      return {
        meetUrl: "",
        platform: "google_meet",
        joinedAt: Date.now(),
        status: "error",
        error: "No Meet link generated. Ensure Google Meet is enabled for your calendar.",
      };
    }

    return this.joinMeeting({
      meetUrl: meetUrlMatch[0],
      muteCamera: true,
      muteMic: true,
    });
  }

  /**
   * Share CallingClaw's screen in the current meeting.
   * Supports both Google Meet and Zoom.
   */
  async shareScreen(): Promise<boolean> {
    if (!this.currentSession || this.currentSession.status !== "in_meeting") {
      console.warn("[Meet] Cannot share screen — not in a meeting");
      return false;
    }
    if (this._isSharing) {
      console.log("[Meet] Already sharing screen");
      return true;
    }

    const platform = this.currentSession.platform;
    console.log(`[Meet] Starting screen share (${platform})...`);

    if (platform === "zoom") {
      // Zoom: Cmd+Shift+S opens share picker
      this.bridge.sendAction("key", { key: "command+shift+s" });
      await this.wait(1500);
      // Select "Desktop 1" and click Share via AppleScript
      await Bun.$`osascript -e 'tell application "System Events" to tell process "zoom.us" to keystroke return'`.quiet().nothrow();
      await this.wait(1000);
    } else {
      // Google Meet: click "Present now" → "Entire screen"
      this.bridge.send("action", {
        action: "find_and_click",
        target: "Present now",
        fallback_target: "展示",
      });
      await this.wait(1500);

      this.bridge.send("action", {
        action: "find_and_click",
        target: "Your entire screen",
        fallback_target: "整个屏幕",
      });
      await this.wait(1500);

      // Confirm system share dialog
      this.bridge.sendAction("key", { key: "return" });
      await this.wait(1000);
    }

    this._isSharing = true;
    console.log("[Meet] Screen sharing active");
    return true;
  }

  /**
   * Stop screen sharing.
   */
  async stopSharing(): Promise<void> {
    if (!this._isSharing) return;

    const platform = this.currentSession?.platform;
    console.log(`[Meet] Stopping screen share (${platform})...`);

    if (platform === "zoom") {
      // Zoom: Cmd+Shift+S toggles share off
      this.bridge.sendAction("key", { key: "command+shift+s" });
    } else {
      // Google Meet: click "Stop sharing"
      this.bridge.send("action", {
        action: "find_and_click",
        target: "Stop sharing",
        fallback_target: "停止共享",
      });
    }
    await this.wait(500);

    this._isSharing = false;
    console.log("[Meet] Screen sharing stopped");
  }

  /**
   * Open a file on CallingClaw's screen for presentation.
   * Supports VS Code, browser, and Finder.
   */
  async openFile(filePath: string, app: "vscode" | "browser" | "finder" = "vscode"): Promise<void> {
    console.log(`[Meet] Opening file: ${filePath} (${app})`);

    let command: string;
    switch (app) {
      case "vscode":
        command = `code "${filePath}"`;
        break;
      case "browser":
        command = `open -a "Google Chrome" "${filePath}"`;
        break;
      case "finder":
        command = `open -R "${filePath}"`;
        break;
    }

    this.bridge.send("action", {
      action: "run_command",
      command,
    });
    await this.wait(2000);
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
