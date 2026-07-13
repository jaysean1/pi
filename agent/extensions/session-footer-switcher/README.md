# Session Footer Switcher

A Pi session switcher with separate project and automation history.

## Open

- Run `/sessions`.
- Use `Shift+Command+Left` when the terminal supports Super-modified arrow keys.

## Tabs

The initially selected tab depends on where the TUI was invoked: opening the overlay from inside the automation workspace (`/Users/jayseanqian/Desktop/on_board/cron_jobs`) or from an open automation run session starts on **Automation Runs**; any other directory starts on **Project Sessions**.

### Project Sessions

Always reads the default Pi session directory for the project `cwd`. It does not inherit the private session directory of the currently opened automation run: while an automation run session is open (its runtime cwd points at the cron job's directory), the tab keeps listing the last known project directory's sessions.

### New session

`New session` lands in the directory the active tab represents:

- **Project Sessions tab**: the project `cwd` (the remembered project directory while in any automation context — an automation run session, or a session created inside the automation workspace).
- **Automation Runs tab**: the automation workspace (`/Users/jayseanqian/Desktop/on_board/cron_jobs`), so it is not counted into the current project's session list.

Sessions created on the automation side never overwrite the remembered project directory, so after a `New session` on the Automation Runs tab, reopening the overlay and pressing Project (or its `New session`) still leads back to the original project's history.

When the runtime already lives in the target directory with its default session dir, this behaves exactly like `/new`. Otherwise (different directory, or inside an automation run session whose session dir is the run's private `sessions/run` folder), the switcher creates a fresh session file in the target directory and switches to it.

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
