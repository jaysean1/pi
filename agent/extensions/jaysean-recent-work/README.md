# jaysean-recent-work

Standalone Recent History section for the `jaysean-intro-header` Pi header.

It scans the current workspace's Pi session files, excludes the active session,
and renders a compact recent-history list with relative timestamps. The component
loads once when the Intro header is installed for a fresh session / Pi startup.
There is no manual refresh command.

## Data Sources

- Session files from `ctx.sessionManager.getSessionDir()`.
- The active session file from `ctx.sessionManager.getSessionFile()` is excluded.
- Candidate sessions are sorted by file `mtimeMs`, newest first.
- The relative time label is derived from the same file `mtimeMs`.

Summary priority:

1. Reuse `session-recap/line` custom messages from the session file
   (`details.recap`).
2. Reuse this component's JSON cache when the session file is unchanged:
   `~/.pi/agent/cache/jaysean-recent-work.json`.
3. Generate missing summaries in the background with the configured cheap LLM.
4. Fall back to the old heuristic: first meaningful user request → latest assistant action.

The initial list renders asynchronously and never blocks startup. LLM upgrades
happen after the heuristic list is already visible and are cached for the next
fresh session / Pi startup.

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

Runtime refresh is intentionally not exposed. Start a new session or restart Pi
to load a fresh Recent History list.
