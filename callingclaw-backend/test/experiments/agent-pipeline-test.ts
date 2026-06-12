#!/usr/bin/env bun
/**
 * EXP-7D: Agent Pipeline Simulation
 *
 * Tests the FULL chain: Realtime transcript → Haiku intent classification → action
 * Uses gpt-4o-mini as Haiku stand-in (same intent classification prompt).
 *
 * Simulates a multi-turn presentation where:
 * 1. Realtime model presents content (text mode)
 * 2. User gives voice commands mid-presentation
 * 3. Haiku classifies intent from transcript
 * 4. Verifies correct action is identified
 */

const OPENAI_KEY = (() => { try { return require("fs").readFileSync("../../.env", "utf-8").match(/^OPENAI_API_KEY=(.+)$/m)?.[1]; } catch { return process.env.OPENAI_API_KEY || ""; } })();

// ── Haiku intent classification prompt (copied from TranscriptAuditor) ──
const HAIKU_SYSTEM = `You are CallingClaw's meeting agent — a fast background assistant. You monitor the conversation and execute actions when the voice AI or participants request something.

## Your Tools
- **click**: Click a button/link on the presenting page. Params: { "selector": "text", "targetTab": "presenting" }
- **scroll**: Scroll the presenting page. Params: { "direction": "up"|"down", "targetTab": "presenting" }
- **share_url**: Present a URL in the meeting. Params: { "url": "https://..." }
- **share_file**: Search and present a file. Params: { "query": "keywords" }
- **search_and_open**: Search for a file by name. Params: { "query": "keywords" }
- **navigate**: Navigate presenting page. Params: { "url": "..." }
- **stop_sharing**: Stop presenting. Params: {}

## When to Act
1. Someone says "打开/open/show/投屏" + a thing → ACT
2. Someone says "点击/click" → ACT (click)
3. Someone says "往下/scroll down/翻页" → ACT (scroll)
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT
5. Discussion/opinion → DO NOT ACT, confidence=0
6. If [Tool Call] already in transcript for same action → DO NOT ACT

Respond with JSON only:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<brief>"}`;

// ── Test scenarios ──
interface Scenario {
  id: string;
  transcript: string;           // simulated conversation context
  userCommand: string;          // the voice command to classify
  expectedAction: string;       // what Haiku should output
  expectedParams: Record<string, any>;  // expected params
}

const SCENARIOS: Scenario[] = [
  {
    id: "D-01",
    transcript: "[assistant] 大家好，今天来汇报 CallingClaw 上线视频计划。\n[user] 好的，开始吧",
    userCommand: "帮我投屏 CallingClaw 官网",
    expectedAction: "share_url",
    expectedParams: { url: /callingclaw\.com/i },
  },
  {
    id: "D-02",
    transcript: "[assistant] 现在大家看到的是官网首页...\n[user] 好的",
    userCommand: "往下滚动一下",
    expectedAction: "scroll",
    expectedParams: { direction: "down" },
  },
  {
    id: "D-03",
    transcript: "[assistant] 首页介绍完了，下面有 Features 链接\n[user] 嗯",
    userCommand: "点击 Features",
    expectedAction: "click",
    expectedParams: { selector: /features/i },
  },
  {
    id: "D-04",
    transcript: "[assistant] Features 页面展示了核心功能...\n[user] 好",
    userCommand: "帮我打开那个 launch video 的文件",
    expectedAction: "search_and_open",
    expectedParams: { query: /launch.*video|video.*launch/i },
  },
  {
    id: "D-05",
    transcript: "[assistant] 正在介绍竞品对比部分...\n[user] 这个不错",
    userCommand: "切换投屏到 Google，搜一下 manus AI",
    expectedAction: "share_url",
    expectedParams: { url: /google.*manus|manus/i },
  },
  {
    id: "D-06",
    transcript: "[assistant] 已经投屏了 Google 搜索页面\n[user] 嗯好",
    userCommand: "好的，停止投屏吧",
    expectedAction: "stop_sharing",
    expectedParams: {},
  },
  {
    id: "D-07",
    transcript: "[assistant] 这个方案的核心是本地运行...\n[user]",
    userCommand: "我觉得这个定价策略挺好的，继续吧",
    expectedAction: null, // should NOT act — this is an opinion
    expectedParams: {},
  },
  {
    id: "D-08",
    transcript: "[assistant] 我让 agent 帮你查一下那个文件\n[user] 好的",
    userCommand: "CallingClaw 说它让 agent 查文件",
    expectedAction: "search_and_open",
    expectedParams: { query: /.+/ },
  },
];

// ── Run Haiku classification ──
// Use Realtime 1.5 text mode for intent classification (chat completions blocked by network)
async function classifyIntent(transcript: string, userCommand: string): Promise<any> {
  const fullTranscript = `${transcript}\n[user] ${userCommand}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5`, {
      headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
    });
    let text = "";
    const timeout = setTimeout(() => { ws.close(); resolve({ action: null, confidence: 0, raw: "timeout" }); }, 15000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: { type: "realtime", model: "gpt-realtime-1.5", output_modalities: ["text"], instructions: HAIKU_SYSTEM },
      }));
    };
    ws.onmessage = (e: any) => {
      const d = JSON.parse(e.data);
      if (d.type === "session.updated") {
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: `## Transcript\n${fullTranscript}\n\nClassify the LAST user message. Respond with JSON only.` }] },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (d.type === "response.output_text.delta" && d.delta) text += d.delta;
      if ((d.type === "response.output_text.done" || d.type === "response.done") && text) {
        clearTimeout(timeout);
        ws.close();
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { action: null, confidence: 0 });
        } catch { resolve({ action: null, confidence: 0, raw: text }); }
      }
      if (d.type === "error") { clearTimeout(timeout); ws.close(); resolve({ action: null, confidence: 0, raw: d.error?.message }); }
    };
    ws.onerror = () => { clearTimeout(timeout); resolve({ action: null, confidence: 0, raw: "ws_error" }); };
  });
}

// ── Main ──
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  EXP-7D: Agent Pipeline Simulation                         ║
║  Transcript → Intent Classification → Action Verification  ║
╚════════════════════════════════════════════════════════════╝
`);

  let passed = 0;
  let total = SCENARIOS.length;

  for (const scenario of SCENARIOS) {
    process.stdout.write(`  ${scenario.id}: "${scenario.userCommand.slice(0, 40)}" → `);

    const result = await classifyIntent(scenario.transcript, scenario.userCommand);
    const action = result.action;
    const confidence = result.confidence || 0;
    const params = result.params || {};

    // Check action matches
    const actionMatch = scenario.expectedAction === null
      ? action === null || confidence < 0.5
      : action === scenario.expectedAction;

    // Check params match (regex or exact)
    let paramsMatch = true;
    for (const [key, expected] of Object.entries(scenario.expectedParams)) {
      const actual = params[key];
      if (expected instanceof RegExp) {
        paramsMatch = paramsMatch && expected.test(String(actual || ""));
      } else {
        paramsMatch = paramsMatch && actual === expected;
      }
    }

    const pass = actionMatch && paramsMatch;
    if (pass) passed++;

    const icon = pass ? "✅" : "❌";
    console.log(`${icon} action=${action || "null"} (expect: ${scenario.expectedAction || "null"}) conf=${confidence}`);
    if (!pass) {
      console.log(`      params=${JSON.stringify(params)} reason=${result.reasoning?.slice(0, 60)}`);
    }
  }

  console.log(`
═══════════════════════════════════════════
  INTENT CLASSIFICATION: ${passed}/${total} (${Math.round(passed / total * 100)}%)
═══════════════════════════════════════════
`);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
