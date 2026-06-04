// Standalone statusline footer: working directory + git branch + session name,
// context/cost stats with the active model and its reasoning effort, plus any
// extension status lines (e.g. codex-claude-usage). Owns the footer surface via
// ctx.ui.setFooter(); knows nothing about diff review or any other feature.

import { homedir } from "node:os";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	formatCwdForFooter,
	formatTokens,
	sanitizeStatusText,
	usageNumber,
} from "./render-utils.ts";

// Mirrors pi-agent-core's ThinkingLevel union (not re-exported from the package);
// kept in sync with Theme.getThinkingBorderColor's accepted levels.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export class StatuslineFooter implements Component {
	private readonly unsubscribeBranch?: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly getThinkingLevel: () => ThinkingLevel,
	) {
		this.unsubscribeBranch = footerData.onBranchChange(() =>
			this.requestRender(),
		);
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	invalidate(): void {
		this.requestRender();
	}

	dispose(): void {
		this.unsubscribeBranch?.();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const lines = [this.renderPathLine(w), this.renderStatsLine(w)];
		lines.push(...this.renderExtensionStatusLines(w));
		return lines;
	}

	private renderPathLine(width: number): string {
		let pathLabel = formatCwdForFooter(
			this.ctx.sessionManager.getCwd(),
			homedir(),
		);
		const branch = this.footerData.getGitBranch();
		if (branch) pathLabel = `${pathLabel} (${branch})`;
		const sessionName = this.ctx.sessionManager.getSessionName();
		if (sessionName) pathLabel = `${pathLabel} • ${sessionName}`;
		return this.padTo(
			truncateToWidth(
				this.theme.fg("dim", pathLabel),
				width,
				this.theme.fg("dim", "..."),
			),
			width,
		);
	}

	private renderStatsLine(width: number): string {
		let totalCost = 0;

		for (const entry of this.ctx.sessionManager.getEntries()) {
			const record = entry as {
				type?: string;
				message?: {
					role?: string;
					usage?: { cost?: { total?: unknown } };
				};
			};
			if (record.type !== "message" || record.message?.role !== "assistant")
				continue;
			totalCost += usageNumber(record.message.usage?.cost?.total);
		}

		const contextUsage = this.ctx.getContextUsage();
		const contextWindow =
			contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent === null
				? "?"
				: `${Math.round(contextPercentValue)}%`;
		const contextValueDisplay = `${contextPercent} / ${formatTokens(
			contextWindow,
		)}`;
		const contextValueText =
			contextPercentValue > 90
				? this.theme.fg("error", contextValueDisplay)
				: contextPercentValue > 70
					? this.theme.fg("warning", contextValueDisplay)
					: contextValueDisplay;
		const contextRendered =
			this.theme.fg("dim", "Ctx: ") + contextValueText;
		const costRendered = this.theme.fg(
			"dim",
			`Cost: $${totalCost.toFixed(1)}`,
		);

		const statsLeftText = `Ctx: ${contextPercent} / ${formatTokens(
			contextWindow,
		)} · Cost: $${totalCost.toFixed(1)}`;
		const statsLeftWidth = visibleWidth(statsLeftText);

		// Reasoning-effort badge for the current model, always shown to the right
		// of the model name (e.g. `… • xhigh`). The level token is tinted with the
		// theme's dedicated thinking-level palette (off→dim … xhigh→hot) so the
		// effort reads at a glance; the model name + bullet stay dim.
		const modelName = this.ctx.model?.id || "no-model";
		const level = this.getThinkingLevel();
		const levelLabel = level === "off" ? "thinking off" : level;
		const reasoningWidth = visibleWidth(` • ${levelLabel}`);

		let rightBase = modelName;
		if (this.footerData.getAvailableProviderCount() > 1 && this.ctx.model) {
			const withProvider = `(${this.ctx.model.provider}) ${modelName}`;
			if (
				statsLeftWidth +
					visibleWidth(" · ") +
					visibleWidth(withProvider) +
					reasoningWidth <=
				width
			) {
				rightBase = withProvider;
			}
		}

		const rightRendered =
			this.theme.fg("dim", `${rightBase} • `) +
			this.theme.getThinkingBorderColor(level)(levelLabel);

		return this.composeSimpleLine(width, [
			contextRendered,
			costRendered,
			rightRendered,
		]);
	}

	private renderExtensionStatusLines(width: number): string[] {
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size === 0) return [];
		const statusLine = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join("  |  ");
		return [
			truncateToWidth(
				this.theme.fg("dim", statusLine),
				width,
				this.theme.fg("dim", "..."),
			),
		];
	}

	private composeSimpleLine(width: number, rendered: string[]): string {
		const separator = this.theme.fg("dim", " · ");
		const line = rendered.join(separator);
		return this.padTo(
			truncateToWidth(line, width, this.theme.fg("dim", "...")),
			width,
		);
	}

	private padTo(text: string, width: number): string {
		const pad = width - visibleWidth(text);
		return pad > 0
			? text + " ".repeat(pad)
			: truncateToWidth(text, width, "...");
	}
}
