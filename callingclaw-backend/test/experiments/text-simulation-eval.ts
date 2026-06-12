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

// ── Eval metrics (Why-What-How framework) ──
interface EvalResult {
  section: number;
  title: string;
  model_response: string;
  // Why-What-How quality (each 0-2, judged by Opus post-hoc)
  why_score: number;         // 0=missing, 1=mentioned, 2=clear reasoning with business context
  what_score: number;        // 0=missing, 1=vague, 2=specific content/decision/data
  how_score: number;         // 0=missing, 1=mentioned, 2=clear steps/flow/mechanism
  // Presentation quality
  no_verbatim: boolean;      // doesn't copy narration verbatim (>50% overlap)
  in_chinese: boolean;       // responds in Chinese
  no_filler: boolean;        // no "需要我介绍吗" / "你想了解吗"
  natural_flow: boolean;     // has transitions, not just bullet points
  // Score (out of 100)
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

        // Step 1: Inject compiled narration + FAQ as system context
        // FAQ injected as separate context (not in narration prompt — model ignores inline FAQ)
        if (section.faq?.length > 0) {
          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text: `[DATA] 以下是与"${section.title}"相关的真实数据:\n${section.faq.map((f: any) => `• ${f.q} → ${f.a}`).join("\n")}` }],
            },
          }));
        }
        // Narration prompt — natural, conversational, cite specific data
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: `[PRESENT NOW] 你正在投屏演示"${section.title}"。像一个资深 PM 给老板做汇报一样讲——直接进入内容，引用具体数字，不要先声明"我来讲为什么"。通过讲事实和数据自然传达动机和价值，而不是模板化的 Why-What-How 段落。保持对话感。\n\n你要讲的内容:\n${section.narration_full}` }],
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

        // Evaluate quality — Why-What-How framework
        const result: EvalResult = {
          section: sectionIdx,
          title: section.title,
          model_response: fullText,
          // Why-What-How scored post-hoc (0-2 each)
          why_score: scoreWhy(fullText, section),
          what_score: scoreWhat(fullText, section),
          how_score: scoreHow(fullText, section),
          // Presentation quality
          no_verbatim: !isVerbatimCopy(section.narration_full, fullText),
          in_chinese: /[\u4e00-\u9fff]/.test(fullText) && (fullText.match(/[\u4e00-\u9fff]/g)?.length || 0) > fullText.length * 0.1,
          no_filler: !/需要我.*介绍|想了解.*更多|你可以告诉我/.test(fullText),
          natural_flow: /首先|接下来|然后|最后|另外|不过|所以|总的来说|简单来说/.test(fullText),
          score: 0,
        };

        // Score: Why(25) + What(25) + How(25) + quality checks(25)
        const whyWhatHow = ((result.why_score + result.what_score + result.how_score) / 6) * 75;
        const quality = [result.no_verbatim, result.in_chinese, result.no_filler, result.natural_flow]
          .filter(Boolean).length * 6.25; // 4 checks × 6.25 = 25
        result.score = Math.round(whyWhatHow + quality);

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

// ── Why-What-How Scoring ──
// Each returns 0-2: 0=missing, 1=mentioned but shallow, 2=clear with specifics

function scoreWhy(response: string, section: any): number {
  // Why = motivation, business reason, problem being solved
  const whyPatterns = /为什么|原因|因为|目的|背景|问题是|痛点|需求|动机|差异化|核心.*定位|价值.*在于/;
  const hasBusinessContext = /用户|市场|竞品|成本|效率|收入|ROI|客户|开发者|企业/.test(response);
  if (!whyPatterns.test(response)) return 0;
  return hasBusinessContext ? 2 : 1;
}

function scoreWhat(response: string, section: any): number {
  // What = specific content, data, decisions discussed in this section
  // Match individual words/numbers from key_points, not full phrases
  const keyPoints = section.key_points || [];
  if (keyPoints.length === 0) return 1; // no key points defined = pass

  let matchedPoints = 0;
  for (const kp of keyPoints) {
    // Extract numbers and key terms from the key point
    const numbers = kp.match(/\d+/g) || [];
    const terms = kp.replace(/\d+/g, "").split(/[\s/|,、·]+/).filter((w: string) => w.length >= 2);
    // Match if ANY number from key point appears in response, OR any term matches
    const numMatch = numbers.some((n: string) => response.includes(n));
    const termMatch = terms.some((t: string) => response.toLowerCase().includes(t.toLowerCase()));
    if (numMatch || termMatch) matchedPoints++;
  }

  if (matchedPoints === 0) return 0;
  return matchedPoints >= keyPoints.length * 0.5 ? 2 : 1;
}

function scoreHow(response: string, section: any): number {
  // How = process, steps, mechanism, implementation approach
  const howPatterns = /流程|步骤|方式|方案|具体|实现|操作|首先.*然后|第一.*第二|做法|实施/;
  const hasSequence = /首先|第一|接下来|然后|最后|第[一二三四五六]/.test(response);
  if (!howPatterns.test(response) && !hasSequence) return 0;
  return hasSequence ? 2 : 1;
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

      const w = result.why_score === 2 ? "✅" : result.why_score === 1 ? "⚠️" : "❌";
      const wh = result.what_score === 2 ? "✅" : result.what_score === 1 ? "⚠️" : "❌";
      const h = result.how_score === 2 ? "✅" : result.how_score === 1 ? "⚠️" : "❌";
      console.log(`${result.score}%  Why:${w} What:${wh} How:${h}  orig:${result.no_verbatim?"✅":"🔁"} flow:${result.natural_flow?"✅":"❌"}`);
      console.log(`    "${result.model_response.slice(0, 120)}..."\n`);
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
  const avgWhy = results.length > 0 ? (results.reduce((s, r) => s + r.why_score, 0) / results.length).toFixed(1) : "0";
  const avgWhat = results.length > 0 ? (results.reduce((s, r) => s + r.what_score, 0) / results.length).toFixed(1) : "0";
  const avgHow = results.length > 0 ? (results.reduce((s, r) => s + r.how_score, 0) / results.length).toFixed(1) : "0";

  console.log(`
═══════════════════════════════════════════
  AVG SCORE: ${avgScore}%
  Why:       ${avgWhy}/2  (motivation, business context)
  What:      ${avgWhat}/2  (specific content, key points)
  How:       ${avgHow}/2  (process, steps, mechanism)
  Original:  ${results.filter(r => r.no_verbatim).length}/${results.length}
  Chinese:   ${results.filter(r => r.in_chinese).length}/${results.length}
  No filler: ${results.filter(r => r.no_filler).length}/${results.length}
  Flow:      ${results.filter(r => r.natural_flow).length}/${results.length}
═══════════════════════════════════════════
`);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
