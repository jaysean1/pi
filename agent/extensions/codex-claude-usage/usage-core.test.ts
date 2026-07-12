// Tests for Claude usage parsing and persistent last-good fallback.
// Run with: bun test agent/extensions/codex-claude-usage/usage-core.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	parseClaudeUsageResponse,
	readClaudeUsageCache,
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
