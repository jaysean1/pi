// Tests the skill-scoped CLI without touching the real crontab or running a real task.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = join(packageRoot, "skills", "create-cron-job", "scripts", "pi-cron-cli.mjs");

async function invoke(args, root) {
  return execFile(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    env: { ...process.env, PI_CRON_ROOT: root },
  });
}

async function invokeFailure(args, root) {
  try {
    await invoke(args, root);
    assert.fail(`Expected command to fail: ${args.join(" ")}`);
  } catch (error) {
    return error;
  }
}

async function makeTask(root, id = "safe-task") {
  const directory = join(root, "tasks", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "prompt.md"), "Return accepted.\n");
  const task = {
    schemaVersion: 1,
    id,
    name: "Safe task",
    description: "Test task",
    enabled: false,
    schedule: { cron: "0 8 * * 1-5", timezone: "Australia/Sydney" },
    cwd: root,
    promptFile: "prompt.md",
    pipeline: [{ id: "run", name: "Run", promptFile: "prompt.md", input: "none" }],
    model: { provider: "openai-codex", id: "fake-model", thinking: "low" },
    tools: ["read"],
    timeoutMinutes: 1,
    overlapPolicy: "skip",
    retention: { maxRuns: 10, maxDays: 30 },
  };
  await writeFile(join(directory, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
}

test("cron extension registers no global LLM tools", async () => {
  const source = await readFile(join(packageRoot, "extensions", "cron", "index.ts"), "utf8");
  assert.doesNotMatch(source, /registerTool/);
  assert.doesNotMatch(source, /promptSnippet|promptGuidelines/);
});

test("skill CLI advertises all migrated operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-help-"));
  const { stdout } = await invoke(["help"], root);
  for (const command of ["list", "get", "run", "sync-schedule", "set-status"]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("skill CLI lists and gets tasks as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-read-"));
  await makeTask(root);
  const listed = JSON.parse((await invoke(["list"], root)).stdout);
  assert.deepEqual(listed.map((item) => item.id), ["safe-task"]);
  assert.deepEqual(listed[0].errors, []);
  const detail = JSON.parse((await invoke(["get", "safe-task"], root)).stdout);
  assert.equal(detail.task.id, "safe-task");
  assert.deepEqual(detail.runs, []);
});

test("skill CLI mutation commands fail closed without confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-guards-"));
  const runError = await invokeFailure(["run", "safe-task"], root);
  assert.match(runError.stderr, /Refusing real task execution/);
  const statusError = await invokeFailure(["set-status", "safe-task", "enabled"], root);
  assert.match(statusError.stderr, /Refusing task status mutation/);
  const syncError = await invokeFailure(["sync-schedule", "--execute"], root);
  assert.match(syncError.stderr, /Refusing crontab installation/);
});

test("set-status changes only the task definition after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-status-"));
  await makeTask(root);
  const result = JSON.parse((await invoke(["set-status", "safe-task", "enabled", "--confirm-status-change"], root)).stdout);
  assert.equal(result.task.enabled, true);
  assert.equal(result.scheduleSynced, false);
  const stored = JSON.parse(await readFile(join(root, "tasks", "safe-task", "task.json"), "utf8"));
  assert.equal(stored.enabled, true);
});
