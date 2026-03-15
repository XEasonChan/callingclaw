// CallingClaw 2.0 — Module 1: Auth & API Key Management
// Handles: API key storage, validation, runtime config updates

import { CONFIG } from "../config";

const ENV_PATH = `${import.meta.dir}/../../.env`;

export interface AuthStatus {
  openai: { configured: boolean; masked: string };
  anthropic: { configured: boolean; masked: string };
  google: { configured: boolean };
}

export class AuthModule {
  /**
   * Get current auth status (keys masked)
   */
  getStatus(): AuthStatus {
    return {
      openai: {
        configured: !!CONFIG.openai.apiKey,
        masked: CONFIG.openai.apiKey
          ? `sk-...${CONFIG.openai.apiKey.slice(-4)}`
          : "",
      },
      anthropic: {
        configured: !!CONFIG.anthropic.apiKey,
        masked: CONFIG.anthropic.apiKey
          ? `sk-ant-...${CONFIG.anthropic.apiKey.slice(-4)}`
          : "",
      },
      google: {
        configured: !!(
          process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN
        ),
      },
    };
  }

  /**
   * Update API keys — writes to .env and updates runtime CONFIG
   */
  async setKeys(keys: Record<string, string>): Promise<void> {
    const envFile = Bun.file(ENV_PATH);
    let envContent = (await envFile.exists()) ? await envFile.text() : "";

    for (const [key, value] of Object.entries(keys)) {
      const envKey = key.toUpperCase();
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${envKey}=${value}`);
      } else {
        envContent += `\n${envKey}=${value}`;
      }

      // Update runtime config
      if (envKey === "OPENAI_API_KEY") CONFIG.openai.apiKey = value;
      if (envKey === "ANTHROPIC_API_KEY") CONFIG.anthropic.apiKey = value;
    }

    await Bun.write(ENV_PATH, envContent);
  }

  /**
   * Validate an OpenAI API key by making a simple models list request
   */
  async validateOpenAI(key?: string): Promise<boolean> {
    const apiKey = key || CONFIG.openai.apiKey;
    if (!apiKey) return false;

    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Validate an Anthropic API key
   */
  async validateAnthropic(key?: string): Promise<boolean> {
    const apiKey = key || CONFIG.anthropic.apiKey;
    if (!apiKey) return false;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // 200 or 400 (invalid request but auth passed) both mean key works
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
