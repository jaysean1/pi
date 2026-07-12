# Migrates active Codex automation TOML files into paused Pi Cron Manager tasks.
# Does not enable tasks, install crontab entries, or disable source automations.

from __future__ import annotations

import argparse
import json
import re
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DAY_NUMBER = {"SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6}
TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]


def parse_rrule(value: str) -> dict[str, str]:
    raw = value.removeprefix("RRULE:")
    result: dict[str, str] = {}
    for part in raw.split(";"):
        key, separator, item = part.partition("=")
        if separator:
            result[key] = item
    return result


def shift_days(days: list[int], shift: int) -> list[int]:
    return sorted({(day + shift) % 7 for day in days})


def rrule_to_sydney_cron(value: str, migration_time: datetime) -> tuple[str, dict[str, object]]:
    rule = parse_rrule(value)
    if rule.get("FREQ") not in {"DAILY", "WEEKLY"}:
        raise ValueError(f"Unsupported RRULE frequency: {value}")
    source_hour = int(rule.get("BYHOUR", "0"))
    minute = int(rule.get("BYMINUTE", "0"))
    offset = migration_time.astimezone(ZoneInfo("Australia/Sydney")).utcoffset()
    if offset is None:
        raise ValueError("Cannot resolve Australia/Sydney UTC offset")
    offset_hours = int(offset.total_seconds() // 3600)
    shifted_hour = source_hour + offset_hours
    day_shift, local_hour = divmod(shifted_hour, 24)
    day_names = [part for part in rule.get("BYDAY", "").split(",") if part]
    if day_names:
        local_days = shift_days([DAY_NUMBER[name] for name in day_names], day_shift)
        day_field = "*" if local_days == list(range(7)) else ",".join(str(day) for day in local_days)
    else:
        day_field = "*"
    cron = f"{minute} {local_hour} * * {day_field}"
    conversion = {
        "sourceRruleAssumedTimezone": "UTC",
        "sydneyOffsetHoursAtMigration": offset_hours,
        "dayShift": day_shift,
        "note": "Confirm local wall-clock time before activation; macOS cron follows local time across DST.",
    }
    return cron, conversion


def iso_from_millis(value: int | None) -> str:
    if value is None:
        return datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return datetime.fromtimestamp(value / 1000, UTC).isoformat().replace("+00:00", "Z")


def migrate(source: Path, tasks_root: Path, overwrite: bool) -> dict[str, object]:
    with source.open("rb") as handle:
        automation = tomllib.load(handle)
    if automation.get("status") != "ACTIVE":
        raise ValueError(f"Source automation is not ACTIVE: {source}")
    task_id = automation["id"]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", task_id):
        raise ValueError(f"Invalid task id: {task_id}")
    task_directory = tasks_root / task_id
    if task_directory.exists() and not overwrite:
        raise FileExistsError(f"Task already exists: {task_directory}")
    task_directory.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    cron, conversion = rrule_to_sydney_cron(automation["rrule"], now)
    cwds = automation.get("cwds") or []
    cwd = cwds[0] if cwds else automation.get("target", {}).get("project_id")
    task = {
        "schemaVersion": 1,
        "id": task_id,
        "name": automation.get("name", task_id),
        "description": f"Migrated from the active Codex automation {task_id}.",
        "enabled": False,
        "schedule": {"cron": cron, "timezone": "Australia/Sydney"},
        "cwd": cwd,
        "promptFile": "prompt.md",
        "pipeline": [
            {"id": "run", "name": "Run migrated automation", "promptFile": "prompt.md", "input": "none"}
        ],
        "model": {
            "provider": "openai-codex",
            "id": automation["model"],
            "thinking": automation.get("reasoning_effort", "medium"),
        },
        "tools": TOOLS,
        "timeoutMinutes": 120,
        "overlapPolicy": "skip",
        "retention": {"maxRuns": 50, "maxDays": 90},
        "migration": {
            "source": "codex-automation",
            "sourcePath": str(source),
            "sourceStatus": automation["status"],
            "sourceRrule": automation["rrule"],
            "sourceModel": automation["model"],
            "sourceReasoningEffort": automation.get("reasoning_effort"),
            "sourceCreatedAt": iso_from_millis(automation.get("created_at")),
            "sourceUpdatedAt": iso_from_millis(automation.get("updated_at")),
            "convertedAt": now.isoformat().replace("+00:00", "Z"),
            "scheduleConversion": conversion,
        },
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "updatedAt": now.isoformat().replace("+00:00", "Z"),
    }
    (task_directory / "task.json").write_text(json.dumps(task, indent=2) + "\n", encoding="utf-8")
    prompt = automation.get("prompt", "")
    (task_directory / "prompt.md").write_text(prompt.rstrip() + "\n", encoding="utf-8")
    return {"id": task_id, "cron": cron, "model": f"openai-codex/{automation['model']}", "enabled": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, default=Path.home() / ".codex" / "automations")
    parser.add_argument(
        "--tasks-root",
        type=Path,
        default=Path("/Users/jayseanqian/Desktop/on_board/cron_jobs/tasks"),
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    results = []
    for source in sorted(args.source_root.glob("*/automation.toml")):
        with source.open("rb") as handle:
            automation = tomllib.load(handle)
        if automation.get("status") == "ACTIVE":
            results.append(migrate(source, args.tasks_root, args.overwrite))
    print(json.dumps({"count": len(results), "tasks": results}, indent=2))


if __name__ == "__main__":
    main()
