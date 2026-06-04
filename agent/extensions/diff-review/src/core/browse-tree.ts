// Build the Files tree and preview rows.
// Not for full-screen overlay rendering state.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	DIFF_MARK_WIDTH,
	IGNORED_BROWSE_NAMES,
	LINE_NUM_WIDTH,
	MAX_BROWSE_CHILDREN,
	MAX_FILE_BYTES,
	UNIFIED_DIFF_PREFIX_WIDTH,
} from "./constants.ts";
import { displayPathFor, expandTabs, splitLines } from "./diff-engine.ts";
import type {
	BrowseNode,
	Cell,
	DiffRow,
	FilePreview,
	UnifiedDiffLine,
	WrappedDiffRow,
	WrappedPreviewLine,
} from "./types.ts";

function isIgnoredBrowseName(name: string): boolean {
	return IGNORED_BROWSE_NAMES.has(name);
}

export function createBrowseRoot(cwd: string): BrowseNode {
	const root: BrowseNode = {
		absPath: cwd,
		name: basename(cwd) || cwd,
		kind: "directory",
		depth: 0,
		expanded: true,
		loaded: false,
		children: [],
	};
	loadBrowseChildren(root);
	return root;
}

export function loadBrowseChildren(node: BrowseNode): void {
	if (node.kind !== "directory" || node.loaded) return;
	try {
		const entries = readdirSync(node.absPath, { withFileTypes: true })
			.filter((entry) => !isIgnoredBrowseName(entry.name))
			.filter((entry) => entry.isDirectory() || entry.isFile())
			.sort((a, b) => {
				const typeOrder = Number(b.isDirectory()) - Number(a.isDirectory());
				return typeOrder || a.name.localeCompare(b.name);
			});
		const visible = entries.slice(0, MAX_BROWSE_CHILDREN);
		node.children = visible.map((entry) => ({
			absPath: join(node.absPath, entry.name),
			name: entry.name,
			kind: entry.isDirectory() ? "directory" : "file",
			depth: node.depth + 1,
			expanded: false,
			loaded: false,
			children: [],
			parent: node,
		}));
		node.truncated = entries.length > visible.length;
		node.loaded = true;
		node.error = undefined;
	} catch (error) {
		node.children = [];
		node.loaded = true;
		node.error = error instanceof Error ? error.message : String(error);
	}
}

export function flattenBrowseTree(root: BrowseNode): BrowseNode[] {
	const nodes: BrowseNode[] = [];
	const visit = (node: BrowseNode) => {
		nodes.push(node);
		if (!node.expanded) return;
		if (!node.loaded) loadBrowseChildren(node);
		for (const child of node.children) visit(child);
	};
	visit(root);
	return nodes;
}

export function previewForNode(cwd: string, node: BrowseNode): FilePreview {
	const displayPath = displayPathFor(cwd, node.absPath);
	if (node.kind === "directory") {
		if (!node.loaded) loadBrowseChildren(node);
		const lines = [
			`${displayPath}/`,
			"",
			`${node.children.length} visible item${node.children.length === 1 ? "" : "s"}`,
		];
		if (node.truncated)
			lines.push(`Showing first ${MAX_BROWSE_CHILDREN} entries.`);
		if (node.error) lines.push(`Could not read directory: ${node.error}`);
		return { title: displayPath, lines };
	}

	try {
		const st = statSync(node.absPath);
		if (!st.isFile())
			return { title: displayPath, lines: [], note: "Not a regular file." };
		if (st.size > MAX_FILE_BYTES)
			return {
				title: displayPath,
				lines: [],
				note: "File too large - preview not shown.",
			};
		const buf = readFileSync(node.absPath);
		if (buf.includes(0))
			return {
				title: displayPath,
				lines: [],
				note: "Binary file - preview not shown.",
			};
		return { title: displayPath, lines: splitLines(buf.toString("utf8")) };
	} catch (error) {
		return {
			title: displayPath,
			lines: [],
			note: `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function wrapVisibleText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	if (text.length === 0) return [""];
	const rows: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const ch of text) {
		const chWidth = Math.max(1, visibleWidth(ch));
		if (current && currentWidth + chWidth > width) {
			rows.push(current);
			current = "";
			currentWidth = 0;
		}
		current += ch;
		currentWidth += chWidth;
	}
	rows.push(current);
	return rows;
}

export function wrapPreviewLines(
	lines: string[],
	width: number,
): WrappedPreviewLine[] {
	const textW = Math.max(1, width - LINE_NUM_WIDTH - 2);
	const wrapped: WrappedPreviewLine[] = [];
	lines.forEach((line, index) => {
		const parts = wrapVisibleText(expandTabs(line), textW);
		parts.forEach((part, partIndex) => {
			wrapped.push({
				num: partIndex === 0 ? index + 1 : undefined,
				text: part,
			});
		});
	});
	return wrapped;
}

function wrapDiffCell(cell: Cell, width: number): Cell[] {
	if (cell.type === "none" || cell.text === undefined) return [cell];
	const textW = Math.max(1, width - LINE_NUM_WIDTH - DIFF_MARK_WIDTH - 3);
	return wrapVisibleText(expandTabs(cell.text), textW).map((text, index) => ({
		...cell,
		num: index === 0 ? cell.num : undefined,
		text,
	}));
}

export function wrapDiffRows(
	rows: DiffRow[],
	leftWidth: number,
	rightWidth: number,
): WrappedDiffRow[] {
	const wrapped: WrappedDiffRow[] = [];
	for (const row of rows) {
		const left = wrapDiffCell(row.left, leftWidth);
		const right = wrapDiffCell(row.right, rightWidth);
		const span = Math.max(left.length, right.length);
		for (let i = 0; i < span; i++) {
			wrapped.push({
				left: left[i] ?? { type: "none" },
				right: right[i] ?? { type: "none" },
			});
		}
	}
	return wrapped;
}

function isContextRow(row: DiffRow): boolean {
	return row.left.type === "same" && row.right.type === "same";
}

function cellToUnifiedLine(
	type: "add" | "del",
	cell: Cell,
): UnifiedDiffLine | undefined {
	if (cell.text === undefined) return undefined;
	return type === "del"
		? { type, oldNum: cell.num, text: cell.text }
		: { type, newNum: cell.num, text: cell.text };
}

export function flattenUnifiedDiffRows(rows: DiffRow[]): UnifiedDiffLine[] {
	const lines: UnifiedDiffLine[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index];
		if (!row) break;
		if (isContextRow(row)) {
			lines.push({
				type: "same",
				oldNum: row.left.num,
				newNum: row.right.num,
				text: row.right.text ?? row.left.text ?? "",
			});
			index++;
			continue;
		}

		const deletions: UnifiedDiffLine[] = [];
		const additions: UnifiedDiffLine[] = [];
		while (index < rows.length && !isContextRow(rows[index]!)) {
			const changed = rows[index]!;
			if (changed.left.type === "del") {
				const line = cellToUnifiedLine("del", changed.left);
				if (line) deletions.push(line);
			}
			if (changed.right.type === "add") {
				const line = cellToUnifiedLine("add", changed.right);
				if (line) additions.push(line);
			}
			index++;
		}
		lines.push(...deletions, ...additions);
	}
	return lines;
}

export function wrapUnifiedDiffRows(
	rows: DiffRow[],
	width: number,
): UnifiedDiffLine[] {
	const textW = Math.max(1, width - UNIFIED_DIFF_PREFIX_WIDTH);
	const wrapped: UnifiedDiffLine[] = [];
	for (const line of flattenUnifiedDiffRows(rows)) {
		const parts = wrapVisibleText(expandTabs(line.text), textW);
		parts.forEach((part, partIndex) => {
			wrapped.push({
				...line,
				oldNum: partIndex === 0 ? line.oldNum : undefined,
				newNum: partIndex === 0 ? line.newNum : undefined,
				text: part,
			});
		});
	}
	return wrapped;
}
