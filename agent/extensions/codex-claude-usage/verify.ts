// Standalone smoke test for the data path. Run with:
//   bun agent/extensions/codex-claude-usage/verify.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fetchClaudeUsageWithToken,
	formatReset,
	latestCodexRollout,
	parseClaudeUsageResponse,
	readCodexUsage,
} from "./usage-core.ts";

function pct(p: number | undefined) {
	return p === undefined ? "—" : `${Math.round(p)}%`;
}

function describeUsage(
	usage: ReturnType<typeof readCodexUsage>,
): string {
	if (!usage) return "(no data)";
	const source = usage.source ? ` source=${usage.source}` : "";
	const stale = usage.stale ? " stale=true" : "";
	return `5h: ${pct(usage.fiveHour?.pct)} (${formatReset(usage.fiveHour?.resetMs ?? NaN)}) | 7d: ${pct(usage.sevenDay?.pct)} (${formatReset(usage.sevenDay?.resetMs ?? NaN)})${source}${stale}`;
}

const rollout = latestCodexRollout();
console.log("codex rollout file:", rollout ?? "(none found)");

const codex = readCodexUsage();
console.log("codex usage:", describeUsage(codex));

const sampleMissingFiveHourReset = parseClaudeUsageResponse({
	five_hour: { utilization: 0 },
	seven_day: { utilization: 2, resets_at: "2026-07-08T16:59:59.702244+00:00" },
	limits: [
		{
			kind: "session",
			group: "session",
			percent: 0,
			resets_at: "2026-07-02T10:39:59.702216+00:00",
			is_active: true,
		},
	],
});
console.log("fallback sample:", describeUsage(sampleMissingFiveHourReset));

const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const authPath = path.join(piAgentDir, "auth.json");
let token = "";
try {
	const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
		anthropic?: { access?: unknown };
	};
	token = typeof auth.anthropic?.access === "string" ? auth.anthropic.access : "";
} catch {
	token = "";
}

const claude = token ? await fetchClaudeUsageWithToken(token) : {};
console.log(
	"claude oauth usage:",
	claude.rateLimited ? "(rate limited / 429)" : describeUsage(claude.usage),
);
