#!/usr/bin/env bun
/**
 * Text Simulation Eval — 用 gpt-realtime-1.5 text mode 验证 compiled narration
 *
 * 不需要开会议，每轮 <5s，可以 1 小时跑 100+ 轮实验。
 * 验证：注入 compiled narration 后 voice model 的回复质量。
 *
 * Usage:
 *   bun run test/experiments/text-simulation-eval.ts
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY
  || (() => { try { return require("fs").readFileSync("../../.env", "utf-8").match(/^OPENAI_API_KEY=(.+)$/m)?.[1]; } catch { return ""; } })();

if (!OPENAI_KEY) { console.error("❌ OPENAI_API_KEY not found"); process.exit(1); }

// Load compiled presentation
const COMPILED = JSON.parse(require("fs").readFileSync(
  require("os").homedir() + "/.callingclaw/shared/launch_video_brief_compiled.json", "utf-8"
));

// ── Core Identity (copied from production prompt-constants.ts) ──
const CORE_IDENTITY = `You are CallingClaw, a voice AI in meetings. You have an agent, a screen, and a memory.

**PRESENTER mode** (you prepared the content, you drive the presentation):
- You have a topic outline (not a fixed script). Deliver section by section, advancing slides/pages in sync.
- Within a section: keep talking, describe what's on screen. Don't ask "想了解更多吗" mid-section.
- Between sections: brief pause — "这部分就到这里，有问题吗？" Wait a moment. No response = continue.
- CRITICAL: When a participant speaks or asks a question, PAUSE your presentation and respond to them first. Then say "好的，我们继续" and resume.
- Describe what the audience SHOULD UNDERSTAND from this section, not what the text literally says. Connect to business value.
- NEVER say the same sentence twice. NEVER read screen text verbatim.`;

// ── Eval metrics ──
interface EvalResult {
  section: number;
  narration_injected: string;
  model_response: string;
  // Quality checks
  has_insight: boolean;      // contains why/because/value words
  no_verbatim: boolean;      // doesn't copy narration verbatim
  appropriate_length: boolean; // 50-300 chars
  in_chinese: boolean;       // responds in Chinese
  no_filler: boolean;        // no "需要我介绍吗"
  // Score
  score: number;
}

// ── WebSocket-based Realtime text eval ──
async function evalSection(sectionIdx: number, userMessage?: string): Promise<EvalResult> {
  const section = COMPILED.sections[sectionIdx];
  if (!section) throw new Error(`Section ${sectionIdx} not found`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5`, {
      headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
    });

    const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 15000);
    let fullText = "";
    let sessionReady = false;

    ws.onopen = () => {
      // Session setup
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-1.5",
          output_modalities: ["text"],
          instructions: CORE_IDENTITY,
        },
      }));
    };

    ws.onmessage = (e: any) => {
      const d = JSON.parse(e.data);

      if (d.type === "session.updated") {
        sessionReady = true;

        // Step 1: Inject compiled narration as system context
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: `[PRESENT NOW] 你正在投屏演示"${section.title}"这个部分。请用你自己的话自然地讲述以下内容，加入你的理解和 insight，不要逐字复读:\n\n${section.narration_full}` }],
          },
        }));

        // Step 2: Send user message (or default trigger)
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: userMessage || "请开始介绍这个部分" }],
          },
        }));

        // Step 3: Trigger response
        ws.send(JSON.stringify({ type: "response.create" }));
      }

      // Collect text response
      if (d.type === "response.output_text.delta" && d.delta) {
        fullText += d.delta;
      }

      if (d.type === "response.output_text.done" || d.type === "response.done") {
        if (!fullText && d.text) fullText = d.text;
        if (!fullText) return; // might get response.done before text.done

        clearTimeout(timeout);
        ws.close();

        // Evaluate quality
        const result: EvalResult = {
          section: sectionIdx,
          narration_injected: section.narration_full.slice(0, 100) + "...",
          model_response: fullText,
          has_insight: /因为|所以|价值|意义|核心|关键|本质|差异化|优势|原因|背后|深层/.test(fullText),
          no_verbatim: !isVerbatimCopy(section.narration_full, fullText),
          appropriate_length: fullText.length >= 50 && fullText.length <= 500,
          in_chinese: /[\u4e00-\u9fff]/.test(fullText) && (fullText.match(/[\u4e00-\u9fff]/g)?.length || 0) > fullText.length * 0.1,
          no_filler: !/需要我.*介绍|想了解.*更多|你可以告诉我|有什么.*问题/.test(fullText),
          score: 0,
        };

        // Calculate score
        result.score = [result.has_insight, result.no_verbatim, result.appropriate_length, result.in_chinese, result.no_filler]
          .filter(Boolean).length * 20; // 5 checks × 20 = max 100

        resolve(result);
      }

      if (d.type === "error") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(JSON.stringify(d.error)));
      }
    };

    ws.onerror = (e: any) => { clearTimeout(timeout); reject(new Error("ws error")); };
  });
}

// Check if model response is a verbatim copy of narration
function isVerbatimCopy(narration: string, response: string): boolean {
  // Split into sentences, check if >50% of response sentences appear verbatim in narration
  const responseSentences = response.split(/[。！？.!?\n]/).filter(s => s.length > 10);
  if (responseSentences.length === 0) return false;
  const narrationLower = narration.toLowerCase();
  const verbatimCount = responseSentences.filter(s => narrationLower.includes(s.toLowerCase().trim())).length;
  return verbatimCount / responseSentences.length > 0.5;
}

// ── Main ──
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Text Simulation Eval — Compiled Narration Quality Test    ║
║  Model: gpt-realtime-1.5 (text mode, same as production)  ║
╚════════════════════════════════════════════════════════════╝
`);
  console.log(`Sections: ${COMPILED.sections.length}`);
  console.log(`Topic: ${COMPILED.topic}\n`);

  const results: EvalResult[] = [];

  // Test each section
  for (let i = 0; i < COMPILED.sections.length; i++) {
    const section = COMPILED.sections[i];
    process.stdout.write(`  Section ${i + 1}/${COMPILED.sections.length}: "${section.title}" ... `);

    try {
      const result = await evalSection(i);
      results.push(result);

      const icons = [
        result.has_insight ? "✅" : "❌",
        result.no_verbatim ? "✅" : "🔁",
        result.appropriate_length ? "✅" : "📏",
        result.in_chinese ? "✅" : "🌐",
        result.no_filler ? "✅" : "🔁",
      ].join("");
      console.log(`${result.score}% ${icons}`);
      console.log(`    "${result.model_response.slice(0, 100)}..."\n`);
    } catch (e: any) {
      console.log(`❌ ${e.message}`);
      results.push({
        section: i, narration_injected: "", model_response: "", has_insight: false,
        no_verbatim: false, appropriate_length: false, in_chinese: false, no_filler: false, score: 0,
      });
    }
  }

  // Also test interruption handling
  console.log("  --- Interruption Test ---");
  process.stdout.write(`  Section 3 + user interrupts with "Pika 的定价是多少?" ... `);
  try {
    const interruptResult = await evalSection(2, "等一下，Pika 的定价是多少？和我们差多少？");
    console.log(`${interruptResult.score}%`);
    console.log(`    "${interruptResult.model_response.slice(0, 120)}..."\n`);
    // Check if it answers the question (mentions Pika pricing)
    const answersQuestion = /Pika|0\.5|0\.50|每分钟|per.min/i.test(interruptResult.model_response);
    console.log(`    Answers user question: ${answersQuestion ? "✅" : "❌"}`);
  } catch (e: any) {
    console.log(`❌ ${e.message}`);
  }

  // Summary
  const avgScore = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
    : 0;

  console.log(`
═══════════════════════════════════════════
  AVG SCORE: ${avgScore}%
  Insight:   ${results.filter(r => r.has_insight).length}/${results.length}
  Original:  ${results.filter(r => r.no_verbatim).length}/${results.length}
  Length OK: ${results.filter(r => r.appropriate_length).length}/${results.length}
  Chinese:   ${results.filter(r => r.in_chinese).length}/${results.length}
  No filler: ${results.filter(r => r.no_filler).length}/${results.length}
═══════════════════════════════════════════
`);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
