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
	Key,
	matchesKey,
	type TUI,
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
		this.unsubscribeBranch = footerData.onBranchChange(() =>
			this.requestRender(),
		);
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
		// Focus chain: ↑ walks up to the twitter-statusline preview when present;
		// ← / Esc jump straight back to the input editor.
		if (matchesKey(data, Key.up)) {
			const twitter = (
				globalThis as {
					__piTwitterChain?: { focusPreview: () => void };
				}
			).__piTwitterChain;
			if (twitter) {
				twitter.focusPreview();
				return;
			}
			this.focusEditor();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
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
		const hintRaw = this._focused ? "enter open · ↑ input" : "↓ focus";
		const buttonW = visibleWidth(buttonRaw);

		if (width <= buttonW + 1) {
			return this.padTo(
				this.renderButton(truncateToWidth(buttonRaw, width)),
				width,
			);
		}

		const statusSegment = status
			? { raw: status, rendered: this.theme.fg("text", status) }
			: undefined;
		const trailingSegments = [
			statusSegment,
			{ raw: buttonRaw, rendered: this.renderButton(buttonRaw) },
			{ raw: hintRaw, rendered: this.theme.fg("dim", hintRaw) },
		].filter((part): part is { raw: string; rendered: string } =>
			Boolean(part),
		);

		return this.composeLeadingLine(
			width,
			{
				raw: pathLabel,
				render: (text) => this.theme.fg("dim", text),
			},
			trailingSegments,
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

		const statsLeft = statsParts.join(" ");
		const statsLeftWidth = visibleWidth(statsLeft);

		const modelName = this.ctx.model?.id || "no-model";
		let rightSide = modelName;
		if (this.footerData.getAvailableProviderCount() > 1 && this.ctx.model) {
			const withProvider = `(${this.ctx.model.provider}) ${modelName}`;
			if (
				statsLeftWidth + visibleWidth(" · ") + visibleWidth(withProvider) <=
				width
			) {
				rightSide = withProvider;
			}
		}

		return this.composeSimpleLine(width, [
			{ raw: statsLeft, rendered: this.theme.fg("dim", statsLeft) },
			{ raw: rightSide, rendered: this.theme.fg("dim", rightSide) },
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

	private renderButton(text: string): string {
		const label = actionBlue(this.theme, this.theme.bold(text));
		return this._focused ? this.theme.bg("selectedBg", label) : label;
	}

	private composeLeadingLine(
		width: number,
		leading: { raw: string; render: (text: string) => string },
		trailingSegments: { raw: string; rendered: string }[],
	): string {
		const separator = " · ";
		const trailingWidth =
			trailingSegments.reduce(
				(sum, segment) => sum + visibleWidth(segment.raw),
				0,
			) +
			visibleWidth(separator) * trailingSegments.length;
		const leadingRoom = Math.max(0, width - trailingWidth);
		const fittedLeading = truncateToWidth(leading.raw, leadingRoom, "...");
		const segments = [
			{ raw: fittedLeading, rendered: leading.render(fittedLeading) },
			...trailingSegments,
		].filter((segment) => segment.raw.length > 0);
		return this.composeSimpleLine(width, segments);
	}

	private composeSimpleLine(
		width: number,
		segments: { raw: string; rendered: string }[],
	): string {
		const separator = this.theme.fg("dim", " · ");
		const line = segments.map((segment) => segment.rendered).join(separator);
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
