# Scheduler Safety Checklist

Complete this checklist before enabling or running a task.

## Definition

- [ ] Task ID matches its folder.
- [ ] Prompt and stage files exist.
- [ ] Working directory exists.
- [ ] Model is available in Pi.
- [ ] Tools are limited to what the task needs.
- [ ] No secret value is stored in task files.

## Schedule

- [ ] Cron expression is standard five-field syntax.
- [ ] Displayed time is confirmed in `Australia/Sydney`.
- [ ] Day rollover from a migrated UTC RRULE is confirmed.
- [ ] Daylight-saving behaviour is understood.
- [ ] Existing source scheduler will not run at the same time after cutover.

## Side Effects

- [ ] File writes are listed.
- [ ] Email, chat, Docs, tickets, and deployment actions are listed.
- [ ] The user approved any real side-effecting test.
- [ ] A fake-runner acceptance test is not described as business-workflow validation.

## Activation

- [ ] Task validation passed.
- [ ] Runner acceptance passed.
- [ ] Real workflow acceptance passed or is explicitly deferred.
- [ ] Crontab preview contains only expected managed lines.
- [ ] User approved installation.
- [ ] Installed crontab was read back and verified.
