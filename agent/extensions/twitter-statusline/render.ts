// Shared formatting helpers for rendering tweets in the terminal.
// Width-aware (CJK double-width) truncation is delegated to pi-tui utilities.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Tweet } from "./twitter-cli.ts";

/** Compact a large count, e.g. 3809 -> "3.8k", 1500000 -> "1.5M". */
export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
}

/** Collapse a tweet body to a single line (newlines and runs of spaces removed). */
export function singleLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** "Name @screen" with a graceful fallback when fields are missing. */
export function authorLabel(t: Tweet): string {
	const name = t.author.name?.trim();
	const handle = t.author.screenName?.trim();
	if (name && handle) return `${name} @${handle}`;
	if (handle) return `@${handle}`;
	return name || "unknown";
}

/** "Name @screen · 2026-04-04 14:33" */
export function authorWithTime(t: Tweet): string {
	const base = authorLabel(t);
	return t.createdAtLocal ? `${base} · ${t.createdAtLocal}` : base;
}

/** Plain (uncolored) metrics summary, e.g. "♥ 55  🔁 5  💬 2  👁 3.8k". */
export function metricsPlain(t: Tweet): string {
	const m = t.metrics;
	const parts = [`♥ ${formatCount(m.likes)}`, `🔁 ${formatCount(m.retweets)}`];
	if (m.replies) parts.push(`💬 ${formatCount(m.replies)}`);
	if (m.views) parts.push(`👁 ${formatCount(m.views)}`);
	if (t.media.length > 0) parts.push(`🖼 ${t.media.length}`);
	return parts.join("  ");
}

/** Truncate to a column budget using ellipsis, honoring display width. */
export function fitWidth(text: string, maxWidth: number): string {
	return truncateToWidth(text, Math.max(1, maxWidth), "…");
}

/** Wrap text into at most `maxLines` lines of `width` columns (width-aware). */
export function wrapLines(text: string, width: number, maxLines: number): string[] {
	const flat = singleLine(text);
	if (!flat) return [];
	const lines: string[] = [];
	let rest = flat;
	const w = Math.max(1, width);
	while (rest.length > 0 && lines.length < maxLines) {
		if (visibleWidth(rest) <= w) {
			lines.push(rest);
			rest = "";
			break;
		}
		// Greedy: take as many chars as fit into one display row.
		let cut = "";
		let used = 0;
		let i = 0;
		for (const ch of rest) {
			const cw = visibleWidth(ch);
			if (used + cw > w) break;
			cut += ch;
			used += cw;
			i += ch.length;
		}
		if (lines.length === maxLines - 1) {
			// Last allowed line: ellipsize whatever remains.
			lines.push(fitWidth(rest, w));
			rest = "";
			break;
		}
		// Prefer breaking on the last space for nicer wrapping.
		const lastSpace = cut.lastIndexOf(" ");
		if (lastSpace > w * 0.5) {
			lines.push(cut.slice(0, lastSpace));
			rest = rest.slice(lastSpace + 1);
		} else {
			lines.push(cut);
			rest = rest.slice(i);
		}
	}
	return lines;
}
