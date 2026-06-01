// twitter-statusline — an always-on, rotating "hot tweet" preview shown directly
// above the diff-review footer (belowEditor widget). Press ↓ from an empty input
// to focus it; Tab chooses View / All; ←/→ browse tweets; Enter opens the detail
// or full-screen browser overlay. The focus chain is input → Twitter → diff footer.
//
// Data comes from the `twitter` CLI, reusing the Chrome login the onboard
// twitter-feed skill relies on. All network work is cached and best-effort: the
// statusline never throws into the session.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorComponent,
	Key,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import { type BrowserResult, TwitterBrowserOverlay } from "./browser.ts";
import { publishTwitterChain } from "./chain.ts";
import { TweetDetailOverlay } from "./detail.ts";
import { TwitterPreview } from "./preview.ts";
import {
	fetchHotFeed,
	isStale,
	loadCache,
	saveCache,
	type Tweet,
} from "./twitter-cli.ts";

const WIDGET_KEY = "twitter-statusline";
const ROTATE_MS = 30_000;
const REFRESH_MS = 30_000;
const DEFAULT_X_CHROME_APP_ID = "lodlkdfmihgonocnmddehnfgiljnadcf";
const CHROME_BUNDLE_ID = "com.google.Chrome";
const X_APP_BUNDLE_PREFIX = "com.google.Chrome.app.";

interface Store {
	tweets: Tweet[];
	index: number;
	fetchedMs: number;
	loading: boolean;
	lastError: string | undefined;
}

export default function twitterStatusline(pi: ExtensionAPI) {
	const store: Store = {
		tweets: [],
		index: 0,
		fetchedMs: 0,
		loading: false,
		lastError: undefined,
	};

	let preview: TwitterPreview | undefined;
	let tuiRef: TUI | undefined;
	let editorRef: EditorComponent | undefined;
	let rotateTimer: ReturnType<typeof setInterval> | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let overlayBusy = false;

	// --- data ----------------------------------------------------------------

	function currentTweet(): Tweet | undefined {
		return store.tweets[store.index];
	}

	function tweetUrl(tweet: Tweet): string {
		const screenName = tweet.author.screenName.trim().replace(/^@+/, "");
		if (screenName) {
			return `https://x.com/${encodeURIComponent(screenName)}/status/${encodeURIComponent(tweet.id)}`;
		}
		return `https://x.com/i/web/status/${encodeURIComponent(tweet.id)}`;
	}

	function xChromeAppId(): string {
		return (
			process.env.TWITTER_STATUSLINE_X_APP_ID?.trim() || DEFAULT_X_CHROME_APP_ID
		);
	}

	function chromeProfileForApp(appId: string): string {
		const configured = process.env.TWITTER_STATUSLINE_CHROME_PROFILE?.trim();
		if (configured) return configured;
		const chromeDir = path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"Google",
			"Chrome",
		);
		try {
			for (const name of readdirSync(chromeDir)) {
				const marker = path.join(
					chromeDir,
					name,
					"Web Applications",
					"Manifest Resources",
					appId,
				);
				if (existsSync(marker)) return name;
			}
		} catch {
			// Fall through to the common profile name.
		}
		return "Default";
	}

	function openWithLabel(label: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile("open", args, (error, _stdout, stderr) => {
				if (!error) {
					resolve();
					return;
				}
				const detail = stderr?.toString().trim() || error.message;
				reject(new Error(`${label}: ${detail}`));
			});
		});
	}

	function updateRunningXApp(url: string, appId: string): Promise<void> {
		const bundleId = `${X_APP_BUNDLE_PREFIX}${appId}`;
		const script = `
on run argv
	set targetUrl to item 1 of argv
	set targetBundleId to item 2 of argv
	tell application "System Events"
		set matchingProcesses to application processes whose bundle identifier is targetBundleId
		if (count of matchingProcesses) is 0 then return "missing"
	end tell
	tell application id targetBundleId to activate
	delay 0.18
	tell application "Google Chrome"
		if (count of windows) is 0 then return "missing"
		set URL of active tab of front window to targetUrl
	end tell
	tell application id targetBundleId to activate
	return "updated"
end run
`;
		return new Promise((resolve, reject) => {
			execFile(
				"osascript",
				["-e", script, url, bundleId],
				{ timeout: 5_000 },
				(error, stdout, stderr) => {
					if (error) {
						const detail = stderr?.toString().trim() || error.message;
						reject(new Error(`Existing X app: ${detail}`));
						return;
					}
					const result = stdout.toString().trim();
					if (result === "updated") {
						resolve();
						return;
					}
					reject(new Error("Existing X app: not running"));
				},
			);
		});
	}

	async function openTweetInXApp(tweet: Tweet): Promise<void> {
		const url = tweetUrl(tweet);
		const errors: string[] = [];
		const appId = xChromeAppId();
		const profile = chromeProfileForApp(appId);
		try {
			await updateRunningXApp(url, appId);
			return;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}

		const attempts: Array<{ label: string; args: string[] }> = [
			{
				label: "Chrome X PWA",
				args: [
					"-n",
					"-b",
					CHROME_BUNDLE_ID,
					"--args",
					`--profile-directory=${profile}`,
					`--app-id=${appId}`,
					`--app-launch-url-for-shortcuts-menu-item=${url}`,
				],
			},
			{
				label: "Chrome app window",
				args: [
					"-n",
					"-b",
					CHROME_BUNDLE_ID,
					"--args",
					`--profile-directory=${profile}`,
					`--app=${url}`,
				],
			},
			{
				label: "Google Chrome",
				args: ["-b", CHROME_BUNDLE_ID, url],
			},
		];
		for (const attempt of attempts) {
			try {
				await openWithLabel(attempt.label, attempt.args);
				return;
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		throw new Error(errors.join(" | ") || "no Chrome launch path available");
	}

	function moveTweet(delta: number): void {
		if (store.tweets.length === 0) return;
		store.index =
			(store.index + delta + store.tweets.length) % store.tweets.length;
	}

	async function refresh(force: boolean): Promise<boolean> {
		if (store.loading) return false;
		if (
			!force &&
			store.tweets.length > 0 &&
			Date.now() - store.fetchedMs < REFRESH_MS
		) {
			return false;
		}
		store.loading = true;
		preview?.requestRender();
		try {
			const tweets = await fetchHotFeed();
			if (tweets.length > 0) {
				store.tweets = tweets;
				store.fetchedMs = Date.now();
				store.lastError = undefined;
				if (store.index >= tweets.length) store.index = 0;
				saveCache({ tweets, fetchedMs: store.fetchedMs });
				return true;
			}
			if (store.tweets.length === 0) store.lastError = "empty feed";
			return false;
		} catch (error) {
			store.lastError = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			store.loading = false;
			preview?.requestRender();
		}
	}

	async function refreshForBrowser(): Promise<{
		tweets: Tweet[];
		refreshed: boolean;
		error: string | undefined;
	}> {
		const refreshed = await refresh(true);
		return { tweets: store.tweets, refreshed, error: store.lastError };
	}

	// --- overlays ------------------------------------------------------------

	async function openDetail(
		ctx: ExtensionContext,
		tweet: Tweet,
	): Promise<void> {
		try {
			await ctx.ui.custom<undefined>(
				(tui, theme, _kb, done) => {
					const overlay = new TweetDetailOverlay(
						tui,
						theme,
						tweet,
						() => done(undefined),
						openTweetInXApp,
					);
					overlay.setViewport(14);
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "72%",
						minWidth: 56,
						maxHeight: "82%",
						margin: 2,
					},
					onHandle: (handle) => handle.focus(),
				},
			);
		} finally {
			focusEditor();
		}
	}

	async function openBrowser(ctx: ExtensionContext): Promise<void> {
		if (overlayBusy) return;
		overlayBusy = true;
		try {
			// Loop so returning from a detail view re-opens the list (back-nav).
			for (;;) {
				const result = await ctx.ui.custom<BrowserResult>(
					(tui, theme, _kb, done) =>
						new TwitterBrowserOverlay(
							tui,
							theme,
							store.tweets,
							done,
							refreshForBrowser,
						),
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "86%",
							minWidth: 60,
							maxHeight: "88%",
							margin: 1,
						},
						onHandle: (handle) => handle.focus(),
					},
				);
				if (!result || result.type === "close") break;
				await openDetail(ctx, result.tweet);
			}
		} catch (error) {
			ctx.ui.notify(
				`Twitter browser failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			overlayBusy = false;
			focusEditor();
		}
	}

	function openDetailSafe(ctx: ExtensionContext, tweet: Tweet): void {
		if (overlayBusy) return;
		overlayBusy = true;
		void openDetail(ctx, tweet)
			.catch((error) =>
				ctx.ui.notify(
					`Tweet detail failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				),
			)
			.finally(() => {
				overlayBusy = false;
			});
	}

	// --- focus helpers -------------------------------------------------------

	function focusEditor(): void {
		if (tuiRef && editorRef) {
			tuiRef.setFocus(editorRef);
			tuiRef.requestRender();
		}
	}

	function isEditorFocused(): boolean {
		return (editorRef as { focused?: boolean } | undefined)?.focused === true;
	}

	// --- lifecycle -----------------------------------------------------------

	function stopTimers(): void {
		if (rotateTimer) clearInterval(rotateTimer);
		if (refreshTimer) clearInterval(refreshTimer);
		rotateTimer = undefined;
		refreshTimer = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Seed from cache so the preview has content immediately.
		const cache = loadCache();
		if (cache) {
			store.tweets = cache.tweets;
			store.fetchedMs = cache.fetchedMs;
			store.index = 0;
		}

		// belowEditor widget → renders between the input and the diff footer.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				preview = new TwitterPreview(tui, theme as Theme, {
					getCurrent: currentTweet,
					getPosition: () => ({
						index: store.index + 1,
						total: store.tweets.length,
					}),
					isStale: () =>
						isStale({ tweets: store.tweets, fetchedMs: store.fetchedMs }),
					isLoading: () => store.loading,
					lastError: () => store.lastError,
					onOpenDetail: (tweet) => openDetailSafe(ctx, tweet),
					onOpenBrowser: () => void openBrowser(ctx),
					onMoveTweet: moveTweet,
					focusEditor,
				});
				return preview;
			},
			{ placement: "belowEditor" },
		);

		// Capture the mounted editor instance (without altering behavior) so the
		// chain can return focus to it. We wrap the previous factory transparently.
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const base =
				previousFactory?.(tui, editorTheme, keybindings) ??
				new CustomEditor(tui, editorTheme, keybindings);
			editorRef = base;
			tuiRef = tui;
			return base;
		});

		// Raw input: ↓ from an empty, focused editor enters the Twitter preview.
		// diff-review yields this key to us when our chain handle is published.
		const unsubInput = ctx.ui.onTerminalInput((data) => {
			if (!preview || !editorRef) return undefined;
			if (
				matchesKey(data, Key.down) &&
				isEditorFocused() &&
				!preview.focused &&
				ctx.ui.getEditorText().trim().length === 0
			) {
				preview.focus();
				return { consume: true };
			}
			return undefined;
		});

		// Publish the chain handle so diff-review can hand focus to us.
		publishTwitterChain({
			focusPreview: () => preview?.focus(),
			isPreviewFocused: () => preview?.focused === true,
		});

		// Rotate every 30s (paused while focused so actions stay on a stable tweet).
		stopTimers();
		rotateTimer = setInterval(() => {
			if (store.tweets.length > 1 && !preview?.focused) {
				store.index = (store.index + 1) % store.tweets.length;
				preview?.requestRender();
			}
		}, ROTATE_MS);
		rotateTimer.unref?.();

		refreshTimer = setInterval(() => void refresh(false), REFRESH_MS);
		refreshTimer.unref?.();

		// Kick off an initial network refresh in the background.
		void refresh(true);

		pi.on("session_shutdown", () => {
			stopTimers();
			publishTwitterChain(undefined);
			unsubInput();
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				// UI may already be gone.
			}
			preview = undefined;
			editorRef = undefined;
			tuiRef = undefined;
		});
	});

	// --- commands ------------------------------------------------------------

	pi.registerCommand("twitter", {
		description: "Twitter statusline: focus preview, or `refresh` / `open`",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (!ctx.hasUI) {
				ctx.ui.notify("Twitter statusline needs the interactive UI", "warning");
				return;
			}
			if (sub === "refresh") {
				const ok = await refresh(true);
				ctx.ui.notify(
					ok
						? "Twitter feed refreshed"
						: `Twitter refresh failed${store.lastError ? `: ${store.lastError}` : ""}`,
					ok ? "info" : "error",
				);
				return;
			}
			if (sub === "open") {
				await openBrowser(ctx);
				return;
			}
			if (sub) {
				ctx.ui.notify(
					"Usage: /twitter, /twitter refresh, /twitter open",
					"error",
				);
				return;
			}
			if (preview) preview.focus();
			else ctx.ui.notify("Twitter preview is not active", "warning");
		},
	});
}
