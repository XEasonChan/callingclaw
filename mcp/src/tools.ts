/**
 * MCP Tool Definitions and Handlers for CallingClaw
 */

import { callingClaw } from "./callingclaw.js";
import type { VoiceProvider, PermissionPanel } from "./types.js";

/**
 * Tool definitions for the MCP server
 */
export const toolDefinitions = [
  {
    name: "join_meeting",
    description:
      "Join a video meeting (Google Meet or Zoom) as an AI assistant with real-time voice, screen sharing, and note-taking. CallingClaw uses OpenAI Realtime API for sub-second voice response — much faster than text-to-speech alternatives. This operation takes 30-60 seconds to complete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        meetUrl: {
          type: "string",
          description:
            "The meeting URL (Google Meet or Zoom link). Example: https://meet.google.com/abc-defg-hij",
        },
        botName: {
          type: "string",
          description:
            'Name for the AI bot in the meeting. Default is "CoCo".',
          default: "CoCo",
        },
        topic: {
          type: "string",
          description:
            "Optional meeting topic to prepare context before joining. The AI will be briefed on this topic.",
        },
      },
      required: ["meetUrl"],
    },
  },
  {
    name: "leave_meeting",
    description:
      "Leave the current meeting and generate an action items summary. Call this when the meeting is over or you need to disconnect.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "speak",
    description:
      "Say something in the meeting through the AI voice. The text is processed by OpenAI Realtime API and spoken naturally — not robotic TTS. Use for greetings, answers, or any verbal communication in the meeting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "The text to speak in the meeting. Will be converted to natural speech.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "present_url",
    description:
      "Share your screen in the meeting showing a specific URL. CallingClaw uses Playwright to load and interact with the page — you can navigate, click, and scroll real websites (not just static slides). Great for demos, presentations, or showing documentation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description:
            "The URL to present/share in the meeting. Example: https://example.com/slides",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_transcript",
    description:
      "Get the current meeting transcript. Returns all spoken text with speaker names and timestamps. Useful for understanding what has been discussed or searching for specific topics mentioned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        newOnly: {
          type: "boolean",
          description:
            "If true, only returns transcript entries since the last call. Default is false (returns full transcript).",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "inject_context",
    description:
      "Inject knowledge or context into the AI meeting assistant's memory without speaking it aloud. Use this to prepare the AI with relevant information before or during a meeting. The AI will use this context to provide better answers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "The context or knowledge to inject. This will not be spoken but will inform the AI's responses.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "send_chat_message",
    description:
      "Send a text message in the meeting chat. Useful for sharing URLs, code snippets, or text that's hard to speak. The message appears in the meeting's chat panel visible to all participants.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message to send in the meeting chat.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "get_status",
    description:
      "Check CallingClaw status — whether it's in a meeting, voice connection state, transcript length, and automation capabilities. Use this to verify CallingClaw is running and check the current state.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_action_items",
    description:
      "Extract action items from the current meeting transcript. Returns tasks, assignees, and due dates mentioned during the meeting. Useful for generating meeting summaries and follow-ups.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "set_voice_provider",
    description:
      'Change the voice AI provider. Options are "openai" (default, best latency), "grok", or "gemini". Use openai for best performance, especially in China where it works well.',
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "grok", "gemini"],
          description:
            'The voice AI provider to use. "openai" is recommended for best latency.',
        },
      },
      required: ["provider"],
    },
  },

  // ============================================
  // Onboarding & Setup Tools
  // ============================================

  {
    name: "check_health",
    description:
      "Check if CallingClaw Desktop is running and reachable. This should be the FIRST tool any agent calls. Returns version info if running, or installation instructions if not. Use this to verify CallingClaw is set up before attempting any meeting operations.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_api_keys",
    description:
      "Check which API keys are configured in CallingClaw (OpenAI, Google, etc.). Returns masked key status (configured/missing) and tells you exactly which keys are needed and where to get them. Use after check_health confirms CallingClaw is running.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "set_api_keys",
    description:
      "Set API keys for CallingClaw services. User provides keys through agent conversation, and this tool configures them. Supports OPENAI_API_KEY, GOOGLE_API_KEY, and other service keys.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keys: {
          type: "object",
          description:
            'Object mapping key names to values. Example: { "OPENAI_API_KEY": "sk-...", "GOOGLE_API_KEY": "..." }',
          additionalProperties: { type: "string" },
        },
      },
      required: ["keys"],
    },
  },
  {
    name: "check_google_auth",
    description:
      "Check Google Calendar OAuth and Chrome login status. Returns whether calendar is connected, Chrome is logged into Google, and the associated email. Required for joining Google Meet meetings.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "setup_google_oauth",
    description:
      'Multi-step Google OAuth setup. Actions: "scan" (look for existing credentials on disk), "apply" (apply found credentials), "set" (manually set OAuth credentials). Start with scan, then apply if found, otherwise guide user through manual setup.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["scan", "apply", "set"],
          description:
            '"scan" to look for existing credentials, "apply" to use found credentials, "set" to manually configure.',
        },
        credentials: {
          type: "object",
          description:
            'Required only for "set" action. OAuth credentials to configure.',
          properties: {
            clientId: { type: "string", description: "Google OAuth Client ID" },
            clientSecret: {
              type: "string",
              description: "Google OAuth Client Secret",
            },
            refreshToken: {
              type: "string",
              description: "OAuth refresh token (optional)",
            },
            accessToken: {
              type: "string",
              description: "OAuth access token (optional)",
            },
          },
        },
      },
      required: ["action"],
    },
  },
  {
    name: "google_chrome_login",
    description:
      'Start or check Google Chrome login. Actions: "start" (opens Chrome to Google sign-in page), "check" (verifies if login succeeded). For meeting join to work, Chrome needs to be logged into Google.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["start", "check"],
          description:
            '"start" to open Chrome for login, "check" to verify login status.',
        },
      },
      required: ["action"],
    },
  },
  {
    name: "get_config",
    description:
      "Get current CallingClaw configuration (non-secret settings). Returns voice provider, language, default bot name, and other preferences.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "set_config",
    description:
      "Update CallingClaw configuration settings. Can set voice provider, language, default bot name, auto-join preferences, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        config: {
          type: "object",
          description:
            "Configuration values to update. Supports voiceProvider, language, defaultBotName, autoJoinAudio, autoJoinVideo.",
          additionalProperties: true,
        },
      },
      required: ["config"],
    },
  },
  {
    name: "check_capabilities",
    description:
      "Check what CallingClaw can currently do. Returns available voice providers, supported meeting platforms (Meet, Zoom), automation layers (Playwright, shortcuts), and feature availability. Use to verify setup is complete.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_audio",
    description:
      "Audio pipeline diagnostic. Check if audio capture is working, list available input/output devices, and identify any audio issues. Use if voice isn't working in meetings.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_permissions",
    description:
      "Check macOS permission status for screen recording, microphone, accessibility, and camera. Returns whether each permission is granted and if it can be requested. Essential for diagnosing why CallingClaw can't join meetings or capture audio.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "open_permissions",
    description:
      "Open macOS System Settings to a specific permission panel. Use this to guide the user to grant required permissions (screenRecording, accessibility, microphone, camera).",
    inputSchema: {
      type: "object" as const,
      properties: {
        panel: {
          type: "string",
          enum: ["screenRecording", "accessibility", "microphone", "camera"],
          description:
            "Which permission panel to open in System Settings.",
        },
      },
      required: ["panel"],
    },
  },
  {
    name: "check_ready",
    description:
      "Check full readiness — all prerequisites in one call. This should be the FIRST tool any onboarding agent calls. Returns a checklist of all requirements (CallingClaw running, API keys, permissions, Google auth, etc.). If everything passes, skip the rest of onboarding.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_calendar_events",
    description:
      "List upcoming calendar events with meeting links. Most common first question: 'what meetings do I have today?' Returns event title, time, attendees, and Google Meet/Zoom links if present.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "schedule_auto_join",
    description:
      "Schedule CallingClaw to automatically join a future meeting, or check scheduler status. Use action 'schedule' to schedule a new auto-join, or 'status' to see scheduled meetings and next join time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["schedule", "status"],
          description:
            '"schedule" to schedule a new auto-join, "status" to get current scheduler status.',
        },
        meetUrl: {
          type: "string",
          description:
            "The meeting URL to auto-join (required for schedule action).",
        },
        scheduledTime: {
          type: "string",
          description:
            "ISO date string for when to join (optional, defaults to event start time).",
        },
        eventId: {
          type: "string",
          description:
            "Calendar event ID to link this scheduled join to (optional).",
        },
      },
      required: ["action"],
    },
  },
];

/**
 * Handle tool calls
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Tools that can check availability themselves (onboarding tools)
  const selfCheckTools = ["get_status", "check_health"];

  // First check if CallingClaw is available (except for self-check tools)
  if (!selfCheckTools.includes(name)) {
    const isAvailable = await callingClaw.isAvailable();
    if (!isAvailable) {
      return {
        content: [
          {
            type: "text",
            text: "❌ CallingClaw Desktop is not running or not reachable at localhost:4000.\n\nTo use CallingClaw MCP:\n1. Download CallingClaw Desktop from https://callingclaw.com\n2. Launch the application\n3. Ensure it's running on localhost:4000\n4. Try this command again\n\nTip: Use check_health as the first step to verify CallingClaw is running.",
          },
        ],
      };
    }
  }

  try {
    switch (name) {
      case "join_meeting": {
        const meetUrl = args.meetUrl as string;
        const botName = (args.botName as string) || "CoCo";
        const topic = args.topic as string | undefined;

        callingClaw.resetTranscriptOffset();

        const result = await callingClaw.joinMeeting({
          meetUrl,
          botName,
          topic,
        });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `✅ Successfully joined the meeting as "${botName}".\n\nMeeting URL: ${meetUrl}${topic ? `\nTopic: ${topic}` : ""}\n\nThe AI assistant is now active with real-time voice capabilities. Use 'speak' to say something, 'inject_context' to add knowledge, or 'get_transcript' to see what's been said.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to join meeting: ${result.error || "Unknown error"}\n\nPlease check:\n- The meeting URL is valid\n- The meeting has started\n- CallingClaw has necessary permissions`,
              },
            ],
          };
        }
      }

      case "leave_meeting": {
        const result = await callingClaw.leaveMeeting();

        if (result.success) {
          let response = "✅ Left the meeting successfully.";

          if (result.actionItems && result.actionItems.length > 0) {
            response += "\n\n📋 Action Items:\n";
            result.actionItems.forEach((item, i) => {
              response += `${i + 1}. ${item.task}`;
              if (item.assignee) response += ` (${item.assignee})`;
              response += "\n";
            });
          }

          return { content: [{ type: "text", text: response }] };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to leave meeting: ${result.error || "Unknown error"}`,
              },
            ],
          };
        }
      }

      case "speak": {
        const text = args.text as string;
        const result = await callingClaw.speak(text);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `🎤 Speaking: "${text}"`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "❌ Failed to speak. Is there an active meeting with voice enabled?",
              },
            ],
          };
        }
      }

      case "present_url": {
        const url = args.url as string;
        const result = await callingClaw.shareScreen({ url });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `🖥️ Now presenting: ${url}\n\nThe screen is being shared with meeting participants. You can use this tool again with a different URL to navigate, or use automation commands to interact with the page.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to present URL: ${url}\n\nPlease check that the URL is accessible and try again.`,
              },
            ],
          };
        }
      }

      case "get_transcript": {
        const newOnly = args.newOnly as boolean;
        const transcript = newOnly
          ? await callingClaw.getNewTranscriptEntries()
          : await callingClaw.getTranscript();

        if (transcript.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: newOnly
                  ? "No new transcript entries since last check."
                  : "📝 Transcript is empty. No one has spoken yet.",
              },
            ],
          };
        }

        let response = `📝 Transcript${newOnly ? " (new entries)" : ""} (${transcript.length} entries):\n\n`;
        transcript.forEach((entry) => {
          const time = entry.timestamp || "";
          response += `[${time}] ${entry.speaker}: ${entry.text}\n`;
        });

        return { content: [{ type: "text", text: response }] };
      }

      case "inject_context": {
        const text = args.text as string;
        const result = await callingClaw.injectContext(text);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `🧠 Context injected successfully.\n\nThe AI now knows: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "❌ Failed to inject context. Is there an active voice session?",
              },
            ],
          };
        }
      }

      case "send_chat_message": {
        const message = args.message as string;
        const result = await callingClaw.sendChatMessage(message);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `💬 Chat message sent: "${message}"`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "❌ Failed to send chat message. Is there an active meeting?",
              },
            ],
          };
        }
      }

      case "get_status": {
        try {
          const status = await callingClaw.getStatus();

          let response = "📊 CallingClaw Status:\n\n";
          response += `Meeting: ${status.meeting || "Not in a meeting"}\n`;

          if (status.voiceSession) {
            response += `Voice Session:\n`;
            response += `  - Connected: ${status.voiceSession.connected ? "Yes" : "No"}\n`;
            response += `  - Active: ${status.voiceSession.active ? "Yes" : "No"}\n`;
            response += `  - Transport: ${status.voiceSession.transport}\n`;
            if (status.voiceSession.topic) {
              response += `  - Topic: ${status.voiceSession.topic}\n`;
            }
          } else {
            response += "Voice Session: Not active\n";
          }

          response += `Transcript Length: ${status.transcriptLength} entries\n`;

          if (status.automation) {
            response += `Automation:\n`;
            if (status.automation.playwright) {
              response += `  - Playwright: ${status.automation.playwright.enabled ? "Enabled" : "Disabled"}\n`;
            }
            if (status.automation.shortcuts) {
              response += `  - Shortcuts: ${status.automation.shortcuts.enabled ? "Enabled" : "Disabled"}\n`;
            }
          }

          return { content: [{ type: "text", text: response }] };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "❌ CallingClaw Desktop is not running or not reachable at localhost:4000.\n\nTo use CallingClaw MCP:\n1. Download CallingClaw Desktop from https://callingclaw.com\n2. Launch the application\n3. Ensure it's running on localhost:4000\n4. Try this command again",
              },
            ],
          };
        }
      }

      case "get_action_items": {
        const actionItems = await callingClaw.getActionItems();

        if (actionItems.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "📋 No action items found in the transcript yet.\n\nAction items are extracted when participants mention tasks, todos, follow-ups, or assignments during the meeting.",
              },
            ],
          };
        }

        let response = `📋 Action Items (${actionItems.length}):\n\n`;
        actionItems.forEach((item, i) => {
          response += `${i + 1}. ${item.task}`;
          if (item.assignee) response += ` — Assigned to: ${item.assignee}`;
          if (item.dueDate) response += ` — Due: ${item.dueDate}`;
          if (item.priority) response += ` — Priority: ${item.priority}`;
          response += "\n";
        });

        return { content: [{ type: "text", text: response }] };
      }

      case "set_voice_provider": {
        const provider = args.provider as VoiceProvider;
        const result = await callingClaw.setVoiceProvider(provider);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `🎙️ Voice provider changed to: ${provider}\n\n${provider === "openai" ? "OpenAI Realtime API provides the best latency and works well globally." : `${provider} is now active.`}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to change voice provider to ${provider}.`,
              },
            ],
          };
        }
      }

      // ============================================
      // Onboarding & Setup Tool Handlers
      // ============================================

      case "check_health": {
        const health = await callingClaw.checkHealth();

        if (health.running) {
          let response = "✅ CallingClaw Desktop is running!\n\n";
          if (health.version) {
            response += `Version: ${health.version}\n`;
          }
          response +=
            "\nNext steps:\n1. Run check_api_keys to verify API keys are configured\n2. Run check_google_auth to verify Google OAuth status";
          return { content: [{ type: "text", text: response }] };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ CallingClaw Desktop is not running.\n\nTo get started:\n1. Download CallingClaw Desktop from https://callingclaw.com\n2. Install and launch the application\n3. Ensure it's running on localhost:4000\n4. Run check_health again to verify`,
              },
            ],
          };
        }
      }

      case "check_api_keys": {
        const keysResponse = await callingClaw.checkApiKeys();

        let response = "🔑 API Keys Status:\n\n";
        const missing: string[] = [];
        const configured: string[] = [];

        for (const key of keysResponse.keys) {
          const status = key.configured ? "✅" : "❌";
          response += `${status} ${key.name}`;
          if (key.configured && key.masked) {
            response += ` (${key.masked})`;
          }
          response += "\n";
          if (key.description) {
            response += `   ${key.description}\n`;
          }
          if (!key.configured && key.url) {
            response += `   Get it here: ${key.url}\n`;
          }
          response += "\n";

          if (key.configured) {
            configured.push(key.name);
          } else if (key.required) {
            missing.push(key.name);
          }
        }

        if (missing.length > 0) {
          response += `\n⚠️ Missing required keys: ${missing.join(", ")}\nUse set_api_keys to configure them.`;
        } else if (configured.length > 0) {
          response +=
            "\n✅ All required API keys are configured!\nNext: Run check_google_auth to verify Google OAuth status.";
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "set_api_keys": {
        const keys = args.keys as Record<string, string>;
        const result = await callingClaw.setApiKeys({ keys });

        if (result.success) {
          const keyNames = Object.keys(keys).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `✅ API keys configured: ${keyNames}\n\n${result.message || "Keys have been saved."}\n\nNext: Run check_api_keys to verify, then check_google_auth for Google OAuth.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to set API keys: ${result.message || "Unknown error"}`,
              },
            ],
          };
        }
      }

      case "check_google_auth": {
        const authStatus = await callingClaw.checkGoogleAuth();

        let response = "🔐 Google Auth Status:\n\n";
        response += `Calendar Connected: ${authStatus.calendarConnected ? "✅ Yes" : "❌ No"}\n`;
        response += `Chrome Logged In: ${authStatus.chromeLoggedIn ? "✅ Yes" : "❌ No"}\n`;
        if (authStatus.email) {
          response += `Email: ${authStatus.email}\n`;
        }
        if (authStatus.scopes && authStatus.scopes.length > 0) {
          response += `Scopes: ${authStatus.scopes.join(", ")}\n`;
        }

        if (!authStatus.calendarConnected) {
          response +=
            '\n⚠️ Google Calendar is not connected.\nRun setup_google_oauth with action "scan" to look for existing credentials.';
        }
        if (!authStatus.chromeLoggedIn) {
          response +=
            '\n⚠️ Chrome is not logged into Google.\nRun google_chrome_login with action "start" to sign in.';
        }
        if (authStatus.calendarConnected && authStatus.chromeLoggedIn) {
          response +=
            "\n✅ Google auth is fully configured! Ready to join meetings.";
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "setup_google_oauth": {
        const action = args.action as "scan" | "apply" | "set";

        if (action === "scan") {
          const scanResult = await callingClaw.scanGoogleCredentials();

          if (scanResult.found) {
            let response =
              "🔍 Found existing Google OAuth credentials!\n\n";
            if (scanResult.paths) {
              response += `Locations:\n${scanResult.paths.map((p) => `  - ${p}`).join("\n")}\n\n`;
            }
            if (scanResult.credentials?.clientId) {
              response += `Client ID: ${scanResult.credentials.clientId.substring(0, 20)}...\n`;
              response += `Has Refresh Token: ${scanResult.credentials.hasRefreshToken ? "Yes" : "No"}\n\n`;
            }
            response +=
              'Run setup_google_oauth with action "apply" to use these credentials.';
            return { content: [{ type: "text", text: response }] };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: '❌ No existing Google OAuth credentials found.\n\nOptions:\n1. Use setup_google_oauth with action "set" to manually configure OAuth credentials\n2. Create a Google Cloud project and OAuth client:\n   - Go to https://console.cloud.google.com/apis/credentials\n   - Create OAuth 2.0 Client ID\n   - Download credentials and provide client_id and client_secret',
                },
              ],
            };
          }
        } else if (action === "apply") {
          const applyResult = await callingClaw.applyGoogleCredentials();

          if (applyResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ Google credentials applied successfully!\n\n${applyResult.message || ""}\n\nNext: Run google_chrome_login to sign into Chrome.`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `❌ Failed to apply credentials: ${applyResult.message || "Unknown error"}\n\nTry setup_google_oauth with action "set" to manually configure.`,
                },
              ],
            };
          }
        } else if (action === "set") {
          const credentials = args.credentials as {
            clientId: string;
            clientSecret: string;
            refreshToken?: string;
            accessToken?: string;
          };

          if (!credentials?.clientId || !credentials?.clientSecret) {
            return {
              content: [
                {
                  type: "text",
                  text: '❌ Missing required credentials.\n\nFor "set" action, provide credentials with clientId and clientSecret:\n{\n  "action": "set",\n  "credentials": {\n    "clientId": "your-client-id.apps.googleusercontent.com",\n    "clientSecret": "your-secret"\n  }\n}',
                },
              ],
            };
          }

          const setResult = await callingClaw.setGoogleCredentials(credentials);

          if (setResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ Google OAuth credentials configured!\n\n${setResult.message || ""}\n\nNext: Run google_chrome_login to sign into Chrome.`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `❌ Failed to set credentials: ${setResult.message || "Unknown error"}`,
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: '❌ Invalid action. Use "scan", "apply", or "set".',
            },
          ],
        };
      }

      case "google_chrome_login": {
        const action = args.action as "start" | "check";

        if (action === "start") {
          const startResult = await callingClaw.startChromeLogin();

          if (startResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `🌐 Chrome opened for Google sign-in!\n\n${startResult.message || "Please sign into your Google account in the Chrome window."}\n\nAfter signing in, run google_chrome_login with action "check" to verify.`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `❌ Failed to open Chrome: ${startResult.message || "Unknown error"}`,
                },
              ],
            };
          }
        } else if (action === "check") {
          const checkResult = await callingClaw.checkChromeLogin();

          if (checkResult.success) {
            let response = "✅ Chrome login successful!\n\n";
            if (checkResult.email) {
              response += `Logged in as: ${checkResult.email}\n`;
            }
            response +=
              "\nGoogle Chrome is now authenticated. Ready to join meetings!\nRun check_capabilities to verify all systems are ready.";
            return { content: [{ type: "text", text: response }] };
          } else if (checkResult.inProgress) {
            return {
              content: [
                {
                  type: "text",
                  text: "⏳ Login is still in progress.\n\nPlease complete the sign-in in Chrome, then run google_chrome_login with action \"check\" again.",
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: '❌ Chrome login not detected.\n\nPlease ensure you:\n1. Signed into Google in the Chrome window\n2. Allowed all necessary permissions\n\nRun google_chrome_login with action "start" to try again.',
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: '❌ Invalid action. Use "start" or "check".',
            },
          ],
        };
      }

      case "get_config": {
        const config = await callingClaw.getConfig();

        let response = "⚙️ CallingClaw Configuration:\n\n";
        for (const [key, value] of Object.entries(config)) {
          response += `${key}: ${JSON.stringify(value)}\n`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "set_config": {
        const config = args.config as Record<string, unknown>;
        const result = await callingClaw.setConfig(config);

        if (result.success) {
          const changes = Object.keys(config).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `✅ Configuration updated: ${changes}\n\n${result.message || "Changes have been saved."}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to update configuration: ${result.message || "Unknown error"}`,
              },
            ],
          };
        }
      }

      case "check_capabilities": {
        const caps = await callingClaw.checkCapabilities();

        let response = "🎯 CallingClaw Capabilities:\n\n";

        response += "Voice Providers:\n";
        for (const provider of caps.voiceProviders) {
          response += `  ✅ ${provider}\n`;
        }

        response += "\nMeeting Platforms:\n";
        for (const platform of caps.meetingPlatforms) {
          response += `  ✅ ${platform}\n`;
        }

        response += "\nAutomation Layers:\n";
        for (const layer of caps.automationLayers) {
          const status = layer.available ? "✅" : "❌";
          response += `  ${status} ${layer.name}: ${layer.description}\n`;
        }

        response += "\nFeatures:\n";
        const allFeaturesAvailable = caps.features.every((f) => f.available);
        for (const feature of caps.features) {
          const status = feature.available ? "✅" : "❌";
          response += `  ${status} ${feature.name}\n`;
        }

        if (allFeaturesAvailable) {
          response +=
            "\n🎉 All systems ready! CallingClaw is fully configured and ready to join meetings.";
        } else {
          response +=
            "\n⚠️ Some features are unavailable. Check the items marked with ❌ above.";
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "check_audio": {
        const audioStatus = await callingClaw.checkAudio();

        let response = "🔊 Audio Status:\n\n";
        response += `Audio Working: ${audioStatus.working ? "✅ Yes" : "❌ No"}\n\n`;

        if (audioStatus.error) {
          response += `Error: ${audioStatus.error}\n\n`;
        }

        response += "Input Devices:\n";
        for (const device of audioStatus.inputDevices) {
          const marker = device.isDefault ? " (default)" : "";
          const selected =
            device.id === audioStatus.selectedInput ? " ← selected" : "";
          response += `  - ${device.name}${marker}${selected}\n`;
        }

        response += "\nOutput Devices:\n";
        for (const device of audioStatus.outputDevices) {
          const marker = device.isDefault ? " (default)" : "";
          const selected =
            device.id === audioStatus.selectedOutput ? " ← selected" : "";
          response += `  - ${device.name}${marker}${selected}\n`;
        }

        if (!audioStatus.working) {
          response +=
            "\n⚠️ Audio is not working. Please check:\n1. Microphone permissions are granted\n2. An input device is connected\n3. Audio drivers are properly installed";
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "check_permissions": {
        const permissions = await callingClaw.checkPermissions();

        let response = "🔐 macOS Permissions:\n\n";
        const permissionItems = [
          { key: "screenRecording", label: "Screen Recording", data: permissions.screenRecording },
          { key: "microphone", label: "Microphone", data: permissions.microphone },
          { key: "accessibility", label: "Accessibility", data: permissions.accessibility },
          { key: "camera", label: "Camera", data: permissions.camera },
        ];

        const missing: string[] = [];
        for (const item of permissionItems) {
          const status = item.data.granted ? "✅" : "❌";
          response += `${status} ${item.label}`;
          if (!item.data.granted) {
            response += item.data.canRequest ? " (can request)" : " (must grant in System Settings)";
            missing.push(item.key);
          }
          response += "\n";
        }

        if (missing.length > 0) {
          response += `\n⚠️ Missing permissions: ${missing.join(", ")}\nUse open_permissions to open System Settings.`;
        } else {
          response += "\n✅ All permissions granted!";
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "open_permissions": {
        const panel = args.panel as PermissionPanel;
        const result = await callingClaw.openPermissions({ panel });

        if (result.success) {
          const panelNames: Record<PermissionPanel, string> = {
            screenRecording: "Screen Recording",
            accessibility: "Accessibility",
            microphone: "Microphone",
            camera: "Camera",
          };
          return {
            content: [
              {
                type: "text",
                text: `🔧 Opened System Settings → ${panelNames[panel]}\n\n${result.message || "Please grant the permission and return here."}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to open System Settings: ${result.message || "Unknown error"}`,
              },
            ],
          };
        }
      }

      case "check_ready": {
        const readiness = await callingClaw.checkReady();

        let response = readiness.ready
          ? "✅ CallingClaw is fully ready!\n\n"
          : "⚠️ CallingClaw is not fully ready.\n\n";

        response += "Readiness Checklist:\n";
        for (const check of readiness.checks) {
          const status = check.passed ? "✅" : "❌";
          response += `${status} ${check.name}`;
          if (check.message) {
            response += ` — ${check.message}`;
          }
          response += "\n";
        }

        if (readiness.ready) {
          response += "\n🎉 All checks passed! Ready to join meetings.\nTry: list_calendar_events to see upcoming meetings.";
        } else {
          const failed = readiness.checks.filter((c) => !c.passed);
          response += `\n⚠️ ${failed.length} check(s) failed. Fix the items above to complete setup.`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "list_calendar_events": {
        const eventsResponse = await callingClaw.listCalendarEvents();

        if (eventsResponse.events.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "📅 No upcoming calendar events found.\n\nMake sure Google Calendar is connected (check_google_auth).",
              },
            ],
          };
        }

        let response = `📅 Upcoming Events (${eventsResponse.events.length}):\n\n`;
        for (const event of eventsResponse.events) {
          const start = new Date(event.start);
          const timeStr = start.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          response += `• ${event.title}\n`;
          response += `  📆 ${timeStr}\n`;
          if (event.meetUrl) {
            response += `  🔗 ${event.meetUrl}\n`;
          }
          if (event.attendees && event.attendees.length > 0) {
            response += `  👥 ${event.attendees.slice(0, 3).join(", ")}${event.attendees.length > 3 ? ` +${event.attendees.length - 3} more` : ""}\n`;
          }
          response += "\n";
        }

        response += "Use schedule_auto_join to schedule CallingClaw for any meeting.";
        return { content: [{ type: "text", text: response }] };
      }

      case "schedule_auto_join": {
        const action = args.action as "schedule" | "status";

        if (action === "status") {
          const status = await callingClaw.getSchedulerStatus();

          let response = "📋 Scheduler Status:\n\n";

          if (status.nextJoin) {
            const nextTime = new Date(status.nextJoin.scheduledTime);
            response += `⏰ Next Auto-Join:\n`;
            response += `  ${status.nextJoin.meetUrl}\n`;
            response += `  ${nextTime.toLocaleString()}\n\n`;
          } else {
            response += "No upcoming auto-joins scheduled.\n\n";
          }

          if (status.scheduled.length > 0) {
            response += `Scheduled Meetings (${status.scheduled.length}):\n`;
            for (const meeting of status.scheduled) {
              const time = new Date(meeting.scheduledTime);
              const statusIcon =
                meeting.status === "pending" ? "⏳" :
                meeting.status === "joined" ? "✅" :
                meeting.status === "missed" ? "❌" : "🚫";
              response += `${statusIcon} ${time.toLocaleString()} — ${meeting.meetUrl}\n`;
            }
          } else {
            response += "No meetings in schedule.";
          }

          return { content: [{ type: "text", text: response }] };
        } else if (action === "schedule") {
          const meetUrl = args.meetUrl as string | undefined;

          if (!meetUrl) {
            return {
              content: [
                {
                  type: "text",
                  text: '❌ Missing meetUrl. For "schedule" action, provide the meeting URL to join.',
                },
              ],
            };
          }

          const result = await callingClaw.scheduleAutoJoin({
            meetUrl,
            scheduledTime: args.scheduledTime as string | undefined,
            eventId: args.eventId as string | undefined,
          });

          if (result.success) {
            let response = `✅ Auto-join scheduled!\n\n`;
            response += `Meeting: ${meetUrl}\n`;
            if (args.scheduledTime) {
              response += `Time: ${new Date(args.scheduledTime as string).toLocaleString()}\n`;
            }
            if (result.id) {
              response += `Schedule ID: ${result.id}\n`;
            }
            response += `\n${result.message || "CallingClaw will automatically join at the scheduled time."}`;
            return { content: [{ type: "text", text: response }] };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `❌ Failed to schedule auto-join: ${result.message || "Unknown error"}`,
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: '❌ Invalid action. Use "schedule" or "status".',
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      content: [
        {
          type: "text",
          text: `❌ Error executing ${name}: ${errorMessage}`,
        },
      ],
    };
  }
}
