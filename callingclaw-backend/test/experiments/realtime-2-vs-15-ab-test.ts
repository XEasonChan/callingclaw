/**
 * Realtime 2 vs 1.5 A/B Test — Verify the gpt-realtime-2 default upgrade
 *
 * Connects directly via WebSocket (bypasses RealtimeClient so we can pin a
 * different model per session in one run). Both share the GA wire format —
 * if v2 is truly drop-in, the same payload should round-trip on both.
 *
 * What we measure:
 *   1. session.created round-trip latency  (handshake regression check)
 *   2. mispronounced file lookup → correct open_file call (reasoning quality)
 *   3. dual-file request → parallel tool calls (v2-only feature)
 *   4. reasoning.effort field acceptance (v2-only knob, 1.5 should reject/ignore)
 *
 * Run:  bun test/experiments/realtime-2-vs-15-ab-test.ts
 * Reqs: OPENAI_API_KEY in .env
 */
import { CONFIG } from "../../src/config";
const WS = require("ws"); // npm ws — Bun's built-in WS ignores proxy

const MODELS = ["gpt-realtime-1.5", "gpt-realtime-2"] as const;
type Model = (typeof MODELS)[number];

const PREP_CONTEXT = `
## Meeting Context — Tanka Link 2.0 Review

### Key Documents:
- Phase 2 Testing Guide → /Users/andrew/docs/link2-phase2-testing-guide.html
  (95 apps, ClickUp 51 actions, Salesforce 50, Stripe 47)
- App Catalog → /Users/andrew/docs/tanka-link-app-catalog.html
  (184 app icons, connection status)
- MCP Tool Registry → /Users/andrew/docs/mcp-tool-priority.html
  (Phase II reduction: 95→20-30 Tier 1 apps)
- Action PRD → /Users/andrew/docs/PRD-Phase2-Action-Coverage.html
`;

const TOOLS = [
  {
    type: "function",
    name: "open_file",
    description: "Open a file at the given absolute path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        reason: { type: "string", description: "Why this file matches" },
      },
      required: ["path"],
    },
  },
];

const QUERIES = [
  {
    id: "smoke",
    label: "smoke / wire-format",
    query: "Reply with the single word: ready.",
    expectTool: false,
    expectFiles: [],
    extraSession: {},
  },
  {
    id: "mispronounce",
    label: "mispronounced lookup",
    query:
      "Hey, can you open the Link to Pony testing guide? I need to check which apps to test first.",
    expectTool: true,
    expectFiles: ["link2-phase2-testing-guide.html"],
    extraSession: {},
  },
  {
    id: "parallel",
    label: "parallel tool calls (v2 feature)",
    query:
      "Open both the app catalog AND the MCP tool registry — I want to cross-reference the Tier 1 apps with available actions.",
    expectTool: true,
    expectFiles: ["tanka-link-app-catalog.html", "mcp-tool-priority.html"],
    extraSession: {},
  },
  {
    id: "reasoning-high",
    label: "reasoning.effort=high (v2 knob)",
    query:
      "I'm describing a doc by content only, no name: it has 95 apps, ClickUp at 51, Salesforce at 50. Open it.",
    expectTool: true,
    expectFiles: ["link2-phase2-testing-guide.html"],
    extraSession: { reasoning: { effort: "high" } },
  },
];

// ── Direct WS session ───────────────────────────────────────────

interface SessionResult {
  model: Model;
  queryId: string;
  label: string;
  query: string;
  handshakeMs: number;
  ttftMs: number; // time-to-first-token (any output)
  totalMs: number;
  toolCalls: { name: string; args: any }[];
  filesOpened: string[];
  filesCorrect: number;
  filesExpected: number;
  responseText: string;
  sessionUpdateAccepted: boolean;
  errors: any[];
  rawCloseCode?: number;
  rawCloseReason?: string;
}

function runOne(model: Model, q: (typeof QUERIES)[number]): Promise<SessionResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const result: SessionResult = {
      model,
      queryId: q.id,
      label: q.label,
      query: q.query,
      handshakeMs: 0,
      ttftMs: 0,
      totalMs: 0,
      toolCalls: [],
      filesOpened: [],
      filesCorrect: 0,
      filesExpected: q.expectFiles.length,
      responseText: "",
      sessionUpdateAccepted: false,
      errors: [],
    };

    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const ws = new WS(url, {
      headers: { Authorization: `Bearer ${CONFIG.openai.apiKey}` },
    });

    let firstTokenAt = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      result.errors.push({ type: "timeout", ms: 45000 });
      try {
        ws.close();
      } catch {}
    }, 45000);

    ws.on("open", () => {
      result.handshakeMs = Date.now() - start;
      // GA session.update — minimal, with optional v2-only fields
      const sessionPayload: any = {
        type: "realtime",
        model,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad" },
            transcription: { model: "gpt-4o-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "marin",
          },
        },
        // text-only output is plenty for AB; saves tokens + time
        output_modalities: ["text"],
        instructions: `You are CoCo, a meeting assistant. ${PREP_CONTEXT}
When asked to open/show a document, call open_file with the matching absolute path.
You may open multiple files in one turn if the user references more than one.`,
        tools: TOOLS,
        ...q.extraSession,
      };
      ws.send(JSON.stringify({ type: "session.update", session: sessionPayload }));
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: q.query }],
          },
        }),
      );
      ws.send(JSON.stringify({ type: "response.create" }));
    });

    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!firstTokenAt && msg.type?.startsWith("response.")) {
        firstTokenAt = Date.now();
        result.ttftMs = firstTokenAt - start;
      }
      switch (msg.type) {
        case "session.updated":
          result.sessionUpdateAccepted = true;
          break;
        case "response.output_text.delta":
        case "response.text.delta":
          result.responseText += msg.delta || "";
          break;
        case "response.function_call_arguments.done": {
          let args: any = {};
          try {
            args = JSON.parse(msg.arguments || "{}");
          } catch {}
          result.toolCalls.push({ name: msg.name, args });
          if (msg.name === "open_file" && args.path) {
            result.filesOpened.push(args.path);
          }
          break;
        }
        case "response.done":
          result.totalMs = Date.now() - start;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {}
          break;
        case "error":
          result.errors.push(msg.error || msg);
          break;
      }
    });

    ws.on("error", (e: any) => {
      result.errors.push({ type: "ws-error", message: e?.message || String(e) });
    });

    ws.on("close", (code: number, reason: Buffer) => {
      result.rawCloseCode = code;
      result.rawCloseReason = reason?.toString?.() || "";
      if (!result.totalMs) result.totalMs = Date.now() - start;
      // Score file matches
      for (const expected of q.expectFiles) {
        if (result.filesOpened.some((p) => p.toLowerCase().includes(expected.toLowerCase()))) {
          result.filesCorrect++;
        }
      }
      if (timedOut && result.errors.length === 0) {
        result.errors.push({ type: "timeout-no-error" });
      }
      resolve(result);
    });
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Realtime 2 vs 1.5 — Upgrade Verification");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  API key: ${CONFIG.openai.apiKey ? "✓" : "✗"}`);
  console.log(`  Models:  ${MODELS.join("  vs  ")}`);
  console.log(`  Queries: ${QUERIES.length}\n`);

  if (!CONFIG.openai.apiKey) {
    console.error("❌ OPENAI_API_KEY not set");
    process.exit(1);
  }

  const all: SessionResult[] = [];
  for (const q of QUERIES) {
    console.log(`── [${q.id}] ${q.label}`);
    console.log(`   query: "${q.query.slice(0, 80)}${q.query.length > 80 ? "…" : ""}"`);
    if (q.expectFiles.length) console.log(`   expect: ${q.expectFiles.join(", ")}`);

    for (const model of MODELS) {
      process.stdout.write(`   ${model.padEnd(20)} → `);
      const r = await runOne(model, q);
      all.push(r);

      if (r.errors.length) {
        console.log(`❌ ${JSON.stringify(r.errors[0]).slice(0, 90)} (${r.totalMs}ms)`);
      } else if (q.expectTool) {
        const fileNames = r.filesOpened.map((p) => p.split("/").pop()).join(", ") || "(none)";
        const icon =
          r.filesCorrect === r.filesExpected ? "✅" : r.filesCorrect > 0 ? "⚠️ " : "❌";
        console.log(
          `${icon} ${r.filesCorrect}/${r.filesExpected} files | tool calls: ${r.toolCalls.length} | ttft ${r.ttftMs}ms | total ${r.totalMs}ms`,
        );
        if (r.filesOpened.length) console.log(`        opened: ${fileNames}`);
      } else {
        console.log(
          `✅ "${r.responseText.trim().slice(0, 60)}" | ttft ${r.ttftMs}ms | total ${r.totalMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500)); // gentle rate-limit
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const model of MODELS) {
    const rows = all.filter((r) => r.model === model);
    const totalExpected = rows.reduce((s, r) => s + r.filesExpected, 0);
    const totalCorrect = rows.reduce((s, r) => s + r.filesCorrect, 0);
    const totalToolCalls = rows.reduce((s, r) => s + r.toolCalls.length, 0);
    const errors = rows.filter((r) => r.errors.length).length;
    const avgTtft = Math.round(
      rows.filter((r) => r.ttftMs > 0).reduce((s, r) => s + r.ttftMs, 0) /
        Math.max(1, rows.filter((r) => r.ttftMs > 0).length),
    );
    const avgTotal = Math.round(rows.reduce((s, r) => s + r.totalMs, 0) / rows.length);

    console.log(`${model}`);
    console.log(
      `  files:   ${totalCorrect}/${totalExpected}  | tool calls: ${totalToolCalls}  | errors: ${errors}`,
    );
    console.log(`  latency: ttft ${avgTtft}ms | total ${avgTotal}ms (avg)\n`);
    for (const r of rows) {
      const icon = r.errors.length
        ? "❌"
        : r.filesExpected === 0
          ? "✅"
          : r.filesCorrect === r.filesExpected
            ? "✅"
            : r.filesCorrect > 0
              ? "⚠️ "
              : "❌";
      console.log(
        `  ${icon} [${r.queryId.padEnd(15)}] ${r.filesCorrect}/${r.filesExpected} files, ${r.toolCalls.length} calls, ${r.totalMs}ms`,
      );
    }
    console.log();
  }

  // ── Diff highlight: parallel + reasoning behavior ─────────────
  const parallel15 = all.find((r) => r.queryId === "parallel" && r.model === "gpt-realtime-1.5");
  const parallel2 = all.find((r) => r.queryId === "parallel" && r.model === "gpt-realtime-2");
  if (parallel15 && parallel2) {
    console.log("Δ Parallel tool calls (v2 feature):");
    console.log(`   1.5 → ${parallel15.toolCalls.length} calls in one turn`);
    console.log(`   2   → ${parallel2.toolCalls.length} calls in one turn\n`);
  }
  const reason15 = all.find((r) => r.queryId === "reasoning-high" && r.model === "gpt-realtime-1.5");
  const reason2 = all.find((r) => r.queryId === "reasoning-high" && r.model === "gpt-realtime-2");
  if (reason15 && reason2) {
    console.log("Δ reasoning.effort=high (v2 knob):");
    console.log(
      `   1.5 → session accepted: ${reason15.sessionUpdateAccepted}, errors: ${reason15.errors.length}`,
    );
    console.log(
      `   2   → session accepted: ${reason2.sessionUpdateAccepted}, errors: ${reason2.errors.length}\n`,
    );
  }

  // ── Persist ────────────────────────────────────────────────────
  const ts = Date.now();
  const out = `${__dirname}/results/realtime-2-vs-15-ab-${ts}.json`;
  const { mkdirSync, writeFileSync } = require("fs");
  mkdirSync(`${__dirname}/results`, { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        experiment: "realtime-2-vs-1.5-upgrade-verification",
        models: MODELS,
        queries: QUERIES,
        results: all,
      },
      null,
      2,
    ),
  );
  console.log(`Results saved → ${out}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
