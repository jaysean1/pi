// Bottom statusline widget that shows Codex and Claude Code usage limits.
//
// For each tool it renders the 5-hour and 7-day rate-limit windows as a used
// percentage plus a countdown to the next reset, e.g.
//   Codex | 5h: 2% (15h) | 7d: 11% (6d) · Claude | 5h: 0% (1h40m) | 7d: 4% (4d11h)
//
// Data sources:
//   Codex  - latest ~/.codex/sessions rollout file, last token_count.rate_limits
//   Claude - Anthropic OAuth usage endpoint, authenticated via Pi's auth.json
//
// Manual refresh: /usage

import os from "node:os";
import path from "node:path";
import { AuthStorage, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	fetchClaudeUsageWithToken,
	formatReset,
	readClaudeUsageCache,
	readCodexUsage,
	writeClaudeUsageCache,
	type FetchResult,
	type Usage,
	type UsageWindow,
} from "./usage-core.ts";

export { formatReset, latestCodexRollout, parseClaudeUsageResponse, readCodexUsage } from "./usage-core.ts";

const STATUS_KEY = "codex-claude-usage";
const REFRESH_MS = 60_000;
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const PI_AUTH_PATH = path.join(PI_AGENT_DIR, "auth.json");
const CLAUDE_CACHE_PATH = path.join(path.dirname(PI_AGENT_DIR), "cache", "claude-usage.json");
// The OAuth /usage endpoint is aggressively rate-limited (429 with no real
// retry-after). Poll it hourly; manual /usage can force a refresh.
const OAUTH_MIN_INTERVAL_MS = 60 * 60 * 1000;
const OAUTH_MAX_BACKOFF_MS = 60 * 60 * 1000;
const CLAUDE_CACHE_STALE_MS = 75 * 60 * 1000;

// ---------------------------------------------------------------------------
// Claude: query Anthropic OAuth usage endpoint directly
// ---------------------------------------------------------------------------

async function readClaudeToken(ctx?: ExtensionContext): Promise<string | undefined> {
	try {
		const storage = ctx?.modelRegistry.authStorage ?? AuthStorage.create(PI_AUTH_PATH);
		return await storage.getApiKey("anthropic");
	} catch {
		return undefined;
	}
}

export async function fetchClaudeUsage(ctx?: ExtensionContext): Promise<FetchResult> {
	const token = await readClaudeToken(ctx);
	if (!token) return { failure: "unauthorised" };
	return fetchClaudeUsageWithToken(token);
}

let oauthNextAllowedMs = 0;
let oauthBackoffMs = OAUTH_MIN_INTERVAL_MS;

// Gate + back off the rate-limited endpoint. ponytail: in-memory gate, fine for
// one statusline process; persist to disk if multiple processes start sharing.
export async function refreshClaudeViaOAuth(ctx: ExtensionContext, force = false): Promise<Usage | undefined> {
	if (!force && Date.now() < oauthNextAllowedMs) return undefined;
	const result = await fetchClaudeUsage(ctx);
	if (result.usage) {
		oauthBackoffMs = OAUTH_MIN_INTERVAL_MS;
		oauthNextAllowedMs = Date.now() + OAUTH_MIN_INTERVAL_MS;
		return result.usage;
	}
	// 429 or any miss: wait at least the min interval; double up to the cap on 429.
	if (result.rateLimited) oauthBackoffMs = Math.min(oauthBackoffMs * 2, OAUTH_MAX_BACKOFF_MS);
	oauthNextAllowedMs = Date.now() + (result.rateLimited ? oauthBackoffMs : OAUTH_MIN_INTERVAL_MS);
	return undefined;
}

function paintPercent(theme: Theme, pct: number): string {
	const colour = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
	return theme.fg(colour, `${Math.round(pct)}%`);
}

function paintSeparator(theme: Theme): string {
	return theme.fg("dim", " | ");
}

function paintToolSeparator(theme: Theme): string {
	return theme.fg("dim", " · ");
}

function paintWindow(theme: Theme, label: string, win: UsageWindow): string {
	const dim = (s: string) => theme.fg("dim", s);
	return `${dim(`${label}:`)} ${paintPercent(theme, win.pct)} ${dim(`(${formatReset(win.resetMs)})`)}`;
}

function paintTool(theme: Theme, name: string, usage: Usage | undefined): string {
	const dim = (s: string) => theme.fg("dim", s);
	const cacheExpired = usage?.updatedMs !== undefined && Date.now() - usage.updatedMs > CLAUDE_CACHE_STALE_MS;
	const stale = usage?.stale || cacheExpired ? ` ${dim("(stale)")}` : "";
	const head = `${theme.bold(theme.fg("accent", name))}${stale}`;
	if (!usage || (!usage.fiveHour && !usage.sevenDay)) {
		return [head, dim("—")].join(paintSeparator(theme));
	}
	const parts = [head];
	if (usage.fiveHour) parts.push(paintWindow(theme, "5h", usage.fiveHour));
	if (usage.sevenDay) parts.push(paintWindow(theme, "7d", usage.sevenDay));
	return parts.join(paintSeparator(theme));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;
	let lastCodex: Usage | undefined;
	let lastClaude: Usage | undefined;
	let activeCtx: ExtensionContext | undefined;

	function render(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const line = [
			paintTool(theme, "Codex", lastCodex),
			paintTool(theme, "Claude", lastClaude),
		].join(paintToolSeparator(theme));
		ctx.ui.setStatus(STATUS_KEY, line);
	}

	async function refresh(ctx: ExtensionContext, forceClaude = false): Promise<boolean> {
		if (!ctx.hasUI || inFlight) return false;
		inFlight = true;
		let claudeUpdated = false;
		try {
			let codex: Usage | undefined;
			try {
				codex = readCodexUsage();
			} catch {
				codex = undefined;
			}
			if (codex) lastCodex = codex;

			// Render the last successful response immediately. This prevents a blank
			// Claude status on startup, reload, 429, auth refresh, or network failure.
			if (!lastClaude) {
				lastClaude = readClaudeUsageCache(CLAUDE_CACHE_PATH, CLAUDE_CACHE_STALE_MS);
			}
			render(ctx);

			const claude = await refreshClaudeViaOAuth(ctx, forceClaude);
			if (claude) {
				lastClaude = claude;
				writeClaudeUsageCache(CLAUDE_CACHE_PATH, claude);
				claudeUpdated = true;
				render(ctx);
			}
		} catch {
			// Never let the statusline crash the session. The last good value remains visible.
		} finally {
			inFlight = false;
		}
		return claudeUpdated;
	}

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		stopTimer();
		activeCtx = ctx;
		void refresh(ctx);
		timer = setInterval(() => {
			if (activeCtx) void refresh(activeCtx);
		}, REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		activeCtx = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// ui may already be gone
		}
	});

	pi.registerCommand("usage", {
		description: "Refresh the Codex / Claude usage statusline",
		handler: async (_args, ctx) => {
			const updated = await refresh(ctx, true);
			if (updated) {
				ctx.ui.notify("Usage statusline refreshed", "info");
			} else if (lastClaude) {
				ctx.ui.notify("Claude refresh failed; showing the last successful value", "warning");
			} else {
				ctx.ui.notify("Claude usage is unavailable", "warning");
			}
		},
	});
}
