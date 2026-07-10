# youtube-music (pi extension)

Browse your **private YouTube Music playlists** in a full-screen TUI inside pi,
play them through [`@involvex/youtube-music-cli`](https://github.com/involvex/youtube-music-cli)
(mpv + yt-dlp) as the backend engine, and **like** tracks — all without leaving pi.

```
┌─ 🎵 YouTube Music ──────────────────────────────────────┐
│ ♪ Man I Need — Olivia Dean   ▶ 1:23/3:22 ▰▰▰▱▱  🔊70    │ ← pinned now-playing
├─────────────────────────────────────────────────────────┤
│ Liked Music (128)   ‹Esc back›                          │
│  › 1  Man I Need        Olivia Dean        3:22   ♥      │
│    2  Choosin' Texas    Ella Langley       7:02         │
├─────────────────────────────────────────────────────────┤
│ ↑↓ · Enter play · Space pause · n/p skip · l like · Esc │
└─────────────────────────────────────────────────────────┘
```

## Requirements

- `mpv` and `yt-dlp` on PATH (`brew install mpv yt-dlp`)
- `@involvex/youtube-music-cli` (`npm i -g @involvex/youtube-music-cli`)
- Logged into **YouTube Music in a Chromium browser** (Chrome/Brave/Edge/Arc),
  or paste a `music.youtube.com` Cookie header locally via `/ytm login`.
  Cookies are read/stored locally and never leave your machine.

## Usage

- **Open:** `⌘⇧M` (Command+Shift+M) or the `/ytm` command.
- **Navigate:** `↑/↓` or `j/k`, `PageUp/PageDown`.
- **Open playlist / play track:** `Enter`.
- **Playback:** `Space` play/pause · `n` next · `p`/`b` previous.
- **Like / unlike selected track:** `l`.
- **Back / close:** `Esc`.

Command shortcuts: `/ytm`, `/ytm pause`, `/ytm next`, `/ytm prev`, `/ytm stop`, `/ytm auth`, `/ytm status`, `/ytm debug-keys`, `/ytm login`, `/ytm logout`, `/ytm account <email>`.

> **Shortcut choice:** `⌘⇧M` is mnemonic for Music and avoids Kaku's built-in
> `⌘⇧Y` (Yazi) plus local Pi shortcuts using `⌘⇧←` / `⌘⇧→`. Kaku is configured
> in `~/.config/kaku/kaku.lua` to forward this as `ESC [ 993 ~`. The `/ytm`
> command always works as a fallback.

## Manual login

Use this when browser auto-detect cannot pick the right account:

1. Open `https://music.youtube.com` in a Chromium browser and confirm the intended
   account is active.
2. Open DevTools → Network, refresh the page, select any `music.youtube.com`
   request, and copy the full request header named `Cookie`.
3. In pi, run `/ytm login` and paste that `Cookie:` header into the local editor.
4. Run `/ytm auth` to re-check. Use `/ytm logout` to remove the saved manual
   cookie and return to browser auto-detect.

Never share your Google password. Prefer not to paste the cookie into chat; it is
an account credential. `/ytm login` stores it locally in
`~/.pi/cache/youtube-music/config.json` with `0600` permissions.

## How it works

| Layer | Module | What it does |
|-------|--------|--------------|
| Auth | `auth.ts`, `cookies.ts` | Auto-detects the browser profile that's **logged into YouTube** (has `LOGIN_INFO`) and builds an authenticated `youtubei.js` client. Only `.youtube.com` cookies are used (mixing in `google.com` cookies breaks YT Music auth). |
| Data | `data.ts` | Lists your library playlists (`FEmusic_liked_playlists` + Liked Music), fetches tracks, and likes via the `/like/like` endpoint. |
| Engine | `engine.ts` | Spawns `youtube-music-cli --web-only` and drives it over its WebSocket control API. **Owns the queue + progress** because the daemon doesn't advance progress or auto-play the next track; auto-advances at track end using known durations. It writes local yt-dlp cookies and launches the daemon with an `MPV_PATH` wrapper so YouTube playback does not hit the bot/sign-in wall. The engine is process-global so playback survives `/clear`, `/new`, `/resume`, `/fork`, and `/reload`; `/ytm stop` or quitting pi kills mpv + the daemon. |
| UI | `fullscreen-view.ts`, `nowplaying.ts`, `render.ts` | The full-screen overlay and the pinned now-playing bar. |

## Configuration

`~/.pi/cache/youtube-music/config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `port` | `8782` | WebSocket port for the engine daemon |
| `browserProfile` | `"auto"` | `"auto"` scans for the YouTube-logged-in profile; or set `"Default"` / `"Profile 1"` |
| `account` | – | Optional target account filter for browser auto-detect; set with `/ytm account <email>` |
| `cookie` | – | Manual override: paste a full `Cookie` header from a logged-in `music.youtube.com` request via `/ytm login` (also via env `YTM_COOKIE`) |
| `enginePath` | `"youtube-music-cli"` | Path to the engine binary |

## Limitations / notes

- **Public playlists by id** also work via the data layer, but the UI lists your
  private library. Search is intentionally **not** included.
- Auto-advance uses track duration as a timer (no live EOF signal from the
  daemon), so it can drift by a second or two.
- If private playlists show *"Sign in"*, open YouTube Music in your browser and
  log in with the intended account, then run `/ytm auth`; or run `/ytm login`
  and paste the full `Cookie:` header from a signed-in `music.youtube.com`
  request. Do **not** paste your Google password into pi or chat.

## Dev

Typecheck: `../rpiv-mono/node_modules/.bin/tsc -p tsconfig.json` (uses the pi
type packages from the sibling `rpiv-mono` install via `paths`).
