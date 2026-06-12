# CallingClaw MCP Server

MCP (Model Context Protocol) server that bridges AI agents to [CallingClaw Desktop](https://callingclaw.com) for real-time voice meetings with AI assistance.

## Features

- **Real-time Voice AI** — Sub-second response via OpenAI Realtime API (not robotic TTS)
- **Interactive Screen Sharing** — Playwright-powered browser control (click, scroll, navigate)
- **Meeting Transcription** — Full transcript with speaker names and timestamps
- **Context Injection** — Prepare the AI with knowledge before/during meetings
- **Action Items** — Extract tasks and follow-ups from conversations
- **Multi-Client Support** — Works with Claude Code, Cursor, Claude Desktop, VS Code Copilot, and more

## Prerequisites

1. **CallingClaw Desktop** running on `localhost:4000`
   - Download from [callingclaw.com](https://callingclaw.com)
   - Launch the application before using this MCP server

2. **Node.js 18+** (for `npx` usage)

## Quick Start

```bash
npx callingclaw-mcp
```

Or install globally:

```bash
npm install -g callingclaw-mcp
callingclaw-mcp
```

## MCP Client Configuration

### Claude Code

Add to your Claude Code MCP settings (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "callingclaw": {
      "command": "npx",
      "args": ["-y", "callingclaw-mcp"]
    }
  }
}
```

### Cursor

Add to Cursor settings (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "callingclaw": {
      "command": "npx",
      "args": ["-y", "callingclaw-mcp"]
    }
  }
}
```

### Claude Desktop

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "callingclaw": {
      "command": "npx",
      "args": ["-y", "callingclaw-mcp"]
    }
  }
}
```

### VS Code with Continue

Add to Continue config (`.continue/config.json`):

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "callingclaw-mcp"]
        }
      }
    ]
  }
}
```

### Generic MCP Client

For any MCP-compatible client, use:

```json
{
  "command": "npx",
  "args": ["-y", "callingclaw-mcp"],
  "transport": "stdio"
}
```

## Available Tools

### Meeting Tools

| Tool | Description |
|------|-------------|
| `join_meeting` | Join a Google Meet or Zoom meeting as an AI assistant |
| `leave_meeting` | Leave the current meeting and get action items |
| `speak` | Say something through the AI voice (natural speech) |
| `present_url` | Share screen showing a URL (interactive browser) |
| `get_transcript` | Get the meeting transcript with speakers and timestamps |
| `inject_context` | Add knowledge to the AI without speaking it aloud |
| `send_chat_message` | Send a text message in the meeting chat |
| `get_status` | Check CallingClaw connection and meeting state |
| `get_action_items` | Extract action items from the transcript |
| `set_voice_provider` | Change voice AI provider (openai/grok/gemini) |

### Onboarding & Setup Tools (Zero GUI Setup)

| Tool | Description |
|------|-------------|
| `check_health` | Check if CallingClaw is running (call this FIRST) |
| `check_api_keys` | Check which API keys are configured |
| `set_api_keys` | Configure API keys (OpenAI, Google, etc.) |
| `check_google_auth` | Check Google Calendar OAuth and Chrome login status |
| `setup_google_oauth` | Scan for, apply, or set Google OAuth credentials |
| `google_chrome_login` | Start or verify Chrome Google sign-in |
| `get_config` | Get current CallingClaw configuration |
| `set_config` | Update configuration settings |
| `check_capabilities` | Check what features are available |
| `check_audio` | Audio pipeline diagnostic |

## Onboarding Flow (Zero GUI Setup)

CallingClaw can be fully set up through agent conversation — no GUI needed! Here's the recommended flow:

### Step 1: Check Health

```
User: Help me set up CallingClaw

AI: [Calls check_health]
✅ CallingClaw Desktop is running!
Version: 1.2.0

Next steps:
1. Run check_api_keys to verify API keys are configured
2. Run check_google_auth to verify Google OAuth status
```

If CallingClaw isn't running:
```
AI: [Calls check_health]
❌ CallingClaw Desktop is not running.

To get started:
1. Download CallingClaw Desktop from https://callingclaw.com
2. Install and launch the application
3. Ensure it's running on localhost:4000
4. Run check_health again to verify
```

### Step 2: Configure API Keys

```
User: Let's set up the API keys

AI: [Calls check_api_keys]
🔑 API Keys Status:

❌ OPENAI_API_KEY
   Required for real-time voice AI
   Get it here: https://platform.openai.com/api-keys

✅ GOOGLE_API_KEY (AIza...xyz)
   Used for speech recognition backup

⚠️ Missing required keys: OPENAI_API_KEY
Use set_api_keys to configure them.

User: Here's my OpenAI key: sk-proj-abc123...

AI: [Calls set_api_keys with {"OPENAI_API_KEY": "sk-proj-abc123..."}]
✅ API keys configured: OPENAI_API_KEY
```

### Step 3: Set Up Google OAuth

```
User: Now let's connect Google

AI: [Calls check_google_auth]
🔐 Google Auth Status:

Calendar Connected: ❌ No
Chrome Logged In: ❌ No

⚠️ Google Calendar is not connected.
Run setup_google_oauth with action "scan" to look for existing credentials.

AI: [Calls setup_google_oauth with action "scan"]
🔍 Found existing Google OAuth credentials!

Locations:
  - ~/.config/gcloud/application_default_credentials.json

Client ID: 123456789012-abc...
Has Refresh Token: Yes

Run setup_google_oauth with action "apply" to use these credentials.

AI: [Calls setup_google_oauth with action "apply"]
✅ Google credentials applied successfully!
```

### Step 4: Chrome Login

```
AI: [Calls google_chrome_login with action "start"]
🌐 Chrome opened for Google sign-in!

Please sign into your Google account in the Chrome window.

User: Done, I signed in

AI: [Calls google_chrome_login with action "check"]
✅ Chrome login successful!

Logged in as: user@gmail.com

Google Chrome is now authenticated. Ready to join meetings!
```

### Step 5: Verify Everything

```
AI: [Calls check_capabilities]
🎯 CallingClaw Capabilities:

Voice Providers:
  ✅ openai
  ✅ grok
  ✅ gemini

Meeting Platforms:
  ✅ Google Meet
  ✅ Zoom

Automation Layers:
  ✅ Playwright: Interactive browser control
  ✅ Shortcuts: Keyboard automation

Features:
  ✅ Voice AI
  ✅ Screen Share
  ✅ Transcription
  ✅ Context Injection

🎉 All systems ready! CallingClaw is fully configured and ready to join meetings.
```

## Usage Examples

### Join a Meeting

```
User: Join this meeting: https://meet.google.com/abc-defg-hij

AI: [Calls join_meeting tool]
✅ Successfully joined the meeting as "CoCo".
```

### Speak in the Meeting

```
User: Say hello to everyone

AI: [Calls speak tool with text: "Hello everyone, thanks for having me!"]
🎤 Speaking: "Hello everyone, thanks for having me!"
```

### Inject Context

```
User: Tell the AI about our Q3 goals

AI: [Calls inject_context tool]
🧠 Context injected successfully.
The AI now knows about Q3 revenue targets, new product launch, and team expansion plans.
```

### Present a URL

```
User: Show the team our roadmap

AI: [Calls present_url tool with url: "https://company.notion.so/roadmap"]
🖥️ Now presenting: https://company.notion.so/roadmap
```

### Get Transcript

```
User: What has been discussed so far?

AI: [Calls get_transcript tool]
📝 Transcript (15 entries):
[10:30:15] Alice: Let's start with the Q3 review...
[10:31:02] Bob: Revenue is up 15% from last quarter...
```

### Get Action Items

```
User: What are the action items from this meeting?

AI: [Calls get_action_items tool]
📋 Action Items (3):
1. Finalize Q4 budget — Assigned to: Alice
2. Schedule customer interviews — Assigned to: Bob
3. Update roadmap with new features — Assigned to: Carol
```

## Architecture

```
┌──────────────────────────────┐
│ MCP Client                   │
│ (Claude Code, Cursor, etc)   │
└──────────┬───────────────────┘
           │ MCP Protocol (stdio)
┌──────────▼───────────────────┐
│ callingclaw-mcp server       │
│ (this package)               │
└──────────┬───────────────────┘
           │ HTTP REST API
┌──────────▼───────────────────┐
│ CallingClaw Desktop          │
│ localhost:4000               │
└──────────────────────────────┘
```

## Comparison with AgentCall

| Feature | CallingClaw MCP | AgentCall |
|---------|-----------------|-----------|
| **Latency** | Sub-second (OpenAI Realtime) | 7-12 seconds |
| **Cost** | Free (local desktop app) | Requires API key ($) |
| **Screen Share** | Interactive (Playwright) | Read-only HTML polling |
| **AI Brain** | Built-in context | External LLM required |
| **Setup** | `npx callingclaw-mcp` | Cloud API registration |

## Troubleshooting

### "CallingClaw Desktop is not running"

1. Download CallingClaw Desktop from [callingclaw.com](https://callingclaw.com)
2. Launch the application
3. Verify it's running on `localhost:4000`
4. Try the `get_status` tool again

### "Failed to join meeting"

- Ensure the meeting URL is valid (Google Meet or Zoom)
- Check that the meeting has started
- Verify CallingClaw has microphone/camera permissions

### "Request timeout"

- Joining meetings takes 30-60 seconds (Playwright browser launch)
- The MCP server uses a 90-second timeout for join operations

## Development

```bash
# Clone the repository
git clone https://github.com/nicedouble/callingclaw-mcp.git
cd callingclaw-mcp

# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/index.js
```

## License

MIT

## Links

- [CallingClaw Desktop](https://callingclaw.com)
- [MCP Protocol Specification](https://modelcontextprotocol.io)
- [Report Issues](https://github.com/nicedouble/callingclaw-mcp/issues)
