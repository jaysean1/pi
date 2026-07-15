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
const acceptanceScriptPath = join(packageRoot, "scripts", "accept_migrated_tasks.mjs");

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

test("cron dashboard always opens with session-switching command context", async () => {
  const source = await readFile(join(packageRoot, "extensions", "cron", "index.ts"), "utf8");
  assert.match(source, /async function openDashboard\(ctx: ExtensionCommandContext/);
  assert.match(source, /ctx\.ui\.setEditorText\("\/cron"\)/);
  assert.match(source, /await inspectPiSessionFile\(action\.sessionFile\)/);
  assert.match(source, /if \(session\.status !== "available"\)/);
  assert.doesNotMatch(source, /if \(!\("switchSession" in ctx\)\)/);
});

test("schedule toggle uses one confirmation before automatic installation", async () => {
  const source = await readFile(join(packageRoot, "extensions", "cron", "index.ts"), "utf8");
  const start = source.indexOf('if (action.type === "toggle")');
  const end = source.indexOf('if (action.type === "edit-prompt")', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const toggleBlock = source.slice(start, end);
  assert.equal((toggleBlock.match(/ctx\.ui\.confirm/g) ?? []).length, 1);
  assert.match(toggleBlock, /planTaskEnabledChange/);
  assert.match(toggleBlock, /expectedNext: plan\.next/);
  assert.match(toggleBlock, /ctx\.ui\.confirm\("Double check", confirmation\)/);
  assert.match(toggleBlock, /apply the schedule change now/);
  assert.doesNotMatch(toggleBlock, /Install crontab change|Candidate user crontab/);
});

test("fake migration acceptance does not publish a resumable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-acceptance-"));
  await makeTask(root);
  const { stdout } = await execFile(process.execPath, [acceptanceScriptPath], {
    cwd: packageRoot,
    env: { ...process.env, PI_CRON_ROOT: root },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.total, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.results[0].status, "succeeded");
  assert.equal(report.results[0].sessionFile, null);
  const runRecord = JSON.parse(await readFile(join(root, ".pi-cron", "runs", "safe-task", report.results[0].runId, "run.json"), "utf8"));
  assert.equal(runRecord.sessionFile, undefined);
});

test("skill CLI advertises all migrated operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-help-"));
  const { stdout } = await invoke(["help"], root);
  for (const command of ["list", "get", "run", "sync-schedule", "import-memory", "set-status"]) {
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
  assert.equal(detail.memory.exists, false);
  assert.deepEqual(detail.runs, []);
});

test("skill CLI mutation commands fail closed without confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-guards-"));
  const runError = await invokeFailure(["run", "safe-task"], root);
  assert.match(runError.stderr, /Refusing real task execution/);
  const statusError = await invokeFailure(["set-status", "safe-task", "enabled"], root);
  assert.match(statusError.stderr, /Refusing task status mutation/);
  const memoryError = await invokeFailure(["import-memory", "safe-task", join(root, "legacy.md")], root);
  assert.match(memoryError.stderr, /Refusing task memory import/);
  const syncError = await invokeFailure(["sync-schedule", "--execute"], root);
  assert.match(syncError.stderr, /Refusing crontab installation/);
});

test("imports reviewed legacy memory into the Pi runtime path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-cli-memory-"));
  await makeTask(root);
  const source = join(root, "legacy-memory.md");
  await writeFile(source, "# Legacy memory\n\n- Durable result.\n");
  const result = JSON.parse((await invoke(["import-memory", "safe-task", source, "--confirm-memory-import"], root)).stdout);
  assert.equal(result.taskId, "safe-task");
  const imported = await readFile(result.targetPath, "utf8");
  assert.match(imported, /Imported Codex Automation Memory/);
  assert.match(imported, /Durable result/);
  const duplicateError = await invokeFailure(["import-memory", "safe-task", source, "--confirm-memory-import"], root);
  assert.match(duplicateError.stderr, /Task memory already exists/);
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
