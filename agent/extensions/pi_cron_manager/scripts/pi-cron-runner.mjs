#!/usr/bin/env node
// Provides the stable command-line entry point used by cron and acceptance tests.
// Does not edit task definitions or install crontab changes implicitly.

import { listTasks, planCrontab, runTask, syncCrontab } from "../src/core.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command, taskId, ...rest] = process.argv.slice(2);
  if (command === "run") {
    if (!taskId) throw new Error("Usage: pi-cron-runner.mjs run <task-id> [--force] [--trigger manual|cron]");
    const triggerIndex = rest.indexOf("--trigger");
    const trigger = triggerIndex >= 0 ? rest[triggerIndex + 1] : "cron";
    if (!new Set(["manual", "cron", "acceptance"]).has(trigger)) throw new Error(`Invalid trigger: ${trigger}`);
    const result = await runTask(taskId, { trigger, force: rest.includes("--force") });
    print(result);
    process.exitCode = result.status === "succeeded" || result.status === "skipped" ? 0 : 1;
    return;
  }
  if (command === "validate-all") {
    const tasks = await listTasks();
    const summary = tasks.map((item) => ({ id: item.id, enabled: item.task?.enabled ?? false, errors: item.validation.errors, warnings: item.validation.warnings }));
    print(summary);
    process.exitCode = summary.some((item) => item.errors.length > 0) ? 1 : 0;
    return;
  }
  if (command === "plan-crontab") {
    print(await planCrontab());
    return;
  }
  if (command === "sync-crontab") {
    print(await syncCrontab({ execute: rest.includes("--execute") || taskId === "--execute" }));
    return;
  }
  throw new Error("Commands: run <task-id>, validate-all, plan-crontab, sync-crontab [--execute]");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
