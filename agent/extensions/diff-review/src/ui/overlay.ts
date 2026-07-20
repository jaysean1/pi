// Render and launch the full-screen diff-review overlay.
// Not for session event registration.

import { basename, isAbsolute, relative, sep } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	BROWSE_SIDEBAR_MAX,
	BROWSE_SIDEBAR_MIN,
	BROWSE_SIDEBAR_RATIO,
	LINE_NUM_WIDTH,
	PANEL_HEIGHT_RATIO,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	SIDEBAR_RATIO,
} from "../core/constants.ts";
import {
	createBrowseRoot,
	flattenBrowseTree,
	loadBrowseChildren,
	previewForNode,
	wrapPreviewLines,
	wrapUnifiedDiffRows,
	wrapVisibleText,
} from "../core/browse-tree.ts";
import { displayPathFor, truncatePathLeft } from "../core/diff-engine.ts";
import type {
	ActiveTab,
	BrowseFocus,
	BrowseNode,
	FileDiff,
	FilePreview,
	Focus,
	ReviewCloseAction,
	ReviewOpenMode,
	ReviewOverlayState,
	UnifiedDiffLine,
} from "../core/types.ts";
import { isToggleKey } from "../platform/keys.ts";
import {
	enableMouseWheel,
	isMouseSequence,
	parseWheelEvents,
} from "../platform/mouse.ts";
import { clamp, colourBlindDiffLine } from "./ui-utils.ts";

// Lines scrolled per wheel notch; matches the english-learning overlay.
const WHEEL_SCROLL_LINES = 3;

class DiffBrowseOverlay {
	private activeTab: ActiveTab;
	private diffFocus: Focus = "list";
	private selected = 0;
	private listScroll = 0;
	private diffScroll = 0;
	private diffWidth = 120;
	private browseFocus: BrowseFocus = "tree";
	private browseSelected = 0;
	private browseScroll = 0;
	private previewScroll = 0;
	private previewWidth = 80;
	private previewPath = "";
	private preview?: FilePreview;
	private readonly browseRoot: BrowseNode;
	private readonly disableMouse: () => void;

	constructor(
		private readonly tui: {
			terminal: { rows: number; write: (data: string) => void };
			requestRender: () => void;
		},
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly files: FileDiff[],
		initialTab: ActiveTab,
		private readonly done: (action: ReviewCloseAction) => void,
		private readonly openFile: (file: FileDiff) => void,
		private readonly openBrowseFile: (
			absPath: string,
			displayPath: string,
		) => void,
		restoredState?: ReviewOverlayState,
		private readonly saveState?: (state: ReviewOverlayState) => void,
	) {
		this.activeTab = initialTab;
		this.browseRoot = createBrowseRoot(cwd);
		if (restoredState) this.restoreState(restoredState);
		// Touchpad two-finger scrolling arrives as wheel reports once mouse
		// reporting is on. dispose() restores the terminal; ui.custom calls it
		// automatically when the overlay closes.
		this.disableMouse = enableMouseWheel(tui.terminal);
	}

	dispose(): void {
		this.saveState?.(this.snapshotState());
		this.disableMouse();
	}

	private diffPath(file: FileDiff): string {
		return file.absPath ?? file.displayPath;
	}

	private isWithin(parentPath: string, childPath: string): boolean {
		const rel = relative(parentPath, childPath);
		return (
			rel !== "" &&
			rel !== ".." &&
			!rel.startsWith(`..${sep}`) &&
			!isAbsolute(rel)
		);
	}

	private restoreState(state: ReviewOverlayState): void {
		const selectedDiff = state.diff.selectedPath
			? this.files.findIndex(
					(file) => this.diffPath(file) === state.diff.selectedPath,
				)
			: -1;
		this.selected = selectedDiff >= 0 ? selectedDiff : 0;
		const body = this.bodyRows();
		this.listScroll = clamp(
			state.diff.listScroll,
			0,
			Math.max(0, this.files.length - body),
		);
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		else if (this.selected >= this.listScroll + body)
			this.listScroll = this.selected - body + 1;
		this.diffScroll = Math.max(0, state.diff.diffScroll);
		const selectedFile = this.currentDiff();
		this.diffFocus =
			state.diff.focus === "diff" && selectedFile?.rows.length
				? "diff"
				: "list";

		const expandedDirs = new Set(state.browse.expandedDirs);
		const restoreDirectory = (node: BrowseNode): void => {
			if (node.kind !== "directory") return;
			node.expanded = node === this.browseRoot || expandedDirs.has(node.absPath);
			const hasExpandedDescendant = state.browse.expandedDirs.some((path) =>
				this.isWithin(node.absPath, path),
			);
			if (!node.expanded && !hasExpandedDescendant) return;
			loadBrowseChildren(node);
			for (const child of node.children) restoreDirectory(child);
		};
		restoreDirectory(this.browseRoot);

		const nodes = flattenBrowseTree(this.browseRoot);
		const selectedBrowse = state.browse.selectedPath
			? nodes.findIndex((node) => node.absPath === state.browse.selectedPath)
			: -1;
		this.browseSelected = selectedBrowse >= 0 ? selectedBrowse : 0;
		this.browseScroll = clamp(
			state.browse.browseScroll,
			0,
			Math.max(0, nodes.length - body),
		);
		if (this.browseSelected < this.browseScroll)
			this.browseScroll = this.browseSelected;
		else if (this.browseSelected >= this.browseScroll + body)
			this.browseScroll = this.browseSelected - body + 1;
		this.previewScroll = Math.max(0, state.browse.previewScroll);
		this.browseFocus =
			state.browse.focus === "preview" &&
			nodes[this.browseSelected]?.kind === "file"
				? "preview"
				: "tree";
	}

	private snapshotState(): ReviewOverlayState {
		const expandedDirs: string[] = [];
		const collectExpanded = (node: BrowseNode): void => {
			if (node.kind === "directory" && node.expanded)
				expandedDirs.push(node.absPath);
			for (const child of node.children) collectExpanded(child);
		};
		collectExpanded(this.browseRoot);
		const diff = this.currentDiff();
		const browse = this.currentBrowse();
		return {
			activeTab: this.activeTab,
			diff: {
				selectedPath: diff ? this.diffPath(diff) : undefined,
				focus: this.diffFocus,
				listScroll: this.listScroll,
				diffScroll: this.diffScroll,
			},
			browse: {
				selectedPath: browse.absPath,
				expandedDirs,
				focus: this.browseFocus,
				browseScroll: this.browseScroll,
				previewScroll: this.previewScroll,
			},
		};
	}

	private currentDiff(): FileDiff | undefined {
		return this.files[this.selected];
	}

	private browseNodes(): BrowseNode[] {
		const nodes = flattenBrowseTree(this.browseRoot);
		this.browseSelected = clamp(
			this.browseSelected,
			0,
			Math.max(0, nodes.length - 1),
		);
		return nodes;
	}

	private currentBrowse(): BrowseNode {
		const nodes = this.browseNodes();
		return nodes[this.browseSelected] ?? this.browseRoot;
	}

	private bodyRows(): number {
		const termRows = this.tui.terminal.rows;
		const panel = Math.max(12, Math.floor(termRows * PANEL_HEIGHT_RATIO));
		return Math.max(3, panel - 8); // 8 fixed chrome lines.
	}

	handleInput(data: string): void {
		if (isToggleKey(data)) {
			this.done("dismiss");
			return;
		}
		// Touchpad / wheel always scrolls the right-hand content pane (diff or
		// preview) regardless of pane focus; left panes stay keyboard-driven.
		const wheel = parseWheelEvents(data);
		if (wheel.length > 0) {
			let delta = 0;
			for (const direction of wheel) {
				delta += direction === "down" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES;
			}
			if (delta !== 0) this.scrollContent(delta);
			return;
		}
		// Swallow click/release reports so they never reach key matching.
		if (isMouseSequence(data)) return;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.switchTab();
			return;
		}
		if (data === "c" && this.files.length > 0) {
			this.done("clear");
			return;
		}
		if (this.activeTab === "diff") this.handleDiffInput(data);
		else this.handleBrowseInput(data);
	}

	private switchTab(tab?: ActiveTab): void {
		this.activeTab = tab ?? (this.activeTab === "diff" ? "browse" : "diff");
		this.tui.requestRender();
	}

	private handleDiffInput(data: string): void {
		if (this.files.length === 0) {
			if (matchesKey(data, Key.escape)) this.done("dismiss");
			return;
		}
		const body = this.bodyRows();
		if (this.diffFocus === "list") {
			if (matchesKey(data, Key.up)) {
				this.moveDiffSelection(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveDiffSelection(1);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.moveDiffSelection(-body);
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				this.moveDiffSelection(body);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.openCurrentFile();
				return;
			}
			if (matchesKey(data, Key.space) || matchesKey(data, Key.right)) {
				this.enterDiff();
				return;
			}
			if (matchesKey(data, Key.escape)) this.done("dismiss");
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
			this.diffFocus = "list";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openCurrentFile();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollDiff(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollDiff(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollDiff(-body);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollDiff(body);
			return;
		}
		if (data === "g") {
			this.scrollDiffTo(0);
			return;
		}
		if (data === "G") this.scrollDiffTo(Number.MAX_SAFE_INTEGER);
	}

	private handleBrowseInput(data: string): void {
		const body = this.bodyRows();
		if (this.browseFocus === "tree") {
			if (matchesKey(data, Key.up)) {
				this.moveBrowseSelection(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveBrowseSelection(1);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.moveBrowseSelection(-body);
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				this.moveBrowseSelection(body);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.openCurrentBrowseFile();
				return;
			}
			if (matchesKey(data, Key.space)) {
				this.toggleOrPreviewBrowse();
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.expandOrPreviewBrowse();
				return;
			}
			if (matchesKey(data, Key.left)) {
				this.collapseBrowse();
				return;
			}
			if (matchesKey(data, Key.escape)) this.done("dismiss");
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
			this.browseFocus = "tree";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openCurrentBrowseFile();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollPreview(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollPreview(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollPreview(-body);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollPreview(body);
			return;
		}
		if (data === "g") {
			this.scrollPreviewTo(0);
			return;
		}
		if (data === "G") this.scrollPreviewTo(Number.MAX_SAFE_INTEGER);
	}

	private moveDiffSelection(delta: number): void {
		if (this.files.length === 0) return;
		this.selected = clamp(this.selected + delta, 0, this.files.length - 1);
		this.diffScroll = 0;
		const body = this.bodyRows();
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		else if (this.selected >= this.listScroll + body)
			this.listScroll = this.selected - body + 1;
		this.tui.requestRender();
	}

	private enterDiff(): void {
		const file = this.currentDiff();
		if (!file || file.rows.length === 0) return;
		this.diffFocus = "diff";
		this.diffScroll = 0;
		this.tui.requestRender();
	}

	private openCurrentFile(): void {
		const file = this.currentDiff();
		if (!file) return;
		this.openFile(file);
	}

	private openCurrentBrowseFile(): void {
		const node = this.currentBrowse();
		if (node.kind === "directory") {
			this.toggleOrPreviewBrowse();
			return;
		}
		this.openBrowseFile(node.absPath, displayPathFor(this.cwd, node.absPath));
	}

	private maxDiffScroll(): number {
		const file = this.currentDiff();
		if (!file) return 0;
		const wrapped = wrapUnifiedDiffRows(file.rows, this.diffWidth);
		return Math.max(0, wrapped.length - this.bodyRows());
	}

	private scrollContent(delta: number): void {
		if (this.activeTab === "diff") {
			if (this.files.length === 0) return;
			this.scrollDiff(delta);
			return;
		}
		this.scrollPreview(delta);
	}

	private scrollDiff(delta: number): void {
		this.diffScroll = clamp(this.diffScroll + delta, 0, this.maxDiffScroll());
		this.tui.requestRender();
	}

	private scrollDiffTo(target: number): void {
		this.diffScroll = clamp(target, 0, this.maxDiffScroll());
		this.tui.requestRender();
	}

	private moveBrowseSelection(delta: number): void {
		const nodes = this.browseNodes();
		if (nodes.length === 0) return;
		this.browseSelected = clamp(
			this.browseSelected + delta,
			0,
			nodes.length - 1,
		);
		this.previewScroll = 0;
		this.previewPath = "";
		this.preview = undefined;
		const body = this.bodyRows();
		if (this.browseSelected < this.browseScroll)
			this.browseScroll = this.browseSelected;
		else if (this.browseSelected >= this.browseScroll + body)
			this.browseScroll = this.browseSelected - body + 1;
		this.tui.requestRender();
	}

	private toggleOrPreviewBrowse(): void {
		const node = this.currentBrowse();
		if (node.kind === "directory") {
			node.expanded = !node.expanded;
			if (node.expanded) loadBrowseChildren(node);
			this.tui.requestRender();
			return;
		}
		this.browseFocus = "preview";
		this.previewScroll = 0;
		this.tui.requestRender();
	}

	private expandOrPreviewBrowse(): void {
		const node = this.currentBrowse();
		if (node.kind === "directory") {
			node.expanded = true;
			loadBrowseChildren(node);
		} else {
			this.browseFocus = "preview";
			this.previewScroll = 0;
		}
		this.tui.requestRender();
	}

	private collapseBrowse(): void {
		const node = this.currentBrowse();
		if (
			node.kind === "directory" &&
			node.expanded &&
			node !== this.browseRoot
		) {
			node.expanded = false;
			this.tui.requestRender();
			return;
		}
		if (node.parent) {
			const parentIndex = this.browseNodes().indexOf(node.parent);
			if (parentIndex >= 0) this.browseSelected = parentIndex;
			this.tui.requestRender();
		}
	}

	private currentPreview(): FilePreview {
		const node = this.currentBrowse();
		if (this.previewPath !== node.absPath) {
			this.previewPath = node.absPath;
			this.preview = previewForNode(this.cwd, node);
			this.previewScroll = 0;
		}
		return (
			this.preview ?? {
				title: displayPathFor(this.cwd, node.absPath),
				lines: [],
				note: "Preview not available.",
			}
		);
	}

	private maxPreviewScroll(): number {
		const preview = this.currentPreview();
		const wrapped = preview.note
			? wrapVisibleText(preview.note, Math.max(1, this.previewWidth - 2))
			: wrapPreviewLines(preview.lines, this.previewWidth);
		return Math.max(0, wrapped.length - this.bodyRows());
	}

	private scrollPreview(delta: number): void {
		this.previewScroll = clamp(
			this.previewScroll + delta,
			0,
			this.maxPreviewScroll(),
		);
		this.tui.requestRender();
	}

	private scrollPreviewTo(target: number): void {
		this.previewScroll = clamp(target, 0, this.maxPreviewScroll());
		this.tui.requestRender();
	}

	invalidate(): void {
		// Render is derived from current state and lazy filesystem reads.
	}

	// -- rendering ----------------------------------------------------------

	private padTo(text: string, width: number): string {
		const pad = width - visibleWidth(text);
		return pad > 0 ? text + " ".repeat(pad) : truncateToWidth(text, width);
	}

	private renderTabs(width: number): string {
		const diffLabel = ` 📝 Diff${this.files.length > 0 ? ` (${this.files.length})` : ""} `;
		const browseLabel = " 📁 Files ";
		const rawWidth = visibleWidth(diffLabel) + 1 + visibleWidth(browseLabel);
		const diff =
			this.activeTab === "diff"
				? this.theme.bg(
						"selectedBg",
						this.theme.fg("accent", this.theme.bold(diffLabel)),
					)
				: this.theme.fg("muted", diffLabel);
		const browse =
			this.activeTab === "browse"
				? this.theme.bg(
						"selectedBg",
						this.theme.fg("accent", this.theme.bold(browseLabel)),
					)
				: this.theme.fg("muted", browseLabel);
		return `${diff} ${browse}${" ".repeat(Math.max(0, width - rawWidth))}`;
	}

	private renderDiffSidebarCell(width: number, index: number): string {
		const th = this.theme;
		const file = this.files[index];
		if (!file) return " ".repeat(width);
		const isSelected = index === this.selected;
		const marker = isSelected ? ">" : " ";
		const stats = `+${file.added} -${file.removed}`;
		const statsW = visibleWidth(stats);
		const nameW = Math.max(1, width - 2 - statsW - 1);
		const name = truncatePathLeft(file.displayPath, nameW);
		const left = this.padTo(`${marker} ${name}`, width - statsW - 1);
		const line = this.padTo(`${left} ${stats}`, width);
		if (isSelected) {
			return this.diffFocus === "list"
				? th.bg("selectedBg", th.fg("accent", line))
				: th.fg("accent", line);
		}
		return th.fg("text", line);
	}

	private renderUnifiedDiffLine(line: UnifiedDiffLine, width: number): string {
		const th = this.theme;
		const oldNum = String(line.oldNum ?? "").padStart(LINE_NUM_WIDTH, " ");
		const newNum = String(line.newNum ?? "").padStart(LINE_NUM_WIDTH, " ");
		const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		const textW = Math.max(0, width - LINE_NUM_WIDTH * 2 - 4);
		const raw = this.padTo(
			`${oldNum} ${newNum} ${marker} ${this.padTo(line.text, textW)}`,
			width,
		);
		if (line.type === "del") return colourBlindDiffLine(th, "del", raw);
		if (line.type === "add") return colourBlindDiffLine(th, "add", raw);
		return th.fg("toolDiffContext", raw);
	}

	private renderBrowseTreeCell(width: number, index: number): string {
		const th = this.theme;
		const node = this.browseNodes()[index];
		if (!node) return " ".repeat(width);
		const selected = index === this.browseSelected;
		const marker = selected ? ">" : " ";
		const suffix = node.kind === "directory" ? "/" : "";
		const indent = " ".repeat(Math.min(16, node.depth * 2));
		const label =
			node.kind === "directory"
				? `${node.expanded ? "v" : ">"} ${node.name}${suffix}`
				: node.name;
		const raw = `${marker} ${indent}${label}`;
		const line = this.padTo(truncateToWidth(raw, width, "…"), width);
		if (selected) {
			return this.browseFocus === "tree"
				? th.bg("selectedBg", th.fg("accent", line))
				: th.fg("accent", line);
		}
		return node.kind === "directory"
			? th.fg("text", line)
			: th.fg("toolDiffContext", line);
	}

	private renderPreviewLine(width: number, row: number): string {
		const preview = this.currentPreview();
		if (preview.note) {
			const wrapped = wrapVisibleText(preview.note, Math.max(1, width - 2));
			const text = wrapped[this.previewScroll + row];
			return this.theme.fg(
				"muted",
				this.padTo(text === undefined ? "" : `  ${text}`, width),
			);
		}
		const wrapped = wrapPreviewLines(preview.lines, width);
		const line = wrapped[this.previewScroll + row];
		if (!line) return " ".repeat(width);
		const num =
			line.num === undefined
				? " ".repeat(LINE_NUM_WIDTH)
				: String(line.num).padStart(LINE_NUM_WIDTH, " ");
		const textW = Math.max(0, width - LINE_NUM_WIDTH - 2);
		const raw = `${num}  ${this.padTo(line.text, textW)}`;
		return this.theme.fg("toolDiffContext", this.padTo(raw, width));
	}

	render(width: number): string[] {
		const th = this.theme;
		const W = Math.max(52, width);
		const innerW = W - 2;
		const body = this.bodyRows();
		const border = (s: string) => th.fg("border", s);
		const lines: string[] = [];
		const title = ` Review · ${this.files.length} changed file${this.files.length === 1 ? "" : "s"} · ${basename(this.cwd) || this.cwd} `;

		lines.push(border("╭") + border("─".repeat(innerW)) + border("╮"));
		lines.push(
			border("│") +
				th.fg("toolTitle", th.bold(this.padTo(title, innerW))) +
				border("│"),
		);
		lines.push(border("│") + this.renderTabs(innerW) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		if (this.activeTab === "diff") this.renderDiff(lines, innerW, body);
		else this.renderBrowse(lines, innerW, body);
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const help =
			this.activeTab === "diff" ? this.diffHelp() : this.browseHelp();
		lines.push(
			border("│") + th.fg("dim", this.padTo(help, innerW)) + border("│"),
		);
		lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
		return lines;
	}

	private renderDiff(lines: string[], innerW: number, body: number): void {
		const th = this.theme;
		const sidebarW = clamp(
			Math.floor(innerW * SIDEBAR_RATIO),
			SIDEBAR_MIN,
			SIDEBAR_MAX,
		);
		const diffTotalW = innerW - 1 - sidebarW;
		this.diffWidth = diffTotalW;
		this.diffScroll = clamp(this.diffScroll, 0, this.maxDiffScroll());
		const sepColour = this.diffFocus === "diff" ? "borderAccent" : "border";
		const sep = th.fg(sepColour, "│");
		const filesHeader =
			this.diffFocus === "list"
				? th.fg("accent", th.bold(this.padTo(" Files", sidebarW)))
				: th.fg("muted", this.padTo(" Files", sidebarW));
		const file = this.currentDiff();
		const stats = file ? `+${file.added} -${file.removed}` : "";
		const prefix = file
			? ` Unified diff · ${stats} · `
			: " Unified diff";
		const room = Math.max(1, diffTotalW - visibleWidth(prefix));
		const diffHeaderText = file
			? `${prefix}${truncatePathLeft(file.displayPath, room)}`
			: prefix;
		const headerColour = this.diffFocus === "diff" ? "accent" : "muted";
		const diffHeader = th.fg(
			headerColour,
			this.padTo(diffHeaderText, diffTotalW),
		);
		lines.push(
			th.fg("border", "│") +
				filesHeader +
				sep +
				diffHeader +
				th.fg("border", "│"),
		);

		const note = file?.note;
		const wrappedRows = file && !note
			? wrapUnifiedDiffRows(file.rows, diffTotalW)
			: [];
		const noteRow = note ? Math.floor(body / 2) : -1;
		for (let r = 0; r < body; r++) {
			const sidebarCell = this.renderDiffSidebarCell(
				sidebarW,
				this.listScroll + r,
			);
			let diffPart: string;
			if (this.files.length === 0) {
				const text =
					r === Math.floor(body / 2)
						? "  No session changes. Press Tab for Files."
						: "";
				diffPart = th.fg("muted", this.padTo(text, diffTotalW));
			} else if (note) {
				const text =
					r === noteRow
						? this.padTo(`  ${note}`, diffTotalW)
						: " ".repeat(diffTotalW);
				diffPart = th.fg("muted", text);
			} else {
				const row = wrappedRows[this.diffScroll + r];
				diffPart = row
					? this.renderUnifiedDiffLine(row, diffTotalW)
					: " ".repeat(diffTotalW);
			}
			lines.push(
				th.fg("border", "│") +
					sidebarCell +
					sep +
					diffPart +
					th.fg("border", "│"),
			);
		}
	}

	private renderBrowse(lines: string[], innerW: number, body: number): void {
		const th = this.theme;
		const treeW = clamp(
			Math.floor(innerW * BROWSE_SIDEBAR_RATIO),
			BROWSE_SIDEBAR_MIN,
			BROWSE_SIDEBAR_MAX,
		);
		const previewW = innerW - 1 - treeW;
		this.previewWidth = previewW;
		this.previewScroll = clamp(this.previewScroll, 0, this.maxPreviewScroll());
		const sepColour =
			this.browseFocus === "preview" ? "borderAccent" : "border";
		const sep = th.fg(sepColour, "│");
		const treeHeader =
			this.browseFocus === "tree"
				? th.fg("accent", th.bold(this.padTo(" Project tree", treeW)))
				: th.fg("muted", this.padTo(" Project tree", treeW));
		const preview = this.currentPreview();
		const previewLabel = ` Preview · ${truncatePathLeft(preview.title, Math.max(1, previewW - 11))}`;
		const previewHeader =
			this.browseFocus === "preview"
				? th.fg("accent", th.bold(this.padTo(previewLabel, previewW)))
				: th.fg("muted", this.padTo(previewLabel, previewW));
		lines.push(
			th.fg("border", "│") +
				treeHeader +
				sep +
				previewHeader +
				th.fg("border", "│"),
		);
		for (let r = 0; r < body; r++) {
			lines.push(
				th.fg("border", "│") +
					this.renderBrowseTreeCell(treeW, this.browseScroll + r) +
					sep +
					this.renderPreviewLine(previewW, r) +
					th.fg("border", "│"),
			);
		}
	}

	private diffHelp(): string {
		if (this.files.length === 0)
			return " Tab switch tabs · Esc close";
		return this.diffFocus === "list"
			? " Tab switch tabs · ↑↓ select file · Enter open · Space/→ diff · touchpad scroll · c clear · Esc close"
			: " Tab switch tabs · Enter open · ↑↓/touchpad scroll · PgUp/PgDn page · g/G top/bottom · ←/Esc back";
	}

	private browseHelp(): string {
		return this.browseFocus === "tree"
			? " Tab switch tabs · ↑↓ select · Enter open file · Space/→ preview · touchpad scroll · ← collapse/up · Esc close"
			: " Tab switch tabs · Enter open file · ↑↓/touchpad scroll · PgUp/PgDn page · ←/Esc tree";
	}
}

// ---------------------------------------------------------------------------
// Overlay launcher
// ---------------------------------------------------------------------------

let overlayOpen = false;

export function isOverlayOpen(): boolean {
	return overlayOpen;
}

export async function openOverlay(
	ctx: ExtensionContext,
	files: FileDiff[],
	mode: ReviewOpenMode,
	openFile: (file: FileDiff) => void,
	openBrowseFile: (absPath: string, displayPath: string) => void,
	onClosed?: (action: ReviewCloseAction) => void,
	restoredState?: ReviewOverlayState,
	saveState?: (state: ReviewOverlayState) => void,
): Promise<void> {
	if (overlayOpen) return;
	if (!ctx.hasUI) {
		ctx.ui.notify("Diff review needs the interactive UI.", "warning");
		return;
	}

	overlayOpen = true;
	let closeAction: ReviewCloseAction | undefined;
	const initialTab: ActiveTab =
		mode === "browse"
			? "browse"
			: mode === "diff"
				? "diff"
				: restoredState?.activeTab ??
					(files.length > 0 ? "diff" : "browse");
	try {
		closeAction = await ctx.ui.custom<ReviewCloseAction>(
			(tui, theme, _keybindings, done) =>
				new DiffBrowseOverlay(
					tui,
					theme,
					ctx.cwd,
					files,
					initialTab,
					(action) => done(action),
					openFile,
					openBrowseFile,
					restoredState,
					saveState,
				),
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
		);
	} finally {
		overlayOpen = false;
		if (closeAction) onClosed?.(closeAction);
	}
}
