// Mermaid ASCII overlay extension for Pi Agent.
// Not for changing assistant messages or session context.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	parseKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";

const EXTENSION_ID = "mermaid-ascii-view";
const COMMAND_NAME = "mermaid";
const TOGGLE_KEY = Key.superShift("p");
const TOGGLE_SEQUENCE_KAKU = "\x1b[994~";
const CSI = `${String.fromCharCode(27)}[`;
const RENDER_TIMEOUT_MS = 45_000;
const GLOBAL_STATE_KEY = "__mermaidAsciiViewState";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const RESET_FG = "\x1b[39m";
const RESET_BG = "\x1b[49m";

type DiagramTone = "blue" | "green" | "purple" | "amber" | "error";
type ColorPair = { tc: string; c256: number };
type DualColor = { light: ColorPair; dark: ColorPair };
type DiagramPalette = { bg: DualColor; fg: DualColor; border: DualColor; title: DualColor };

function dual(lightTc: string, light256: number, darkTc: string, dark256: number): DualColor {
	return {
		light: { tc: lightTc, c256: light256 },
		dark: { tc: darkTc, c256: dark256 },
	};
}

const DIAGRAM_PALETTES: Record<DiagramTone, DiagramPalette> = {
	blue: {
		bg: dual("239;246;255", 195, "15;35;57", 17),
		fg: dual("30;58;138", 25, "191;219;254", 153),
		border: dual("37;99;235", 33, "96;165;250", 75),
		title: dual("30;64;175", 25, "147;197;253", 111),
	},
	green: {
		bg: dual("236;253;245", 194, "12;44;35", 22),
		fg: dual("20;83;45", 22, "187;247;208", 157),
		border: dual("22;163;74", 34, "74;222;128", 77),
		title: dual("21;128;61", 28, "134;239;172", 120),
	},
	purple: {
		bg: dual("245;243;255", 189, "42;32;67", 54),
		fg: dual("88;28;135", 54, "221;214;254", 189),
		border: dual("124;58;237", 99, "167;139;250", 141),
		title: dual("109;40;217", 92, "196;181;253", 183),
	},
	amber: {
		bg: dual("255;251;235", 230, "61;42;12", 58),
		fg: dual("120;53;15", 94, "254;243;199", 230),
		border: dual("217;119;6", 172, "251;191;36", 221),
		title: dual("180;83;9", 166, "252;211;77", 222),
	},
	error: {
		bg: dual("254;242;242", 224, "72;28;28", 52),
		fg: dual("153;27;27", 124, "254;202;202", 224),
		border: dual("220;38;38", 160, "248;113;113", 203),
		title: dual("185;28;28", 160, "252;165;165", 217),
	},
};

interface MermaidBlock {
	index: number;
	source: string;
}

interface RenderedDiagram {
	index: number;
	source: string;
	output: string;
	command: string;
	error?: string;
}

interface ActiveOverlay {
	close(): void;
}

type Cleanup = () => void;

interface GlobalState {
	cleanup?: Cleanup;
}

function globalState(): GlobalState {
	const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: GlobalState };
	return (root[GLOBAL_STATE_KEY] ??= {});
}

let activeOverlay: ActiveOverlay | undefined;
let rendering = false;
let lastShortcutToggleAt = 0;

export default function mermaidAsciiView(pi: ExtensionAPI) {
	const state = globalState();

	const toggleFromShortcut = (ctx: ExtensionContext) => {
		const now = Date.now();
		if (now - lastShortcutToggleAt < 200) return;
		lastShortcutToggleAt = now;
		void openOrToggleMermaid(pi, ctx);
	};

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Show Mermaid diagrams from the last assistant response as ASCII",
		handler: (ctx) => toggleFromShortcut(ctx),
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show Mermaid diagrams from the last assistant response as ASCII",
		handler: async (_args, ctx) => {
			await openOrToggleMermaid(pi, ctx);
		},
	});

	pi.on("session_shutdown", () => {
		state.cleanup?.();
		state.cleanup = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		state.cleanup?.();
		state.cleanup = undefined;

		const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!isToggleKey(data)) return undefined;
			if (isToggleKeyPress(data)) toggleFromShortcut(ctx);
			return { consume: true };
		});

		state.cleanup = () => {
			unsubscribeInput();
			activeOverlay?.close();
			activeOverlay = undefined;
			ctx.ui.setStatus(EXTENSION_ID, undefined);
		};
	});
}

async function openOrToggleMermaid(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (activeOverlay) {
		activeOverlay.close();
		return;
	}
	if (rendering) {
		ctx.ui.notify("Mermaid ASCII rendering is already running.", "info");
		return;
	}
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Mermaid ASCII preview requires Pi TUI mode.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the agent to finish before rendering Mermaid diagrams.", "warning");
		return;
	}

	const last = getLastAssistantText(ctx);
	if (!last) {
		ctx.ui.notify("No assistant message found.", "warning");
		return;
	}

	const blocks = extractMermaidBlocks(last);
	if (blocks.length === 0) {
		ctx.ui.notify("No closed ```mermaid code blocks found in the last assistant response.", "warning");
		return;
	}

	rendering = true;
	ctx.ui.setStatus(EXTENSION_ID, `Rendering ${blocks.length} Mermaid diagram(s)...`);
	try {
		await ctx.ui.custom<"closed">(
			async (tui, theme, _keybindings, done) => {
				const terminalColumns = Number.isFinite(tui.terminal.columns) ? tui.terminal.columns : 100;
				const renderWidth = Math.max(40, Math.min(160, terminalColumns - 6));
				const diagrams = await renderBlocks(pi, ctx, blocks, renderWidth);
				const overlay = new MermaidAsciiOverlay(tui, theme, diagrams, () => done("closed"));
				activeOverlay = overlay;
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
				onHandle: (handle) => {
					queueMicrotask(() => handle.focus());
					setTimeout(() => handle.focus(), 0).unref?.();
				},
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Mermaid ASCII preview failed: ${message}`, "error");
	} finally {
		rendering = false;
		activeOverlay = undefined;
		ctx.ui.setStatus(EXTENSION_ID, undefined);
	}
}

function getLastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const candidate = part as { type?: string; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("");
}

function extractMermaidBlocks(markdown: string): MermaidBlock[] {
	const normalized = markdown.replace(/\r\n/g, "\n");
	const fence = /(?:^|\n)(```|~~~)[ \t]*mermaid[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=\n|$)/gi;
	const blocks: MermaidBlock[] = [];
	let match: RegExpExecArray | null;
	while ((match = fence.exec(normalized))) {
		const source = (match[2] ?? "").trim();
		if (!source) continue;
		blocks.push({ index: blocks.length + 1, source });
	}
	return blocks;
}

async function renderBlocks(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	blocks: MermaidBlock[],
	width: number,
): Promise<RenderedDiagram[]> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mermaid-"));
	try {
		const rendered: RenderedDiagram[] = [];
		for (const block of blocks) {
			const file = join(dir, `diagram-${block.index}.mmd`);
			await writeFile(file, `${block.source}\n`, "utf8");
			rendered.push(await renderOne(pi, ctx, block, file, width));
		}
		return rendered;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function renderOne(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	block: MermaidBlock,
	file: string,
	width: number,
): Promise<RenderedDiagram> {
	const primary = await tryRender(pi, ctx, "termaid", ["--ascii", "--width", String(width), file]);
	if (primary.ok) {
		return { ...block, output: primary.output, command: "termaid" };
	}

	const fallback = await tryRender(pi, ctx, "uvx", [
		"--cache-dir",
		"/tmp/uv-cache",
		"--from",
		"termaid",
		"termaid",
		"--ascii",
		"--width",
		String(width),
		file,
	]);
	if (fallback.ok) {
		return { ...block, output: fallback.output, command: "uvx termaid" };
	}

	return {
		...block,
		output: "",
		command: "termaid",
		error: `termaid failed:\n${primary.error}\n\nuvx fallback failed:\n${fallback.error}`,
	};
}

async function tryRender(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	args: string[],
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: RENDER_TIMEOUT_MS });
	const output = result.stdout.trimEnd();
	if (result.code === 0 && output.trim()) return { ok: true, output };
	const details = [
		`${command} exited ${result.code}${result.killed ? " (killed)" : ""}`,
		result.stderr.trim(),
		!output.trim() ? "stdout was empty" : "",
	]
		.filter(Boolean)
		.join("\n");
	return { ok: false, error: truncatePlain(details, 2_000) };
}

class MermaidAsciiOverlay implements Component, ActiveOverlay {
	private scroll = 0;
	private closed = false;
	private cachedWidth = 0;
	private cachedDark: boolean | undefined;
	private cachedContent: string[] = [];
	private readonly disableMouse: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly diagrams: RenderedDiagram[],
		private readonly done: () => void,
	) {
		this.disableMouse = enableMouseWheel(tui.terminal);
	}

	close(): void {
		this.requestClose();
	}

	requestClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}

	dispose(): void {
		this.disableMouse();
		this.closed = true;
	}

	handleInput(data: string): void {
		if (isToggleKey(data)) {
			if (isToggleKeyPress(data)) this.requestClose();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.requestClose();
			return;
		}
		const wheel = parseWheelInput(data);
		if (wheel) return this.scrollBy(wheel === "up" ? -3 : 3);
		const page = Math.max(1, this.bodyRows() - 2);
		if (matchesKey(data, Key.up) || data === "k") return this.scrollBy(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.scrollBy(1);
		if (matchesKey(data, Key.pageUp)) return this.scrollBy(-page);
		if (matchesKey(data, Key.pageDown) || data === " ") return this.scrollBy(page);
		if (data === "g") return this.scrollTo(0);
		if (data === "G") return this.scrollTo(Number.MAX_SAFE_INTEGER);
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedContent = [];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		const dark = isDarkTheme(this.theme);
		if (dark !== this.cachedDark) {
			this.cachedDark = dark;
			this.invalidate();
		}
		const header = this.renderHeader(safeWidth);
		const footerRows = 1;
		const bodyRows = this.bodyRows(header.length, footerRows);
		const content = this.getContent(safeWidth);
		const maxScroll = Math.max(0, content.length - bodyRows);
		this.scroll = clamp(this.scroll, 0, maxScroll);

		const lines = [...header];
		for (let row = 0; row < bodyRows; row++) {
			lines.push(padTo(content[this.scroll + row] ?? "", safeWidth));
		}
		lines.push(this.renderFooter(safeWidth, maxScroll));
		return lines.map((line) => truncateToWidth(line, safeWidth, "", true));
	}

	private renderHeader(width: number): string[] {
		const inner = width - 2;
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const cell = (text: string) => border("│") + padTo(` ${text}`, inner) + border("│");
		const title = this.theme.fg("toolTitle", this.theme.bold("Mermaid ASCII")) +
			this.theme.fg("muted", " · Last assistant response");
		const failures = this.diagrams.filter((diagram) => diagram.error).length;
		const summary = this.theme.fg("success", `${this.diagrams.length - failures}/${this.diagrams.length} rendered`) +
			(failures ? this.theme.fg("warning", ` · ${failures} failed`) : "");
		const paletteLabel = isDarkTheme(this.theme) ? "dark palette" : "light palette";
		return [
			border("╭") + border("─".repeat(inner)) + border("╮"),
			cell(title),
			cell(`${summary}${this.theme.fg("muted", ` · ${paletteLabel} · Esc/Cmd⇧P close · wheel/↑↓/j/k/PgUp/PgDn/g/G scroll`)}`),
			border("╰") + border("─".repeat(inner)) + border("╯"),
		];
	}

	private renderFooter(width: number, maxScroll: number): string {
		const position = maxScroll === 0 ? "all" : `${this.scroll + 1}-${Math.min(this.scroll + this.bodyRows(), this.getContent(width).length)}/${this.getContent(width).length}`;
		return this.theme.fg("dim", padTo(` Mermaid ASCII · ${position} `, width));
	}

	private bodyRows(headerRows = 4, footerRows = 1): number {
		return Math.max(3, this.tui.terminal.rows - headerRows - footerRows);
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scroll + delta);
	}

	private scrollTo(target: number): void {
		const maxScroll = Math.max(0, this.getContent(this.cachedWidth || 80).length - this.bodyRows());
		this.scroll = clamp(target, 0, maxScroll);
		this.tui.requestRender();
	}

	private getContent(width: number): string[] {
		if (this.cachedWidth === width && this.cachedContent.length > 0) return this.cachedContent;
		const lines: string[] = [];
		for (const diagram of this.diagrams) {
			if (lines.length > 0) lines.push(this.renderSeparator(width));
			this.renderDiagram(lines, diagram, width);
		}
		this.cachedWidth = width;
		this.cachedContent = lines.length ? lines : [this.theme.fg("muted", "No Mermaid diagrams rendered.")];
		return this.cachedContent;
	}

	private renderSeparator(width: number): string {
		return this.theme.fg("borderMuted", padTo("─".repeat(width), width));
	}

	private renderDiagram(lines: string[], diagram: RenderedDiagram, width: number): void {
		const sourceLines = diagram.source.split("\n").length;
		const title = `Diagram ${diagram.index}/${this.diagrams.length} · ${sourceLines} source line(s) · ${diagram.command}`;
		const tone = diagram.error ? "error" : toneForDiagram(diagram.index);
		const innerWidth = Math.max(1, width - 4);
		lines.push(cardRule(this.theme, tone, width, "╭", "╮"));
		lines.push(cardLine(this.theme, tone, this.theme.bold(title), width, true));
		lines.push(cardRule(this.theme, tone, width, "├", "┤"));
		const body = diagram.error ? `Rendering failed:\n${diagram.error}\n\nSource:\n${diagram.source}` : diagram.output;
		const bodyLines = body.split("\n");
		const displayLines = diagram.error ? bodyLines : centreBlockLines(bodyLines, innerWidth);
		for (const raw of displayLines) {
			lines.push(cardLine(this.theme, tone, raw, width));
		}
		lines.push(cardRule(this.theme, tone, width, "╰", "╯"));
	}
}

function toneForDiagram(index: number): DiagramTone {
	const tones: DiagramTone[] = ["blue", "green", "purple", "amber"];
	return tones[(index - 1) % tones.length] ?? "blue";
}

function cardRule(theme: Theme, tone: DiagramTone, width: number, left: string, right: string): string {
	const bg = ansiBg(theme, resolve(theme, DIAGRAM_PALETTES[tone].bg));
	const border = ansiFg(theme, resolve(theme, DIAGRAM_PALETTES[tone].border));
	return `${bg}${border}${left}${"─".repeat(Math.max(0, width - 2))}${right}${RESET_FG}${RESET_BG}`;
}

function cardLine(theme: Theme, tone: DiagramTone, text: string, width: number, title = false): string {
	const palette = DIAGRAM_PALETTES[tone];
	const innerWidth = Math.max(0, width - 4);
	const content = truncateToWidth(text, innerWidth, "…", true);
	const bg = ansiBg(theme, resolve(theme, palette.bg));
	const border = ansiFg(theme, resolve(theme, palette.border));
	const fg = ansiFg(theme, resolve(theme, title ? palette.title : palette.fg));
	return `${bg}${border}│${RESET_FG} ${fg}${content}${RESET_FG} ${border}│${RESET_FG}${RESET_BG}`;
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

function isDarkTheme(theme: Theme): boolean {
	if (theme.name === "light") return false;
	if (theme.name === "dark") return true;
	const rgb = parseAnsiColor(theme.getFgAnsi("text"));
	return rgb ? rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722 >= 140 : false;
}

function isToggleKey(data: string): boolean {
	if (data === TOGGLE_SEQUENCE_KAKU) return true;
	if (matchesKey(data, TOGGLE_KEY)) return true;
	if (data === `${CSI}112;10u` || data === `${CSI}80;9u` || data === `${CSI}80;10u`) return true;
	const parsed = parseKey(data);
	return parsed === "super+shift+p" || parsed === "shift+super+p";
}

function isToggleKeyPress(data: string): boolean {
	return isToggleKey(data) && !isKeyRelease(data) && !isKeyRepeat(data);
}

function centreBlockLines(lines: string[], width: number): string[] {
	const maxWidth = Math.max(0, ...lines.map((line) => visibleWidth(line)));
	const leftPad = Math.max(0, Math.floor((width - maxWidth) / 2));
	if (leftPad === 0) return lines;
	const prefix = " ".repeat(leftPad);
	return lines.map((line) => `${prefix}${line}`);
}

function enableMouseWheel(terminal: Terminal): () => void {
	terminal.write(ENABLE_MOUSE);
	let disabled = false;
	return () => {
		if (disabled) return;
		disabled = true;
		terminal.write(DISABLE_MOUSE);
	};
}

function parseWheelInput(data: string): "up" | "down" | undefined {
	const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[mM]$/);
	if (sgr) {
		const code = Number.parseInt(sgr[1]!, 10);
		const wheel = code & ~(4 | 8 | 16 | 32);
		if (wheel === 64) return "up";
		if (wheel === 65) return "down";
	}
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const code = data.charCodeAt(3) - 32;
		const wheel = code & ~(4 | 8 | 16 | 32);
		if (wheel === 64) return "up";
		if (wheel === 65) return "down";
	}
	return undefined;
}

function padTo(text: string, width: number): string {
	return truncateToWidth(text, width, "", true);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function truncatePlain(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
