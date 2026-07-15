#!/usr/bin/env node
// Skill-scoped CLI for infrequent Pi Cron Manager operations.
// Read-only commands are safe by default; mutations require explicit confirmation flags.

import { createHash } from "node:crypto";
import {
  importTaskMemory,
  listRuns,
  listTasks,
  loadTask,
  planCrontab,
  readTaskMemory,
  runTask,
  setTaskEnabled,
  syncCrontab,
} from "../../../src/core.mjs";

const HELP = `Pi Cron Manager skill CLI

Usage:
  pi-cron-cli.mjs list
  pi-cron-cli.mjs get <task-id>
  pi-cron-cli.mjs run <task-id> --confirm-side-effects
  pi-cron-cli.mjs sync-schedule
  pi-cron-cli.mjs sync-schedule --execute --confirm-schedule-change --expected-current-sha256 <sha256>
  pi-cron-cli.mjs import-memory <task-id> <absolute-source-path> --confirm-memory-import
  pi-cron-cli.mjs set-status <task-id> <enabled|paused> --confirm-status-change

Use cases:
  list           Inspect managed tasks and validation status (read-only).
  get            Inspect one task and its 10 most recent runs (read-only).
  run            Execute the real task prompt; may cause external side effects.
  sync-schedule  Preview the managed crontab by default; installation requires an
                 explicit confirmation flag and the hash returned by the preview.
  import-memory  Copy one reviewed legacy memory file into the Pi runtime path.
  set-status     Change only task.json. Run sync-schedule separately to preview and
                 approve the resulting crontab change.

Safety:
  Never use mutation confirmation flags unless the user has explicitly approved the
  exact side effects or schedule change in the current conversation.
`;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(args) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--expected-current-sha256") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--expected-current-sha256 requires a value");
      flags.set(argument, value);
      index += 1;
      continue;
    }
    flags.set(argument, true);
  }
  return { positionals, flags };
}

function requireExactShape(positionals, expectedCount, usage) {
  if (positionals.length !== expectedCount) throw new Error(`Usage: ${usage}`);
}

function rejectUnknownFlags(flags, allowed) {
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown flag: ${flag}`);
  }
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArguments(rest);

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (command === "list") {
    requireExactShape(positionals, 0, "pi-cron-cli.mjs list");
    rejectUnknownFlags(flags, new Set());
    const tasks = await listTasks();
    print(tasks.map((item) => ({
      id: item.id,
      name: item.task?.name,
      enabled: item.task?.enabled,
      schedule: item.task?.schedule,
      model: item.task?.model,
      errors: item.validation.errors,
      warnings: item.validation.warnings,
    })));
    return;
  }

  if (command === "get") {
    requireExactShape(positionals, 1, "pi-cron-cli.mjs get <task-id>");
    rejectUnknownFlags(flags, new Set());
    const loaded = await loadTask(positionals[0]);
    const [runs, memory] = await Promise.all([
      listRuns(positionals[0], 10),
      readTaskMemory(positionals[0]),
    ]);
    print({ task: loaded.task, validation: loaded.validation, memory, runs });
    return;
  }

  if (command === "run") {
    requireExactShape(positionals, 1, "pi-cron-cli.mjs run <task-id> --confirm-side-effects");
    rejectUnknownFlags(flags, new Set(["--confirm-side-effects"]));
    if (!flags.has("--confirm-side-effects")) {
      throw new Error("Refusing real task execution without --confirm-side-effects");
    }
    print(await runTask(positionals[0], { trigger: "manual", force: true }));
    return;
  }

  if (command === "sync-schedule") {
    requireExactShape(positionals, 0, "pi-cron-cli.mjs sync-schedule [--execute ...]");
    rejectUnknownFlags(flags, new Set(["--execute", "--confirm-schedule-change", "--expected-current-sha256"]));
    const execute = flags.has("--execute");
    if (execute && !flags.has("--confirm-schedule-change")) {
      throw new Error("Refusing crontab installation without --confirm-schedule-change");
    }
    const expectedHash = flags.get("--expected-current-sha256");
    if (execute && typeof expectedHash !== "string") {
      throw new Error("Crontab installation requires --expected-current-sha256 from a reviewed preview");
    }
    const plan = await planCrontab();
    const currentSha256 = sha256(plan.current);
    if (!execute) {
      print({ ...plan, currentSha256, executed: false });
      return;
    }
    if (expectedHash !== currentSha256) {
      throw new Error("Current crontab no longer matches the reviewed preview; preview again");
    }
    const result = await syncCrontab({ execute: true, expectedCurrent: plan.current });
    print({ ...result, currentSha256 });
    return;
  }

  if (command === "import-memory") {
    requireExactShape(positionals, 2, "pi-cron-cli.mjs import-memory <task-id> <absolute-source-path> --confirm-memory-import");
    rejectUnknownFlags(flags, new Set(["--confirm-memory-import"]));
    if (!flags.has("--confirm-memory-import")) {
      throw new Error("Refusing task memory import without --confirm-memory-import");
    }
    print(await importTaskMemory(positionals[0], positionals[1]));
    return;
  }

  if (command === "set-status") {
    requireExactShape(positionals, 2, "pi-cron-cli.mjs set-status <task-id> <enabled|paused> --confirm-status-change");
    rejectUnknownFlags(flags, new Set(["--confirm-status-change"]));
    const [taskId, status] = positionals;
    if (status !== "enabled" && status !== "paused") throw new Error("Status must be enabled or paused");
    if (!flags.has("--confirm-status-change")) {
      throw new Error("Refusing task status mutation without --confirm-status-change");
    }
    const loaded = await setTaskEnabled(taskId, status === "enabled");
    print({
      task: loaded.task,
      validation: loaded.validation,
      scheduleSynced: false,
      nextAction: "Run sync-schedule, review its exact preview, then execute it only after explicit approval.",
    });
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
