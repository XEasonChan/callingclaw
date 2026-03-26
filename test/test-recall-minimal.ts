/**
 * Minimal Recall.ai Audio Test
 *
 * Purpose: Verify that Recall.ai bot can join a meeting and play audio
 * from the CallingClaw voice-recall.html Output Media page.
 *
 * Prerequisites:
 *   1. Recall.ai API key (sign up at https://recall.ai — free 5 hrs)
 *   2. Cloudflare Tunnel running:
 *        cloudflared tunnel --url http://localhost:4000
 *   3. CallingClaw backend running:
 *        cd callingclaw-backend && bun --hot run src/callingclaw.ts
 *
 * What it does:
 *   1. Creates a Recall bot pointing to your meeting URL
 *   2. Bot joins meeting with Output Media = voice-recall.html (via tunnel)
 *   3. voice-recall.html auto-starts → connects to backend → starts AI voice
 *   4. You join the same meeting → hear AI respond to what you say
 *
 * Usage:
 *   RECALL_API_KEY=xxx RECALL_TUNNEL_URL=https://xxx.trycloudflare.com \
 *   MEET_URL=https://meet.google.com/xxx bun run test/test-recall-minimal.ts
 */

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const TUNNEL_URL = process.env.RECALL_TUNNEL_URL;
const MEET_URL = process.env.MEET_URL;
const REGION = process.env.RECALL_REGION || "us-west-2";

if (!RECALL_API_KEY || !TUNNEL_URL || !MEET_URL) {
  console.error(`
Usage:
  RECALL_API_KEY=xxx \\
  RECALL_TUNNEL_URL=https://xxx.trycloudflare.com \\
  MEET_URL=https://meet.google.com/xxx-xxx-xxx \\
  bun run test/test-recall-minimal.ts

Prerequisites:
  1. Sign up at https://recall.ai (free 5 hrs)
  2. Start Cloudflare Tunnel:
       cloudflared tunnel --url http://localhost:4000
  3. Start CallingClaw backend:
       cd callingclaw-backend && bun --hot run src/callingclaw.ts
`);
  process.exit(1);
}

const BASE_URL = `https://${REGION}.recall.ai/api/v1`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function recallFetch(path: string, method: string, body?: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Token ${RECALL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Recall ${method} ${path}: ${res.status} ${text}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  CallingClaw — Minimal Recall.ai Audio Test");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Meet URL:    ${MEET_URL}`);
  console.log(`  Tunnel URL:  ${TUNNEL_URL}`);
  console.log(`  Region:      ${REGION}`);
  console.log("═══════════════════════════════════════════════\n");

  // ── Step 1: Verify tunnel is reachable ──
  console.log("[1/4] Verifying tunnel...");
  try {
    const res = await fetch(`${TUNNEL_URL}/api/status`);
    if (res.ok) {
      console.log("  ✅ Tunnel reachable, backend running");
    } else {
      console.log(`  ⚠️ Tunnel reachable but backend returned ${res.status}`);
    }
  } catch (e: any) {
    console.error("  ❌ Tunnel not reachable:", e.message);
    console.error("  Run: cloudflared tunnel --url http://localhost:4000");
    process.exit(1);
  }

  // ── Step 2: Verify Output Media page is accessible ──
  console.log("[2/4] Verifying voice-recall.html...");
  try {
    const pageUrl = `${TUNNEL_URL}/voice-recall.html?backend=${encodeURIComponent(TUNNEL_URL.replace('https://', 'wss://'))}`;
    const res = await fetch(pageUrl);
    if (res.ok) {
      console.log("  ✅ voice-recall.html accessible via tunnel");
      console.log(`  URL: ${pageUrl}`);
    } else {
      console.error(`  ❌ voice-recall.html returned ${res.status}`);
      process.exit(1);
    }
  } catch (e: any) {
    console.error("  ❌ Cannot access voice-recall.html:", e.message);
    process.exit(1);
  }

  // ── Step 3: Create Recall bot ──
  console.log("[3/4] Creating Recall bot...");
  const outputUrl = `${TUNNEL_URL}/voice-recall.html?backend=${encodeURIComponent(TUNNEL_URL.replace('https://', 'wss://'))}`;

  const bot = await recallFetch("/bot/", "POST", {
    meeting_url: MEET_URL,
    bot_name: "CallingClaw-Test",
    output_media: {
      camera: {
        kind: "webpage",
        config: { url: outputUrl },
      },
    },
  });

  console.log(`  ✅ Bot created: ${bot.id}`);
  console.log(`  Status: ${bot.status_changes?.[0]?.code || 'creating'}`);

  // ── Step 4: Poll bot status ──
  console.log("[4/4] Polling bot status (Ctrl+C to stop)...\n");

  let lastStatus = "";
  while (true) {
    try {
      const status = await recallFetch(`/bot/${bot.id}/`, "GET");
      const currentStatus = status.status_changes?.[status.status_changes.length - 1]?.code || "unknown";

      if (currentStatus !== lastStatus) {
        console.log(`  [${new Date().toISOString().substr(11, 8)}] Status: ${currentStatus}`);
        lastStatus = currentStatus;

        if (currentStatus === "in_call_recording") {
          console.log("\n  ═══════════════════════════════════════");
          console.log("  ✅ BOT IS IN THE MEETING AND RECORDING!");
          console.log("");
          console.log("  → Join the meeting from your browser/phone");
          console.log("  → Speak — the AI should respond");
          console.log("  → voice-recall.html is running in Recall's container");
          console.log("  → Audio flows: You → Recall → webpage → backend → AI → back");
          console.log("  ═══════════════════════════════════════\n");
        }

        if (currentStatus === "done" || currentStatus === "fatal") {
          console.log("\n  Bot session ended:", currentStatus);
          if (status.status_changes) {
            console.log("  Full status history:");
            for (const sc of status.status_changes) {
              console.log(`    ${sc.created_at}: ${sc.code}${sc.sub_code ? ' (' + sc.sub_code + ')' : ''}`);
            }
          }
          break;
        }
      }
    } catch (e: any) {
      console.log(`  [poll error] ${e.message}`);
    }
    await wait(3000);
  }
}

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n\nCleaning up...");
  // Could delete bot here but let it end naturally
  process.exit(0);
});

main().catch(e => {
  console.error("Test failed:", e.message);
  process.exit(1);
});
