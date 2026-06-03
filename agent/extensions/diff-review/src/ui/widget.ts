// The diff-review status line rendered as a passive aboveEditor widget, shown
// directly above the input. It reports how many files changed this session and
// the net +added / -removed counts. It is intentionally NOT focusable: the
// review overlay is opened solely via the keyboard shortcut (see TOGGLE_KEY),
// so this widget never participates in the focus chain.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { diffStats } from "../core/diff-engine.ts";
import type { FileDiff } from "../core/types.ts";
import { colourBlindDiff } from "./ui-utils.ts";

export interface DiffWidgetDeps {
	/** Current tracked file diffs (drives the file count and +/- totals). */
	getFiles: () => FileDiff[];
}

export class DiffReviewWidget implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly deps: DiffWidgetDeps,
	) {}

	requestRender(): void {
		this.tui.requestRender();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const stats = diffStats(this.deps.getFiles());

		if (stats.files === 0) {
			return [truncateToWidth(this.theme.fg("dim", "📁 no changes"), w)];
		}

		const label = `📝 ${stats.files} file${stats.files === 1 ? "" : "s"} changed`;
		const line =
			`${this.theme.fg("text", label)} ` +
			`${colourBlindDiff(this.theme, "add", `+${stats.added}`)} ` +
			`${colourBlindDiff(this.theme, "del", `-${stats.removed}`)}`;
		return [truncateToWidth(line, w)];
	}
}
