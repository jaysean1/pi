# english-learning extension

A Pi TUI extension for English learning.

## Features

- `Tab` while the input editor has non-empty normal text: rewrite Chinese/English input into natural English.
- `Command+Shift+M`: toggle a full-screen segmented translation overlay for the last assistant response. In Kaku this is forwarded as the private sequence `\x1b[993~`, matching the session/diff shortcut style.
- `/english translate [--force]`: command fallback for terminals that do not send shortcut events.
- `/english debug-keys`: print raw key bytes for debugging shortcut support.

## Translation view

The overlay shows the assistant response in original order as a compact comparison view with a bordered status header:

- The header shows translation progress, text/code segment counts, current status, and the model channel as `(provider) model`.
- Original text appears in `Original` blocks with a warm background and left rail.
- Chinese translation appears in `Translation` blocks with a green background and left rail.
- Markdown code blocks appear once in `Code shown once` blocks; they are not sent to the model and are not translated.
- Translation streams into the matching `Translation` blocks when the model emits tagged output.
- `Esc` or `Command+Shift+M` closes the overlay. Closing while streaming cancels the model request.
- Scroll with `↑/↓`, `PgUp/PgDn`, `g/G`, or touchpad/mouse wheel when the terminal supports mouse reporting.
- Press `f` to resume auto-follow after manually scrolling.

## Model selection

The extension only uses models already available in `ctx.modelRegistry.getAvailable()`:

1. Prefer logged-in OpenAI mini models such as `gpt-5-mini`, `gpt-5.4-mini`, or `gpt-4.1-mini`.
2. Fall back to any logged-in fast model with names like `mini`, `lite`, `haiku`, `flash`, or `turbo`.
3. Fall back to the current Pi model if needed.

It does not switch Pi's active agent model.
