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

The 3D shadow is theme-aware: on light themes it darkens the face colour toward
black, while on dark themes it is lifted **up from the background** toward the
face colour (`SHADOW_DARK_BG` / `SHADOW_DARK_MIX`) so the extrude stays visible
instead of sinking into a dark terminal background. The unrevealed "ghost"
cells during the sweep use the same dark-mode lift (`GHOST_DARK_MIX`). Dark
mode is detected from the theme name (or body-text luminance for custom
themes) and re-checked on theme hot-swaps.

Below the wordmark it delegates the **Recent History** list to the sibling
`jaysean-recent-work` component. The list is loaded only when this header is
installed for a fresh session / Pi startup. On `/reload`, the header stays
visible but the wordmark is rendered in its frozen final state rather than
replaying the animation.

## Hiding Pi's built-in startup listing

Pi prints a `[Context] / [Skills] / [Extensions]` block into the chat at startup.
That block is core (not a header), so an extension cannot replace it. To keep the
startup focused on the intro animation and Recent History, `quietStartup` is enabled in
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

## Customise

Open `index.ts` and edit the constants near the top:

- `WORD` — the narrow-terminal fallback text.
- `RED_START` / `RED_END` — the frozen red gradient (RGB). `HIGHLIGHT` is the
  white sweep crest.
- `HUE_SPREAD` / `ROW_HUE` / `CYCLE_SPEED` / `RAINBOW_SAT` / `RAINBOW_LIGHT` —
  the animated rainbow during the reveal.
- `SHADOW_MUL` — light-mode shadow darkness; `SHADOW_DARK_BG` /
  `SHADOW_DARK_MIX` — dark-mode shadow lift; `GHOST_MUL` / `GHOST_DARK_MIX` —
  unrevealed-ghost brightness per mode.
- `SWEEP_MS` — reveal duration; `SETTLE_MS` — rainbow→red morph duration.
- `FRAME_MS` — frame interval while animating (lower = smoother, more CPU).
- `HEADER_INDENT` — left inset for the wordmark and Recent History.

The animation is one-shot by design: the `setInterval` timer is cleared once the
sweep finishes, so it does not burn CPU while you work. The timer is also
`unref`'d so it never keeps the process alive.
