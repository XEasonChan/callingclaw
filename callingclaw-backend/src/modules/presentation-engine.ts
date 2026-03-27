// CallingClaw — Presentation Engine
// Haiku reads a webpage, builds a presentation plan, then orchestrates
// Grok (voice) + Playwright (scroll) to deliver a synchronized presentation.
//
// Architecture:
//   1. Haiku reads full page DOM snapshot (ONE call, ~1-2s)
//   2. Returns structured slides: { sectionTitle, scrollTarget, talkingPoints }
//   3. Runner loops: scroll → wait → speak → wait → next
//   4. User interruption → pause → Grok responds → resume
//
// This gives Grok "vision" without any vision model — Haiku pre-digests
// the page content into talking points that Grok speaks naturally.

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
   * Build a presentation plan by having Haiku read the page DOM.
   * Returns the plan without starting the presentation.
   */
  async buildPlan(opts: {
    url: string;
    topic: string;
    context?: string;
    chromeLauncher: any;
  }): Promise<PresentationPlan> {
    const { url, topic, context: extraContext, chromeLauncher } = opts;

    // 1. Get DOM snapshot from the presenting page
    console.log(`[Presentation] Building plan for: ${url}`);
    const snapshot = await chromeLauncher.snapshotPresentingPage();

    if (!snapshot || snapshot.length < 50) {
      throw new Error("Page snapshot too short — page may not be loaded");
    }

    // 2. Ask Haiku to build the presentation plan
    const prompt = `You are building a presentation plan from a webpage. The presenter (CallingClaw AI) will narrate each section while the page scrolls to match.

## Page URL: ${url}
## Topic: ${topic}
${extraContext ? `## Additional context: ${extraContext}` : ""}

## Page DOM Snapshot (headings + key content):
${snapshot.substring(0, 6000)}

## Instructions
Extract 5-8 sections from the page in visual order (top to bottom). For each section:
- sectionTitle: the heading text (exact match from DOM)
- scrollTarget: exact text string to find via scrollIntoView (use the heading text)
- talkingPoints: 2-4 sentences to say about this section. Write as natural speech (not bullet points). Connect each section to the topic. Use the language that matches the page (Chinese page → Chinese talking points, English page → English).
- estimatedDurationMs: how long it takes to say the talking points at normal speed (~150 words/min for English, ~200 chars/min for Chinese)

Return ONLY a JSON array:
[{"sectionTitle":"...","scrollTarget":"...","talkingPoints":"...","estimatedDurationMs":N},...]`;

    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.analysis.model, // Haiku
        max_tokens: 2000,
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

  /**
   * Run the presentation: scroll + speak for each slide.
   */
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

        // 2. Wait for audience to see
        await new Promise(r => setTimeout(r, 2000));

        // 3. Speak talking points
        const transcriptBefore = sharedContext.transcript.length;
        voice.sendText(slide.talkingPoints);

        // 4. Wait for speech to complete
        await new Promise(r => setTimeout(r, slide.estimatedDurationMs));

        // 5. Check if user spoke during this slide (interruption detection)
        const newEntries = sharedContext.transcript.slice(transcriptBefore);
        const userSpoke = newEntries.some(e => e.role === "user" && e.text.length > 5
          && !e.text.includes("Press the down arrow")); // Filter tooltip noise

        if (userSpoke) {
          console.log("[Presentation] User spoke — pausing for response");
          // Let Grok respond naturally (it has the talking points context)
          await new Promise(r => setTimeout(r, 8000)); // Wait for Grok to respond
        }

        slidesPresented++;

        // Brief pause between slides
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally {
      this._running = false;
      this._currentSlide = -1;
    }

    console.log(`[Presentation] Completed: ${slidesPresented}/${plan.slides.length} slides`);
    return { completed: slidesPresented === plan.slides.length, slidesPresented };
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
