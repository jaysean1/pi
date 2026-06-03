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
- **View** → read-only overlay of the current tweet + replies (`twitter tweet`).
- **View action**: press **Enter** to open the tweet in **Google Chrome**, reusing
  an already-open tab. Via AppleScript it looks for an existing `x.com` /
  `twitter.com` tab in any running Chrome window, navigates that tab to the tweet
  and focuses its window; if none exists it opens a single new tab in the front
  window. Pressing **Enter** on another tweet reuses the same tab — it never piles
  up new windows. (Chrome's installed **X** PWA / app-mode windows can't be
  scripted or reliably reused from the command line, so a normal browser tab is
  used instead.) Falls back to `open -b com.google.Chrome <url>` (a plain tab, no
  reuse) if the AppleScript path fails.
- **All** → full-screen, scrollable list of the cached hot tweets; `Enter` opens
  a tweet's detail, **r** refreshes recent hot tweets, `Esc` returns to the list.
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
