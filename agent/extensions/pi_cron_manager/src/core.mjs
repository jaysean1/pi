// Provides task storage, validation, crontab management, and Pi process execution.
// Does not render the TUI or make scheduler changes without an explicit execute flag.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
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
const SESSION_HEADER_READ_LIMIT = 64 * 1024;

export function taskDirectory(taskId) {
  return join(TASKS_ROOT, taskId);
}

export function runtimeDirectory(taskId) {
  return join(RUNS_ROOT, taskId);
}

export function taskMemoryPath(taskId) {
  return join(runtimeDirectory(taskId), "memory.md");
}

export function isInside(base, candidate) {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function atomicWriteText(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export async function atomicWriteJson(path, value) {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
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

async function readFirstSessionEntry(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        // Pi skips malformed JSONL lines before validating the first parsed entry.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function inspectPiSessionFile(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    return { status: "missing", path: null, error: "No saved session was recorded." };
  }
  try {
    const fileStat = await lstat(sessionFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return { status: "invalid", path: sessionFile, error: "Saved session is not a regular file." };
    }
    const header = await readFirstSessionEntry(sessionFile);
    if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
      return { status: "invalid", path: sessionFile, error: "Saved session does not start with a valid Pi session header." };
    }
    return {
      status: "available",
      path: sessionFile,
      error: null,
      header: {
        id: header.id,
        version: header.version ?? 1,
        cwd: typeof header.cwd === "string" ? header.cwd : null,
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing", path: sessionFile, error: "Saved session file does not exist." };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "invalid", path: sessionFile, error: `Saved session cannot be read: ${message}` };
  }
}

async function validateExplicitResources(resources, label, { directoryOnly = false } = {}) {
  const errors = [];
  if (resources === undefined) return errors;
  if (!Array.isArray(resources)) return [`${label} must be an array`];
  for (const [index, resourcePath] of resources.entries()) {
    const field = `${label}[${index}]`;
    if (typeof resourcePath !== "string" || !resourcePath.trim()) {
      errors.push(`${field} must be a non-empty string`);
    } else if (!isAbsolute(resourcePath)) {
      errors.push(`${field} must be an absolute path`);
    } else if (!(await pathExists(resourcePath))) {
      errors.push(`${field} does not exist: ${resourcePath}`);
    } else {
      const resourceStat = await lstat(resourcePath);
      if (resourceStat.isSymbolicLink()) errors.push(`${field} must not be a symbolic link`);
      if (directoryOnly && !resourceStat.isDirectory()) errors.push(`${field} must be a directory`);
      if (!directoryOnly && !resourceStat.isFile() && !resourceStat.isDirectory()) errors.push(`${field} must be a file or directory`);
      if ((resourceStat.mode & 0o002) !== 0) errors.push(`${field} must not be world-writable`);
    }
  }
  return errors;
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
    if (!isInside(directory, promptPath)) {
      errors.push(`pipeline[${index}].promptFile escapes the task directory`);
    } else if (!(await pathExists(promptPath))) {
      errors.push(`missing prompt file: ${stage.promptFile}`);
    } else {
      try {
        const [canonicalDirectory, canonicalPromptPath] = await Promise.all([realpath(directory), realpath(promptPath)]);
        if (!isInside(canonicalDirectory, canonicalPromptPath)) {
          errors.push(`pipeline[${index}].promptFile symlink escapes the task directory`);
        }
      } catch {
        errors.push(`pipeline[${index}].promptFile cannot be resolved: ${stage.promptFile}`);
      }
    }
    errors.push(...await validateExplicitResources(stage.extensions, `pipeline[${index}].extensions`));
    errors.push(...await validateExplicitResources(stage.skills, `pipeline[${index}].skills`));
    errors.push(...await validateExplicitResources(stage.pathEntries, `pipeline[${index}].pathEntries`, { directoryOnly: true }));
    if (stage.requireStatusMarker !== undefined && typeof stage.requireStatusMarker !== "boolean") {
      errors.push(`pipeline[${index}].requireStatusMarker must be boolean`);
    }
  }
  if (!task.model?.provider || !task.model?.id) errors.push("model.provider and model.id are required");
  if (!THINKING_LEVELS.has(task.model?.thinking)) errors.push("model.thinking is invalid");
  if (!Array.isArray(task.tools) || task.tools.length === 0) errors.push("tools must contain at least one tool");
  for (const tool of task.tools ?? []) if (!BUILTIN_TOOLS.has(tool)) warnings.push(`non-built-in tool: ${tool}`);
  if (!Number.isInteger(task.timeoutMinutes) || task.timeoutMinutes < 1 || task.timeoutMinutes > 1440) {
    errors.push("timeoutMinutes must be an integer from 1 to 1440");
  }
  if (!new Set(["skip", "queue"]).has(task.overlapPolicy)) errors.push("overlapPolicy must be skip or queue");
  if (task.memory !== undefined) {
    if (!task.memory || typeof task.memory !== "object" || Array.isArray(task.memory)) {
      errors.push("memory must be an object");
    } else {
      if (typeof task.memory.enabled !== "boolean") errors.push("memory.enabled must be boolean");
      if (task.memory.maxEntries !== undefined && (!Number.isInteger(task.memory.maxEntries) || task.memory.maxEntries < 1 || task.memory.maxEntries > 1000)) {
        errors.push("memory.maxEntries must be an integer from 1 to 1000");
      }
      if (task.memory.maxSummaryChars !== undefined && (!Number.isInteger(task.memory.maxSummaryChars) || task.memory.maxSummaryChars < 200 || task.memory.maxSummaryChars > 10000)) {
        errors.push("memory.maxSummaryChars must be an integer from 200 to 10000");
      }
    }
  }
  try {
    const taskStat = await lstat(join(directory, "task.json"));
    if (taskStat.isSymbolicLink()) errors.push("task.json must not be a symbolic link");
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
      const session = await inspectPiSessionFile(run.sessionFile);
      runs.push({ ...run, session, directory: join(directory, entry.name) });
    } catch (error) {
      runs.push({
        runId: entry.name,
        taskId,
        status: "invalid",
        error: String(error),
        session: await inspectPiSessionFile(null),
        directory: join(directory, entry.name),
      });
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

function buildCrontabPlan(tasks, current) {
  const invalidEnabled = tasks.filter((item) => item.task?.enabled && item.validation.errors.length > 0);
  if (invalidEnabled.length > 0) throw new Error(`Enabled tasks are invalid: ${invalidEnabled.map((item) => item.id).join(", ")}`);
  const block = generateManagedBlock(tasks);
  const next = mergeManagedCrontab(current, block);
  return { current, next, changed: current !== next, block };
}

export async function planCrontab() {
  const [tasks, current] = await Promise.all([listTasks(), readUserCrontab()]);
  return buildCrontabPlan(tasks, current);
}

export async function planTaskEnabledChange(taskId, enabled) {
  if (!ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  if (typeof enabled !== "boolean") throw new Error("Task enabled state must be boolean");
  const tasks = await listTasks();
  let found = false;
  const candidateTasks = tasks.map((item) => {
    if (item.id !== taskId) return item;
    if (!item.task) throw new Error(`Cannot change invalid task: ${taskId}`);
    found = true;
    return { ...item, task: { ...item.task, enabled } };
  });
  if (!found) throw new Error(`Task not found: ${taskId}`);
  return buildCrontabPlan(candidateTasks, await readUserCrontab());
}

export async function syncCrontab({ execute = false, expectedCurrent, expectedNext } = {}) {
  const plan = await planCrontab();
  if (!execute || !plan.changed) return { ...plan, executed: false };
  if (expectedCurrent !== undefined && expectedCurrent !== plan.current) throw new Error("Crontab changed after preview; refresh and try again");
  if (expectedNext !== undefined && expectedNext !== plan.next) throw new Error("Task definitions changed after preview; refresh and try again");
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

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but cannot be signalled by this user.
    if (error?.code === "EPERM") return true;
    return true;
  }
}

async function reconcileOrphanedLock(taskId, lockPath) {
  let lock;
  try {
    lock = await readJson(lockPath);
  } catch {
    // A malformed lock is not safe to reclaim automatically.
    return false;
  }
  if (isProcessAlive(lock.pid)) return false;
  if (typeof lock.runId !== "string" || !lock.runId.trim()) return false;

  const runPath = join(runtimeDirectory(taskId), lock.runId, "run.json");
  try {
    const run = await readJson(runPath);
    if (run.runId !== lock.runId || run.taskId !== taskId || run.pid !== lock.pid) return false;
    if (run.status === "running") {
      const finishedAt = new Date().toISOString();
      const startedMs = Date.parse(run.startedAt);
      run.status = "failed";
      run.finishedAt = finishedAt;
      run.durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.parse(finishedAt) - startedMs) : null;
      run.error = "orphaned_process: recorded runner PID is no longer alive";
      run.stages = (run.stages ?? []).map((stage) => stage.status === "running"
        ? {
            ...stage,
            status: "failed",
            finishedAt,
            durationMs: Number.isFinite(Date.parse(stage.startedAt))
              ? Math.max(0, Date.parse(finishedAt) - Date.parse(stage.startedAt))
              : null,
            error: "orphaned_process: recorded runner PID is no longer alive",
          }
        : stage);
      await atomicWriteJson(runPath, run);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }

  // Re-read before removal so a concurrently replaced lock is never deleted.
  try {
    const current = await readJson(lockPath);
    if (current.runId !== lock.runId || current.pid !== lock.pid) return false;
    await rm(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(taskId, runId) {
  await mkdir(LOCKS_ROOT, { recursive: true, mode: 0o700 });
  const lockPath = join(LOCKS_ROOT, `${taskId}.lock`);
  const lock = { pid: process.pid, runId, createdAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(lock)}\n`);
      await handle.close();
      return async () => {
        try {
          const current = await readJson(lockPath);
          if (current.pid === lock.pid && current.runId === lock.runId) await rm(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt > 0 || !(await reconcileOrphanedLock(taskId, lockPath))) return null;
    }
  }
  return null;
}

export function stripCronControlLines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !/^PI_CRON_STAGE_STATUS: (succeeded|failed)$/.test(line.trim()))
    .join("\n")
    .trim();
}

export async function readTaskMemory(taskId, maxChars = 6000) {
  const path = taskMemoryPath(taskId);
  if (!(await pathExists(path))) return { path, exists: false, content: "" };
  const content = await readFile(path, "utf8");
  return { path, exists: true, content: content.length > maxChars ? content.slice(-maxChars) : content };
}

export async function importTaskMemory(taskId, sourcePath) {
  if (!isAbsolute(sourcePath)) throw new Error("Memory import source must be an absolute path");
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o002) !== 0) {
    throw new Error("Memory import source must be a regular, non-symlinked, non-world-writable file");
  }
  const { task } = await loadTask(taskId);
  const targetPath = taskMemoryPath(taskId);
  if (await pathExists(targetPath)) throw new Error(`Task memory already exists: ${targetPath}`);
  const legacyContent = (await readFile(sourcePath, "utf8")).trim();
  const content = [
    `# ${task.name} — Pi Cron Memory`,
    "",
    "## Imported Codex Automation Memory",
    "",
    `Imported once at ${new Date().toISOString()}. Future updates are written by Pi Cron Manager and do not depend on Codex paths.`,
    "",
    legacyContent || "No historical Codex automation memory was present.",
    "",
  ].join("\n");
  await atomicWriteText(targetPath, content);
  return { taskId, sourcePath, targetPath, importedChars: legacyContent.length };
}

async function updateTaskMemory(task, run, summaryText) {
  const path = taskMemoryPath(task.id);
  const maxEntries = Number.isInteger(task.memory?.maxEntries) ? task.memory.maxEntries : 120;
  const maxSummaryChars = Number.isInteger(task.memory?.maxSummaryChars) ? task.memory.maxSummaryChars : 2000;
  const marker = "<!-- PI_CRON_MEMORY_ENTRY -->";
  let existing = "";
  if (await pathExists(path)) existing = await readFile(path, "utf8");
  const markerIndex = existing.indexOf(marker);
  const prefix = (markerIndex >= 0 ? existing.slice(0, markerIndex) : existing).trimEnd() || `# ${task.name} — Pi Cron Memory`;
  const entries = existing.split(marker).slice(1).map((entry) => entry.trim()).filter(Boolean);
  const cleanSummary = stripCronControlLines(summaryText) || run.error || "No assistant summary was produced.";
  const summary = cleanSummary.length > maxSummaryChars ? `${cleanSummary.slice(0, maxSummaryChars).trimEnd()}…` : cleanSummary;
  const indentedSummary = summary.split("\n").map((line) => `  ${line}`).join("\n");
  const entry = [
    `## ${run.finishedAt} — ${run.status}`,
    "",
    `- Run ID: \`${run.runId}\``,
    `- Trigger: \`${run.trigger}\``,
    `- Model: \`${run.model}\``,
    `- Duration: ${run.durationMs} ms`,
    "- Summary:",
    indentedSummary,
  ].join("\n");
  const retained = [...entries, entry].slice(-maxEntries);
  const content = `${prefix}\n\n${retained.map((item) => `${marker}\n${item}\n`).join("\n")}`;
  await atomicWriteText(path, content);
  return path;
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
    heartbeatAt: null,
    finishedAt: null,
    durationMs: null,
    pid: process.pid,
    model: `${task.model.provider}/${task.model.id}`,
    thinking: task.model.thinking,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    stages: [],
    error: null,
  };
  run.heartbeatAt = run.startedAt;
  const runPath = join(runDirectory, "run.json");
  let runRecordWrites = Promise.resolve();
  const writeRunRecord = () => {
    const snapshot = JSON.parse(JSON.stringify(run));
    runRecordWrites = runRecordWrites.then(() => atomicWriteJson(runPath, snapshot));
    return runRecordWrites;
  };
  await writeRunRecord();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeatTimer = setInterval(() => {
    run.heartbeatAt = new Date().toISOString();
    void writeRunRecord().catch(() => {});
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const eventsPath = join(runDirectory, "events.jsonl");
  const stdoutPath = join(runDirectory, "stdout.log");
  const stderrPath = join(runDirectory, "stderr.log");
  await Promise.all([
    writeFile(eventsPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(stdoutPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(stderrPath, "", { encoding: "utf8", mode: 0o600 }),
  ]);
  const started = Date.now();
  let previousOutput = "";

  try {
    for (const stage of task.pipeline) {
      const stageStarted = Date.now();
      const promptPath = await realpath(resolve(directory, stage.promptFile));
      const canonicalDirectory = await realpath(directory);
      if (!isInside(canonicalDirectory, promptPath)) throw new Error(`Stage prompt escapes task directory: ${stage.promptFile}`);
      let prompt = await readFile(promptPath, "utf8");
      if (previousOutput && stage.input !== "none") prompt += `\n\n## Previous stage output\n\n${previousOutput}`;
      if (stage.requireStatusMarker) {
        prompt += "\n\n## Pi Cron completion contract\n\nEnd the final response with exactly one of these lines:\n- `PI_CRON_STAGE_STATUS: succeeded` only when every required action and validation succeeded.\n- `PI_CRON_STAGE_STATUS: failed` when any required action or validation failed.\nNever report succeeded after a partial result, skipped required action, command error, missing output, or failed readback.\n";
      }
      const sessionDirectory = join(runDirectory, "sessions", stage.id);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const extensionPaths = await Promise.all((stage.extensions ?? []).map((extensionPath) => realpath(extensionPath)));
      const skillPaths = await Promise.all((stage.skills ?? []).map((skillPath) => realpath(skillPath)));
      const pathEntries = await Promise.all((stage.pathEntries ?? []).map((pathEntry) => realpath(pathEntry)));
      const args = ["--no-extensions", "--no-skills", "--no-prompt-templates"];
      for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);
      for (const skillPath of skillPaths) args.push("--skill", skillPath);
      args.push(
        "--mode", "json", "-p",
        "--session-dir", sessionDirectory,
        "--model", `${stage.model?.provider ?? task.model.provider}/${stage.model?.id ?? task.model.id}`,
        "--thinking", stage.model?.thinking ?? task.model.thinking,
        "--tools", (stage.tools ?? task.tools).join(","),
        "--name", `cron:${taskId}:${runId}:${stage.id}`,
        prompt,
      );
      const piBin = options.piBin ?? process.env.PI_CRON_PI_BIN ?? "/opt/homebrew/bin/pi";
      const stageRecord = { id: stage.id, name: stage.name ?? stage.id, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, exitCode: null };
      run.stages.push(stageRecord);
      await writeRunRecord();
      const result = await new Promise((resolveResult, reject) => {
        const stagePath = [...new Set([...pathEntries, ...DEFAULT_PATH.split(":")])].join(":");
        const child = spawn(piBin, args, { cwd: task.cwd, shell: false, env: { ...process.env, PATH: stagePath }, detached: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let buffer = "";
        let finalText = "";
        let providerError = "";
        const failedToolCallIds = new Set();
        let logWrites = Promise.resolve();
        const appendLogs = (path, text) => {
          logWrites = logWrites.then(() => appendFile(path, text, { encoding: "utf8" }));
        };
        const processEventLine = (line) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line);
            if (event.type === "tool_execution_end" && event.isError === true) {
              failedToolCallIds.add(event.toolCallId ?? `tool-event-${failedToolCallIds.size}`);
            }
            if (event.type !== "message_end") return;
            const textPart = getAssistantText(event.message);
            if (textPart) finalText = textPart;
            if (event.message?.role === "assistant" && (event.message.stopReason === "error" || event.message.errorMessage)) {
              providerError = event.message.errorMessage || "Provider returned an error response";
            }
            if (event.message?.role === "toolResult" && event.message.isError === true) {
              failedToolCallIds.add(event.message.toolCallId ?? `tool-result-${failedToolCallIds.size}`);
            }
            const usage = event.message?.usage;
            if (usage) {
              run.usage.input += usage.input ?? 0;
              run.usage.output += usage.output ?? 0;
              run.usage.cacheRead += usage.cacheRead ?? 0;
              run.usage.cacheWrite += usage.cacheWrite ?? 0;
              run.usage.cost += usage.cost?.total ?? 0;
            }
          } catch {
            // Raw output is preserved even when a line is not valid JSON.
          }
        };
        const timeout = setTimeout(() => child.kill("SIGTERM"), task.timeoutMinutes * 60_000);
        child.stdout.on("data", (data) => {
          const text = data.toString();
          stdout += text;
          appendLogs(eventsPath, text);
          appendLogs(stdoutPath, text);
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) processEventLine(line);
        });
        child.stderr.on("data", (data) => {
          const text = data.toString();
          stderr += text;
          appendLogs(stderrPath, text);
        });
        child.on("error", async (error) => {
          clearTimeout(timeout);
          await logWrites;
          reject(error);
        });
        child.on("close", async (code, signal) => {
          clearTimeout(timeout);
          if (buffer.trim()) processEventLine(buffer);
          await logWrites;
          const visibleFinalText = stripCronControlLines(finalText);
          if (visibleFinalText) await writeFile(join(runDirectory, "final.md"), `${visibleFinalText}\n`, { encoding: "utf8", mode: 0o600 });
          resolveResult({ code: code ?? 1, signal, stdout, stderr, finalText, visibleFinalText, providerError, toolErrorCount: failedToolCallIds.size });
        });
      });
      const sessionFiles = (await readdir(sessionDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(sessionDirectory, entry.name))
        .sort((a, b) => b.localeCompare(a));
      const sessionChecks = await Promise.all(sessionFiles.map((sessionFile) => inspectPiSessionFile(sessionFile)));
      const resumableSession = sessionChecks.find((session) => session.status === "available");
      const unavailableSession = sessionChecks.find((session) => session.status !== "available");
      stageRecord.sessionFile = resumableSession?.path ?? null;
      stageRecord.sessionError = resumableSession ? null : unavailableSession?.error ?? null;
      if (stageRecord.sessionFile) run.sessionFile = stageRecord.sessionFile;
      stageRecord.exitCode = result.code;
      stageRecord.finishedAt = new Date().toISOString();
      stageRecord.durationMs = Date.now() - stageStarted;
      const statusMatch = result.finalText.match(/^PI_CRON_STAGE_STATUS: (succeeded|failed)$/m);
      const contractError = !stage.requireStatusMarker
        ? ""
        : !statusMatch
          ? "Stage final output is missing the required Pi Cron status marker"
          : statusMatch[1] === "failed"
            ? "Stage reported failure through the Pi Cron completion contract"
            : "";
      const toolError = stage.requireStatusMarker && result.toolErrorCount > 0
        ? `Stage executed ${result.toolErrorCount} failed tool call(s) despite its final status marker`
        : "";
      stageRecord.toolErrorCount = result.toolErrorCount;
      const stageError = result.providerError || (result.code !== 0 ? result.stderr.trim() || `Stage ${stage.id} exited ${result.code}` : "") || toolError || contractError;
      stageRecord.status = stageError ? "failed" : "succeeded";
      stageRecord.error = stageError || null;
      previousOutput = result.visibleFinalText;
      if (stageError && !stage.continueOnError) throw new Error(stageError);
    }
    run.status = run.stages.some((stage) => stage.status === "failed") ? "failed" : "succeeded";
  } catch (error) {
    run.status = "failed";
    run.error = String(error instanceof Error ? error.message : error);
  } finally {
    clearInterval(heartbeatTimer);
    run.finishedAt = new Date().toISOString();
    run.heartbeatAt = run.finishedAt;
    run.durationMs = Date.now() - started;
    if (task.memory?.enabled && trigger !== "acceptance") {
      try {
        const memoryPath = await updateTaskMemory(task, run, previousOutput);
        run.memory = { status: "updated", path: memoryPath, error: null };
      } catch (error) {
        run.memory = { status: "failed", path: taskMemoryPath(taskId), error: String(error instanceof Error ? error.message : error) };
      }
    } else {
      run.memory = { status: "skipped", path: taskMemoryPath(taskId), error: null };
    }
    try {
      await writeRunRecord();
    } finally {
      await releaseLock();
      await applyRetention(taskId, task.retention);
    }
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
