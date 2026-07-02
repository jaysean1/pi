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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-claude-usage";
const REFRESH_MS = 60_000;
const CODEX_TAIL_BYTES = 512 * 1024;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const PI_AUTH_PATH = path.join(PI_AGENT_DIR, "auth.json");
// The OAuth /usage endpoint is aggressively rate-limited (429 with no real
// retry-after). Poll it hourly; manual /usage can force a refresh.
const OAUTH_MIN_INTERVAL_MS = 60 * 60 * 1000;
const OAUTH_MAX_BACKOFF_MS = 60 * 60 * 1000;

interface Window {
	/** Used percentage, 0-100. */
	pct: number;
	/** Epoch milliseconds when this window resets, or NaN if unknown. */
	resetMs: number;
}

interface Usage {
	fiveHour?: Window;
	sevenDay?: Window;
	stale?: boolean;
	source?: string;
	updatedMs?: number;
}

// ---------------------------------------------------------------------------
// Codex: read the most recent rollout file and pull the last rate_limits block
// ---------------------------------------------------------------------------

function readTail(filePath: string, maxBytes: number): string {
	const fd = fs.openSync(filePath, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const len = Math.min(size, maxBytes);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, size - len);
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function latestRolloutInDir(dir: string): string | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const files = entries.filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl")).sort();
	const last = files.at(-1);
	return last ? path.join(dir, last) : undefined;
}

function latestRolloutUnderSessions(root: string): string | undefined {
	let cur = root;
	// Descend year -> month -> day, always taking the lexicographically newest dir.
	for (let level = 0; level < 3; level++) {
		let dirs: string[];
		try {
			dirs = fs
				.readdirSync(cur, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort();
		} catch {
			return undefined;
		}
		const next = dirs.at(-1);
		if (!next) return undefined;
		cur = path.join(cur, next);
	}
	return latestRolloutInDir(cur);
}

export function latestCodexRollout(): string | undefined {
	const base = path.join(os.homedir(), ".codex");
	const candidates = [
		latestRolloutUnderSessions(path.join(base, "sessions")),
		latestRolloutInDir(path.join(base, "archived_sessions")),
	].filter((f): f is string => Boolean(f));

	let best: string | undefined;
	let bestMtime = -1;
	for (const file of candidates) {
		try {
			const mtime = fs.statSync(file).mtimeMs;
			if (mtime > bestMtime) {
				bestMtime = mtime;
				best = file;
			}
		} catch {
			// ignore unreadable candidate
		}
	}
	return best;
}

function toWindow(raw: unknown): Window | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as { used_percent?: unknown; resets_at?: unknown };
	if (typeof r.used_percent !== "number") return undefined;
	const resetSec = typeof r.resets_at === "number" ? r.resets_at : NaN;
	return { pct: r.used_percent, resetMs: resetSec * 1000 };
}

export function readCodexUsage(): Usage | undefined {
	const file = latestCodexRollout();
	if (!file) return undefined;

	let text: string;
	try {
		text = readTail(file, CODEX_TAIL_BYTES);
	} catch {
		return undefined;
	}

	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (!line || !line.includes("rate_limits")) continue;
		let entry: { payload?: { rate_limits?: { primary?: unknown; secondary?: unknown } } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const rl = entry.payload?.rate_limits;
		if (!rl) continue;
		const fiveHour = toWindow(rl.primary);
		if (!fiveHour) continue;
		return { fiveHour, sevenDay: toWindow(rl.secondary) };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Claude: query Anthropic OAuth usage endpoint directly
// ---------------------------------------------------------------------------

function toEpochMs(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw > 1_000_000_000_000 ? raw : raw * 1000;
	}
	if (typeof raw !== "string" || !raw.trim()) return NaN;
	const numeric = Number(raw);
	if (Number.isFinite(numeric)) return toEpochMs(numeric);
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function toClaudeWindow(raw: unknown): Window | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as {
		resets_at?: unknown;
		used_percentage?: unknown;
		utilization?: unknown;
	};
	const pct = typeof r.used_percentage === "number" ? r.used_percentage : r.utilization;
	if (typeof pct !== "number") return undefined;
	return { pct, resetMs: toEpochMs(r.resets_at) };
}

async function readClaudeToken(ctx?: ExtensionContext): Promise<string | undefined> {
	try {
		const storage = ctx?.modelRegistry.authStorage ?? AuthStorage.create(PI_AUTH_PATH);
		return await storage.getApiKey("anthropic");
	} catch {
		return undefined;
	}
}

interface FetchResult {
	usage?: Usage;
	rateLimited?: boolean;
}

export async function fetchClaudeUsage(ctx?: ExtensionContext): Promise<FetchResult> {
	const token = await readClaudeToken(ctx);
	if (!token) return {};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(CLAUDE_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
			},
			signal: controller.signal,
		});
		if (res.status === 429) return { rateLimited: true };
		if (res.status === 401 || res.status === 403) return {};
		if (!res.ok) return {};
		const data = (await res.json()) as {
			five_hour?: { utilization?: number; resets_at?: string };
			seven_day?: { utilization?: number; resets_at?: string };
		};
		const fiveHour = toClaudeWindow(data.five_hour);
		const sevenDay = toClaudeWindow(data.seven_day);
		if (!fiveHour && !sevenDay) return {};
		return {
			usage: { fiveHour, sevenDay, source: "oauth", stale: false, updatedMs: Date.now() },
		};
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatReset(resetMs: number): string {
	if (!Number.isFinite(resetMs)) return "?";
	let secs = Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
	const days = Math.floor(secs / 86_400);
	secs -= days * 86_400;
	const hours = Math.floor(secs / 3600);
	secs -= hours * 3600;
	const mins = Math.floor(secs / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
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

function paintWindow(theme: Theme, label: string, win: Window): string {
	const dim = (s: string) => theme.fg("dim", s);
	return `${dim(`${label}:`)} ${paintPercent(theme, win.pct)} ${dim(`(${formatReset(win.resetMs)})`)}`;
}

function paintTool(theme: Theme, name: string, usage: Usage | undefined): string {
	const dim = (s: string) => theme.fg("dim", s);
	const stale = usage?.stale ? ` ${dim("(stale)")}` : "";
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

	async function refresh(ctx: ExtensionContext, forceClaude = false): Promise<void> {
		if (!ctx.hasUI || inFlight) return;
		inFlight = true;
		try {
			let codex: Usage | undefined;
			try {
				codex = readCodexUsage();
			} catch {
				codex = undefined;
			}
			if (codex) lastCodex = codex;
			render(ctx);

			const claude = await refreshClaudeViaOAuth(ctx, forceClaude);
			if (claude) {
				lastClaude = claude;
				render(ctx);
			}
		} catch {
			// never let the statusline crash the session
		} finally {
			inFlight = false;
		}
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
			await refresh(ctx, true);
			ctx.ui.notify("Usage statusline refreshed", "info");
		},
	});
}
