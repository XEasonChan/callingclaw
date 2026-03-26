// CallingClaw 2.0 — Recall.ai Client (Meeting Bot Transport)
//
// REST API client for Recall.ai's managed meeting bot service.
// Creates cloud-hosted bots that join meetings, stream audio via Output Media,
// and deliver real-time transcripts + participant events via webhook.
//
// Architecture:
//   RecallClient
//     ├── createBot()    → POST /api/v1/bot (schedule bot to join meeting)
//     ├── getBot()       → GET  /api/v1/bot/:id (check status)
//     ├── deleteBot()    → DELETE /api/v1/bot/:id (remove bot from meeting)
//     ├── startOutput()  → POST /api/v1/bot/:id/output_media (start AI voice)
//     ├── stopOutput()   → DELETE /api/v1/bot/:id/output_media (stop AI voice)
//     └── handleWebhook()→ process Recall webhook events
//
// Data flow (Output Media):
//   Recall bot joins meeting → runs YOUR webpage in headless browser
//   → webpage connects to CallingClaw backend via Cloudflare Tunnel
//   → backend relays audio to/from Grok/OpenAI Realtime API
//   → webpage plays AI audio → Recall captures → meeting participants hear AI
//
// Webhook flow:
//   Recall → POST /api/recall/webhook → CallingClaw backend
//   Events: bot.joining_call, bot.in_call_recording, bot.call_ended, bot.fatal

import { CONFIG } from "./config";

// ── Types ──────────────────────────────────────────────────────────

export interface RecallBotConfig {
  meetingUrl: string;
  botName?: string;
  joinAt?: string;          // ISO 8601 — omit for immediate join
  outputMediaUrl?: string;  // URL to your Output Media webpage
}

export interface RecallBot {
  id: string;
  status: string;
  meetingUrl: string;
  createdAt: string;
}

export interface RecallWebhookEvent {
  event: string;
  data: {
    bot_id: string;
    code?: string;
    sub_code?: string;
    [key: string]: any;
  };
}

type BotStatusCallback = (botId: string, status: string, data?: any) => void;

// ── Client ─────────────────────────────────────────────────────────

export class RecallClient {
  private apiKey: string;
  private region: string;
  private baseUrl: string;
  private tunnelUrl: string;    // Cloudflare Tunnel URL for Output Media webpage
  private activeBots = new Map<string, RecallBot>();
  private onStatusChange: BotStatusCallback | null = null;

  constructor(opts?: { apiKey?: string; region?: string; tunnelUrl?: string }) {
    this.apiKey = opts?.apiKey || process.env.RECALL_API_KEY || "";
    this.region = opts?.region || process.env.RECALL_REGION || "us-west-2";
    this.baseUrl = `https://${this.region}.recall.ai/api/v1`;
    this.tunnelUrl = opts?.tunnelUrl || process.env.RECALL_TUNNEL_URL || "";
  }

  get configured(): boolean {
    return !!this.apiKey && !!this.tunnelUrl;
  }

  onBotStatusChange(cb: BotStatusCallback) {
    this.onStatusChange = cb;
  }

  // ── Bot Lifecycle ──────────────────────────────────────────────

  /** Create a bot and join a meeting */
  async createBot(config: RecallBotConfig): Promise<RecallBot> {
    const outputMediaUrl = config.outputMediaUrl || `${this.tunnelUrl}/voice-recall.html`;

    const body: any = {
      meeting_url: config.meetingUrl,
      bot_name: config.botName || "CallingClaw",
      output_media: {
        camera: {
          kind: "webpage",
          config: { url: outputMediaUrl },
        },
      },
      recording_config: {
        realtime_endpoints: [
          {
            type: "webhook",
            url: `${this.tunnelUrl}/api/recall/webhook`,
            events: ["transcript.data", "transcript.partial_data"],
          },
        ],
      },
    };

    if (config.joinAt) {
      body.join_at = config.joinAt;
    }

    const res = await this._fetch("/bot/", "POST", body);
    const bot: RecallBot = {
      id: res.id,
      status: "creating",
      meetingUrl: config.meetingUrl,
      createdAt: new Date().toISOString(),
    };

    this.activeBots.set(bot.id, bot);
    console.log(`[Recall] Bot created: ${bot.id} for ${config.meetingUrl}`);
    return bot;
  }

  /** Get current bot status */
  async getBot(botId: string): Promise<any> {
    return this._fetch(`/bot/${botId}/`, "GET");
  }

  /** Remove bot from meeting */
  async deleteBot(botId: string): Promise<void> {
    try {
      await this._fetch(`/bot/${botId}/`, "DELETE");
    } catch (e: any) {
      console.warn(`[Recall] Delete bot ${botId} failed:`, e.message);
    }
    this.activeBots.delete(botId);
    console.log(`[Recall] Bot deleted: ${botId}`);
  }

  /** Start Output Media (AI voice) — usually set at creation, but can start later */
  async startOutput(botId: string, pageUrl?: string): Promise<void> {
    const url = pageUrl || `${this.tunnelUrl}/voice-recall.html`;
    await this._fetch(`/bot/${botId}/output_media/`, "POST", {
      camera: {
        kind: "webpage",
        config: { url },
      },
    });
    console.log(`[Recall] Output Media started for bot ${botId}`);
  }

  /** Stop Output Media */
  async stopOutput(botId: string): Promise<void> {
    await this._fetch(`/bot/${botId}/output_media/`, "DELETE", { camera: true });
    console.log(`[Recall] Output Media stopped for bot ${botId}`);
  }

  // ── Webhook Handler ────────────────────────────────────────────

  /** Process incoming Recall webhook events */
  handleWebhook(event: RecallWebhookEvent): void {
    const botId = event.data?.bot_id;
    const eventType = event.event;

    console.log(`[Recall] Webhook: ${eventType} for bot ${botId}`);

    // Update local bot state
    const bot = botId ? this.activeBots.get(botId) : undefined;
    if (bot) {
      bot.status = eventType;
    }

    // Notify listener
    if (this.onStatusChange && botId) {
      this.onStatusChange(botId, eventType, event.data);
    }

    // Handle terminal states
    if (eventType === "bot.call_ended" || eventType === "bot.done") {
      if (botId) this.activeBots.delete(botId);
    }

    if (eventType === "bot.fatal") {
      console.error(`[Recall] Bot ${botId} fatal error:`, event.data.code, event.data.sub_code);
      if (botId) this.activeBots.delete(botId);
    }
  }

  // ── Status ─────────────────────────────────────────────────────

  getActiveBots(): RecallBot[] {
    return [...this.activeBots.values()];
  }

  getActiveBot(meetingUrl: string): RecallBot | undefined {
    for (const bot of this.activeBots.values()) {
      if (bot.meetingUrl === meetingUrl) return bot;
    }
    return undefined;
  }

  // ── HTTP Helper ────────────────────────────────────────────────

  private async _fetch(path: string, method: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Recall API ${method} ${path} failed: ${res.status} ${text}`);
    }

    if (method === "DELETE" && res.status === 204) return {};
    return res.json();
  }
}
