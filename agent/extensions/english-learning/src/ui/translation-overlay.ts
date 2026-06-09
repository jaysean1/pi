import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	TranslatableSegment,
	TranslationCloseReason,
	TranslationSegment,
	TranslationStatus,
} from "../types.ts";
import { isTranslateToggleKey, isTranslateToggleKeyPress } from "../platform/keys.ts";
import { enableMouseWheel, parseWheelInput } from "../platform/mouse.ts";
import { clamp, padTo, prefixWrapped, wrapBlock } from "./ui-utils.ts";

export type OverlayRunStatus = "idle" | "streaming" | "done" | "aborted" | "error";

export class TranslationOverlay implements Component {
	private scroll = 0;
	private autoFollow = true;
	private runStatus: OverlayRunStatus = "idle";
	private statusText = "Preparing translation...";
	private closed = false;
	private cachedWidth = 0;
	private cachedContent: string[] = [];
	private readonly disableMouse: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly segments: TranslationSegment[],
		private readonly options: {
			modelLabel: string;
			translatableCount: number;
			codeBlockCount: number;
			done: (reason: TranslationCloseReason) => void;
			onClose: () => void;
		},
	) {
		this.disableMouse = enableMouseWheel(tui.terminal);
	}

	isClosed(): boolean {
		return this.closed;
	}

	setRunStatus(status: OverlayRunStatus, text?: string): void {
		this.runStatus = status;
		if (text) this.statusText = text;
		this.invalidate();
		this.followIfNeeded();
		this.tui.requestRender();
	}

	setSegmentStatus(id: number, status: TranslationStatus, error?: string): void {
		const segment = this.findTranslatable(id);
		if (!segment) return;
		segment.status = status;
		segment.error = error;
		this.invalidate();
		this.followIfNeeded();
		this.tui.requestRender();
	}

	appendTranslation(id: number, delta: string): void {
		const segment = this.findTranslatable(id);
		if (!segment || !delta) return;
		segment.translation += delta;
		if (segment.status === "pending") segment.status = "streaming";
		this.invalidate();
		this.followIfNeeded();
		this.tui.requestRender();
	}

	requestClose(reason: TranslationCloseReason = "toggle"): void {
		if (this.closed) return;
		this.closed = true;
		this.options.onClose();
		this.options.done(reason);
	}

	dispose(): void {
		this.disableMouse();
		this.closed = true;
	}

	handleInput(data: string): void {
		if (isTranslateToggleKey(data)) {
			if (isTranslateToggleKeyPress(data)) this.requestClose("toggle");
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.requestClose("escape");
			return;
		}
		const wheel = parseWheelInput(data);
		if (wheel) {
			this.scrollBy(wheel === "up" ? -3 : 3, true);
			return;
		}
		const page = Math.max(1, this.bodyRows() - 2);
		if (matchesKey(data, Key.up)) {
			this.scrollBy(-1, true);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollBy(1, true);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-page, true);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(page, true);
			return;
		}
		if (data === "g") {
			this.scrollTo(0, true);
			return;
		}
		if (data === "G") {
			this.scrollTo(Number.MAX_SAFE_INTEGER, true);
			return;
		}
		if (data === "f") {
			this.autoFollow = true;
			this.scrollTo(Number.MAX_SAFE_INTEGER, false);
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedContent = [];
	}

	render(width: number): string[] {
		const th = this.theme;
		const W = Math.max(60, width);
		const innerW = W - 2;
		const body = this.bodyRows();
		const content = this.getContent(innerW);
		const maxScroll = Math.max(0, content.length - body);
		this.scroll = clamp(this.scroll, 0, maxScroll);
		const border = (s: string) => th.fg("border", s);
		const title = ` English Learning · Translate · ${this.options.translatableCount} text segment${this.options.translatableCount === 1 ? "" : "s"} · ${this.options.codeBlockCount} code block${this.options.codeBlockCount === 1 ? "" : "s"} shown `;
		const model = ` Model: ${this.options.modelLabel} `;
		const progress = ` ${this.progressLabel()} · ${this.statusText} `;
		const help = " Esc/Cmd+Shift+M close · ↑↓/touchpad scroll · PgUp/PgDn page · g/G top/bottom · f follow ";
		const lines: string[] = [];

		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		lines.push(border("│") + th.fg("toolTitle", th.bold(padTo(title, innerW))) + border("│"));
		lines.push(border("│") + th.fg("muted", padTo(model, innerW)) + border("│"));
		lines.push(border("│") + this.statusLine(progress, innerW) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		for (let row = 0; row < body; row++) {
			lines.push(border("│") + padTo(content[this.scroll + row] ?? "", innerW) + border("│"));
		}
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + th.fg("dim", padTo(help, innerW)) + border("│"));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines.map((line) => truncateToWidth(line, W, ""));
	}

	private statusLine(text: string, width: number): string {
		const th = this.theme;
		const color =
			this.runStatus === "error"
				? "error"
				: this.runStatus === "aborted"
					? "warning"
					: this.runStatus === "done"
						? "success"
						: "accent";
		return th.fg(color, padTo(text, width));
	}

	private progressLabel(): string {
		const translated = this.segments.filter(
			(segment) => segment.translatable && segment.status === "done",
		).length;
		return `${translated}/${this.options.translatableCount} translated`;
	}

	private bodyRows(): number {
		return Math.max(4, this.tui.terminal.rows - 8);
	}

	private findTranslatable(id: number): TranslatableSegment | undefined {
		const segment = this.segments.find((candidate) => candidate.id === id);
		return segment?.translatable ? segment : undefined;
	}

	private followIfNeeded(): void {
		if (!this.autoFollow) return;
		this.scroll = Number.MAX_SAFE_INTEGER;
	}

	private scrollBy(delta: number, user: boolean): void {
		if (user) this.autoFollow = false;
		const maxScroll = Math.max(0, this.getContent(this.cachedWidth || 80).length - this.bodyRows());
		this.scroll = clamp(this.scroll + delta, 0, maxScroll);
		this.tui.requestRender();
	}

	private scrollTo(target: number, user: boolean): void {
		if (user) this.autoFollow = false;
		const maxScroll = Math.max(0, this.getContent(this.cachedWidth || 80).length - this.bodyRows());
		this.scroll = clamp(target, 0, maxScroll);
		this.tui.requestRender();
	}

	private getContent(width: number): string[] {
		if (this.cachedWidth === width && this.cachedContent.length > 0) return this.cachedContent;
		const lines: string[] = [];
		for (const segment of this.segments) {
			if (lines.length > 0) lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
			this.renderSegment(lines, segment, width);
		}
		if (lines.length === 0) lines.push(this.theme.fg("muted", padTo(" No assistant text to translate.", width)));
		this.cachedWidth = width;
		this.cachedContent = lines;
		return lines;
	}

	private renderSegment(lines: string[], segment: TranslationSegment, width: number): void {
		const th = this.theme;
		const label = ` ${segment.id}/${this.segments.length} ${segment.kind}${segment.kind === "code" && segment.language ? ` · ${segment.language}` : ""} `;
		lines.push(th.fg("accent", th.bold(padTo(label, width))));

		if (!segment.translatable) {
			for (const raw of segment.source.split("\n")) {
				lines.push(th.fg("mdCodeBlock", padTo(`  ${truncateToWidth(raw, Math.max(1, width - 2), "…")}`, width)));
			}
			lines.push(th.fg("dim", padTo("  ↳ code block shown only, not translated", width)));
			return;
		}

		lines.push(...prefixWrapped("EN  ", segment.source, width, (line) => th.fg("toolDiffContext", line)));

		const translation = segment.translation.trimEnd();
		if (translation) {
			lines.push(...prefixWrapped("中文 ", translation, width, (line) => th.fg("success", line)));
		} else if (segment.status === "pending") {
			lines.push(th.fg("dim", padTo("中文 …", width)));
		} else if (segment.status === "error") {
			lines.push(th.fg("error", padTo(`中文 Error: ${segment.error ?? "translation failed"}`, width)));
		}

		if (segment.status === "streaming") {
			const suffix = visibleWidth(translation) > 0 ? "  ▌" : "中文 ▌";
			if (!translation) lines.push(th.fg("accent", padTo(suffix, width)));
		}
	}
}
