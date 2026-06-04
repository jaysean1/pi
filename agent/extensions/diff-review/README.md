# diff-review extension

Review files Pi created or modified during a session, or browse the current project when there are no session changes.

## What it does

- Tracks every file touched by the `write` and `edit` tools across the current session.
- Tracks files created, modified, or deleted under the session `cwd` by the `bash` tool using before/after project scans.
- Keeps the original content and latest content for each tracked file.
- Persists the tracked review set per Pi session, so it survives session switches, `/reload`, and Pi restarts.
- Opens a full-screen overlay with two tabs: `Diff` and `Files`.
- Defaults to `Diff` when there are session changes.
- Defaults to `Files` when there are no session changes.
- Provides a read-only project tree and file preview in `Files`.
- Read-only: it never changes, reverts, stages, deletes, or moves files.

## Location

Auto-discovered from:

```text
~/.pi/agent/extensions/diff-review/index.ts
```

No install or build step is needed. Pi runs the TypeScript directly. Run `/reload` after editing.

## Source layout

The extension keeps `index.ts` as the Pi entry point and stores implementation
files under `src/`.

```text
diff-review/
  index.ts              # Pi commands, events, and session wiring
  src/core/             # Diff logic, file tracking, persistence, and file tree data
  src/ui/               # Footer entry, full-screen overlay, and editor bridge
  src/platform/         # Terminal shortcut detection and external file launching
  src/demo.ts           # Sample data for /review-demo
```

Use this split when changing behaviour:

- Change tracking or saved review state in `src/core/file-state.ts`.
- Change diff rows or stats in `src/core/diff-engine.ts`; change wrapping helpers in `src/core/browse-tree.ts`.
- Change the footer `review` or `files` entry in `src/ui/footer.ts`.
- Change the full-screen `Diff` or `Files` view in `src/ui/overlay.ts`.
- Change key detection in `src/platform/keys.ts`.

## Open the overlay

| Trigger | Notes |
| --- | --- |
| `Command+Shift+Right` | Primary hotkey. Opens `Diff` when there are changes, otherwise `Files`. |
| `/review` | Same as the hotkey. |
| `/review diff` | Opens the `Diff` tab, even when it is empty. |
| `/review browse` | Opens the `Files` tab directly. |
| `/review-demo` | Opens sample diff data for testing the UI. |
| `/review status` | Shows how many files are tracked. |
| `/review clear` | Clears the current tracked review set. |
| `/review debug-keys` | Prints raw key bytes for 10 seconds. |
| Empty input `↓` | Focuses the `review` or `files` button in the footer path line. Press `Enter` to open the overlay. |

The hotkey is caught in three ways, matching the session-footer-switcher design: a
registered shortcut, a raw terminal-input safety net, and an editor wrapper that
catches the key while the prompt editor has focus.

The Kaku terminal sends `\x1b[992~` for `Command+Shift+Right`; this is matched
directly, alongside the generic Super-modified right-arrow CSI form. If your
terminal sends something else, run `/review debug-keys`, press the key, and report
the bytes so the sequence can be added.

## Footer entry

The extension adds the review entry to the same footer line as the current path, for example `~/Desktop/on_board`.

- With tracked changes, the path line also shows `📝 N file changes +A -R` and a pale-blue `📝 review` button.
- With no tracked changes, the path line shows the empty entry as a pale-blue `📁 files` button.
- When the input is focused and empty, press `↓` to focus this entry.
- From the focused entry, press `Enter` to open the same full-screen overlay as `/review`.
- The focused state highlights only the `review` or `files` button, not the full row.
- Right-side hints show the available action, such as `enter open · ↑ input`.
- Press `↑`, `←`, or `Esc` to return focus to the input.

## Tabs

Use `Tab` or `Shift+Tab` to switch between `📝 Diff` and `📁 Files`.

### Diff tab

The diff tab has a file list on the left and a vertical unified diff on the right.
Added lines use `+` markers and an addition background; removed lines use `-`
markers and a deletion background.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move file selection. |
| `PgUp` / `PgDn` | Jump selection or diff scroll by a page. |
| `Enter` | Open the selected file externally. |
| `Space` / `→` | Enter the diff pane. |
| `g` / `G` | Jump to top / bottom while the diff pane is focused. |
| `c` | Clear the current tracked review set and close the overlay. |
| `Esc` | Close from the file list, or return to the file list from the diff pane. |

### Files tab

The Files tab uses the current Pi session `cwd` as the project root. The left
pane shows a tree. The right pane previews the selected directory or file.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move tree selection, or scroll preview when the preview pane is focused. |
| `PgUp` / `PgDn` | Move or scroll by a page. |
| `Enter` | Open a file externally. Directories expand or collapse. |
| `Space` / `→` | Expand directories or focus a file preview. |
| `←` | Collapse a directory, move to its parent, or return from preview to tree. |
| `g` / `G` | Jump to top / bottom while the preview pane is focused. |
| `Esc` | Close from the tree, or return to the tree from the preview pane. |

## Tracking

Changes are captured from the `tool_call` (before) and `tool_result` (after)
hooks. For `write` and `edit`, the extension snapshots the addressed path. For
`bash`, it snapshots the current project tree before and after the command. The
review set is saved per Pi session under:

```text
~/.pi/agent/state/diff-review/
```

This means:

- Only edits made **after** the extension is installed and loaded are tracked.
- Switching to another Pi session and later switching back reloads that session's saved review set.
- Running `/reload` reloads the saved review set for the current session.
- Restarting Pi reloads the saved review set for the resumed session.
- Closing the overlay with `Esc` or the hotkey only hides it.
- Reopening shows the same tracked changes until you press `c` or run `/review clear`.
- Pressing `c` or running `/review clear` deletes only the current session's saved review set.

Use `/review status` to confirm tracking is working after an edit.

## Scope and limits

- Tracking is **session-cumulative**: it accumulates all unreviewed changes.
- Tracking is global to the session for `write` and `edit`; files edited outside the current directory are included in `Diff`.
- `bash` tracking is project-scoped: it scans regular files under the session `cwd`, skipping common heavy folders.
- Bash scans are capped at 2,500 files and 16 MB of captured text per scan; if a cap is hit, some files may show a note or be omitted.
- New files show as all additions. Files reverted to their original content are hidden.
- Binary files, skipped files, and files larger than 512 KB are listed with a note instead of a diff or preview.
- Diff rows wrap to the unified diff pane width.
- Files previews wrap long lines to the preview pane width.
- `Files` skips common heavy folders such as `.git`, `node_modules`, `dist`, `build`, caches, and virtual environments.
- Diff rows use `+` / `-` markers, colour-blind-safe foreground colours, and distinct addition/deletion backgrounds.

## Notes

- If the hotkey does not fire, use `/review`, then `/review debug-keys` to capture the exact sequence.
- This extension is independent of the `session-footer-switcher` extension, which uses `Command+Shift+Left` (`\x1b[991~` in Kaku).
