---
name: create-cron-job
description: Create, validate, schedule, pause, migrate, or update local Pi-powered cron jobs under /Users/jayseanqian/Desktop/on_board/cron_jobs. Use when the user asks for a recurring agent task, cron job, scheduled Pi prompt, or scheduled pipeline.
---

# Create Cron Job

Create tasks for Pi Cron Manager. Every agent stage must run through `pi -p`.

## Fixed Paths

- Task root: `/Users/jayseanqian/Desktop/on_board/cron_jobs/tasks`
- Manager package: `/Users/jayseanqian/.pi/agent/extensions/pi_cron_manager`
- Runtime records: `/Users/jayseanqian/Desktop/on_board/cron_jobs/.pi-cron`

Read the workspace `README.md`, `AGENTS.md`, `cron_jobs/README.md`, and `cron_jobs/AGENTS.md` before changing a task.

Read [task-schema.md](references/task-schema.md) before writing `task.json`. Read [safety-checklist.md](references/safety-checklist.md) before enabling or running a task.

## Workflow

1. Collect the purpose, expected output, Sydney schedule, working directory, prompt, pipeline stages, model, thinking level, tools, timeout, and overlap policy.
2. State all local and external side effects. Treat email, chat, ticket, Google Doc, deployment, and data mutation as external side effects.
3. Create `/Users/jayseanqian/Desktop/on_board/cron_jobs/tasks/<task-id>/task.json` and Markdown prompt files.
4. Keep the new task paused with `"enabled": false` during drafting and testing.
5. Run:

```bash
cd /Users/jayseanqian/.pi/agent/extensions/pi_cron_manager
npm run validate
```

6. Confirm the configured model exists:

```bash
pi --list-models | grep '<model-id>'
```

7. Preview the generated crontab without installing it:

```bash
node scripts/pi-cron-runner.mjs plan-crontab
```

8. Use a fake Pi executable for a no-side-effect runner acceptance test when the real prompt can mutate files or external systems. A fake runner test validates arguments, prompt loading, run records, and status only; it does not prove the business workflow.
9. Run the real task only after the user explicitly confirms its exact side effects. Never call a real run a dry run unless the underlying workflow explicitly enables a no-side-effect mode.
10. Enable the task only after validation passes and the user approves the schedule.
11. Use `cron_task_sync_schedule` or `/cron` to preview, confirm, install, and verify the managed crontab block. Never use `crontab -e`.
12. Report task paths, local schedule, model, validation result, test scope, next action, and run record path.

## Safety Rules

- Never activate a task without explicit confirmation.
- Never store API keys, OAuth tokens, cookies, or passwords in task files.
- Preserve every crontab line outside the Pi-managed markers.
- Do not disable or delete a source scheduler until the Pi replacement is enabled and accepted.
- Avoid duplicate live schedules during migration.
- If a task has external side effects, separate runner acceptance from live business acceptance.
- Use `Australia/Sydney` for task schedules in this workspace.
- Scheduler changes are high risk. Show the exact crontab preview before installation.
