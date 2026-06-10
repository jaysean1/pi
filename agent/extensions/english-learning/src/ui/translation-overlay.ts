import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type Component,
	type MarkdownTheme,
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
const DIFF_SEPARATOR = " │ ";
const DIFF_SEPARATOR_WIDTH = 3;

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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function toneFg(theme: Theme, truecolor: string, fallback256: number): (text: string) => string {
	return (text) => `${ansiFg(theme, `\x1b[38;2;${truecolor}m`, fallback256)}${text}${RESET_FG}`;
}

// Markdown palette tuned for the overlay's light pastel card backgrounds. The
// global theme's markdown colors target the terminal background, so they can
// become unreadable here; instead reuse the card palette with darker accents.
function buildMarkdownTheme(theme: Theme, tone: BlockTone): MarkdownTheme {
	const isTranslation = tone === "translation";
	const heading = isTranslation ? toneFg(theme, "6;78;59", 22) : toneFg(theme, "17;24;39", 234);
	const accent = isTranslation ? toneFg(theme, "20;132;79", 28) : toneFg(theme, "205;48;65", 160);
	const muted = isTranslation ? toneFg(theme, "96;134;113", 65) : toneFg(theme, "120;113;108", 245);
	const linkFg = toneFg(theme, "29;78;216", 26);
	return {
		heading,
		link: (text) => theme.underline(linkFg(text)),
		linkUrl: toneFg(theme, "96;125;199", 67),
		code: toneFg(theme, "109;40;217", 92),
		codeBlock: isTranslation ? toneFg(theme, "48;105;68", 29) : toneFg(theme, "87;83;78", 240),
		codeBlockBorder: muted,
		quote: muted,
		quoteBorder: accent,
		hr: muted,
		listBullet: accent,
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

export class TranslationOverlay implements Component {
	private scroll = 0;
	// Anchor the view at the start of the content when the overlay opens; users
	// opt into bottom-following explicitly with `f`.
	private autoFollow = false;
	private readonly markdownThemes = new Map<BlockTone, MarkdownTheme>();
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
		const title = th.fg("toolTitle", th.bold("Translate")) + th.fg("muted", " · Side-by-side diff · Last assistant response");
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

		if (segment.status === "error") {
			this.renderDiffBlock(
				lines,
				segment.source,
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
		this.renderDiffBlock(lines, segment.source, targetText, width, "translation");
	}

	private renderDiffBlock(
		lines: string[],
		original: string,
		translation: string,
		width: number,
		translationTone: BlockTone,
	): void {
		const { leftWidth, rightWidth } = this.diffColumnWidths(width);
		const separator = this.theme.fg("borderMuted", DIFF_SEPARATOR);
		const leftTitle = this.renderCellLine("Original", leftWidth, "original", { title: true });
		const rightTitle = this.renderCellLine("Translation", rightWidth, translationTone, { title: true });
		lines.push(leftTitle + separator + rightTitle);

		const leftRows = this.renderCellLines(original, leftWidth, "original");
		const rightRows = this.renderCellLines(translation, rightWidth, translationTone);
		const rowCount = Math.max(leftRows.length, rightRows.length);
		for (let i = 0; i < rowCount; i++) {
			lines.push(
				(leftRows[i] ?? this.renderBlankCell(leftWidth, "original")) +
				separator +
				(rightRows[i] ?? this.renderBlankCell(rightWidth, translationTone)),
			);
		}
	}

	private diffColumnWidths(width: number): { leftWidth: number; rightWidth: number } {
		const available = Math.max(2, width - DIFF_SEPARATOR_WIDTH);
		const leftWidth = Math.floor(available / 2);
		return {
			leftWidth,
			rightWidth: available - leftWidth,
		};
	}

	private renderCellLines(text: string, width: number, tone: BlockTone): string[] {
		if (tone === "original" || tone === "translation") {
			return this.renderMarkdownCellLines(text, width, tone);
		}
		return wrapBlock(text, Math.max(1, width - 2)).map((line) =>
			this.renderCellLine(line, width, tone),
		);
	}

	private renderMarkdownCellLines(text: string, width: number, tone: BlockTone): string[] {
		const contentWidth = Math.max(1, width - 2);
		const markdown = new Markdown(
			text,
			0,
			0,
			this.markdownThemeFor(tone),
			{ color: (value) => blockText(this.theme, tone, value) },
			{ preserveOrderedListMarkers: true },
		);
		const rendered = [...markdown.render(contentWidth)];
		while (rendered.length > 0 && (rendered[rendered.length - 1] ?? "").trim() === "") {
			rendered.pop();
		}
		if (rendered.length === 0) rendered.push("");
		const prefix = rail(this.theme, tone, "▌ ");
		return rendered.map((line) => blockBg(this.theme, tone, padTo(prefix + line, width)));
	}

	private markdownThemeFor(tone: BlockTone): MarkdownTheme {
		let markdownTheme = this.markdownThemes.get(tone);
		if (!markdownTheme) {
			markdownTheme = buildMarkdownTheme(this.theme, tone);
			this.markdownThemes.set(tone, markdownTheme);
		}
		return markdownTheme;
	}

	private renderCellLine(
		content: string,
		width: number,
		tone: BlockTone,
		options: { title?: boolean } = {},
	): string {
		const prefix = "▌ ";
		const contentText = options.title
			? rail(this.theme, tone, this.theme.bold(content))
			: blockText(this.theme, tone, content);
		return blockBg(this.theme, tone, padTo(rail(this.theme, tone, prefix) + contentText, width));
	}

	private renderBlankCell(width: number, tone: BlockTone): string {
		return blockBg(this.theme, tone, " ".repeat(Math.max(0, width)));
	}

	private renderCodeBlock(lines: string[], source: string, width: number): void {
		lines.push(this.renderCellLine("Code shown once", width, "code", { title: true }));
		const prefix = "  ";
		const contentWidth = Math.max(1, width - prefix.length);
		for (const raw of source.split("\n")) {
			const content = truncateToWidth(raw, contentWidth, "…");
			const styled = blockText(this.theme, "code", `${prefix}${content}`);
			lines.push(blockBg(this.theme, "code", padTo(styled, width)));
		}
	}
}
