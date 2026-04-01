/**
 * Recall.ai REST API wrapper for bot management.
 * Docs: https://docs.recall.ai/docs/stream-media
 */

export interface RecallBotConfig {
  meetUrl: string;
  clientPageUrl: string;   // Full URL with ?ws= param
  botName?: string;
}

export interface RecallBot {
  id: string;
  meeting_url: string;
  status_changes: Array<{ code: string; created_at: string }>;
}

export class RecallAPI {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://us-west-2.recall.ai/api/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createBot(config: RecallBotConfig): Promise<RecallBot> {
    const res = await fetch(`${this.baseUrl}/bot/`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        meeting_url: config.meetUrl,
        bot_name: config.botName || "CallingClaw",
        output_media: {
          camera: {
            kind: "webpage",
            config: { url: config.clientPageUrl },
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Recall API createBot failed (${res.status}): ${text}`);
    }

    return res.json();
  }

  async getBot(botId: string): Promise<RecallBot> {
    const res = await fetch(`${this.baseUrl}/bot/${botId}/`, {
      headers: { "Authorization": `Token ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Recall API getBot failed (${res.status})`);
    }

    return res.json();
  }

  async destroyBot(botId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/bot/${botId}/leave_call/`, {
      method: "POST",
      headers: { "Authorization": `Token ${this.apiKey}` },
    });

    // 404 = bot already gone, that's fine
    if (!res.ok && res.status !== 404) {
      throw new Error(`Recall API destroyBot failed (${res.status})`);
    }
  }
}
