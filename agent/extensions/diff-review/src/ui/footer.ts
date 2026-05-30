// Render the diff-review footer entry.
// Not for overlay layout or file tracking.

import { homedir } from "node:os";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type TUI,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { diffStats, fileChangeLabel } from "../core/diff-engine.ts";
import type { FileDiff } from "../core/types.ts";
import {
	actionBlue,
	formatCwdForFooter,
	formatTokens,
	sanitizeStatusText,
	usageNumber,
} from "./ui-utils.ts";

export class DiffReviewFooter implements Component, Focusable {
	private _focused = false;
	private readonly unsubscribeBranch?: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly getFiles: () => FileDiff[],
		private readonly open: () => void,
		private readonly focusEditor: () => void,
	) {
		this.unsubscribeBranch = footerData.onBranchChange(() => this.requestRender());
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	focus(): void {
		this.tui.setFocus(this);
		this.tui.requestRender();
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

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.open();
			return;
		}
		if (
			matchesKey(data, Key.up) ||
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.escape)
		) {
			this.focusEditor();
		}
	}

	render(width: number): string[] {
		const W = Math.max(1, width);
		const lines = [this.renderPathLine(W), this.renderStatsLine(W)];
		lines.push(...this.renderExtensionStatusLines(W));
		return lines;
	}

	private renderPathLine(width: number): string {
		const pathLabel = this.pathLabel();
		const files = this.getFiles();
		const stats = diffStats(files);
		const hasChanges = stats.files > 0;
		const status = hasChanges
			? `📝 ${fileChangeLabel(stats.files)} +${stats.added} -${stats.removed}`
			: "";
		const action = hasChanges ? "review" : "files";
		const icon = hasChanges ? "📝" : "📁";
		return this.composePathLine(width, pathLabel, status, icon, action);
	}

	private pathLabel(): string {
		let pathLabel = formatCwdForFooter(
			this.ctx.sessionManager.getCwd(),
			homedir(),
		);
		const branch = this.footerData.getGitBranch();
		if (branch) pathLabel = `${pathLabel} (${branch})`;
		const sessionName = this.ctx.sessionManager.getSessionName();
		if (sessionName) pathLabel = `${pathLabel} • ${sessionName}`;
		return pathLabel;
	}

	private composePathLine(
		width: number,
		pathLabel: string,
		status: string,
		icon: string,
		action: string,
	): string {
		const buttonRaw = ` ${icon} ${action} `;
		const hintRaw = this._focused ? " enter open · ↑ input" : " ↓ focus";
		const buttonW = visibleWidth(buttonRaw);
		const hintW = visibleWidth(hintRaw);

		if (width <= buttonW + 1) {
			return this.padTo(this.renderButton(truncateToWidth(buttonRaw, width)), width);
		}
		if (width <= buttonW + hintW + 1) {
			return this.padTo(this.renderButton(buttonRaw), width);
		}

		const minGap = 2;
		const statusGap = status ? "  " : "";
		let statusRaw = status;
		let rightW =
			visibleWidth(statusRaw) +
			visibleWidth(statusGap) +
			buttonW +
			hintW;
		if (statusRaw && rightW + minGap > width) {
			statusRaw = "";
			rightW = buttonW + hintW;
		}
		const leftRoom = Math.max(0, width - rightW - minGap);
		const fittedLeft = truncateToWidth(pathLabel, leftRoom, "...");
		const gap = Math.max(
			minGap,
			width - visibleWidth(fittedLeft) - rightW,
		);
		const statusText = statusRaw
			? `${this.theme.fg("text", statusRaw)}${statusGap}`
			: "";
		return this.padTo(
			`${this.theme.fg("dim", fittedLeft)}${" ".repeat(gap)}${statusText}${this.renderButton(buttonRaw)}${this.theme.fg("dim", hintRaw)}`,
			width,
		);
	}

	private renderStatsLine(width: number): string {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.ctx.sessionManager.getEntries()) {
			const record = entry as {
				type?: string;
				message?: {
					role?: string;
					usage?: {
						input?: unknown;
						output?: unknown;
						cacheRead?: unknown;
						cacheWrite?: unknown;
						cost?: { total?: unknown };
					};
				};
			};
			if (record.type !== "message" || record.message?.role !== "assistant")
				continue;
			const usage = record.message.usage;
			totalInput += usageNumber(usage?.input);
			totalOutput += usageNumber(usage?.output);
			totalCacheRead += usageNumber(usage?.cacheRead);
			totalCacheWrite += usageNumber(usage?.cacheWrite);
			totalCost += usageNumber(usage?.cost?.total);
		}

		const contextUsage = this.ctx.getContextUsage();
		const contextWindow =
			contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent === null ? "?" : contextPercentValue.toFixed(1);
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}`
				: `${contextPercent}%/${formatTokens(contextWindow)}`;
		const contextPercentText =
			contextPercentValue > 90
				? this.theme.fg("error", contextPercentDisplay)
				: contextPercentValue > 70
					? this.theme.fg("warning", contextPercentDisplay)
					: contextPercentDisplay;

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

		const usingSubscription = this.ctx.model
			? this.ctx.modelRegistry.isUsingOAuth(this.ctx.model)
			: false;
		if (totalCost || usingSubscription) {
			statsParts.push(
				`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
			);
		}
		statsParts.push(contextPercentText);

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const modelName = this.ctx.model?.id || "no-model";
		let rightSide = modelName;
		if (this.footerData.getAvailableProviderCount() > 1 && this.ctx.model) {
			const withProvider = `(${this.ctx.model.provider}) ${modelName}`;
			if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const availableForRight = width - statsLeftWidth - 2;
		let statsLine: string;
		if (statsLeftWidth + 2 + rightSideWidth <= width) {
			statsLine =
				statsLeft +
				" ".repeat(width - statsLeftWidth - rightSideWidth) +
				rightSide;
		} else if (availableForRight > 0) {
			const fittedRight = truncateToWidth(rightSide, availableForRight, "");
			statsLine =
				statsLeft +
				" ".repeat(
					Math.max(0, width - statsLeftWidth - visibleWidth(fittedRight)),
				) +
				fittedRight;
		} else {
			statsLine = statsLeft;
		}

		return truncateToWidth(this.theme.fg("dim", statsLine), width);
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

	private renderButton(text: string): string {
		const label = actionBlue(this.theme, this.theme.bold(text));
		return this._focused ? this.theme.bg("selectedBg", label) : label;
	}

	private padTo(text: string, width: number): string {
		const pad = width - visibleWidth(text);
		return pad > 0 ? text + " ".repeat(pad) : truncateToWidth(text, width, "...");
	}
}
