# twitter-statusline

An always-on, rotating **hot tweet** preview rendered directly above the
diff-review footer (a `belowEditor` widget). Press **↓** from an empty input to
focus it, use **Tab** to choose **View / All**, use **←/→** to move between
tweets, and **Enter** to open a read-only detail or full-screen browser overlay.

The preview is a single compact line: **username · publish time**, the **like
count**, and the **post content**, with the **View / All** buttons pinned to the
far right. When the middle overflows it is ellipsis-truncated (`…`) just before
the buttons.

Each field is color-coded by its nature so the line is easy to scan:

| Field          | Theme color                         | Meaning              |
|----------------|-------------------------------------|----------------------|
| display name   | `accent` (bold when focused)        | author identity      |
| `@handle`      | `muted`                             | secondary identity   |
| `· time`        | `dim`                               | metadata             |
| `♥ likes`       | `success` (green)                   | engagement metric    |
| post content   | `text` when focused, `dim` when idle| the tweet body       |
| `(stale)`      | `warning`                           | cache is stale       |

```
┌─ input ─────────────────────────────────────────────┐
│ >                                                    │
└──────────────────────────────────────────────────────┘
  Tim✨ @timyangnet · 2026-04-04 14:33  ♥ 55  花了半天实测 Karpathy…  [View]  All   ← this widget
~/.pi (main) · 📁 files · ↓ focus                          ← diff-review footer
$0.000 (sub) 0.0%/1.0M · (anthropic) claude-opus-4-8
```

## Login state

Uses the `twitter` CLI directly — the same binary the onboard `twitter-feed`
skill relies on. It transparently reuses the Chrome login cookies, so no extra
credential handling is needed. Verify with `twitter whoami`.

## Behaviour

- **Source**: `twitter feed --filter -n 20 --json` (score-ranked home timeline).
- **Refresh**: the network feed is re-fetched every ~30 seconds and cached to
  `~/.pi/cache/twitter-statusline/feed.json`. The preview rotates through the
  cached tweets every **30 s** locally. Rotation pauses
  while the preview is focused. After 10 minutes without a successful refresh the
  bar shows `(stale)`.
- **View** → read-only full-screen overlay of the current tweet + replies
  (`twitter tweet`); scroll with **↑/↓**, **PgUp/PgDn**, or the **touchpad**.
- **View action**: press **Enter** to open the tweet in a normal **Google
  Chrome** tab that is navigated **in place**. AppleScript first reuses the tab
  this extension used last time, then an existing `x.com` / `twitter.com` tab,
  and only creates a tab if none exists; the final last-resort fallback is
  `open -b com.google.Chrome <url>`. (The installed **X.app** PWA was evaluated
  and rejected: Chrome PWA windows expose no scriptable URL and x.com's
  `launch_handler` opens a new app window per launch, so the PWA cannot be
  updated in place — only swapped, which flashes windows.)
- **All** → full-screen, scrollable list of the cached hot tweets; scroll with
  **↑/↓**, **PgUp/PgDn**, or the **touchpad**, `Enter` opens a tweet's detail,
  **r** refreshes recent hot tweets, `Esc` returns to the list.

Both overlays open full-screen (`width/maxHeight 100%`, anchored top-left) so they
don't collide with other centered overlays, and enable terminal mouse reporting
for two-finger touchpad / wheel scrolling (restored on close).
- Everything is best-effort: any CLI/network failure falls back to the previous
  cache and never throws into the session.

## Focus chain (input → Twitter → diff)

- **↓** from an empty input focuses the Twitter preview; **↓** again focuses the
  diff-review footer.
- **↑** walks back up (diff → Twitter → input); **Esc** from the preview jumps to
  the input.

This is coordinated with the `diff-review` extension over `globalThis`
(`__piTwitterChain` / `__piDiffChain`, see `chain.ts`). diff-review yields the
empty-input **↓** to this extension when the chain handle is published, and its
footer's **↑** hands focus back to the preview.

> Load order note: this extension publishes `__piTwitterChain` and consumes the
> ↓ that diff-review yields. The cooperation is load-order independent, but the
> entry keystroke assumes diff-review is also loaded from
> `~/.pi/agent/extensions/`.

## Commands

| Command            | Action                                    |
|--------------------|-------------------------------------------|
| `/twitter`         | Focus the preview                         |
| `/twitter refresh` | Force a network refresh of the feed cache |
| `/twitter open`    | Open the full-screen browser overlay      |

## Files

| File            | Responsibility                                   |
|-----------------|--------------------------------------------------|
| `index.ts`      | Wiring: widget, timers, input chain, commands    |
| `twitter-cli.ts`| `twitter` CLI wrapper, JSON parsing, disk cache  |
| `render.ts`     | Width-aware tweet formatting helpers             |
| `preview.ts`    | The belowEditor single-line preview (Focusable)  |
| `detail.ts`     | View: single tweet + replies overlay (read-only) |
| `browser.ts`    | All: full-screen tweet list overlay (read-only)  |
| `chain.ts`      | Focus-chain contract with diff-review            |
