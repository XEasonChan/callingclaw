// CallingClaw 2.0 — OpenClaw Protocol Schema
// ═══════════════════════════════════════════════════════════════════
// Defines ALL message schemas between CallingClaw → OpenClaw.
// Each call has a unique ID, typed request, typed response, and
// an English prompt builder + response parser.
//
// All prompts are in English for consistency and model performance.
// ═══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// OC-001: Meeting Prep Brief Generation
// Trigger: Pre-meeting, via MeetingPrepSkill.generate()
// ══════════════════════════════════════════════════════════════

export interface OC001_Request {
  id: "OC-001";
  topic: string;
  userContext?: string;
  attendees?: Array<{ name: string; email: string; status?: string }>;
}

export interface OC001_Response {
  topic: string;
  goal: string;
  summary: string;
  keyPoints: string[];
  architectureDecisions: Array<{ decision: string; rationale: string }>;
  expectedQuestions: Array<{ question: string; suggestedAnswer: string }>;
  previousContext?: string;
  filePaths: Array<{ path: string; description: string; action?: "open" | "scroll" | "present" }>;
  browserUrls: Array<{ url: string; description: string; action?: "navigate" | "demo" | "show" }>;
  folderPaths: Array<{ path: string; description: string }>;
}

export const OC001_PROMPT = (req: OC001_Request) => {
  const attendeeSection = req.attendees?.length
    ? `\n## Meeting Attendees\n${req.attendees
        .map((a) => `- ${a.name || a.email}${a.name ? ` (${a.email})` : ""}${a.status ? ` — ${a.status}` : ""}`)
        .join("\n")}`
    : "";

  return `Generate a meeting prep brief. Follow these instructions exactly.

## Your Task
Read the relevant files and your memory, then generate a structured JSON meeting prep brief.

## Meeting Topic
${req.topic}

## Additional Context from User
${req.userContext || "(no additional context)"}${attendeeSection}

## What to Include

1. **summary**: 2-3 paragraphs summarizing what will be presented. Write in the user's preferred language.
2. **keyPoints**: 5-8 bullet points covering the main topics to discuss.
3. **architectureDecisions**: For each major technical decision, explain WHAT was decided and WHY.
4. **expectedQuestions**: 3-5 questions that might come up, with suggested answers.
5. **previousContext**: If there were previous meetings on this topic, summarize key outcomes and open items.
6. **filePaths**: All relevant local files with absolute paths. Suggest action: "open" / "scroll" / "present".
7. **browserUrls**: All relevant web URLs (GitHub, deployed apps, Figma, docs).
8. **folderPaths**: Key project directories the user might want to show.

## Output Format
Return ONLY valid JSON matching this exact structure:
\`\`\`json
{
  "topic": "string",
  "goal": "string — what the meeting should achieve",
  "summary": "string — 2-3 paragraphs in user's language",
  "keyPoints": ["string — 5-8 bullet points"],
  "architectureDecisions": [{"decision": "string", "rationale": "string"}],
  "expectedQuestions": [{"question": "string", "suggestedAnswer": "string"}],
  "previousContext": "string or null — prior meeting summary",
  "filePaths": [{"path": "/absolute/path", "description": "string", "action": "open|scroll|present"}],
  "browserUrls": [{"url": "https://...", "description": "string", "action": "navigate|demo|show"}],
  "folderPaths": [{"path": "/absolute/path", "description": "string"}]
}
\`\`\`

Be thorough with file paths — use absolute paths.`;
};

export function parseOC001(raw: string, fallbackTopic: string): OC001_Response {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const p = JSON.parse(jsonMatch[0]);
      return {
        topic: p.topic || fallbackTopic,
        goal: p.goal || "",
        summary: p.summary || "",
        keyPoints: Array.isArray(p.keyPoints) ? p.keyPoints : [],
        architectureDecisions: Array.isArray(p.architectureDecisions) ? p.architectureDecisions : [],
        expectedQuestions: Array.isArray(p.expectedQuestions) ? p.expectedQuestions : [],
        previousContext: p.previousContext || undefined,
        filePaths: Array.isArray(p.filePaths) ? p.filePaths : [],
        browserUrls: Array.isArray(p.browserUrls) ? p.browserUrls : [],
        folderPaths: Array.isArray(p.folderPaths) ? p.folderPaths : [],
      };
    } catch {}
  }
  return {
    topic: fallbackTopic, goal: "Discuss " + fallbackTopic,
    summary: raw.slice(0, 2000), keyPoints: [], architectureDecisions: [],
    expectedQuestions: [], filePaths: [], browserUrls: [], folderPaths: [],
  };
}

// ══════════════════════════════════════════════════════════════
// OC-002: Context Recall (recall_context tool)
// Trigger: Voice AI calls recall_context during conversation
// ══════════════════════════════════════════════════════════════

export interface OC002_Request {
  id: "OC-002";
  query: string;
  localContext?: string;
  language: string;
}

export interface OC002_Response {
  answer: string;
}

export const OC002_PROMPT = (req: OC002_Request) =>
  `The user asked a question that requires context recall. Search your memory (MEMORY.md), recent files, and conversation history to find relevant information.

User's question: "${req.query}"

${req.localContext ? `Pre-fetched local context:\n${req.localContext}\n\nExpand on this with more details from your files.` : "No local context found. Search broadly across your memory and files."}

Return a concise factual answer (under 500 words) for the voice assistant to relay. Focus on concrete facts, dates, metrics, and actionable information. Answer in the user's language (${req.language}).`;

export function parseOC002(raw: string): OC002_Response {
  return { answer: raw.slice(0, 3000) };
}

// ══════════════════════════════════════════════════════════════
// OC-003: Calendar Cron Registration
// Trigger: MeetingScheduler finds upcoming meeting
// ══════════════════════════════════════════════════════════════

export interface OC003_Request {
  id: "OC-003";
  cronName: string;
  joinAtISO: string;
  eventSummary: string;
  eventDescription: string;
}

export interface OC003_Response {
  jobId: string;
}

export const OC003_PROMPT = (req: OC003_Request) =>
  `Use the cron tool to create a one-time scheduled task:
- action: "add"
- schedule: { kind: "at", at: "${req.joinAtISO}" }
- sessionTarget: "main"
- payload: { kind: "systemEvent", text: the event text below }
- name: "${req.cronName}"

Event text:
---
${req.eventDescription}
---

After creating the cron job, reply with only the job ID in this format: jobId: <id>`;

export function parseOC003(raw: string): OC003_Response {
  const match = raw.match(/job[_\s]?[Ii][Dd][\s:]*[`"']?([a-zA-Z0-9_-]+)[`"']?/);
  return { jobId: match?.[1] || `auto_${Date.now()}` };
}

// ══════════════════════════════════════════════════════════════
// OC-004: Post-Meeting Todo Delivery (Telegram)
// Trigger: Meeting ends with action items
// ══════════════════════════════════════════════════════════════

export interface OC004_Request {
  id: "OC-004";
  topic: string;
  meetingId: string;
  todos: Array<{
    id: string;
    text: string;
    fullText: string;
    assignee?: string;
    deadline?: string;
  }>;
  /** Meeting summary markdown (optional — included for user delivery) */
  summaryMarkdown?: string;
  /** Path to HTML file for Vercel deployment (optional) */
  htmlPath?: string;
}

export interface OC004_Response {
  sent: boolean;
}

export const OC004_PROMPT = (req: OC004_Request) => {
  const todoLines = req.todos
    .map((t, i) => `${i + 1}. ${t.text}${t.assignee ? ` @${t.assignee}` : ""}${t.deadline ? ` (${t.deadline})` : ""}`)
    .join("\n");

  const buttons = req.todos.map((t, i) => [
    { text: `✅ ${i + 1}`, callback_data: `cc_confirm:${req.meetingId}:${t.id}` },
    { text: `❌ ${i + 1}`, callback_data: `cc_skip:${req.meetingId}:${t.id}` },
  ]);
  buttons.push([{ text: "✅ Confirm all", callback_data: `cc_confirm_all:${req.meetingId}` }]);

  const htmlNote = req.htmlPath
    ? `\n\nIMPORTANT: An HTML summary is available at: ${req.htmlPath}\nDeploy it to Vercel (vercel deploy --prod ${req.htmlPath}) and include the URL in the message to the user.`
    : "";

  return `Meeting "${req.topic}" just ended. Use the message tool to send the following to the user with inline buttons.${htmlNote}

Message content:
---
Meeting Todos — ${req.topic}

${todoLines}
---

Inline buttons (one row per todo, two buttons each):
\`\`\`json
${JSON.stringify(buttons, null, 2)}
\`\`\`

After sending the message, reply with only "sent".`;
};

export function parseOC004(raw: string): OC004_Response {
  return { sent: raw.toLowerCase().includes("sent") };
}

// ══════════════════════════════════════════════════════════════
// OC-005: Post-Meeting Summary Delivery (no todos)
// Trigger: Meeting ends without action items
// ══════════════════════════════════════════════════════════════

export interface OC005_Request {
  id: "OC-005";
  topic: string;
  keyPoints: string[];
  decisions: string[];
  /** Full summary markdown (optional — for user delivery) */
  summaryMarkdown?: string;
  /** Path to HTML file for Vercel deployment (optional) */
  htmlPath?: string;
}

export interface OC005_Response {
  sent: boolean;
}

export const OC005_PROMPT = (req: OC005_Request) => {
  const parts = [`Meeting Summary — ${req.topic}`, ""];
  if (req.keyPoints.length) parts.push(`**Key conclusions:**\n${req.keyPoints.map((p) => `- ${p}`).join("\n")}`);
  if (req.decisions.length) parts.push(`\n**Decisions:**\n${req.decisions.map((d) => `- ${d}`).join("\n")}`);
  parts.push("", "(No action items)");

  const htmlNote = req.htmlPath
    ? `\n\nIMPORTANT: An HTML summary is available at: ${req.htmlPath}\nDeploy it to Vercel (vercel deploy --prod ${req.htmlPath}) and include the URL in the message.`
    : "";

  return `Meeting "${req.topic}" just ended with no action items. Use the message tool to send this summary to the user:${htmlNote}

${parts.filter(Boolean).join("\n")}

After sending, reply with only "sent".`;
};

export function parseOC005(raw: string): OC005_Response {
  return { sent: raw.toLowerCase().includes("sent") };
}

// ══════════════════════════════════════════════════════════════
// OC-006: Todo Execution Handoff
// Trigger: User confirms todo via Telegram button
// ══════════════════════════════════════════════════════════════

export interface OC006_Request {
  id: "OC-006";
  todo: {
    fullText: string;
    assignee?: string;
    deadline?: string;
  };
  meeting: {
    topic: string;
    time: string;
    notesFilePath: string;
    decisions: string[];
    requirements: string[];
    liveNotes: string[];
  };
}

export interface OC006_Response {
  status: "started" | "completed" | "failed";
  summary: string;
}

export const OC006_PROMPT = (req: OC006_Request) => {
  const parts: string[] = [];
  parts.push("User confirmed a meeting todo for execution.");
  parts.push("");
  parts.push("## Todo");
  parts.push(req.todo.fullText);
  if (req.todo.assignee) parts.push(`Assignee: ${req.todo.assignee}`);
  if (req.todo.deadline) parts.push(`Deadline: ${req.todo.deadline}`);
  parts.push("");
  parts.push("## Meeting Context");
  parts.push(`Topic: ${req.meeting.topic}`);
  parts.push(`Time: ${req.meeting.time}`);
  parts.push(`Full notes: ${req.meeting.notesFilePath}`);
  if (req.meeting.decisions.length) {
    parts.push("", "## Related Decisions");
    req.meeting.decisions.forEach((d) => parts.push(`- ${d}`));
  }
  if (req.meeting.requirements.length) {
    parts.push("", "## Requirements from Meeting");
    req.meeting.requirements.forEach((r) => parts.push(`- ${r}`));
  }
  if (req.meeting.liveNotes.length) {
    parts.push("", "## Live Notes");
    req.meeting.liveNotes.forEach((n) => parts.push(`- ${n}`));
  }
  parts.push("");
  parts.push("Read the full meeting notes, combine with your memory and file structure, analyze the todo's background, acceptance criteria, and goals, then execute using a sub-agent.");
  parts.push("");
  parts.push('When done, reply with JSON: {"status": "completed", "summary": "what was done"}');

  return parts.join("\n");
};

export function parseOC006(raw: string): OC006_Response {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const p = JSON.parse(match[0]);
      if (p.status && p.summary) return { status: p.status, summary: p.summary };
    }
  } catch {}
  return { status: "started", summary: raw.slice(0, 500) };
}

// ══════════════════════════════════════════════════════════════
// OC-007: Meeting Vision Context Push
// Trigger: Every ~40s during meeting (batch of 5 screen descriptions)
// ══════════════════════════════════════════════════════════════

export interface OC007_Request {
  id: "OC-007";
  reason: "batch" | "final";
  screenDescriptions: string[];
}

export interface OC007_Response {
  acknowledged: boolean;
}

export const OC007_PROMPT = (req: OC007_Request) =>
  req.reason === "final"
    ? `Meeting ended — final screen captures for meeting context:\n\n${req.screenDescriptions.join("\n\n")}\n\nStore these in your meeting context for the post-meeting summary. Reply "ok".`
    : `Meeting screen update — visual content shown during the meeting. Add relevant details to your meeting context for later summary:\n\n${req.screenDescriptions.join("\n\n")}\n\nReply "ok".`;

export function parseOC007(raw: string): OC007_Response {
  return { acknowledged: raw.toLowerCase().includes("ok") || raw.length > 0 };
}

// ══════════════════════════════════════════════════════════════
// OC-008: Computer Use Task Delegation
// Trigger: Claude CU agent decides to delegate to OpenClaw
// ══════════════════════════════════════════════════════════════

export interface OC008_Request {
  id: "OC-008";
  task: string;
}

export interface OC008_Response {
  result: string;
}

export const OC008_PROMPT = (req: OC008_Request) => req.task;

export function parseOC008(raw: string): OC008_Response {
  return { result: raw.length > 10000 ? raw.slice(0, 10000) + "\n...(truncated)" : raw };
}

// ══════════════════════════════════════════════════════════════
// OC-009: Post-Meeting Follow-up Fallback
// Trigger: PostMeetingDelivery.deliver() fails
// ══════════════════════════════════════════════════════════════

export interface OC009_Request {
  id: "OC-009";
  topic: string;
  time: string;
  filepath: string;
  keyPoints: string[];
  tasks: Array<{ task: string }>;
}

export interface OC009_Response {
  acknowledged: boolean;
}

export const OC009_PROMPT = (req: OC009_Request) => {
  const parts = [
    `## Meeting Ended — Follow-up Report`,
    `**Topic**: ${req.topic}`,
    `**Time**: ${req.time}`,
    `**Notes file**: ${req.filepath}`,
  ];
  if (req.keyPoints.length) parts.push(`\n### Key Conclusions\n${req.keyPoints.map((p) => `- ${p}`).join("\n")}`);
  if (req.tasks.length) parts.push(`\n### Pending Tasks\n${req.tasks.map((t) => `- [ ] ${t.task}`).join("\n")}`);
  return `Meeting follow-up (Telegram delivery failed, sending raw report). Store this for reference:\n\n${parts.join("\n")}\n\nReply "ok".`;
};

export function parseOC009(raw: string): OC009_Response {
  return { acknowledged: raw.length > 0 };
}

// ══════════════════════════════════════════════════════════════
// Protocol Index
// ══════════════════════════════════════════════════════════════

export const OPENCLAW_PROTOCOL = {
  "OC-001": { name: "Meeting Prep Brief Generation", prompt: OC001_PROMPT, parse: parseOC001 },
  "OC-002": { name: "Context Recall", prompt: OC002_PROMPT, parse: parseOC002 },
  "OC-003": { name: "Calendar Cron Registration", prompt: OC003_PROMPT, parse: parseOC003 },
  "OC-004": { name: "Todo Delivery (Telegram)", prompt: OC004_PROMPT, parse: parseOC004 },
  "OC-005": { name: "Summary Delivery (no todos)", prompt: OC005_PROMPT, parse: parseOC005 },
  "OC-006": { name: "Todo Execution Handoff", prompt: OC006_PROMPT, parse: parseOC006 },
  "OC-007": { name: "Meeting Vision Push", prompt: OC007_PROMPT, parse: parseOC007 },
  "OC-008": { name: "Computer Use Delegation", prompt: OC008_PROMPT, parse: parseOC008 },
  "OC-009": { name: "Follow-up Fallback", prompt: OC009_PROMPT, parse: parseOC009 },
} as const;

export type OpenClawProtocolId = keyof typeof OPENCLAW_PROTOCOL;
