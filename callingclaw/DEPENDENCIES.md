# CallingClaw 2.0 — Dependency Manifest

## Quick Setup

```bash
# 1. Install all dependencies
cd "CallingClaw 2.0/callingclaw"
bun install
pip3 install -r requirements.txt

# 2. Install system dependencies (macOS)
brew install portaudio        # Required by pyaudio
brew install blackhole-2ch    # Virtual audio device (for Meet audio bridge)

# 3. Copy and configure env
cp .env.example .env
# Edit .env with your API keys

# 4. Start
bun run start
```

---

## System Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| **macOS** | 12+ | Required for PyAutoGUI, AppleScript, BlackHole |
| **Bun** | 1.3+ | Runtime for main process |
| **Python** | 3.9+ | Sidecar runtime (recommend conda 3.13) |
| **portaudio** | 19.7+ | System lib for PyAudio |
| **BlackHole** | 0.6+ | Virtual audio device for Meet bridging (optional) |

---

## Bun (Node) Dependencies

Defined in `package.json`, installed via `bun install`.

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | 0.78.0 | Claude Computer Use API (direct or via OpenRouter) |
| `openai` | 6.27.0 | OpenAI Realtime voice + GPT-4o vision |
| `@types/bun` | latest | TypeScript types (dev) |

> **Note:** Google Calendar uses direct REST API with OAuth2 refresh tokens — no MCP package needed.
> Credentials are auto-discovered from `~/.openclaw/workspace/` or `~/.config/gcloud/`.

---

## Python Dependencies

Defined in `requirements.txt`, installed via `pip3 install -r requirements.txt`.

| Package | Version | Purpose |
|---------|---------|---------|
| `websockets` | 15.0.1 | WebSocket client to connect to Bun bridge |
| `pyautogui` | 0.9.54 | Mouse/keyboard automation (Computer Use execution) |
| `mss` | 10.1.0 | Fast screen capture (1 FPS screenshot stream) |
| `Pillow` | 12.1.1 | Image processing (screenshot format conversion) |
| `pyaudio` | 0.2.14 | Audio I/O for Meet bridging (requires portaudio) |

### PyAutoGUI Sub-dependencies (auto-installed)

| Package | Purpose |
|---------|---------|
| `pyobjc-core` | macOS Objective-C bridge |
| `pyobjc-framework-Cocoa` | macOS Cocoa framework |
| `pyobjc-framework-quartz` | macOS screen/window access |
| `pyscreeze` | Screenshot capture |
| `pytweening` | Animation easing for mouse movement |
| `pymsgbox` | Message box dialogs |
| `pygetwindow` | Window management |
| `pyrect` | Rectangle utilities |
| `mouseinfo` | Mouse position info |
| `pyperclip` | Clipboard access |
| `rubicon-objc` | Obj-C bridge (alternative) |

---

## System Dependencies (Homebrew)

| Package | Install Command | Purpose |
|---------|----------------|---------|
| `portaudio` | `brew install portaudio` | C library for audio I/O (PyAudio build dep) |
| `blackhole-2ch` | `brew install blackhole-2ch` | Virtual audio device for Meet audio routing |

---

## API Keys Required

| Key | Required | Source | Purpose |
|-----|----------|--------|---------|
| `OPENAI_API_KEY` | **Yes** | [platform.openai.com](https://platform.openai.com/api-keys) | Realtime voice + GPT-4o vision |
| `OPENROUTER_API_KEY` | Recommended | [openrouter.ai/keys](https://openrouter.ai/keys) | Claude Computer Use (no Anthropic account needed) |
| `ANTHROPIC_API_KEY` | Optional | [console.anthropic.com](https://console.anthropic.com/) | Direct Claude API (alternative to OpenRouter) |
| `GOOGLE_CLIENT_ID` | Optional | Google Cloud Console | Calendar + Meet integration |
| `GOOGLE_CLIENT_SECRET` | Optional | Google Cloud Console | Calendar + Meet integration |
| `GOOGLE_REFRESH_TOKEN` | Optional | OAuth flow | Calendar + Meet integration |

---

## Environment Variables

```bash
# .env file — copy from .env.example
OPENAI_API_KEY=sk-xxx              # Required
OPENROUTER_API_KEY=sk-or-v1-xxx    # Recommended (for Computer Use)
# ANTHROPIC_API_KEY=sk-ant-xxx     # Optional (direct Anthropic)

GOOGLE_CLIENT_ID=                  # Optional
GOOGLE_CLIENT_SECRET=              # Optional
GOOGLE_REFRESH_TOKEN=              # Optional

PORT=4000                          # HTTP config server
BRIDGE_PORT=4001                   # Python sidecar WebSocket
PYTHON_PATH=/opt/miniconda3/bin/python3  # Python binary path

SCREEN_WIDTH=1920                  # Screen resolution
SCREEN_HEIGHT=1080
```

---

## Verification

```bash
# Check Bun deps
bun run src/callingclaw.ts &  # Should start without import errors

# Check Python deps
python3 -c "
import pyautogui; print(f'pyautogui: {pyautogui.__version__}')
import mss; print(f'mss: {mss.__version__}')
import pyaudio; print(f'pyaudio: {pyaudio.__version__}')
import websockets; print(f'websockets: {websockets.__version__}')
import PIL; print(f'Pillow: {PIL.__version__}')
print('All OK')
"

# Run tests
bun test
```
