import { describe, expect, test } from "bun:test";
import { aiTools } from "../src/tool-definitions/ai-tools";

describe("aiTools recall_context", () => {
  test("falls back to local memory when OpenClaw returns no response", async () => {
    const emitted: Array<{ event: string; payload: any }> = [];
    const tools = aiTools({
      contextSync: {
        searchMemory: () => "今天修复了 memory recall 和 voice text duplicate 两个 bug。",
      } as any,
      contextRetriever: undefined,
      openclawBridge: {
        connected: true,
        sendTask: async () => "(no response)",
      } as any,
      eventBus: {
        emit: (event: string, payload: any) => emitted.push({ event, payload }),
      } as any,
    });

    const result = await tools.handler("recall_context", {
      query: "今天修复的 bug 列表",
      urgency: "quick",
    });

    expect(result).toContain("[Memory recall]");
    expect(result).toContain("memory recall");
    expect(emitted[0]?.event).toBe("voice.tool_call");
  });
});
