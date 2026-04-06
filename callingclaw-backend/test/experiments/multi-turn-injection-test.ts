#!/usr/bin/env bun
/**
 * EXP-7C: Multi-turn Injection Test
 *
 * Tests the core mechanism: can we feed compiled narration sections
 * one at a time via replaceContext, and the model stays coherent?
 *
 * Checks:
 * 1. Model receives and uses each section's content
 * 2. Model doesn't repeat content from previous sections
 * 3. Model knows its progress (section N of M)
 * 4. Model handles user interruption mid-presentation
 * 5. Model resumes correctly after interruption
 *
 * Uses gpt-realtime-1.5 text mode (same as production, <5s per turn)
 */

const OPENAI_KEY = (() => { try { return require("fs").readFileSync("../../.env", "utf-8").match(/^OPENAI_API_KEY=(.+)$/m)?.[1]; } catch { return process.env.OPENAI_API_KEY || ""; } })();
const COMPILED = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.callingclaw/shared/launch_video_brief_compiled.json", "utf-8"));

const SYSTEM_PROMPT = `You are CallingClaw, a voice AI presenting in a meeting. You have prepared content for each section. Present each section naturally — like a senior PM briefing their boss. Don't say "我来讲一下为什么" — just speak the insight directly. Cite specific numbers. When you finish a section, wait for the next one. If interrupted, answer the question then resume.`;

// ── WebSocket client that stays connected for multi-turn ──
class RealtimeTextClient {
  private ws: WebSocket | null = null;
  private responseResolve: ((text: string) => void) | null = null;
  private responseText = "";
  private connected = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5`, {
        headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
      });
      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({
          type: "session.update",
          session: { type: "realtime", model: "gpt-realtime-1.5", output_modalities: ["text"], instructions: SYSTEM_PROMPT },
        }));
      };
      this.ws.onmessage = (e: any) => {
        const d = JSON.parse(e.data);
        if (d.type === "session.updated") { this.connected = true; resolve(); }
        if (d.type === "response.output_text.delta" && d.delta) { this.responseText += d.delta; }
        if (d.type === "response.output_text.done" || (d.type === "response.done" && this.responseText)) {
          if (this.responseResolve) { this.responseResolve(this.responseText); this.responseResolve = null; }
        }
        if (d.type === "error") { console.error("WS error:", d.error?.message); }
      };
      this.ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("connect timeout")), 10000);
    });
  }

  // Inject system context (silent, no response triggered)
  inject(text: string, id?: string) {
    this.ws?.send(JSON.stringify({
      type: "conversation.item.create",
      item: { id, type: "message", role: "system", content: [{ type: "input_text", text }] },
    }));
  }

  // Delete a context item
  remove(id: string) {
    this.ws?.send(JSON.stringify({ type: "conversation.item.delete", item_id: id }));
  }

  // Replace context (delete old + inject new with same ID)
  replace(text: string, id: string) {
    this.remove(id);
    this.inject(text, id);
  }

  // Send user message and get response
  async chat(text: string): Promise<string> {
    this.responseText = "";
    return new Promise((resolve, reject) => {
      this.responseResolve = resolve;
      this.ws?.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }));
      this.ws?.send(JSON.stringify({ type: "response.create" }));
      setTimeout(() => { if (this.responseResolve) { this.responseResolve(this.responseText || "(timeout)"); this.responseResolve = null; } }, 20000);
    });
  }

  // Trigger response without user message (model continues from context)
  async respond(): Promise<string> {
    this.responseText = "";
    return new Promise((resolve) => {
      this.responseResolve = resolve;
      this.ws?.send(JSON.stringify({ type: "response.create" }));
      setTimeout(() => { if (this.responseResolve) { this.responseResolve(this.responseText || "(timeout)"); this.responseResolve = null; } }, 20000);
    });
  }

  close() { this.ws?.close(); }
}

// ── Main test ──
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  EXP-7C: Multi-Turn Injection Test                         ║
║  6 sections, sequential inject-present-replace cycle       ║
╚════════════════════════════════════════════════════════════╝
`);

  const client = new RealtimeTextClient();
  await client.connect();
  console.log("✅ Connected to gpt-realtime-1.5 (text mode)\n");

  const SLIDE_ID = "current_slide";
  const PROGRESS_ID = "presentation_progress";
  const responses: string[] = [];
  const sections = COMPILED.sections;

  // Primer: establish the presentation framework before Section 1
  client.inject(`[PRESENTATION] 你即将进行一个 ${sections.length} 部分的汇报，主题是"${COMPILED.topic}"。每次我会给你一个 [PRESENT NOW] 的内容块，你只讲那个部分的内容。不要自由发挥或编造数据，所有数字和事实都在提供的内容里。`);
  const primerResponse = await client.chat("好的，我准备好了，请给我第一部分的内容");
  console.log(`Primer: "${primerResponse.slice(0, 80)}..."\n`);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const progress = `[PROGRESS] Section ${i + 1}/${sections.length}: "${section.title}". ${i > 0 ? `已讲完: ${sections.slice(0, i).map((s: any) => s.title).join(", ")}` : "这是第一部分。"}`;

    // 1. Inject/replace slide context (fixed ID, only 1 item)
    if (i === 0) {
      // First section: inject (no delete needed)
      client.inject(`[PRESENT NOW] ${section.title}\n\n${section.narration_full}`, SLIDE_ID);
      client.inject(progress, PROGRESS_ID);
    } else {
      // Subsequent sections: replace (delete old + inject new)
      client.replace(`[PRESENT NOW] ${section.title}\n\n${section.narration_full}`, SLIDE_ID);
      client.replace(progress, PROGRESS_ID);
    }

    // 3. Wait for server to process the injected context before triggering response
    await new Promise(r => setTimeout(r, 800));

    // 4. Trigger model to present
    process.stdout.write(`Section ${i + 1}/${sections.length}: "${section.title}" ... `);
    const response = await client.chat(i === 0 ? `请介绍第一部分` : `好的，请继续介绍下一部分："${section.title}"`);
    responses.push(response);
    console.log(`${response.length} chars`);
    console.log(`  "${response.slice(0, 120)}..."\n`);

    // 4. Check: mid-presentation interruption (only on section 3)
    if (i === 2) {
      console.log("  --- USER INTERRUPTS ---");
      const interruptResponse = await client.chat("等一下，Pika 的定价到底是多少？我记得我们有这个数据的");
      console.log(`  Interrupt response: "${interruptResponse.slice(0, 120)}..."\n`);

      // Check if model answers AND then indicates resumption
      const answeredPika = /Pika|0\.5|定价/.test(interruptResponse);
      const resumeSignal = /继续|回到|刚才|接着/.test(interruptResponse);
      console.log(`  Answers Pika question: ${answeredPika ? "✅" : "❌"}`);
      console.log(`  Resume signal: ${resumeSignal ? "✅" : "❌"}\n`);
    }
  }

  client.close();

  // ── Evaluate multi-turn coherence ──
  console.log("═══════════════════════════════════════════");
  console.log("  MULTI-TURN COHERENCE CHECK");
  console.log("═══════════════════════════════════════════\n");

  // Check 1: No repetition between sections
  let repetitionCount = 0;
  for (let i = 1; i < responses.length; i++) {
    const prev = responses[i - 1]!;
    const curr = responses[i]!;
    // Check if >30% of current response's sentences appear in previous
    const currSentences = curr.split(/[。！？\n]/).filter(s => s.length > 15);
    const prevLower = prev.toLowerCase();
    const repeated = currSentences.filter(s => prevLower.includes(s.toLowerCase().trim()));
    if (repeated.length > currSentences.length * 0.3) {
      repetitionCount++;
      console.log(`  ❌ Section ${i + 1} repeats Section ${i}: "${repeated[0]?.slice(0, 60)}"`);
    }
  }
  if (repetitionCount === 0) console.log("  ✅ No repetition between sections");

  // Check 2: Each response references its own section content
  let relevanceCount = 0;
  for (let i = 0; i < responses.length; i++) {
    const section = sections[i];
    const keyTerms = (section.key_points || []).flatMap((kp: string) =>
      kp.match(/\d+/g) || kp.split(/[\s/|,、]+/).filter((w: string) => w.length >= 2)
    );
    const mentioned = keyTerms.some((t: string) => responses[i]!.includes(t));
    if (mentioned) { relevanceCount++; }
    else { console.log(`  ⚠️ Section ${i + 1} missing key terms from: ${keyTerms.join(", ")}`); }
  }
  console.log(`  Relevance: ${relevanceCount}/${responses.length} sections reference their content`);

  // Check 3: Response length trend (should be consistent, not degrade)
  const lengths = responses.map(r => r.length);
  const avgLen = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const minLen = Math.min(...lengths);
  console.log(`  Avg length: ${avgLen} chars (min: ${minLen})`);
  console.log(`  Length degradation: ${minLen < avgLen * 0.3 ? "❌ DEGRADED" : "✅ OK"}`);

  console.log("");
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
