# Session Footer Switcher

A Pi session switcher with separate project and automation history.

## Open

- Run `/sessions`.
- Use `Shift+Command+Left` when the terminal supports Super-modified arrow keys.

## Tabs

### Project Sessions

Always reads the default Pi session directory for the current `cwd`. It does not inherit the private session directory of the currently opened automation run.

### Automation Runs

Reads saved sessions referenced by:

```text
/Users/jayseanqian/Desktop/on_board/cron_jobs/.pi-cron/runs/*/*/run.json
```

Runs without a saved `sessionFile` are omitted. Latest completed runs appear first.

The non-active tab is preloaded in the background when the overlay opens. Session lists are cached for the lifetime of the overlay, while detailed titles hydrate asynchronously, so tab switching does not wait for all JSONL files to be parsed.

## Navigation

- Left, Right, Tab, or Shift+Tab: switch tabs.
- Up or Down: select an entry.
- Enter: switch session.
- Escape: close.

The UI uses Pi theme tokens and supports both dark and light themes.
