// CallingClaw 2.0 — Shared Context Store
// Central state shared between OpenAI Voice and Claude Computer Use
// OpenAI produces transcripts → Claude reads them for action context

export interface TranscriptEntry {
  role: "user" | "assistant" | "system" | "participant";
  speaker?: string;
  text: string;
  ts: number;
}

export interface ScreenState {
  latestScreenshot: string | null; // base64 JPEG (or PNG legacy)
  capturedAt: number;
  description?: string; // AI-generated screen description
  url?: string;         // Current page URL (from CDP)
  title?: string;       // Current page title (from CDP)
}

export interface MeetingNote {
  type: "todo" | "decision" | "action_item" | "note";
  text: string;
  assignee?: string;
  ts: number;
}

export interface WorkspaceFile {
  path: string;
  summary?: string;
  diffLines?: number;
}

export interface WorkspaceContext {
  topic?: string;
  files: WorkspaceFile[];
  gitSummary?: string;
  discussionPoints?: string[];
  injectedAt: number;
}

export interface BrowserContext {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  visibleText: string;
  links: number;
  buttons: number;
  inputs: number;
  capturedAt: number;
}

/** Document tracked on the Meeting Stage — visible to participants during screen share */
export interface StageDocument {
  path: string;
  name: string;
  badge?: "new" | "modified";
  addedAt: number;
}

/** Active presentation scene — updated by PresentationEngine, read by TranscriptAuditor */
export interface CurrentScene {
  index: number;
  total: number;
  url: string;
  scrollTarget?: string;
  talkingPoints: string;
}

export class SharedContext {
  private _transcript: TranscriptEntry[] = [];
  private _screen: ScreenState = { latestScreenshot: null, capturedAt: 0 };
  private _meetingNotes: MeetingNote[] = [];
  private _workspace: WorkspaceContext | null = null;
  private _browserContext: BrowserContext | null = null;
  private _currentScene: CurrentScene | null = null;
  private _stageDocuments = new Map<string, StageDocument>();
  private _listeners = new Map<string, Array<(data: any) => void>>();

  // ── Transcript ──

  get transcript(): readonly TranscriptEntry[] {
    return this._transcript;
  }

  addTranscript(entry: TranscriptEntry) {
    // BUG-031: Dedup — skip if identical entry exists in recent history (same role+text within 500ms)
    const recent = this._transcript.slice(-8);
    if (recent.some(e => e.role === entry.role && e.text === entry.text && Math.abs(e.ts - entry.ts) < 500)) {
      return; // Duplicate, skip
    }

    this._transcript.push(entry);
    this.emit("transcript", entry);

    // Keep last 200 entries to avoid memory bloat
    if (this._transcript.length > 200) {
      this._transcript = this._transcript.slice(-200);
    }
  }

  resetTranscript() {
    this._transcript = [];
  }

  getRecentTranscript(count = 20): TranscriptEntry[] {
    return this._transcript.slice(-count);
  }

  getTranscriptText(count = 20): string {
    return this.getRecentTranscript(count)
      .map((e) => `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`)
      .join("\n");
  }

  /**
   * Get conversation-only transcript (user + assistant speech).
   * Excludes system messages, tool calls/results, screen updates, etc.
   * Used by meeting summary generator to avoid OpenClaw task pollution.
   */
  getConversationText(count = 200): string {
    return this._transcript
      .filter((e) => e.role === "user" || e.role === "assistant")
      .slice(-count)
      .map((e) => `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`)
      .join("\n");
  }

  // ── Screen State ──

  get screen(): ScreenState {
    return this._screen;
  }

  updateScreen(screenshot: string, description?: string, url?: string, title?: string) {
    this._screen = {
      latestScreenshot: screenshot,
      capturedAt: Date.now(),
      description,
      url,
      title,
    };
    this.emit("screen", this._screen);
  }

  // ── Meeting Notes ──

  get meetingNotes(): readonly MeetingNote[] {
    return this._meetingNotes;
  }

  addNote(note: MeetingNote) {
    this._meetingNotes.push(note);
    this.emit("note", note);
  }

  getTodos(): MeetingNote[] {
    return this._meetingNotes.filter((n) => n.type === "todo" || n.type === "action_item");
  }

  // ── Workspace Context ──

  get workspace(): WorkspaceContext | null {
    return this._workspace;
  }

  setWorkspace(ws: Omit<WorkspaceContext, "injectedAt">) {
    this._workspace = { ...ws, injectedAt: Date.now() };
    this.emit("workspace", this._workspace);
  }

  /** Build a system prompt snippet from workspace context for Voice AI */
  getWorkspacePrompt(): string {
    if (!this._workspace) return "";
    const parts: string[] = [];
    if (this._workspace.topic) {
      parts.push(`Meeting topic: ${this._workspace.topic}`);
    }
    if (this._workspace.files.length > 0) {
      parts.push("Files to discuss:");
      for (const f of this._workspace.files) {
        parts.push(`  - ${f.path}${f.summary ? ` — ${f.summary}` : ""}${f.diffLines ? ` (${f.diffLines} lines changed)` : ""}`);
      }
    }
    if (this._workspace.gitSummary) {
      parts.push(`Recent git changes: ${this._workspace.gitSummary}`);
    }
    if (this._workspace.discussionPoints && this._workspace.discussionPoints.length > 0) {
      parts.push("Discussion points:");
      for (const dp of this._workspace.discussionPoints) {
        parts.push(`  - ${dp}`);
      }
    }
    return parts.join("\n");
  }

  clearWorkspace() {
    this._workspace = null;
  }

  // ── Browser Context (Talk Locally: DOM snapshots of active browser tab) ──

  get browserContext(): BrowserContext | null {
    return this._browserContext;
  }

  updateBrowserContext(info: Omit<BrowserContext, "capturedAt">) {
    this._browserContext = { ...info, capturedAt: Date.now() };
    this.emit("browser_context", this._browserContext);
  }

  clearBrowserContext() {
    this._browserContext = null;
  }

  /** Current presentation scene — set by PresentationEngine, read by TranscriptAuditor */
  get currentScene(): CurrentScene | null {
    return this._currentScene;
  }

  updateCurrentScene(scene: CurrentScene) {
    this._currentScene = scene;
    this.emit("scene", this._currentScene);
  }

  clearCurrentScene() {
    this._currentScene = null;
    this.emit("scene", null);
  }

  // ── Stage Documents (Meeting Stage working documents) ──

  addStageDocument(path: string, badge?: "new" | "modified") {
    const name = path.split("/").pop() || path;
    this._stageDocuments.set(path, { path, name, badge, addedAt: Date.now() });
    this.emit("stage_documents", this.stageDocuments);
  }

  get stageDocuments(): StageDocument[] {
    return Array.from(this._stageDocuments.values())
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, 10);
  }

  getStageDocumentsPrompt(): string {
    const docs = this.stageDocuments;
    if (docs.length === 0) return "";
    return "[STAGE DOCS] " + docs.map((d, i) => `${i + 1}. ${d.name}`).join("  ");
  }

  clearStageDocuments() {
    this._stageDocuments.clear();
    this.emit("stage_documents", []);
  }

  // ── Event System ──

  on(event: string, handler: (data: any) => void) {
    const list = this._listeners.get(event) || [];
    list.push(handler);
    this._listeners.set(event, list);
  }

  off(event: string, handler: (data: any) => void) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      const idx = listeners.indexOf(handler);
      if (idx !== -1) listeners.splice(idx, 1);
    }
  }

  private emit(event: string, data: any) {
    const list = this._listeners.get(event) || [];
    for (const fn of list) fn(data);
  }

  // ── Export ──

  exportSummary() {
    return {
      transcriptLength: this._transcript.length,
      latestTranscript: this.getRecentTranscript(5),
      screenCapturedAt: this._screen.capturedAt,
      screenDescription: this._screen.description,
      meetingNotes: this._meetingNotes,
      todos: this.getTodos(),
      workspace: this._workspace,
      browserContext: this._browserContext,
      stageDocuments: this.stageDocuments,
    };
  }

  reset() {
    this._transcript = [];
    this._screen = { latestScreenshot: null, capturedAt: 0 };
    this._meetingNotes = [];
    this._workspace = null;
    this._browserContext = null;
    this._stageDocuments.clear();
  }
}
