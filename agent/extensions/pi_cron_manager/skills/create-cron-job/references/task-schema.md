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
- Keep source scheduler metadata under an optional `migration` object.
- Keep migrated tasks paused until acceptance is complete.
