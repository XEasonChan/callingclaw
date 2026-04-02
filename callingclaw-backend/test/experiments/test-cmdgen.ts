import { CONFIG } from "../../src/config.ts";
console.log("Anthropic:", CONFIG.anthropic.apiKey ? "YES" : "NO");
console.log("OpenRouter:", CONFIG.openrouter?.apiKey ? "YES" : "NO");

import { generateOpenCLICommand } from "../../src/modules/opencli-command-gen.ts";

const tests = [
  "check trending on HackerNews",
  "search arxiv for voice AI",
  "看看 Google 新闻",
  "what is the weather",
];

for (const t of tests) {
  const start = performance.now();
  const result = await generateOpenCLICommand(t);
  const ms = Math.round(performance.now() - start);
  if (result) {
    console.log(`[${ms}ms] "${t}" → ${result.command} (${result.confidence})`);
  } else {
    console.log(`[${ms}ms] "${t}" → NONE`);
  }
}
