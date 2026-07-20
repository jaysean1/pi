# Task Schema

Each task lives under `cron_jobs/tasks/<task-id>/`.

## Required Files

```text
<task-id>/
├── task.json
├── prompt.md
└── stages/          # Optional for additional stages
```

## Minimal Definition

```json
{
  "schemaVersion": 1,
  "id": "example-task",
  "name": "Example task",
  "description": "Explain the expected result.",
  "enabled": false,
  "schedule": {
    "cron": "0 8 * * 1-5",
    "timezone": "Australia/Sydney"
  },
  "cwd": "/Users/jayseanqian/Desktop/on_board",
  "promptFile": "prompt.md",
  "pipeline": [
    {
      "id": "run",
      "name": "Run task",
      "promptFile": "prompt.md",
      "input": "none"
    }
  ],
  "model": {
    "provider": "openai-codex",
    "id": "gpt-5.6-sol",
    "thinking": "high"
  },
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "timeoutMinutes": 60,
  "overlapPolicy": "skip",
  "retention": {
    "maxRuns": 50,
    "maxDays": 90
  },
  "memory": {
    "enabled": true,
    "maxEntries": 120,
    "maxSummaryChars": 2000
  },
  "createdAt": "2026-07-11T00:00:00Z",
  "updatedAt": "2026-07-11T00:00:00Z"
}
```

## Rules

- Use standard five-field cron syntax.
- Use lowercase task and stage IDs with hyphens.
- Use absolute working-directory paths.
- Prompt paths must stay inside the task directory.
- Use one or more sequential pipeline stages.
- A stage may include `"extensions": ["/absolute/reviewed/extension.js"]`; automatic extension discovery remains disabled.
- A stage may include `"skills": ["/absolute/reviewed/SKILL.md"]`; automatic skill discovery remains disabled.
- A stage may include `"pathEntries": ["/absolute/reviewed/bin"]`; entries are prepended only for that stage.
- A stage may set `"requireStatusMarker": true` to fail closed unless the final response reports the Pi Cron completion marker. The marker is artefact-driven: the stage succeeds when the agent verified every required final artefact, even if it recovered from earlier tool errors. Recovered tool errors are recorded as a stage `warning` with `toolErrorCount`.
- A stage may additionally set `"failOnToolError": true` to restore strict behaviour: any failed tool call fails the stage even when the completion marker reports succeeded.
- Task `memory.enabled` writes real-run summaries to `.pi-cron/runs/<task-id>/memory.md`; `maxEntries` is 1-1000 and `maxSummaryChars` is 200-10000.
- Acceptance runs must not update task memory.
- Explicit resource entries must be absolute, exist, and must not be symlinks or world-writable; PATH entries must be directories.
- Keep source scheduler metadata under an optional `migration` object.
- Keep migrated tasks paused until acceptance is complete.
