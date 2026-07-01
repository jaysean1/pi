// twitter-statusline — an always-on, rotating "hot tweet" preview shown directly
// above the diff-review footer (belowEditor widget). Press ↓ from an empty input
// to focus it; Tab chooses View / All; ←/→ browse tweets; Enter opens the detail
// or full-screen browser overlay. The focus chain is input → Twitter → diff footer.
//
// Data comes from the `twitter` CLI, reusing the Chrome login the onboard
// twitter-feed skill relies on. All network work is cached and best-effort: the
// statusline never throws into the session.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
const CHROME_BUNDLE_ID = "com.google.Chrome";
const CHROME_SCRIPT_TIMEOUT_MS = 2_500;
const CHROME_OPEN_TIMEOUT_MS = 3_000;

// --- config --------------------------------------------------------------

interface TwitterStatuslineConfig {
	chromeProfile?: string;
}

let configCache: TwitterStatuslineConfig | undefined;

function loadConfig(): TwitterStatuslineConfig {
	if (configCache) return configCache;
	try {
		const configPath = path.join(__dirname, "config.json");
		const text = readFileSync(configPath, "utf8");
		configCache = JSON.parse(text) as TwitterStatuslineConfig;
	} catch {
		configCache = {};
	}
	return configCache;
}

interface Store {
	tweets: Tweet[];
	index: number;
	fetchedMs: number;
	loading: boolean;
	lastError: string | undefined;
}

interface ChromeTabTarget {
	windowId: string;
	tabId: string;
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
	let chromeTabTarget: ChromeTabTarget | undefined;

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

	function errorDetail(
		label: string,
		error: Error & { killed?: boolean; signal?: string | null },
		stderr: string | Buffer | undefined,
		timeoutMs: number,
	): Error {
		if (
			error.killed ||
			error.signal === "SIGTERM" ||
			error.signal === "SIGKILL"
		) {
			return new Error(`${label}: timed out after ${timeoutMs}ms`);
		}
		const detail = stderr?.toString().trim() || error.message;
		return new Error(`${label}: ${detail}`);
	}

	function runCommand(
		label: string,
		command: string,
		args: string[],
		timeoutMs: number,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const child = execFile(command, args, (error, stdout, stderr) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (!error) {
					resolve(stdout?.toString() ?? "");
					return;
				}
				reject(errorDetail(label, error, stderr, timeoutMs));
			});
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				reject(new Error(`${label}: timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		});
	}

	function openWithLabel(
		label: string,
		args: string[],
		timeoutMs = CHROME_OPEN_TIMEOUT_MS,
	): Promise<void> {
		return runCommand(label, "open", args, timeoutMs).then(() => undefined);
	}

	function runAppleScript(
		label: string,
		script: string,
		args: string[],
		timeoutMs = CHROME_SCRIPT_TIMEOUT_MS,
	): Promise<string> {
		return runCommand(label, "osascript", ["-e", script, ...args], timeoutMs);
	}

	function parseChromeTabTarget(stdout: string): ChromeTabTarget | undefined {
		const line = stdout
			.split(/\r?\n/)
			.find((entry) => entry.startsWith("PI_TWITTER_TAB\t"));
		if (!line) return undefined;
		const [, windowId, tabId] = line.split("\t");
		if (!windowId || !tabId) return undefined;
		return { windowId, tabId };
	}

	// Open the tweet in a visible Chrome tab. We first reuse the tab previously
	// opened by this extension. If that tab was lost (or pi was reloaded), we scan
	// all Chrome windows for an existing x.com/twitter.com tab and reuse it. Only
	// when no Twitter tab exists do we create a new tab in the front Chrome window.
	function openTweetInChromeTab(
		url: string,
		tweetId: string,
		previous: ChromeTabTarget | undefined,
		profileDir: string | undefined,
	): Promise<ChromeTabTarget> {
		const script = `on run argv
  set tweetURL to item 1 of argv
  set expectedTweetId to item 2 of argv
  set expectedWindowId to item 3 of argv
  set expectedTabId to item 4 of argv
  set profileDir to item 5 of argv
  set sep to ASCII character 9
  tell application "Google Chrome"
    activate
    if (count of windows) is 0 then make new window

    set targetWindow to missing value
    set targetTab to missing value

    if expectedWindowId is not "" and expectedTabId is not "" then
      repeat with w in windows
        if ((id of w) as text) is expectedWindowId then
          repeat with t in tabs of w
            if ((id of t) as text) is expectedTabId then
              set targetWindow to w
              set targetTab to t
              exit repeat
            end if
          end repeat
        end if
        if targetTab is not missing value then exit repeat
      end repeat
    end if

    if targetTab is missing value then
      if profileDir is not "" then
        -- Skip scanning all windows; open directly in the configured profile.
        do shell script "open -a 'Google Chrome' --args --profile-directory=" & quoted form of profileDir & " " & quoted form of tweetURL
        delay 0.5
        repeat with w in windows
          set ti to 0
          repeat with t in tabs of w
            set ti to ti + 1
            try
              set u to URL of t
            on error
              set u to ""
            end try
            if u is tweetURL then
              set targetWindow to w
              set targetTab to t
              set active tab index of w to ti
              exit repeat
            end if
          end repeat
          if targetTab is not missing value then exit repeat
        end repeat
      else
        -- Fallback: scan all windows for any Twitter tab (original behavior).
        repeat with w in windows
          set ti to 0
          repeat with t in tabs of w
            set ti to ti + 1
            try
              set u to URL of t
            on error
              set u to ""
            end try
            if u contains "x.com/" or u contains "twitter.com/" then
              set targetWindow to w
              set targetTab to t
              set active tab index of w to ti
              exit repeat
            end if
          end repeat
          if targetTab is not missing value then exit repeat
        end repeat
      end if
    end if

    if targetTab is missing value then
      set targetWindow to front window
      tell targetWindow
        make new tab with properties {URL:tweetURL}
        set active tab index to (count of tabs)
        set targetTab to active tab
      end tell
    else
      set URL of targetTab to tweetURL
      set ti to 0
      repeat with t in tabs of targetWindow
        set ti to ti + 1
        if ((id of t) as text) is ((id of targetTab) as text) then
          set active tab index of targetWindow to ti
          exit repeat
        end if
      end repeat
    end if

    set minimized of targetWindow to false
    set visible of targetWindow to true
    set index of targetWindow to 1
    activate

    return "PI_TWITTER_TAB" & sep & ((id of targetWindow) as text) & sep & ((id of targetTab) as text) & sep & (URL of targetTab)
  end tell
end run`;
		return runAppleScript("Chrome tab", script, [
			url,
			tweetId,
			previous?.windowId ?? "",
			previous?.tabId ?? "",
			profileDir ?? "",
		]).then((stdout) => {
			const target = parseChromeTabTarget(stdout);
			if (!target) {
				throw new Error("Chrome tab: missing target tab in AppleScript result");
			}
			return target;
		});
	}

	async function openTweetInChrome(tweet: Tweet): Promise<void> {
		const url = tweetUrl(tweet);
		const errors: string[] = [];

		// Primary: a normal Chrome tab that we control and navigate in place. The
		// X.app PWA route was rejected on purpose: Chrome PWA windows cannot be
		// navigated in place (no scriptable URL, and x.com's launch_handler opens a
		// new app window per launch), so a reusable browser tab is the only way to
		// update the same surface on every Enter.
		try {
			chromeTabTarget = await openTweetInChromeTab(
				url,
				tweet.id,
				chromeTabTarget,
				loadConfig().chromeProfile,
			);
			return;
		} catch (error) {
			chromeTabTarget = undefined;
			errors.push(error instanceof Error ? error.message : String(error));
		}

		// Fallback 1: force Chrome to open the exact URL. This may create a normal
		// tab, so it only runs when the reusable-tab AppleScript path failed.
		try {
			await openWithLabel("Google Chrome URL", ["-b", CHROME_BUNDLE_ID, url]);
			return;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}

		// Fallback 2: bundle id lookup can fail on unusual installs; app name is less
		// precise but often succeeds for a manually installed Chrome.app.
		try {
			await openWithLabel("Google Chrome app URL", [
				"-a",
				"Google Chrome",
				url,
			]);
			return;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
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
				(tui, theme, _kb, done) =>
					new TweetDetailOverlay(
						tui,
						theme,
						tweet,
						() => done(undefined),
						openTweetInChrome,
					),
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
					onHandle: (handle) => handle.focus(),
				},
			);
		} finally {
			focusEditor();
		}
	}

	async function openBrowser(ctx: ExtensionContext): Promise<void> {
		getFocusedEditor();
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
							anchor: "top-left",
							width: "100%",
							maxHeight: "100%",
							margin: 0,
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

	type FocusableEditorComponent = EditorComponent & { focused?: boolean };

	function isEditorComponentLike(value: unknown): value is EditorComponent {
		if (!value || typeof value !== "object") return false;
		const probe = value as {
			getText?: unknown;
			setText?: unknown;
			handleInput?: unknown;
		};
		return (
			typeof probe.getText === "function" &&
			typeof probe.setText === "function" &&
			typeof probe.handleInput === "function"
		);
	}

	function getFocusedComponent(): unknown {
		// TUI keeps the focused component as an internal field. We only read it as a
		// fallback because another extension (for example prompt-suggester's ghost
		// editor) may replace the editor after our transparent wrapper was installed.
		return (tuiRef as unknown as { focusedComponent?: unknown } | undefined)
			?.focusedComponent;
	}

	function getFocusedEditor(): EditorComponent | undefined {
		const focused = getFocusedComponent();
		if (isEditorComponentLike(focused)) {
			editorRef = focused;
			return focused;
		}
		if ((editorRef as FocusableEditorComponent | undefined)?.focused === true) {
			return editorRef;
		}
		return undefined;
	}

	function focusEditor(): void {
		if (tuiRef && editorRef) {
			tuiRef.setFocus(editorRef);
			tuiRef.requestRender();
		}
	}

	function focusPreview(): void {
		// Capture the currently focused editor before moving focus away so ↑/Esc can
		// return to it even when the editor came from a later-loaded extension.
		getFocusedEditor();
		preview?.focus();
	}

	function isEditorFocused(): boolean {
		return getFocusedEditor() !== undefined;
	}

	// Some extensions wrap the editor; walk the `.base` chain so completion
	// menus keep ownership of ↑/↓ while autocomplete is open.
	function isEditorAutocompleteOpen(): boolean {
		let node: unknown = getFocusedEditor() ?? editorRef;
		const seen = new Set<unknown>();

		for (let depth = 0; node && depth < 10 && !seen.has(node); depth++) {
			seen.add(node);
			const probe = node as {
				isShowingAutocomplete?: () => boolean;
				base?: unknown;
			};
			if (
				typeof probe.isShowingAutocomplete === "function" &&
				probe.isShowingAutocomplete() === true
			) {
				return true;
			}
			node = probe.base;
		}
		return false;
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
			if (!preview) return undefined;
			if (
				matchesKey(data, Key.down) &&
				isEditorFocused() &&
				!preview.focused &&
				!isEditorAutocompleteOpen() &&
				ctx.ui.getEditorText().trim().length === 0
			) {
				focusPreview();
				return { consume: true };
			}
			return undefined;
		});

		// Publish the chain handle so diff-review can hand focus to us.
		publishTwitterChain({
			focusPreview,
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
			if (preview) focusPreview();
			else ctx.ui.notify("Twitter preview is not active", "warning");
		},
	});
}
