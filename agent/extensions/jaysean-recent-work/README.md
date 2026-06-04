# jaysean-recent-work

Standalone recent-work section for the `jaysean-intro-header` Pi header.

It scans the current workspace's session files, excludes the active session, and renders a compact `recent` list with relative timestamps.

Summary priority:

1. Reuse cached `session-recap/line` custom messages from the session file.
2. Reuse this plugin's JSON cache when the session file is unchanged.
3. Generate missing summaries in the background with the configured cheap LLM.
4. Fall back to the old heuristic: first meaningful user request → latest assistant action.

The initial list renders asynchronously and never blocks startup; LLM upgrades happen after the heuristic list is already visible.

## Configuration

By default it reuses `sessionRecap` model settings:

```json
{
  "sessionRecap": {
    "model": "openai-codex/gpt-5.4-mini",
    "maxChars": 140,
    "contextChars": 8000,
    "language": "auto"
  }
}
```

Optional `recentWork` overrides:

```json
{
  "recentWork": {
    "enabled": true,
    "maxItems": 5,
    "scanLimit": 10,
    "generateMissing": true,
    "cache": true,
    "model": "openai-codex/gpt-5.4-mini"
  }
}
```

## Commands

- `/recent` or `/recent refresh` — refresh visible recent sections.
- `/recent status` — show active config and section count.
