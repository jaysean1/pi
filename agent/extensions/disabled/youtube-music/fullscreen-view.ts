// Full-screen YouTube Music overlay: pinned now-playing header on top, then a
// navigable list that switches between the user's playlists and a playlist's
// tracks. Opened via ⌘⇧M or the /ytm command.
//
//   ↑/↓ or j/k  move      Enter  open playlist / play track
//   Space play-pause      n/p    next / previous       l  like track
//   Esc         back (tracks → playlists) or close
//   ⌘⇧M         close from anywhere (toggle, handled in index.ts)

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitWidth, fmtDuration, padTo, progressBar, stripAnsi } from "./render.ts";
import type { Playlist, PlayerState, Track } from "./types.ts";

export interface FullscreenDeps {
	loadPlaylists: () => Promise<Playlist[]>;
	loadTracks: (playlistId: string) => Promise<{ title: string; tracks: Track[] }>;
	getState: () => PlayerState | undefined;
	onStateChange?: (cb: () => void) => () => void;
	onPlay: (tracks: Track[], index: number, playlistTitle: string) => Promise<boolean>;
	onTogglePlay: () => void;
	onNext: () => void;
	onPrev: () => void;
	onLike: (videoId: string, like: boolean) => Promise<boolean>;
}

const VISIBLE = 12;

type Mode = "playlists" | "tracks";

export class FullscreenView implements Component, Focusable {
	focused = false;

	private mode: Mode = "playlists";
	private loading = true;
	private status: { kind: "info" | "error"; message: string } | undefined;

	private playlists: Playlist[] = [];
	private tracks: Track[] = [];
	private currentPlaylist: Playlist | undefined;

	private selPlaylist = 0;
	private offPlaylist = 0;
	private selTrack = 0;
	private offTrack = 0;

	private likedOverride = new Map<string, boolean>();
	private unsubState: (() => void) | undefined;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly deps: FullscreenDeps,
		private readonly done: () => void,
	) {
		this.unsubState = deps.onStateChange?.(() => this.tui.requestRender());
		void this.refreshPlaylists();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubState?.();
		this.unsubState = undefined;
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	// --- data ---------------------------------------------------------------

	private async refreshPlaylists(): Promise<void> {
		this.loading = true;
		this.tui.requestRender();
		try {
			this.playlists = await this.deps.loadPlaylists();
			this.status = this.playlists.length === 0
				? { kind: "error", message: "No playlists found — are you signed in to YouTube Music?" }
				: undefined;
		} catch (err) {
			this.status = { kind: "error", message: `Failed to load playlists — ${msg(err)}` };
			this.playlists = [];
		} finally {
			this.loading = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private async openSelectedPlaylist(): Promise<void> {
		const pl = this.playlists[this.selPlaylist];
		if (!pl) return;
		this.mode = "tracks";
		this.currentPlaylist = pl;
		this.tracks = [];
		this.selTrack = 0;
		this.offTrack = 0;
		this.loading = true;
		this.status = { kind: "info", message: `Loading "${pl.title}"…` };
		this.tui.requestRender();
		try {
			const { tracks } = await this.deps.loadTracks(pl.id);
			this.tracks = tracks;
			this.status = tracks.length === 0 ? { kind: "info", message: "This playlist is empty." } : undefined;
		} catch (err) {
			this.status = { kind: "error", message: `Failed to load tracks — ${msg(err)}` };
		} finally {
			this.loading = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private async playSelected(): Promise<void> {
		const t = this.tracks[this.selTrack];
		if (!t) return;
		this.status = { kind: "info", message: `Starting "${t.title}"…` };
		this.tui.requestRender();
		const ok = await this.deps.onPlay(this.tracks, this.selTrack, this.currentPlaylist?.title ?? "");
		if (!this.disposed) {
			this.status = ok
				? { kind: "info", message: `▶ ${t.title}` }
				: { kind: "error", message: "Engine unavailable — is `youtube-music-cli` installed? (mpv + yt-dlp required)" };
			this.tui.requestRender();
		}
	}

	private async likeSelected(): Promise<void> {
		if (this.mode !== "tracks") return;
		const t = this.tracks[this.selTrack];
		if (!t) return;
		const next = !(this.likedOverride.get(t.videoId) ?? false);
		this.likedOverride.set(t.videoId, next); // optimistic
		this.status = { kind: "info", message: `${next ? "Liking" : "Removing like from"} "${t.title}"…` };
		this.tui.requestRender();
		const ok = await this.deps.onLike(t.videoId, next);
		if (!ok) {
			this.likedOverride.set(t.videoId, !next); // rollback
			this.status = { kind: "error", message: `Couldn't update like for "${t.title}"` };
		} else {
			this.status = { kind: "info", message: next ? `♥ Liked "${t.title}"` : `Removed like` };
		}
		if (!this.disposed) this.tui.requestRender();
	}

	// --- input --------------------------------------------------------------

	handleInput(data: string): void {
		// Global playback controls (work in both modes).
		if (matchesKey(data, Key.space)) return void this.deps.onTogglePlay();
		if (matchesKey(data, "n")) return void this.deps.onNext();
		if (matchesKey(data, "p") || matchesKey(data, "b")) return void this.deps.onPrev();

		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			if (this.mode === "tracks") {
				this.mode = "playlists";
				this.status = undefined;
				this.tui.requestRender();
			} else {
				this.done();
			}
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) return this.move(-1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-VISIBLE);
		if (matchesKey(data, Key.pageDown)) return this.move(VISIBLE);
		if (matchesKey(data, Key.enter)) {
			if (this.mode === "playlists") void this.openSelectedPlaylist();
			else void this.playSelected();
			return;
		}
		if (matchesKey(data, "l") || matchesKey(data, "shift+l")) return void this.likeSelected();
	}

	private listLength(): number {
		return this.mode === "playlists" ? this.playlists.length : this.tracks.length;
	}

	private move(delta: number): void {
		const len = this.listLength();
		if (len === 0) return;
		if (this.mode === "playlists") {
			this.selPlaylist = clamp(this.selPlaylist + delta, 0, len - 1);
			[this.offPlaylist] = scroll(this.selPlaylist, this.offPlaylist, len);
		} else {
			this.selTrack = clamp(this.selTrack + delta, 0, len - 1);
			[this.offTrack] = scroll(this.selTrack, this.offTrack, len);
		}
		this.tui.requestRender();
	}

	// --- render -------------------------------------------------------------

	render(width: number): string[] {
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const innerW = Math.max(28, width - 2);
		const lines: string[] = [];

		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		lines.push(this.row(innerW, th.bold(th.fg("accent", " 🎵 YouTube Music"))));
		// Pinned now-playing header.
		for (const l of this.renderNowPlaying(innerW)) lines.push(this.row(innerW, l));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Context title / breadcrumb.
		const crumb =
			this.mode === "playlists"
				? `Playlists (${this.playlists.length})`
				: `${this.currentPlaylist?.title ?? "Playlist"}  ‹Esc back›   (${this.tracks.length})`;
		lines.push(this.row(innerW, th.fg("dim", fitWidth(crumb, innerW - 1))));

		// List body.
		for (const l of this.renderList(innerW)) lines.push(this.row(innerW, l));

		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(this.row(innerW, th.fg(this.status?.kind === "error" ? "warning" : "dim", fitWidth(this.footer(), innerW - 1))));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines;
	}

	private renderNowPlaying(innerW: number): string[] {
		const th = this.theme;
		const st = this.deps.getState();
		if (!st || !st.track?.title) {
			return [th.fg("dim", " ♪  — nothing playing —")];
		}
		const t = st.track;
		const head = `${t.title}${t.artists ? th.fg("dim", ` — ${t.artists}`) : ""}`;
		const time = `${fmtDuration(st.progress)}/${fmtDuration(st.duration || t.duration || 0)}`;
		const icon = st.isPlaying ? "▶" : "⏸";
		const barW = Math.min(18, Math.max(6, innerW - 30));
		const bar = progressBar(st.progress, st.duration || t.duration || 0, barW);
		const vol = `🔊${st.volume}`;
		const meta = th.fg("dim", `${icon} ${time}  `) + th.fg("accent", bar) + th.fg("dim", `  ${vol}`);
		return [
			" " + th.fg("accent", "♪ ") + fitWidth(head, innerW - 3),
			" " + meta,
		];
	}

	private renderList(innerW: number): string[] {
		const th = this.theme;
		if (this.loading) return [th.fg("dim", "   Loading…")];
		const len = this.listLength();
		if (len === 0) return [th.fg("dim", "   (empty)")];

		const out: string[] = [];
		if (this.mode === "playlists") {
			const off = this.offPlaylist;
			for (let i = off; i < Math.min(len, off + VISIBLE); i++) {
				const pl = this.playlists[i]!;
				const sel = i === this.selPlaylist;
				const marker = sel ? "›" : " ";
				const right = pl.subtitle ? th.fg("dim", fitWidth(pl.subtitle, 18)) : "";
				// Measure in terminal columns, not UTF-16 code units (CJK/emoji = 2 cols).
				const rightW = pl.subtitle ? Math.min(18, visibleWidth(right)) : 0;
				const titleBudget = Math.max(6, innerW - 4 - rightW - 2);
				const label = `${marker} ${fitWidth(pl.title, titleBudget)}`;
				const gap = Math.max(2, innerW - 1 - visibleWidth(label) - rightW);
				const line = `${label}${" ".repeat(gap)}${right}`;
				out.push(sel ? th.bg("selectedBg", th.bold(th.fg("accent", padTo(stripAnsi(line), innerW - 1)))) : th.fg("text", label) + " ".repeat(gap) + right);
			}
		} else {
			const off = this.offTrack;
			for (let i = off; i < Math.min(len, off + VISIBLE); i++) {
				const t = this.tracks[i]!;
				const sel = i === this.selTrack;
				const marker = sel ? "›" : " ";
				const num = `${i + 1}`.padStart(2, " ");
				const liked = this.likedOverride.get(t.videoId);
				const heart = liked ? " ♥" : "";
				const dur = fmtDuration(t.duration);
				const rightW = visibleWidth(dur) + visibleWidth(heart) + 1;
				const titleBudget = Math.max(8, Math.floor((innerW - 6 - rightW) * 0.55));
				const artBudget = Math.max(6, innerW - 6 - rightW - titleBudget - 2);
				const title = fitWidth(t.title, titleBudget);
				const art = fitWidth(t.artists, artBudget);
				const left = `${marker} ${num} ${title}`;
				const mid = th.fg("dim", art);
				const gap1 = Math.max(2, innerW - 1 - visibleWidth(left) - visibleWidth(art) - rightW);
				const rightStr = th.fg("dim", dur) + th.fg("accent", heart);
				const plain = `${left}${" ".repeat(gap1)}${art}  ${dur}${heart}`;
				out.push(
					sel
						? th.bg("selectedBg", th.bold(th.fg("accent", padTo(stripAnsi(plain), innerW - 1))))
						: th.fg("text", left) + " ".repeat(gap1) + mid + "  " + rightStr,
				);
			}
		}
		return out;
	}

	private footer(): string {
		if (this.status) return this.status.message;
		if (this.mode === "playlists") return "↑↓ select · Enter open · Space play/pause · n/p skip · Esc/⌘⇧M close";
		return "↑↓ · Enter play · Space pause · n/p skip · l like · Esc back · ⌘⇧M close";
	}

	private row(innerW: number, content: string): string {
		const border = (s: string) => this.theme.fg("border", s);
		const w = visibleWidth(content);
		const pad = innerW - 1 - w;
		// Clamp overly-wide content (e.g. long CJK titles) so a row can never exceed
		// the box width and crash the renderer.
		const body = pad >= 0 ? ` ${content}${" ".repeat(pad)}` : ` ${truncateToWidth(content, innerW - 1)}`;
		return border("│") + body + border("│");
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/** Returns [newOffset] keeping `sel` within a VISIBLE-row window. */
function scroll(sel: number, off: number, len: number): [number] {
	let o = off;
	if (sel < o) o = sel;
	else if (sel >= o + VISIBLE) o = sel - VISIBLE + 1;
	o = Math.max(0, Math.min(o, Math.max(0, len - VISIBLE)));
	return [o];
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
