// RavenAdapter tests — uses a fake `raven` binary via RAVEN_BIN so we can
// assert exactly how the adapter invokes the CLI, without a real Raven install.
//
// Raven's `-m` is the MESSAGE/PROMPT (not a model). The adapter must invoke
// `raven agent -m <prompt> -w <cwd> --no-markdown --no-logs` and must NOT pass
// any model flag (model comes from ~/.raven/config.json — design Decision 2).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binDir = mkdtempSync(join(tmpdir(), "raven-bin-"));
const argsFile = join(binDir, "last-args.txt");
const binPath = join(binDir, "raven");

beforeAll(() => {
  // Fake `raven`:
  //   --version                → print a version, exit 0
  //   agent -m ... --slow-test  → sleep long enough to trip the timeout
  //   agent -m ... --fail-test  → print an error line to STDOUT, exit 1
  //                               (mirrors real Raven: on failure it prints
  //                                "Error: No API key configured..." to stdout
  //                                with raw ANSI and exits non-zero)
  //   agent -m ... --ansi-test  → print an ANSI-color-wrapped answer, exit 0
  //   agent -m ... --preamble-test → print Raven's real stdout shape (structlog
  //                               preamble + "🐦‍⬛ Raven" banner + answer), exit 0.
  //                               Mirrors raven v0.1.1: even with --no-logs the
  //                               log lines + banner precede the model answer.
  //   otherwise                → record argv + echo a canned response
  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "raven 0.1.1-test"; exit 0; fi
: > "${argsFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done
for a in "$@"; do
  if [ "$a" = "--slow-test" ]; then sleep 5; fi
  if [ "$a" = "--fail-test" ]; then printf '\\x1b[31mError: No API key configured. Set one in ~/.raven/config.json\\x1b[0m\\n'; exit 1; fi
  if [ "$a" = "--ansi-test" ]; then printf '\\x1b[31mred\\x1b[0m answer \\x1b[1mbold\\x1b[0m text\\n'; exit 0; fi
  if [ "$a" = "--preamble-test" ]; then printf '2026-06-30 23:09:06 [info     ] app_created                    docs_enabled=False\\n2026-06-30 23:09:06 [warning  ] llm_not_configured             hint=set\\nEverosBackend.store failed (LLM is required)\\n\\n\\xf0\\x9f\\x90\\xa6\\xe2\\x80\\x8d\\xe2\\xac\\x9b Raven\\nThe answer is 42.\\nSecond line of the answer.\\n\\n'; exit 0; fi
done
echo "RAVEN_RESPONSE_OK"
`;
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  // Point the adapter at our stub binary (Bun.spawn ignores mutated PATH).
  process.env.RAVEN_BIN = binPath;
  // Pin model envs — these are RESERVED/INERT in v1 (Raven has no model flag),
  // so we assert they are NEVER passed on the CLI regardless of value.
  process.env.RAVEN_PREP_MODEL = "openrouter/test/prep-model";
  process.env.RAVEN_RECALL_MODEL = "openrouter/test/recall-model";
  process.env.RAVEN_TASK_MODEL = "openrouter/test/task-model";
});

afterAll(() => {
  delete process.env.RAVEN_BIN;
  delete process.env.RAVEN_PREP_MODEL;
  delete process.env.RAVEN_RECALL_MODEL;
  delete process.env.RAVEN_TASK_MODEL;
  try { rmSync(binDir, { recursive: true, force: true }); } catch {}
});

// Import AFTER env is set so module-level constants pick up our values.
const { RavenAdapter } = await import("../../src/adapters/raven-adapter");

function lastArgs(): string[] {
  return existsSync(argsFile)
    ? readFileSync(argsFile, "utf-8").split("\n").filter(Boolean)
    : [];
}

// Raw recorded argv (the prompt arg spans multiple lines, so search the whole thing).
function rawArgs(): string {
  return existsSync(argsFile) ? readFileSync(argsFile, "utf-8") : "";
}

test("connect() verifies the raven CLI", async () => {
  const a = new RavenAdapter();
  await a.connect();
  expect(a.connected).toBe(true);
  expect(a.name).toBe("raven");
  a.disconnect();
});

test("generateMeetingPrep invokes `raven agent -m <OC-001 prompt>` with the exact argv", async () => {
  const a = new RavenAdapter();
  const result = await a.generateMeetingPrep({ topic: "Q3 Roadmap", userContext: "with the exec team" });
  expect(result).toBe("RAVEN_RESPONSE_OK");

  const args = lastArgs();
  // Exact argv shape: agent -m <prompt> -w <cwd> --no-markdown --no-logs
  expect(args[0]).toBe("agent");
  expect(args[1]).toBe("-m");
  // The prompt should be an OC-001 meeting-prep prompt mentioning the topic.
  // (The prompt is a single argv element but spans multiple lines, so the stub
  // records it across several lines — search the raw recorded argv.)
  expect(rawArgs()).toContain("Q3 Roadmap");
  expect(args).toContain("-w");
  expect(args).toContain("--no-markdown");
  expect(args).toContain("--no-logs");
  // -w must be followed by Raven's DEDICATED workspace dir — NOT the shared
  // dir (Raven scaffolds memory files into -w, which would pollute the shared
  // dir that Desktop/OpenClaw read).
  expect(args[args.indexOf("-w") + 1]).toBe(`${process.env.HOME}/.callingclaw/raven-workspace`);
});

test("NO model flag is ever passed (Raven picks the model from config)", async () => {
  const a = new RavenAdapter();
  await a.generateMeetingPrep({ topic: "Model Flag Check" });
  const args = lastArgs();
  // The reserved-but-inert model env values must NOT leak onto the command line.
  expect(args).not.toContain("openrouter/test/prep-model");
  expect(args).not.toContain("--model");
  expect(rawArgs()).not.toContain("openrouter/test/prep-model");
});

test("recallContext invokes agent -m with the query, no model flag", async () => {
  const a = new RavenAdapter();
  const result = await a.recallContext("what did we decide about pricing?");
  expect(result).toBe("RAVEN_RESPONSE_OK");
  const args = lastArgs();
  expect(args[0]).toBe("agent");
  expect(args[1]).toBe("-m");
  expect(rawArgs()).toContain("pricing");
  expect(args).not.toContain("openrouter/test/recall-model");
});

test("executeTask passes the instruction as the -m message", async () => {
  const a = new RavenAdapter();
  const result = await a.executeTask("open the design doc");
  expect(result).toBe("RAVEN_RESPONSE_OK");
  const args = lastArgs();
  // The instruction is the message, immediately after `agent -m`.
  expect(args[0]).toBe("agent");
  expect(args[1]).toBe("-m");
  expect(args[2]).toBe("open the design doc");
  expect(args).not.toContain("openrouter/test/task-model");
});

test("runRaven times out and kills the child (no zombie)", async () => {
  // recallContext has a 30s budget; force a shorter timeout via the private
  // runner by driving executeTask against a slow stub is impractical, so we
  // exercise the timeout path directly through the private runner.
  const a = new RavenAdapter() as any;
  const start = Date.now();
  await expect(
    a.runRaven("--slow-test", { timeout: 200 }),
  ).rejects.toThrow(/timeout/i);
  // Should reject at ~the timeout, well before the stub's 5s sleep completes.
  expect(Date.now() - start).toBeLessThan(2000);
});

test("runRaven THROWS on non-zero exit even when error text is on stdout", async () => {
  // Real Raven prints its error to STDOUT and exits non-zero. The adapter must
  // NOT treat that stdout as a valid answer — it must throw, so the error never
  // reaches the meeting pipeline as a brief/answer. (Regression guard for B1.)
  const a = new RavenAdapter() as any;
  let returned: string | undefined;
  let threw = false;
  try {
    returned = await a.runRaven("--fail-test", { timeout: 5000 });
  } catch (e: any) {
    threw = true;
    // The thrown message carries the (stripped) error text, not raw ANSI.
    expect(e.message).toContain("No API key configured");
    expect(e.message).not.toContain("\x1b[");
  }
  expect(threw).toBe(true);
  // Must not have returned the error string as if it were a valid answer.
  expect(returned).toBeUndefined();
});

test("runRaven strips ANSI escapes from the returned value on success", async () => {
  const a = new RavenAdapter() as any;
  const result = await a.runRaven("--ansi-test", { timeout: 5000 });
  // Stub emitted `\x1b[31mred\x1b[0m answer \x1b[1mbold\x1b[0m text`.
  expect(result).toBe("red answer bold text");
  expect(result).not.toContain("\x1b[");
});

test("runRaven strips Raven's log/banner preamble, returning only the answer", async () => {
  // Even with --no-logs, raven v0.1.1 prints structlog init/warning lines and a
  // "🐦‍⬛ Raven" banner on STDOUT before the model answer. The adapter must
  // return ONLY the text after the last banner line — no preamble, no banner.
  const a = new RavenAdapter() as any;
  const result = await a.runRaven("--preamble-test", { timeout: 5000 });
  expect(result).toBe("The answer is 42.\nSecond line of the answer.");
  // Preamble + banner must be gone.
  expect(result).not.toContain("app_created");
  expect(result).not.toContain("EverosBackend");
  expect(result).not.toContain("Raven");
  expect(result).not.toContain("🐦");
});

test("scheduleJob / cancelJob round-trip via the internal scheduler", async () => {
  let fired = false;
  const a = new RavenAdapter(() => { fired = true; });
  const id = await a.scheduleJob({
    name: "join standup",
    fireAt: new Date(Date.now() + 50),
    payload: { meetUrl: "https://meet.google.com/x", summary: "Standup" },
  });
  expect(typeof id).toBe("string");
  await a.cancelJob(id);
  await new Promise((r) => setTimeout(r, 80));
  expect(fired).toBe(false); // cancelled before firing
  a.disconnect();
});

test("deliverTodos writes a notes file and returns true", async () => {
  const a = new RavenAdapter();
  const meetingId = `raven_test_${Date.now()}`;
  const ok = await a.deliverTodos({
    meetingId,
    topic: "Planning",
    todos: [{ id: "t1", text: "ship it", fullText: "ship the release", assignee: "andrew" }],
  });
  expect(ok).toBe(true);
  const notePath = `${process.env.HOME}/.callingclaw/shared/notes/${meetingId}_todos.md`;
  expect(existsSync(notePath)).toBe(true);
  const content = readFileSync(notePath, "utf-8");
  expect(content).toContain("ship the release");
  try { rmSync(notePath, { force: true }); } catch {}
});
