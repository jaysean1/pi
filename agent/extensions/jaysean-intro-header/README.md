# jaysean-intro-header

An animated 3D ASCII wordmark shown at the top of the Pi UI on startup, with a Claude Code-style two-space left inset.

On `session_start` it sets a custom header via `ctx.ui.setHeader(...)`. The header
draws a **bold** "JAYSEAN" wordmark with a **down-left** 3D extrude and plays a
one-shot intro in three phases:

1. **Reveal** — a diagonal light sweep wipes in a flowing, ultrathink-style
   rainbow shimmer (hue rotates over time, across columns and rows).
2. **Cool down** — the rainbow morphs into the final red palette.
3. **Freeze** — settles on a red gradient: deep crab red `#be1a22` →
   Claude burnt-orange / coral `#d97757`.

Truecolor terminals get 24-bit colour; 256-colour terminals get a cube fallback.

Below the wordmark it delegates the **recent-work summary** to the sibling
`jaysean-recent-work` extension. That section is aligned to the same inset and
shows the last few sessions for this workspace with relative time (`now` / `34m`
/ `2h` / `2d`). The current session is excluded.

`jaysean-recent-work` is responsible for scanning sessions, reusing
`session-recap/line` summaries, background LLM summarisation, and heuristic
fallbacks. This keeps the header focused on rendering the intro shell.

## Hiding Pi's built-in startup listing

Pi prints a `[Context] / [Skills] / [Extensions]` block into the chat at startup.
That block is core (not a header), so an extension cannot replace it. To let this
header's summary be the main thing at the top, `quietStartup` is enabled in
`~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

Set it back to `false` to restore the full listing. Billing/auth warnings and
diagnostics still show regardless.

## Install

This folder lives in `~/.pi/agent/extensions/`, so Pi auto-discovers it. No
`settings.json` change is needed. Run `/reload` or restart `pi` to see it.

## Commands

- `/intro` — replay the intro animation in the current session.
- `/recent` — refresh the delegated recent-work section.

## Customise

Open `index.ts` and edit the constants near the top:

- `WORD` — the narrow-terminal fallback text.
- `RED_START` / `RED_END` — the frozen red gradient (RGB). `HIGHLIGHT` is the
  white sweep crest.
- `HUE_SPREAD` / `ROW_HUE` / `CYCLE_SPEED` / `RAINBOW_SAT` / `RAINBOW_LIGHT` —
  the animated rainbow during the reveal.
- `SWEEP_MS` — reveal duration; `SETTLE_MS` — rainbow→red morph duration.
- `FRAME_MS` — frame interval while animating (lower = smoother, more CPU).
- `HEADER_INDENT` — left inset for both the wordmark and delegated recent section.

Configure recent-session count, LLM model, and cache behavior in
`jaysean-recent-work` via `recentWork` settings.

The animation is one-shot by design: the `setInterval` timer is cleared once the
sweep finishes, so it does not burn CPU while you work. The timer is also
`unref`'d so it never keeps the process alive.
