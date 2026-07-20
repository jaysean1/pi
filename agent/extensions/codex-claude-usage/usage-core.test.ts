// Tests for Codex and Claude usage parsing plus persistent last-good fallback.
// Run with: bun test agent/extensions/codex-claude-usage/usage-core.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	parseClaudeUsageResponse,
	parseCodexRateLimits,
	parseCodexUsageResponse,
	readClaudeUsageCache,
	readCodexAuth,
	writeClaudeUsageCache,
} from "./usage-core.ts";

const temporaryDirectories: string[] = [];

function temporaryCachePath(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-usage-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "nested", "claude-usage.json");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("parseCodexRateLimits", () => {
	test("maps the current primary weekly limit to seven days", () => {
		const usage = parseCodexRateLimits({
			primary: { used_percent: 4, resets_at: 1_784_491_208, window_minutes: 10_080 },
			secondary: null,
		});

		expect(usage).toEqual({
			sevenDay: { pct: 4, resetMs: 1_784_491_208_000 },
		});
		expect(usage?.fiveHour).toBeUndefined();
	});

	test("finds the weekly limit in legacy secondary data", () => {
		const usage = parseCodexRateLimits({
			primary: { used_percent: 12, resets_at: 1_000, window_minutes: 300 },
			secondary: { used_percent: 34, resets_at: 2_000, window_minutes: 10_080 },
		});

		expect(usage).toEqual({
			sevenDay: { pct: 34, resetMs: 2_000_000 },
		});
	});
});

describe("parseCodexUsageResponse (live endpoint)", () => {
	test("maps the live primary weekly window to seven days", () => {
		const usage = parseCodexUsageResponse(
			{
				rate_limit: {
					primary_window: {
						used_percent: 4,
						limit_window_seconds: 604_800,
						reset_at: 1_784_666_326,
					},
					secondary_window: null,
				},
			},
			9_999,
		);

		expect(usage?.sevenDay).toEqual({ pct: 4, resetMs: 1_784_666_326_000 });
		expect(usage?.fiveHour).toBeUndefined();
		expect(usage?.source).toBe("oauth");
		expect(usage?.stale).toBe(false);
		expect(usage?.updatedMs).toBe(9_999);
	});

	test("prefers the weekly window when it sits in secondary", () => {
		const usage = parseCodexUsageResponse({
			rate_limit: {
				primary_window: { used_percent: 50, limit_window_seconds: 18_000, reset_at: 1_000 },
				secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_at: 2_000 },
			},
		});

		expect(usage?.sevenDay).toEqual({ pct: 7, resetMs: 2_000_000 });
	});

	test("returns undefined without a rate_limit block", () => {
		expect(parseCodexUsageResponse({})).toBeUndefined();
		expect(parseCodexUsageResponse({ rate_limit: {} })).toBeUndefined();
		expect(parseCodexUsageResponse(null)).toBeUndefined();
	});
});

describe("readCodexAuth", () => {
	function temporaryAuthPath(): string {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-auth-"));
		temporaryDirectories.push(directory);
		return path.join(directory, "auth.json");
	}

	test("reads access token and account id", () => {
		const authPath = temporaryAuthPath();
		fs.writeFileSync(
			authPath,
			JSON.stringify({ tokens: { access_token: "abc", account_id: "user-123" } }),
		);

		expect(readCodexAuth(authPath)).toEqual({ token: "abc", accountId: "user-123" });
	});

	test("returns undefined without an access token", () => {
		const authPath = temporaryAuthPath();
		fs.writeFileSync(authPath, JSON.stringify({ tokens: { account_id: "user-123" } }));

		expect(readCodexAuth(authPath)).toBeUndefined();
	});

	test("returns undefined for a missing file", () => {
		expect(readCodexAuth(path.join(os.tmpdir(), "does-not-exist-codex-auth.json"))).toBeUndefined();
	});
});

describe("parseClaudeUsageResponse", () => {
	test("parses current top-level Anthropic windows", () => {
		const usage = parseClaudeUsageResponse({
			five_hour: { utilization: 12, resets_at: "2026-07-11T20:00:00Z" },
			seven_day: { utilization: 34, resets_at: "2026-07-15T20:00:00Z" },
		}, 1234);

		expect(usage?.fiveHour?.pct).toBe(12);
		expect(usage?.sevenDay?.pct).toBe(34);
		expect(usage?.updatedMs).toBe(1234);
	});

	test("falls back to limits when top-level windows are absent", () => {
		const usage = parseClaudeUsageResponse({
			limits: [
				{ kind: "session", group: "session", percent: 8, resets_at: "2026-07-11T20:00:00Z" },
				{ kind: "weekly_all", group: "weekly", percent: 21, resets_at: "2026-07-15T20:00:00Z" },
			],
		});

		expect(usage?.fiveHour?.pct).toBe(8);
		expect(usage?.sevenDay?.pct).toBe(21);
	});

	test("exposes the model-scoped weekly limit (Fable)", () => {
		const usage = parseClaudeUsageResponse({
			limits: [
				{ kind: "weekly_all", group: "weekly", percent: 22, resets_at: "2026-07-22T17:00:00Z", scope: null },
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 37,
					resets_at: "2026-07-22T17:00:00Z",
					scope: { model: { id: null, display_name: "Fable" } },
				},
			],
		});

		expect(usage?.sevenDay?.pct).toBe(22);
		expect(usage?.weeklyScoped?.pct).toBe(37);
		expect(usage?.weeklyScopedLabel).toBe("fable");
	});
});

describe("Claude usage cache", () => {
	test("round-trips the last successful response and creates its directory", () => {
		const cachePath = temporaryCachePath();
		const usage = {
			fiveHour: { pct: 4, resetMs: 20_000 },
			sevenDay: { pct: 9, resetMs: 30_000 },
			updatedMs: 10_000,
		};

		expect(writeClaudeUsageCache(cachePath, usage)).toBe(true);
		expect(readClaudeUsageCache(cachePath, 5_000, 12_000)).toEqual({
			...usage,
			source: "cache",
			stale: false,
		});
	});

	test("keeps old data but marks it stale", () => {
		const cachePath = temporaryCachePath();
		writeClaudeUsageCache(cachePath, {
			fiveHour: { pct: 7, resetMs: Number.NaN },
			updatedMs: 1_000,
		});

		const cached = readClaudeUsageCache(cachePath, 5_000, 10_000);
		expect(cached?.fiveHour?.pct).toBe(7);
		expect(Number.isNaN(cached?.fiveHour?.resetMs)).toBe(true);
		expect(cached?.stale).toBe(true);
	});

	test("ignores malformed cache files", () => {
		const cachePath = temporaryCachePath();
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, "not json");

		expect(readClaudeUsageCache(cachePath, 5_000)).toBeUndefined();
	});
});
