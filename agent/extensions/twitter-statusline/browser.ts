// All: a read-only full-screen TUI list of the cached hot tweets.
// Opened from the preview's [All] action via ctx.ui.custom({ overlay: true }).
// Enter resolves with { type: "detail", tweet } so the caller can open the
// detail overlay (and re-open the browser afterwards for back-navigation).

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { authorLabel, fitWidth, metricsPlain, singleLine } from "./render.ts";
import type { Tweet } from "./twitter-cli.ts";

export type BrowserResult =
	| { type: "close" }
	| { type: "detail"; tweet: Tweet };
export interface BrowserRefreshResult {
	tweets: Tweet[];
	refreshed: boolean;
	error: string | undefined;
}

const VISIBLE_ITEMS = 9;
type RefreshStatus = { kind: "info" | "error"; message: string };

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

export class TwitterBrowserOverlay implements Component, Focusable {
	focused = false;
	private selected = 0;
	private offset = 0;
	private refreshing = false;
	private refreshStatus: RefreshStatus | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private tweets: Tweet[],
		private readonly done: (result: BrowserResult) => void,
		private readonly refreshFeed: () => Promise<BrowserRefreshResult>,
	) {}

	invalidate(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.done({ type: "close" });
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "r")) {
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const t = this.tweets[this.selected];
			if (t) this.done({ type: "detail", tweet: t });
		}
	}

	private move(delta: number): void {
		if (this.tweets.length === 0) return;
		this.selected =
			(this.selected + delta + this.tweets.length) % this.tweets.length;
		if (this.selected < this.offset) this.offset = this.selected;
		else if (this.selected >= this.offset + VISIBLE_ITEMS) {
			this.offset = this.selected - VISIBLE_ITEMS + 1;
		}
		this.tui.requestRender();
	}

	private refresh(): void {
		if (this.refreshing) return;
		this.refreshing = true;
		this.refreshStatus = { kind: "info", message: "refreshing…" };
		this.tui.requestRender();
		void this.refreshFeed()
			.then((result) => {
				this.tweets = result.tweets;
				if (this.tweets.length === 0) {
					this.selected = 0;
					this.offset = 0;
				} else {
					this.selected = Math.min(this.selected, this.tweets.length - 1);
					if (this.offset > this.selected) this.offset = this.selected;
				}
				if (result.refreshed) {
					this.refreshStatus = { kind: "info", message: "refreshed" };
				} else if (result.error) {
					this.refreshStatus = {
						kind: "error",
						message: `refresh failed — ${result.error}`,
					};
				} else {
					this.refreshStatus = { kind: "info", message: "cache unchanged" };
				}
			})
			.catch((error) => {
				this.refreshStatus = {
					kind: "error",
					message: `refresh failed — ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.refreshing = false;
				this.tui.requestRender();
			});
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];

		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		const title = ` 🐦 Twitter · Hot ${this.tweets.length} `;
		lines.push(this.row(border, innerW, th.bold(th.fg("accent", title))));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		if (this.tweets.length === 0) {
			lines.push(
				this.row(
					border,
					innerW,
					th.fg("dim", "no cached tweets — try /twitter refresh"),
				),
			);
		} else {
			const end = Math.min(this.tweets.length, this.offset + VISIBLE_ITEMS);
			for (let i = this.offset; i < end; i++) {
				const tweet = this.tweets[i];
				if (!tweet) continue;
				const [a, b] = this.renderItem(tweet, i, innerW);
				lines.push(this.row(border, innerW, a));
				lines.push(this.row(border, innerW, b));
			}
		}

		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const pos =
			this.tweets.length > 0
				? ` ${this.selected + 1}/${this.tweets.length} ·`
				: "";
		const hint = `${pos} ↑/↓ select · Enter view · r refresh · Esc close`;
		const footer = this.refreshStatus
			? `${hint} · ${this.refreshStatus.message}`
			: hint;
		const footerColor =
			this.refreshStatus?.kind === "error" ? "warning" : "dim";
		lines.push(this.row(border, innerW, th.fg(footerColor, footer)));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines;
	}

	private renderItem(
		t: Tweet,
		index: number,
		innerW: number,
	): [string, string] {
		const th = this.theme;
		const isSel = index === this.selected;
		const marker = isSel ? "›" : " ";
		const num = `${index + 1}`.padStart(2, " ");

		const head = `${marker} ${num}. ${authorLabel(t)}`;
		const metrics = metricsPlain(t);
		const headBudget = Math.max(8, innerW - 1 - visibleWidth(metrics) - 2);
		const headFit = fitWidth(head, headBudget);
		const gap = Math.max(
			2,
			innerW - 1 - visibleWidth(headFit) - visibleWidth(metrics),
		);
		const line1Plain = headFit + " ".repeat(gap) + metrics;
		const line1 = isSel
			? th.bg("selectedBg", th.bold(th.fg("accent", line1Plain)))
			: th.fg("accent", headFit) + th.fg("dim", " ".repeat(gap) + metrics);

		const body =
			singleLine(t.text) || (t.media.length ? "(media)" : "(no text)");
		const bodyFit = fitWidth(`     ${body}`, innerW - 1);
		const line2 = isSel ? th.fg("text", bodyFit) : th.fg("dim", bodyFit);
		return [line1, line2];
	}

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
