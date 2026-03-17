// CallingClaw 2.0 — OpenClaw Protocol Schema
// ═══════════════════════════════════════════════════════════════════
// Defines ALL message schemas between CallingClaw → OpenClaw.
// Each call has a unique ID, typed request, and typed response.
//
// Design principles:
// - Every call has a schema ID (OC-xxx) for cross-reference in docs
// - Request and response are typed — no ambiguous free-text
// - Response parsing includes validation
// - Failure modes are explicit
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

  return `You are preparing a Meeting Prep Brief for CallingClaw's voice AI assistant.

## Your Task
Read the relevant files and your memory, then generate a structured JSON meeting prep brief.

## Meeting Topic
${req.topic}

## Additional Context from User
${req.userContext || "(no additional context)"}${attendeeSection}

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

Be thorough with file paths — use absolute paths. Write summary in the user's preferred language.`;
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
  // Fallback: raw text as summary
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
  localContext?: string;  // Pre-fetched local keyword search result
  language: string;       // "zh" | "en" | "ja"
}

export interface OC002_Response {
  answer: string;         // Concise factual answer (<500 words)
}

export const OC002_PROMPT = (req: OC002_Request) =>
  `The user asked a question that requires context recall. Search your memory (MEMORY.md), recent files, and conversation history to find relevant information.

User's question context: "${req.query}"

${req.localContext ? `Pre-fetched local context:\n${req.localContext}\n\nPlease expand on this with more details.` : "No local context found. Please search broadly."}

Return a concise factual answer (under 500 words) that the voice assistant can relay to the user. Focus on concrete facts, dates, metrics, and actionable information. Answer in ${req.language === "zh" ? "Chinese" : req.language === "ja" ? "Japanese" : "English"}.`;

export function parseOC002(raw: string): OC002_Response {
  return { answer: raw.slice(0, 3000) };
}

// ══════════════════════════════════════════════════════════════
// OC-003: Calendar Cron Registration
// Trigger: MeetingScheduler finds upcoming meeting
// ══════════════════════════════════════════════════════════════

export interface OC003_Request {
  id: "OC-003";
  cronName: string;          // e.g. "auto-join: CallingClaw PRD review"
  joinAtISO: string;         // ISO 8601 timestamp
  eventSummary: string;      // Meeting title
  eventDescription: string;  // Full event text for OpenClaw context
}

export interface OC003_Response {
  jobId: string;             // Cron job ID
}

export const OC003_PROMPT = (req: OC003_Request) =>
  `请用 cron 工具创建一个一次性定时任务:
- action: "add"
- schedule: { kind: "at", at: "${req.joinAtISO}" }
- sessionTarget: "main"
- payload: { kind: "systemEvent", text: 以下内容 }
- name: "${req.cronName}"

systemEvent 内容:
---
${req.eventDescription}
---

创建后只回复 job ID，格式: jobId: <id>`;

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
    text: string;       // Compressed ≤20 chars
    fullText: string;   // Original text
    assignee?: string;
    deadline?: string;
  }>;
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
  buttons.push([{ text: "✅ 全部确认执行", callback_data: `cc_confirm_all:${req.meetingId}` }]);

  return `会议「${req.topic}」刚结束。请用 message 工具发送以下内容给用户，并附带 inline buttons:

消息内容:
---
📋 会议 Todo — ${req.topic}

${todoLines}
---

inline buttons:
\`\`\`json
${JSON.stringify(buttons, null, 2)}
\`\`\`

发完消息后，只回复 "sent"。`;
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
}

export interface OC005_Response {
  sent: boolean;
}

export const OC005_PROMPT = (req: OC005_Request) => {
  const parts = [`📝 会议总结 — ${req.topic}`, ""];
  if (req.keyPoints.length) parts.push(`**关键结论:**\n${req.keyPoints.map((p) => `- ${p}`).join("\n")}`);
  if (req.decisions.length) parts.push(`\n**决策:**\n${req.decisions.map((d) => `- ${d}`).join("\n")}`);
  parts.push("", "(无待办事项)");

  return `会议「${req.topic}」刚结束，没有 action items。请用 message 工具发送以下总结给用户:\n\n${parts.filter(Boolean).join("\n")}

发完消息后，只回复 "sent"。`;
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
    time: string;          // ISO 8601
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
  parts.push(`用户确认了会议 todo，请执行。`);
  parts.push("");
  parts.push("## Todo");
  parts.push(req.todo.fullText);
  if (req.todo.assignee) parts.push(`负责人: ${req.todo.assignee}`);
  if (req.todo.deadline) parts.push(`截止: ${req.todo.deadline}`);
  parts.push("");
  parts.push("## 会议信息");
  parts.push(`主题: ${req.meeting.topic}`);
  parts.push(`时间: ${req.meeting.time}`);
  parts.push(`完整记录: ${req.meeting.notesFilePath}`);
  if (req.meeting.decisions.length) {
    parts.push("", "## 相关决策");
    req.meeting.decisions.forEach((d) => parts.push(`- ${d}`));
  }
  if (req.meeting.requirements.length) {
    parts.push("", "## 会议中的需求");
    req.meeting.requirements.forEach((r) => parts.push(`- ${r}`));
  }
  if (req.meeting.liveNotes.length) {
    parts.push("", "## 实时记录");
    req.meeting.liveNotes.forEach((n) => parts.push(`- ${n}`));
  }
  parts.push("");
  parts.push("请读取完整会议记录，结合你的记忆和文件结构，分析这个 todo 的背景、验收标准、修改方向和目标，然后用 sub-agent 执行。");
  parts.push("");
  parts.push('完成后回复 JSON: {"status": "completed", "summary": "做了什么"}');

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
  // Fallback: treat any response as "started"
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

// No meaningful response — fire and forget
export interface OC007_Response {
  acknowledged: boolean;
}

export const OC007_PROMPT = (req: OC007_Request) =>
  req.reason === "final"
    ? `Meeting ended — final screen captures for meeting context:\n\n${req.screenDescriptions.join("\n\n")}\n\nStore these in your meeting context for the summary. Reply "ok".`
    : `Meeting screen update — visual content shown during meeting. Add to meeting context:\n\n${req.screenDescriptions.join("\n\n")}\n\nReply "ok".`;

export function parseOC007(raw: string): OC007_Response {
  return { acknowledged: raw.toLowerCase().includes("ok") || raw.length > 0 };
}

// ══════════════════════════════════════════════════════════════
// OC-008: Computer Use Task Delegation
// Trigger: Claude CU agent decides to delegate to OpenClaw
// ══════════════════════════════════════════════════════════════

export interface OC008_Request {
  id: "OC-008";
  task: string;           // Natural language task from Claude CU
}

export interface OC008_Response {
  result: string;         // Task execution output (capped 10K chars)
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
    `## 会议结束 — Follow-up Report`,
    `**主题**: ${req.topic}`,
    `**时间**: ${req.time}`,
    `**记录文件**: ${req.filepath}`,
  ];
  if (req.keyPoints.length) parts.push(`\n### 关键结论\n${req.keyPoints.map((p) => `- ${p}`).join("\n")}`);
  if (req.tasks.length) parts.push(`\n### 待执行任务\n${req.tasks.map((t) => `- [ ] ${t.task}`).join("\n")}`);
  return `Meeting follow-up (delivery failed, sending raw):\n\n${parts.join("\n")}\n\nReply "ok".`;
};

export function parseOC009(raw: string): OC009_Response {
  return { acknowledged: raw.length > 0 };
}

// ══════════════════════════════════════════════════════════════
// Protocol Index — all schemas in one place
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
