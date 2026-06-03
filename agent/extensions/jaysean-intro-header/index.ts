// jaysean intro header: an animated 3D ASCII wordmark plus a recent-work summary, shown on startup.
// The wordmark plays a rainbow reveal that freezes red; below it, recent session progress is listed.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// --- Wordmark banner (figlet "ANSI Shadow"). '█' = lit face, box-drawing chars = built-in 3D shadow. ---
const WORD = "JAYSEAN"; // kept for the narrow-terminal fallback label
const FACE_CH = "█"; // full-block character that forms the bright letter face
const BANNER: string[] = [
	"     ██╗ █████╗ ██╗   ██╗███████╗███████╗ █████╗ ███╗   ██╗",
	"     ██║██╔══██╗╚██╗ ██╔╝██╔════╝██╔════╝██╔══██╗████╗  ██║",
	"     ██║███████║ ╚████╔╝ ███████╗█████╗  ███████║██╔██╗ ██║",
	"██   ██║██╔══██║  ╚██╔╝  ╚════██║██╔══╝  ██╔══██║██║╚██╗██║",
	"╚█████╔╝██║  ██║   ██║   ███████║███████╗██║  ██║██║ ╚████║",
	" ╚════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝",
];
const TAGLINE = "· your terminal AI agent ·";

type RGB = [number, number, number];

// --- Final frozen palette: red-dominant, anchored on the Claude "crab" coral (#d97757). ---
const RED_START: RGB = [190, 26, 34]; // deep crab red    #be1a22
const RED_END: RGB = [217, 119, 87]; // Claude burnt orange #d97757
const HIGHLIGHT: RGB = [250, 250, 255]; // white sweep crest during reveal
const SHADOW_MUL = 0.24; // how dark the 3D extrude is

// --- Summary block palette (tuned for a light / cream background) ---
const FOCUS_RGB: RGB = [200, 96, 64]; // memory.md "now" line (Claude coral)
const BULLET_RGB: RGB = [168, 96, 78]; // muted coral bullets / labels
const TOPIC_RGB: RGB = [92, 84, 80]; // session topic text (dark warm grey, readable)
const DIM_RGB: RGB = [105, 97, 92]; // timestamps / hints

// --- Animated rainbow while the intro plays (ultrathink-style shimmer). ---
const HUE_SPREAD = 320; // degrees of rainbow spread across the wordmark
const ROW_HUE = 12; // extra hue shift per row (diagonal shimmer)
const CYCLE_SPEED = 0.22; // degrees of hue rotation per millisecond
const RAINBOW_SAT = 0.85;
const RAINBOW_LIGHT = 0.62;

// --- Timing (shortened: ~1.6s total, was ~3.45s) ---
const BAND = 7; // width of the reveal light sweep, in diagonal units
const SWEEP_MS = 1150; // phase 1: rainbow flows in as letters reveal
const SETTLE_MS = 450; // phase 2: rainbow cools into red, then freezes
const TOTAL_MS = SWEEP_MS + SETTLE_MS;
const FRAME_MS = 40; // ~25fps while animating

// --- Recent-work summary ---
const HEADER_INDENT = 2; // Claude Code-style left inset for the wordmark and summary.
const MAX_ITEMS = 5; // recent sessions to list
const HEAD_BYTES = 200_000; // bounded read from the top of a session file
const TAIL_BYTES = 200_000; // bounded read from the bottom of a session file
const OVERFLOW_MARKER = "...";

const RESET = "\x1b[0m";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: RGB, b: RGB, t: number): RGB => [
	Math.round(lerp(a[0], b[0], t)),
	Math.round(lerp(a[1], b[1], t)),
	Math.round(lerp(a[2], b[2], t)),
];
const mul = (a: RGB, k: number): RGB => [
	Math.round(a[0] * k),
	Math.round(a[1] * k),
	Math.round(a[2] * k),
];
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// Colour emit: truecolor (24-bit) or a 256-colour cube fallback.
const fgTrue = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const fg256 = (n: number) => `\x1b[38;5;${n}m`;
function rgbTo256(c: RGB): number {
	const [r, g, b] = c;
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return 232 + Math.round(((r - 8) / 247) * 24);
	}
	const q = (v: number) => Math.round((v / 255) * 5);
	return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
function hslToRgb(h: number, s: number, l: number): RGB {
	h = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function truncWidth(s: string, max: number): string {
	return truncateToWidth(s, max, OVERFLOW_MARKER);
}

// --- Session-record helpers ---
interface RecentItem {
	topic: string;
	action: string;
	time: string;
}

function relTime(deltaMs: number): string {
	const s = deltaMs / 1000;
	if (s < 90) return "now";
	const m = s / 60;
	if (m < 60) return `${Math.round(m)}m`;
	const h = m / 60;
	if (h < 24) return `${Math.round(h)}h`;
	return `${Math.round(h / 24)}d`;
}

function cleanText(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isMeaningfulUser(text: string): boolean {
	const t = cleanText(text);
	if (!t) return false;
	if (/^\/?(resume|reload|quit|new|clear|exit|sessions|intro|tree|fork|clone)(\s|$)/i.test(t)) return false;
	if (/^(hi|hello|hey|thanks|thank you|ok|你好|嗨|谢谢|好的|可以|嗯|是的|继续)$/i.test(t)) return false;
	return visibleWidth(t) >= 4;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join(" ");
}

function firstSentence(text: string): string {
	const t = cleanText(text);
	const m = t.split(/(?<=[。.!?！？])\s|\n/)[0] ?? t;
	return m.trim();
}

async function readHeadTail(path: string): Promise<{ head: string; tail: string; whole: boolean }> {
	const fh = await open(path, "r");
	try {
		const { size } = await fh.stat();
		if (size <= HEAD_BYTES + TAIL_BYTES) {
			const buf = Buffer.alloc(size);
			await fh.read(buf, 0, size, 0);
			const s = buf.toString("utf8");
			return { head: s, tail: s, whole: true };
		}
		const hb = Buffer.alloc(HEAD_BYTES);
		await fh.read(hb, 0, HEAD_BYTES, 0);
		const tb = Buffer.alloc(TAIL_BYTES);
		await fh.read(tb, 0, TAIL_BYTES, size - TAIL_BYTES);
		return { head: hb.toString("utf8"), tail: tb.toString("utf8"), whole: false };
	} finally {
		await fh.close();
	}
}

function parseLine(line: string): { role?: string; text: string } | undefined {
	if (!line.trim()) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const msg = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
	if (!msg) return undefined;
	return { role: msg.role, text: cleanText(extractText(msg.content)) };
}

async function summariseSession(path: string, mtimeMs: number): Promise<RecentItem | undefined> {
	const { head, tail, whole } = await readHeadTail(path);

	let topic = "";
	for (const line of head.split("\n")) {
		const p = parseLine(line);
		if (p?.role === "user" && p.text && isMeaningfulUser(p.text)) {
			topic = p.text;
			break;
		}
	}
	if (!topic) return undefined; // empty / trivial session

	let action = "";
	const tailLines = tail.split("\n");
	for (let i = tailLines.length - 1; i >= (whole ? 0 : 1); i--) {
		const p = parseLine(tailLines[i]!);
		if (p?.role === "assistant" && p.text) {
			action = firstSentence(p.text);
			if (action) break;
		}
	}

	return { topic, action, time: relTime(Date.now() - mtimeMs) };
}

// Build the banner buffer once at module load.
// Each cell carries both a colour class (type) and the literal glyph character:
//   0 = empty, 1 = shadow (box-drawing 3D edge), 2 = face (full block).
function buildArt() {
	const rows = BANNER.map((line) => [...line]); // split into code points (box chars are multi-byte)
	const h = rows.length;
	const w = Math.max(...rows.map((r) => r.length));
	const cols = w;
	const type: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));
	const chars: string[][] = Array.from({ length: h }, () => new Array(w).fill(" "));
	for (let r = 0; r < h; r++)
		for (let c = 0; c < w; c++) {
			const ch = rows[r]![c] ?? " ";
			chars[r]![c] = ch;
			if (ch === " " || ch === "") type[r]![c] = 0;
			else if (ch === FACE_CH) type[r]![c] = 2; // bright letter face
			else type[r]![c] = 1; // box-drawing 3D shadow edge
		}

	let dMin = Infinity;
	let dMax = -Infinity;
	for (let r = 0; r < h; r++)
		for (let c = 0; c < w; c++)
			if (type[r]![c]! > 0) {
				const d = c - r * 1.2;
				if (d < dMin) dMin = d;
				if (d > dMax) dMax = d;
			}
	return { type, chars, cols, h, w, dMin, dMax };
}

const ART = buildArt();
const redGrad = (c: number): RGB => mix(RED_START, RED_END, ART.cols > 1 ? c / (ART.cols - 1) : 0);
const rainbow = (c: number, r: number, ms: number): RGB =>
	hslToRgb(
		(c / Math.max(1, ART.cols)) * HUE_SPREAD - ms * CYCLE_SPEED - r * ROW_HUE,
		RAINBOW_SAT,
		RAINBOW_LIGHT,
	);

class IntroHeader implements Component {
	readonly tui: TUI;
	private theme: Theme;
	private ctx: ExtensionContext;
	private start = Date.now();
	private finished = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	// Recent-work state (loaded asynchronously so startup is never blocked).
	private loaded = false;
	private focus: string | undefined;
	private items: RecentItem[] = [];

	constructor(tui: TUI, theme: Theme, ctx: ExtensionContext) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.startAnim();
		void this.loadRecent();
	}

	private startAnim(): void {
		this.stopAnim();
		this.start = Date.now();
		this.finished = false;
		this.timer = setInterval(() => {
			if (Date.now() - this.start >= TOTAL_MS) {
				this.finished = true;
				this.stopAnim();
			}
			this.tui.requestRender();
		}, FRAME_MS);
		this.timer?.unref?.();
	}

	private stopAnim(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async loadRecent(): Promise<void> {
		try {
			const [focus, items] = await Promise.all([this.loadFocus(), this.loadSessions()]);
			if (this.disposed) return;
			this.focus = focus;
			this.items = items;
		} catch {
			// Leave the summary empty on any error.
		}
		this.loaded = true;
		if (!this.disposed) this.tui.requestRender();
	}

	/** Pull the first real "active work" bullet from the workspace memory.md, if present. */
	private async loadFocus(): Promise<string | undefined> {
		try {
			const text = await readFile(join(this.ctx.cwd, "memory.md"), "utf8");
			const lines = text.split("\n");
			let inSection = false;
			for (const raw of lines) {
				const line = raw.trim();
				if (/^##\s/.test(line)) {
					inSection = /active|work|progress|current/i.test(line);
					continue;
				}
				if (!inSection) continue;
				const m = line.match(/^[-*]\s+(.*)$/);
				if (!m) continue;
				const item = cleanText(m[1]!);
				if (!item) continue;
				if (/no .*(recorded|memory|active)|recorded yet|placeholder/i.test(item)) continue;
				return item;
			}
		} catch {
			// no memory.md or unreadable
		}
		return undefined;
	}

	/** List the most recent sessions for the current workspace and summarise them. */
	private async loadSessions(): Promise<RecentItem[]> {
		const dir = this.ctx.sessionManager.getSessionDir();
		const current = this.ctx.sessionManager.getSessionFile();
		const names = await readdir(dir);
		const stated = await Promise.all(
			names
				.filter((n) => n.endsWith(".jsonl"))
				.map(async (n) => {
					const p = join(dir, n);
					try {
						const s = await stat(p);
						return { p, m: s.mtimeMs };
					} catch {
						return undefined;
					}
				}),
		);
		const sorted = stated
			.filter((x): x is { p: string; m: number } => Boolean(x))
			.filter((x) => x.p !== current)
			.sort((a, b) => b.m - a.m)
			.slice(0, MAX_ITEMS + 2); // read a few extra; some may be empty

		const summaries = await Promise.all(sorted.map((x) => summariseSession(x.p, x.m).catch(() => undefined)));
		return summaries.filter((x): x is RecentItem => Boolean(x)).slice(0, MAX_ITEMS);
	}

	/** Replay the intro animation from the start. */
	replay(): void {
		this.startAnim();
		this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.stopAnim();
	}

	invalidate(): void {
		// Colours are derived per frame; nothing cached to clear.
	}

	private emit(c: RGB): string {
		return this.theme.getColorMode() === "truecolor" ? fgTrue(c) : fg256(rgbTo256(c));
	}

	private faceColor(r: number, c: number, elapsed: number): RGB {
		if (elapsed >= TOTAL_MS) return redGrad(c); // frozen
		if (elapsed >= SWEEP_MS) {
			const morph = easeInOut((elapsed - SWEEP_MS) / SETTLE_MS);
			return mix(rainbow(c, r, elapsed), redGrad(c), morph); // cooling into red
		}
		const prog = elapsed / SWEEP_MS;
		const s = lerp(ART.dMin - BAND, ART.dMax + BAND, prog);
		const d = c - r * 1.2;
		const rb = rainbow(c, r, elapsed);
		if (s < d - BAND) return mul(rb, 0.15); // not revealed yet (faint ghost)
		if (s <= d + BAND) {
			const k = 1 - Math.abs(s - d) / BAND;
			return mix(rb, HIGHLIGHT, Math.max(0, k) * 0.9); // bright sweep crest
		}
		return rb; // revealed rainbow
	}

	private cellStyle(t: number, r: number, c: number, elapsed: number): { ansi: string; ch: string } {
		const face = this.faceColor(r, c, elapsed);
		const ch = ART.chars[r]![c]!;
		return t === 1
			? { ansi: this.emit(mul(face, SHADOW_MUL)), ch } // dim box-drawing 3D shadow
			: { ansi: this.emit(face), ch }; // bright full-block face
	}

	/** Centered subtitle, aligned under the banner span. */
	private taglineLine(width: number): string {
		const padW = visibleWidth(this.leftPad(width, ART.w));
		const span = Math.min(ART.w, Math.max(0, width - padW));
		const text = truncWidth(TAGLINE, span);
		const lead = padW + Math.max(0, Math.floor((span - visibleWidth(text)) / 2));
		return " ".repeat(lead) + this.emit(DIM_RGB) + text + RESET;
	}

	private leftPad(width: number, reservedWidth = 1): string {
		const available = Math.max(0, width - reservedWidth);
		return " ".repeat(Math.min(HEADER_INDENT, available));
	}

	/** Lines for the recent-work summary, aligned to the fixed header inset. */
	private summaryLines(width: number): string[] {
		const pad = this.leftPad(width);
		const padW = visibleWidth(pad);
		const inner = Math.max(1, width - padW);
		const bullet = "  • ";
		const bulletW = visibleWidth(bullet);
		const out: string[] = [""];

		if (this.focus) {
			const prefix = "▸ now  ";
			const text = truncWidth(this.focus, inner - visibleWidth(prefix));
			out.push(pad + this.emit(FOCUS_RGB) + prefix + text + RESET);
		}

		out.push(pad + this.emit(DIM_RGB) + "recent  ·  type /intro to replay" + RESET);

		if (!this.loaded) {
			out.push(pad + this.emit(DIM_RGB) + bullet + "loading recent work…" + RESET);
			return out;
		}
		if (this.items.length === 0) {
			out.push(pad + this.emit(DIM_RGB) + bullet + "(no recent sessions)" + RESET);
			return out;
		}

		for (const item of this.items) {
			const rt = item.time;
			// Pad every topic to the same width so the time column lines up.
			const avail = Math.max(0, inner - bulletW - visibleWidth(rt) - 1);
			const mid = item.action ? `${item.topic}  →  ${item.action}` : item.topic;
			const midT = truncWidth(mid, avail);
			const padN = Math.max(1, avail - visibleWidth(midT) + 1);
			out.push(
				pad +
					this.emit(BULLET_RGB) +
					bullet +
					RESET +
					this.emit(TOPIC_RGB) +
					midT +
					RESET +
					" ".repeat(padN) +
					this.emit(DIM_RGB) +
					rt +
					RESET,
			);
		}
		return out.map((line) => truncateToWidth(line, width, this.emit(DIM_RGB) + OVERFLOW_MARKER + RESET));
	}

	render(width: number): string[] {
		// Narrow-terminal fallback: simple inset wordmark in the freeze colour.
		if (width < ART.w + HEADER_INDENT) {
			const pad = this.leftPad(width);
			const plain = truncateToWidth(WORD.toLowerCase(), Math.max(0, width - visibleWidth(pad)), "");
			return ["", pad + this.emit(RED_END) + plain + RESET, ""];
		}

		const elapsed = this.finished ? TOTAL_MS : Date.now() - this.start;
		const lines: string[] = [""];
		for (let r = 0; r < ART.h; r++) {
			let outLine = "";
			let last = "";
			for (let c = 0; c < ART.w; c++) {
				if (ART.type[r]![c] === 0) {
					if (last) {
						outLine += RESET;
						last = "";
					}
					outLine += " ";
					continue;
				}
				const { ansi, ch } = this.cellStyle(ART.type[r]![c]!, r, c, elapsed);
				if (ansi !== last) {
					outLine += ansi;
					last = ansi;
				}
				outLine += ch;
			}
			if (last) outLine += RESET;
			lines.push(this.leftPad(width, ART.w) + outLine);
		}
		lines.push(this.taglineLine(width));
		lines.push(...this.summaryLines(width));
		return lines;
	}
}

let active: IntroHeader | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader((tui, theme) => {
			active = new IntroHeader(tui, theme, ctx);
			return active;
		});
	});

	pi.registerCommand("intro", {
		description: "Replay the jaysean intro header animation",
		handler: async (_args, ctx) => {
			if (active) {
				active.replay();
			} else if (ctx.hasUI) {
				ctx.ui.notify("Intro header is not active", "warning");
			}
		},
	});
}
