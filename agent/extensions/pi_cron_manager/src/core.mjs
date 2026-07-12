// Provides task storage, validation, crontab management, and Pi process execution.
// Does not render the TUI or make scheduler changes without an explicit execute flag.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CRON_ROOT = resolve(process.env.PI_CRON_ROOT ?? "/Users/jayseanqian/Desktop/on_board/cron_jobs");
export const TASKS_ROOT = join(CRON_ROOT, "tasks");
export const RUNTIME_ROOT = join(CRON_ROOT, ".pi-cron");
export const RUNS_ROOT = join(RUNTIME_ROOT, "runs");
export const LOCKS_ROOT = join(RUNTIME_ROOT, "locks");
export const MANAGED_BEGIN = "# BEGIN PI CRON MANAGER — DO NOT EDIT BY HAND";
export const MANAGED_END = "# END PI CRON MANAGER";
export const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const RUNNER_PATH = join(PACKAGE_ROOT, "scripts", "pi-cron-runner.mjs");

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const CRON_FIELD_RE = /^[0-9*/?,\-]+$/;

export function taskDirectory(taskId) {
  return join(TASKS_ROOT, taskId);
}

export function runtimeDirectory(taskId) {
  return join(RUNS_ROOT, taskId);
}

export function isInside(base, candidate) {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function validateCronExpression(expression) {
  if (typeof expression !== "string") return ["schedule.cron must be a string"];
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return ["schedule.cron must use five fields"];
  const errors = [];
  for (const [index, field] of fields.entries()) {
    if (!CRON_FIELD_RE.test(field)) errors.push(`schedule.cron field ${index + 1} is invalid`);
  }
  return errors;
}

export async function validateTask(task, directory = taskDirectory(task?.id ?? "invalid")) {
  const errors = [];
  const warnings = [];
  if (!task || typeof task !== "object") return { errors: ["task.json must contain an object"], warnings };
  if (task.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!ID_RE.test(task.id ?? "")) errors.push("id must use lowercase letters, numbers, and hyphens");
  if (resolve(directory) !== taskDirectory(task.id ?? "invalid")) errors.push("task folder must match task id");
  if (typeof task.name !== "string" || !task.name.trim()) errors.push("name is required");
  if (typeof task.enabled !== "boolean") errors.push("enabled must be boolean");
  errors.push(...validateCronExpression(task.schedule?.cron));
  if (task.schedule?.timezone !== "Australia/Sydney") errors.push("schedule.timezone must be Australia/Sydney");
  if (!isAbsolute(task.cwd ?? "")) errors.push("cwd must be an absolute path");
  else if (!(await pathExists(task.cwd))) errors.push(`cwd does not exist: ${task.cwd}`);
  if (!Array.isArray(task.pipeline) || task.pipeline.length === 0) errors.push("pipeline must contain at least one stage");
  const stageIds = new Set();
  for (const [index, stage] of (task.pipeline ?? []).entries()) {
    if (!ID_RE.test(stage.id ?? "")) errors.push(`pipeline[${index}].id is invalid`);
    if (stageIds.has(stage.id)) errors.push(`duplicate stage id: ${stage.id}`);
    stageIds.add(stage.id);
    if (typeof stage.promptFile !== "string" || !stage.promptFile) {
      errors.push(`pipeline[${index}].promptFile is required`);
      continue;
    }
    const promptPath = resolve(directory, stage.promptFile);
    if (!isInside(directory, promptPath)) errors.push(`pipeline[${index}].promptFile escapes the task directory`);
    else if (!(await pathExists(promptPath))) errors.push(`missing prompt file: ${stage.promptFile}`);
  }
  if (!task.model?.provider || !task.model?.id) errors.push("model.provider and model.id are required");
  if (!THINKING_LEVELS.has(task.model?.thinking)) errors.push("model.thinking is invalid");
  if (!Array.isArray(task.tools) || task.tools.length === 0) errors.push("tools must contain at least one tool");
  for (const tool of task.tools ?? []) if (!BUILTIN_TOOLS.has(tool)) warnings.push(`non-built-in tool: ${tool}`);
  if (!Number.isInteger(task.timeoutMinutes) || task.timeoutMinutes < 1 || task.timeoutMinutes > 1440) {
    errors.push("timeoutMinutes must be an integer from 1 to 1440");
  }
  if (!new Set(["skip", "queue"]).has(task.overlapPolicy)) errors.push("overlapPolicy must be skip or queue");
  try {
    const taskStat = await stat(join(directory, "task.json"));
    if ((taskStat.mode & 0o002) !== 0) errors.push("task.json must not be world-writable");
  } catch {
    errors.push("task.json is missing");
  }
  return { errors, warnings };
}

export async function loadTask(taskId) {
  if (!ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const directory = taskDirectory(taskId);
  const task = await readJson(join(directory, "task.json"));
  const validation = await validateTask(task, directory);
  return { task, directory, validation };
}

export async function listTasks() {
  await mkdir(TASKS_ROOT, { recursive: true });
  const entries = (await readdir(TASKS_ROOT, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(entries.map(async (entry) => {
    try {
      const loaded = await loadTask(entry.name);
      return { ...loaded, id: entry.name };
    } catch (error) {
      return { id: entry.name, task: null, directory: taskDirectory(entry.name), validation: { errors: [String(error)], warnings: [] } };
    }
  }));
}

export async function listRuns(taskId, limit = 50) {
  const directory = runtimeDirectory(taskId);
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const runs = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      const run = await readJson(join(directory, entry.name, "run.json"));
      runs.push({ ...run, directory: join(directory, entry.name) });
    } catch (error) {
      runs.push({ runId: entry.name, taskId, status: "invalid", error: String(error), directory: join(directory, entry.name) });
    }
  }
  return runs
    .sort((a, b) => String(b.startedAt ?? b.runId).localeCompare(String(a.startedAt ?? a.runId)))
    .slice(0, limit);
}

export function splitManagedCrontab(content) {
  const start = content.indexOf(MANAGED_BEGIN);
  const end = content.indexOf(MANAGED_END);
  const secondStart = start >= 0 ? content.indexOf(MANAGED_BEGIN, start + MANAGED_BEGIN.length) : -1;
  const secondEnd = end >= 0 ? content.indexOf(MANAGED_END, end + MANAGED_END.length) : -1;
  if ((start >= 0) !== (end >= 0) || secondStart >= 0 || secondEnd >= 0 || (start >= 0 && end < start)) {
    throw new Error("Invalid or duplicate Pi Cron Manager markers");
  }
  if (start < 0) return { before: content.replace(/\s+$/, ""), managed: "", after: "" };
  const endAfterLine = content.indexOf("\n", end);
  return {
    before: content.slice(0, start).replace(/\s+$/, ""),
    managed: content.slice(start, endAfterLine < 0 ? content.length : endAfterLine).trim(),
    after: (endAfterLine < 0 ? "" : content.slice(endAfterLine + 1)).replace(/^\s+/, "").replace(/\s+$/, ""),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function generateManagedBlock(tasks) {
  const lines = [MANAGED_BEGIN, `PATH=${DEFAULT_PATH}`];
  for (const item of tasks) {
    const task = item.task ?? item;
    if (!task.enabled) continue;
    const command = [process.execPath, RUNNER_PATH, "run", task.id].map(shellQuote).join(" ");
    lines.push(`${task.schedule.cron} ${command} >/dev/null 2>&1`);
  }
  lines.push(MANAGED_END);
  return lines.join("\n");
}

export function mergeManagedCrontab(content, block) {
  const { before, after } = splitManagedCrontab(content);
  return [before, block, after].filter(Boolean).join("\n\n") + "\n";
}

export function execFile(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
    if (options.stdin) child.stdin.end(options.stdin);
  });
}

export async function readUserCrontab() {
  const result = await execFile("crontab", ["-l"]);
  if (result.code === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return "";
  throw new Error(result.stderr.trim() || `crontab -l exited ${result.code}`);
}

export async function planCrontab() {
  const tasks = await listTasks();
  const invalidEnabled = tasks.filter((item) => item.task?.enabled && item.validation.errors.length > 0);
  if (invalidEnabled.length > 0) throw new Error(`Enabled tasks are invalid: ${invalidEnabled.map((item) => item.id).join(", ")}`);
  const current = await readUserCrontab();
  const block = generateManagedBlock(tasks);
  const next = mergeManagedCrontab(current, block);
  return { current, next, changed: current !== next, block };
}

export async function syncCrontab({ execute = false, expectedCurrent } = {}) {
  const plan = await planCrontab();
  if (!execute || !plan.changed) return { ...plan, executed: false };
  if (expectedCurrent !== undefined && expectedCurrent !== plan.current) throw new Error("Crontab changed after preview; refresh and try again");
  const result = await execFile("crontab", ["-"], { stdin: plan.next });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `crontab install exited ${result.code}`);
  const verified = await readUserCrontab();
  if (verified !== plan.next) {
    await execFile("crontab", ["-"], { stdin: plan.current });
    throw new Error("Crontab verification failed; the previous crontab was restored");
  }
  return { ...plan, executed: true };
}

function makeRunId(trigger) {
  return `${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${trigger}-${Math.random().toString(16).slice(2, 8)}`;
}

function getAssistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function acquireLock(taskId, runId) {
  await mkdir(LOCKS_ROOT, { recursive: true, mode: 0o700 });
  const lockPath = join(LOCKS_ROOT, `${taskId}.lock`);
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, runId, createdAt: new Date().toISOString() })}\n`);
    await handle.close();
    return async () => rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

async function applyRetention(taskId, retention = {}) {
  const maxRuns = Number.isInteger(retention.maxRuns) ? retention.maxRuns : 50;
  const runs = await listRuns(taskId, 10000);
  for (const run of runs.slice(maxRuns)) await rm(run.directory, { recursive: true, force: true });
}

export async function runTask(taskId, options = {}) {
  const { task, directory, validation } = await loadTask(taskId);
  if (validation.errors.length > 0) throw new Error(`Task validation failed: ${validation.errors.join("; ")}`);
  const trigger = options.trigger ?? "manual";
  if (!task.enabled && !options.force) throw new Error(`Task is disabled: ${taskId}`);
  const runId = makeRunId(trigger);
  const releaseLock = await acquireLock(taskId, runId);
  const runDirectory = join(runtimeDirectory(taskId), runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  if (!releaseLock) {
    const skipped = { schemaVersion: 1, runId, taskId, trigger, status: "skipped", reason: "already_running", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stages: [] };
    await atomicWriteJson(join(runDirectory, "run.json"), skipped);
    return skipped;
  }

  const run = {
    schemaVersion: 1,
    runId,
    taskId,
    trigger,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    pid: process.pid,
    model: `${task.model.provider}/${task.model.id}`,
    thinking: task.model.thinking,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    stages: [],
    error: null,
  };
  await atomicWriteJson(join(runDirectory, "run.json"), run);
  const started = Date.now();
  let previousOutput = "";

  try {
    for (const stage of task.pipeline) {
      const stageStarted = Date.now();
      const promptPath = resolve(directory, stage.promptFile);
      let prompt = await readFile(promptPath, "utf8");
      if (previousOutput && stage.input !== "none") prompt += `\n\n## Previous stage output\n\n${previousOutput}`;
      const sessionDirectory = join(runDirectory, "sessions", stage.id);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const args = [
        "--mode", "json", "-p",
        "--session-dir", sessionDirectory,
        "--model", `${stage.model?.provider ?? task.model.provider}/${stage.model?.id ?? task.model.id}`,
        "--thinking", stage.model?.thinking ?? task.model.thinking,
        "--tools", (stage.tools ?? task.tools).join(","),
        "--name", `cron:${taskId}:${runId}:${stage.id}`,
        prompt,
      ];
      const piBin = options.piBin ?? process.env.PI_CRON_PI_BIN ?? "/opt/homebrew/bin/pi";
      const stageRecord = { id: stage.id, name: stage.name ?? stage.id, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, exitCode: null };
      run.stages.push(stageRecord);
      await atomicWriteJson(join(runDirectory, "run.json"), run);
      const eventsPath = join(runDirectory, "events.jsonl");
      const stdoutPath = join(runDirectory, "stdout.log");
      const stderrPath = join(runDirectory, "stderr.log");
      const result = await new Promise((resolveResult, reject) => {
        const child = spawn(piBin, args, { cwd: task.cwd, shell: false, env: { ...process.env, PATH: DEFAULT_PATH }, detached: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let buffer = "";
        let finalText = "";
        const timeout = setTimeout(() => child.kill("SIGTERM"), task.timeoutMinutes * 60_000);
        child.stdout.on("data", (data) => {
          const text = data.toString();
          stdout += text;
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === "message_end") {
                const textPart = getAssistantText(event.message);
                if (textPart) finalText = textPart;
                const usage = event.message?.usage;
                if (usage) {
                  run.usage.input += usage.input ?? 0;
                  run.usage.output += usage.output ?? 0;
                  run.usage.cacheRead += usage.cacheRead ?? 0;
                  run.usage.cacheWrite += usage.cacheWrite ?? 0;
                  run.usage.cost += usage.cost?.total ?? 0;
                }
              }
            } catch {
              // Raw output is preserved even when a line is not valid JSON.
            }
          }
        });
        child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("error", reject);
        child.on("close", async (code, signal) => {
          clearTimeout(timeout);
          await writeFile(eventsPath, stdout, { encoding: "utf8", mode: 0o600 });
          await writeFile(stdoutPath, stdout, { encoding: "utf8", mode: 0o600 });
          await writeFile(stderrPath, stderr, { encoding: "utf8", mode: 0o600 });
          if (finalText) await writeFile(join(runDirectory, "final.md"), `${finalText.trim()}\n`, { encoding: "utf8", mode: 0o600 });
          resolveResult({ code: code ?? 1, signal, stdout, stderr, finalText });
        });
      });
      const sessionFiles = (await readdir(sessionDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(sessionDirectory, entry.name))
        .sort((a, b) => b.localeCompare(a));
      stageRecord.sessionFile = sessionFiles[0] ?? null;
      if (stageRecord.sessionFile) run.sessionFile = stageRecord.sessionFile;
      stageRecord.exitCode = result.code;
      stageRecord.finishedAt = new Date().toISOString();
      stageRecord.durationMs = Date.now() - stageStarted;
      stageRecord.status = result.code === 0 ? "succeeded" : "failed";
      previousOutput = result.finalText;
      if (result.code !== 0 && !stage.continueOnError) throw new Error(result.stderr.trim() || `Stage ${stage.id} exited ${result.code}`);
    }
    run.status = run.stages.some((stage) => stage.status === "failed") ? "failed" : "succeeded";
  } catch (error) {
    run.status = "failed";
    run.error = String(error instanceof Error ? error.message : error);
  } finally {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    await atomicWriteJson(join(runDirectory, "run.json"), run);
    await releaseLock();
    await applyRetention(taskId, task.retention);
  }
  return { ...run, directory: runDirectory };
}

export async function setTaskEnabled(taskId, enabled) {
  const { task, directory } = await loadTask(taskId);
  task.enabled = enabled;
  task.updatedAt = new Date().toISOString();
  await atomicWriteJson(join(directory, "task.json"), task);
  return loadTask(taskId);
}

export function displayPath(path) {
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}
