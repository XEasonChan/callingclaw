---
type: "note"
---
# CallingClaw Architecture Decisions — 2026-03-16

Cross-tree planning document. Both frontend and backend agents should read this.

## Core Product Concept

**"Give a meeting room to your OpenClaw."**

OpenClaw is the brain (deep reasoning, memory, coding). CallingClaw is the meeting room (voice, screen, automation). OpenClaw can attend meetings, confirm requirements with humans, carry unified memory, then execute — like a remote employee.

## Key Decisions

### 1. OpenClaw ↔ CallingClaw Binding

**Approach: Slash command + Gateway auto-connect**

* CallingClaw writes `/callingclaw` skill to `~/.claude/commands/callingclaw.md` during onboarding

* This lets any Claude Code session invoke CallingClaw's REST API on `:4000`

* Reverse: CallingClaw auto-connects to OpenClaw Gateway on `:18789` (existing `openclaw_bridge.ts`)

* Fallback: If Gateway unavailable, CallingClaw can spawn `claude --sdk-url ws://localhost:4000/ws/openclaw` (Pneuma pattern) for one-off deep reasoning tasks

**Backend action required:**

* Add `--sdk-url` WebSocket handler to CallingClaw's Bun server at `/ws/openclaw`

* This handler should speak Claude Code's `stream-json` protocol (see pneuma-skills `backends/claude-code/cli-launcher.ts`)

* This is the fallback path when OpenClaw Gateway is not running

### 2. BlackHole Bundled in DMG

**Approach: Bundle BlackHole .pkg in Electron app's&#x20;**`extraResources`

* During first launch, CallingClaw detects if BlackHole is installed

* If not, runs bundled installer: `osascript -e 'do shell script "installer -pkg PATH -target /" with administrator privileges'`

* Onboarding only shows verification status, not an install step

**Backend action required:** None. This is Electron-side only.

### 3. Microphone Permission Not Needed

BlackHole virtual audio doesn't require macOS microphone permission. CallingClaw captures meeting audio via BlackHole routing, not the physical mic. Removed from onboarding.

### 4. Skill File Contents

`~/.claude/commands/callingclaw.md` should contain:

* CallingClaw's full REST API reference (all endpoints on `:4000`)

* Usage examples for common flows: join meeting, leave, check status, manage tasks

* Context about the dual-process architecture (System 1 voice + System 2 reasoning)

* Instructions for CallingClaw to use when OpenClaw delegates tasks

**Backend action required:**

* The skill manifest in `openclaw-callingclaw-skill.ts` should be updated to match this new installation path

* Add a REST endpoint `GET /api/skill/manifest` that returns the skill markdown content, so the Electron app can fetch the latest version to write

### 5. Post-Meeting Flow → Telegram + Desktop

Meeting deliverables should render identically on both surfaces:

* **Desktop:** Post-meeting view with summary, decisions, todos, execution tracking

* **Telegram:** Compressed version with inline buttons for todo confirmation

* Both consume the same data model from `PostMeetingDelivery`

**Backend action required:**

* Ensure `POST /api/meeting/leave` returns the full `MeetingDelivery` object (summary + todos + decisions)

* Add `GET /api/postmeeting/:meetingId` to fetch delivery data for desktop rendering

### 6. Frontend Design System

* Light theme: `#F5F5F7` background, `#FFFFFF` cards

* Brand red accent: `#E63946`

* Meeting-centric home (not dashboard)

* System health collapsed to 36px status bar

* Reference: `/Users/admin/Downloads/design-a67efc0b-c2f9-447d-8e1d-dd39748e006c.html`

## Phase Roadmap

| Phase | Focus                                          | Status      |
| ----- | ---------------------------------------------- | ----------- |
| 1     | Meeting-centric home view                      | Done        |
| 2     | Onboarding (6 steps, WhisperFlow style)        | In progress |
| 3     | Overlay — minimal meeting-time floating window | Planned     |
| 4     | Post-meeting — summary + todo confirmation     | Planned     |
| 5     | Execution tracking — OpenClaw progress         | Planned     |

---

## v2.5 Architecture Decisions (2026-03-20/21)

### Audio: AudioWorklet + Ring Buffer Playback
ScriptProcessor was deprecated and caused chunk-boundary pops. Switched to:
- Capture: AudioWorklet via Blob URL (Electron file:// compatible)
- Playback: AudioWorklet ring buffer (gapless, no scheduling complexity)
- Dual AudioContext: native rate capture + 24kHz playback

### Voice: Provider Capability Matrix
Each provider declares explicit capabilities (interruption, resume, native tools, audio formats, session limits). Prevents runtime surprises when switching providers.

### Voice: Heard Transcript Truncation
On user interrupt, calculate what was actually heard (heardRatio = elapsed/total duration) and write correction entry. Prevents multi-turn confusion from AI referencing unheard content.

### Tools: Fast/Slow Dispatch
Slow tools (browser_action, computer_action) return "Working on it" immediately, execute async, inject result via context. Prevents blocking the voice thread.

### Context: Meeting Lifecycle Cleanup
All modules now properly reset on meeting.started and unsubscribe listeners on meeting.ended. SharedContext.off() method added. Prevents cross-session state leaks.

### Meeting: Multimodal Timeline
KeyFrameStore persists screenshots + transcript to disk during meetings. OC-010 protocol sends timeline to OpenClaw for visual action extraction.