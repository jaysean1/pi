---
name: create-cron-job
description: Create, validate, schedule, pause, migrate, or update local Pi-powered cron jobs under /Users/jayseanqian/Desktop/on_board/cron_jobs. Use when the user asks for a recurring agent task, cron job, scheduled Pi prompt, or scheduled pipeline.
---

# Create Cron Job

Create tasks for Pi Cron Manager. Every agent stage must run through an isolated `pi -p` child with extension, skill, and prompt-template discovery disabled. A stage may load only reviewed extensions and skills listed by absolute path in its `extensions` and `skills` arrays. Reviewed `pathEntries` may add required executables for that stage. Task prompts must otherwise be self-contained and use built-in providers and tools.

## Fixed Paths

- Task root: `/Users/jayseanqian/Desktop/on_board/cron_jobs/tasks`
- Manager package: `/Users/jayseanqian/.pi/agent/extensions/pi_cron_manager`
- Runtime records: `/Users/jayseanqian/Desktop/on_board/cron_jobs/.pi-cron`
- Skill CLI: `/Users/jayseanqian/.pi/agent/extensions/pi_cron_manager/skills/create-cron-job/scripts/pi-cron-cli.mjs`

Read the workspace `README.md`, `AGENTS.md`, `cron_jobs/README.md`, and `cron_jobs/AGENTS.md` before changing a task.

Read [task-schema.md](references/task-schema.md) before writing `task.json`. Read [safety-checklist.md](references/safety-checklist.md) before enabling or running a task.

## Workflow

1. Collect the purpose, expected output, Sydney schedule, working directory, prompt, pipeline stages, model, thinking level, tools, any required reviewed extension, skill, and PATH entries, task-memory retention, timeout, and overlap policy.
2. State all local and external side effects. Treat email, chat, ticket, Google Doc, deployment, and data mutation as external side effects.
3. Create `/Users/jayseanqian/Desktop/on_board/cron_jobs/tasks/<task-id>/task.json` and Markdown prompt files.
4. Keep the new task paused with `"enabled": false` during drafting and testing.
5. Run:

```bash
cd /Users/jayseanqian/.pi/agent/extensions/pi_cron_manager
npm run validate
```

Use the skill-scoped CLI for manager operations. It replaces globally registered `cron_task_*` tools:

```bash
CLI=/Users/jayseanqian/.pi/agent/extensions/pi_cron_manager/skills/create-cron-job/scripts/pi-cron-cli.mjs
node "$CLI" list
node "$CLI" get "<task-id>"
```

Read-only commands are `list`, `get`, and `sync-schedule` without `--execute`. Mutation commands contain refusal guards:

```bash
# Only after explicit approval of the exact real-task side effects:
node "$CLI" run "<task-id>" --confirm-side-effects

# Only after explicit approval of the exact legacy memory source and target:
node "$CLI" import-memory "<task-id>" "/absolute/path/to/legacy-memory.md" --confirm-memory-import

# Only after explicit approval to enable or pause this task definition:
node "$CLI" set-status "<task-id>" enabled --confirm-status-change

# First preview and retain currentSha256 from its JSON output:
node "$CLI" sync-schedule

# Only after the user reviews that exact preview and approves installation:
node "$CLI" sync-schedule --execute --confirm-schedule-change --expected-current-sha256 "<currentSha256>"
```

Never add a confirmation flag merely to bypass a refusal. Confirmation flags assert that the user already approved the exact operation in the current conversation. Keep status changes and crontab synchronization as separate reviewed steps.

6. Confirm the configured model exists:

```bash
pi --list-models | grep '<model-id>'
```

7. Preview the generated crontab without installing it:

```bash
node "$CLI" sync-schedule
```

8. Use a fake Pi executable for a no-side-effect runner acceptance test when the real prompt can mutate files or external systems. A fake runner test validates arguments, prompt loading, run records, and status only; it does not prove the business workflow.
9. Run the real task only after the user explicitly confirms its exact side effects. Never call a real run a dry run unless the underlying workflow explicitly enables a no-side-effect mode.
10. Enable the task only after validation passes and the user approves the schedule.
11. Use the skill CLI's guarded `sync-schedule` flow or `/cron` to preview, confirm, install, and verify the managed crontab block. Never use `crontab -e`.
12. Report task paths, local schedule, model, validation result, test scope, task-memory path, next action, and run record path.

## Safety Rules

- Never activate a task without explicit confirmation.
- Never store API keys, OAuth tokens, cookies, or passwords in task files.
- Never list an extension, skill, or PATH entry unless its exact absolute path and purpose were reviewed for that stage.
- Store task memory only under the Git-ignored Pi runtime path; never point Pi task memory back to Codex automation directories.
- Preserve every crontab line outside the Pi-managed markers.
- Do not disable or delete a source scheduler until the Pi replacement is enabled and accepted.
- Avoid duplicate live schedules during migration.
- If a task has external side effects, separate runner acceptance from live business acceptance.
- Use `Australia/Sydney` for task schedules in this workspace.
- Scheduler changes are high risk. Show the exact crontab preview before installation.
- Do not call the skill CLI through interpolated shell strings. Pass validated task IDs as quoted arguments.
- Treat `--confirm-side-effects`, `--confirm-memory-import`, `--confirm-status-change`, and `--confirm-schedule-change` as records of explicit user approval, never as defaults.
