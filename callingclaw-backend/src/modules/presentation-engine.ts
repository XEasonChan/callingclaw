// CallingClaw — Presentation Engine (narrative mapping only)
//
// Story-driven presentation: the NARRATIVE leads, the page follows.
//
// Architecture (simplified — voice model drives execution natively):
//   Phase 1 — Story (from MeetingPrepBrief):
//     MeetingPrep generates: goal → keyPoints → decisions → narrative arc
//
//   Phase 2 — Stage Directions (this engine):
//     Haiku maps story beats to scroll positions on the page.
//     Output: PresentationPlan (array of slides with scroll targets + talking points)
//
//   Phase 3 — Performance (handled by voice model):
//     Voice model sees the screen (injectScreenshot), uses interact/scroll tools
//     to navigate, and narrates naturally. No timer loops or scene state machines.
//     The voice model IS the presentation engine.

import { CONFIG } from "../config";

export interface PresentationSlide {
  sectionTitle: string;
  scrollTarget: string;
  talkingPoints: string;
  estimatedDurationMs: number;
}

export interface PresentationPlan {
  url: string;
  topic: string;
  slides: PresentationSlide[];
  totalEstimatedMs: number;
}

/** Meeting context — the STORY that drives the presentation */
export interface PresentationBriefContext {
  goal?: string;
  summary?: string;
  keyPoints?: string[];
  architectureDecisions?: Array<{ decision: string; rationale: string }>;
  expectedQuestions?: Array<{ question: string; suggestedAnswer: string }>;
  previousContext?: string;
  attendees?: Array<{ name?: string; email: string }>;
  liveNotes?: string[];
}

export class PresentationEngine {
  private _running = false;
  private _paused = false;
  private _currentSlide = -1;
  _plan: PresentationPlan | null = null;

  get running() { return this._running; }
  get paused() { return this._paused; }
  get currentSlide() { return this._currentSlide; }
  get plan() { return this._plan; }

  /**
   * Build a presentation plan: story-first, page-second.
   *
   * If briefContext is provided (normal flow):
   *   The story comes from MeetingPrep → Haiku maps story beats to DOM positions.
   *
   * If no briefContext (fallback):
   *   Haiku reads DOM and generates both story + positions (legacy behavior).
   */
  async buildPlan(opts: {
    url: string;
    topic: string;
    context?: string;
    briefContext?: PresentationBriefContext;
    chromeLauncher: any;
  }): Promise<PresentationPlan> {
    const { url, topic, context: extraContext, briefContext, chromeLauncher } = opts;

    // 1. Get DOM snapshot from the presenting page
    console.log(`[Presentation] Building plan for: ${url}`);
    const snapshot = await chromeLauncher.snapshotPresentingPage();
    console.log(`[Presentation] Snapshot: ${snapshot?.length || 0} chars`);

    if (!snapshot || snapshot.length < 50) {
      throw new Error("Page snapshot too short — page may not be loaded");
    }

    // 2. Build the prompt — story-driven if brief available, DOM-driven fallback
    const prompt = briefContext
      ? this._buildStoryDrivenPrompt(url, topic, extraContext, briefContext, snapshot)
      : this._buildDomDrivenPrompt(url, topic, extraContext, snapshot);
    console.log(`[Presentation] Prompt: ${prompt.length} chars, calling Haiku (${CONFIG.analysis.model})...`);

    // 3. Call Haiku (use curl fallback if fetch fails — Bun+Playwright conflict)
    let content: string;
    try {
      const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
        },
        body: JSON.stringify({
          model: CONFIG.analysis.model,
          max_tokens: 2500,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`Haiku API error: ${resp.status}`);
      const data = await resp.json() as any;
      content = data.choices?.[0]?.message?.content || "[]";
    } catch (fetchErr: any) {
      // Fallback: use curl when Bun fetch is broken (e.g., Playwright browser active)
      console.warn(`[Presentation] fetch failed (${fetchErr.message}), falling back to curl`);
      const reqBodyPath = "/tmp/callingclaw-present-req.json";
      await Bun.write(reqBodyPath, JSON.stringify({
        model: CONFIG.analysis.model,
        max_tokens: 2500,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }));
      const apiUrl = `${CONFIG.openrouter.baseUrl}/chat/completions`;
      const authHeader = `Bearer ${CONFIG.openrouter.apiKey}`;
      const proc = Bun.spawn(["curl", "-s", "--noproxy", "*", "--max-time", "30", "-X", "POST", apiUrl,
        "-H", "Content-Type: application/json",
        "-H", `Authorization: ${authHeader}`,
        "-d", `@${reqBodyPath}`,
      ], { stderr: "pipe" });
      const curlResult = await new Response(proc.stdout).text();
      const curlErr = await new Response(proc.stderr).text();
      if (curlErr) console.warn(`[Presentation] curl stderr: ${curlErr.slice(0, 200)}`);
      const curlData = JSON.parse(curlResult);
      if (curlData.error) throw new Error(`Haiku API error: ${JSON.stringify(curlData.error)}`);
      content = curlData.choices?.[0]?.message?.content || "[]";
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Haiku returned no JSON array");

    const slides: PresentationSlide[] = JSON.parse(jsonMatch[0]);
    const totalEstimatedMs = slides.reduce((sum, s) => sum + s.estimatedDurationMs, 0);

    this._plan = { url, topic, slides, totalEstimatedMs };
    console.log(`[Presentation] Plan built: ${slides.length} slides, ~${Math.round(totalEstimatedMs / 1000)}s total`);
    for (const s of slides) {
      console.log(`  → ${s.sectionTitle} (${Math.round(s.estimatedDurationMs / 1000)}s)`);
    }

    return this._plan;
  }

  // ── Story-First Brief Generation (analyze content → narrative arc) ──

  /**
   * Generate a PresentationBriefContext from raw HTML content.
   * This is the "story-first" step: understand what matters (goal, key decisions,
   * likely questions) BEFORE mapping to scroll positions.
   * Used in test/standalone mode where no MeetingPrepBrief exists.
   */
  async generateBriefFromContent(opts: {
    textSnapshot: string;
    topic: string;
    context?: string;
  }): Promise<PresentationBriefContext> {
    const { textSnapshot, topic, context: extraContext } = opts;

    const prompt = `You are analyzing a document to create a presentation strategy.
Think like an employee preparing to present work to their boss.

## Document Content:
${textSnapshot.substring(0, 5000)}

## Topic: ${topic}
${extraContext ? `## Additional Context: ${extraContext}` : ""}

## Your Task:
Create a presentation strategy. Identify:
1. What is the GOAL of presenting this? (What should the audience understand or decide?)
2. What are the 3-5 KEY POINTS in order of importance (not document order)?
3. What key DECISIONS or trade-offs are described?
4. What QUESTIONS will the audience likely ask?

Return ONLY JSON:
{
  "goal": "one sentence",
  "summary": "2-3 sentence overview",
  "keyPoints": ["point1", "point2", "point3"],
  "architectureDecisions": [{"decision": "what was decided", "rationale": "why"}],
  "expectedQuestions": [{"question": "likely question", "suggestedAnswer": "how to answer"}]
}`;

    // Call Haiku with curl fallback (Bun fetch broken with HTTPS_PROXY)
    let content: string;
    try {
      const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
        body: JSON.stringify({ model: CONFIG.analysis.model, max_tokens: 1500, temperature: 0.3, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      const data = await resp.json() as any;
      content = data.choices?.[0]?.message?.content || "{}";
    } catch {
      console.warn("[Presentation] fetch failed for brief generation, falling back to curl");
      const reqBodyPath = "/tmp/callingclaw-brief-req.json";
      await Bun.write(reqBodyPath, JSON.stringify({ model: CONFIG.analysis.model, max_tokens: 1500, temperature: 0.3, messages: [{ role: "user", content: prompt }] }));
      const apiUrl = `${CONFIG.openrouter.baseUrl}/chat/completions`;
      const authHeader = `Bearer ${CONFIG.openrouter.apiKey}`;
      const proc = Bun.spawn(["curl", "-s", "--noproxy", "*", "--max-time", "30", "-X", "POST", apiUrl, "-H", "Content-Type: application/json", "-H", `Authorization: ${authHeader}`, "-d", `@${reqBodyPath}`], { stderr: "pipe" });
      const curlResult = await new Response(proc.stdout).text();
      const curlErr = await new Response(proc.stderr).text();
      if (curlErr) console.warn(`[Presentation] curl stderr: ${curlErr.slice(0, 200)}`);
      const curlData = JSON.parse(curlResult);
      if (curlData.error) throw new Error(`API error: ${JSON.stringify(curlData.error)}`);
      content = curlData.choices?.[0]?.message?.content || "{}";
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const brief = JSON.parse(jsonMatch?.[0] || "{}") as PresentationBriefContext;
    console.log(`[Presentation] Brief generated: goal="${brief.goal?.slice(0, 60)}", ${brief.keyPoints?.length || 0} key points`);
    return brief;
  }

  // ── Story-Driven Prompt (normal flow: brief → story → page mapping) ──

  private _buildStoryDrivenPrompt(
    url: string,
    topic: string,
    extraContext: string | undefined,
    brief: PresentationBriefContext,
    snapshot: string,
  ): string {
    // Build the narrative arc from the brief
    const storyParts: string[] = [];

    if (brief.goal) storyParts.push(`Goal of this presentation: ${brief.goal}`);
    if (brief.previousContext) storyParts.push(`Where we left off last time: ${brief.previousContext}`);

    if (brief.attendees?.length) {
      const names = brief.attendees.map(a => a.name || a.email).join(", ");
      storyParts.push(`Audience: ${names}`);
    }

    if (brief.keyPoints?.length) {
      storyParts.push(`Story beats (in order of importance):\n${brief.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
    }

    if (brief.architectureDecisions?.length) {
      const decisions = brief.architectureDecisions.map(d => `- "${d.decision}" — because: ${d.rationale}`).join("\n");
      storyParts.push(`Key decisions to highlight (emphasize the WHY):\n${decisions}`);
    }

    if (brief.expectedQuestions?.length) {
      const qs = brief.expectedQuestions.slice(0, 3).map(q => `- "${q.question}" → ${q.suggestedAnswer}`).join("\n");
      storyParts.push(`Questions the audience will likely ask (preemptively address):\n${qs}`);
    }

    if (brief.liveNotes?.length) {
      const recent = brief.liveNotes.slice(-5);
      storyParts.push(`Recent updates to weave in:\n${recent.map(n => `- ${n}`).join("\n")}`);
    }

    return `You are a presentation director. A meeting prep has already written the STORY — your job is to map that story onto this webpage, finding the right scroll positions for each story beat.

## The Story (this is what the presenter MUST say)
${storyParts.join("\n\n")}

## The Stage (webpage to scroll through)
URL: ${url}
Topic: ${topic}
${extraContext ? `Additional context: ${extraContext}` : ""}

## Page DOM Snapshot:
${snapshot.substring(0, 6000)}

## Your Task
Map each story beat to a position on the page. Create 5-8 slides:

- sectionTitle: a short label for this story beat (can differ from DOM headings)
- scrollTarget: exact text string from the DOM to scrollIntoView (must exist in the snapshot)
- talkingPoints: 2-4 sentences of natural speech. Rules:
  1. The story beats and decisions above are your SCRIPT — follow them faithfully
  2. Lead with WHY and the DECISION, not implementation details
  3. If the brief mentions "last time we discussed X", open with that continuity
  4. Skip resolved bugs or old issues — only mention if the lesson matters to the audience
  5. Preemptively address expected questions when relevant
  6. Match the page language (Chinese → Chinese, English → English)
  7. Sound like a knowledgeable teammate presenting, not a robot reading a summary
- estimatedDurationMs: ~150 words/min (English) or ~200 chars/min (Chinese)

If a story beat has no matching section on the page, still include it as a slide — use the nearest relevant scroll position and deliver the talking point there.

Return ONLY a JSON array:
[{"sectionTitle":"...","scrollTarget":"...","talkingPoints":"...","estimatedDurationMs":N},...]`;
  }

  // ── DOM-Driven Prompt (fallback: no brief, generate from page) ──

  private _buildDomDrivenPrompt(
    url: string,
    topic: string,
    extraContext: string | undefined,
    snapshot: string,
  ): string {
    return `You are preparing a presentation script from a webpage. The presenter (CallingClaw AI) will narrate each section while the page scrolls to match.

## Page URL: ${url}
## Topic: ${topic}
${extraContext ? `## Additional context: ${extraContext}` : ""}

## Page DOM Snapshot (headings + key content):
${snapshot.substring(0, 6000)}

## Instructions
Extract 5-8 sections from the page in visual order (top to bottom). For each section:
- sectionTitle: the heading text (exact match from DOM)
- scrollTarget: exact text string to find via scrollIntoView (use the heading text)
- talkingPoints: 2-4 sentences of natural speech. Focus on decisions and rationale over implementation details. Match the page language.
- estimatedDurationMs: ~150 words/min (English) or ~200 chars/min (Chinese)

Return ONLY a JSON array:
[{"sectionTitle":"...","scrollTarget":"...","talkingPoints":"...","estimatedDurationMs":N},...]`;
  }

}
// ── Deleted: run(), runScenes(), runScript(), SceneController ──
// Voice model drives presentation natively using interact/scroll/navigate tools
// + injectScreenshot feedback loop. No timer loops or scene state machines needed.

// Legacy type kept for compatibility (SceneSpec used by meeting-tools share_screen)
export interface SceneSpec {
  url: string;
  scrollTarget?: string;
  talkingPoints: string;
  durationMs: number;
}

// EOF — previous 550 lines of timer-driven execution deleted
// The voice model IS the presentation engine now.
