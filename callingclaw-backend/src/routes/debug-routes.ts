// CallingClaw 2.0 — Debug Routes
// /api/debug/prompts, /api/debug/token-budget
// Provides visibility into active prompt state and token consumption.
// See CONTEXT-ENGINEERING.md for the 5-layer context strategy.

import type { Services, RouteHandler } from "./types";
import { CORE_IDENTITY, CORE_IDENTITY_TOKEN_BUDGET } from "../prompt-constants";

export function debugRoutes(services: Services): RouteHandler {
  return {
    match: (pathname) => pathname.startsWith("/api/debug/"),

    handle: async (req, url, headers) => {
      // GET /api/debug/prompts — Active prompt state across all layers
      if (url.pathname === "/api/debug/prompts" && req.method === "GET") {
        const contextQueue = services.realtime.connected
          ? services.realtime.getContextQueue()
          : [];

        return Response.json({
          layer0: {
            name: "CORE_IDENTITY",
            content: CORE_IDENTITY,
            tokenBudget: CORE_IDENTITY_TOKEN_BUDGET,
            estimatedTokens: Math.ceil(CORE_IDENTITY.length / 3.5),
          },
          layer1: {
            name: "Tools",
            tools: services.realtime.getAllTools().map((t) => ({
              name: t.name,
              description: t.description.slice(0, 100),
            })),
            toolCount: services.realtime.getAllTools().length,
          },
          layer2: {
            name: "Mission Context",
            briefActive: !!services.meetingPrepSkill?.currentBrief,
            briefTopic: services.meetingPrepSkill?.currentBrief?.topic || null,
          },
          layer3: {
            name: "Live Context",
            queueSize: contextQueue.length,
            maxItems: 15,
            items: contextQueue.map((item) => ({
              id: item.id,
              preview: item.text.slice(0, 100),
              injectedAt: item.injectedAt,
            })),
          },
          session: {
            connected: services.realtime.connected,
            provider: services.realtime.provider,
            lastInstructions: services.realtime.getLastInstructions().slice(0, 200),
          },
        }, { headers });
      }

      // GET /api/debug/token-budget — Token consumption tracking
      if (url.pathname === "/api/debug/token-budget" && req.method === "GET") {
        // Token budget is tracked on the RealtimeClient (not VoiceModule)
        // We access it indirectly through the context queue and instructions
        const instructions = services.realtime.getLastInstructions();
        const contextQueue = services.realtime.connected
          ? services.realtime.getContextQueue()
          : [];

        const layer0Tokens = Math.ceil(instructions.length / 3.5);
        const layer1Tokens = services.realtime.getAllTools().length * 50; // ~50 tokens per tool
        const layer3Tokens = contextQueue.reduce((sum, item) => sum + Math.ceil(item.text.length / 3.5), 0);
        const overheadTokens = layer0Tokens + layer1Tokens + layer3Tokens;

        return Response.json({
          layers: {
            layer0_identity: { tokens: layer0Tokens, budget: CORE_IDENTITY_TOKEN_BUDGET },
            layer1_tools: { tokens: layer1Tokens, count: services.realtime.getAllTools().length },
            layer3_context: { tokens: layer3Tokens, items: contextQueue.length, maxItems: 15 },
          },
          overhead: {
            tokens: overheadTokens,
            budgetTotal: 128_000,
            usagePercent: Math.round((overheadTokens / 128_000) * 100 * 100) / 100,
          },
          session: {
            connected: services.realtime.connected,
            provider: services.realtime.provider,
          },
        }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
