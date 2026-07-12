# Pi Cron Manager — Extension Design

## 1. Summary

Pi Cron Manager is a local Pi package for managing scheduled Pi tasks on macOS.

It provides:

- `/cron` — an interactive TUI for tasks, configuration, and run history.
- A `create-cron-job` skill — guides the agent through safe task creation.
- A local runner — executes every managed pipeline through `pi -p`.
- A managed macOS crontab block — keeps scheduling separate from unrelated cron entries.
- File-based task and run records under `/Users/jayseanqian/Desktop/on_board/cron_jobs`.

The design follows the main Codex Scheduled Tasks concepts: a task list, clear status, schedule, prompt, model settings, and individual run records. It remains terminal-first and uses native Pi TUI components.

## 2. Product Goals

1. Show local macOS cron jobs inside Pi.
2. Make Pi-powered scheduled tasks easy to inspect and create.
3. Keep prompts, pipelines, model settings, and run evidence visible.
4. Use `pi -p` as the only agent execution engine.
5. Keep task definitions portable, reviewable, and version-controlled.
6. Avoid silently changing cron or executing a new task without confirmation.

## 3. Non-goals for Version 1

- Replacing `launchd` or displaying every LaunchAgent and LaunchDaemon.
- Importing Codex automations automatically.
- Editing system-owned cron files such as `/etc/crontab`.
- Remote execution or cloud scheduling.
- Running more than one pipeline stage in parallel.
- Providing a graphical desktop application.

Codex automation import can be added later as an explicit migration workflow.

## 4. Package and Data Layout

```text
/Users/jayseanqian/.pi/agent/extensions/pi_cron_manager/
├── package.json                     # Pi package manifest
├── extensions/cron/index.ts         # Registers /cron and its TUI only
├── src/                             # Storage, scheduler, runner, and TUI support
├── scripts/pi-cron-runner.mjs       # Stable cron entry point
├── skills/create-cron-job/          # Bundled configurable skill
│   └── scripts/pi-cron-cli.mjs      # Skill-scoped manager CLI
└── tests/

/Users/jayseanqian/Desktop/on_board/cron_jobs/
├── tasks/                           # Canonical managed task instances
│   └── <task-id>/
│       ├── task.json
│       ├── prompt.md
│       └── stages/
│           └── <stage-id>.md
└── .pi-cron/                        # Runtime state; Git-ignored
    ├── runs/<task-id>/<run-id>/
    │   ├── run.json
    │   ├── events.jsonl
    │   ├── stdout.log
    │   ├── stderr.log
    │   └── final.md
    ├── locks/<task-id>.lock
    ├── workflows/<task-id>.json       # One-time prompt-derived workflow cache
    └── tmp/
```

Extension and skill code lives in Pi's system extension path. Task definitions and runtime instances stay inside the requested `cron_jobs` root.

## 5. Installation Model

The folder is a local Pi package with this manifest shape:

```json
{
  "name": "pi-cron-manager",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/cron/index.ts"],
    "skills": ["./skills/create-cron-job/SKILL.md"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

Recommended installation:

```bash
pi install /Users/jayseanqian/.pi/agent/extensions/pi_cron_manager
```

The package is installed from Pi's system extension directory. Its manifest exposes the extension and skill as separate resources so each can be enabled or disabled through `pi config`.

## 6. Task Definition

`task.json` is the canonical machine-readable definition. JSON avoids adding a YAML runtime dependency.

```json
{
  "schemaVersion": 1,
  "id": "daily-inbox-summary",
  "name": "Daily inbox summary",
  "description": "Summarise important inbox messages each morning.",
  "enabled": true,
  "schedule": {
    "cron": "0 8 * * 1-5",
    "timezone": "Australia/Sydney"
  },
  "cwd": "/Users/jayseanqian/Desktop/on_board",
  "promptFile": "prompt.md",
  "pipeline": [
    {
      "id": "summarise",
      "name": "Summarise inbox",
      "promptFile": "stages/summarise.md",
      "input": "taskPrompt"
    }
  ],
  "model": {
    "provider": "google",
    "id": "gemini-2.5-pro",
    "thinking": "high"
  },
  "tools": ["read", "bash", "edit", "write"],
  "timeoutMinutes": 45,
  "overlapPolicy": "skip",
  "retention": {
    "maxRuns": 50,
    "maxDays": 90
  },
  "createdAt": "2026-07-11T00:00:00Z",
  "updatedAt": "2026-07-11T00:00:00Z"
}
```

### Validation rules

- `id` uses lowercase letters, numbers, and hyphens only.
- `cwd` must be an existing absolute directory.
- Prompt files must resolve inside the task directory.
- A task must contain at least one pipeline stage.
- Model identifiers must resolve through `pi --list-models` before activation.
- Cron expressions use standard five-field syntax only in version 1.
- The configured timezone must be `Australia/Sydney` in this workspace.
- The host timezone must match the task timezone before installation.
- `timeoutMinutes` must be between 1 and 1,440.
- The default overlap policy is `skip`.
- Secrets must not be stored in task definitions or prompts.

## 7. Pipeline Model

A pipeline is a sequential list of Pi stages. Every stage is run by a fresh non-interactive Pi process.

### Stage inputs

- `taskPrompt` — main `prompt.md` plus the stage prompt.
- `previousOutput` — previous stage `final.md` plus the stage prompt.
- `taskPromptAndPreviousOutput` — both inputs.
- `none` — stage prompt only.

The first version does not support arbitrary shell stages. Shell work must be requested through Pi's `bash` tool and controlled through the task's tool allowlist. This keeps `pi -p` at the centre of every execution and leaves tool calls in the JSON event log.

### Failure behaviour

- Stages stop on the first failure by default.
- An optional `continueOnError: true` can be added to non-critical stages.
- The final run status is `succeeded`, `failed`, `timed_out`, `cancelled`, or `skipped`.
- A skipped overlap creates a run record with reason `already_running`.

## 8. Runner Design

Cron calls one stable command:

```bash
/usr/bin/env node \
  /Users/jayseanqian/.pi/agent/extensions/pi_cron_manager/scripts/pi-cron-runner.mjs \
  run daily-inbox-summary
```

For every pipeline stage, the runner spawns Pi without a shell:

```text
pi
--no-extensions
--no-skills
--no-prompt-templates
--mode json
-p
--session-dir <run-directory>/sessions/<stage-id>
--model <provider>/<model>
--thinking <level>
--tools <comma-separated-tools>
--name cron:<task-id>:<run-id>:<stage-id>
<assembled-prompt>
```

### Runner responsibilities

1. Load and validate `task.json`.
2. Refuse disabled tasks unless `--force` is supplied for a manual run.
3. Acquire an atomic per-task lock.
4. Create the run directory and initial `run.json`.
5. Spawn `pi` with an argument array and `shell: false`.
6. Disable extension, skill, and prompt-template discovery in the child Pi process. Scheduled runs therefore cannot trigger unrelated global hooks, hidden model calls, or extra tool metadata; task prompts must be self-contained and use built-in providers/tools.
7. Stream Pi JSON events into `events.jsonl`.
8. Capture standard output and standard error separately.
9. Extract the last assistant text into `final.md`.
10. Record stage usage, model, duration, exit code, and error details.
11. Enforce timeout and terminate the process safely.
12. Apply run-retention rules after completion.
13. Always release the task lock.

### Environment

Cron has a minimal environment. The generated command sets an explicit safe `PATH`, for example:

```text
/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

Credentials continue to come from Pi auth, environment references, Keychain-backed commands, or existing skill configuration. The manager never copies secret values into task files or logs.

## 9. macOS Crontab Integration

The extension owns only a marked section of the current user's crontab:

```cron
# BEGIN PI CRON MANAGER — DO NOT EDIT BY HAND
0 8 * * 1-5 /usr/bin/env node /Users/jayseanqian/.pi/agent/extensions/pi_cron_manager/scripts/pi-cron-runner.mjs run daily-inbox-summary >/dev/null 2>&1
# END PI CRON MANAGER
```

### Safe update algorithm

1. Read `crontab -l`; treat “no crontab” as an empty file.
2. Parse and preserve every line outside the managed markers byte-for-byte.
3. Generate the managed block from enabled task manifests.
4. Write the candidate crontab to a temporary file with mode `0600`.
5. Show a diff in the TUI.
6. Require explicit confirmation.
7. Install with `crontab <temp-file>`.
8. Read `crontab -l` again and verify exact managed-block equality.
9. Restore the prior crontab if verification fails.

Unmanaged user entries are visible in `/cron`, but version 1 never edits them. Readable system cron entries can also be displayed as read-only external jobs.

Cron follows the host's local timezone. The manager therefore validates that macOS is using `Australia/Sydney`; it does not depend on non-portable `CRON_TZ` behaviour. The TUI warns about daylight-saving transitions, where cron may skip or repeat a wall-clock time.

## 10. `/cron` TUI

`/cron` opens a full-screen overlay with `ctx.ui.custom()`. It uses the complete terminal width and height and is available only when `ctx.mode === "tui"`. Terminal mouse reporting is enabled while the overlay is open so touchpad two-finger gestures and mouse wheels scroll the detail pane.

### Main layout

```text
┌ Pi Scheduled Tasks ──────────────────────────────────────────────────────┐
│ 12 tasks   8 active   1 running   1 failed                 Sydney 14:32 │
├──────────────────────────┬───────────────────────────────────────────────┤
│ TASKS                    │ Daily inbox summary                ● Active  │
│                          │ Weekdays at 08:00 · next Mon 08:00           │
│ ● Daily inbox summary    │                                               │
│ ○ Weekly memory review   │ [Runs] [Overview] [Prompt] [Pipeline] [Model]│
│ ! Product issue scan     │                                               │
│ ◇ External cron entry    │ Last run     Succeeded · 2m 14s              │
│                          │ Next run     14 Jul 2026, 08:00               │
│                          │ Working dir  ~/Desktop/on_board              │
│                          │ Model        google/gemini-2.5-pro · high     │
│                          │ Pipeline     1 stage                          │
│                          │                                               │
│                          │ Recent runs                                  │
│                          │ ✓ 11 Jul 08:00  2m14s  $0.04                 │
│                          │ ✗ 10 Jul 08:00  0m31s  auth error            │
├──────────────────────────┴───────────────────────────────────────────────┤
│ ↑↓ task  ←→ tab  enter details  n new  r run  e edit  space toggle     │
│ l logs   d delete   / filter   g refresh   esc close                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Task list states

- `●` active managed task.
- `○` paused managed task.
- `◐` currently running.
- `!` latest run failed or configuration is invalid.
- `◇` external or unmanaged cron entry; read-only.

### Detail tabs

`Runs` is the first and default tab so recent execution history is visible immediately.

#### Runs

Shows a quick schedule switch above the latest-first run history. With a managed task selected, press Enter to move focus into the Runs tab; the switch is selected first. Use Up and Down to move between the switch and history rows. Enter on the switch starts the existing reviewed pause/enable flow; Enter on a run resumes its saved Pi session. Left or Escape returns focus to the task list.

#### Overview

Shows status, human schedule, raw cron expression, next run, last run, working directory, timeout, overlap policy, and source path.

#### Prompt

Renders the full `prompt.md` with line wrapping and scrolling. Press `e` to inspect it in `ctx.ui.editor()`; version 0.1 keeps edits read-only and directs changes through the bundled skill.

#### Pipeline

Shows the automation's working mechanism as a compact vertical Chinese ASCII flow diagram. Trigger, processing steps, and outcome use width-aware bordered blocks connected with `|` and `v`. The trigger block converts the raw cron expression into natural Chinese, such as `每周五 16:30 自动运行（悉尼时间）`; the raw expression remains available in Overview. The first time this tab is opened for a task, the manager asks the configured task model to reduce `description` plus the task prompt into 3–7 sequential Chinese workflow nodes.

If the model is unavailable, returns an error, or produces invalid JSON, the manager builds a deterministic local workflow from the task objective, input, validation, delivery, and reporting rules. Pipeline content therefore remains available without a successful model call.

The generated workflow is cached under `.pi-cron/workflows/<task-id>.json`. Reopening the dashboard does not call the model again. A changed description or prompt produces a new source hash and triggers one fresh initialisation when Pipeline is opened again. The cache is explanatory only and never changes task execution.

Workflow helpers use a versioned module entry point (`src/workflow-v2.mjs`). When that export contract changes, the module path must be versioned again so Pi hot reload cannot reuse a stale ESM namespace. The detail renderer also catches content errors and shows an in-panel recovery message instead of allowing an exception to terminate Pi.

#### Model

Shows provider, model ID, thinking level, tool allowlist, authentication availability, and model validation status. The model selector uses available Pi models rather than accepting an unchecked free-text value.

The Runs view shows status, scheduled/manual trigger, start time, duration, model, token usage, estimated cost, final output preview, and saved-session availability. Runs are sorted by `startedAt` descending. Older records created before session persistence show `no saved session` and remain view-only.

Each run also preserves:

- Summary and final assistant output.
- Pipeline stage timeline and stage session path.
- Tool calls from `events.jsonl`.
- Standard error.
- Exact runtime paths.

Logs are rendered with width-safe truncation and scrolling. Full files remain available on disk.

### Responsive behaviour

- At 100 columns or more, use the split list/detail layout.
- Below 100 columns, stack a compact task list above the selected detail tab.
- The overlay paints immediately, then loads task validation, prompts, run history, and crontab data concurrently in the background.
- Loaded dashboard data is cached for instant reopening while each open still starts a background refresh.
- Touchpad or wheel input scrolls the detail content by three lines per report, regardless of task-list focus.
- Fast touchpad flicks aggregate all batched SGR or X10 wheel reports.
- `PgUp`, `PgDn`, `Home`, and `End` provide keyboard scrolling.
- Up and Down cycle through the task selector: Up from the first item selects the last, and Down from the last selects the first.
- Inside the Runs tab, Up and Down move through the schedule switch and history rows, clamping at the first and last control.
- Mouse reporting is restored automatically when the overlay closes.
- All colours use Pi theme tokens and have been verified with both `dark` and `light` themes.
- All rendered lines use `truncateToWidth()` or `wrapTextWithAnsi()`.
- `Shift+Command+J` opens Cron Manager directly from the prompt editor.
- Kaku forwards `Shift+Command+J` as the private sequence `ESC[995~`; the extension handles both that sequence and Pi's standard Super+Shift+J key.

## 11. TUI Actions and Safety

| Action | Behaviour |
| --- | --- |
| New | Runs a guided form, writes draft files, validates, then asks whether to install the schedule. |
| Edit | Edits the selected managed task only; shows manifest and crontab diffs. |
| Run now | Shows model, cwd, tools, and side-effect warning before spawning the runner. |
| Pause/resume | Updates `enabled`, previews the crontab diff, then confirms installation. |
| Delete | Removes only the managed schedule first; task files move to a local archive after a second confirmation. |
| Refresh | Re-reads task files, crontab, model availability, active locks, and run records. |
| Retry | Starts a new manual run; never mutates an old run record. |

No schedule mutation occurs on opening `/cron` or viewing a task.

## 12. Extension API Surface

The extension registers:

### Command

- `/cron` — open the task manager.
- `/cron <task-id>` — open a specific task.
- `/cron runs <task-id>` — open its run list.

### Skill-scoped CLI

The extension intentionally registers no LLM tools, so ordinary Pi requests do not carry low-frequency Cron Manager tool definitions. After the `create-cron-job` skill is loaded, the agent uses:

```bash
node skills/create-cron-job/scripts/pi-cron-cli.mjs <command>
```

Commands:

- `list` — read-only task and validation summary.
- `get <task-id>` — read-only task and recent-run details.
- `run <task-id> --confirm-side-effects` — real execution after explicit approval.
- `sync-schedule` — read-only crontab preview with a current-content hash.
- `sync-schedule --execute --confirm-schedule-change --expected-current-sha256 <hash>` — guarded, conflict-checked installation after review.
- `set-status <task-id> <enabled|paused> --confirm-status-change` — task-definition mutation only; schedule synchronization remains a separate reviewed operation.

The CLI invokes core functions directly without interpolated shell commands. Mutations fail closed unless their explicit confirmation flags are present. A schedule installation additionally requires the hash returned by the reviewed preview, preventing installation after an intervening crontab change.

## 13. `create-cron-job` Skill

### Trigger description

```yaml
---
name: create-cron-job
description: Create, validate, schedule, pause, or update local Pi-powered cron jobs under /Users/jayseanqian/Desktop/on_board/cron_jobs. Use when the user asks for a recurring agent task, cron job, scheduled Pi prompt, or multi-stage scheduled pipeline.
---
```

### Skill workflow

1. Read the workspace and `cron_jobs` guidance.
2. Ask for missing requirements:
   - Purpose and expected output.
   - Schedule and Sydney date/time.
   - Working directory.
   - Prompt and pipeline stages.
   - Model and thinking level.
   - Required tools and external side effects.
   - Timeout and overlap behaviour.
3. Classify risk:
   - Read-only.
   - Local file mutation.
   - External side effect such as email, chat, ticket, or deployment.
4. Generate a task draft under `cron_jobs/tasks/<task-id>/`.
5. Keep prompts in Markdown and configuration in `task.json`.
6. Validate paths, model, cron expression, timezone, tools, and secrets.
7. Show the exact files and generated crontab line.
8. Offer a manual test run only after stating its exact side effects. Call it a dry run only when the underlying workflow explicitly supports and enables a no-side-effect mode.
9. Summarise the test output, side effects, and any external actions taken.
10. Ask for explicit approval before activating or changing the schedule.
11. Sync the managed crontab block and verify it.
12. Report task path, schedule, next run, model, and latest run path.

### Skill safety rules

- Never write directly to `crontab -e`.
- Never activate a task without explicit confirmation.
- Never embed API keys, OAuth tokens, cookies, or passwords.
- Never assume a delivery task is a dry run; state its external effects clearly.
- Reuse existing workspace skills and scripts rather than duplicating them.
- Treat scheduler changes as high risk and verify the installed crontab.
- Preserve unrelated crontab lines exactly.

## 14. Run Record Schema

`run.json` contains enough metadata for audit and TUI rendering:

```json
{
  "schemaVersion": 1,
  "runId": "20260711T080000+1000-manual-a1b2c3",
  "taskId": "daily-inbox-summary",
  "trigger": "manual",
  "status": "succeeded",
  "scheduledFor": null,
  "startedAt": "2026-07-10T22:00:00Z",
  "finishedAt": "2026-07-10T22:02:14Z",
  "durationMs": 134000,
  "pid": 12345,
  "model": "google/gemini-2.5-pro",
  "thinking": "high",
  "usage": {
    "input": 12000,
    "output": 2400,
    "cacheRead": 8000,
    "cacheWrite": 0,
    "cost": 0.04
  },
  "stages": [
    {
      "id": "summarise",
      "status": "succeeded",
      "startedAt": "2026-07-10T22:00:00Z",
      "finishedAt": "2026-07-10T22:02:14Z",
      "exitCode": 0
    }
  ],
  "error": null
}
```

Writes use a temporary file followed by an atomic rename. A crashed run left in `running` state is reconciled to `failed` with reason `orphaned_process` when the manager starts and the recorded PID is no longer alive.

## 15. Reliability and Security

### Reliability

- Atomic task and run metadata writes.
- Per-task overlap locks.
- Process timeout with graceful termination, then forced kill.
- Crontab backup and post-install verification.
- Deterministic task discovery by folder name.
- Corrupt manifests remain visible as invalid tasks instead of disappearing.
- Run retention never deletes an active run.

### Security

- Never invoke task IDs, model IDs, or paths through an interpolated shell command.
- Resolve prompt and stage files inside the task directory, including canonical-path checks that reject escaping symlinks.
- Reject world-writable or symlinked task definitions.
- Create runtime directories and temporary files with user-only permissions.
- Redact common secret patterns from TUI previews and logs.
- Do not expose full environment variables in run metadata.
- Treat project-local prompts and task files as executable instructions.

### macOS permissions

The setup screen checks:

- `cron` can execute the runner.
- Pi is resolvable from the explicit cron `PATH`.
- The task working directory is readable.
- Full Disk Access is granted to `/usr/sbin/cron` when a task needs protected files.

## 16. Error States

The TUI provides direct remediation for:

- No user crontab — normal empty state.
- Duplicate managed markers — block all mutation until repaired.
- Invalid cron expression.
- Missing prompt or stage file.
- Missing working directory.
- Unknown or unauthorised model.
- Pi executable not found from cron environment.
- Stale task lock.
- Timed-out or orphaned run.
- Corrupt JSON event line — preserve raw line and continue parsing.
- Crontab changed by another process between preview and install — abort and refresh.

## 17. Testing Strategy

### Unit tests

- Task schema and path validation.
- Five-field cron parsing and next-run calculation.
- Managed-block parsing and preservation of unmanaged lines.
- Pi event parsing and usage aggregation.
- Lock acquisition, stale-lock detection, and retention.
- TUI width safety at 60, 99, 100, and 160 columns.

### Integration tests

- Use a temporary task root and a fake `pi` executable.
- Use a fake crontab adapter by default; never touch the real crontab in tests.
- Verify success, model failure, timeout, cancellation, and overlap skip.
- Verify crontab conflict detection and rollback.
- Verify `/cron` task filtering, tabs, run navigation, and narrow layout.

### Manual acceptance checks

1. Install the local package and run `/reload`.
2. Open `/cron`; confirm the current empty user crontab is shown safely.
3. Create a harmless task that writes only into a temporary directory.
4. Run it manually and inspect prompt, pipeline, model, events, final output, and logs.
5. Activate it and verify `crontab -l` contains exactly one managed block.
6. Add an unmanaged test line and confirm pause/resume preserves it byte-for-byte.
7. Trigger two runs and verify the overlap policy.
8. Pause and delete the test task; confirm no managed crontab line remains.

## 18. Implementation Phases

### Phase 1 — Safe core

- Package scaffold and schemas.
- Task discovery and validation.
- Single-stage runner using `pi --mode json -p`.
- Run records, locks, timeout, and retention.
- Read-only `/cron` task and run viewer.

### Phase 2 — Scheduler management

- Managed crontab block.
- Preview, confirmation, conflict detection, verification, and rollback.
- Pause, resume, run now, and delete actions.

### Phase 3 — Creation experience

- `create-cron-job` skill.
- Draft creation and validation tools.
- TUI task editor and model selector.
- Multi-stage sequential pipelines.

### Phase 4 — Migration and polish

- Optional Codex automation importer.
- Search and run filtering.
- Cost summaries and task health indicators.
- Exportable run reports.

## 19. Recommended Version 1 Decisions

1. Use a local Pi package, not a loose global extension.
2. Use JSON manifests and Markdown prompts.
3. Keep runtime state under `cron_jobs/.pi-cron/` and Git-ignore it.
4. Manage only a marked user-crontab block.
5. Show unmanaged cron jobs as read-only.
6. Use fresh `pi -p --mode json --session-dir <run-stage-directory>` processes for every stage so historical runs can be resumed.
7. Start with sequential stages and an overlap policy of `skip`.
8. Require an explicit confirmation for every real crontab mutation.
9. Keep `Australia/Sydney` as the only supported workspace timezone in version 1.
10. Build read-only viewing before enabling schedule writes.
