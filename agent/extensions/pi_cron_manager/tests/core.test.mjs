// Tests task validation, managed crontab preservation, and no-side-effect runner execution.
// Does not access the real user crontab or call a real model.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("previews and installs a task toggle with conflict checks", async () => {
  const task = await makeTask("toggle-preview-task");
  const fakeBin = join(root, "fake-crontab-bin");
  const fakeCrontab = join(fakeBin, "crontab");
  const crontabState = join(root, "fake-crontab-state.txt");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(crontabState, "MAILTO=test@example.com\n");
  await writeFile(fakeCrontab, `#!/usr/bin/env node\nimport{existsSync,readFileSync,writeFileSync}from"node:fs";const state=process.env.FAKE_CRONTAB_STATE;const action=process.argv[2];if(action==="-l"){if(!existsSync(state)){process.stderr.write("no crontab for test\\n");process.exit(1)}process.stdout.write(readFileSync(state,"utf8"));process.exit(0)}if(action==="-"){writeFileSync(state,readFileSync(0,"utf8"));process.exit(0)}process.stderr.write("unsupported fake crontab action\\n");process.exit(2);\n`);
  await chmod(fakeCrontab, 0o755);
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CRONTAB_STATE;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  process.env.FAKE_CRONTAB_STATE = crontabState;
  try {
    const preview = await core.planTaskEnabledChange(task.id, true);
    assert.equal(preview.changed, true);
    assert.match(preview.next, /toggle-preview-task/);
    assert.equal(JSON.parse(await readFile(join(root, "tasks", task.id, "task.json"), "utf8")).enabled, false);

    await core.setTaskEnabled(task.id, true);
    await assert.rejects(
      core.syncCrontab({ execute: true, expectedCurrent: preview.current, expectedNext: `${preview.next}stale` }),
      /Task definitions changed after preview/,
    );
    assert.equal(await readFile(crontabState, "utf8"), preview.current);

    const applied = await core.syncCrontab({ execute: true, expectedCurrent: preview.current, expectedNext: preview.next });
    assert.equal(applied.executed, true);
    assert.equal(await readFile(crontabState, "utf8"), preview.next);
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CRONTAB_STATE;
    else process.env.FAKE_CRONTAB_STATE = previousState;
  }
});

test("validates Pi session headers without rewriting session files", async () => {
  const directory = join(root, "session-fixtures");
  await mkdir(directory, { recursive: true });
  const validPath = join(directory, "valid.jsonl");
  const invalidPath = join(directory, "invalid.jsonl");
  const missingPath = join(directory, "missing.jsonl");
  const header = { type: "session", version: 3, id: "valid-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: root };
  await writeFile(validPath, `${JSON.stringify(header)}\n`);
  await writeFile(invalidPath, "{}\n");
  const invalidBefore = await readFile(invalidPath, "utf8");

  const valid = await core.inspectPiSessionFile(validPath);
  assert.equal(valid.status, "available");
  assert.equal(valid.header.id, "valid-session");
  assert.equal((await core.inspectPiSessionFile(invalidPath)).status, "invalid");
  assert.equal((await core.inspectPiSessionFile(missingPath)).status, "missing");
  assert.equal((await core.inspectPiSessionFile(null)).status, "missing");
  assert.equal(await readFile(invalidPath, "utf8"), invalidBefore);
});

test("runs a task through a fake Pi executable with only reviewed resources", async () => {
  const task = await makeTask("runner-task");
  const extensionPath = join(root, "reviewed-extension.mjs");
  const skillPath = join(root, "reviewed-skill.md");
  const extraBin = join(root, "reviewed-bin");
  await writeFile(extensionPath, "export default function activate() {}\n");
  await writeFile(skillPath, "---\nname: reviewed-skill\ndescription: Test skill.\n---\n\n# Test\n");
  await mkdir(extraBin);
  task.pipeline[0].extensions = [extensionPath];
  task.pipeline[0].skills = [skillPath];
  task.pipeline[0].pathEntries = [extraBin];
  task.pipeline[0].requireStatusMarker = true;
  await writeFile(join(root, "tasks", "runner-task", "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const fakePi = join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);const sessionDir=args[args.indexOf("--session-dir")+1];const header={type:"session",version:3,id:"fake-session",timestamp:new Date().toISOString(),cwd:process.cwd()};writeFileSync(join(sessionDir,"fake-session.jsonl"),JSON.stringify(header)+"\\n");writeFileSync(join(sessionDir,"args.json"),JSON.stringify(args));writeFileSync(join(sessionDir,"path.txt"),process.env.PATH);const message={role:"assistant",content:[{type:"text",text:"accepted\\n\\nPI_CRON_STAGE_STATUS: succeeded"}],usage:{input:2,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask("runner-task", { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "succeeded");
  assert.equal(run.usage.input, 2);
  assert.match(run.sessionFile, /fake-session\.jsonl$/);
  assert.equal(JSON.parse(await readFile(run.sessionFile, "utf8")).type, "session");
  assert.equal((await core.inspectPiSessionFile(run.sessionFile)).status, "available");
  const args = JSON.parse(await readFile(join(dirname(run.sessionFile), "args.json"), "utf8"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-prompt-templates"));
  const extensionIndex = args.indexOf("--extension");
  assert.notEqual(extensionIndex, -1);
  assert.equal(args[extensionIndex + 1], await realpath(extensionPath));
  const skillIndex = args.indexOf("--skill");
  assert.notEqual(skillIndex, -1);
  assert.equal(args[skillIndex + 1], await realpath(skillPath));
  assert.equal((await readFile(join(dirname(run.sessionFile), "path.txt"), "utf8")).split(":")[0], await realpath(extraBin));
  assert.equal((await readFile(join(run.directory, "final.md"), "utf8")).trim(), "accepted");
});

test("reconciles a dead-PID lock before starting a replacement run", async () => {
  const task = await makeTask("stale-lock-task");
  const staleRunId = "stale-run";
  const stalePid = 2_147_483_647;
  assert.equal(core.isProcessAlive(stalePid), false);
  const staleDirectory = join(core.runtimeDirectory(task.id), staleRunId);
  const lockPath = join(core.LOCKS_ROOT, `${task.id}.lock`);
  await mkdir(staleDirectory, { recursive: true });
  await mkdir(core.LOCKS_ROOT, { recursive: true });
  await writeFile(join(staleDirectory, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: staleRunId,
    taskId: task.id,
    trigger: "cron",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: null,
    durationMs: null,
    pid: stalePid,
    stages: [{ id: "run", status: "running", startedAt: "2026-07-15T00:00:00.000Z" }],
    error: null,
  }, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify({ pid: stalePid, runId: staleRunId, createdAt: "2026-07-15T00:00:00.000Z" })}\n`);
  const fakePi = join(root, "stale-lock-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconst message={role:"assistant",content:[{type:"text",text:"recovered\\n\\nPI_CRON_STAGE_STATUS: succeeded"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};console.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);

  const replacement = await core.runTask(task.id, { force: true, trigger: "acceptance", piBin: fakePi });

  assert.equal(replacement.status, "succeeded");
  const staleRun = JSON.parse(await readFile(join(staleDirectory, "run.json"), "utf8"));
  assert.equal(staleRun.status, "failed");
  assert.match(staleRun.error, /orphaned_process/);
  assert.equal(staleRun.stages[0].status, "failed");
  assert.equal(await core.pathExists(lockPath), false);
});

test("keeps a live-PID lock and skips an overlapping run", async () => {
  const task = await makeTask("live-lock-task");
  const lockPath = join(core.LOCKS_ROOT, `${task.id}.lock`);
  await mkdir(core.LOCKS_ROOT, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, runId: "active-run", createdAt: new Date().toISOString() })}\n`);
  try {
    const skipped = await core.runTask(task.id, { force: true, trigger: "acceptance" });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "already_running");
    assert.equal(await core.pathExists(lockPath), true);
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("streams Pi stdout and heartbeats before the child exits", async () => {
  const task = await makeTask("streaming-log-task");
  task.pipeline[0].requireStatusMarker = true;
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const fakePi = join(root, "streaming-log-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"agent_start"}));await new Promise(resolve=>setTimeout(resolve,500));const message={role:"assistant",content:[{type:"text",text:"streamed\\n\\nPI_CRON_STAGE_STATUS: succeeded"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};console.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);

  const pendingRun = core.runTask(task.id, { force: true, trigger: "acceptance", piBin: fakePi, heartbeatIntervalMs: 25 });
  let streamed = false;
  let runningRecordPath = "";
  let firstHeartbeat = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runs = await core.listRuns(task.id, 1);
    const eventsPath = runs[0] ? join(runs[0].directory, "events.jsonl") : null;
    if (eventsPath && await core.pathExists(eventsPath)) {
      const content = await readFile(eventsPath, "utf8");
      if (content.includes("agent_start")) {
        streamed = true;
        runningRecordPath = join(runs[0].directory, "run.json");
        firstHeartbeat = (await core.readJson(runningRecordPath)).heartbeatAt;
        break;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(streamed, true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  assert.notEqual((await core.readJson(runningRecordPath)).heartbeatAt, firstHeartbeat);
  const run = await pendingRun;
  assert.equal(run.status, "succeeded");
});

test("fails a strict stage when Pi reports an errored tool result", async () => {
  const task = await makeTask("tool-error-task");
  task.pipeline[0].requireStatusMarker = true;
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const fakePi = join(root, "tool-error-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconst toolCallId="failed-command";console.log(JSON.stringify({type:"tool_execution_end",toolCallId,isError:true}));const failedTool={role:"toolResult",toolName:"bash",toolCallId,isError:true,content:[{type:"text",text:"Command exited with code 1"}]};console.log(JSON.stringify({type:"message_end",message:failedTool}));const message={role:"assistant",content:[{type:"text",text:"recovered\\n\\nPI_CRON_STAGE_STATUS: succeeded"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};console.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);

  const run = await core.runTask(task.id, { force: true, trigger: "acceptance", piBin: fakePi });

  assert.equal(run.status, "failed");
  assert.equal(run.stages[0].toolErrorCount, 1);
  assert.match(run.error, /1 failed tool call/);
});

test("does not publish malformed JSONL output as a resumable session", async () => {
  await makeTask("invalid-session-runner-task");
  const fakePi = join(root, "invalid-session-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);const sessionDir=args[args.indexOf("--session-dir")+1];writeFileSync(join(sessionDir,"invalid-session.jsonl"),"{}\\n");const message={role:"assistant",content:[{type:"text",text:"accepted"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};console.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask("invalid-session-runner-task", { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "succeeded");
  assert.equal(run.sessionFile, undefined);
  assert.equal(run.stages[0].sessionFile, null);
  assert.match(run.stages[0].sessionError, /valid Pi session header/);
});

test("updates bounded task memory after real runs and strips control markers", async () => {
  const task = await makeTask("memory-task");
  task.pipeline[0].requireStatusMarker = true;
  task.memory = { enabled: true, maxEntries: 2, maxSummaryChars: 500 };
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const legacyPath = join(root, "legacy-memory.md");
  await writeFile(legacyPath, "# Legacy\n\nDurable imported decision.\n");
  await core.importTaskMemory(task.id, legacyPath);
  const fakePi = join(root, "memory-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconst message={role:"assistant",content:[{type:"text",text:"durable business result\\n\\nPI_CRON_STAGE_STATUS: succeeded"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    runs.push(await core.runTask(task.id, { force: true, trigger: "manual", piBin: fakePi }));
  }
  assert.ok(runs.every((run) => run.memory.status === "updated"));
  const memory = await core.readTaskMemory(task.id);
  assert.equal(memory.exists, true);
  assert.equal(memory.path, core.taskMemoryPath(task.id));
  assert.match(memory.content, /Durable imported decision/);
  assert.match(memory.content, /durable business result/);
  assert.doesNotMatch(memory.content, /PI_CRON_STAGE_STATUS/);
  assert.doesNotMatch(memory.content, new RegExp(runs[0].runId));
  assert.match(memory.content, new RegExp(runs[1].runId));
  assert.match(memory.content, new RegExp(runs[2].runId));
  assert.equal((memory.content.match(/PI_CRON_MEMORY_ENTRY/g) ?? []).length, 2);
});

test("fails a required completion contract without a status marker", async () => {
  const task = await makeTask("missing-marker-task");
  task.pipeline[0].requireStatusMarker = true;
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const fakePi = join(root, "missing-marker-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconst message={role:"assistant",content:[{type:"text",text:"looks successful"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask(task.id, { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "failed");
  assert.match(run.error, /missing the required Pi Cron status marker/);
});

test("marks a provider error as a failed run even when Pi exits zero", async () => {
  await makeTask("provider-error-task");
  const fakePi = join(root, "provider-error-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node\nconst message={role:"assistant",content:[],stopReason:"error",errorMessage:"blocked provider request",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}};\nconsole.log(JSON.stringify({type:"message_end",message}));\n`);
  await chmod(fakePi, 0o755);
  const run = await core.runTask("provider-error-task", { force: true, trigger: "acceptance", piBin: fakePi });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "blocked provider request");
  assert.equal(run.stages[0].status, "failed");
  assert.equal(run.stages[0].error, "blocked provider request");
});

test("rejects invalid memory settings", async () => {
  const task = await makeTask("bad-memory-task");
  task.memory = { enabled: "yes", maxEntries: 0, maxSummaryChars: 100 };
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const validation = await core.validateTask(task, join(root, "tasks", task.id));
  assert.ok(validation.errors.includes("memory.enabled must be boolean"));
  assert.ok(validation.errors.includes("memory.maxEntries must be an integer from 1 to 1000"));
  assert.ok(validation.errors.includes("memory.maxSummaryChars must be an integer from 200 to 10000"));
});

test("rejects unsafe explicit resource paths", async () => {
  const task = await makeTask("bad-resource-task");
  task.pipeline[0].extensions = ["relative-extension.mjs"];
  task.pipeline[0].skills = [join(root, "missing-skill.md")];
  task.pipeline[0].pathEntries = [join(root, "missing-bin")];
  await writeFile(join(root, "tasks", task.id, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  const validation = await core.validateTask(task, join(root, "tasks", task.id));
  assert.ok(validation.errors.some((error) => error.includes("must be an absolute path")));
  assert.ok(validation.errors.some((error) => error.includes("missing-skill.md")));
  assert.ok(validation.errors.some((error) => error.includes("missing-bin")));
});

test("classifies historical session pointers without changing run records", async () => {
  const runsRoot = join(root, ".pi-cron", "runs", "session-history-task");
  const validRunDirectory = join(runsRoot, "valid-run");
  const invalidRunDirectory = join(runsRoot, "invalid-run");
  await mkdir(validRunDirectory, { recursive: true });
  await mkdir(invalidRunDirectory, { recursive: true });
  const validSession = join(validRunDirectory, "session.jsonl");
  const invalidSession = join(invalidRunDirectory, "session.jsonl");
  await writeFile(validSession, `${JSON.stringify({ type: "session", version: 3, id: "history-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: root })}\n`);
  await writeFile(invalidSession, "{}\n");
  const validRecord = { runId: "valid-run", startedAt: "2026-07-14T01:00:00Z", status: "succeeded", sessionFile: validSession };
  const invalidRecord = { runId: "invalid-run", startedAt: "2026-07-14T00:00:00Z", status: "succeeded", sessionFile: invalidSession };
  await writeFile(join(validRunDirectory, "run.json"), JSON.stringify(validRecord));
  await writeFile(join(invalidRunDirectory, "run.json"), JSON.stringify(invalidRecord));
  const invalidRecordBefore = await readFile(join(invalidRunDirectory, "run.json"), "utf8");

  const runs = await core.listRuns("session-history-task");
  assert.equal(runs.find((run) => run.runId === "valid-run").session.status, "available");
  assert.equal(runs.find((run) => run.runId === "invalid-run").session.status, "invalid");
  assert.equal(await readFile(join(invalidRunDirectory, "run.json"), "utf8"), invalidRecordBefore);
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
