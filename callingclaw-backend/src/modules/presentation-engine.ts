// CallingClaw — Presentation Engine
//
// Story-driven presentation: the NARRATIVE leads, the page follows.
//
// Architecture:
//   Phase 1 — Story (from MeetingPrepBrief):
//     MeetingPrep generates: goal → keyPoints → decisions → narrative arc
//     This is the "what to say" — independent of any specific page.
//
//   Phase 2 — Stage Directions (this engine):
//     Haiku takes the story + DOM snapshot and maps each story beat
//     to a scroll position on the page. The page is the "slideshow"
//     that accompanies the narrative, not the source of it.
//
//   Phase 3 — Performance:
//     Runner loops: scroll → wait → speak → wait → next
//     User interruption → pause → voice responds → resume

import { CONFIG } from "../config";
import type { VoiceModule } from "./voice";
import type { SharedContext } from "./shared-context";

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
  private _plan: PresentationPlan | null = null;

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

    if (!snapshot || snapshot.length < 50) {
      throw new Error("Page snapshot too short — page may not be loaded");
    }

    // 2. Build the prompt — story-driven if brief available, DOM-driven fallback
    const prompt = briefContext
      ? this._buildStoryDrivenPrompt(url, topic, extraContext, briefContext, snapshot)
      : this._buildDomDrivenPrompt(url, topic, extraContext, snapshot);

    // 3. Call Haiku
    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.analysis.model, // Haiku
        max_tokens: 2500,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) throw new Error(`Haiku API error: ${resp.status}`);

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content || "[]";
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

  // ── Runner: scroll + speak for each slide ──

  async run(opts: {
    chromeLauncher: any;
    voice: VoiceModule;
    context: SharedContext;
    onSlide?: (slide: PresentationSlide, index: number, total: number) => void;
  }): Promise<{ completed: boolean; slidesPresented: number }> {
    if (!this._plan) throw new Error("No plan — call buildPlan() first");
    if (this._running) throw new Error("Already presenting");

    const { chromeLauncher, voice, context: sharedContext, onSlide } = opts;
    const plan = this._plan;
    this._running = true;
    this._paused = false;

    console.log(`[Presentation] Starting: ${plan.slides.length} slides`);
    let slidesPresented = 0;

    // Enable presentation mode on voice — slow tools (computer_action) will be
    // awaited instead of async, keeping voice and screen in sync
    voice.presentationMode = true;

    try {
      for (let i = 0; i < plan.slides.length; i++) {
        if (!this._running) break;

        // Wait if paused (user interruption)
        while (this._paused && this._running) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!this._running) break;

        const slide = plan.slides[i];
        this._currentSlide = i;
        onSlide?.(slide, i, plan.slides.length);

        console.log(`[Presentation] Slide ${i + 1}/${plan.slides.length}: ${slide.sectionTitle}`);

        // 1. Scroll to section
        await chromeLauncher.evaluateOnPresentingPage(`(() => {
          var target = ${JSON.stringify(slide.scrollTarget)};
          var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6,section,[id],p');
          for (var el of all) {
            if ((el.textContent || '').trim().toLowerCase().includes(target.toLowerCase())) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return 'scrolled';
            }
          }
          window.scrollBy({ top: 500, behavior: 'smooth' });
          return 'fallback_scroll';
        })()`);

        // 2. Wait for scroll animation to settle
        await new Promise(r => setTimeout(r, 1000));

        // 3. Speak talking points
        const transcriptBefore = sharedContext.transcript.length;
        voice.sendText(slide.talkingPoints);

        // 4. Wait for ACTUAL speech completion (not fixed estimate)
        // waitForSpeechDone() resolves when voice transitions from speaking → listening,
        // with estimatedDurationMs + 3s buffer as timeout fallback
        await voice.waitForSpeechDone(slide.estimatedDurationMs + 3000);

        // 5. Check if user spoke during this slide (interruption detection)
        const newEntries = sharedContext.transcript.slice(transcriptBefore);
        const userSpoke = newEntries.some(e => e.role === "user" && e.text.length > 5
          && !e.text.includes("Press the down arrow")); // Filter tooltip noise

        if (userSpoke) {
          console.log("[Presentation] User spoke — pausing for response");
          // Let voice model respond naturally, wait for it to finish
          await voice.waitForSpeechDone(10000);
        }

        slidesPresented++;

        // Brief pause between slides (tighter pacing for natural flow)
        await new Promise(r => setTimeout(r, 800));
      }
    } finally {
      this._running = false;
      this._currentSlide = -1;
      voice.presentationMode = false;
    }

    console.log(`[Presentation] Completed: ${slidesPresented}/${plan.slides.length} slides`);
    return { completed: slidesPresented === plan.slides.length, slidesPresented };
  }

  // ══════════════════════════════════════════════════════════════
  // Multi-URL Scene Runner (playbook-driven)
  // ══════════════════════════════════════════════════════════════
  //
  // Runs a sequence of scenes from the meeting playbook.
  // Each scene can be a different URL. The engine navigates between
  // URLs and scrolls to the specified target on each page.
  //
  //   scene[0]: callingclaw.com → scroll to hero
  //   scene[1]: callingclaw.com → scroll to #features
  //   scene[2]: vision.html → scroll to top
  //   scene[3]: figma.com/design/xxx → scroll to component
  //
  // The voice AI is driven by onSceneAdvance callbacks that inject
  // progressive context (current phase + next scene talking points).

  async runScenes(opts: {
    scenes: Array<{
      url: string;
      scrollTarget?: string;
      talkingPoints: string;
      durationMs: number;
    }>;
    chromeLauncher: any;
    voice: VoiceModule;
    context: SharedContext;
    onSceneAdvance?: (sceneIndex: number, scene: typeof opts.scenes[0]) => void;
    onComplete?: () => void;
  }): Promise<{ completed: boolean; scenesPresented: number }> {
    const { scenes, chromeLauncher, voice, context: sharedContext, onSceneAdvance, onComplete } = opts;
    if (scenes.length === 0) return { completed: true, scenesPresented: 0 };
    if (this._running) throw new Error("Already presenting");

    this._running = true;
    this._paused = false;
    let currentUrl = "";
    let scenesPresented = 0;
    voice.presentationMode = true;

    console.log(`[Presentation] Starting scene sequence: ${scenes.length} scenes`);

    try {
      for (let i = 0; i < scenes.length; i++) {
        if (!this._running) break;

        while (this._paused && this._running) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!this._running) break;

        const scene = scenes[i]!;
        this._currentSlide = i;

        // 1. Navigate to URL if different from current
        if (scene.url && scene.url !== currentUrl) {
          console.log(`[Presentation] Navigating to: ${scene.url}`);
          try {
            await chromeLauncher.navigatePresentingPage(scene.url);
            currentUrl = scene.url;
            // Wait for page load
            await new Promise(r => setTimeout(r, 2000));
          } catch (e: any) {
            console.warn(`[Presentation] Navigation failed for ${scene.url}: ${e.message}, skipping scene`);
            continue; // Skip this scene, voice continues
          }
        }

        // 2. Scroll to target
        if (scene.scrollTarget) {
          try {
            await chromeLauncher.evaluateOnPresentingPage(`(() => {
              var target = ${JSON.stringify(scene.scrollTarget)};
              var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6,section,[id],p,div');
              for (var el of all) {
                var text = (el.textContent || '').trim();
                if (text.toLowerCase().includes(target.toLowerCase()) && text.length < 200) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  return 'scrolled';
                }
              }
              window.scrollTo({ top: 0, behavior: 'smooth' });
              return 'fallback_top';
            })()`);
            await new Promise(r => setTimeout(r, 1000));
          } catch {
            // Scroll failure is non-fatal
          }
        }

        // 3. Update shared state + notify callback (progressive context injection)
        // SharedContext.currentScene is the single source of truth for "what's on screen now"
        // Read by TranscriptAuditor (Haiku) to know which page click/scroll targets apply to
        sharedContext.updateCurrentScene({
          index: i,
          total: scenes.length,
          url: scene.url,
          scrollTarget: scene.scrollTarget,
          talkingPoints: scene.talkingPoints,
        });
        onSceneAdvance?.(i, scene);
        console.log(`[Presentation] Scene ${i + 1}/${scenes.length}: ${scene.talkingPoints.slice(0, 60)}...`);

        // 4. Speak talking points
        const transcriptBefore = sharedContext.transcript.length;
        voice.sendText(scene.talkingPoints);

        // 5. Wait for speech completion
        await voice.waitForSpeechDone(scene.durationMs + 3000);

        // 6. Check for user interruption
        const newEntries = sharedContext.transcript.slice(transcriptBefore);
        const userSpoke = newEntries.some(e => e.role === "user" && e.text.length > 5);
        if (userSpoke) {
          console.log("[Presentation] User spoke — pausing for response");
          await voice.waitForSpeechDone(10000);
        }

        scenesPresented++;
        await new Promise(r => setTimeout(r, 800));
      }
    } finally {
      this._running = false;
      this._currentSlide = -1;
      voice.presentationMode = false;
      sharedContext.clearCurrentScene();
      onComplete?.();
    }

    console.log(`[Presentation] Scene sequence completed: ${scenesPresented}/${scenes.length}`);
    return { completed: scenesPresented === scenes.length, scenesPresented };
  }

  /** Pause the presentation (user wants to discuss) */
  pause() {
    if (this._running) {
      this._paused = true;
      console.log("[Presentation] Paused");
    }
  }

  /** Resume after pause */
  resume() {
    this._paused = false;
    console.log("[Presentation] Resumed");
  }

  /** Stop the presentation entirely */
  stop() {
    this._running = false;
    this._paused = false;
    console.log("[Presentation] Stopped");
  }
}
