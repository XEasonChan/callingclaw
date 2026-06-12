/**
 * Comprehensive Unit Tests for CallingClaw MCP Tools
 *
 * Tests all 30 tools with mocked API client.
 * Uses Node's built-in test runner (node:test + node:assert).
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { CallingClawClient } from "../callingclaw.js";
import { handleToolCall, toolDefinitions } from "../tools.js";

// ============================================
// Mock Setup
// ============================================

/**
 * Creates a mock CallingClawClient with all methods stubbed
 */
function createMockClient(): CallingClawClient & { _mocks: Record<string, ReturnType<typeof mock.fn>> } {
  const client = new CallingClawClient("http://localhost:4000");
  const mocks: Record<string, ReturnType<typeof mock.fn>> = {};

  // List of all methods to mock
  const methodsToMock = [
    "isAvailable",
    "getStatus",
    "joinMeeting",
    "leaveMeeting",
    "prepareMeeting",
    "speak",
    "injectContext",
    "shareScreen",
    "runAutomation",
    "getTranscript",
    "getNewTranscriptEntries",
    "resetTranscriptOffset",
    "sendChatMessage",
    "getActionItems",
    "setVoiceProvider",
    "checkHealth",
    "checkApiKeys",
    "setApiKeys",
    "checkGoogleAuth",
    "scanGoogleCredentials",
    "applyGoogleCredentials",
    "setGoogleCredentials",
    "startChromeLogin",
    "checkChromeLogin",
    "getConfig",
    "setConfig",
    "getUserEmail",
    "setUserEmail",
    "getSearchPaths",
    "setSearchPaths",
    "checkCapabilities",
    "checkAudio",
    "checkPermissions",
    "openPermissions",
    "checkReady",
    "listCalendarEvents",
    "scheduleAutoJoin",
    "getSchedulerStatus",
    // New v1.1.0 methods
    "validateMeetingUrl",
    "getMeetingSummary",
    "startLocalVoice",
    "stopLocalVoice",
    "listPrompts",
    "updatePrompt",
    "resetPrompt",
    "getRecoveryHealth",
    "recoverBrowser",
    "recoverVoice",
  ];

  for (const method of methodsToMock) {
    mocks[method] = mock.fn();
    (client as unknown as Record<string, unknown>)[method] = mocks[method];
  }

  return Object.assign(client, { _mocks: mocks });
}

// Store original module and mock client
let mockClient: ReturnType<typeof createMockClient>;

// ============================================
// Test Helpers
// ============================================

/**
 * Replace the callingClaw singleton with our mock
 */
async function setupMock() {
  mockClient = createMockClient();

  // Mock isAvailable to return true by default (CallingClaw running)
  mockClient._mocks.isAvailable.mock.mockImplementation(() => Promise.resolve(true));

  // Dynamically replace the module export
  const toolsModule = await import("../tools.js");
  const callingClawModule = await import("../callingclaw.js");

  // Replace the singleton with our mock
  Object.assign(callingClawModule.callingClaw, mockClient);

  return { toolsModule, mockClient };
}

/**
 * Assert tool call returns expected content structure
 */
function assertToolResult(
  result: { content: Array<{ type: string; text: string }> },
  expectedTextPattern?: RegExp | string
) {
  assert.ok(result.content, "Result should have content");
  assert.ok(Array.isArray(result.content), "Content should be an array");
  assert.ok(result.content.length > 0, "Content should not be empty");
  assert.strictEqual(result.content[0].type, "text", "Content type should be text");

  if (expectedTextPattern) {
    if (typeof expectedTextPattern === "string") {
      assert.ok(
        result.content[0].text.includes(expectedTextPattern),
        `Expected text to include "${expectedTextPattern}", got: ${result.content[0].text}`
      );
    } else {
      assert.match(result.content[0].text, expectedTextPattern);
    }
  }
}

// ============================================
// Tool Definition Tests
// ============================================

describe("Tool Definitions", () => {
  it("should have 30 tools defined", () => {
    assert.strictEqual(toolDefinitions.length, 30);
  });

  it("should have unique tool names", () => {
    const names = toolDefinitions.map((t) => t.name);
    const uniqueNames = new Set(names);
    assert.strictEqual(names.length, uniqueNames.size, "Tool names should be unique");
  });

  it("should have valid input schemas", () => {
    for (const tool of toolDefinitions) {
      assert.ok(tool.name, `Tool should have a name`);
      assert.ok(tool.description, `Tool ${tool.name} should have a description`);
      assert.ok(tool.inputSchema, `Tool ${tool.name} should have an inputSchema`);
      assert.strictEqual(
        tool.inputSchema.type,
        "object",
        `Tool ${tool.name} inputSchema type should be object`
      );
    }
  });

  const expectedTools = [
    // Core meeting tools (10)
    "join_meeting",
    "leave_meeting",
    "speak",
    "present_url",
    "get_transcript",
    "inject_context",
    "send_chat_message",
    "get_status",
    "get_action_items",
    "set_voice_provider",
    // Onboarding tools (15)
    "check_health",
    "check_api_keys",
    "set_api_keys",
    "check_google_auth",
    "setup_google_oauth",
    "google_chrome_login",
    "get_config",
    "set_config",
    "check_capabilities",
    "check_audio",
    "check_permissions",
    "open_permissions",
    "check_ready",
    "list_calendar_events",
    "schedule_auto_join",
    // New v1.1.0 tools (5)
    "validate_meeting_url",
    "get_meeting_summary",
    "talk_locally",
    "manage_prompts",
    "recover",
  ];

  for (const toolName of expectedTools) {
    it(`should have tool: ${toolName}`, () => {
      const tool = toolDefinitions.find((t) => t.name === toolName);
      assert.ok(tool, `Tool ${toolName} should be defined`);
    });
  }
});

// ============================================
// Core Meeting Tool Tests
// ============================================

describe("Core Meeting Tools", () => {
  beforeEach(async () => {
    await setupMock();
  });

  describe("join_meeting", () => {
    it("should call joinMeeting with correct params", async () => {
      mockClient._mocks.joinMeeting.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("join_meeting", {
        meetUrl: "https://meet.google.com/abc-defg-hij",
        botName: "TestBot",
        topic: "Test Meeting",
      });

      assertToolResult(result, "Successfully joined");
    });

    it("should handle join failure", async () => {
      mockClient._mocks.joinMeeting.mock.mockImplementation(() =>
        Promise.resolve({ success: false, error: "Meeting not found" })
      );

      const result = await handleToolCall("join_meeting", {
        meetUrl: "https://meet.google.com/invalid",
      });

      assertToolResult(result, "Failed to join");
    });

    it("should use default botName when not provided", async () => {
      mockClient._mocks.joinMeeting.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("join_meeting", {
        meetUrl: "https://meet.google.com/abc-defg-hij",
      });

      assertToolResult(result, "CoCo");
    });
  });

  describe("leave_meeting", () => {
    it("should call leaveMeeting and show action items", async () => {
      mockClient._mocks.leaveMeeting.mock.mockImplementation(() =>
        Promise.resolve({
          success: true,
          actionItems: [
            { task: "Follow up with team", assignee: "John" },
            { task: "Send meeting notes", assignee: "Jane" },
          ],
        })
      );

      const result = await handleToolCall("leave_meeting", {});

      assertToolResult(result, "Left the meeting");
      assertToolResult(result, "Action Items");
    });

    it("should handle leave failure", async () => {
      mockClient._mocks.leaveMeeting.mock.mockImplementation(() =>
        Promise.resolve({ success: false, error: "Not in a meeting" })
      );

      const result = await handleToolCall("leave_meeting", {});

      assertToolResult(result, "Failed to leave");
    });
  });

  describe("speak", () => {
    it("should call speak with text", async () => {
      mockClient._mocks.speak.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("speak", {
        text: "Hello, everyone!",
      });

      assertToolResult(result, "Speaking");
      assertToolResult(result, "Hello, everyone!");
    });

    it("should handle speak failure", async () => {
      mockClient._mocks.speak.mock.mockImplementation(() =>
        Promise.resolve({ success: false })
      );

      const result = await handleToolCall("speak", {
        text: "Test",
      });

      assertToolResult(result, "Failed to speak");
    });
  });

  describe("present_url", () => {
    it("should call shareScreen with URL", async () => {
      mockClient._mocks.shareScreen.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("present_url", {
        url: "https://example.com/slides",
      });

      assertToolResult(result, "Now presenting");
    });

    it("should handle present failure", async () => {
      mockClient._mocks.shareScreen.mock.mockImplementation(() =>
        Promise.resolve({ success: false })
      );

      const result = await handleToolCall("present_url", {
        url: "https://invalid.example.com",
      });

      assertToolResult(result, "Failed to present");
    });
  });

  describe("get_transcript", () => {
    it("should return full transcript", async () => {
      mockClient._mocks.getTranscript.mock.mockImplementation(() =>
        Promise.resolve([
          { speaker: "John", text: "Hello", timestamp: "00:00:01" },
          { speaker: "Jane", text: "Hi there", timestamp: "00:00:05" },
        ])
      );

      const result = await handleToolCall("get_transcript", {});

      assertToolResult(result, "Transcript");
      assertToolResult(result, "John: Hello");
    });

    it("should return new entries only when newOnly is true", async () => {
      mockClient._mocks.getNewTranscriptEntries.mock.mockImplementation(() =>
        Promise.resolve([{ speaker: "John", text: "New message", timestamp: "00:01:00" }])
      );

      const result = await handleToolCall("get_transcript", { newOnly: true });

      assertToolResult(result, "new entries");
    });

    it("should handle empty transcript", async () => {
      mockClient._mocks.getTranscript.mock.mockImplementation(() =>
        Promise.resolve([])
      );

      const result = await handleToolCall("get_transcript", {});

      assertToolResult(result, "empty");
    });
  });

  describe("inject_context", () => {
    it("should inject context successfully", async () => {
      mockClient._mocks.injectContext.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("inject_context", {
        text: "The project deadline is next Friday",
      });

      assertToolResult(result, "Context injected");
    });
  });

  describe("send_chat_message", () => {
    it("should send chat message", async () => {
      mockClient._mocks.sendChatMessage.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("send_chat_message", {
        message: "Here is the link: https://example.com",
      });

      assertToolResult(result, "Chat message sent");
    });
  });

  describe("get_status", () => {
    it("should return status when CallingClaw is running", async () => {
      mockClient._mocks.getStatus.mock.mockImplementation(() =>
        Promise.resolve({
          meeting: "recording",
          voiceSession: { connected: true, active: true, transport: "websocket" },
          transcriptLength: 10,
          automation: { playwright: { enabled: true } },
        })
      );

      const result = await handleToolCall("get_status", {});

      assertToolResult(result, "CallingClaw Status");
    });

    it("should handle CallingClaw not running", async () => {
      mockClient._mocks.getStatus.mock.mockImplementation(() =>
        Promise.reject(new Error("Connection refused"))
      );

      const result = await handleToolCall("get_status", {});

      assertToolResult(result, "not running");
    });
  });

  describe("get_action_items", () => {
    it("should extract action items from transcript", async () => {
      mockClient._mocks.getActionItems.mock.mockImplementation(() =>
        Promise.resolve([
          { task: "Send report", assignee: "John", priority: "high" },
          { task: "Schedule follow-up", assignee: "Jane" },
        ])
      );

      const result = await handleToolCall("get_action_items", {});

      assertToolResult(result, "Action Items");
    });

    it("should handle no action items", async () => {
      mockClient._mocks.getActionItems.mock.mockImplementation(() =>
        Promise.resolve([])
      );

      const result = await handleToolCall("get_action_items", {});

      assertToolResult(result, "No action items");
    });
  });

  describe("set_voice_provider", () => {
    it("should change voice provider to openai", async () => {
      mockClient._mocks.setVoiceProvider.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("set_voice_provider", {
        provider: "openai",
      });

      assertToolResult(result, "Voice provider changed");
      assertToolResult(result, "openai");
    });

    it("should change voice provider to gemini", async () => {
      mockClient._mocks.setVoiceProvider.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("set_voice_provider", {
        provider: "gemini",
      });

      assertToolResult(result, "gemini");
    });
  });
});

// ============================================
// Onboarding Tool Tests
// ============================================

describe("Onboarding Tools", () => {
  beforeEach(async () => {
    await setupMock();
  });

  describe("check_health", () => {
    it("should return running status", async () => {
      mockClient._mocks.checkHealth.mock.mockImplementation(() =>
        Promise.resolve({ running: true, version: "2.0.0" })
      );

      const result = await handleToolCall("check_health", {});

      assertToolResult(result, "running");
    });

    it("should return not running when desktop is down", async () => {
      mockClient._mocks.checkHealth.mock.mockImplementation(() =>
        Promise.resolve({ running: false, message: "Not running" })
      );

      const result = await handleToolCall("check_health", {});

      assertToolResult(result, "not running");
    });
  });

  describe("check_api_keys", () => {
    it("should list configured and missing keys", async () => {
      mockClient._mocks.checkApiKeys.mock.mockImplementation(() =>
        Promise.resolve({
          keys: [
            { name: "OPENAI_API_KEY", configured: true, masked: "sk-...abc", required: true, description: "OpenAI API" },
            { name: "GOOGLE_API_KEY", configured: false, required: true, description: "Google API", url: "https://console.cloud.google.com" },
          ],
        })
      );

      const result = await handleToolCall("check_api_keys", {});

      assertToolResult(result, "API Keys Status");
      assertToolResult(result, "OPENAI_API_KEY");
    });
  });

  describe("set_api_keys", () => {
    it("should set API keys successfully", async () => {
      mockClient._mocks.setApiKeys.mock.mockImplementation(() =>
        Promise.resolve({ success: true, message: "Keys saved" })
      );

      const result = await handleToolCall("set_api_keys", {
        keys: { OPENAI_API_KEY: "sk-test123" },
      });

      assertToolResult(result, "API keys configured");
    });

    it("should handle set failure", async () => {
      mockClient._mocks.setApiKeys.mock.mockImplementation(() =>
        Promise.resolve({ success: false, message: "Invalid key format" })
      );

      const result = await handleToolCall("set_api_keys", {
        keys: { OPENAI_API_KEY: "invalid" },
      });

      assertToolResult(result, "Failed to set");
    });
  });

  describe("check_google_auth", () => {
    it("should return auth status", async () => {
      mockClient._mocks.checkGoogleAuth.mock.mockImplementation(() =>
        Promise.resolve({
          calendarConnected: true,
          chromeLoggedIn: true,
          email: "user@example.com",
        })
      );

      const result = await handleToolCall("check_google_auth", {});

      assertToolResult(result, "Google Auth Status");
      assertToolResult(result, "fully configured");
    });

    it("should show missing auth", async () => {
      mockClient._mocks.checkGoogleAuth.mock.mockImplementation(() =>
        Promise.resolve({
          calendarConnected: false,
          chromeLoggedIn: false,
        })
      );

      const result = await handleToolCall("check_google_auth", {});

      assertToolResult(result, "not connected");
    });
  });

  describe("setup_google_oauth", () => {
    it("should scan for credentials", async () => {
      mockClient._mocks.scanGoogleCredentials.mock.mockImplementation(() =>
        Promise.resolve({
          found: true,
          paths: ["/path/to/credentials.json"],
          credentials: { clientId: "test-client-id", hasRefreshToken: true },
        })
      );

      const result = await handleToolCall("setup_google_oauth", { action: "scan" });

      assertToolResult(result, "Found existing");
    });

    it("should handle no credentials found", async () => {
      mockClient._mocks.scanGoogleCredentials.mock.mockImplementation(() =>
        Promise.resolve({ found: false })
      );

      const result = await handleToolCall("setup_google_oauth", { action: "scan" });

      assertToolResult(result, "No existing");
    });

    it("should apply credentials", async () => {
      mockClient._mocks.applyGoogleCredentials.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("setup_google_oauth", { action: "apply" });

      assertToolResult(result, "applied successfully");
    });

    it("should set credentials manually", async () => {
      mockClient._mocks.setGoogleCredentials.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("setup_google_oauth", {
        action: "set",
        credentials: { clientId: "test-id", clientSecret: "test-secret" },
      });

      assertToolResult(result, "configured");
    });

    it("should reject set without credentials", async () => {
      const result = await handleToolCall("setup_google_oauth", { action: "set" });

      assertToolResult(result, "Missing required credentials");
    });
  });

  describe("google_chrome_login", () => {
    it("should start Chrome login", async () => {
      mockClient._mocks.startChromeLogin.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("google_chrome_login", { action: "start" });

      assertToolResult(result, "Chrome opened");
    });

    it("should check login status", async () => {
      mockClient._mocks.checkChromeLogin.mock.mockImplementation(() =>
        Promise.resolve({ success: true, email: "user@example.com" })
      );

      const result = await handleToolCall("google_chrome_login", { action: "check" });

      assertToolResult(result, "login successful");
    });

    it("should handle login in progress", async () => {
      mockClient._mocks.checkChromeLogin.mock.mockImplementation(() =>
        Promise.resolve({ inProgress: true })
      );

      const result = await handleToolCall("google_chrome_login", { action: "check" });

      assertToolResult(result, "in progress");
    });
  });

  describe("get_config", () => {
    it("should return configuration", async () => {
      mockClient._mocks.getConfig.mock.mockImplementation(() =>
        Promise.resolve({
          voiceProvider: "openai",
          language: "en",
          defaultBotName: "CoCo",
        })
      );

      const result = await handleToolCall("get_config", {});

      assertToolResult(result, "Configuration");
    });
  });

  describe("set_config", () => {
    it("should update configuration", async () => {
      mockClient._mocks.setConfig.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("set_config", {
        config: { voiceProvider: "gemini" },
      });

      assertToolResult(result, "Configuration updated");
    });
  });

  describe("check_capabilities", () => {
    it("should list all capabilities", async () => {
      mockClient._mocks.checkCapabilities.mock.mockImplementation(() =>
        Promise.resolve({
          voiceProviders: ["openai", "gemini", "grok"],
          meetingPlatforms: ["Google Meet", "Zoom"],
          automationLayers: [
            { name: "Playwright", available: true, description: "Browser automation" },
          ],
          features: [{ name: "Voice AI", available: true }],
        })
      );

      const result = await handleToolCall("check_capabilities", {});

      assertToolResult(result, "Capabilities");
    });
  });

  describe("check_audio", () => {
    it("should return audio status", async () => {
      mockClient._mocks.checkAudio.mock.mockImplementation(() =>
        Promise.resolve({
          working: true,
          inputDevices: [{ id: "1", name: "MacBook Microphone", isDefault: true }],
          outputDevices: [{ id: "2", name: "MacBook Speakers", isDefault: true }],
        })
      );

      const result = await handleToolCall("check_audio", {});

      assertToolResult(result, "Audio Status");
    });

    it("should show audio not working", async () => {
      mockClient._mocks.checkAudio.mock.mockImplementation(() =>
        Promise.resolve({
          working: false,
          inputDevices: [],
          outputDevices: [],
          error: "No devices found",
        })
      );

      const result = await handleToolCall("check_audio", {});

      assertToolResult(result, "not working");
    });
  });

  describe("check_permissions", () => {
    it("should list permission status", async () => {
      mockClient._mocks.checkPermissions.mock.mockImplementation(() =>
        Promise.resolve({
          screenRecording: { granted: true, canRequest: false },
          microphone: { granted: true, canRequest: false },
          accessibility: { granted: false, canRequest: true },
          camera: { granted: true, canRequest: false },
        })
      );

      const result = await handleToolCall("check_permissions", {});

      assertToolResult(result, "Permissions");
    });
  });

  describe("open_permissions", () => {
    it("should open screen recording panel", async () => {
      mockClient._mocks.openPermissions.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("open_permissions", {
        panel: "screenRecording",
      });

      assertToolResult(result, "Screen Recording");
    });
  });

  describe("check_ready", () => {
    it("should show all checks passed", async () => {
      mockClient._mocks.checkReady.mock.mockImplementation(() =>
        Promise.resolve({
          ready: true,
          checks: [
            { name: "CallingClaw Running", passed: true },
            { name: "API Keys", passed: true },
            { name: "Permissions", passed: true },
          ],
        })
      );

      const result = await handleToolCall("check_ready", {});

      assertToolResult(result, "fully ready");
    });

    it("should show failed checks", async () => {
      mockClient._mocks.checkReady.mock.mockImplementation(() =>
        Promise.resolve({
          ready: false,
          checks: [
            { name: "CallingClaw Running", passed: true },
            { name: "API Keys", passed: false, message: "Missing OPENAI_API_KEY" },
          ],
        })
      );

      const result = await handleToolCall("check_ready", {});

      assertToolResult(result, "not fully ready");
    });
  });

  describe("list_calendar_events", () => {
    it("should list upcoming events", async () => {
      mockClient._mocks.listCalendarEvents.mock.mockImplementation(() =>
        Promise.resolve({
          events: [
            {
              id: "1",
              title: "Team Standup",
              start: new Date().toISOString(),
              end: new Date().toISOString(),
              meetUrl: "https://meet.google.com/abc-defg-hij",
              attendees: ["john@example.com", "jane@example.com"],
            },
          ],
        })
      );

      const result = await handleToolCall("list_calendar_events", {});

      assertToolResult(result, "Upcoming Events");
      assertToolResult(result, "Team Standup");
    });

    it("should handle no events", async () => {
      mockClient._mocks.listCalendarEvents.mock.mockImplementation(() =>
        Promise.resolve({ events: [] })
      );

      const result = await handleToolCall("list_calendar_events", {});

      assertToolResult(result, "No upcoming");
    });
  });

  describe("schedule_auto_join", () => {
    it("should schedule auto-join", async () => {
      mockClient._mocks.scheduleAutoJoin.mock.mockImplementation(() =>
        Promise.resolve({ success: true, id: "sched-123" })
      );

      const result = await handleToolCall("schedule_auto_join", {
        action: "schedule",
        meetUrl: "https://meet.google.com/abc-defg-hij",
        scheduledTime: new Date().toISOString(),
      });

      assertToolResult(result, "Auto-join scheduled");
    });

    it("should get scheduler status", async () => {
      mockClient._mocks.getSchedulerStatus.mock.mockImplementation(() =>
        Promise.resolve({
          scheduled: [
            {
              id: "1",
              meetUrl: "https://meet.google.com/abc",
              scheduledTime: new Date().toISOString(),
              status: "pending",
            },
          ],
          nextJoin: {
            id: "1",
            meetUrl: "https://meet.google.com/abc",
            scheduledTime: new Date().toISOString(),
            status: "pending",
          },
        })
      );

      const result = await handleToolCall("schedule_auto_join", { action: "status" });

      assertToolResult(result, "Scheduler Status");
    });

    it("should require meetUrl for schedule action", async () => {
      const result = await handleToolCall("schedule_auto_join", { action: "schedule" });

      assertToolResult(result, "Missing meetUrl");
    });
  });
});

// ============================================
// New v1.1.0 Tool Tests
// ============================================

describe("New v1.1.0 Tools", () => {
  beforeEach(async () => {
    await setupMock();
  });

  describe("validate_meeting_url", () => {
    it("should validate Google Meet URL", async () => {
      mockClient._mocks.validateMeetingUrl.mock.mockImplementation(() =>
        Promise.resolve({
          valid: true,
          platform: "google_meet",
          normalized: "https://meet.google.com/abc-defg-hij",
        })
      );

      const result = await handleToolCall("validate_meeting_url", {
        meetUrl: "https://meet.google.com/abc-defg-hij",
      });

      assertToolResult(result, "Valid");
      assertToolResult(result, "Google Meet");
    });

    it("should validate Zoom URL", async () => {
      mockClient._mocks.validateMeetingUrl.mock.mockImplementation(() =>
        Promise.resolve({
          valid: true,
          platform: "zoom",
          normalized: "https://zoom.us/j/1234567890",
        })
      );

      const result = await handleToolCall("validate_meeting_url", {
        meetUrl: "https://zoom.us/j/1234567890",
      });

      assertToolResult(result, "Zoom");
    });

    it("should reject invalid URL", async () => {
      mockClient._mocks.validateMeetingUrl.mock.mockImplementation(() =>
        Promise.resolve({
          valid: false,
          platform: "unknown",
          normalized: "",
        })
      );

      const result = await handleToolCall("validate_meeting_url", {
        meetUrl: "https://example.com/not-a-meeting",
      });

      assertToolResult(result, "Invalid");
    });
  });

  describe("get_meeting_summary", () => {
    it("should generate summary for current meeting", async () => {
      mockClient._mocks.getMeetingSummary.mock.mockImplementation(() =>
        Promise.resolve({
          success: true,
          title: "Team Standup",
          duration: "30 minutes",
          keyTopics: ["Sprint progress", "Blockers"],
          decisions: ["Move deadline to Friday"],
          actionItems: [
            { task: "Update documentation", assignee: "John" },
          ],
        })
      );

      const result = await handleToolCall("get_meeting_summary", {});

      assertToolResult(result, "Meeting Summary");
      assertToolResult(result, "Key Topics");
      assertToolResult(result, "Decisions");
    });

    it("should get past meeting summary by ID", async () => {
      mockClient._mocks.getMeetingSummary.mock.mockImplementation(() =>
        Promise.resolve({
          success: true,
          title: "Past Meeting",
          actionItems: [],
        })
      );

      const result = await handleToolCall("get_meeting_summary", {
        meetingId: "meeting-123",
      });

      assertToolResult(result, "Meeting Summary");
    });

    it("should handle summary generation failure", async () => {
      mockClient._mocks.getMeetingSummary.mock.mockImplementation(() =>
        Promise.resolve({
          success: false,
          error: "No transcript available",
        })
      );

      const result = await handleToolCall("get_meeting_summary", {});

      assertToolResult(result, "No transcript available");
    });
  });

  describe("talk_locally", () => {
    it("should start local voice chat", async () => {
      mockClient._mocks.startLocalVoice.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("talk_locally", { action: "start" });

      assertToolResult(result, "Local voice chat started");
    });

    it("should stop local voice chat", async () => {
      mockClient._mocks.stopLocalVoice.mock.mockImplementation(() =>
        Promise.resolve({ success: true })
      );

      const result = await handleToolCall("talk_locally", { action: "stop" });

      assertToolResult(result, "stopped");
    });

    it("should handle start failure", async () => {
      mockClient._mocks.startLocalVoice.mock.mockImplementation(() =>
        Promise.resolve({ success: false, error: "Microphone not available" })
      );

      const result = await handleToolCall("talk_locally", { action: "start" });

      assertToolResult(result, "Failed to start");
    });

    it("should reject invalid action", async () => {
      const result = await handleToolCall("talk_locally", { action: "invalid" });

      assertToolResult(result, "Invalid action");
    });
  });

  describe("manage_prompts", () => {
    it("should list all prompts", async () => {
      mockClient._mocks.listPrompts.mock.mockImplementation(() =>
        Promise.resolve({
          prompts: [
            {
              id: "meeting-assistant",
              name: "Meeting Assistant",
              description: "Default meeting behavior",
              content: "You are a helpful meeting assistant...",
            },
            {
              id: "technical-advisor",
              name: "Technical Advisor",
              description: "Technical discussions",
              content: "You are a technical advisor...",
            },
          ],
        })
      );

      const result = await handleToolCall("manage_prompts", { action: "list" });

      assertToolResult(result, "Prompt Templates");
      assertToolResult(result, "meeting-assistant");
    });

    it("should update a prompt", async () => {
      mockClient._mocks.updatePrompt.mock.mockImplementation(() =>
        Promise.resolve({ success: true, message: "Prompt updated" })
      );

      const result = await handleToolCall("manage_prompts", {
        action: "update",
        promptId: "meeting-assistant",
        content: "New prompt content",
      });

      assertToolResult(result, "updated successfully");
    });

    it("should reset a prompt to default", async () => {
      mockClient._mocks.resetPrompt.mock.mockImplementation(() =>
        Promise.resolve({ success: true, message: "Reset to default" })
      );

      const result = await handleToolCall("manage_prompts", {
        action: "reset",
        promptId: "meeting-assistant",
      });

      assertToolResult(result, "reset to default");
    });

    it("should require promptId for update", async () => {
      const result = await handleToolCall("manage_prompts", {
        action: "update",
        content: "New content",
      });

      assertToolResult(result, "Missing required parameters");
    });

    it("should require content for update", async () => {
      const result = await handleToolCall("manage_prompts", {
        action: "update",
        promptId: "test",
      });

      assertToolResult(result, "Missing required parameters");
    });

    it("should require promptId for reset", async () => {
      const result = await handleToolCall("manage_prompts", { action: "reset" });

      assertToolResult(result, "Missing promptId");
    });
  });

  describe("recover", () => {
    it("should check system health", async () => {
      mockClient._mocks.getRecoveryHealth.mock.mockImplementation(() =>
        Promise.resolve({
          browser: { healthy: true, message: "Running" },
          voice: { healthy: true, message: "Connected" },
          sidecar: { healthy: true, message: "OpenClaw running" },
        })
      );

      const result = await handleToolCall("recover", { action: "health" });

      assertToolResult(result, "System Health Check");
      assertToolResult(result, "All subsystems healthy");
    });

    it("should show unhealthy subsystems", async () => {
      mockClient._mocks.getRecoveryHealth.mock.mockImplementation(() =>
        Promise.resolve({
          browser: { healthy: false, message: "Not running" },
          voice: { healthy: true, message: "Connected" },
          sidecar: { healthy: false, message: "OpenClaw not found" },
        })
      );

      const result = await handleToolCall("recover", { action: "health" });

      assertToolResult(result, "need attention");
    });

    it("should recover browser", async () => {
      mockClient._mocks.recoverBrowser.mock.mockImplementation(() =>
        Promise.resolve({ success: true, message: "Browser restarted" })
      );

      const result = await handleToolCall("recover", { action: "browser" });

      assertToolResult(result, "Browser recovered");
    });

    it("should recover voice", async () => {
      mockClient._mocks.recoverVoice.mock.mockImplementation(() =>
        Promise.resolve({ success: true, message: "Voice session restarted" })
      );

      const result = await handleToolCall("recover", { action: "voice" });

      assertToolResult(result, "Voice session recovered");
    });

    it("should handle browser recovery failure", async () => {
      mockClient._mocks.recoverBrowser.mock.mockImplementation(() =>
        Promise.resolve({ success: false, error: "Failed to start Chrome" })
      );

      const result = await handleToolCall("recover", { action: "browser" });

      assertToolResult(result, "Failed to recover");
    });

    it("should reject invalid action", async () => {
      const result = await handleToolCall("recover", { action: "invalid" });

      assertToolResult(result, "Invalid action");
    });
  });
});

// ============================================
// Error Handling Tests
// ============================================

describe("Error Handling", () => {
  beforeEach(async () => {
    await setupMock();
  });

  it("should handle API connection errors", async () => {
    mockClient._mocks.joinMeeting.mock.mockImplementation(() =>
      Promise.reject(new Error("Connection refused"))
    );

    const result = await handleToolCall("join_meeting", {
      meetUrl: "https://meet.google.com/abc",
    });

    assertToolResult(result, "Error executing");
  });

  it("should handle timeout errors", async () => {
    mockClient._mocks.joinMeeting.mock.mockImplementation(() =>
      Promise.reject(new Error("Request timeout after 90000ms"))
    );

    const result = await handleToolCall("join_meeting", {
      meetUrl: "https://meet.google.com/abc",
    });

    assertToolResult(result, "Error executing");
  });

  it("should handle unknown tool", async () => {
    const result = await handleToolCall("nonexistent_tool", {});

    assertToolResult(result, "Unknown tool");
  });

  it("should handle CallingClaw not available for non-self-check tools", async () => {
    mockClient._mocks.isAvailable.mock.mockImplementation(() => Promise.resolve(false));

    const result = await handleToolCall("join_meeting", {
      meetUrl: "https://meet.google.com/abc",
    });

    assertToolResult(result, "not running");
  });
});

// ============================================
// API Client Method Tests
// ============================================

describe("CallingClawClient API Methods", () => {
  it("should use correct endpoints for new v1.1.0 methods", async () => {
    const client = new CallingClawClient("http://test:4000");

    // Verify method existence
    assert.ok(typeof client.validateMeetingUrl === "function");
    assert.ok(typeof client.getMeetingSummary === "function");
    assert.ok(typeof client.startLocalVoice === "function");
    assert.ok(typeof client.stopLocalVoice === "function");
    assert.ok(typeof client.listPrompts === "function");
    assert.ok(typeof client.updatePrompt === "function");
    assert.ok(typeof client.resetPrompt === "function");
    assert.ok(typeof client.getRecoveryHealth === "function");
    assert.ok(typeof client.recoverBrowser === "function");
    assert.ok(typeof client.recoverVoice === "function");
  });

  it("should have all 30 tool-related methods", () => {
    const client = new CallingClawClient();

    const expectedMethods = [
      // Core methods
      "isAvailable",
      "getStatus",
      "joinMeeting",
      "leaveMeeting",
      "speak",
      "injectContext",
      "shareScreen",
      "getTranscript",
      "getNewTranscriptEntries",
      "sendChatMessage",
      "getActionItems",
      "setVoiceProvider",
      // Onboarding methods
      "checkHealth",
      "checkApiKeys",
      "setApiKeys",
      "checkGoogleAuth",
      "scanGoogleCredentials",
      "applyGoogleCredentials",
      "setGoogleCredentials",
      "startChromeLogin",
      "checkChromeLogin",
      "getConfig",
      "setConfig",
      "checkCapabilities",
      "checkAudio",
      "checkPermissions",
      "openPermissions",
      "checkReady",
      "listCalendarEvents",
      "scheduleAutoJoin",
      "getSchedulerStatus",
      // v1.1.0 methods
      "validateMeetingUrl",
      "getMeetingSummary",
      "startLocalVoice",
      "stopLocalVoice",
      "listPrompts",
      "updatePrompt",
      "resetPrompt",
      "getRecoveryHealth",
      "recoverBrowser",
      "recoverVoice",
    ];

    for (const method of expectedMethods) {
      assert.ok(
        typeof (client as unknown as Record<string, unknown>)[method] === "function",
        `Client should have method: ${method}`
      );
    }
  });
});
