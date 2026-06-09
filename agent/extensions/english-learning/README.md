# english-learning extension

A Pi TUI extension for English learning.

## Features

- `Tab` while the input editor has non-empty normal text: rewrite Chinese/English input into natural English.
- `Command+Shift+M`: toggle a full-screen segmented translation overlay for the last assistant response. In Kaku this is forwarded as the private sequence `\x1b[993~`, matching the session/diff shortcut style.
- `/english translate [--force]`: command fallback for terminals that do not send shortcut events.
- `/english clear-cache`: clear cached full-screen translations.
- `/english debug-keys`: print raw key bytes for debugging shortcut support.

## Translation view

The overlay shows the assistant response in original order as a side-by-side diff view with a bordered status header:

- The header shows translation progress, text/code segment counts, current status, and the model channel as `(provider) model`.
- Original text appears in the left `Original` column with a warm background and left rail.
- Chinese translation appears in the right `Translation` column with a green background and left rail.
- Markdown code blocks appear once in `Code shown once` blocks; they are not sent to the model and are not translated.
- Related Markdown blocks are grouped into larger sections before translation, so headings, paragraphs, quotes, and lists stay readable instead of becoming many tiny cards.
- Translation streams into the matching `Translation` column when the model emits tagged output.
- Successful translations are cached in memory and reused when the same assistant response is opened again. The cache keeps the latest 50 responses and evicts older entries automatically.
- `Esc` or `Command+Shift+M` closes the overlay. Closing while streaming cancels the model request.
- Scroll with `↑/↓`, `PgUp/PgDn`, `g/G`, or touchpad/mouse wheel when the terminal supports mouse reporting.
- Press `f` to resume auto-follow after manually scrolling.

## Model selection

The extension only uses models already available in `ctx.modelRegistry.getAvailable()`:

1. Use the ChatGPT Plus/Pro OpenAI Codex subscription provider (`openai-codex`), especially `gpt-5.4-mini`.
2. Fall back only within the same subscription provider, for example `gpt-5.4`, `gpt-5.5`, or `gpt-5.3-codex-spark`.
3. Do not fall back to `opencode`/`opencode-go`, OpenAI API-key models, or the current Pi model.

It does not switch Pi's active agent model.
