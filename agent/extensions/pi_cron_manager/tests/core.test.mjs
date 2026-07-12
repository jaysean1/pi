// Tests task validation, managed crontab preservation, and no-side-effect runner execution.
// Does not access the real user crontab or call a real model.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

const root = await mkdtemp(join(tmpdir(), "pi-cron-test-"));
process.env.PI_CRON_ROOT = root;
const core = await import(`../src/core.mjs?test=${Date.now()}`);

async function makeTask(id = "safe-task") {
  const directory = join(root, "tasks", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "prompt.md"), "Return the word accepted.\n");
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
  return task;
}

test("validates a complete paused task", async () => {
  const task = await makeTask();
  const validation = await core.validateTask(task, join(root, "tasks", task.id));
  assert.deepEqual(validation.errors, []);
});

test("lists tasks in stable alphabetical order", async () => {
  await Promise.all([makeTask("zulu-task"), makeTask("alpha-task"), makeTask("middle-task")]);
  const ids = (await core.listTasks()).map((item) => item.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test("preserves unmanaged crontab content", () => {
  const original = "MAILTO=user@example.com\n15 4 * * * /usr/local/bin/external\n";
  const block = core.generateManagedBlock([]);
  const merged = core.mergeManagedCrontab(original, block);
  assert.match(merged, /MAILTO=user@example.com/);
  assert.match(merged, /\/usr\/local\/bin\/external/);
  assert.match(merged, /BEGIN PI CRON MANAGER/);
  const replaced = core.mergeManagedCrontab(merged, `${core.MANAGED_BEGIN}\n# replacement\n${core.MANAGED_END}`);
  assert.equal((replaced.match(/external/g) ?? []).length, 1);
  assert.equal((replaced.match(/BEGIN PI CRON MANAGER/g) ?? []).length, 1);
});

test("runs a task through a fake Pi executable", async () => {
  await makeTask("runner-task");
  const fakePi = join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);const sessionDir=args[args.indexOf("--session-dir")+1];writeFileSync(join(sessionDir,"fake-session.jsonl"),"{}\\n");const message={role:"assistant",content:[{type:"text",text:"accepted"}],usage:{input:2,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask("runner-task", { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "succeeded");
  assert.equal(run.usage.input, 2);
  assert.match(run.sessionFile, /fake-session\.jsonl$/);
  assert.equal((await readFile(run.sessionFile, "utf8")).trim(), "{}");
  assert.equal((await readFile(join(run.directory, "final.md"), "utf8")).trim(), "accepted");
});

test("lists newest run first", async () => {
  const runsRoot = join(root, ".pi-cron", "runs", "ordered-task");
  await mkdir(join(runsRoot, "older"), { recursive: true });
  await mkdir(join(runsRoot, "newer"), { recursive: true });
  await writeFile(join(runsRoot, "older", "run.json"), JSON.stringify({ runId: "older", startedAt: "2026-07-10T00:00:00Z", status: "succeeded" }));
  await writeFile(join(runsRoot, "newer", "run.json"), JSON.stringify({ runId: "newer", startedAt: "2026-07-11T00:00:00Z", status: "succeeded" }));
  const runs = await core.listRuns("ordered-task");
  assert.deepEqual(runs.map((run) => run.runId), ["newer", "older"]);
});

test("rejects prompt traversal", async () => {
  const task = await makeTask("bad-task");
  task.pipeline[0].promptFile = "../secret.md";
  await writeFile(join(root, "tasks", "bad-task", "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const validation = await core.validateTask(task, join(root, "tasks", "bad-task"));
  assert.ok(validation.errors.some((error) => error.includes("escapes")));
});
