// Width-aware formatting helpers shared by the overlay and the widget.

import { visibleWidth } from "@earendil-works/pi-tui";

/** Strip ANSI escape sequences (for width math on already-colored strings). */
export function stripAnsi(s: string): string {
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

/** Truncate a plain string to a visible width, adding an ellipsis if cut. */
export function fitWidth(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;
	if (width === 1) return "…";
	let out = "";
	let used = 0;
	for (const ch of s) {
		const cw = visibleWidth(ch);
		if (used + cw > width - 1) break;
		out += ch;
		used += cw;
	}
	return out + "…";
}

/** Pad a plain string with spaces to exactly `width` visible columns. */
export function padTo(s: string, width: number): string {
	const w = visibleWidth(stripAnsi(s));
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

/** Seconds -> "m:ss" or "h:mm:ss". */
export function fmtDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
	const s = Math.floor(seconds % 60);
	const m = Math.floor((seconds / 60) % 60);
	const h = Math.floor(seconds / 3600);
	const ss = s.toString().padStart(2, "0");
	if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
	return `${m}:${ss}`;
}

/** A unicode progress bar of the given cell width. */
export function progressBar(progress: number, duration: number, width: number): string {
	const w = Math.max(1, width);
	const ratio = duration > 0 ? Math.min(1, Math.max(0, progress / duration)) : 0;
	const filled = Math.round(ratio * w);
	return "▰".repeat(filled) + "▱".repeat(w - filled);
}
