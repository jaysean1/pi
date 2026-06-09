import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	TranslatableSegment,
	TranslationCloseReason,
	TranslationSegment,
	TranslationStatus,
} from "../types.ts";
import { isTranslateToggleKey, isTranslateToggleKeyPress } from "../platform/keys.ts";
import { enableMouseWheel, parseWheelInput } from "../platform/mouse.ts";
import { clamp, padTo, wrapBlock } from "./ui-utils.ts";

export type OverlayRunStatus = "idle" | "streaming" | "done" | "aborted" | "error";

type BlockTone = "original" | "translation" | "code" | "error";

const RESET_FG = "\x1b[39m";
const RESET_BG = "\x1b[49m";
const HEADER_ROWS = 5;
const FOOTER_ROWS = 1;

function ansiFg(theme: Theme, truecolor: string, fallback256: number): string {
	return theme.getColorMode() === "truecolor"
		? truecolor
		: `\x1b[38;5;${fallback256}m`;
}

function ansiBg(theme: Theme, truecolor: string, fallback256: number): string {
	return theme.getColorMode() === "truecolor"
		? truecolor
		: `\x1b[48;5;${fallback256}m`;
}

function blockBg(theme: Theme, tone: BlockTone, text: string): string {
	const bg =
		tone === "translation"
			? ansiBg(theme, "\x1b[48;2;218;246;231m", 194)
			: tone === "code"
				? ansiBg(theme, "\x1b[48;2;242;237;250m", 189)
				: tone === "error"
					? ansiBg(theme, "\x1b[48;2;255;226;226m", 224)
					: ansiBg(theme, "\x1b[48;2;255;232;226m", 224);
	return `${bg}${text}${RESET_BG}`;
}

function rail(theme: Theme, tone: BlockTone, text: string): string {
	const fg =
		tone === "translation"
			? ansiFg(theme, "\x1b[38;2;20;132;79m", 28)
			: tone === "code"
				? ansiFg(theme, "\x1b[38;2;100;82;150m", 97)
				: ansiFg(theme, "\x1b[38;2;205;48;65m", 160);
	return `${fg}${theme.bold(text)}${RESET_FG}`;
}

function blockText(theme: Theme, tone: BlockTone, text: string): string {
	if (tone === "error") {
		return `${ansiFg(theme, "\x1b[38;2;185;28;28m", 160)}${text}${RESET_FG}`;
	}
	if (tone === "translation") {
		return `${ansiFg(theme, "\x1b[38;2;20;70;47m", 29)}${text}${RESET_FG}`;
	}
	if (tone === "code") {
		return `${ansiFg(theme, "\x1b[38;2;48;105;68m", 29)}${text}${RESET_FG}`;
	}
	return `${ansiFg(theme, "\x1b[38;2;31;41;55m", 235)}${text}${RESET_FG}`;
}

function titleText(theme: Theme, tone: BlockTone, text: string): string {
	return rail(theme, tone, theme.bold(text));
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

export class TranslationOverlay implements Component {
	private scroll = 0;
	private autoFollow = true;
	private runStatus: OverlayRunStatus = "idle";
	private statusText = "Preparing translation...";
	private closed = false;
	private cachedWidth = 0;
	private cachedContent: string[] = [];
	private modelLabel: string;
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
		this.modelLabel = options.modelLabel;
		this.disableMouse = enableMouseWheel(tui.terminal);
	}

	isClosed(): boolean {
		return this.closed;
	}

	setModelLabel(label: string): void {
		if (!label || label === this.modelLabel) return;
		this.modelLabel = label;
		this.tui.requestRender();
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
		const W = Math.max(60, width);
		const body = this.bodyRows();
		const content = this.getContent(W);
		const maxScroll = Math.max(0, content.length - body);
		this.scroll = clamp(this.scroll, 0, maxScroll);
		const lines: string[] = [...this.renderHeader(W)];

		for (let row = 0; row < body; row++) {
			lines.push(padTo(content[this.scroll + row] ?? "", W));
		}

		lines.push(this.renderFooter(W));
		return lines.map((line) => truncateToWidth(line, W, ""));
	}

	private renderHeader(width: number): string[] {
		const th = this.theme;
		const innerW = width - 2;
		const border = (s: string) => th.fg("borderAccent", s);
		const cell = (content: string) =>
			border("│") + padTo(` ${content}`, innerW) + border("│");
		const progressIcon =
			this.runStatus === "done"
				? "✓"
				: this.runStatus === "error"
					? "!"
					: this.runStatus === "aborted"
						? "×"
						: this.runStatus === "streaming"
							? "↻"
							: "…";
		const statusColor =
			this.runStatus === "error"
				? "error"
				: this.runStatus === "aborted"
					? "warning"
					: this.runStatus === "done"
						? "success"
						: "accent";
		const title = th.fg("toolTitle", th.bold("Translate")) + th.fg("muted", " · Last assistant response");
		const codeSummary = this.options.codeBlockCount > 0
			? `</> ${plural(this.options.codeBlockCount, "code block")} shown once`
			: "</> 0 code blocks";
		const summary = th.fg(
			statusColor,
			`${progressIcon} ${this.progressLabel()} · ¶ ${plural(this.options.translatableCount, "text segment")}`,
		) + th.fg("muted", ` · ${codeSummary}`);
		const model = th.fg("muted", "Model: ") + th.fg("accent", this.modelLabel) + th.fg("muted", ` · ${this.statusText}`);

		return [
			border("╭") + border("─".repeat(innerW)) + border("╮"),
			cell(title),
			cell(summary),
			cell(model),
			border("╰") + border("─".repeat(innerW)) + border("╯"),
		];
	}

	private renderFooter(width: number): string {
		const help = " Esc/Cmd⇧M close · ↑↓/touchpad scroll · PgUp/PgDn · g/G · f follow ";
		return this.theme.fg("dim", padTo(help, width));
	}

	private progressLabel(): string {
		const translated = this.segments.filter(
			(segment) => segment.translatable && segment.status === "done",
		).length;
		return `${translated}/${this.options.translatableCount} translated`;
	}

	private bodyRows(): number {
		return Math.max(4, this.tui.terminal.rows - HEADER_ROWS - FOOTER_ROWS);
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
			if (lines.length > 0) lines.push("");
			this.renderSegment(lines, segment, width);
		}
		if (lines.length === 0) lines.push(this.theme.fg("muted", padTo(" No assistant text to translate.", width)));
		this.cachedWidth = width;
		this.cachedContent = lines;
		return lines;
	}

	private renderSegment(lines: string[], segment: TranslationSegment, width: number): void {
		if (!segment.translatable) {
			this.renderCodeBlock(lines, segment.source, width);
			return;
		}

		this.renderTextBlock(lines, "Original", segment.source, width, "original");

		if (segment.status === "error") {
			this.renderTextBlock(
				lines,
				"Translation",
				`Error: ${segment.error ?? "translation failed"}`,
				width,
				"error",
			);
			return;
		}

		const translation = segment.translation.trimEnd();
		const showCursor = segment.status === "streaming";
		const targetText = translation
			? `${translation}${showCursor ? " ▌" : ""}`
			: showCursor
				? "▌"
				: "…";
		this.renderTextBlock(lines, "Translation", targetText, width, "translation");
	}

	private renderTextBlock(
		lines: string[],
		label: string,
		text: string,
		width: number,
		tone: BlockTone,
	): void {
		lines.push(this.renderBlockLine(label, width, tone, { title: true }));
		for (const wrapped of wrapBlock(text, Math.max(1, width - 2))) {
			lines.push(this.renderBlockLine(wrapped, width, tone));
		}
	}

	private renderBlockLine(
		content: string,
		width: number,
		tone: BlockTone,
		options: { title?: boolean } = {},
	): string {
		const prefix = "▌ ";
		const styled =
			rail(this.theme, tone, prefix) +
			(options.title ? titleText(this.theme, tone, content) : blockText(this.theme, tone, content));
		return blockBg(this.theme, tone, padTo(styled, width));
	}

	private renderCodeBlock(lines: string[], source: string, width: number): void {
		lines.push(this.renderBlockLine("Code shown once", width, "code", { title: true }));
		const prefix = "  ";
		const contentWidth = Math.max(1, width - prefix.length);
		for (const raw of source.split("\n")) {
			const content = truncateToWidth(raw, contentWidth, "…");
			const styled = blockText(this.theme, "code", `${prefix}${content}`);
			lines.push(blockBg(this.theme, "code", padTo(styled, width)));
		}
	}
}
