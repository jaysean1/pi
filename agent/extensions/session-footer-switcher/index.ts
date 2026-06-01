// Session switcher as a left-side overlay.
// The panel starts with a "New session" entry (equivalent to /new), followed
// by the list of saved sessions.
// Toggle shortcut:
//   Command+Shift+Left - requires terminal support for Super-modified keys
// Manual fallback: /sessions

import { readFile } from "node:fs/promises";
import {
	CustomEditor,
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
const WIDGET_KEY = "session-footer-switcher";
const MAX_TITLE_WIDTH = 56;
const MAX_DETAIL_WIDTH = 96;
const OVERLAY_VISIBLE_COUNT = 12;
const INTERNAL_COMMAND_SWITCH_ARG = "--switch";
const INTERNAL_COMMAND_PREFIX = `/${COMMAND_OPEN} ${INTERNAL_COMMAND_SWITCH_ARG}`;
const DEBUG_KEYS_ARG = "debug-keys";

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

interface SessionItem {
	info: SessionInfo;
	summary: SessionSummary;
}

const summaryCache = new Map<string, { modifiedMs: number; summary: SessionSummary }>();

function cleanSingleLine(text: string | undefined, fallback: string): string {
	const cleaned = (text ?? "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return cleaned || fallback;
}

function normaliseMessageText(text: string): string {
	return text
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
	if (/^\/?(resume|reload|quit|new|session|tree|fork|clone)(\s|$)/i.test(cleaned)) return false;
	if (/^(hi|hello|hey|thanks|thank you|你好|嗨|谢谢|好的|可以|ok|嗯|是的|继续)$/i.test(cleaned)) return false;
	return cleaned.length >= 8;
}

function compactText(text: string, maxWidth: number): string {
	return truncateToWidth(cleanSingleLine(normaliseMessageText(text), "No summary"), maxWidth, "...");
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

async function summariseSession(session: SessionInfo): Promise<SessionSummary> {
	try {
		const content = await readFile(session.path, "utf8");
		const userMessages: string[] = [];
		const assistantMessages: string[] = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
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

		const latestUser = userMessages.at(-1);
		const firstUser = userMessages[0];
		const latestAssistant = assistantMessages.at(-1);
		const titleSource = session.name || latestUser || firstUser || session.firstMessage;
		const title = compactText(titleSource, MAX_TITLE_WIDTH);
		const detailParts = [firstUser && firstUser !== latestUser ? firstUser : undefined, latestUser, latestAssistant]
			.filter(Boolean)
			.slice(-2) as string[];
		const detail = compactText(detailParts.join(" → ") || titleSource, MAX_DETAIL_WIDTH);
		return { title, detail };
	} catch {
		return inferSessionSummaryFromInfo(session);
	}
}

async function buildSessionItem(session: SessionInfo): Promise<SessionItem> {
	const modifiedMs = session.modified.getTime();
	const cached = summaryCache.get(session.path);
	if (cached && cached.modifiedMs === modifiedMs) {
		return { info: session, summary: cached.summary };
	}

	const summary = await summariseSession(session);
	summaryCache.set(session.path, { modifiedMs, summary });
	return { info: session, summary };
}

function asciiDisplayText(text: string): string {
	return text.replace(/→/g, "->");
}

function isFocusableComponent(component: Component): component is Component & Focusable {
	return "focused" in component;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class SessionSwitcherOverlay implements Component, Focusable {
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
		void this.reload();
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

	async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		this.loading = true;
		this.error = undefined;
		this.tui.requestRender();

		try {
			const sessions = await SessionManager.list(this.ctx.cwd, this.ctx.sessionManager.getSessionDir());
			const sorted = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			const items = await Promise.all(sorted.map((session) => buildSessionItem(session)));
			if (seq !== this.loadSeq) return;

			this.sessions = items;
			this.scrollOffset = 0;
			if (this.sessions.length === 0) {
				// Only the "New session" entry remains selectable.
				this.selectedIndex = 0;
			} else {
				// Index 0 is the "New session" entry; sessions occupy 1..N.
				const currentIdx = this.sessions.findIndex((s) => s.info.path === this.currentPath());
				this.selectedIndex = currentIdx >= 0 ? currentIdx + 1 : 0;
				this.ensureSelectedVisible();
			}
		} catch (error) {
			if (seq !== this.loadSeq) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (seq === this.loadSeq) {
				this.loading = false;
				this.tui.requestRender();
			}
		}
	}

	handleInput(data: string): void {
		if (isEscapeKey(data)) {
			this.onClose();
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
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg("border", c);
		const padLine = (s: string) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - w));
		};

		const lines: string[] = [];

		// Title bar
		const title = " Sessions ";
		const titleW = visibleWidth(title);
		const sideW = Math.max(0, innerW - titleW);
		const leftPad = Math.floor(sideW / 2);
		const rightPad = sideW - leftPad;
		lines.push(
			border("╭") +
				border("─".repeat(leftPad)) +
				th.fg("accent", th.bold(title)) +
				border("─".repeat(rightPad)) +
				border("╮"),
		);

		if (this.error) {
			lines.push(border("│") + padLine(th.fg("error", this.error)) + border("│"));
			lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
			return lines;
		}

		// Subtitle
		const sessionCount = this.sessions.length;
		const subtitle =
			this.selectedIndex === 0
				? ` new session - ${sessionCount} saved `
				: ` ${this.selectedIndex}/${sessionCount} - ${sessionCount} sessions `;
		lines.push(border("│") + padLine(th.fg("dim", subtitle)) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// "New session" entry — always available at the top (equivalent to /new).
		lines.push(border("│") + this.renderNewSessionRow(innerW) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Session list area
		if (this.loading && this.sessions.length === 0) {
			lines.push(border("│") + padLine(th.fg("dim", "loading sessions...")) + border("│"));
		} else if (this.sessions.length === 0) {
			lines.push(border("│") + padLine(th.fg("dim", "no saved sessions")) + border("│"));
		} else {
			// Scroll indicators
			const visibleCount = Math.min(this.sessions.length, OVERLAY_VISIBLE_COUNT);
			const maxScroll = Math.max(0, this.sessions.length - visibleCount);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

			const canScrollUp = this.scrollOffset > 0;
			const canScrollDown = this.scrollOffset < maxScroll;

			if (canScrollUp || canScrollDown) {
				const upArrow = canScrollUp ? "^" : "-";
				const downArrow = canScrollDown ? "v" : "-";
				const scrollInfo = ` ${upArrow} ${this.scrollOffset + 1}-${this.scrollOffset + visibleCount} ${downArrow} `;
				lines.push(border("│") + padLine(th.fg("dim", scrollInfo)) + border("│"));
			}

			// Session items
			for (let i = this.scrollOffset; i < this.scrollOffset + visibleCount && i < this.sessions.length; i++) {
				lines.push(border("│") + this.renderSessionItem(this.sessions[i]!, i, innerW) + border("│"));
			}
		}

		// Footer
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const selectedDetail =
			this.selectedIndex === 0 ? "Start a fresh session (same as /new)" : this.selectedSession()?.summary.detail;
		if (selectedDetail) {
			const detail = truncateToWidth(` ${asciiDisplayText(selectedDetail)} `, innerW, "...", true);
			lines.push(border("│") + th.fg("dim", detail) + border("│"));
		}
		const noticeLine = this.notice ? ` ${th.fg("warning", this.notice)} ` : "";
		const help = noticeLine || " up/down navigate - enter select - esc close ";
		lines.push(border("│") + padLine(th.fg("dim", help)) + border("│"));
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));

		return lines;
	}

	private renderNewSessionRow(width: number): string {
		const th = this.theme;
		const isSelected = this.selectedIndex === 0;
		const marker = isSelected ? ">" : " ";
		const line = truncateToWidth(`${marker}  +  New session`, width, "...", true);
		if (isSelected) {
			return th.bg("selectedBg", th.fg("accent", th.bold(line)));
		}
		return th.fg("accent", line);
	}

	private renderSessionItem(item: SessionItem, index: number, width: number): string {
		const th = this.theme;
		// Sessions occupy unified indices 1..N (index 0 is the "New session" entry).
		const isSelected = index === this.selectedIndex - 1;
		const isCurrent = item.info.path === this.currentPath();
		const marker = isSelected ? ">" : " ";
		const number = `${index + 1}.`.padStart(3, " ");
		const currentMarker = isCurrent ? "*" : " ";
		const prefix = `${marker} ${number} ${currentMarker} `;
		const prefixWidth = visibleWidth(prefix);
		const titleWidth = Math.max(1, width - prefixWidth);
		const titleText = truncateToWidth(asciiDisplayText(item.summary.title), titleWidth, "...");
		const line = truncateToWidth(`${prefix}${titleText}`, width, "...", true);
		if (isSelected) {
			return th.bg("selectedBg", th.fg("accent", th.bold(line)));
		}
		return isCurrent ? th.fg("success", line) : th.fg("text", line);
	}

	private currentPath(): string | undefined {
		return this.ctx.sessionManager.getSessionFile();
	}

	private selectedSession(): SessionItem | undefined {
		if (this.selectedIndex === 0) return undefined;
		return this.sessions[this.selectedIndex - 1];
	}

	private move(delta: number): void {
		// Total selectable rows: the "New session" entry plus every saved session.
		const total = this.sessions.length + 1;
		this.notice = undefined;
		this.selectedIndex = (this.selectedIndex + delta + total) % total;
		this.ensureSelectedVisible();
		this.tui.requestRender();
	}

	private ensureSelectedVisible(): void {
		if (this.selectedIndex <= 0) return; // "New session" entry — no session scrolling needed.
		const sessionIdx = this.selectedIndex - 1;
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
							anchor: "center",
							width: "48%",
							minWidth: 52,
							maxHeight: "85%",
							margin: { left: 2, right: 2, top: 2, bottom: 2 },
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
