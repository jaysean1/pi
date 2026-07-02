// Standalone smoke test for the data path. Run with: bun verify.ts
import {
	fetchClaudeUsage,
	formatReset,
	latestCodexRollout,
	readCodexUsage,
} from "./index.ts";

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

const claude = await fetchClaudeUsage();
console.log(
	"claude oauth usage:",
	claude.rateLimited ? "(rate limited / 429)" : describeUsage(claude.usage),
);
