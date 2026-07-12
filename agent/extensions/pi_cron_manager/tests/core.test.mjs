// Tests task validation, managed crontab preservation, and no-side-effect runner execution.
// Does not access the real user crontab or call a real model.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

const root = await mkdtemp(join(tmpdir(), "pi-cron-test-"));
process.env.PI_CRON_ROOT = root;
const cacheBust = Date.now();
const core = await import(`../src/core.mjs?test=${cacheBust}`);
const workflowStore = await import(`../src/workflow-v2.mjs?test=${cacheBust}`);

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

test("uses a versioned workflow module with the complete hot-reload contract", async () => {
  const extensionSource = await readFile(join(process.cwd(), "extensions", "cron", "index.ts"), "utf8");
  assert.match(extensionSource, /src\/workflow-v2\.mjs/);
  for (const name of ["buildFallbackWorkflow", "describeSchedule", "loadWorkflow", "parseWorkflowResponse", "saveWorkflow", "workflowSourceHash"]) {
    assert.equal(typeof workflowStore[name], "function", `${name} must be exported`);
  }
  assert.equal(typeof workflowStore.WORKFLOW_SYSTEM_PROMPT, "string");
});

test("parses a concise fenced Chinese workflow response", () => {
  const parsed = workflowStore.parseWorkflowResponse(`\`\`\`json
{"summary":"生成并交付报告。","steps":[{"title":"收集数据"},{"title":"验证结果"},{"title":"交付报告"}],"outcome":"报告交付完成。"}
\`\`\``);
  assert.equal(parsed.summary, "生成并交付报告。");
  assert.deepEqual(parsed.steps.map((step) => step.title), ["收集数据", "验证结果", "交付报告"]);
  assert.equal(parsed.outcome, "报告交付完成。");
});

test("rejects a model workflow that is not Chinese", () => {
  assert.throws(
    () => workflowStore.parseWorkflowResponse('{"summary":"Build report","steps":[{"title":"Collect"},{"title":"Validate"},{"title":"Deliver"}],"outcome":"Done"}'),
    /must use Chinese/,
  );
  assert.throws(
    () => workflowStore.parseWorkflowResponse('{"summary":"生成报告","steps":[{"title":"Collect"},{"title":"验证结果"},{"title":"交付报告"}],"outcome":"报告完成"}'),
    /must use Chinese/,
  );
});

test("builds a useful local workflow when model generation fails", () => {
  const parsed = workflowStore.buildFallbackWorkflow(
    "Update terminal agents.",
    "Objective: keep terminal coding agents updated every morning.\n1. Read workspace rules.\n2. Run the update script.\n3. Stop on validation failure.\n4. Report before and after versions.",
  );
  assert.match(parsed.summary, /任务规则/);
  assert.ok(parsed.steps.length >= 3 && parsed.steps.length <= 7);
  assert.ok(parsed.steps.some((step) => step.title === "执行核心流程"));
  assert.ok(parsed.steps.some((step) => step.title === "验证处理结果"));
  assert.ok(parsed.steps.some((step) => step.title === "汇报运行结果"));
  assert.ok(parsed.steps.every((step) => /[\u3400-\u9fff]/.test(`${step.title}${step.detail}`)));
});

test("describes common cron schedules in natural Chinese", () => {
  assert.equal(workflowStore.describeSchedule("5 7 * * *", "Australia/Sydney"), "每天 07:05 自动运行（悉尼时间）");
  assert.equal(workflowStore.describeSchedule("30 16 * * 5", "Australia/Sydney"), "每周五 16:30 自动运行（悉尼时间）");
  assert.equal(workflowStore.describeSchedule("0 18 * * 2,3,4,5,6", "Australia/Sydney"), "每周二至周六 18:00 自动运行（悉尼时间）");
});

test("caches a workflow until its source prompt changes", async () => {
  const sourceHash = workflowStore.workflowSourceHash("Test task", "Collect data, validate it, then report.");
  const workflow = {
    sourceHash,
    summary: "Produce a checked report.",
    steps: [
      { title: "Collect data" },
      { title: "Validate result" },
      { title: "Report outcome" },
    ],
    outcome: "A checked report is available.",
    generatedAt: "2026-07-12T00:00:00Z",
    model: "test/fake-model",
  };
  await workflowStore.saveWorkflow("safe-task", workflow);
  assert.deepEqual(await workflowStore.loadWorkflow("safe-task", sourceHash), workflow);
  assert.equal(await workflowStore.loadWorkflow("safe-task", workflowStore.workflowSourceHash("Test task", "Changed prompt")), null);
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
  await writeFile(fakePi, `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);const sessionDir=args[args.indexOf("--session-dir")+1];writeFileSync(join(sessionDir,"fake-session.jsonl"),"{}\\n");writeFileSync(join(sessionDir,"args.json"),JSON.stringify(args));const message={role:"assistant",content:[{type:"text",text:"accepted"}],usage:{input:2,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask("runner-task", { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "succeeded");
  assert.equal(run.usage.input, 2);
  assert.match(run.sessionFile, /fake-session\.jsonl$/);
  assert.equal((await readFile(run.sessionFile, "utf8")).trim(), "{}");
  const args = JSON.parse(await readFile(join(dirname(run.sessionFile), "args.json"), "utf8"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-prompt-templates"));
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

test("rejects prompt symlinks that escape the task directory", async () => {
  const task = await makeTask("symlink-task");
  const outside = join(root, "outside-prompt.md");
  await writeFile(outside, "Untrusted outside prompt.\n");
  const promptPath = join(root, "tasks", "symlink-task", "prompt.md");
  await rm(promptPath);
  await symlink(outside, promptPath);
  const validation = await core.validateTask(task, join(root, "tasks", "symlink-task"));
  assert.ok(validation.errors.some((error) => error.includes("symlink escapes")));
});
