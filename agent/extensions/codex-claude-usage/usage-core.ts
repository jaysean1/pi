import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_TAIL_BYTES = 512 * 1024;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageWindow {
	/** Used percentage, 0-100. */
	pct: number;
	/** Epoch milliseconds when this window resets, or NaN if unknown. */
	resetMs: number;
}

export interface Usage {
	fiveHour?: UsageWindow;
	sevenDay?: UsageWindow;
	stale?: boolean;
	source?: string;
	updatedMs?: number;
}

export interface FetchResult {
	usage?: Usage;
	rateLimited?: boolean;
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

function toCodexWindow(raw: unknown): UsageWindow | undefined {
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
		const fiveHour = toCodexWindow(rl.primary);
		if (!fiveHour) continue;
		return { fiveHour, sevenDay: toCodexWindow(rl.secondary) };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Claude: parse/fetch Anthropic OAuth usage data
// ---------------------------------------------------------------------------

export function toEpochMs(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw > 1_000_000_000_000 ? raw : raw * 1000;
	}
	if (typeof raw !== "string" || !raw.trim()) return NaN;
	const numeric = Number(raw);
	if (Number.isFinite(numeric)) return toEpochMs(numeric);
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function firstEpochMs(...values: unknown[]): number {
	for (const value of values) {
		const parsed = toEpochMs(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return NaN;
}

function toClaudeWindow(raw: unknown, fallbackResetMs = NaN): UsageWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as {
		resets_at?: unknown;
		reset_at?: unknown;
		reset_time?: unknown;
		used_percentage?: unknown;
		utilization?: unknown;
		percent?: unknown;
		used_percent?: unknown;
	};
	const pct = firstNumber(r.used_percentage, r.utilization, r.percent, r.used_percent);
	if (pct === undefined) return undefined;
	const resetMs = firstEpochMs(r.resets_at, r.reset_at, r.reset_time, fallbackResetMs);
	return { pct, resetMs };
}

function findLimit(
	data: unknown,
	match: (limit: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
	const limits = (data as { limits?: unknown })?.limits;
	if (!Array.isArray(limits)) return undefined;
	for (const limit of limits) {
		if (limit && typeof limit === "object" && match(limit as Record<string, unknown>)) {
			return limit as Record<string, unknown>;
		}
	}
	return undefined;
}

function limitWindow(data: unknown, match: (limit: Record<string, unknown>) => boolean): UsageWindow | undefined {
	return toClaudeWindow(findLimit(data, match));
}

function firstKnownResetMs(...windows: Array<UsageWindow | undefined>): number {
	for (const window of windows) {
		if (window && Number.isFinite(window.resetMs)) return window.resetMs;
	}
	return NaN;
}

export function parseClaudeUsageResponse(data: unknown, nowMs = Date.now()): Usage | undefined {
	if (!data || typeof data !== "object") return undefined;

	const sessionLimit = limitWindow(
		data,
		(limit) => limit.kind === "session" || limit.group === "session",
	);
	const weeklyAllLimit = limitWindow(
		data,
		(limit) =>
			limit.kind === "weekly_all" ||
			(limit.group === "weekly" && (limit.scope === null || limit.scope === undefined)),
	);
	const anyWeeklyLimit = limitWindow(data, (limit) => limit.group === "weekly");

	const raw = data as { five_hour?: unknown; seven_day?: unknown };
	const fiveHour = toClaudeWindow(raw.five_hour, sessionLimit?.resetMs) ?? sessionLimit;
	const sevenDay =
		toClaudeWindow(raw.seven_day, firstKnownResetMs(weeklyAllLimit, anyWeeklyLimit)) ??
		weeklyAllLimit ??
		anyWeeklyLimit;

	if (!fiveHour && !sevenDay) return undefined;
	return { fiveHour, sevenDay, source: "oauth", stale: false, updatedMs: nowMs };
}

export async function fetchClaudeUsageWithToken(token: string): Promise<FetchResult> {
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
		const data = await res.json();
		const usage = parseClaudeUsageResponse(data);
		return usage ? { usage } : {};
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
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
