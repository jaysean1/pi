# Personal Pi configuration

My [Pi coding agent](https://github.com/earendil-works/pi-mono) configuration, custom extensions, agent profiles, and plugin experiments.

## Highlights

- English input optimization and response translation
- Session recaps and recent-work summaries
- Custom intro header, footer, status line, and session switcher
- Diff review overlay
- Codex and Claude usage display
- Optional/disabled experiments for Twitter and YouTube Music

## Layout

- `agent/extensions/` — global Pi extensions
- `agent/agents/` — subagent profiles
- `agent/settings.json` — package and model configuration
- `agent/npm/` — pinned extension dependencies
- `web-search.example.json` — safe example for `~/.pi/web-search.json`

## Installation

Review the source before installing: Pi extensions run with full user permissions.

For a fresh setup, copy the desired files into `~/.pi/agent/`, install the packages listed in `agent/settings.json`, and copy `web-search.example.json` to `~/.pi/web-search.json` if needed. Local package paths such as `../../.vibe-island/pi-extension` are optional and machine-specific.

## Security

Credentials and runtime data are intentionally excluded, including:

- `agent/auth.json`
- sessions, state, caches, generated files, and project trust decisions
- live `web-search.json`
- local memory and prompt-suggester project seeds

No API keys, OAuth tokens, browser cookies, or session credentials should be committed. Authentication is resolved at runtime through Pi or environment variables.
