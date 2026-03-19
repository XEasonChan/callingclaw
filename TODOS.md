# TODOS

## Backend: Emit meeting.summary_ready WebSocket event
**Priority:** P1
**Owner:** Backend agent
**Context:** When a meeting ends, the frontend receives `meeting.ended` but the summary file is generated asynchronously afterwards. The frontend currently has no way to know when the summary file is ready. The backend should emit a `meeting.summary_ready` event (with `meetingId` and optionally `filePath`) once the summary markdown file has been written to shared storage. Until this is implemented, the frontend summary tab may show stale "pending" state after meeting end.
**Why:** Without this event, the user has to manually refresh to see the meeting summary. This breaks the "consistent file asset" mental model — prep appears automatically but summary doesn't.
**Depends on:** Backend WS event bus, summary generation pipeline
**Added:** 2026-03-19

## Frontend: Generalize tabbed side panel for multi-doc contexts
**Priority:** P2
**Owner:** Frontend agent
**Context:** The tabbed side panel (Live Feed / Prep / Summary) is built specifically for the meeting use case. If other features need multi-document side panels (e.g., viewing multiple related docs, comparing versions), the tab system could be generalized into a reusable pattern. Currently only one use case exists — generalize when a second appears.
**Why:** Avoid premature abstraction, but track the pattern so we don't rebuild it from scratch.
**Depends on:** A second use case emerging
**Added:** 2026-03-19
