#!/usr/bin/env python3
"""CallingClaw 2.0 — Python Sidecar (Audio Gateway + Input Actions)

Connects to the Bun main process via Local WebSocket.
Handles: audio I/O (PyAudio/BlackHole), mouse/keyboard actions (pyautogui).

Screen capture is handled on the Bun side (CDP + screencapture CLI).
This process does NOT touch CoreGraphics/mss — audio-only.
"""

import asyncio
import json
import os
import time
import base64
import subprocess
import sys

# Try imports, fail gracefully with instructions
missing = []
try:
    import websockets
except ImportError:
    missing.append("websockets")

try:
    import pyautogui
    pyautogui.FAILSAFE = True  # Move mouse to corner to abort
    pyautogui.PAUSE = 0.05
except ImportError:
    missing.append("pyautogui")

if missing:
    print(f"[Sidecar] Missing packages: {', '.join(missing)}")
    print(f"[Sidecar] Install with: pip3 install {' '.join(missing)}")
    sys.exit(1)

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "4001"))
BRIDGE_URL = f"ws://localhost:{BRIDGE_PORT}"

# State
audio_mode = "default"  # "default" | "direct" | "meet_bridge"


def find_and_click_text(target: str, fallback: str = None) -> dict:
    """
    Use macOS Accessibility / AppleScript to find and click a button by text.
    Falls back to pyautogui.locateOnScreen if available.
    """
    # Try AppleScript approach for Chrome (most reliable on macOS)
    for text in [target, fallback] if fallback else [target]:
        if not text:
            continue
        script = f'''
        tell application "Google Chrome"
            activate
            delay 0.5
        end tell
        tell application "System Events"
            tell process "Google Chrome"
                set frontmost to true
                -- Try to find and click button with text
                try
                    click button "{text}" of group 1 of group 1 of group 1 of window 1
                    return "clicked"
                end try
                -- Try generic UI element search
                try
                    set allButtons to every button of window 1 whose title contains "{text}"
                    if (count of allButtons) > 0 then
                        click item 1 of allButtons
                        return "clicked"
                    end if
                end try
            end tell
        end tell
        return "not_found"
        '''
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=10
            )
            if "clicked" in result.stdout:
                return {"ok": True, "method": "applescript", "target": text}
        except Exception:
            pass

    return {"ok": False, "error": f"Could not find button: {target}"}


async def execute_action(action_data: dict) -> dict:
    """Execute a PyAutoGUI action and return result."""
    action = action_data.get("action", "")
    result = {"ok": True, "action": action}

    try:
        if action == "click":
            button = action_data.get("button", "left")
            x, y = action_data.get("x", 0), action_data.get("y", 0)
            if button == "double":
                pyautogui.doubleClick(x, y)
            elif button == "right":
                pyautogui.rightClick(x, y)
            elif button == "middle":
                pyautogui.middleClick(x, y)
            else:
                pyautogui.click(x, y)
            result["position"] = [x, y]

        elif action == "type":
            text = action_data.get("text", "")
            pyautogui.typewrite(text, interval=0.02)
            result["typed"] = len(text)

        elif action == "key":
            key = action_data.get("key", "")
            if "+" in key:
                keys = key.split("+")
                pyautogui.hotkey(*keys)
            else:
                pyautogui.press(key)
            result["key"] = key

        elif action == "scroll":
            direction = action_data.get("direction", "down")
            amount = action_data.get("amount", 3)
            x = action_data.get("x")
            y = action_data.get("y")
            clicks = amount if direction in ("up", "left") else -amount
            if x is not None and y is not None:
                pyautogui.scroll(clicks, x, y)
            else:
                pyautogui.scroll(clicks)

        elif action == "mouse_move":
            x, y = action_data.get("x", 0), action_data.get("y", 0)
            pyautogui.moveTo(x, y, duration=0.2)

        elif action == "drag":
            sx, sy = action_data.get("startX", 0), action_data.get("startY", 0)
            ex, ey = action_data.get("endX", 0), action_data.get("endY", 0)
            pyautogui.moveTo(sx, sy)
            pyautogui.drag(ex - sx, ey - sy, duration=0.5)

        elif action == "screenshot":
            # Screenshot is now handled on the Bun side (CDP + screencapture CLI).
            # Return an error to signal callers to use the new capture providers.
            result["ok"] = False
            result["error"] = "Screenshot moved to Bun side. Use BrowserCaptureProvider or DesktopCaptureProvider."

        elif action == "run_command":
            # Execute a shell command (used for opening URLs, etc.)
            command = action_data.get("command", "")
            proc = subprocess.run(
                command, shell=True, capture_output=True, text=True, timeout=15
            )
            result["stdout"] = proc.stdout[:500]
            result["stderr"] = proc.stderr[:500]
            result["returncode"] = proc.returncode

        elif action == "find_and_click":
            # Find a UI element by text and click it (macOS AppleScript)
            target = action_data.get("target", "")
            fallback = action_data.get("fallback_target", "")
            click_result = find_and_click_text(target, fallback)
            result.update(click_result)

        else:
            result["ok"] = False
            result["error"] = f"Unknown action: {action}"

    except Exception as e:
        result["ok"] = False
        result["error"] = str(e)

    return result


# ── Audio Bridge ──────────────────────────────────────────────

class AudioBridge:
    """
    Audio bridge for a DEDICATED CallingClaw machine (no user sharing audio).

    Modes:

    1. "direct" mode — default mic + default speaker (testing / standalone)
       Mic → PyAudio → WS → Bun → OpenAI Realtime → WS → PyAudio → Speaker

    2. "meet_bridge" mode — dual BlackHole for Google Meet audio routing
       Meet speaker → BlackHole 2ch → PyAudio capture → OpenAI Realtime (AI hears meeting)
       OpenAI Realtime → PyAudio playback → BlackHole 16ch → Meet mic input (AI speaks to meeting)

       Setup: brew install blackhole-2ch blackhole-16ch
       Chrome Meet settings:
         - Speaker output: BlackHole 2ch
         - Mic input: BlackHole 16ch

    Requires pyaudio. Meet mode requires BlackHole 2ch + BlackHole 16ch.
    """

    def __init__(self):
        self.running = False
        self.capture_stream = None
        self.playback_stream = None
        self.pa = None
        self.mode = "direct"
        self._rate = 24000  # OpenAI Realtime uses 24kHz
        self._chunk = int(self._rate * 0.02)  # 20ms = 480 samples

    def _find_device(self, keyword, need_input=False, need_output=False):
        """Find audio device by name keyword."""
        for i in range(self.pa.get_device_count()):
            info = self.pa.get_device_info_by_index(i)
            name = info.get("name", "")
            if keyword.lower() in name.lower():
                if need_input and info["maxInputChannels"] > 0:
                    return i, info
                if need_output and info["maxOutputChannels"] > 0:
                    return i, info
                if not need_input and not need_output:
                    return i, info
        return None, None

    def start(self, ws_send_callback, mode="direct"):
        """Start audio capture and playback."""
        try:
            import pyaudio
        except ImportError:
            print("[Audio] pyaudio not installed. Run: pip3 install pyaudio")
            return False

        self.mode = mode
        self.pa = pyaudio.PyAudio()
        self.running = True
        FORMAT = pyaudio.paInt16

        # List available devices
        print("[Audio] Available audio devices:")
        for i in range(self.pa.get_device_count()):
            info = self.pa.get_device_info_by_index(i)
            in_ch = info["maxInputChannels"]
            out_ch = info["maxOutputChannels"]
            if in_ch > 0 or out_ch > 0:
                print(f"[Audio]   [{i}] {info['name']} (in={in_ch}, out={out_ch}, rate={int(info['defaultSampleRate'])})")

        if mode == "meet_bridge":
            bh2_idx, bh2_info = self._find_device("BlackHole 2ch", need_input=True)
            bh16_idx, bh16_info = self._find_device("BlackHole 16ch", need_output=True)

            if bh2_idx is None or bh16_idx is None:
                bh_idx, _ = self._find_device("BlackHole", need_input=True)
                if bh_idx is None:
                    print("[Audio] BlackHole not found. Install: brew install blackhole-2ch blackhole-16ch")
                    print("[Audio] Falling back to direct mode.")
                    mode = "direct"
                    self.mode = "direct"
                else:
                    print(f"[Audio] Only one BlackHole found. Using [{bh_idx}] for capture, default for playback.")
                    self.capture_stream = self.pa.open(
                        format=FORMAT, channels=1, rate=self._rate,
                        input=True, input_device_index=bh_idx,
                        frames_per_buffer=self._chunk,
                    )
                    self.playback_stream = self.pa.open(
                        format=FORMAT, channels=1, rate=self._rate,
                        output=True, frames_per_buffer=self._chunk,
                    )
            else:
                print(f"[Audio] Meet bridge — capture: [{bh2_idx}] {bh2_info['name']}")
                print(f"[Audio] Meet bridge — playback: [{bh16_idx}] {bh16_info['name']}")
                self.capture_stream = self.pa.open(
                    format=FORMAT, channels=1, rate=self._rate,
                    input=True, input_device_index=bh2_idx,
                    frames_per_buffer=self._chunk,
                )
                self.playback_stream = self.pa.open(
                    format=FORMAT, channels=1, rate=self._rate,
                    output=True, output_device_index=bh16_idx,
                    frames_per_buffer=self._chunk,
                )

        if mode == "direct":
            print("[Audio] Direct mode — using default microphone + speaker")
            try:
                self.capture_stream = self.pa.open(
                    format=FORMAT, channels=1, rate=self._rate,
                    input=True, frames_per_buffer=self._chunk,
                )
            except Exception as e:
                print(f"[Audio] Failed to open microphone: {e}")
                print("[Audio] Check System Settings > Privacy > Microphone")
                return False

            try:
                self.playback_stream = self.pa.open(
                    format=FORMAT, channels=1, rate=self._rate,
                    output=True, frames_per_buffer=self._chunk,
                )
            except Exception as e:
                print(f"[Audio] Failed to open speaker: {e}")

        self._ws_send = ws_send_callback
        print(f"[Audio] Started in {mode} mode (rate={self._rate}Hz, chunk={self._chunk})")
        return True

    async def capture_loop(self, ws):
        """Read audio from mic/BlackHole and send as base64 PCM chunks."""
        if not self.capture_stream:
            return

        loop = asyncio.get_event_loop()
        while self.running:
            try:
                data = await loop.run_in_executor(
                    None, self.capture_stream.read, self._chunk, False
                )
                b64 = base64.b64encode(data).decode("utf-8")
                await ws.send(json.dumps({
                    "type": "audio_chunk",
                    "payload": {"audio": b64, "format": "pcm16", "rate": self._rate},
                    "ts": int(time.time() * 1000),
                }))
                await asyncio.sleep(0.015)
            except Exception as e:
                if self.running:
                    print(f"[Audio] Capture error: {e}")
                await asyncio.sleep(0.1)

    def play_audio(self, base64_pcm: str):
        """Play AI audio response through speaker/BlackHole."""
        if not self.playback_stream:
            return
        try:
            pcm_data = base64.b64decode(base64_pcm)
            self.playback_stream.write(pcm_data)
        except Exception as e:
            print(f"[Audio] Playback error: {e}", flush=True)

    def stop(self):
        """Stop audio capture and playback."""
        self.running = False
        for stream in (self.capture_stream, self.playback_stream):
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
        if self.pa:
            self.pa.terminate()
        self.capture_stream = None
        self.playback_stream = None
        self.pa = None
        print("[Audio] Audio bridge stopped")


# ── Main ──────────────────────────────────────────────────────

async def main():
    global audio_mode

    audio_bridge = AudioBridge()

    print(f"[Sidecar] Connecting to {BRIDGE_URL}...")
    print("[Sidecar] Audio-only mode (screen capture handled by Bun)")

    while True:
        try:
            ws = await websockets.connect(BRIDGE_URL)
        except Exception as e:
            print(f"[Sidecar] Connection failed: {e}, retrying in 3s...")
            await asyncio.sleep(3)
            continue

        try:
            print("[Sidecar] Connected to Bun bridge!")

            await ws.send(json.dumps({
                "type": "status",
                "payload": {"status": "ready", "platform": sys.platform, "audio_mode": audio_mode},
                "ts": int(time.time() * 1000),
            }))

            audio_capture_task = None

            async for raw_msg in ws:
                try:
                    msg = json.loads(raw_msg)
                    msg_type = msg.get("type")
                    payload = msg.get("payload", {})

                    if msg_type == "action":
                        result = await execute_action(payload)
                        await ws.send(json.dumps({
                            "type": "action_result",
                            "payload": result,
                            "ts": int(time.time() * 1000),
                        }))

                    elif msg_type == "audio_playback":
                        audio_data = payload.get("audio", "")
                        if audio_data and audio_mode in ("direct", "meet_bridge"):
                            loop = asyncio.get_event_loop()
                            loop.run_in_executor(None, audio_bridge.play_audio, audio_data)

                    elif msg_type == "config":
                        print(f"[Sidecar] Config update received: {payload}")

                        new_mode = payload.get("audio_mode")

                        if new_mode in ("direct", "meet_bridge") and audio_mode != new_mode:
                            if audio_mode in ("direct", "meet_bridge"):
                                audio_bridge.stop()
                                if audio_capture_task:
                                    audio_capture_task.cancel()
                                    audio_capture_task = None

                            audio_mode = new_mode
                            success = audio_bridge.start(ws.send, mode=new_mode)
                            if success:
                                audio_capture_task = asyncio.create_task(
                                    audio_bridge.capture_loop(ws)
                                )
                                print(f"[Sidecar] Audio mode switched to: {new_mode.upper()}")
                                await ws.send(json.dumps({
                                    "type": "status",
                                    "payload": {
                                        "status": "audio_mode_changed",
                                        "audio_mode": new_mode,
                                        "success": True,
                                    },
                                    "ts": int(time.time() * 1000),
                                }))
                            else:
                                audio_mode = "default"
                                print("[Sidecar] Audio start failed, back to DEFAULT")
                                await ws.send(json.dumps({
                                    "type": "status",
                                    "payload": {
                                        "status": "audio_mode_changed",
                                        "audio_mode": "default",
                                        "success": False,
                                        "error": "AudioBridge.start() failed",
                                    },
                                    "ts": int(time.time() * 1000),
                                }))

                        elif new_mode == "default" and audio_mode != "default":
                            audio_mode = "default"
                            audio_bridge.stop()
                            if audio_capture_task:
                                audio_capture_task.cancel()
                                audio_capture_task = None
                            print("[Sidecar] Audio mode: DEFAULT (no audio)")

                    elif msg_type == "ping":
                        await ws.send(json.dumps({
                            "type": "status",
                            "payload": {
                                "status": "alive",
                                "audio_mode": audio_mode,
                                "audio_running": audio_bridge.running,
                            },
                            "ts": int(time.time() * 1000),
                        }))

                except json.JSONDecodeError:
                    print("[Sidecar] Invalid JSON received")
                except Exception as e:
                    print(f"[Sidecar] Message handling error: {e}")

        except (websockets.ConnectionClosed, ConnectionError, OSError) as e:
            print(f"[Sidecar] Disconnected: {e}, reconnecting in 3s...")
        except Exception as e:
            print(f"[Sidecar] Unexpected error: {e}, reconnecting in 3s...")
        finally:
            if audio_capture_task and not audio_capture_task.done():
                audio_capture_task.cancel()
                try: await audio_capture_task
                except: pass
            audio_bridge.stop()
            audio_mode = "default"
            try: await ws.close()
            except: pass
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
