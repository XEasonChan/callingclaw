// CallingClaw 2.0 — Module: NoShowDetector
// After CallingClaw joins a meeting, waits 5 minutes.
// If no user speech detected, notifies via OpenClaw and offers to reschedule.

import type { EventBus } from "./event-bus";
import type { SharedContext } from "./shared-context";
import type { OpenClawBridge } from "../openclaw_bridge";
import { detectLanguage } from "../prompt-constants";

const NO_SHOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class NoShowDetector {
  private eventBus: EventBus;
  private context: SharedContext;
  private openclawBridge: OpenClawBridge;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _meetingStartTs: number = 0;
  private _meetUrl: string = "";
  private _meetTopic: string = "";

  constructor(opts: {
    eventBus: EventBus;
    context: SharedContext;
    openclawBridge: OpenClawBridge;
  }) {
    this.eventBus = opts.eventBus;
    this.context = opts.context;
    this.openclawBridge = opts.openclawBridge;
  }

  /** Called when CallingClaw joins a meeting */
  activate(data: { url?: string; topic?: string }) {
    this.deactivate(); // clear any prior timer
    this._meetUrl = data.url || "";
    this._meetTopic = data.topic || "Meeting";
    this._meetingStartTs = Date.now();

    this._timer = setTimeout(() => this.checkNoShow(), NO_SHOW_TIMEOUT_MS);
    console.log(`[NoShow] Watching for user join — will check in 5 min (topic: ${this._meetTopic})`);
  }

  /** Called when the meeting ends */
  deactivate() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private async checkNoShow() {
    this._timer = null;

    // Check transcript for user speech after meeting start
    const recent = this.context.getRecentTranscript(50);
    const userSpoke = recent.some(
      (e) => e.role === "user" && e.ts > this._meetingStartTs
    );

    if (userSpoke) {
      console.log("[NoShow] User detected in meeting — all clear");
      return;
    }

    console.log("[NoShow] User not detected after 5 minutes");
    this.eventBus.emit("meeting.no_show", {
      meetUrl: this._meetUrl,
      topic: this._meetTopic,
      waitedMinutes: 5,
    });

    // Notify user via OpenClaw (language matches meeting topic)
    if (this.openclawBridge.connected) {
      const lang = detectLanguage(this._meetTopic);
      const msg = lang === "zh"
        ? `我已在会议「${this._meetTopic}」中等候5分钟了，您还没有加入。需要我先退出吗？您随时可以让我重新加入。`
        : lang === "ja"
        ? `会議「${this._meetTopic}」で5分間お待ちしていますが、まだ参加されていません。退出しましょうか？いつでも再参加できます。`
        : `I've been waiting in "${this._meetTopic}" for 5 minutes but you haven't joined yet. Should I leave? You can have me rejoin anytime.`;
      this.openclawBridge.sendTaskIsolated(
        `CallingClaw has been waiting in meeting "${this._meetTopic}" for 5 minutes ` +
        `but the user hasn't joined. Send this message to the user via Telegram:\n\n` +
        `"${msg}"\n\nReply "sent" when done.`
      ).catch((e: any) => {
        console.warn("[NoShow] Failed to notify user:", e.message);
      });
    }
  }
}
