// jaysean recent work: standalone recent-session section for the intro header.
// Reuses session-recap custom messages, generates missing summaries with a cheap LLM,
// and falls back to a bounded heuristic summary when no cached/LLM summary is available.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Keep this aligned with session-recap.ts. The recap text lives in details.recap
// on a top-level custom_message entry and does not pollute LLM context.
const RECAP_MSG_TYPE = "session-recap/line";
const SESSION_RECAP_SETTINGS_KEY = "sessionRecap";
const RECENT_WORK_SETTINGS_KEY = "recentWork";

const DEFAULT_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_SCAN_LIMIT = 10;
const DEFAULT_MAX_CHARS = 140;
const DEFAULT_CONTEXT_CHARS = 8_000;
const DEFAULT_HEAD_BYTES = 200_000;
const DEFAULT_TAIL_BYTES = 200_000;
const CACHE_VERSION = 1;

const OVERFLOW_MARKER = "...";
const RESET = "\x1b[0m";

type AnyModel = any;
type SummarySource = "recap" | "cache" | "llm" | "heuristic";
type RGB = [number, number, number];

interface RecentWorkConfig {
	enabled: boolean;
	model: string;
	maxItems: number;
	scanLimit: number;
	maxChars: number;
	contextChars: number;
	language: string;
	generateMissing: boolean;
	cache: boolean;
	headBytes: number;
	tailBytes: number;
}

interface RecentWorkSectionOptions {
	indent?: number;
}

interface ContentBlock {
	type?: string;
	text?: string;
}

interface ParsedLine {
	role?: string;
	text?: string;
	recap?: string;
}

interface ReadWindow {
	head: string;
	tail: string;
	whole: boolean;
	size: number;
}

interface RecentSessionCandidate {
	path: string;
	mtimeMs: number;
	size: number;
	topic: string;
	action: string;
	summary: string;
	source: SummarySource;
	conversation: string;
}

interface RecentWorkItem {
	path: string;
	mtimeMs: number;
	size: number;
	summary: string;
	time: string;
	source: SummarySource;
	conversation: string;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	summary: string;
	model: string;
	maxChars: number;
	updatedAt: number;
}

interface CacheFile {
	version: number;
	entries: Record<string, CacheEntry>;
}

const BULLET_RGB: RGB = [168, 96, 78];
const TOPIC_RGB: RGB = [92, 84, 80];
const DIM_RGB: RGB = [105, 97, 92];

const SYSTEM_PROMPT = [
	"You write concise one-line summaries for a coding-agent recent-session list.",
	"Output exactly ONE concrete line describing what the session accomplished and the next step if visible.",
	"Do NOT start with 'The user asked', 'This session', 'In this conversation', or similar preambles.",
	"No markdown, no bullets, no quotes, no trailing period.",
	"Write in the same language the conversation uses unless instructed otherwise.",
].join("\n");

const activeSections = new Set<RecentWorkSection>();

function fgTrue(c: RGB): string {
	return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function fg256(n: number): string {
	return `\x1b[38;5;${n}m`;
}

function rgbTo256(c: RGB): number {
	const [r, g, b] = c;
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return 232 + Math.round(((r - 8) / 247) * 24);
	}
	const rc = Math.round((r / 255) * 5);
	const gc = Math.round((g / 255) * 5);
	const bc = Math.round((b / 255) * 5);
	return 16 + 36 * rc + 6 * gc + bc;
}

function emit(theme: Theme, c: RGB): string {
	return theme.getColorMode() === "truecolor" ? fgTrue(c) : fg256(rgbTo256(c));
}

function truncWidth(s: string, max: number): string {
	return truncateToWidth(s, Math.max(0, max), OVERFLOW_MARKER);
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
	if (/^\/?(resume|reload|quit|new|clear|exit|sessions|intro|recent|recap|tree|fork|clone)(\s|$)/i.test(t)) {
		return false;
	}
	if (/^(hi|hello|hey|thanks|thank you|ok|你好|嗨|谢谢|好的|可以|嗯|是的|继续)$/i.test(t)) {
		return false;
	}
	return visibleWidth(t) >= 4;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			return part.type === "text" && typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join(" ");
}

function firstSentence(text: string): string {
	const t = cleanText(text);
	const m = t.split(/(?<=[。.!?！？])\s|\n/)[0] ?? t;
	return m.trim();
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

function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
}

function getConfig(ctx: ExtensionContext): RecentWorkConfig {
	const home = agentDir();
	const globalSettings = readJson(join(home, "settings.json"));
	const projectSettings = readJson(join(ctx.cwd, ".pi", "settings.json"));
	const recap = {
		...((globalSettings[SESSION_RECAP_SETTINGS_KEY] ?? {}) as Record<string, unknown>),
		...((projectSettings[SESSION_RECAP_SETTINGS_KEY] ?? {}) as Record<string, unknown>),
	};
	const recent = {
		...((globalSettings[RECENT_WORK_SETTINGS_KEY] ?? {}) as Record<string, unknown>),
		...((projectSettings[RECENT_WORK_SETTINGS_KEY] ?? {}) as Record<string, unknown>),
	};

	const numberFrom = (value: unknown, fallback: number, min = 1): number => {
		const n = typeof value === "number" ? value : Number(value);
		return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
	};
	const booleanFrom = (value: unknown, fallback: boolean): boolean =>
		typeof value === "boolean" ? value : fallback;
	const stringFrom = (value: unknown, fallback: string): string =>
		typeof value === "string" && value.trim() ? value.trim() : fallback;

	const maxItems = numberFrom(recent.maxItems, DEFAULT_MAX_ITEMS);
	const scanLimit = Math.max(maxItems, numberFrom(recent.scanLimit, DEFAULT_SCAN_LIMIT));

	return {
		enabled: booleanFrom(recent.enabled, true),
		model: stringFrom(recent.model, stringFrom(recap.model, DEFAULT_MODEL)),
		maxItems,
		scanLimit,
		maxChars: numberFrom(recent.maxChars, numberFrom(recap.maxChars, DEFAULT_MAX_CHARS)),
		contextChars: numberFrom(recent.contextChars, numberFrom(recap.contextChars, DEFAULT_CONTEXT_CHARS)),
		language: stringFrom(recent.language, stringFrom(recap.language, "auto")),
		generateMissing: booleanFrom(recent.generateMissing, true),
		cache: booleanFrom(recent.cache, true),
		headBytes: numberFrom(recent.headBytes, DEFAULT_HEAD_BYTES),
		tailBytes: numberFrom(recent.tailBytes, DEFAULT_TAIL_BYTES),
	};
}

function cachePath(): string {
	return join(agentDir(), "cache", "jaysean-recent-work.json");
}

function readCache(): CacheFile {
	try {
		const parsed = readJson(cachePath()) as Partial<CacheFile>;
		if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
			return { version: CACHE_VERSION, entries: {} };
		}
		return { version: CACHE_VERSION, entries: parsed.entries };
	} catch {
		return { version: CACHE_VERSION, entries: {} };
	}
}

function validCacheEntry(entry: CacheEntry | undefined, session: { mtimeMs: number; size: number }, cfg: RecentWorkConfig): string | undefined {
	if (!entry?.summary) return undefined;
	if (entry.mtimeMs !== session.mtimeMs || entry.size !== session.size) return undefined;
	if (entry.model !== cfg.model || entry.maxChars !== cfg.maxChars) return undefined;
	return entry.summary;
}

async function writeCacheEntry(path: string, entry: CacheEntry): Promise<void> {
	const p = cachePath();
	const cache = readCache();
	cache.entries[path] = entry;
	await mkdir(dirname(p), { recursive: true });
	await writeFile(p, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function readHeadTail(path: string, cfg: RecentWorkConfig): Promise<ReadWindow> {
	const fh = await open(path, "r");
	try {
		const { size } = await fh.stat();
		if (size <= cfg.headBytes + cfg.tailBytes) {
			const buf = Buffer.alloc(size);
			await fh.read(buf, 0, size, 0);
			const s = buf.toString("utf8");
			return { head: s, tail: s, whole: true, size };
		}
		const hb = Buffer.alloc(cfg.headBytes);
		await fh.read(hb, 0, cfg.headBytes, 0);
		const tb = Buffer.alloc(cfg.tailBytes);
		await fh.read(tb, 0, cfg.tailBytes, size - cfg.tailBytes);
		return { head: hb.toString("utf8"), tail: tb.toString("utf8"), whole: false, size };
	} finally {
		await fh.close();
	}
}

function parseLine(line: string): ParsedLine | undefined {
	if (!line.trim()) return undefined;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}

	if (entry?.type === "custom_message" && entry.customType === RECAP_MSG_TYPE) {
		const recap = typeof entry.details?.recap === "string" ? cleanText(entry.details.recap) : "";
		return recap ? { recap } : undefined;
	}

	const msg = entry?.message;
	if (!msg || typeof msg !== "object") return undefined;
	const text = cleanText(extractText(msg.content));
	return { role: msg.role, text };
}

function latestRecapFromTail(tail: string): string | undefined {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const p = parseLine(lines[i]!);
		if (p?.recap) return p.recap;
	}
	return undefined;
}

function collectConversation(head: string, tail: string, whole: boolean, cfg: RecentWorkConfig): string {
	const seen = new Set<string>();
	const turns: string[] = [];
	let firstUser = "";
	const sources = whole ? [head] : [head, tail];

	for (const source of sources) {
		for (const line of source.split("\n")) {
			const p = parseLine(line);
			if (!p?.role || !p.text) continue;
			if (p.role !== "user" && p.role !== "assistant") continue;
			const text = p.text.trim();
			if (!text) continue;
			const key = `${p.role}:${text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (p.role === "user" && !firstUser && isMeaningfulUser(text)) firstUser = text;
			turns.push(`${p.role === "user" ? "User" : "Assistant"}: ${text}`);
		}
	}

	if (turns.length === 0) return "";
	let body = turns.join("\n\n");
	if (body.length > cfg.contextChars) {
		const tailText = body.slice(-cfg.contextChars);
		const headText = firstUser ? `User (first request): ${firstUser}\n\n…\n\n` : "";
		body = headText + tailText;
	}
	return body;
}

async function summariseSession(path: string, mtimeMs: number, cfg: RecentWorkConfig, cache: CacheFile): Promise<RecentSessionCandidate | undefined> {
	const { head, tail, whole, size } = await readHeadTail(path, cfg);

	let topic = "";
	for (const line of head.split("\n")) {
		const p = parseLine(line);
		if (p?.role === "user" && p.text && isMeaningfulUser(p.text)) {
			topic = p.text;
			break;
		}
	}

	const recap = latestRecapFromTail(tail);
	if (recap) {
		return {
			path,
			mtimeMs,
			size,
			topic,
			action: "",
			summary: recap,
			source: "recap",
			conversation: "",
		};
	}

	if (!topic) return undefined; // empty / command-only / trivial session

	const cached = cfg.cache ? validCacheEntry(cache.entries[path], { mtimeMs, size }, cfg) : undefined;
	if (cached) {
		return {
			path,
			mtimeMs,
			size,
			topic,
			action: "",
			summary: cached,
			source: "cache",
			conversation: "",
		};
	}

	let action = "";
	const tailLines = tail.split("\n");
	for (let i = tailLines.length - 1; i >= (whole ? 0 : 1); i--) {
		const p = parseLine(tailLines[i]!);
		if (p?.role === "assistant" && p.text) {
			action = firstSentence(p.text);
			if (action) break;
		}
	}

	const heuristic = action ? `${topic}  →  ${action}` : topic;
	return {
		path,
		mtimeMs,
		size,
		topic,
		action,
		summary: heuristic,
		source: "heuristic",
		conversation: collectConversation(head, tail, whole, cfg),
	};
}

function pickModel(ctx: ExtensionContext, ref: string): AnyModel | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = ref.slice(0, slash).trim();
	const modelId = ref.slice(slash + 1).trim();
	try {
		return ctx.modelRegistry.find(provider, modelId);
	} catch {
		return undefined;
	}
}

function cleanSummary(text: string, maxChars: number): string {
	let line =
		text
			.split("\n")
			.map((s) => s.trim())
			.find(Boolean) ?? "";
	line = line
		.replace(/^[-•*\d.)\s]+/, "")
		.replace(/^(recap|summary|recent)\s*[:：]\s*/i, "")
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (line.length > maxChars) line = `${line.slice(0, maxChars - 1).trimEnd()}…`;
	return line;
}

async function generateSummary(ctx: ExtensionContext, cfg: RecentWorkConfig, conversation: string, signal: AbortSignal): Promise<string | undefined> {
	if (!conversation.trim()) return undefined;
	const model = pickModel(ctx, cfg.model);
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const langLine =
		cfg.language && cfg.language.toLowerCase() !== "auto"
			? `Write the summary in: ${cfg.language}.`
			: "Write the summary in the same language as the conversation.";

	const response = await completeSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `${langLine}\n\nSummarize this prior Pi coding-agent session in one line (≤ ${cfg.maxChars} chars):\n\n${conversation}`,
					timestamp: Date.now(),
				},
			],
		},
		{
			maxTokens: 200,
			reasoning: "low",
			signal,
			apiKey: auth.apiKey,
			headers: auth.headers,
		},
	);

	const raw = (response.content ?? [])
		.filter((b: ContentBlock) => b.type === "text" && typeof b.text === "string")
		.map((b: ContentBlock) => b.text as string)
		.join("\n");
	return cleanSummary(raw, cfg.maxChars) || undefined;
}

export class RecentWorkSection implements Component {
	readonly tui: TUI;
	private readonly ctx: ExtensionContext;
	private readonly theme: Theme;
	private readonly indent: number;
	private loaded = false;
	private disposed = false;
	private seq = 0;
	private items: RecentWorkItem[] = [];
	private aborts = new Set<AbortController>();

	constructor(ctx: ExtensionContext, tui: TUI, theme: Theme, options: RecentWorkSectionOptions = {}) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.indent = options.indent ?? 2;
		activeSections.add(this);
		void this.load(false);
	}

	refresh(): void {
		void this.load(true);
	}

	dispose(): void {
		this.disposed = true;
		this.seq++;
		for (const abort of this.aborts) abort.abort();
		this.aborts.clear();
		activeSections.delete(this);
	}

	invalidate(): void {
		// Render computes theme colours fresh each frame.
	}

	private leftPad(width: number): string {
		const available = Math.max(0, width - 1);
		return " ".repeat(Math.min(this.indent, available));
	}

	private style(c: RGB, text: string): string {
		return emit(this.theme, c) + text + RESET;
	}

	private async load(force: boolean): Promise<void> {
		const cfg = getConfig(this.ctx);
		const mySeq = ++this.seq;
		this.loaded = false;
		if (force) this.items = [];
		this.tui.requestRender();

		try {
			if (!cfg.enabled) {
				this.items = [];
				this.loaded = true;
				this.tui.requestRender();
				return;
			}

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
				.slice(0, cfg.scanLimit);

			const cache = readCache();
			const summaries = await Promise.all(sorted.map((x) => summariseSession(x.p, x.m, cfg, cache).catch(() => undefined)));
			if (this.disposed || mySeq !== this.seq) return;

			this.items = summaries
				.filter((x): x is RecentSessionCandidate => Boolean(x))
				.slice(0, cfg.maxItems)
				.map((x) => ({ ...x, time: relTime(Date.now() - x.mtimeMs) }));
			this.loaded = true;
			this.tui.requestRender();

			if (cfg.generateMissing) await this.upgradeHeuristicItems(mySeq, cfg);
		} catch {
			if (this.disposed || mySeq !== this.seq) return;
			this.loaded = true;
			this.tui.requestRender();
		}
	}

	private async upgradeHeuristicItems(seq: number, cfg: RecentWorkConfig): Promise<void> {
		for (const item of this.items) {
			if (this.disposed || seq !== this.seq) return;
			if (item.source !== "heuristic" || !item.conversation) continue;

			const abort = new AbortController();
			this.aborts.add(abort);
			try {
				const summary = await generateSummary(this.ctx, cfg, item.conversation, abort.signal);
				if (!summary || this.disposed || seq !== this.seq) continue;

				item.summary = summary;
				item.source = "llm";
				item.conversation = "";
				this.tui.requestRender();

				if (cfg.cache) {
					void writeCacheEntry(item.path, {
						mtimeMs: item.mtimeMs,
						size: item.size,
						summary,
						model: cfg.model,
						maxChars: cfg.maxChars,
						updatedAt: Date.now(),
					}).catch(() => undefined);
				}
			} catch {
				// Keep the heuristic fallback.
			} finally {
				this.aborts.delete(abort);
			}
		}
	}

	private renderItem(item: RecentWorkItem, width: number): string {
		const pad = this.leftPad(width);
		const padW = visibleWidth(pad);
		const inner = Math.max(1, width - padW);
		const bullet = "  • ";
		const bulletW = visibleWidth(bullet);
		const time = item.time;
		const avail = Math.max(0, inner - bulletW - visibleWidth(time) - 1);
		const summary = truncWidth(item.summary, avail);
		const padN = Math.max(1, avail - visibleWidth(summary) + 1);
		return truncateToWidth(
			pad +
				this.style(BULLET_RGB, bullet) +
				this.style(TOPIC_RGB, summary) +
				" ".repeat(padN) +
				this.style(DIM_RGB, time),
			width,
			this.style(DIM_RGB, OVERFLOW_MARKER),
		);
	}

	render(width: number): string[] {
		const pad = this.leftPad(width);
		const out: string[] = [""];
		out.push(truncateToWidth(pad + this.style(DIM_RGB, "recent"), width, this.style(DIM_RGB, OVERFLOW_MARKER)));

		if (!this.loaded) {
			out.push(truncateToWidth(pad + this.style(DIM_RGB, "  • loading recent work…"), width, this.style(DIM_RGB, OVERFLOW_MARKER)));
			return out;
		}
		if (this.items.length === 0) {
			out.push(truncateToWidth(pad + this.style(DIM_RGB, "  • (no recent sessions)"), width, this.style(DIM_RGB, OVERFLOW_MARKER)));
			return out;
		}
		for (const item of this.items) out.push(this.renderItem(item, width));
		return out;
	}
}

export function createRecentWorkSection(
	ctx: ExtensionContext,
	tui: TUI,
	theme: Theme,
	options?: RecentWorkSectionOptions,
): RecentWorkSection {
	return new RecentWorkSection(ctx, tui, theme, options);
}

export default function activate(pi: ExtensionAPI): void {
	pi.registerCommand("recent", {
		description: "Refresh the intro-header recent-work summaries",
		getArgumentCompletions: (prefix: string) => {
			const items = ["refresh", "status"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args || "refresh").trim().toLowerCase();
			if (arg === "status") {
				const cfg = getConfig(ctx);
				ctx.ui.notify(
					`[recent] sections=${activeSections.size} model=${cfg.model} maxItems=${cfg.maxItems} llm=${cfg.generateMissing}`,
					"info",
				);
				return;
			}
			for (const section of activeSections) section.refresh();
			ctx.ui.notify(`[recent] refresh requested for ${activeSections.size} section(s)`, "info");
		},
	});
}
