// CallingClaw 2.0 — Playwright CLI Client (Layer 2: Browser Automation)
// Wraps the official @playwright/cli for token-efficient browser control.
//
// Uses persistent Chrome profile so Google login state survives across restarts.
// First launch requires manual Google login; subsequent launches reuse the session.
//
// Key flags:
//   --persistent          Save profile to disk across restarts
//   --profile=<path>      Custom profile directory
//   --browser=chrome      Use real Chrome (not Chromium for Testing)
//   --headed              Show the browser window
//   -s=<name>             Named session (share browser across CLI calls)

import { resolve } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";

// Resolve binary: prefer local node_modules/.bin, fallback to global
const LOCAL_BIN = resolve(import.meta.dir, "../../node_modules/.bin/playwright-cli");
const CMD = existsSync(LOCAL_BIN) ? LOCAL_BIN : "playwright-cli";
const SESSION = "callingclaw";
const TIMEOUT_MS = 15_000;

// Persistent browser profile — keeps Google login state across restarts
const DEFAULT_PROFILE_DIR = resolve(homedir(), ".callingclaw", "browser-profile");

export class PlaywrightCLIClient {
  private _connected = false;
  private _explicitlyStopped = false; // Prevents auto-start after explicit stop/reset
  private headless: boolean;
  private profileDir: string;

  get connected() { return this._connected; }

  constructor(opts?: { headless?: boolean; profileDir?: string }) {
    this.headless = opts?.headless ?? false; // Default headed — need to see the browser for meetings
    this.profileDir = opts?.profileDir || process.env.PLAYWRIGHT_USER_DATA_DIR || DEFAULT_PROFILE_DIR;
  }

  /** Start the Playwright-controlled Chrome session.
   *  1. Try to reconnect to an existing session (no new tabs).
   *  2. If no session exists, launch Chrome with about:blank. */
  async start(): Promise<void> {
    if (this._connected) return;
    this._explicitlyStopped = false; // Clear stopped flag on explicit start

    // Ensure profile directory exists
    try { mkdirSync(this.profileDir, { recursive: true }); } catch {}

    // Block notification permission prompts (Chrome native dialog can't be dismissed via playwright-cli)
    this.ensureChromePreferences();

    console.log(`[PlaywrightCLI] Starting (session: ${SESSION}, profile: ${this.profileDir}, browser: chrome)...`);

    // Step 1: Try reconnecting to existing session (no new tab opened)
    try {
      await this._exec(`eval "document.title || 'ok'"`);
      this._connected = true;
      console.log("[PlaywrightCLI] Reconnected to existing session");
      return;
    } catch {
      // No existing session — need to launch Chrome
    }

    // Step 2: Launch fresh Chrome (opens about:blank as initial tab)
    try {
      await this._exec("open about:blank");
      this._connected = true;
      console.log("[PlaywrightCLI] Ready — persistent Chrome profile active");
    } catch (e: any) {
      throw new Error(`Failed to start playwright-cli: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════

  /** Navigate to a URL */
  async navigate(url: string): Promise<string> {
    return this.run(`goto ${url}`);
  }

  /** Get interactive accessibility tree snapshot */
  async snapshot(): Promise<string> {
    const output = await this.run("snapshot");
    // playwright-cli writes snapshot to .yml file — extract and read it
    return this.extractSnapshotContent(output);
  }

  /** Click an element by its @ref from the snapshot */
  async click(ref: string): Promise<string> {
    const r = ref.startsWith("@") ? ref : `@${ref}`;
    await this.run(`click ${r}`);
    return this.snapshot();
  }

  /** Fill text into an element (clears first) */
  async type(ref: string, text: string, submit = false): Promise<string> {
    const r = ref.startsWith("@") ? ref : `@${ref}`;
    await this.run(`fill ${r} ${this.shellQuote(text)}`);
    if (submit) {
      await this.run("press Enter");
    }
    return this.snapshot();
  }

  /** Press a keyboard key */
  async pressKey(key: string): Promise<string> {
    return this.run(`press ${key}`);
  }

  /** Scroll the page */
  async scroll(direction: "up" | "down", amount = 3): Promise<string> {
    const key = direction === "down" ? "PageDown" : "PageUp";
    let result = "";
    for (let i = 0; i < amount; i++) {
      result = await this.run(`press ${key}`);
    }
    return result;
  }

  /** Hover over an element */
  async hover(ref: string): Promise<string> {
    const r = ref.startsWith("@") ? ref : `@${ref}`;
    return this.run(`hover ${r}`);
  }

  /** Take a screenshot */
  async screenshot(): Promise<string> {
    return this.run("screenshot");
  }

  /** Open a new tab (or navigate to URL) */
  async newTab(url?: string): Promise<string> {
    return this.run(`open ${url || "about:blank"}`);
  }

  /** Close the current page */
  async closeTab(): Promise<string> {
    return this.run("close");
  }

  /** Navigate back */
  async back(): Promise<string> {
    return this.run("go-back");
  }

  /** Navigate forward */
  async forward(): Promise<string> {
    return this.run("go-forward");
  }

  /** Reload the page */
  async reload(): Promise<string> {
    return this.run("reload");
  }

  /** Check a checkbox */
  async check(ref: string): Promise<string> {
    const r = ref.startsWith("@") ? ref : `@${ref}`;
    return this.run(`check ${r}`);
  }

  /** Evaluate JavaScript on the page. Returns only the result value, not CLI formatting. */
  async evaluate(js: string): Promise<string> {
    const raw = await this.run(`eval ${this.shellQuote(js)}`);
    return this.extractEvalResult(raw);
  }

  /** Evaluate JS only if already connected — no auto-start, no new tabs.
   *  Returns empty string if not connected. Use for background polling. */
  async evaluateIfConnected(js: string): Promise<string> {
    if (!this._connected) return "";
    return this.evaluate(js);
  }

  // ══════════════════════════════════════════════════════════════
  // High-level: Google Meet Join (Deterministic Fast Path)
  // ══════════════════════════════════════════════════════════════

  /**
   * Join a Google Meet meeting using deterministic JS eval — no AI model needed.
   * Handles all Meet pre-join states: "Join now", "Ask to join", "Switch here",
   * "Got it" dialogs, permission prompts, and waiting room.
   *
   * Default: camera OFF, mic ON, audio devices set to BlackHole for CallingClaw bridge.
   */
  async joinGoogleMeet(
    url: string,
    opts?: {
      displayName?: string;
      muteCamera?: boolean;
      muteMic?: boolean;
      micDevice?: string;      // e.g. "BlackHole 16ch"
      speakerDevice?: string;  // e.g. "BlackHole 2ch"
      onStep?: (step: string) => void;
    },
  ): Promise<{ success: boolean; summary: string; steps: string[]; state: "in_meeting" | "waiting_room" | "failed" }> {
    const displayName = opts?.displayName || "CallingClaw";
    const muteCamera = opts?.muteCamera ?? true;
    const muteMic = opts?.muteMic ?? false; // Default: mic ON (for BlackHole audio bridge)
    const micDevice = opts?.micDevice || "BlackHole 16ch";
    const speakerDevice = opts?.speakerDevice || "BlackHole 2ch";
    const steps: string[] = [];
    const log = (msg: string) => { steps.push(msg); opts?.onStep?.(msg); console.log(`[MeetJoin] ${msg}`); };

    try {
      // ── Step 1: Navigate to Meet URL ──
      log("Navigating...");
      await this.navigate(url);
      await this.wait(1500);

      // ── Step 2: Dismiss + detect + configure (NO join yet) ──
      // Single eval: dismiss dialogs, detect state, set camera/mic/name.
      // Join click is deferred to Step 4 so audio devices can be selected first.
      log("Detecting + configuring (single pass)...");
      const configResult = await this.evaluate(`() => {
        const R = { state: 'unknown', config: [], hasJoinBtn: false };

        // 1. Dismiss blocking dialogs
        const dismiss = ['got it', 'dismiss', 'continue without', 'not now', 'block', 'deny'];
        document.querySelectorAll('button, [role="button"]').forEach(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          if (dismiss.some(d => t === d || t.includes(d))) b.click();
        });

        // 2. Detect page state
        const body = document.body.innerText || '';
        const btns = [...document.querySelectorAll('button')];
        const btnTexts = btns.map(b => b.textContent.trim());

        if (document.querySelector('[aria-label*="Leave call"]') || document.querySelector('[aria-label="Call controls"]')) {
          R.state = 'already_in'; return JSON.stringify(R);
        }
        if (body.includes('This meeting has ended') || body.includes('会议已结束')) {
          R.state = 'ended'; return JSON.stringify(R);
        }
        if (body.includes('not allowed') || body.includes('Check your meeting code')) {
          R.state = 'error'; return JSON.stringify(R);
        }

        // 3. Handle "Switch here"
        const switchBtn = btns.find(b => ['Switch here', '切换到这里'].includes(b.textContent.trim()));
        if (switchBtn) { switchBtn.click(); R.state = 'switch_here'; return JSON.stringify(R); }

        // 4. Configure camera OFF
        ${muteCamera ? `
        const camOff = document.querySelector('[aria-label="Turn off camera"], [aria-label="关闭摄像头"]');
        if (camOff) { camOff.click(); R.config.push('cam:off'); }
        else R.config.push('cam:already_off');
        ` : `R.config.push('cam:skip');`}

        // 5. Configure mic
        ${muteMic ? `
        const micOff = document.querySelector('[aria-label="Turn off microphone"], [aria-label="关闭麦克风"]');
        if (micOff) { micOff.click(); R.config.push('mic:muted'); }
        ` : `
        const micOn = document.querySelector('[aria-label="Turn on microphone"], [aria-label="打开麦克风"]');
        if (micOn) { micOn.click(); R.config.push('mic:on'); }
        else R.config.push('mic:already_on');
        `}

        // 6. Set display name
        const nameInput = document.querySelector('input[aria-label="Your name"], input[placeholder*="name"]');
        if (nameInput && (!nameInput.value || nameInput.value === 'Guest')) {
          const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (s) { s.call(nameInput, ${JSON.stringify(displayName)}); nameInput.dispatchEvent(new Event('input', {bubbles:true})); R.config.push('name:set'); }
        }

        // 7. Check if join button exists (don't click yet — need to set devices first)
        const joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入'];
        for (const b of btns) {
          if (joinTargets.includes(b.textContent.trim())) { R.hasJoinBtn = true; break; }
        }

        R.state = R.hasJoinBtn ? 'ready_to_join' : (btnTexts.length > 0 ? 'no_join_button' : 'loading');
        return JSON.stringify(R);
      }`);

      let parsed: any;
      try { parsed = JSON.parse(configResult); } catch { parsed = { state: "parse_error" }; }
      log(`Result: state=${parsed.state} config=[${(parsed.config || []).join(',')}]`);

      // Handle terminal states
      if (parsed.state === "already_in") {
        return { success: true, summary: "Already in meeting", steps, state: "in_meeting" };
      }
      if (parsed.state === "ended") {
        return { success: false, summary: "Meeting has ended", steps, state: "failed" };
      }
      if (parsed.state === "error") {
        return { success: false, summary: "Cannot access meeting", steps, state: "failed" };
      }
      if (parsed.state === "switch_here") {
        // Switch here already clicked, go straight to verify
        log("Switched — skipping device selection");
      }

      // If page was loading, retry config once after short wait
      if (parsed.state === "loading" || parsed.state === "no_join_button") {
        log("Page still loading — retrying in 2s...");
        await this.wait(2000);
        const retry = await this.evaluate(`() => {
          const btns = [...document.querySelectorAll('button')];
          for (const b of btns) {
            if (['Join now','Ask to join','Join','加入会议','请求加入'].includes(b.textContent.trim())) return 'found';
          }
          return 'still_no_button';
        }`);
        log(`Retry: ${retry}`);
        if (retry.includes("still_no_button")) {
          return { success: false, summary: "Join button not found after retry", steps, state: "failed" };
        }
      }

      // ── Step 3: Set audio devices BEFORE joining (needs separate evals for dropdown interaction) ──
      if (parsed.state !== "switch_here") {
        await this.selectMeetDevice("microphone", micDevice, log);
        await this.selectMeetDevice("speaker", speakerDevice, log);
      }

      // ── Step 4: Click join button ──
      if (parsed.state !== "switch_here") {
        log("Clicking join...");
        const joinResult = await this.evaluate(`() => {
          const btns = [...document.querySelectorAll('button')];
          const joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入'];
          for (const b of btns) {
            const t = b.textContent.trim();
            if (joinTargets.includes(t)) {
              if (b.disabled) { b.disabled = false; b.removeAttribute('disabled'); }
              b.click();
              return 'joined:' + t;
            }
          }
          return 'no_join_button';
        }`);
        log(`Join: ${joinResult}`);
        if (joinResult.includes("no_join_button")) {
          return { success: false, summary: "Join button disappeared", steps, state: "failed" };
        }
      }

      // ── Step 4: Verify join state (poll up to 20s) ──
      log("Verifying join state...");
      await this.wait(2000);

      for (let attempt = 0; attempt < 6; attempt++) {
        const state = await this.evaluate(`() => {
          if (document.querySelector('[aria-label*="Leave call"]') || document.querySelector('[aria-label="Call controls"]')) return 'in_meeting';
          const t = document.body.innerText;
          if (t.includes('Waiting for the host') || t.includes('Someone will let you in') || t.includes('等待主持人')) return 'waiting_room';
          return 'loading';
        }`);

        if (state.includes("in_meeting")) {
          log("Joined!");

          // ── Post-join: ensure mic is unmuted (Meet may auto-mute on entry) ──
          if (!muteMic) {
            await this.wait(1500);
            const micState = await this.evaluate(`() => {
              const muteBtn = document.querySelector('[aria-label*="Turn on microphone"], [aria-label*="打开麦克风"]');
              if (muteBtn) { muteBtn.click(); return 'unmuted_after_join'; }
              const alreadyOn = document.querySelector('[aria-label*="Turn off microphone"], [aria-label*="关闭麦克风"]');
              if (alreadyOn) return 'already_on';
              return 'mic_button_not_found';
            }`);
            log(`Post-join mic: ${micState}`);
          }

          return { success: true, summary: "Joined meeting — camera off, mic on (BlackHole)", steps, state: "in_meeting" };
        }
        if (state.includes("waiting_room")) {
          log("In waiting room");
          return { success: false, summary: "In waiting room — waiting for host", steps, state: "waiting_room" };
        }
        if (attempt < 5) await this.wait(3000);
      }

      return { success: false, summary: "Could not confirm join state", steps, state: "failed" };

    } catch (err: any) {
      log(`Error: ${err.message}`);
      return { success: false, summary: `Error: ${err.message}`, steps, state: "failed" };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Meeting Attendee Admission Monitor
  // ══════════════════════════════════════════════════════════════

  private _admissionInterval: ReturnType<typeof setInterval> | null = null;
  private _admittedSet = new Set<string>();
  private _meetingEndCallback: (() => void) | null = null;

  /**
   * Start monitoring for attendee admission requests in Google Meet.
   *
   * Google Meet admission is a two-step flow:
   *   Step A: Green notification "Admit N guest(s)" → click to open People sidebar
   *   Step B: Click "Admit" / "Admit all" button in the sidebar
   *
   * SPEED OPTIMIZATION: Both steps are chained in a single cycle.
   * After Step A opens the sidebar, we wait 800ms then immediately run Step B
   * — no waiting for the next interval. Total admit latency: ~1.5s instead of ~8s.
   *
   * L1 (fast): Pure JS eval, no AI model needed. ~200ms per eval round-trip.
   * Fallback: If L1 fails 3 times, delegates to automation layer (Haiku/CU vision).
   *
   * @param attendeeNames - Expected attendees to auto-admit (empty = admit all)
   * @param intervalMs - Check interval (default 3000ms)
   * @param onFallback - Called when L1 fails and needs automation fallback
   */
  startAdmissionMonitor(
    attendeeNames: string[],
    intervalMs = 3000,
    onFallback?: (instruction: string) => Promise<void>,
  ): void {
    if (this._admissionInterval) this.stopAdmissionMonitor();
    this._admittedSet.clear();

    const admitAll = attendeeNames.length === 0;
    console.log(`[MeetAdmit] Monitoring (${intervalMs}ms)${admitAll ? " admit-all" : ` for ${attendeeNames.length}: ${attendeeNames.join(", ")}`}`);

    let consecutiveFailures = 0;

    this._admissionInterval = setInterval(async () => {
      try {
        // ── Check if meeting has ended (host ended, kicked, network drop) ──
        if (this._meetingEndCallback) {
          try {
            const ended = await this._checkMeetingEnded();
            if (ended) {
              console.log("[MeetAdmit] Meeting ended detected — triggering cleanup");
              const cb = this._meetingEndCallback;
              this._meetingEndCallback = null;
              this.stopAdmissionMonitor();
              cb();
              return;
            }
          } catch {}
        }

        // ── L1: Pure JS eval — no AI model, ~200ms round-trip ──
        const result = await this._admitEval();

        if (result.startsWith("admitted:")) {
          consecutiveFailures = 0;
          this._recordAdmitted(result.slice(9));
          // Handle "Admit all" confirmation dialog (async render)
          await this.wait(500);
          await this._dismissAdmitConfirmation();
          return;
        }

        if (result.startsWith("opened_")) {
          // Step A succeeded (panel/notification opened).
          // CHAIN: immediately run Step B after DOM renders.
          consecutiveFailures = 0;
          console.log(`[MeetAdmit] ${result} → chaining Step B...`);
          await this.wait(800);
          const step2 = await this._admitEval();
          if (step2.startsWith("admitted:")) {
            this._recordAdmitted(step2.slice(9));
            await this.wait(500);
            await this._dismissAdmitConfirmation();
          } else {
            // Sidebar opened but no Admit button yet — try once more
            await this.wait(600);
            const step3 = await this._admitEval();
            if (step3.startsWith("admitted:")) {
              this._recordAdmitted(step3.slice(9));
              await this.wait(500);
              await this._dismissAdmitConfirmation();
            } else {
              console.log(`[MeetAdmit] Panel open but Admit button not found after 2 retries`);
            }
          }
          return;
        }

        if (result === "has_notification_no_button") {
          consecutiveFailures++;
          console.log(`[MeetAdmit] Notification visible but no button (${consecutiveFailures}/3)`);
        } else {
          // "none" — no admission pending
          consecutiveFailures = 0;
        }

        // ── Fallback: If L1 fails 3 times, use automation layer ──
        if (consecutiveFailures >= 3 && onFallback) {
          consecutiveFailures = 0;
          console.log("[MeetAdmit] L1 failed 3x → automation fallback (Haiku/CU)...");
          const names = admitAll ? "all pending participants" : attendeeNames.join(", ");
          onFallback(
            `In Google Meet, someone is asking to join the meeting. ` +
            `Click the green admit notification or open the People panel, then click "Admit" to let in: ${names}`
          ).catch((e) => console.warn("[MeetAdmit] Fallback failed:", e.message));
        }
      } catch (e: any) {
        // Silently ignore — page might be transitioning
      }
    }, intervalMs);
  }

  /**
   * Single JS eval that handles both admission steps.
   * Returns: "admitted:<name>", "opened_admit_panel:<text>", "opened_view_all",
   *          "opened_people_panel", "has_notification_no_button", or "none".
   */
  private async _admitEval(): Promise<string> {
    return this.evaluate(`() => {
      const all = [...document.querySelectorAll('button, [role="button"], div[tabindex]')];

      // Step B: Individual "Admit" first (avoids "Admit all" confirmation dialog)
      const admit = all.find(b => {
        const t = (b.textContent || '').trim();
        return t === 'Admit' || t === '准许';
      });
      if (admit) { admit.click(); return 'admitted:' + admit.textContent.trim().substring(0, 60); }

      // Step B2: "Admit all" as fallback — confirmation dialog handled by _dismissAdmitConfirmation()
      const admitAll = all.find(b => {
        const t = (b.textContent || '').trim();
        return t === 'Admit all' || t === '全部准许';
      });
      if (admitAll) {
        admitAll.click();
        // Note: "Admit all" triggers an async confirmation dialog.
        // The caller (_dismissAdmitConfirmation) handles it with retries.
        return 'admitted:' + admitAll.textContent.trim().substring(0, 60);
      }

      // Step A: Green notification "Admit N guest(s)"
      const notif = all.find(b => {
        const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
        return t.includes('Admit') && t.includes('guest');
      });
      if (notif) { notif.click(); return 'opened_admit_panel:' + notif.textContent.trim().substring(0, 60); }

      // "View all" for multiple guests
      const viewAll = all.find(b => {
        const t = (b.textContent || '').trim();
        return t === 'View all' || t === '查看全部';
      });
      if (viewAll) { viewAll.click(); return 'opened_view_all'; }

      // Detect join notification → open People panel as last resort
      const body = document.body.innerText;
      const hasNotif = body.includes('wants to join') || body.includes('asking to join') ||
        body.includes('请求加入') || body.includes('想加入') || body.includes('Someone wants to join');
      if (hasNotif) {
        const peopleBtn = all.find(b => {
          const a = (b.getAttribute('aria-label') || '');
          return a === 'People' || a.includes('Show everyone') || a.includes('参与者');
        });
        if (peopleBtn) { peopleBtn.click(); return 'opened_people_panel'; }
        return 'has_notification_no_button';
      }

      return 'none';
    }`);
  }

  /**
   * Dismiss "Admit all" confirmation dialog if it appeared.
   * Google Meet renders a second "Admit all" or "Confirm" button ASYNCHRONOUSLY
   * after clicking the first one. We retry up to 3 times with increasing waits
   * to catch the async DOM render.
   */
  private async _dismissAdmitConfirmation(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.evaluate(`() => {
          // Look for dialog/overlay containers (confirmation renders inside these)
          const all = [...document.querySelectorAll('button, [role="button"], [role="dialog"] button, div[role="alertdialog"] button')];
          const confirmBtn = all.find(b => {
            const t = (b.textContent || '').trim();
            return t === 'Admit all' || t === '全部准许' || t === 'Confirm' || t === '确认' || t === 'OK' || t === '确定';
          });
          if (confirmBtn) { confirmBtn.click(); return 'confirmed'; }
          return 'no_dialog';
        }`);
        if (result.includes("confirmed")) {
          console.log(`[MeetAdmit] Confirmation dialog dismissed (attempt ${attempt + 1})`);
          return;
        }
      } catch {}
      // Increasing wait: 500ms, 800ms, 1200ms — gives DOM time to render
      await this.wait(500 + attempt * 300);
    }
  }

  /** Record admitted attendees */
  private _recordAdmitted(text: string) {
    const names = text.split(",").map(n => n.trim()).filter(Boolean);
    for (const name of names) {
      if (!this._admittedSet.has(name)) {
        this._admittedSet.add(name);
        console.log(`[MeetAdmit] ✅ Admitted: ${name}`);
      }
    }
  }

  /**
   * Stop the admission monitor.
   * @returns List of admitted attendee names.
   */
  stopAdmissionMonitor(): string[] {
    if (this._admissionInterval) {
      clearInterval(this._admissionInterval);
      this._admissionInterval = null;
    }
    // Always clear meeting-end callback to prevent standalone watcher from restarting
    this._meetingEndCallback = null;
    const admitted = [...this._admittedSet];
    console.log(`[MeetAdmit] Monitor stopped. Admitted ${admitted.length} attendees.`);
    return admitted;
  }

  get isAdmissionMonitoring(): boolean {
    return this._admissionInterval !== null;
  }

  /**
   * Register a callback to fire when the meeting ends (host ended, kicked, etc.).
   * Detection piggybacks on the admission monitor's 3s interval.
   * If no admission monitor is running, starts a standalone meeting-end watcher.
   */
  onMeetingEnd(callback: () => void): void {
    this._meetingEndCallback = callback;

    // If admission monitor isn't running, start a lightweight standalone watcher
    if (!this._admissionInterval) {
      console.log("[MeetEnd] Starting standalone meeting-end watcher (3s interval)");
      this._admissionInterval = setInterval(async () => {
        try {
          const ended = await this._checkMeetingEnded();
          if (ended) {
            console.log("[MeetEnd] Meeting ended detected — triggering cleanup");
            const cb = this._meetingEndCallback;
            this._meetingEndCallback = null;
            this.stopAdmissionMonitor();
            if (cb) cb();
          }
        } catch {}
      }, 3000);
    }
  }

  /**
   * Check if Google Meet page shows "meeting ended" state.
   * Uses pure DOM inspection — no screenshots, no AI model.
   * Detects: host ended meeting, removed, expired, navigated away.
   */
  private async _checkMeetingEnded(): Promise<boolean> {
    const result = await this.evaluate(`() => {
      // 1. Not on Meet anymore (navigated away / crashed)
      if (!location.hostname.includes('meet.google.com')) return 'ended';

      // 2. DOM signal: Leave call button missing = no longer in meeting
      const leaveBtn = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"], [aria-label*="離開通話"]');
      const callControls = document.querySelector('[aria-label="Call controls"], [aria-label="通话控件"]');

      // 3. Text-based signals (post-meeting screen)
      const text = document.body.innerText || '';
      const endedSignals = [
        'This meeting has ended', '会议已结束', '會議已結束',
        'You were removed from the meeting', '您已被移出会议',
        'Your meeting code has expired', '会议代码已过期',
        'Return to home screen', '返回主屏幕',
        'The meeting has ended for everyone', '所有人的会议已结束',
        'You left the meeting', '你已退出会议', '您已離開會議',
        'Rejoin', '重新加入',  // Post-meeting "Rejoin" button = meeting is over for us
      ];
      const hasEndedText = endedSignals.some(s => text.includes(s));
      if (hasEndedText) return 'ended';

      // 4. No call controls AND no video grid = definitely not in meeting
      const videoGrid = document.querySelector('[data-allocation-index], [data-requested-participant-id]');
      if (!leaveBtn && !callControls && !videoGrid) return 'ended';

      return 'active';
    }`);
    return result === "ended";
  }

  /** Clear the meeting-end callback without stopping the admission monitor */
  clearMeetingEndCallback(): void {
    this._meetingEndCallback = null;
  }

  /**
   * Select an audio device in Google Meet's pre-join device picker.
   *
   * Google Meet opens a SINGLE settings panel with 3 sections when you click
   * any device button. Each section is a separate <ul> with aria-label:
   *   - "Device selection for the microphone"
   *   - "Device selection for the speaker"
   *   - "Device selection for the camera"
   *
   * IMPORTANT: Must search ONLY within the correct section's <ul>,
   * otherwise `textContent.includes("BlackHole 16ch")` may match a device
   * in the wrong section (e.g. speaker instead of microphone).
   */
  private async selectMeetDevice(
    deviceType: "microphone" | "speaker" | "camera",
    targetName: string,
    log: (msg: string) => void,
  ): Promise<void> {
    const labelPrefix = deviceType === "microphone" ? "Microphone" : deviceType === "speaker" ? "Speaker" : "Camera";

    // Check if the correct device is already selected
    const currentDevice = await this.evaluate(`() => {
      const btn = document.querySelector('[aria-label^="${labelPrefix}:"], [aria-label^="${labelPrefix === "Microphone" ? "麦克风" : "扬声器"}:"]');
      return btn ? btn.getAttribute('aria-label') : 'not_found';
    }`);

    if (currentDevice.includes(targetName)) {
      log(`${labelPrefix}: already set to ${targetName}`);
      return;
    }

    if (currentDevice === "not_found") {
      log(`${labelPrefix}: device selector not found`);
      return;
    }

    // Click the device selector button to open the settings panel
    const clicked = await this.evaluate(`() => {
      const btn = document.querySelector('[aria-label^="${labelPrefix}:"], [aria-label^="${labelPrefix === "Microphone" ? "麦克风" : "扬声器"}:"]');
      if (btn) { btn.click(); return 'opened'; }
      return 'not_found';
    }`);

    if (!clicked.includes("opened")) {
      log(`${labelPrefix}: could not open device menu`);
      return;
    }

    await this.wait(500);

    // Find and click the target device WITHIN the correct section only.
    // Google Meet uses ul[aria-label="Device selection for the <type>"]
    const selected = await this.evaluate(`() => {
      // Step 1: Find the correct section by aria-label
      const sectionLabels = {
        microphone: ['Device selection for the microphone', '麦克风设备选择'],
        speaker: ['Device selection for the speaker', '扬声器设备选择'],
        camera: ['Device selection for the camera', '摄像头设备选择'],
      };
      const labels = sectionLabels[${JSON.stringify(deviceType)}] || [];
      let section = null;
      for (const label of labels) {
        section = document.querySelector('ul[aria-label="' + label + '"]');
        if (section) break;
      }

      // Step 2: Search within the section
      if (section) {
        const items = section.querySelectorAll('[role="menuitemradio"]');
        for (const item of items) {
          const text = (item.textContent || '').trim();
          if (text.includes(${JSON.stringify(targetName)})) {
            item.click();
            return 'selected: ' + text.substring(0, 60);
          }
        }
        return 'not_in_section (items: ' + items.length + ')';
      }

      // Fallback: section not found by aria-label, search all menuitemradio
      // but prefer exact device name match to avoid cross-section confusion
      const allItems = document.querySelectorAll('[role="menuitemradio"]');
      for (const item of allItems) {
        const text = (item.textContent || '').trim();
        // Exact start match: "BlackHole 16ch" must be at the beginning
        if (text.startsWith(${JSON.stringify(targetName)})) {
          item.click();
          return 'fallback_selected: ' + text.substring(0, 60);
        }
      }
      return 'target_not_found';
    }`);

    if (selected.includes("selected")) {
      log(`${labelPrefix}: ${selected}`);
    } else {
      log(`${labelPrefix}: ${targetName} not found — ${selected}`);
      await this.pressKey("Escape");
    }
    await this.wait(300);
  }

  /** Stop the browser session */
  stop() {
    this._explicitlyStopped = true; // Always set — prevents auto-start from run()

    // Stop admission monitor + meeting-end watcher (even if already disconnected)
    if (this._admissionInterval) {
      this.stopAdmissionMonitor();
    }
    this._meetingEndCallback = null;

    if (!this._connected) return; // Already disconnected — skip close command
    this._connected = false;
    const quotedCmd = CMD.includes(" ") ? `"${CMD}"` : CMD;
    const stopCmd = `${quotedCmd} -s=${SESSION} close`;
    Bun.$`${{ raw: stopCmd }}`.quiet().nothrow();
    console.log("[PlaywrightCLI] Stopped");
  }

  /**
   * Reset browser — kill all Chrome processes and restart Playwright CLI.
   * Used for self-recovery when the browser is stuck/unresponsive.
   * Returns true if restart succeeded.
   */
  async resetBrowser(): Promise<{ success: boolean; detail: string }> {
    console.log("[PlaywrightCLI] Resetting browser...");

    // Stop admission monitor + meeting-end watcher if running
    if (this._admissionInterval) {
      this.stopAdmissionMonitor();
    }
    this._meetingEndCallback = null;

    // 1. Close playwright-cli session gracefully
    try {
      this.stop();
    } catch {}

    // 2. Kill any lingering Chrome processes launched by playwright-cli
    try {
      await Bun.$`pkill -f "chrome.*--user-data-dir.*callingclaw"`.quiet().nothrow();
      await new Promise(r => setTimeout(r, 1000));
    } catch {}

    // 3. Restart
    try {
      await this.start();
      return { success: true, detail: "Browser reset and restarted" };
    } catch (e: any) {
      return { success: false, detail: `Reset failed: ${e.message}` };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Internal — CLI execution
  // ══════════════════════════════════════════════════════════════

  /** Build global flags for every CLI invocation */
  private get globalFlags(): string {
    // Config file with --use-fake-ui-for-media-stream for auto-allowing mic/camera
    const configPath = resolve(homedir(), ".callingclaw", "playwright-config.json");
    const flags = [
      `-s=${SESSION}`,
      "--persistent",
      `--profile=${this.shellQuote(this.profileDir)}`,
      "--browser=chrome",
    ];
    if (!this.headless) flags.push("--headed");
    if (existsSync(configPath)) flags.push(`--config=${this.shellQuote(configPath)}`);
    return flags.join(" ");
  }

  /** Run a playwright-cli command and return stdout */
  private async run(subcommand: string): Promise<string> {
    // Block auto-start if browser was explicitly stopped (e.g. after leaving meeting).
    // Only an explicit start() call clears this flag.
    if (this._explicitlyStopped && !this._connected) {
      throw new Error("Browser session was stopped. Call start() to reconnect.");
    }

    // Auto-start on first use — but ONLY for navigate/open commands.
    // eval commands should NOT trigger auto-start (avoids about:blank tab spam
    // from AdmissionMonitor polling when session is disconnected).
    if (!this._connected) {
      if (subcommand.startsWith("eval")) {
        throw new Error("Not connected — eval requires active session");
      }
      if (!subcommand.startsWith("open")) {
        console.log(`[PlaywrightCLI] Not connected — auto-starting for: ${subcommand.slice(0, 40)}`);
        await this.start();
      }
    }

    const quotedCmd = CMD.includes(" ") ? `"${CMD}"` : CMD;
    const fullCmd = `${quotedCmd} ${this.globalFlags} ${subcommand}`;

    try {
      const result = await Promise.race([
        Bun.$`${{ raw: fullCmd }}`.quiet().cwd(this.cwd).text(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout (${TIMEOUT_MS}ms): ${subcommand}`)), TIMEOUT_MS)
        ),
      ]);
      return result.trim();
    } catch (e: any) {
      if (e.message?.includes("ECONNREFUSED") || e.message?.includes("not running")) {
        this._connected = false;
      }
      throw new Error(`playwright-cli error: ${e.message}`);
    }
  }

  /** Extract the result value from playwright-cli eval output.
   * CLI output format:
   *   ### Result\n"some_value"\n### Ran Playwright code\n...
   * OR for objects:
   *   ### Result\n{ "key": "value" }\n### Ran Playwright code\n...
   */
  private extractEvalResult(raw: string): string {
    // Look for ### Result section
    const resultMatch = raw.match(/### Result\n([\s\S]*?)(?:\n###|$)/);
    if (resultMatch) {
      let value = resultMatch[1].trim();
      // Strip quotes from simple string results: "some_value" → some_value
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch {}
      }
      return value;
    }
    // No ### Result section — return raw
    return raw;
  }

  /** Extract accessibility tree from CLI output (reads .yml file reference) */
  private extractSnapshotContent(output: string): string {
    // Look for YAML file reference: [Snapshot](.playwright-cli/page-xxx.yml)
    const match = output.match(/\[Snapshot\]\(([^)]+\.yml)\)/);
    if (match) {
      const ymlPath = resolve(this.cwd, match[1]);
      try {
        return readFileSync(ymlPath, "utf-8").trim();
      } catch {
        // File not readable, return raw output
      }
    }
    // No file reference found — return raw output (may already contain inline tree)
    return output;
  }

  /** Low-level exec: runs playwright-cli without auto-start logic.
   *  Used by start() to probe/launch the session without triggering recursion. */
  private async _exec(subcommand: string): Promise<string> {
    const quotedCmd = CMD.includes(" ") ? `"${CMD}"` : CMD;
    const fullCmd = `${quotedCmd} ${this.globalFlags} ${subcommand}`;
    const result = await Promise.race([
      Bun.$`${{ raw: fullCmd }}`.quiet().cwd(this.cwd).text(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout (${TIMEOUT_MS}ms): ${subcommand}`)), TIMEOUT_MS)
      ),
    ]);
    return result.trim();
  }

  /** Working directory for resolving relative file paths from CLI output */
  private get cwd(): string {
    return resolve(import.meta.dir, "../..");
  }

  /** Shell-quote a string value */
  private shellQuote(s: string): string {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  /**
   * Ensure Chrome profile preferences for CallingClaw meeting audio:
   *
   * 1. Block notification prompts (can't be dismissed via playwright-cli)
   * 2. Microphone = ALLOW for meet.google.com (BlackHole 16ch → Meet mic input)
   * 3. Camera = BLOCK for meet.google.com (CallingClaw is audio-only, no camera)
   *
   * Audio device mapping (configured in joinGoogleMeet → selectMeetDevice):
   *   Mic:     BlackHole 16ch  (AI voice → Meet call)
   *   Speaker: BlackHole 2ch   (Meet call → AI hearing)
   */
  private ensureChromePreferences() {
    const prefsPath = resolve(this.profileDir, "Default", "Preferences");
    try {
      // Ensure Default directory exists
      mkdirSync(resolve(this.profileDir, "Default"), { recursive: true });

      let prefs: any = {};
      if (existsSync(prefsPath)) {
        prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
      }

      let changed = false;

      // ── 1. Block notification prompts ──
      if (!prefs.profile) prefs.profile = {};
      if (!prefs.profile.default_content_setting_values) prefs.profile.default_content_setting_values = {};

      if (prefs.profile.default_content_setting_values.notifications !== 2) {
        prefs.profile.default_content_setting_values.notifications = 2;
        changed = true;
      }

      // ── 2. Site-specific permissions for Meet ──
      // Chrome content_settings: setting 1 = Allow, 2 = Block
      if (!prefs.profile.content_settings) prefs.profile.content_settings = {};
      if (!prefs.profile.content_settings.exceptions) prefs.profile.content_settings.exceptions = {};

      const meetDomains = [
        "https://meet.google.com,*",
        "https://[*.]meet.google.com,*",
      ];

      const ts = String(Date.now());

      // Microphone = ALLOW (Meet needs mic access for BlackHole 16ch audio bridge)
      if (!prefs.profile.content_settings.exceptions.media_stream_mic) {
        prefs.profile.content_settings.exceptions.media_stream_mic = {};
      }
      for (const domain of meetDomains) {
        if (prefs.profile.content_settings.exceptions.media_stream_mic[domain]?.setting !== 1) {
          prefs.profile.content_settings.exceptions.media_stream_mic[domain] = {
            expiration: "0", last_modified: ts, model: 0, setting: 1,
          };
          changed = true;
        }
      }

      // Camera = BLOCK (CallingClaw is audio-only — no camera needed)
      if (!prefs.profile.content_settings.exceptions.media_stream_camera) {
        prefs.profile.content_settings.exceptions.media_stream_camera = {};
      }
      for (const domain of meetDomains) {
        if (prefs.profile.content_settings.exceptions.media_stream_camera[domain]?.setting !== 2) {
          prefs.profile.content_settings.exceptions.media_stream_camera[domain] = {
            expiration: "0", last_modified: ts, model: 0, setting: 2,
          };
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(prefsPath, JSON.stringify(prefs));
        console.log("[PlaywrightCLI] Chrome prefs: notifications=block, meet mic=allow, meet camera=block");
      }
    } catch (e: any) {
      console.warn(`[PlaywrightCLI] Could not set Chrome preferences: ${e.message}`);
    }
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
