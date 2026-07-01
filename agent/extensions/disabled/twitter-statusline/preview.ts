// The always-on rotating Twitter preview rendered below the editor (and thus
// directly above the diff-review footer). It is a Focusable component so the
// ↓-driven focus chain can land on it; when focused, Tab chooses View/All and
// ←/→ browse the cached tweets. Enter activates the selected action.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getDiffChain } from "./chain.ts";
import { fitWidth, formatCount, singleLine } from "./render.ts";
import type { Tweet } from "./twitter-cli.ts";

export type PreviewAction = "view" | "all";

export interface PreviewDeps {
	/** The tweet currently in the rotation, or undefined when none cached yet. */
	getCurrent: () => Tweet | undefined;
	/** 1-based position and total for the "i/N" indicator. */
	getPosition: () => { index: number; total: number };
	isStale: () => boolean;
	isLoading: () => boolean;
	lastError: () => string | undefined;
	/** View: open the current tweet's detail overlay. */
	onOpenDetail: (tweet: Tweet) => void;
	/** All: open the full-screen TUI browser overlay. */
	onOpenBrowser: () => void;
	/** Move to another cached tweet without opening an overlay. */
	onMoveTweet: (delta: number) => void;
	/** Return focus to the input editor (chain: ↑ / Esc). */
	focusEditor: () => void;
}

export class TwitterPreview implements Component, Focusable {
	private _focused = false;
	private selected: PreviewAction = "view";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly deps: PreviewDeps,
	) {}

	// --- Focusable -----------------------------------------------------------

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		if (value) this.selected = "view";
		this.tui.requestRender();
	}

	/** Entry point used by the focus chain (chain.focusPreview). */
	focus(): void {
		this.tui.setFocus(this);
		this.tui.requestRender();
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	// --- Input ---------------------------------------------------------------

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.toggleAction();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.deps.onMoveTweet(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.deps.onMoveTweet(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.activate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			// Chain down to the diff footer when present, else drop back to input.
			const diff = getDiffChain();
			if (diff) diff.focusFooter();
			else this.deps.focusEditor();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.escape)) {
			this.deps.focusEditor();
			return;
		}
	}

	private toggleAction(): void {
		this.selected = this.selected === "view" ? "all" : "view";
		this.tui.requestRender();
	}

	private activate(): void {
		if (this.selected === "all") {
			this.deps.onOpenBrowser();
			return;
		}
		const current = this.deps.getCurrent();
		if (current) this.deps.onOpenDetail(current);
	}

	// --- Render --------------------------------------------------------------

	render(width: number): string[] {
		const w = Math.max(1, width);
		const current = this.deps.getCurrent();

		if (!current) {
			return [this.renderStatusOnly(w)];
		}

		return [this.renderLine(current, w)];
	}

	private renderStatusOnly(width: number): string {
		const th = this.theme;
		let msg: string;
		if (this.deps.isLoading()) msg = "loading hot tweets…";
		else {
			const err = this.deps.lastError();
			msg = err
				? `unavailable — ${err}`
				: "no tweets (check Chrome login / twitter CLI)";
		}
		return fitWidth(th.fg("dim", `Twitter · ${msg}`), width);
	}

	// One compact line, color-coded by the nature of each field:
	//   Name @handle · time  ♥ likes  post content…            [View]  All
	//   │    │        │       │       └ content: text (focused) / dim (idle)
	//   │    │        │       └ ♥ like count: success (green) — engagement
	//   │    │        └ publish time: dim — metadata
	//   │    └ @handle: muted — secondary identity
	//   └ display name: accent (bold when focused) — author identity
	// The action buttons stay pinned far-right; the middle (meta + content) is
	// ellipsis-truncated just before the buttons when it overflows.
	private renderLine(t: Tweet, width: number): string {
		const th = this.theme;
		const dim = (s: string) => th.fg("dim", s);
		const id = (s: string) => s;
		const color = this._focused ? "text" : "dim";

		// Far-right: View / All buttons (always the rightmost elements).
		const right = this.renderActions();
		const rightW = visibleWidth(this.actionsPlain());

		// Reserve a gap so content never touches the buttons.
		const gap = 2;
		const leftBudget = Math.max(8, width - rightW - gap);

		// --- Meta, split into individually-colored segments -------------------
		const name = t.author.name?.trim() ?? "";
		const handle = t.author.screenName?.trim().replace(/^@+/, "") ?? "";
		const nameColor = (s: string) =>
			this._focused ? th.bold(th.fg("accent", s)) : th.fg("accent", s);

		type Seg = { text: string; render: (s: string) => string };
		const segs: Seg[] = [];
		const space = () => {
			if (segs.length) segs.push({ text: " ", render: id });
		};
		if (name) segs.push({ text: name, render: nameColor });
		if (handle) {
			space();
			segs.push({ text: `@${handle}`, render: (s) => th.fg("muted", s) });
		}
		if (!name && !handle)
			segs.push({ text: "unknown", render: (s) => th.fg("muted", s) });
		if (t.createdAtLocal) {
			space();
			segs.push({ text: `· ${t.createdAtLocal}`, render: dim });
		}
		segs.push({ text: "  ", render: id });
		segs.push({
			text: `♥ ${formatCount(t.metrics.likes)}`,
			render: (s) => th.fg("success", s),
		});
		if (this.deps.isStale()) {
			segs.push({ text: "  ", render: id });
			segs.push({ text: "(stale)", render: (s) => th.fg("warning", s) });
		}

		const metaPlain = segs.map((s) => s.text).join("");
		const metaColored = segs.map((s) => s.render(s.text)).join("");
		const metaW = visibleWidth(metaPlain);

		// --- Post content -----------------------------------------------------
		const body =
			singleLine(t.text) || (t.media.length ? "(media)" : "(no text)");

		const sep = "  "; // between meta and content
		const sepW = visibleWidth(sep);
		const fullW = metaW + sepW + visibleWidth(body);

		let leftRendered: string;
		let leftW: number;
		if (fullW <= leftBudget) {
			// Everything fits on the line.
			leftRendered = metaColored + dim(sep) + th.fg(color, body);
			leftW = fullW;
		} else if (metaW + sepW + 2 <= leftBudget) {
			// Keep the colored meta intact; ellipsis-truncate the content.
			const contentBudget = leftBudget - metaW - sepW;
			const fittedBody = fitWidth(body, contentBudget);
			leftRendered = metaColored + dim(sep) + th.fg(color, fittedBody);
			leftW = metaW + sepW + visibleWidth(fittedBody);
		} else {
			// Even the meta overflows: ellipsis-truncate the whole left side.
			const truncated = fitWidth(metaPlain, leftBudget);
			leftRendered = th.fg("muted", truncated);
			leftW = visibleWidth(truncated);
		}

		const pad = Math.max(gap, width - leftW - rightW);
		return leftRendered + " ".repeat(pad) + right;
	}

	private actionsPlain(): string {
		const view = this.selected === "view" ? "[View]" : " View ";
		const all = this.selected === "all" ? "[All]" : " All ";
		return `${view} ${all}`;
	}

	private renderActions(): string {
		const th = this.theme;
		const renderOne = (label: string, active: boolean): string => {
			const text = active ? `[${label}]` : ` ${label} `;
			if (active && this._focused)
				return th.bg("selectedBg", th.bold(th.fg("accent", text)));
			if (active) return th.fg("accent", text);
			return th.fg("dim", text);
		};
		return `${renderOne("View", this.selected === "view")} ${renderOne("All", this.selected === "all")}`;
	}
}
