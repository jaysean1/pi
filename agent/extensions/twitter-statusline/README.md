# twitter-statusline

An always-on, rotating **hot tweet** preview rendered directly above the
diff-review footer (a `belowEditor` widget). Press **↓** from an empty input to
focus it, use **Tab** to choose **View / All**, use **←/→** to move between
tweets, and **Enter** to open a read-only detail or full-screen browser overlay.

```
┌─ input ─────────────────────────────────────────────┐
│ >                                                    │
└──────────────────────────────────────────────────────┘
  🐦 Tim✨ @timyangnet · ♥ 55  🔁 5   [View]  All        ← this widget
  花了半天实测 Karpathy 提到的 LLM 知识库玩法…
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
- **View action**: press **d** to open the tweet detail URL in the local Chrome
  **X** app. Set `TWITTER_STATUSLINE_X_APP_ID` or
  `TWITTER_STATUSLINE_CHROME_PROFILE` if Chrome uses a different app/profile.
  If X is already open, the current PWA window is navigated to the tweet instead
  of opening another window.
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
| `preview.ts`    | The belowEditor rotating preview (Focusable)     |
| `detail.ts`     | View: single tweet + replies overlay (read-only) |
| `browser.ts`    | All: full-screen tweet list overlay (read-only)  |
| `chain.ts`      | Focus-chain contract with diff-review            |
