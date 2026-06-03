// The pinned "now playing" bar shown above the editor (always visible).
// Renders live from the engine's state and refreshes on every state change.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { engine } from "./engine.ts";
import { fitWidth, fmtDuration, progressBar } from "./render.ts";

const OPEN_HINT = "⌘⇧M";

export class NowPlayingBar implements Component {
	private unsub: (() => void) | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {
		this.unsub = engine.onState(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsub?.();
		this.unsub = undefined;
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(10, width);
		const st = engine.getState();
		const hint = th.fg("dim", `${OPEN_HINT}`);

		if (!st.track?.title) {
			return [th.fg("dim", fitWidth(`♪ YouTube Music · ${OPEN_HINT} 全屏`, w))];
		}

		const time = `${fmtDuration(st.progress)}/${fmtDuration(st.duration || st.track.duration || 0)}`;
		const vol = `🔊${st.volume}`;
		const rightPlain = `${time}  ${vol}  ${OPEN_HINT}`;
		const right = th.fg("dim", `${time}  ${vol}  ${hint}`);
		// Measure in terminal columns, not UTF-16 code units: CJK/emoji are 2 cols wide
		// but length 1, so .length undercounts and the padding overflows the line.
		const rightW = visibleWidth(rightPlain);
		const barW = Math.min(14, Math.max(5, w - 40));
		const bar = th.fg("accent", progressBar(st.progress, st.duration || st.track.duration || 0, barW));

		const head = `${st.track.title}${st.track.artists ? ` — ${st.track.artists}` : ""}`;
		// Layout: "♪ "(2) + left + " "(1) + bar(barW) + pad(>=1) + right(rightW).
		const leftBudget = Math.max(0, w - 2 - 1 - barW - 1 - rightW);
		const leftText = fitWidth(head, leftBudget);
		const left = th.fg("accent", "♪ ") + th.fg("text", leftText);

		const used = 2 + visibleWidth(leftText) + 1 + barW + rightW;
		const pad = Math.max(1, w - used);
		const line = `${left} ${bar}${" ".repeat(pad)}${right}`;
		// Final safety net: never emit a line wider than the widget width, even in
		// pathologically narrow terminals where the pieces can't all fit.
		return [truncateToWidth(line, w)];
	}
}
