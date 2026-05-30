// Standalone smoke test for the data path. Run with: bun verify.ts
import { fetchClaudeUsage, formatReset, latestCodexRollout, readCodexUsage } from "./index.ts";

function pct(p: number | undefined) {
	return p === undefined ? "—" : `${Math.round(p)}%`;
}

const rollout = latestCodexRollout();
console.log("codex rollout file:", rollout ?? "(none found)");

const codex = readCodexUsage();
console.log(
	"codex usage:",
	codex
		? `5h: ${pct(codex.fiveHour?.pct)} (${formatReset(codex.fiveHour?.resetMs ?? NaN)}) | 7d: ${pct(codex.sevenDay?.pct)} (${formatReset(codex.sevenDay?.resetMs ?? NaN)})`
		: "(no data)",
);

const claude = await fetchClaudeUsage();
console.log(
	"claude usage:",
	claude
		? `5h: ${pct(claude.fiveHour?.pct)} (${formatReset(claude.fiveHour?.resetMs ?? NaN)}) | 7d: ${pct(claude.sevenDay?.pct)} (${formatReset(claude.sevenDay?.resetMs ?? NaN)})`
		: "(no data)",
);
