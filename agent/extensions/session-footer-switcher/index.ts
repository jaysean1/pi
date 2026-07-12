// Session switcher as a bottom-anchored, full-width overlay (mirrors the
// ask-user-question style: horizontal-rule borders, no vertical │ side borders,
// so wide CJK glyphs can never collide with a right-hand border).
// The panel starts with a "New session" entry (equivalent to /new), then a
// pinned-session section populated via /pin, followed by saved history sessions.
// Toggle shortcut:
//   Command+Shift+Left - requires terminal support for Super-modified keys
// Manual fallback: /sessions

import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	parseKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

const COMMAND_OPEN = "sessions";
const COMMAND_PIN = "pin";
const COMMAND_UNPIN = "unpin";
const WIDGET_KEY = "session-footer-switcher";
// Keep cached summaries generous; rendering still truncates to the live overlay width.
const MAX_TITLE_WIDTH = 240;
const MAX_DETAIL_WIDTH = 320;
const OVERLAY_WIDTH = "100%";
const OVERLAY_VISIBLE_COUNT = 12;
const INTERNAL_COMMAND_SWITCH_ARG = "--switch";
const INTERNAL_COMMAND_PREFIX = `/${COMMAND_OPEN} ${INTERNAL_COMMAND_SWITCH_ARG}`;
const DEBUG_KEYS_ARG = "debug-keys";
const PIN_CUSTOM_TYPE = "session-footer-switcher/pin";
const AUTOMATION_RUNS_ROOT = "/Users/jayseanqian/Desktop/on_board/cron_jobs/.pi-cron/runs";
type SessionTab = "project" | "automation";

const TOGGLE_KEY = Key.superShift("left");
const TOGGLE_SEQUENCE_COMMAND_SHIFT_LEFT = "\x1b[991~";
const MODIFIER_SHIFT = 1;
const MODIFIER_COMMAND_LIKE = 8 | 16 | 32; // Super, Hyper, or Meta depending on terminal.
const GLOBAL_STATE_KEY = "__sessionFooterSwitcherState";

type FocusTarget = EditorComponent & Partial<Focusable>;
type Cleanup = () => void;
// Result returned by the overlay: switch to an existing session, or start a new one (/new).
type OverlayResult = { type: "switch"; path: string } | { type: "new" };

interface GlobalState {
	cleanup?: Cleanup;
}

function globalState(): GlobalState {
	const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: GlobalState };
	return (root[GLOBAL_STATE_KEY] ??= {});
}

interface SessionSummary {
	title: string;
	detail: string;
}

interface SessionPin {
	title: string;
	pinnedAt?: string;
}

interface SessionDecorations {
	summary: SessionSummary;
	pin?: SessionPin;
}

interface SessionItem {
	info: SessionInfo;
	summary: SessionSummary;
	pin?: SessionPin;
}

type CachedDecoration = { modifiedMs: number } & SessionDecorations;
const sessionItemCache = new Map<string, CachedDecoration>();

// Persist decorated titles to disk so a freshly launched process (e.g. opening
// the overlay via the keyboard shortcut in a brand-new session) can render real
// session names on the very first frame instead of flashing placeholder
// timestamps until the JSONL files finish hydrating. Entries carry the source
// file's mtime, so a stale cache entry is ignored and re-hydrated on demand.
let cacheLoadedFromDisk = false;
let persistCacheTimer: ReturnType<typeof setTimeout> | undefined;

function cacheFilePath(): string {
	return join(getAgentDir(), "session-footer-switcher-cache.json");
}

function loadPersistedCacheOnce(): void {
	if (cacheLoadedFromDisk) return;
	cacheLoadedFromDisk = true;
	try {
		const raw = readFileSync(cacheFilePath(), "utf8");
		const data = JSON.parse(raw) as Record<string, CachedDecoration>;
		for (const [path, entry] of Object.entries(data)) {
			if (entry && typeof entry.modifiedMs === "number" && entry.summary?.title) {
				sessionItemCache.set(path, entry);
			}
		}
	} catch {
		// No cache yet or unreadable/corrupt file — start cold.
	}
}

function schedulePersistCache(): void {
	if (persistCacheTimer) clearTimeout(persistCacheTimer);
	persistCacheTimer = setTimeout(() => {
		persistCacheTimer = undefined;
		try {
			const obj: Record<string, CachedDecoration> = {};
			for (const [path, value] of sessionItemCache) obj[path] = value;
			writeFileSync(cacheFilePath(), JSON.stringify(obj));
		} catch {
			// Best-effort cache; ignore write failures.
		}
	}, 500);
	persistCacheTimer.unref?.();
}

function parseSessionCreatedFromFilename(filePath: string, fallback: Date): Date {
	const rawTimestamp = basename(filePath).split("_")[0];
	const normalized = rawTimestamp?.replace(
		/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
		"$1T$2:$3:$4.$5Z",
	);
	const parsed = normalized ? new Date(normalized) : fallback;
	return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseSessionIdFromFilename(filePath: string): string {
	return basename(filePath).replace(/^[^_]+_/, "").replace(/\.jsonl$/, "") || filePath;
}

function placeholderSessionTitle(created: Date): string {
	return `Session ${created.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z")}`;
}

function defaultSessionDirForCwd(cwd: string): string {
	const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getAgentDir(), "sessions", encoded);
}

async function listSessionsFast(cwd: string, sessionDir: string | undefined): Promise<SessionInfo[]> {
	if (!sessionDir) return SessionManager.list(cwd, sessionDir);

	// If the user points multiple projects at a shared custom sessionDir, Pi's
	// canonical list() filters by the header cwd. The fast path intentionally
	// avoids opening files, so only use it for the normal per-cwd session folder.
	const expectedDefaultDirName = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	if (basename(sessionDir) !== expectedDefaultDirName) return SessionManager.list(cwd, sessionDir);

	try {
		const files = (await readdir(sessionDir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(sessionDir, file));
		const sessions = (
			await Promise.all(
				files.map(async (filePath): Promise<SessionInfo | undefined> => {
					try {
						const stats = await stat(filePath);
						const created = parseSessionCreatedFromFilename(filePath, stats.birthtime);
						const placeholder = placeholderSessionTitle(created);
						return {
							path: filePath,
							id: parseSessionIdFromFilename(filePath),
							cwd,
							created,
							modified: stats.mtime,
							messageCount: 0,
							firstMessage: placeholder,
							allMessagesText: "",
						};
					} catch {
						return undefined;
					}
				}),
			)
		).filter((session): session is SessionInfo => Boolean(session));
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	} catch {
		// Fall back to Pi's canonical parser if the fast directory scan fails.
		return SessionManager.list(cwd, sessionDir);
	}
}

// Synchronous mirror of listSessionsFast, used only to seed the first render so
// the overlay never shows an empty "loading" frame before the list appears.
// Returns an empty array when the fast path is unsafe (custom shared dir), in
// which case the caller falls back to the async load path.
function listSessionsFastSync(cwd: string, sessionDir: string | undefined): SessionInfo[] {
	if (!sessionDir) return [];
	const expectedDefaultDirName = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	if (basename(sessionDir) !== expectedDefaultDirName) return [];

	try {
		const sessions = readdirSync(sessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(sessionDir, file))
			.map((filePath): SessionInfo | undefined => {
				try {
					const stats = statSync(filePath);
					const created = parseSessionCreatedFromFilename(filePath, stats.birthtime);
					return {
						path: filePath,
						id: parseSessionIdFromFilename(filePath),
						cwd,
						created,
						modified: stats.mtime,
						messageCount: 0,
						firstMessage: placeholderSessionTitle(created),
						allMessagesText: "",
					};
				} catch {
					return undefined;
				}
			})
			.filter((session): session is SessionInfo => Boolean(session));
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	} catch {
		return [];
	}
}

async function listAutomationSessions(cwd: string): Promise<SessionInfo[]> {
	try {
		const taskEntries = await readdir(AUTOMATION_RUNS_ROOT, { withFileTypes: true });
		const sessions: SessionInfo[] = [];
		for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory())) {
			const taskRunsDir = join(AUTOMATION_RUNS_ROOT, taskEntry.name);
			const runEntries = await readdir(taskRunsDir, { withFileTypes: true });
			for (const runEntry of runEntries.filter((entry) => entry.isDirectory())) {
				try {
					const runPath = join(taskRunsDir, runEntry.name, "run.json");
					const run = JSON.parse(await readFile(runPath, "utf8")) as {
						runId?: string;
						taskId?: string;
						status?: string;
						trigger?: string;
						startedAt?: string;
						finishedAt?: string;
						sessionFile?: string;
					};
					if (!run.sessionFile) continue;
					const sessionStats = await stat(run.sessionFile);
					const created = run.startedAt ? new Date(run.startedAt) : sessionStats.birthtime;
					const modified = run.finishedAt ? new Date(run.finishedAt) : sessionStats.mtime;
					const taskId = run.taskId || taskEntry.name;
					const runId = run.runId || runEntry.name;
					sessions.push({
						path: run.sessionFile,
						id: runId,
						cwd,
						created: Number.isNaN(created.getTime()) ? sessionStats.birthtime : created,
						modified: Number.isNaN(modified.getTime()) ? sessionStats.mtime : modified,
						messageCount: 0,
						firstMessage: `${taskId} · ${run.status || "unknown"}`,
						allMessagesText: "",
						name: `${taskId} · ${run.status || "unknown"} · ${run.trigger || "cron"}`,
					});
				} catch {
					// Ignore incomplete, removed, or pre-session run records.
				}
			}
		}
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	} catch {
		return [];
	}
}

// Synchronous mirror of listAutomationSessions, used only to seed the first
// render so the Automation Runs tab never flashes an empty "loading" frame.
// Automation titles come straight from run.json (name/firstMessage), so this
// sync scan already yields real titles without any JSONL hydration.
function listAutomationSessionsSync(cwd: string): SessionInfo[] {
	try {
		const taskEntries = readdirSync(AUTOMATION_RUNS_ROOT, { withFileTypes: true });
		const sessions: SessionInfo[] = [];
		for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory())) {
			const taskRunsDir = join(AUTOMATION_RUNS_ROOT, taskEntry.name);
			const runEntries = readdirSync(taskRunsDir, { withFileTypes: true });
			for (const runEntry of runEntries.filter((entry) => entry.isDirectory())) {
				try {
					const runPath = join(taskRunsDir, runEntry.name, "run.json");
					const run = JSON.parse(readFileSync(runPath, "utf8")) as {
						runId?: string;
						taskId?: string;
						status?: string;
						trigger?: string;
						startedAt?: string;
						finishedAt?: string;
						sessionFile?: string;
					};
					if (!run.sessionFile) continue;
					const sessionStats = statSync(run.sessionFile);
					const created = run.startedAt ? new Date(run.startedAt) : sessionStats.birthtime;
					const modified = run.finishedAt ? new Date(run.finishedAt) : sessionStats.mtime;
					const taskId = run.taskId || taskEntry.name;
					const runId = run.runId || runEntry.name;
					sessions.push({
						path: run.sessionFile,
						id: runId,
						cwd,
						created: Number.isNaN(created.getTime()) ? sessionStats.birthtime : created,
						modified: Number.isNaN(modified.getTime()) ? sessionStats.mtime : modified,
						messageCount: 0,
						firstMessage: `${taskId} · ${run.status || "unknown"}`,
						allMessagesText: "",
						name: `${taskId} · ${run.status || "unknown"} · ${run.trigger || "cron"}`,
					});
				} catch {
					// Ignore incomplete, removed, or pre-session run records.
				}
			}
		}
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	} catch {
		return [];
	}
}

function cleanSingleLine(text: string | undefined, fallback: string): string {
	const cleaned = (text ?? "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return cleaned || fallback;
}

// Strip terminal escape sequences and decorative glyphs that leak in from
// pasted terminal output (statuslines, rendered TUIs, progress bars). Left in
// place they desync the column alignment: raw/unclosed ANSI codes bleed color
// into neighbouring rows, and ambiguous-width block/box glyphs throw off width
// math. Everything is collapsed to a space so word boundaries survive.
function stripControlAndDecorations(text: string): string {
	return (
		text
			// CSI / SGR sequences: ESC [ params intermediates final.
			.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, " ")
			// OSC / APC / DCS sequences: ESC ]/_/P ... (BEL or ST terminator).
			.replace(/\u001b[\]_P][\s\S]*?(?:\u0007|\u001b\\)/g, " ")
			// Stray ESC plus any remaining C0/C1 control characters.
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			// Box drawing, block elements, geometric shapes, misc symbols, dingbats,
			// braille spinners, technical symbols (⌘⌥ etc.), variation selectors.
			.replace(/[\u2300-\u23ff\u2500-\u27bf\u2800-\u28ff\u2b00-\u2bff\ufe00-\ufe0f]/g, " ")
			// Emoji and pictographs (astral plane).
			.replace(/[\u{1f000}-\u{1faff}]/gu, " ")
	);
}

function normaliseMessageText(text: string): string {
	return stripControlAndDecorations(text)
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isMeaningfulUserText(text: string): boolean {
	const cleaned = normaliseMessageText(text);
	if (!cleaned) return false;
	if (cleaned.startsWith(INTERNAL_COMMAND_PREFIX)) return false;
	if (/^\/?(resume|reload|quit|new|session|sessions|pin|unpin|tree|fork|clone)(\s|$)/i.test(cleaned)) return false;
	if (/^(hi|hello|hey|thanks|thank you|你好|嗨|谢谢|好的|可以|ok|嗯|是的|继续)$/i.test(cleaned)) return false;
	return cleaned.length >= 8;
}

function compactText(text: string, maxWidth: number): string {
	return truncateToWidth(cleanSingleLine(normaliseMessageText(text), "No summary"), maxWidth, "...");
}

function normalizePinTitle(input: string): string {
	return cleanSingleLine(normaliseMessageText(input.replace(/^#+/, "")), "").slice(0, 80);
}

function parsePinEntry(data: unknown, timestamp?: string): SessionPin | null | undefined {
	if (typeof data === "string") {
		const title = normalizePinTitle(data);
		return title ? { title, pinnedAt: timestamp } : undefined;
	}

	if (!data || typeof data !== "object") return undefined;
	const record = data as { title?: unknown; tag?: unknown; pinned?: unknown };
	if (record.pinned === false) return null;

	// Backward compatible with the earlier /pin <tag> shape.
	const rawTitle = typeof record.title === "string" ? record.title : typeof record.tag === "string" ? record.tag : "";
	const title = normalizePinTitle(rawTitle);
	return title ? { title, pinnedAt: timestamp } : undefined;
}

function parseTabTitleEntry(data: unknown): string | null | undefined {
	if (!data || typeof data !== "object") return undefined;
	const state = data as { kind?: unknown; title?: unknown };
	if (state.kind === "manual-reset") return null;
	if ((state.kind === "manual" || state.kind === "llm" || state.kind === "llm-started") && typeof state.title === "string") {
		const title = normalizePinTitle(state.title);
		return title || undefined;
	}
	return undefined;
}

function derivePinTitleFromEntries(entries: unknown[], sessionName: string | undefined, fallback: string): string {
	let tabTitle: string | undefined;
	let latestRecap: string | undefined;
	let firstUser: string | undefined;
	let latestUser: string | undefined;

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			details?: { recap?: string };
			message?: { role?: string; content?: unknown };
		};

		if (record.type === "custom" && record.customType === "kaku-tab-title") {
			const nextTitle = parseTabTitleEntry(record.data);
			if (nextTitle === null) {
				tabTitle = undefined;
			} else if (nextTitle) {
				tabTitle = nextTitle;
			}
			continue;
		}

		if (record.type === "custom_message" && record.customType === "session-recap/line" && record.details?.recap) {
			latestRecap = normalizePinTitle(record.details.recap);
			continue;
		}

		if (record.type !== "message" || record.message?.role !== "user") continue;
		const text = normaliseMessageText(extractTextContent(record.message.content));
		if (!isMeaningfulUserText(text)) continue;
		firstUser ??= text;
		latestUser = text;
	}

	return normalizePinTitle(tabTitle || sessionName || latestRecap || latestUser || firstUser || fallback) || "Pinned session";
}

function inferSessionSummaryFromInfo(session: SessionInfo): SessionSummary {
	const chunks = session.allMessagesText
		.split(/(?<=[。.!?？])\s+/)
		.map((part) => normaliseMessageText(part))
		.filter(Boolean);
	const meaningful = chunks.filter(isMeaningfulUserText);
	const latest = meaningful.at(-1) ?? normaliseMessageText(session.firstMessage);
	const earliest = meaningful[0] ?? normaliseMessageText(session.firstMessage);
	const title = compactText(session.name || latest || earliest || session.firstMessage, MAX_TITLE_WIDTH);
	const detailSource = latest && earliest && latest !== earliest ? `${earliest} → ${latest}` : latest || earliest || session.firstMessage;
	return {
		title,
		detail: compactText(detailSource, MAX_DETAIL_WIDTH),
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: unknown; thinking?: unknown };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

async function readSessionDecorations(session: SessionInfo): Promise<SessionDecorations> {
	try {
		const content = await readFile(session.path, "utf8");
		const userMessages: string[] = [];
		const assistantMessages: string[] = [];
		const recapMessages: string[] = [];
		let pin: SessionPin | undefined;

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			// session-recap 插件把 recap 存成内联 custom_message（无 message 字段），
			// 取最后一条作为列表标题：它是模型对整个会话的一句话归纳，比「最新用户
			// 消息原文」更贴合任务主题。仅改标题来源，detail 仍走原有消息链。
			const custom = entry as {
				type?: string;
				customType?: string;
				data?: unknown;
				details?: { recap?: string };
				timestamp?: string;
			};
			if (custom.type === "custom" && custom.customType === PIN_CUSTOM_TYPE) {
				const nextPin = parsePinEntry(custom.data, custom.timestamp);
				if (nextPin === null) {
					pin = undefined;
				} else if (nextPin) {
					pin = nextPin;
				}
				continue;
			}
			if (
				custom.type === "custom_message" &&
				custom.customType === "session-recap/line" &&
				custom.details?.recap
			) {
				const recap = cleanSingleLine(custom.details.recap, "");
				if (recap) recapMessages.push(recap);
				continue;
			}

			const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
			if (!message) continue;

			const text = normaliseMessageText(extractTextContent(message.content));
			if (!text) continue;

			if (message.role === "user" && isMeaningfulUserText(text)) {
				userMessages.push(text);
			} else if (message.role === "assistant") {
				assistantMessages.push(text);
			}
		}

		const latestRecap = recapMessages.at(-1);
		const latestUser = userMessages.at(-1);
		const firstUser = userMessages[0];
		const latestAssistant = assistantMessages.at(-1);
		const titleSource = latestRecap || session.name || latestUser || firstUser || session.firstMessage;
		const title = compactText(titleSource, MAX_TITLE_WIDTH);
		const detailParts = [firstUser && firstUser !== latestUser ? firstUser : undefined, latestUser, latestAssistant]
			.filter(Boolean)
			.slice(-2) as string[];
		const detail = compactText(detailParts.join(" → ") || titleSource, MAX_DETAIL_WIDTH);
		return { summary: { title, detail }, pin };
	} catch {
		return { summary: inferSessionSummaryFromInfo(session) };
	}
}

async function buildSessionItem(session: SessionInfo): Promise<SessionItem> {
	const modifiedMs = session.modified.getTime();
	const cached = sessionItemCache.get(session.path);
	if (cached && cached.modifiedMs === modifiedMs) {
		return { info: session, summary: cached.summary, pin: cached.pin };
	}

	const decorations = await readSessionDecorations(session);
	sessionItemCache.set(session.path, { modifiedMs, ...decorations });
	schedulePersistCache();
	return { info: session, ...decorations };
}

function buildSessionItemFromCache(session: SessionInfo): SessionItem {
	const modifiedMs = session.modified.getTime();
	const cached = sessionItemCache.get(session.path);
	if (cached && cached.modifiedMs === modifiedMs) {
		return { info: session, summary: cached.summary, pin: cached.pin };
	}
	return { info: session, summary: inferSessionSummaryFromInfo(session) };
}

async function buildSessionItemsWithConcurrency(
	sessions: SessionInfo[],
	onItem?: (item: SessionItem) => void,
): Promise<SessionItem[]> {
	const results = new Array<SessionItem | undefined>(sessions.length);
	let nextIndex = 0;
	const workerCount = Math.min(4, sessions.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < sessions.length) {
				const index = nextIndex++;
				const session = sessions[index];
				if (!session) continue;
				const item = await buildSessionItem(session);
				results[index] = item;
				onItem?.(item);
			}
		}),
	);
	return results.filter((item): item is SessionItem => Boolean(item));
}

function asciiDisplayText(text: string): string {
	return text.replace(/→/g, "->");
}

// Paint a full-width selection band behind a row. `th.bg` resets only the
// background (\x1b[49m), so any foreground/bold styling already baked into
// `line` survives. The line is padded with spaces to the overlay width first so
// the highlight reaches the right edge instead of stopping at the text.
function withSelectedBackground(th: Theme, line: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(line));
	return th.bg("selectedBg", line + " ".repeat(padding));
}

function isFocusableComponent(component: Component): component is Component & Focusable {
	return "focused" in component;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class SessionSwitcherOverlay implements Component, Focusable {
	private activeTab: SessionTab;
	private readonly tabItems = new Map<SessionTab, SessionItem[]>();
	private readonly tabSessions = new Map<SessionTab, SessionInfo[]>();
	private readonly tabLoadPromises = new Map<SessionTab, Promise<void>>();
	private pinnedSessions: SessionItem[] = [];
	private sessions: SessionItem[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private loading = false;
	private error: string | undefined;
	private notice: string | undefined;
	private loadSeq = 0;
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly ctx: ExtensionContext;
	private readonly onSwitch: (path: string) => void;
	private readonly onNewSession: () => void;
	private readonly onClose: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		ctx: ExtensionContext,
		onSwitch: (path: string) => void,
		onNewSession: () => void,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.onSwitch = onSwitch;
		this.onNewSession = onNewSession;
		this.onClose = onClose;
		this.activeTab = ctx.sessionManager.getSessionFile()?.startsWith(AUTOMATION_RUNS_ROOT) ? "automation" : "project";
		// Warm the module cache from disk and synchronously seed the active tab so
		// the very first render already shows the session list with real titles
		// (when cached) instead of a "loading" frame followed by placeholder
		// timestamps. The async reload below still runs to hydrate/refresh.
		loadPersistedCacheOnce();
		this.seedTabSync(this.activeTab);
		void this.reload();
		void this.preloadTab(this.activeTab === "project" ? "automation" : "project");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (value) {
			this.notice = undefined;
		}
	}

	// Populate a tab synchronously (fast per-cwd scan for project, run.json scan
	// for automation) so the first paint of that tab has real content instead of
	// an empty "loading" frame. Returns true when it seeded the given tab. Skips
	// work when the tab is already cached. When the tab is the active one, the
	// seeded items are applied immediately so the current render reflects them.
	private seedTabSync(tab: SessionTab): boolean {
		if (this.tabItems.has(tab)) return true;
		const sessions = tab === "project"
			? listSessionsFastSync(this.ctx.cwd, defaultSessionDirForCwd(this.ctx.cwd))
			: listAutomationSessionsSync(this.ctx.cwd);
		if (sessions.length === 0) return false;
		const sorted = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		const items = sorted.map((session) => buildSessionItemFromCache(session));
		this.tabSessions.set(tab, sorted);
		this.tabItems.set(tab, items);
		if (tab === this.activeTab) {
			this.applyItems(items, false);
			this.loading = false;
		}
		return true;
	}

	private async loadTab(tab: SessionTab): Promise<void> {
		const existing = this.tabLoadPromises.get(tab);
		if (existing) return existing;
		const load = (async () => {
			const sessions = tab === "project"
				? await listSessionsFast(this.ctx.cwd, defaultSessionDirForCwd(this.ctx.cwd))
				: await listAutomationSessions(this.ctx.cwd);
			const sorted = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			this.tabSessions.set(tab, sorted);
			this.tabItems.set(tab, sorted.map((session) => buildSessionItemFromCache(session)));
		})().finally(() => this.tabLoadPromises.delete(tab));
		this.tabLoadPromises.set(tab, load);
		return load;
	}

	private async preloadTab(tab: SessionTab): Promise<void> {
		try {
			await this.loadTab(tab);
		} catch {
			// The active tab reports errors; background preload stays silent.
		}
	}

	async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		const tab = this.activeTab;
		this.error = undefined;
		const cached = this.tabItems.get(tab);
		if (cached) {
			this.loading = false;
			this.applyItems(cached, false);
			this.tui.requestRender();
			const sessions = this.tabSessions.get(tab) ?? [];
			void this.hydrateSessions(seq, tab, sessions);
			return;
		}

		this.loading = true;
		this.tui.requestRender();
		try {
			await this.loadTab(tab);
			if (seq !== this.loadSeq || tab !== this.activeTab) return;
			this.applyItems(this.tabItems.get(tab) ?? [], false);
			this.loading = false;
			this.tui.requestRender();
			void this.hydrateSessions(seq, tab, this.tabSessions.get(tab) ?? []);
		} catch (error) {
			if (seq !== this.loadSeq || tab !== this.activeTab) return;
			this.error = error instanceof Error ? error.message : String(error);
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private applyItems(items: SessionItem[], preserveSelection: boolean): void {
		const previousSelectedPath = preserveSelection ? this.selectedSession()?.info.path : undefined;
		const keepNewSelected = preserveSelection && this.selectedIndex === 0;

		this.pinnedSessions = items.filter((item) => item.pin);
		this.sessions = items.filter((item) => !item.pin);

		if (keepNewSelected || items.length === 0) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}

		const targetPath = previousSelectedPath || this.currentPath();
		const pinnedIdx = this.pinnedSessions.findIndex((s) => s.info.path === targetPath);
		const historyIdx = this.sessions.findIndex((s) => s.info.path === targetPath);
		this.selectedIndex =
			pinnedIdx >= 0 ? pinnedIdx + 1 : historyIdx >= 0 ? historyIdx + this.pinnedSessions.length + 1 : 0;
		this.ensureSelectedVisible();
	}

	private async hydrateSessions(seq: number, tab: SessionTab, sessions: SessionInfo[]): Promise<void> {
		const items = await buildSessionItemsWithConcurrency(sessions);
		this.tabItems.set(tab, items);
		if (seq !== this.loadSeq || tab !== this.activeTab) return;
		this.applyItems(items, true);
		this.loading = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (isEscapeKey(data)) {
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.switchTab(-1);
			return;
		}

		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.switchTab(1);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.confirmSelection();
			return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(1, width);
		// Full-width horizontal rules replace the old box borders. With no vertical
		// │ side borders, wide (CJK) glyphs can no longer collide with a right border.
		const rule = (n = w) => th.fg("border", "─".repeat(Math.max(1, n)));
		const pad = (s: string) => ` ${s}`;

		const lines: string[] = [];
		lines.push(rule());
		const projectLabel = " Project Sessions ";
		const automationLabel = " Automation Runs ";
		const projectTab = this.activeTab === "project"
			? th.bg("selectedBg", th.fg("accent", th.bold(projectLabel)))
			: th.fg("muted", projectLabel);
		const automationTab = this.activeTab === "automation"
			? th.bg("selectedBg", th.fg("accent", th.bold(automationLabel)))
			: th.fg("muted", automationLabel);
		lines.push(pad(`${projectTab} ${automationTab}`));
		lines.push(rule());

		if (this.error) {
			lines.push(pad(th.fg("error", this.error)));
			lines.push(rule());
			return lines;
		}

		// Header: a single line that pairs the bold title with the current
		// position, e.g. "Sessions (3 of 26)" or "Sessions (new session)". Keeping
		// title + counter on one row avoids the old two-line layout that looked
		// misaligned at the top of the overlay.
		const sessionCount = this.pinnedSessions.length + this.sessions.length;
		const position = this.selectedIndex === 0 ? "new session" : `${this.selectedIndex} of ${sessionCount}`;
		const sectionTitle = this.activeTab === "project" ? "Project Sessions" : "Automation Runs";
		lines.push(pad(`${th.fg("accent", th.bold(sectionTitle))} ${th.fg("dim", `(${position})`)}`));

		// "New session" entry — rendered as a bordered button (equivalent to /new).
		lines.push(...this.renderNewSessionRow(w));
		// Divider separating the button from pinned/history sections below.
		lines.push(rule());

		if (this.pinnedSessions.length > 0) {
			lines.push(pad(th.fg("accent", th.bold("Pinned Sessions"))));
			for (let i = 0; i < this.pinnedSessions.length; i++) {
				lines.push(this.renderPinnedSessionItem(this.pinnedSessions[i]!, i, w));
			}
			lines.push(rule());
		}

		lines.push(pad(th.fg("accent", th.bold(this.activeTab === "project" ? "History Sessions" : "Run Sessions"))));

		// Session list area. While the first async scan is still in flight and no
		// items exist yet, render nothing here (no "loading sessions..." placeholder)
		// so the tab bar, section titles, and New-session button show immediately
		// and the list simply fills in once ready — avoids a loading flash.
		if (this.loading && sessionCount === 0) {
			// Intentionally blank during initial load.
		} else if (sessionCount === 0) {
			lines.push(pad(th.fg("dim", this.activeTab === "project" ? "no saved project sessions" : "no automation runs with saved sessions")));
		} else if (this.sessions.length === 0) {
			lines.push(pad(th.fg("dim", "no unpinned history sessions")));
		} else {
			const visibleCount = Math.min(this.sessions.length, OVERLAY_VISIBLE_COUNT);
			const maxScroll = Math.max(0, this.sessions.length - visibleCount);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

			const canScrollUp = this.scrollOffset > 0;
			const canScrollDown = this.scrollOffset < maxScroll;
			if (canScrollUp || canScrollDown) {
				const upArrow = canScrollUp ? "↑" : "·";
				const downArrow = canScrollDown ? "↓" : "·";
				const scrollInfo = `${upArrow} ${this.scrollOffset + 1}-${this.scrollOffset + visibleCount} ${downArrow}`;
				lines.push(pad(th.fg("dim", scrollInfo)));
			}

			for (let i = this.scrollOffset; i < this.scrollOffset + visibleCount && i < this.sessions.length; i++) {
				lines.push(this.renderSessionItem(this.sessions[i]!, i, w));
			}
		}

		// Footer: bottom rule and key hints.
		lines.push(rule());
		const help = this.notice ? th.fg("warning", this.notice) : "←/→ or tab switch · ↑/↓ navigate · enter select · esc close";
		lines.push(pad(th.fg("dim", help)));

		return lines;
	}

	private sessionNumberWidth(): number {
		return Math.max(2, `${this.pinnedSessions.length + this.sessions.length}.`.length);
	}

	// Render the "New session" entry as a compact single-line bracket button so it
	// reads as a distinct, clickable-looking control rather than a plain list row
	// without consuming three vertical lines. It shares the same row grid as saved
	// sessions: cursor column, index column, then content column. A dim dot fills
	// the numeric digit slot (with a trailing spacer replacing the period) so the
	// button starts exactly where session titles start.
	private renderNewSessionRow(width: number): string[] {
		const th = this.theme;
		const isSelected = this.selectedIndex === 0;
		const content = "+ New session";
		const cursorPlain = isSelected ? "›" : " ";
		const placeholderPlain = `${" ".repeat(Math.max(0, this.sessionNumberWidth() - 2))}· `;
		const prefixPlain = ` ${cursorPlain} ${placeholderPlain} `;
		// Clamp against the computed grid prefix plus "[label]" chrome so the
		// button never overflows on narrow terminals.
		const labelWidth = Math.max(1, width - visibleWidth(prefixPlain) - 2);
		const label = truncateToWidth(content, labelWidth, "...");

		const borderColor = isSelected ? "accent" : "border";
		const bracketL = th.fg(borderColor, "[");
		const bracketR = th.fg(borderColor, "]");
		const labelStyled = isSelected ? th.bold(th.fg("accent", label)) : th.fg("accent", label);
		const cursor = isSelected ? th.fg("accent", "›") : " ";
		const placeholder = th.fg("dim", placeholderPlain);

		const row = ` ${cursor} ${placeholder} ${bracketL}${labelStyled}${bracketR}`;
		// When selected, paint a full-width highlight bar behind the row so the
		// active entry reads as a solid selected band (mirrors the built-in
		// session selector's `selectedBg` treatment).
		return [isSelected ? withSelectedBackground(th, row, width) : row];
	}

	private renderPinnedSessionItem(item: SessionItem, index: number, width: number): string {
		const th = this.theme;
		const isSelected = this.selectedIndex === index + 1;
		const isCurrent = item.info.path === this.currentPath();
		const cursorChar = isSelected ? "›" : " ";
		const number = `${index + 1}.`.padStart(this.sessionNumberWidth(), " ");
		const pinTitle = item.pin?.title || item.summary.title;
		const prefixPlain = ` ${cursorChar} ${number} `;
		const titleWidth = Math.max(1, width - visibleWidth(prefixPlain));
		const titleText = truncateToWidth(asciiDisplayText(pinTitle), titleWidth, "...");
		const body = `${number} ${titleText}`;
		const cursor = isSelected ? th.fg("accent", "›") : " ";
		const styled = isSelected
			? th.bold(th.fg("accent", body))
			: isCurrent
				? th.fg("success", body)
				: th.fg("text", body);
		const line = ` ${cursor} ${styled}`;
		return isSelected ? withSelectedBackground(th, line, width) : line;
	}

	private renderSessionItem(item: SessionItem, index: number, width: number): string {
		const th = this.theme;
		// Sessions occupy unified indices 1..N (index 0 is the "New session" entry).
		const unifiedIndex = this.pinnedSessions.length + index + 1;
		const isSelected = this.selectedIndex === unifiedIndex;
		const isCurrent = item.info.path === this.currentPath();
		const cursorChar = isSelected ? "›" : " ";
		const number = `${unifiedIndex}.`.padStart(this.sessionNumberWidth(), " ");
		// Plain prefix drives the width math; color is applied afterwards.
		const prefixPlain = ` ${cursorChar} ${number} `;
		const titleWidth = Math.max(1, width - visibleWidth(prefixPlain));
		const titleText = truncateToWidth(asciiDisplayText(item.summary.title), titleWidth, "...");
		const body = `${number} ${titleText}`;
		const cursor = isSelected ? th.fg("accent", "›") : " ";
		const styled = isSelected
			? th.bold(th.fg("accent", body))
			: isCurrent
				? th.fg("success", body)
				: th.fg("text", body);
		const line = ` ${cursor} ${styled}`;
		// Selected row gets a full-width `selectedBg` band so the active item is
		// unmistakable even on wide CJK rows where the cursor alone is easy to miss.
		return isSelected ? withSelectedBackground(th, line, width) : line;
	}

	private currentPath(): string | undefined {
		return this.ctx.sessionManager.getSessionFile();
	}

	private selectedSession(): SessionItem | undefined {
		if (this.selectedIndex === 0) return undefined;
		const pinnedIdx = this.selectedIndex - 1;
		if (pinnedIdx < this.pinnedSessions.length) return this.pinnedSessions[pinnedIdx];
		return this.sessions[this.selectedIndex - this.pinnedSessions.length - 1];
	}

	private switchTab(delta: number): void {
		const tabs: SessionTab[] = ["project", "automation"];
		const current = tabs.indexOf(this.activeTab);
		this.activeTab = tabs[(current + delta + tabs.length) % tabs.length]!;
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.notice = undefined;
		// Seed the target tab synchronously (when not already cached) so switching
		// tabs paints the list immediately instead of flashing a "loading" frame
		// while the async scan runs. reload() still refreshes/hydrates afterwards.
		this.seedTabSync(this.activeTab);
		void this.reload();
	}

	private move(delta: number): void {
		// Total selectable rows: the "New session" entry plus every saved session.
		const total = this.pinnedSessions.length + this.sessions.length + 1;
		this.notice = undefined;
		this.selectedIndex = (this.selectedIndex + delta + total) % total;
		this.ensureSelectedVisible();
		this.tui.requestRender();
	}

	private ensureSelectedVisible(): void {
		if (this.selectedIndex <= this.pinnedSessions.length) return; // New/pinned rows need no history scrolling.
		const sessionIdx = this.selectedIndex - this.pinnedSessions.length - 1;
		const visibleCount = Math.min(this.sessions.length, OVERLAY_VISIBLE_COUNT);
		const maxScroll = Math.max(0, this.sessions.length - visibleCount);

		if (sessionIdx < this.scrollOffset) {
			this.scrollOffset = sessionIdx;
		} else if (sessionIdx >= this.scrollOffset + visibleCount) {
			this.scrollOffset = sessionIdx - visibleCount + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
	}

	private confirmSelection(): void {
		// Index 0 is the "New session" entry → behaves like /new.
		if (this.selectedIndex === 0) {
			if (!this.ctx.isIdle()) {
				this.notice = "wait until idle";
				this.tui.requestRender();
				return;
			}
			this.onNewSession();
			return;
		}

		const selected = this.selectedSession();
		if (!selected) return;

		if (selected.info.path === this.currentPath()) {
			this.onClose();
			return;
		}

		if (!this.ctx.isIdle()) {
			this.notice = "wait until idle";
			this.tui.requestRender();
			return;
		}

		this.onSwitch(selected.info.path);
	}

	invalidate(): void {
		// Render is derived from current state and theme.
	}
}

// ---------------------------------------------------------------------------
// Editor wrappers — intercept toggle key when editor has focus
// ---------------------------------------------------------------------------

function isToggleKey(data: string): boolean {
	if (data === TOGGLE_SEQUENCE_COMMAND_SHIFT_LEFT) return true;
	if (matchesKey(data, TOGGLE_KEY)) return true;

	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::\d+)?D$/);
	if (!arrowMatch) return false;

	const modifier = Number.parseInt(arrowMatch[1]!, 10) - 1;
	return (modifier & MODIFIER_SHIFT) !== 0 && (modifier & MODIFIER_COMMAND_LIKE) !== 0;
}

function isToggleKeyPress(data: string): boolean {
	return isToggleKey(data) && !isKeyRelease(data) && !isKeyRepeat(data);
}

function isEscapeKey(data: string): boolean {
	return matchesKey(data, Key.escape) || parseKey(data) === Key.escape;
}

function describeKeyInput(data: string): string {
	const key = parseKey(data) ?? "unparsed";
	const escaped = data
		.replace(/\x1b/g, "\\x1b")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
	const codes = Array.from(data, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
	return `${key} | ${escaped || "(empty)"} | ${codes || "no-bytes"}`;
}

class ShortcutBridgeEditor extends CustomEditor {
	private readonly onToggle: () => void;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, onToggle: () => void) {
		super(tui, theme, keybindings);
		this.onToggle = onToggle;
	}

	handleInput(data: string): void {
		if (isToggleKey(data)) {
			if (isToggleKeyPress(data)) {
				this.onToggle();
			}
			return;
		}
		super.handleInput(data);
	}
}

class ShortcutBridgeWrapper implements EditorComponent, Focusable {
	private readonly base: EditorComponent;
	private readonly onToggle: () => void;

	constructor(base: EditorComponent, onToggle: () => void) {
		this.base = base;
		this.onToggle = onToggle;
	}

	get focused(): boolean {
		return isFocusableComponent(this.base) ? this.base.focused : false;
	}

	set focused(value: boolean) {
		if (isFocusableComponent(this.base)) {
			this.base.focused = value;
		}
	}

	get borderColor() {
		return this.base.borderColor;
	}

	set borderColor(value) {
		this.base.borderColor = value;
	}

	get onSubmit() {
		return this.base.onSubmit;
	}

	set onSubmit(value) {
		this.base.onSubmit = value;
	}

	get onChange() {
		return this.base.onChange;
	}

	set onChange(value) {
		this.base.onChange = value;
	}

	get actionHandlers() {
		return (this.base as { actionHandlers?: Map<string, () => void> }).actionHandlers;
	}

	get onEscape() {
		return (this.base as { onEscape?: () => void }).onEscape;
	}

	set onEscape(value) {
		(this.base as { onEscape?: () => void }).onEscape = value;
	}

	get onCtrlD() {
		return (this.base as { onCtrlD?: () => void }).onCtrlD;
	}

	set onCtrlD(value) {
		(this.base as { onCtrlD?: () => void }).onCtrlD = value;
	}

	get onPasteImage() {
		return (this.base as { onPasteImage?: () => void }).onPasteImage;
	}

	set onPasteImage(value) {
		(this.base as { onPasteImage?: () => void }).onPasteImage = value;
	}

	get onExtensionShortcut() {
		return (this.base as { onExtensionShortcut?: (data: string) => boolean | undefined }).onExtensionShortcut;
	}

	set onExtensionShortcut(value) {
		(this.base as { onExtensionShortcut?: (data: string) => boolean | undefined }).onExtensionShortcut = value;
	}

	getText(): string {
		return this.base.getText();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	// Forward autocomplete visibility so consumers that query the editor (the host
	// and other extensions' input handlers) get a truthful answer through the proxy.
	isShowingAutocomplete(): boolean {
		const editor = this.base as { isShowingAutocomplete?: () => boolean };
		return editor.isShowingAutocomplete?.() === true;
	}

	invalidate(): void {
		this.base.invalidate();
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	handleInput(data: string): void {
		if (isToggleKey(data)) {
			if (isToggleKeyPress(data)) {
				this.onToggle();
			}
			return;
		}
		(this.base as { handleInput?: (data: string) => void }).handleInput?.(data);
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let pendingSwitchPath: string | undefined;
	let debugKeysUntil = 0;
	const state = globalState();

	pi.registerCommand(COMMAND_PIN, {
		description: "Pin the current session using its current session title",
		handler: async (_args, ctx) => {
			const title = derivePinTitleFromEntries(
				ctx.sessionManager.getBranch() as unknown[],
				ctx.sessionManager.getSessionName(),
				ctx.sessionManager.getHeader()?.cwd || ctx.cwd,
			);

			pi.appendEntry(PIN_CUSTOM_TYPE, { pinned: true, title, updatedAt: new Date().toISOString() });
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (sessionPath) sessionItemCache.delete(sessionPath);
			ctx.ui.notify(`Pinned current session: ${title}`, "info");
			pi.events.emit("session-switcher:pins-changed", undefined);
		},
	});

	pi.registerCommand(COMMAND_UNPIN, {
		description: "Remove the pin from the current session",
		handler: async (_args, ctx) => {
			pi.appendEntry(PIN_CUSTOM_TYPE, { pinned: false, updatedAt: new Date().toISOString() });
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (sessionPath) sessionItemCache.delete(sessionPath);
			ctx.ui.notify("Unpinned current session", "info");
			pi.events.emit("session-switcher:pins-changed", undefined);
		},
	});

	// Manual command to open the overlay. The --switch form is private to the overlay.
	pi.registerCommand(COMMAND_OPEN, {
		description: "Open the session switcher overlay",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();

			if (trimmedArgs === INTERNAL_COMMAND_SWITCH_ARG) {
				const sessionPath = pendingSwitchPath;
				pendingSwitchPath = undefined;

				if (!sessionPath) {
					ctx.ui.notify("No session selected", "error");
					return;
				}

				await ctx.waitForIdle();
				const result = await ctx.switchSession(sessionPath, {
					withSession: async (nextCtx) => {
						nextCtx.ui.notify("Switched session", "info");
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("Session switch cancelled", "info");
				}
				return;
			}

			if (trimmedArgs) {
				if (trimmedArgs === DEBUG_KEYS_ARG) {
					debugKeysUntil = Date.now() + 10_000;
					ctx.ui.notify("Key debug enabled for 10s. Press Command+Shift+Left now.", "info");
					return;
				}

				ctx.ui.notify(`Usage: /sessions or /sessions ${DEBUG_KEYS_ARG}`, "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("UI not available", "error");
				return;
			}
			pi.events.emit("session-switcher:toggle", undefined);
		},
	});

	pi.on("session_shutdown", () => {
		state.cleanup?.();
		state.cleanup = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		state.cleanup?.();
		state.cleanup = undefined;

		// Clean up any stale bottom-row widget from a previous version
		ctx.ui.setWidget(WIDGET_KEY, undefined);

		let overlayOpen = false;
		let closeCurrentOverlay: (() => void) | undefined;
		let submitText: ((text: string) => void) | undefined;
		let lastShortcutToggleAt = 0;

		const closeOverlay = () => {
			closeCurrentOverlay?.();
		};

		const openOverlay = async () => {
			if (overlayOpen) return;
			overlayOpen = true;
			try {
				const result = await ctx.ui.custom<OverlayResult | undefined>(
					(tui, theme, _keybindings, done) => {
						closeCurrentOverlay = () => done(undefined);
						return new SessionSwitcherOverlay(
							tui,
							theme,
							ctx,
							(path) => done({ type: "switch", path }),
							() => done({ type: "new" }),
							() => done(undefined),
						);
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: OVERLAY_WIDTH,
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							queueMicrotask(() => handle.focus());
							setTimeout(() => handle.focus(), 0);
						},
					},
				);

				if (!result) return;
				if (!submitText) {
					ctx.ui.notify("Editor not available", "error");
					return;
				}
				// Start a brand-new session — same effect as typing /new.
				if (result.type === "new") {
					submitText("/new");
					return;
				}
				pendingSwitchPath = result.path;
				submitText(`/${COMMAND_OPEN} ${INTERNAL_COMMAND_SWITCH_ARG}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Session switcher failed: ${message}`, "error");
			} finally {
				overlayOpen = false;
				closeCurrentOverlay = undefined;
			}
		};

		const toggleOverlay = () => {
			if (overlayOpen) {
				closeOverlay();
			} else {
				void openOverlay();
			}
		};

		const toggleOverlayFromShortcut = () => {
			const now = Date.now();
			if (now - lastShortcutToggleAt < 200) return;
			lastShortcutToggleAt = now;
			toggleOverlay();
		};

		// Listen for toggle signals from the /sessions command.
		const unsubToggle = pi.events.on("session-switcher:toggle", toggleOverlay);

		// Intercept the toggle at the raw terminal-input layer before it can edit text.
		// Escape is intentionally left to the focused overlay, so one Esc maps to
		// exactly one close operation.
		const unsubInput = ctx.ui.onTerminalInput((data) => {
			if (Date.now() <= debugKeysUntil) {
				ctx.ui.notify(`key: ${describeKeyInput(data)}`, isToggleKey(data) ? "info" : "warning");
			}

			if (isToggleKey(data)) {
				if (isToggleKeyPress(data)) {
					toggleOverlayFromShortcut();
				}
				return { consume: true };
			}
			return undefined;
		});

		// Wrap the editor to catch the key when it has focus
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			let editor: FocusTarget;
			if (previousFactory) {
				editor = new ShortcutBridgeWrapper(
					previousFactory(tui, editorTheme, keybindings),
					toggleOverlayFromShortcut,
				);
			} else {
				editor = new ShortcutBridgeEditor(tui, editorTheme, keybindings, toggleOverlayFromShortcut);
			}

			submitText = (text) => editor.onSubmit?.(text);
			return editor;
		});

		state.cleanup = () => {
			closeOverlay();
			unsubToggle();
			unsubInput();
		};
	});
}
