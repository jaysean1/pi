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

type ColorPair = { tc: string; c256: number };
type DualColor = { light: ColorPair; dark: ColorPair };

function dual(
	lightTc: string,
	light256: number,
	darkTc: string,
	dark256: number,
): DualColor {
	return {
		light: { tc: lightTc, c256: light256 },
		dark: { tc: darkTc, c256: dark256 },
	};
}

// Card backgrounds: light pastel cards on light terminals, deep muted tones
// on dark terminals so the overlay blends with the surrounding theme.
const BG_COLORS: Record<BlockTone, DualColor> = {
	original: dual("255;232;226", 224, "56;36;36", 52),
	translation: dual("218;246;231", 194, "26;48;38", 22),
	code: dual("242;237;250", 189, "42;36;58", 54),
	error: dual("255;226;226", 224, "72;28;28", 52),
};

// Left rail / title accents: darker than the card in light mode, brighter in
// dark mode so they pop against the deep card backgrounds.
const RAIL_COLORS: Record<BlockTone, DualColor> = {
	original: dual("205;48;65", 160, "248;113;113", 203),
	translation: dual("20;132;79", 28, "74;222;128", 77),
	code: dual("100;82;150", 97, "167;139;250", 141),
	error: dual("205;48;65", 160, "248;113;113", 203),
};

const TEXT_COLORS: Record<BlockTone, DualColor> = {
	original: dual("31;41;55", 235, "229;225;222", 253),
	translation: dual("20;70;47", 29, "187;236;205", 152),
	code: dual("48;105;68", 29, "214;205;246", 189),
	error: dual("185;28;28", 160, "252;165;165", 217),
};

const BASIC_16: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
	[0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
	[127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
	[92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function xterm256ToRgb(code: number): { r: number; g: number; b: number } {
	if (code < 16) {
		const [r = 0, g = 0, b = 0] = BASIC_16[code] ?? [];
		return { r, g, b };
	}
	if (code >= 232) {
		const v = 8 + (code - 232) * 10;
		return { r: v, g: v, b: v };
	}
	const idx = code - 16;
	const steps = [0, 95, 135, 175, 215, 255];
	return {
		r: steps[Math.floor(idx / 36) % 6] ?? 0,
		g: steps[Math.floor(idx / 6) % 6] ?? 0,
		b: steps[idx % 6] ?? 0,
	};
}

function parseAnsiColor(ansi: string): { r: number; g: number; b: number } | undefined {
	const truecolor = ansi.match(/\[[34]8;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) {
		return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	}
	const indexed = ansi.match(/\[[34]8;5;(\d+)m/);
	if (indexed) return xterm256ToRgb(Number(indexed[1]));
	return undefined;
}

let darkThemeCacheKey: string | undefined;
let darkThemeCacheValue = false;

// The global theme can hot-swap at runtime (e.g. the mac-system-theme
// extension follows the macOS appearance), so detect dark mode per call and
// memoize on the resolved values rather than the Theme instance.
export function isDarkTheme(theme: Theme): boolean {
	const textAnsi = theme.getFgAnsi("text");
	const key = `${theme.name ?? ""}|${textAnsi}`;
	if (key === darkThemeCacheKey) return darkThemeCacheValue;
	let dark: boolean;
	if (theme.name === "light") {
		dark = false;
	} else if (theme.name === "dark") {
		dark = true;
	} else {
		// Custom theme: bright body text implies a dark terminal background.
		const rgb = parseAnsiColor(textAnsi);
		dark = rgb ? rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722 >= 140 : false;
	}
	darkThemeCacheKey = key;
	darkThemeCacheValue = dark;
	return dark;
}

function resolve(theme: Theme, color: DualColor): ColorPair {
	return isDarkTheme(theme) ? color.dark : color.light;
}

function ansiFg(theme: Theme, color: ColorPair): string {
	return theme.getColorMode() === "truecolor"
		? `\x1b[38;2;${color.tc}m`
		: `\x1b[38;5;${color.c256}m`;
}

function ansiBg(theme: Theme, color: ColorPair): string {
	return theme.getColorMode() === "truecolor"
		? `\x1b[48;2;${color.tc}m`
		: `\x1b[48;5;${color.c256}m`;
}

function blockBg(theme: Theme, tone: BlockTone, text: string): string {
	return `${ansiBg(theme, resolve(theme, BG_COLORS[tone]))}${text}${RESET_BG}`;
}

function rail(theme: Theme, tone: BlockTone, text: string): string {
	const fg = ansiFg(theme, resolve(theme, RAIL_COLORS[tone]));
	return `${fg}${theme.bold(text)}${RESET_FG}`;
}

function blockText(theme: Theme, tone: BlockTone, text: string): string {
	return `${ansiFg(theme, resolve(theme, TEXT_COLORS[tone]))}${text}${RESET_FG}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

// Resolves light/dark lazily on every call so cached closures stay correct
// when the theme hot-swaps while the overlay is open.
function toneFg(theme: Theme, color: DualColor): (text: string) => string {
	return (text) => `${ansiFg(theme, resolve(theme, color))}${text}${RESET_FG}`;
}

const MD_COLORS = {
	headingTranslation: dual("6;78;59", 22, "134;239;172", 120),
	headingOriginal: dual("17;24;39", 234, "243;244;246", 255),
	accentTranslation: dual("20;132;79", 28, "74;222;128", 77),
	accentOriginal: dual("205;48;65", 160, "248;113;113", 203),
	mutedTranslation: dual("96;134;113", 65, "134;170;150", 108),
	mutedOriginal: dual("120;113;108", 245, "168;162;158", 246),
	link: dual("29;78;216", 26, "147;197;253", 111),
	linkUrl: dual("96;125;199", 67, "125;160;220", 110),
	inlineCode: dual("109;40;217", 92, "198;183;254", 183),
	codeBlockTranslation: dual("48;105;68", 29, "144;205;168", 115),
	codeBlockOriginal: dual("87;83;78", 240, "189;183;175", 250),
};

// Markdown palette tuned for the overlay's card backgrounds. The global
// theme's markdown colors target the terminal background, so they can become
// unreadable here; instead reuse the card palette with theme-aware accents.
function buildMarkdownTheme(theme: Theme, tone: BlockTone): MarkdownTheme {
	const isTranslation = tone === "translation";
	const heading = toneFg(theme, isTranslation ? MD_COLORS.headingTranslation : MD_COLORS.headingOriginal);
	const accent = toneFg(theme, isTranslation ? MD_COLORS.accentTranslation : MD_COLORS.accentOriginal);
	const muted = toneFg(theme, isTranslation ? MD_COLORS.mutedTranslation : MD_COLORS.mutedOriginal);
	const linkFg = toneFg(theme, MD_COLORS.link);
	return {
		heading,
		link: (text) => theme.underline(linkFg(text)),
		linkUrl: toneFg(theme, MD_COLORS.linkUrl),
		code: toneFg(theme, MD_COLORS.inlineCode),
		codeBlock: toneFg(theme, isTranslation ? MD_COLORS.codeBlockTranslation : MD_COLORS.codeBlockOriginal),
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
	private cachedDark: boolean | undefined;
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
		// Rebuild cached lines when the theme flips between light and dark while
		// the overlay is open (e.g. mac-system-theme follows the OS appearance).
		const dark = isDarkTheme(this.theme);
		if (dark !== this.cachedDark) {
			this.cachedDark = dark;
			this.invalidate();
		}
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
