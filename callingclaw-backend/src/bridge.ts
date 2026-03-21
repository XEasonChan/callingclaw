// CallingClaw 2.0 — Native Input Bridge (replaces Python Sidecar)
//
// Executes mouse/keyboard/shell actions directly via osascript + cliclick.
// No WebSocket, no Python, no reconnect loops.
//
// Action mapping:
//   key(hotkey)      → osascript keystroke + modifier keys
//   click(x,y)       → cliclick c:x,y (or dc: / rc:)
//   type(text)        → osascript keystroke
//   scroll(dir,amt)   → cliclick (not supported natively, uses osascript)
//   mouse_move(x,y)   → cliclick m:x,y
//   drag(start,end)   → cliclick dd:x1,y1 du:x2,y2
//   run_command(cmd)  → Bun.$
//   find_and_click    → osascript AppleScript
//   screenshot        → deprecated (use BrowserCaptureProvider/DesktopCaptureProvider)
//   config            → no-op (AudioWorklet handles audio)

// ── InputBridge Interface ──
// All consumers depend on this interface, not the concrete implementation.

export type BridgeMessageType =
  | "audio_chunk"
  | "audio_playback"
  | "screenshot"
  | "action"
  | "action_result"
  | "status"
  | "config"
  | "ping";

export interface BridgeMessage {
  type: BridgeMessageType;
  payload: any;
  ts: number;
}

export interface InputBridge {
  readonly ready: boolean;
  send(type: BridgeMessageType, payload: any): boolean;
  sendAction(action: string, params?: Record<string, any>): boolean;
  sendAudioPlayback(base64Pcm: string): boolean;
  sendConfigAndVerify(payload: any, opts?: { timeoutMs?: number; retries?: number }): Promise<boolean>;
  on(type: BridgeMessageType, handler: (msg: BridgeMessage) => void): void;
  once(type: BridgeMessageType, handler: (msg: BridgeMessage) => void): void;
  off(type: BridgeMessageType, handler: (msg: BridgeMessage) => void): void;
  start(): void;
  stop(): void;
}

// ── Action execution timeout (ms) ──
const ACTION_TIMEOUT = 5000;

/** Run a shell command with timeout + nothrow. Returns {stdout, stderr, exitCode}. */
async function run(args: string[], timeoutMs = ACTION_TIMEOUT): Promise<{
  stdout: string; stderr: string; exitCode: number;
}> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

// ── Hotkey parsing: "command+shift+e" → osascript keystroke ──
function buildKeystrokeScript(hotkey: string): string {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts.pop()!;
  const modifiers: string[] = [];

  for (const mod of parts) {
    if (mod === "command" || mod === "cmd") modifiers.push("command down");
    else if (mod === "shift") modifiers.push("shift down");
    else if (mod === "option" || mod === "alt") modifiers.push("option down");
    else if (mod === "control" || mod === "ctrl") modifiers.push("control down");
  }

  // Map special key names to AppleScript key codes
  const specialKeys: Record<string, string> = {
    return: "return", enter: "return", tab: "tab", escape: "escape",
    space: "space", delete: "delete", backspace: "delete",
    up: "up arrow", down: "down arrow", left: "left arrow", right: "right arrow",
  };

  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

  if (specialKeys[key]) {
    return `tell application "System Events" to key code ${getKeyCode(specialKeys[key])}${using}`;
  }

  // Regular character keystroke
  return `tell application "System Events" to keystroke "${key}"${using}`;
}

function getKeyCode(keyName: string): number {
  const codes: Record<string, number> = {
    return: 36, tab: 48, escape: 53, space: 49, delete: 51,
    "up arrow": 126, "down arrow": 125, "left arrow": 123, "right arrow": 124,
  };
  return codes[keyName] ?? 36;
}

// ── Execute action directly via osascript/cliclick ──
export async function executeAction(
  action: string,
  params: Record<string, any> = {}
): Promise<{ ok: boolean; action: string; [key: string]: any }> {
  const result: { ok: boolean; action: string; [key: string]: any } = { ok: true, action };

  try {
    switch (action) {
      case "click": {
        const { x = 0, y = 0, button = "left" } = params;
        const cmd = button === "double" ? `dc:${x},${y}`
          : button === "right" ? `rc:${x},${y}`
          : `c:${x},${y}`;
        await run(["cliclick", cmd]);
        result.position = [x, y];
        break;
      }

      case "type": {
        const text = params.text || "";
        const escaped = text.replace(/"/g, '\\"');
        await run(["osascript", "-e", `tell application "System Events" to keystroke "${escaped}"`]);
        result.typed = text.length;
        break;
      }

      case "key": {
        const key = params.key || "";
        const script = buildKeystrokeScript(key);
        await run(["osascript", "-e", script]);
        result.key = key;
        break;
      }

      case "scroll": {
        const { direction = "down", amount = 3, x, y } = params;
        if (x != null && y != null) {
          await run(["cliclick", `m:${x},${y}`]);
        }
        // AppleScript scroll via key events (up/down arrow with option key)
        const keyCode = (direction === "up" || direction === "left") ? 126 : 125;
        for (let i = 0; i < amount; i++) {
          await run(["osascript", "-e", `tell application "System Events" to key code ${keyCode}`]);
        }
        break;
      }

      case "mouse_move": {
        const { x = 0, y = 0 } = params;
        await run(["cliclick", `m:${x},${y}`]);
        break;
      }

      case "drag": {
        const { startX = 0, startY = 0, endX = 0, endY = 0 } = params;
        await run(["cliclick", `dd:${startX},${startY}`, `du:${endX},${endY}`]);
        break;
      }

      case "run_command": {
        const command = params.command || "";
        const proc = await run(["/bin/zsh", "-c", command], 15000);
        result.stdout = proc.stdout.slice(0, 500);
        result.stderr = proc.stderr.slice(0, 500);
        result.returncode = proc.exitCode;
        break;
      }

      case "find_and_click": {
        const target = params.target || "";
        const fallback = params.fallback_target || "";
        for (const text of [target, fallback].filter(Boolean)) {
          const script = `tell application "Google Chrome"
  activate
  delay 0.5
end tell
tell application "System Events"
  tell process "Google Chrome"
    set frontmost to true
    try
      click button "${text}" of group 1 of group 1 of group 1 of window 1
      return "clicked"
    end try
    try
      set allButtons to every button of window 1 whose title contains "${text}"
      if (count of allButtons) > 0 then
        click item 1 of allButtons
        return "clicked"
      end if
    end try
  end tell
end tell
return "not_found"`;
          const proc = await run(["osascript", "-e", script], 10000);
          if (proc.stdout.includes("clicked")) {
            result.method = "applescript";
            result.target = text;
            return result;
          }
        }
        result.ok = false;
        result.error = `Could not find button: ${target}`;
        break;
      }

      case "screenshot": {
        // Deprecated: use BrowserCaptureProvider or DesktopCaptureProvider
        result.ok = false;
        result.error = "Screenshot moved to Bun side. Use capture providers.";
        break;
      }

      default:
        result.ok = false;
        result.error = `Unknown action: ${action}`;
    }
  } catch (e: any) {
    result.ok = false;
    result.error = e.message;
  }

  return result;
}

// ── NativeBridge: drop-in replacement for PythonBridge ──

export class NativeBridge implements InputBridge {
  private _cliclickAvailable = false;
  private handlers = new Map<BridgeMessageType, Array<(msg: BridgeMessage) => void>>();

  get ready() {
    return true; // Always ready — no WebSocket dependency
  }

  start() {
    // Check cliclick availability at startup
    this._checkCliclick();
    console.log("[Bridge] NativeBridge ready (osascript + cliclick, no Python sidecar)");
  }

  private async _checkCliclick() {
    try {
      await $`which cliclick`.quiet();
      this._cliclickAvailable = true;
    } catch {
      console.warn("[Bridge] ⚠️ cliclick not found. Install: brew install cliclick");
      console.warn("[Bridge] Mouse coordinate actions (click, drag, move) will not work.");
      this._cliclickAvailable = false;
    }
  }

  send(type: BridgeMessageType, payload: any): boolean {
    if (type === "config") {
      // Audio config is now handled by AudioWorklet + SwitchAudioSource.
      // No-op — don't block, don't error.
      console.log(`[Bridge] Config no-op (AudioWorklet handles audio): ${JSON.stringify(payload).slice(0, 100)}`);
      return true;
    }

    if (type === "action") {
      // Fire-and-forget: execute action in background
      const action = payload.action || "";
      executeAction(action, payload).then((result) => {
        if (!result.ok) {
          console.warn(`[Bridge] Action failed: ${action} — ${result.error}`);
        }
        // Emit action_result for any listeners
        const msg: BridgeMessage = { type: "action_result", payload: result, ts: Date.now() };
        const listeners = this.handlers.get("action_result") || [];
        for (const fn of listeners) fn(msg);
      });
      return true;
    }

    if (type === "audio_playback") {
      // Audio playback now handled by Electron AudioWorklet — no-op
      return true;
    }

    if (type === "ping") {
      return true; // No-op — no sidecar to ping
    }

    console.warn(`[Bridge] Unhandled message type: ${type}`);
    return true;
  }

  sendAction(action: string, params: Record<string, any> = {}): boolean {
    return this.send("action", { action, ...params });
  }

  sendAudioPlayback(base64Pcm: string): boolean {
    return this.send("audio_playback", { audio: base64Pcm });
  }

  async sendConfigAndVerify(
    _payload: any,
    _opts?: { timeoutMs?: number; retries?: number }
  ): Promise<boolean> {
    // Audio config is no longer mediated by a sidecar.
    // SwitchAudioSource handles device routing, AudioWorklet handles capture/playback.
    console.log("[Bridge] sendConfigAndVerify no-op (AudioWorklet handles audio)");
    return true;
  }

  on(type: BridgeMessageType, handler: (msg: BridgeMessage) => void) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  once(type: BridgeMessageType, handler: (msg: BridgeMessage) => void) {
    const wrapper = (msg: BridgeMessage) => {
      this.off(type, wrapper);
      handler(msg);
    };
    this.on(type, wrapper);
  }

  off(type: BridgeMessageType, handler: (msg: BridgeMessage) => void) {
    const list = this.handlers.get(type) || [];
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  stop() {
    // Nothing to stop — no server, no process
  }
}

// ── Backward compatibility: export PythonBridge as alias ──
export { NativeBridge as PythonBridge };
