// pi extension: YouTube Music
//
// Browse your *private* YouTube Music playlists in a full-screen TUI, play them
// through the youtube-music-cli engine (mpv + yt-dlp), and like tracks. A pinned
// "now playing" bar sits directly above the editor input; ⌘⇧M (or /ytm) opens the
// full screen.
//
// Widget ordering: pi renders "aboveEditor" widgets in registration (Map insertion)
// order — first registered sits highest, last registered sits closest to the input.
// Other extensions (e.g. the rpiv-todo overlay) register their widget lazily when a
// todo tool runs, which would otherwise push our bar upward. We re-pin the bar (a
// re-`setWidget` moves it to the end of the map) on a deferred macrotask after those
// events so the now-playing bar always stays directly above the input and the todo
// list shows above it, conflict-free.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { getAuthError, getClient, resetClient } from "./auth.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { getLibraryPlaylists, getPlaylistTracks, likeTrack, removeLike } from "./data.ts";
import { engine } from "./engine.ts";
import { FullscreenView, type FullscreenDeps } from "./fullscreen-view.ts";
import { NowPlayingBar } from "./nowplaying.ts";

const WIDGET_KEY = "youtube-music";
const SHORTCUT = Key.superShift("m"); // ⌘⇧M: mnemonic for Music; avoids Kaku's built-in ⌘⇧Y/Yazi
const SHORTCUT_LABEL = "⌘⇧M";
const KAKU_SHORTCUT_SEQUENCE = "\x1b[993~";
const DEBUG_KEYS_ARG = "debug-keys";
const TARGET_ACCOUNT = "jaysean.qian@gmail.com";
// rpiv-todo registers its overlay widget when this tool executes. We re-pin our
// bar afterwards so the todo list stacks above it instead of pushing it up.
const TODO_WIDGET_TOOL = "todo";

async function refreshAuth(ctx: ExtensionContext): Promise<void> {
	resetClient();
	const c = await getClient(true);
	ctx.ui.notify(c ? `YouTube Music: signed in (${c.source})` : (getAuthError() ?? "Not signed in"), c ? "info" : "warning");
}

async function promptManualCookie(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Run /ytm login in interactive pi, or set YTM_COOKIE to a music.youtube.com Cookie header.", "warning");
		return;
	}

	const ok = await ctx.ui.confirm(
		"YouTube Music manual login",
		`Use the browser account ${TARGET_ACCOUNT}, then paste only the music.youtube.com Cookie header locally. Do not paste your Google password. Continue?`,
	);
	if (!ok) return;

	const pasted = await ctx.ui.editor("Paste music.youtube.com Cookie header", "");
	const cookie = extractCookieHeader(pasted ?? "");
	if (!cookie) {
		ctx.ui.notify("No Cookie header found. Copy a request header that starts with `Cookie:` from music.youtube.com.", "warning");
		return;
	}

	const cfg = loadConfig();
	saveConfig({ ...cfg, account: cfg.account?.trim() || TARGET_ACCOUNT, browserProfile: "auto", cookie });
	await refreshAuth(ctx);
}

function clearManualCookie(ctx: ExtensionContext): void {
	const cfg = loadConfig();
	const { cookie: _cookie, ...rest } = cfg;
	saveConfig({ ...rest, browserProfile: "auto" });
	resetClient();
	ctx.ui.notify(
		process.env.YTM_COOKIE
			? "Config cookie cleared, but env YTM_COOKIE is still active for this process."
			: "Manual YouTube Music cookie cleared; browser auto-detect will be used.",
		"info",
	);
}

function extractCookieHeader(input: string): string | undefined {
	const raw = input.trim();
	if (!raw) return undefined;

	const headerMatch = raw.match(/(?:^|\r?\n)\s*(?:-H\s+['\"]?)?cookie\s*:\s*([^'\"\r\n]+)/i);
	let candidate = headerMatch?.[1] ?? raw;
	candidate = candidate
		.replace(/^cookie\s*:\s*/i, "")
		.replace(/^['\"`]|['\"`]$/g, "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.join(" ")
		.replace(/\\\s*/g, "")
		.replace(/\s*;\s*/g, "; ")
		.replace(/\s+/g, " ")
		.trim();

	if (!candidate || !candidate.includes("=")) return undefined;
	return candidate;
}

function isShortcutKey(data: string): boolean {
	return data === KAKU_SHORTCUT_SEQUENCE || matchesKey(data, SHORTCUT);
}

function isShortcutKeyPress(data: string): boolean {
	return isShortcutKey(data) && !isKeyRelease(data) && !isKeyRepeat(data);
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

export default function (pi: ExtensionAPI) {
	let overlayOpen = false;
	// Closes the full-screen overlay (resolves its custom() promise). Set while the
	// overlay is open so a second ⌘⇧M press can toggle it shut.
	let closeOverlay: (() => void) | undefined;
	let debugKeysUntil = 0;
	let cleanupInput: (() => void) | undefined;
	let cleanupState: (() => void) | undefined;
	const repinTimers = new Set<ReturnType<typeof setTimeout>>();

	// Register (or re-register) the pinned now-playing bar. Re-registering moves the
	// widget to the end of pi's "aboveEditor" map, so it renders closest to the input.
	function pinNowPlaying(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new NowPlayingBar(tui, theme), { placement: "aboveEditor" });
	}

	// Re-pin in two phases so the now-playing bar always settles at the END of pi's
	// aboveEditor map (closest to the input).
	//
	//  • The 0ms macrotask runs AFTER the current event dispatch settles — i.e. after
	//    any other extension's *synchronous* setWidget (the todo overlay appends its
	//    widget during the same dispatch). A macrotask is used rather than
	//    queueMicrotask because inter-extension handler order is not guaranteed.
	//  • The trailing 150ms re-pin catches *asynchronous* widget churn: both a theme
	//    switch (mac-system-theme flips light/dark via setTheme) and terminal
	//    cell-size responses call ui.invalidate(), which recursively invalidates the
	//    todo overlay and trips its internal "registered" flag — so the overlay's
	//    NEXT update() re-appends itself BELOW us. The second pass moves us back down.
	//
	// Debounced together so a burst of events collapses into one pair of re-pins.
	function schedulePin(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		for (const t of repinTimers) clearTimeout(t);
		repinTimers.clear();
		for (const delay of [0, 150]) {
			const timer = setTimeout(() => {
				repinTimers.delete(timer);
				try {
					pinNowPlaying(ctx);
				} catch {}
			}, delay);
			repinTimers.add(timer);
		}
	}

	const deps: FullscreenDeps = {
		loadPlaylists: getLibraryPlaylists,
		loadTracks: getPlaylistTracks,
		getState: () => engine.getState(),
		onStateChange: (cb) => engine.onState(cb),
		onPlay: (tracks, index) => engine.play(tracks, index),
		onTogglePlay: () => engine.togglePlay(),
		onNext: () => engine.next(),
		onPrev: () => engine.prev(),
		onLike: (videoId, like) => (like ? likeTrack(videoId) : removeLike(videoId)),
	};

	async function openFullscreen(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("YouTube Music needs the interactive UI", "warning");
			return;
		}
		if (overlayOpen) return;
		overlayOpen = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					// Capture done() so the ⌘⇧M toggle (handled in onTerminalInput) can close
					// this overlay from outside, mirroring the view's own Esc/q close.
					closeOverlay = () => done();
					return new FullscreenView(tui, theme, deps, () => done());
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "88%", minWidth: 60, maxHeight: "90%", margin: 1 },
					onHandle: (handle) => handle.focus(),
				},
			);
		} finally {
			overlayOpen = false;
			closeOverlay = undefined;
		}
	}

	// ⌘⇧M toggles the full screen: open when closed, close when already open.
	function toggleFullscreen(ctx: ExtensionContext): void {
		if (overlayOpen) {
			closeOverlay?.();
			return;
		}
		void openFullscreen(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		cleanupInput?.();
		cleanupInput = undefined;
		cleanupState?.();
		cleanupState = undefined;

		// Pinned now-playing bar above the editor. Re-attached for every session.
		// Pin immediately for first-frame display, then re-pin after the event dispatch
		// settles so we sit below any widget the todo overlay registers in its own
		// session_start handler (whichever extension's handler runs first).
		pinNowPlaying(ctx);
		schedulePin(ctx);

		// Re-pin when the *track* or play/pause state changes (ignoring the 1s progress
		// ticks) so playback transitions re-assert our slot at the bottom of the stack,
		// healing any displacement that happened while idle (e.g. a theme switch that
		// silently let the todo overlay re-append itself below us between turns).
		let lastTrack = engine.getState().track?.videoId;
		let lastPlaying = engine.getState().isPlaying;
		cleanupState = engine.onState(() => {
			const s = engine.getState();
			if (s.track?.videoId === lastTrack && s.isPlaying === lastPlaying) return;
			lastTrack = s.track?.videoId;
			lastPlaying = s.isPlaying;
			schedulePin(ctx);
		});

		// Kaku/WezTerm does not forward arbitrary Command+Shift letter keys unless
		// the terminal config maps them to an escape sequence. Match the explicit
		// Kaku sequence plus Pi's normal Key.superShift("m") parsing, mirroring the
		// diff-review/session switcher raw-input safety net.
		cleanupInput = ctx.ui.onTerminalInput((data) => {
			if (Date.now() <= debugKeysUntil) {
				ctx.ui.notify(`ytm key: ${describeKeyInput(data)}`, isShortcutKey(data) ? "info" : "warning");
			}
			if (isShortcutKey(data)) {
				// Toggle: opens the overlay, or closes it if a press arrives while open.
				// onTerminalInput runs before the focused overlay and consumes the key,
				// so this is the single source of truth for ⌘⇧M in both states.
				if (isShortcutKeyPress(data)) toggleFullscreen(ctx);
				return { consume: true };
			}
			return undefined;
		});
	});

	// Keep the now-playing bar pinned directly above the input. The todo overlay
	// (rpiv-todo) registers its widget when the `todo` tool runs and on session
	// compact/tree; re-pinning afterwards moves our bar back to the bottom of the
	// aboveEditor stack so the todo list shows above it without conflict.
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === TODO_WIDGET_TOOL && !event.isError) schedulePin(ctx);
	});
	pi.on("session_compact", (_event, ctx) => schedulePin(ctx));
	pi.on("session_tree", (_event, ctx) => schedulePin(ctx));
	// Turn/agent boundaries are natural settle points. Re-pinning here guarantees the
	// at-rest state the user sees (between turns) is correct: after any turn that
	// created, completed, or hid todos — each of which re-appends the todo widget —
	// the now-playing bar is restored to the bottom, directly above the input.
	pi.on("agent_start", (_event, ctx) => schedulePin(ctx));
	pi.on("agent_end", (_event, ctx) => schedulePin(ctx));
	pi.on("turn_end", (_event, ctx) => schedulePin(ctx));

	pi.on("session_shutdown", (event, ctx) => {
		cleanupInput?.();
		cleanupInput = undefined;
		cleanupState?.();
		cleanupState = undefined;
		for (const t of repinTimers) clearTimeout(t);
		repinTimers.clear();
		// Keep playback alive across /new, /resume, /fork, /reload, and UI clears.
		// Only a real pi quit or explicit /ytm stop tears down mpv + the daemon.
		if (event.reason !== "quit") return;
		engine.shutdown();
		try { ctx.ui.setWidget(WIDGET_KEY, undefined); } catch {}
	});

	// ⌘⇧M toggles the full-screen view open/closed (super = Command on macOS).
	pi.registerShortcut(SHORTCUT, {
		description: "Toggle YouTube Music (full screen)",
		handler: (ctx) => toggleFullscreen(ctx),
	});

	// Reliable entry point that works in every terminal.
	pi.registerCommand("ytm", {
		description: `YouTube Music: open the full-screen player (${SHORTCUT_LABEL})`,
		handler: async (args, ctx) => {
			const sub = args.trim();
			const lower = sub.toLowerCase();
			if (lower === "next") return void engine.next();
			if (lower === "prev") return void engine.prev();
			if (lower === "pause" || lower === "play") return void engine.togglePlay();
			if (lower === "stop" || lower === "shutdown") {
				engine.shutdown();
				ctx.ui.notify("YouTube Music stopped", "info");
				return;
			}
			if (lower === DEBUG_KEYS_ARG) {
				debugKeysUntil = Date.now() + 10_000;
				ctx.ui.notify(`YouTube Music key debug enabled for 10s. Press ${SHORTCUT_LABEL} now.`, "info");
				return;
			}
			if (lower === "auth") return void (await refreshAuth(ctx));
			if (lower === "status" || lower === "doctor") {
				ctx.ui.notify(engine.getDiagnostics(), engine.getError() ? "warning" : "info");
				return;
			}
			if (lower === "login" || lower === "cookie") return void (await promptManualCookie(ctx));
			if (lower === "logout" || lower === "login clear" || lower === "cookie clear") return void clearManualCookie(ctx);
			if (lower.startsWith("account")) {
				const email = sub.slice("account".length).trim();
				const cfg = loadConfig();
				if (!email) {
					ctx.ui.notify(`Target account: ${cfg.account ?? "(auto — first logged-in profile)"}`, "info");
					return;
				}
				if (email.toLowerCase() === "auto" || email.toLowerCase() === "clear") {
					saveConfig({ ...cfg, account: undefined, browserProfile: "auto" });
					await refreshAuth(ctx);
					return;
				}
				// Switch target account: set filter, unpin profile, force re-auth.
				saveConfig({ ...cfg, account: email, browserProfile: "auto" });
				const c = await getClient(true);
				ctx.ui.notify(
					c ? `Switched to ${email} (${c.source})` : (getAuthError() ?? `Could not find ${email}`),
					c ? "info" : "warning",
				);
				return;
			}
			await openFullscreen(ctx);
		},
	});
}
