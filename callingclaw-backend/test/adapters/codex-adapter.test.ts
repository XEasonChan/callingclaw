// CodexAdapter tests — uses a fake `codex` binary so we can assert exactly
// how the adapter invokes the CLI, without a real Codex install.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binDir = mkdtempSync(join(tmpdir(), "codex-bin-"));
const argsFile = join(binDir, "last-args.txt");
const binPath = join(binDir, "codex");

beforeAll(() => {
  // Fake `codex`: --version prints a version; `exec` records argv, writes the
  // final answer to the --output-last-message file, and logs noise to stdout
  // (mirroring real codex exec, which streams its event log to stdout).
  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-test"; exit 0; fi
: > "${argsFile}"
OUT=""
prev=""
for a in "$@"; do
  printf '%s\\n' "$a" >> "${argsFile}"
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"
done
echo "[event-log noise that should not be returned]"
if [ -n "$OUT" ]; then printf 'CODEX_RESPONSE_OK' > "$OUT"; fi
`;
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  // Point the adapter at our stub binary.
  process.env.CODEX_BIN = binPath;
  // Pin model envs so we can assert them deterministically.
  process.env.CODEX_PREP_MODEL = "test-prep-model";
  process.env.CODEX_RECALL_MODEL = "test-recall-model";
  process.env.CODEX_TASK_MODEL = "test-task-model";
});

afterAll(() => {
  delete process.env.CODEX_BIN;
  delete process.env.CODEX_PREP_MODEL;
  delete process.env.CODEX_RECALL_MODEL;
  delete process.env.CODEX_TASK_MODEL;
  try { rmSync(binDir, { recursive: true, force: true }); } catch {}
});

// Import AFTER env is set so the adapter picks up our stub.
const { CodexAdapter } = await import("../../src/adapters/codex-adapter");

function lastArgs(): string[] {
  return existsSync(argsFile)
    ? readFileSync(argsFile, "utf-8").split("\n").filter(Boolean)
    : [];
}

// Raw recorded argv (the prompt arg spans multiple lines, so search the whole thing).
function rawArgs(): string {
  return existsSync(argsFile) ? readFileSync(argsFile, "utf-8") : "";
}

test("connect() verifies the codex CLI", async () => {
  const a = new CodexAdapter();
  await a.connect();
  expect(a.connected).toBe(true);
  expect(a.name).toBe("codex");
  a.disconnect();
});

test("generateMeetingPrep invokes `codex exec -m <prep-model>` with the OC-001 prompt", async () => {
  const a = new CodexAdapter();
  const result = await a.generateMeetingPrep({ topic: "Q3 Roadmap", userContext: "with the exec team" });
  // Final answer comes from the --output-last-message file, not stdout noise.
  expect(result).toBe("CODEX_RESPONSE_OK");

  const args = lastArgs();
  expect(args[0]).toBe("exec");
  expect(args).toContain("--skip-git-repo-check");
  expect(args).toContain("--output-last-message");
  expect(args[args.indexOf("-m") + 1]).toBe("test-prep-model");
  expect(rawArgs()).toContain("Q3 Roadmap");
});

test("recallContext uses the recall model", async () => {
  const a = new CodexAdapter();
  const result = await a.recallContext("what did we decide about pricing?");
  expect(result).toBe("CODEX_RESPONSE_OK");
  const args = lastArgs();
  expect(args[args.indexOf("-m") + 1]).toBe("test-recall-model");
  expect(rawArgs()).toContain("pricing");
});

test("executeTask uses the task model and passes the prompt as the last arg", async () => {
  const a = new CodexAdapter();
  const result = await a.executeTask("open the design doc");
  expect(result).toBe("CODEX_RESPONSE_OK");
  const args = lastArgs();
  expect(args[args.indexOf("-m") + 1]).toBe("test-task-model");
  expect(args[args.length - 1]).toBe("open the design doc");
});

test("omits -m when no model env is set (falls back to ~/.codex/config.toml)", async () => {
  const saved = {
    prep: process.env.CODEX_PREP_MODEL,
    recall: process.env.CODEX_RECALL_MODEL,
    task: process.env.CODEX_TASK_MODEL,
  };
  delete process.env.CODEX_PREP_MODEL;
  delete process.env.CODEX_RECALL_MODEL;
  delete process.env.CODEX_TASK_MODEL;
  try {
    const a = new CodexAdapter();
    const result = await a.recallContext("anything");
    expect(result).toBe("CODEX_RESPONSE_OK");
    expect(lastArgs()).not.toContain("-m");
  } finally {
    process.env.CODEX_PREP_MODEL = saved.prep;
    process.env.CODEX_RECALL_MODEL = saved.recall;
    process.env.CODEX_TASK_MODEL = saved.task;
  }
});

test("scheduleJob / cancelJob round-trip via the internal scheduler", async () => {
  let fired = false;
  const a = new CodexAdapter(() => { fired = true; });
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
  const a = new CodexAdapter();
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
