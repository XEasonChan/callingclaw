// HermesAdapter tests — uses a fake `hermes` binary on PATH so we can assert
// exactly how the adapter invokes the CLI, without a real Hermes install.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binDir = mkdtempSync(join(tmpdir(), "hermes-bin-"));
const argsFile = join(binDir, "last-args.txt");
const binPath = join(binDir, "hermes");

beforeAll(() => {
  // Fake `hermes`: --version prints a version; otherwise record argv + echo a response.
  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "hermes 0.2.0-test"; exit 0; fi
: > "${argsFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done
echo "HERMES_RESPONSE_OK"
`;
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  // Point the adapter at our stub binary (Bun.spawn ignores mutated PATH).
  process.env.HERMES_BIN = binPath;
  // Pin model envs so we can assert them deterministically.
  process.env.HERMES_PREP_MODEL = "openrouter/test/prep-model";
  process.env.HERMES_RECALL_MODEL = "openrouter/test/recall-model";
  process.env.HERMES_TASK_MODEL = "openrouter/test/task-model";
});

afterAll(() => {
  delete process.env.HERMES_BIN;
  try { rmSync(binDir, { recursive: true, force: true }); } catch {}
});

// Import AFTER env is set so module-level model constants pick up our values.
const { HermesAdapter } = await import("../../src/adapters/hermes-adapter");

function lastArgs(): string[] {
  return existsSync(argsFile)
    ? readFileSync(argsFile, "utf-8").split("\n").filter(Boolean)
    : [];
}

// Raw recorded argv (the prompt arg spans multiple lines, so search the whole thing).
function rawArgs(): string {
  return existsSync(argsFile) ? readFileSync(argsFile, "utf-8") : "";
}

test("connect() verifies the hermes CLI", async () => {
  const a = new HermesAdapter();
  await a.connect();
  expect(a.connected).toBe(true);
  expect(a.name).toBe("hermes");
  a.disconnect();
});

test("generateMeetingPrep invokes `hermes -z -m <prep-model>` with the OC-001 prompt", async () => {
  const a = new HermesAdapter();
  const result = await a.generateMeetingPrep({ topic: "Q3 Roadmap", userContext: "with the exec team" });
  expect(result).toBe("HERMES_RESPONSE_OK");

  const args = lastArgs();
  expect(args[0]).toBe("-z");
  expect(args).toContain("-m");
  expect(args[args.indexOf("-m") + 1]).toBe("openrouter/test/prep-model");
  // The prompt should be an OC-001 meeting-prep prompt mentioning the topic.
  expect(rawArgs()).toContain("Q3 Roadmap");
});

test("recallContext uses the recall model", async () => {
  const a = new HermesAdapter();
  const result = await a.recallContext("what did we decide about pricing?");
  expect(result).toBe("HERMES_RESPONSE_OK");
  const args = lastArgs();
  expect(args[args.indexOf("-m") + 1]).toBe("openrouter/test/recall-model");
  expect(rawArgs()).toContain("pricing");
});

test("executeTask uses the task model", async () => {
  const a = new HermesAdapter();
  const result = await a.executeTask("open the design doc");
  expect(result).toBe("HERMES_RESPONSE_OK");
  const args = lastArgs();
  expect(args[args.indexOf("-m") + 1]).toBe("openrouter/test/task-model");
  // Prompt comes immediately after -z (argparse requires `-z PROMPT`).
  expect(args[0]).toBe("-z");
  expect(args[1]).toBe("open the design doc");
});

test("scheduleJob / cancelJob round-trip via the internal scheduler", async () => {
  let fired = false;
  const a = new HermesAdapter(() => { fired = true; });
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
  const a = new HermesAdapter();
  const meetingId = `test_${Date.now()}`;
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
