// Session switcher as a bottom-anchored, full-width overlay (mirrors the
// ask-user-question style: horizontal-rule borders, no vertical │ side borders,
// so wide CJK glyphs can never collide with a right-hand border).
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
// Keep cached summaries generous; rendering still truncates to the live overlay width.
const MAX_TITLE_WIDTH = 240;
const MAX_DETAIL_WIDTH = 320;
const OVERLAY_WIDTH = "100%";
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
		const w = Math.max(1, width);
		// Full-width horizontal rules replace the old box borders. With no vertical
		// │ side borders, wide (CJK) glyphs can no longer collide with a right border.
		const rule = (n = w) => th.fg("border", "─".repeat(Math.max(1, n)));
		const pad = (s: string) => ` ${s}`;

		const lines: string[] = [];
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
		const sessionCount = this.sessions.length;
		const position =
			this.selectedIndex === 0 ? "new session" : `${this.selectedIndex} of ${sessionCount}`;
		lines.push(pad(`${th.fg("accent", th.bold("Sessions"))} ${th.fg("dim", `(${position})`)}`));

		// "New session" entry — rendered as a bordered button (equivalent to /new).
		lines.push(...this.renderNewSessionRow(w));
		// Divider separating the button from the saved-session list below.
		lines.push(rule());

		// Session list area.
		if (this.loading && this.sessions.length === 0) {
			lines.push(pad(th.fg("dim", "loading sessions...")));
		} else if (this.sessions.length === 0) {
			lines.push(pad(th.fg("dim", "no saved sessions")));
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
		const help = this.notice ? th.fg("warning", this.notice) : "↑/↓ navigate · enter select · esc close";
		lines.push(pad(th.fg("dim", help)));

		return lines;
	}

	// Render the "New session" entry as a small bordered button so it reads as a
	// distinct, clickable-looking control rather than a plain list row. The box
	// border is drawn in the accent color when selected and the muted border color
	// otherwise; a "›" cursor sits to the left of the middle row.
	private renderNewSessionRow(width: number): string[] {
		const th = this.theme;
		const isSelected = this.selectedIndex === 0;
		const content = "+  New session";
		// Box layout: │ <space> label <space> │, so the inner width is the label cell
		// plus the two padding spaces. Clamp to the overlay width (minus indent +
		// borders) so the button never overflows on narrow terminals.
		const innerWidth = Math.min(visibleWidth(content) + 2, Math.max(3, width - 6));
		const labelWidth = Math.max(1, innerWidth - 2);
		const label = truncateToWidth(content, labelWidth, "...");
		const padCount = Math.max(0, labelWidth - visibleWidth(label));
		const labelCell = `${label}${" ".repeat(padCount)}`;

		const borderColor = isSelected ? "accent" : "border";
		const top = th.fg(borderColor, `╭${"─".repeat(innerWidth)}╮`);
		const bottom = th.fg(borderColor, `╰${"─".repeat(innerWidth)}╯`);
		const side = th.fg(borderColor, "│");
		const labelStyled = isSelected ? th.bold(th.fg("accent", labelCell)) : th.fg("accent", labelCell);
		const cursor = isSelected ? th.fg("accent", "›") : " ";

		return [`    ${top}`, ` ${cursor}  ${side} ${labelStyled} ${side}`, `    ${bottom}`];
	}

	private renderSessionItem(item: SessionItem, index: number, width: number): string {
		const th = this.theme;
		// Sessions occupy unified indices 1..N (index 0 is the "New session" entry).
		const isSelected = index === this.selectedIndex - 1;
		const isCurrent = item.info.path === this.currentPath();
		const cursorChar = isSelected ? "›" : " ";
		const number = `${index + 1}.`.padStart(3, " ");
		const currentMarker = isCurrent ? "*" : " ";
		// Plain prefix drives the width math; color is applied afterwards.
		const prefixPlain = ` ${cursorChar} ${number} ${currentMarker} `;
		const titleWidth = Math.max(1, width - visibleWidth(prefixPlain));
		const titleText = truncateToWidth(asciiDisplayText(item.summary.title), titleWidth, "...");
		const body = `${number} ${currentMarker} ${titleText}`;
		const cursor = isSelected ? th.fg("accent", "›") : " ";
		const styled = isSelected
			? th.bold(th.fg("accent", body))
			: isCurrent
				? th.fg("success", body)
				: th.fg("text", body);
		return ` ${cursor} ${styled}`;
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
