// View: a read-only overlay showing a single tweet and its replies.
// Opened from the preview's [View] action via ctx.ui.custom({ overlay: true }).

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	authorWithTime,
	formatCount,
	metricsPlain,
	wrapLines,
} from "./render.ts";
import {
	enableMouseWheel,
	isMouseSequence,
	parseWheelEvents,
} from "./mouse.ts";
import { fetchTweet, type Tweet, type TweetThread } from "./twitter-cli.ts";

// Fixed chrome around the scrollable body: top border, title, divider, footer
// divider, footer hint, bottom border.
const CHROME_ROWS = 6;
// Lines scrolled per wheel notch; matches the diff-review overlay.
const WHEEL_SCROLL_LINES = 3;

type ActionStatus = { kind: "info" | "error"; message: string };
export type OpenTweetExternal = (tweet: Tweet) => Promise<void>;

const OPEN_EXTERNAL_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function stripAnsi(s: string): string {
	let out = "";
	let inEsc = false;
	for (const ch of s) {
		if (ch === "\u001b") {
			inEsc = true;
			continue;
		}
		if (inEsc) {
			if (ch === "m") inEsc = false;
			continue;
		}
		out += ch;
	}
	return out;
}

export class TweetDetailOverlay implements Component, Focusable {
	focused = false;
	private thread: TweetThread;
	private loading = true;
	private error: string | undefined;
	private actionStatus: ActionStatus | undefined;
	private openingExternal = false;
	private scroll = 0;
	private disposed = false;
	private readonly disableMouse: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		seed: Tweet,
		private readonly close: () => void,
		private readonly openExternal?: OpenTweetExternal,
	) {
		// Seed with the cached tweet so there is something to show immediately.
		this.thread = { tweet: seed, replies: [] };
		// Touchpad two-finger scrolling arrives as wheel reports once mouse
		// reporting is on. dispose() restores the terminal on close.
		this.disableMouse = enableMouseWheel(tui.terminal);
		void this.load(seed.id);
	}

	// Body height for the current full-screen terminal.
	private bodyRows(): number {
		return Math.max(3, this.tui.terminal.rows - CHROME_ROWS);
	}

	private async load(id: string): Promise<void> {
		try {
			const thread = await fetchTweet(id, 12);
			if (this.disposed) return;
			this.thread = thread;
		} catch (e) {
			if (this.disposed) return;
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!this.disposed) {
				this.loading = false;
				this.tui.requestRender();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.disableMouse();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		// Touchpad / wheel scrolls the body; aggregate batched reports.
		const wheel = parseWheelEvents(data);
		if (wheel.length > 0) {
			let delta = 0;
			for (const direction of wheel) {
				delta += direction === "down" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES;
			}
			if (delta !== 0) {
				this.scroll = Math.max(0, this.scroll + delta); // clamped during render
				this.tui.requestRender();
			}
			return;
		}
		// Swallow click/release reports so they never reach key matching.
		if (isMouseSequence(data)) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openCurrentTweetExternal();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scroll = Math.max(0, this.scroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scroll += 1; // clamped during render
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll = Math.max(0, this.scroll - this.bodyRows());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll += this.bodyRows();
			this.tui.requestRender();
		}
	}

	private openCurrentTweetExternal(): void {
		if (!this.openExternal || this.openingExternal) return;
		this.openingExternal = true;
		this.actionStatus = { kind: "info", message: "opening detail…" };
		this.tui.requestRender();
		void withTimeout(
			this.openExternal(this.thread.tweet),
			OPEN_EXTERNAL_TIMEOUT_MS,
		)
			.then(() => {
				if (this.disposed) return;
				this.actionStatus = { kind: "info", message: "opened detail" };
			})
			.catch((error) => {
				if (this.disposed) return;
				this.actionStatus = {
					kind: "error",
					message: `open failed — ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.openingExternal = false;
				if (!this.disposed) this.tui.requestRender();
			});
	}

	// --- Content -------------------------------------------------------------

	private buildContent(innerWidth: number): string[] {
		const th = this.theme;
		const dim = (s: string) => th.fg("dim", s);
		const out: string[] = [];
		const t = this.thread.tweet;

		out.push(th.bold(th.fg("accent", authorWithTime(t))));
		out.push("");
		for (const line of wrapLines(t.text, innerWidth, 40))
			out.push(th.fg("text", line));
		if (t.media.length > 0) {
			out.push("");
			for (const md of t.media) out.push(dim(`🖼 ${md.type}: ${md.url}`));
		}
		out.push("");
		out.push(th.fg("text", this.metricsDetailed(t)));
		out.push(dim("─".repeat(Math.max(1, innerWidth))));

		if (this.loading) {
			out.push(dim("loading replies…"));
		} else if (this.error) {
			out.push(th.fg("warning", `replies unavailable — ${this.error}`));
		} else if (this.thread.replies.length === 0) {
			out.push(dim("no replies"));
		} else {
			out.push(dim(`replies (${this.thread.replies.length})`));
			out.push("");
			for (const r of this.thread.replies) {
				out.push(th.fg("accent", `  ${authorWithTime(r)}`));
				for (const line of wrapLines(r.text, innerWidth - 2, 6)) {
					out.push(th.fg("text", `  ${line}`));
				}
				out.push(dim(`  ${metricsPlain(r)}`));
				out.push("");
			}
		}
		return out;
	}

	private metricsDetailed(t: Tweet): string {
		const m = t.metrics;
		const parts = [
			`♥ ${formatCount(m.likes)}`,
			`🔁 ${formatCount(m.retweets)}`,
			`💬 ${formatCount(m.replies)}`,
		];
		if (m.quotes) parts.push(`❝ ${formatCount(m.quotes)}`);
		if (m.bookmarks) parts.push(`🔖 ${formatCount(m.bookmarks)}`);
		if (m.views) parts.push(`👁 ${formatCount(m.views)}`);
		return parts.join("   ");
	}

	// --- Render --------------------------------------------------------------

	render(width: number): string[] {
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const innerW = Math.max(10, width - 2);

		const content = this.buildContent(innerW);
		// Full-screen body: fill all rows between the title and footer chrome.
		const maxBodyRows = this.bodyRows();
		const maxScroll = Math.max(0, content.length - maxBodyRows);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const visible = content.slice(this.scroll, this.scroll + maxBodyRows);

		const lines: string[] = [];
		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		lines.push(
			this.row(border, innerW, th.bold(th.fg("accent", " 🐦 Tweet "))),
		);
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		for (const c of visible) lines.push(this.row(border, innerW, c));
		// Pad to keep a stable height.
		for (let i = visible.length; i < maxBodyRows; i++) {
			lines.push(this.row(border, innerW, ""));
		}
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const more =
			maxScroll > 0
				? ` ${this.scroll + 1}-${this.scroll + visible.length}/${content.length} ·`
				: "";
		const hint = `${more} ↑/↓/touchpad scroll · PgUp/PgDn page · Enter detail · Esc close`;
		const footer = this.actionStatus
			? `${hint} · ${this.actionStatus.message}`
			: hint;
		const footerColor = this.actionStatus?.kind === "error" ? "warning" : "dim";
		lines.push(this.row(border, innerW, th.fg(footerColor, footer)));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines;
	}

	/** Render one bordered row, padded/truncated to the inner width. */
	private row(
		border: (s: string) => string,
		innerW: number,
		content: string,
	): string {
		const pad = innerW - 1 - visibleWidth(this.strip(content));
		const body =
			pad >= 0
				? ` ${content}${" ".repeat(pad)}`
				: ` ${this.clip(content, innerW - 1)}`;
		return border("│") + body + border("│");
	}

	private strip(s: string): string {
		return stripAnsi(s);
	}

	private clip(s: string, max: number): string {
		// Width-aware hard clip that preserves whole escape-free chars.
		let used = 0;
		let out = "";
		let inEsc = false;
		for (const ch of s) {
			if (ch === "\u001b") inEsc = true;
			if (inEsc) {
				out += ch;
				if (ch === "m") inEsc = false;
				continue;
			}
			const cw = visibleWidth(ch);
			if (used + cw > max) break;
			used += cw;
			out += ch;
		}
		return out;
	}
}
