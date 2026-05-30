// Build text diffs and compact diff metadata.
// Not for filesystem persistence or Pi event registration.

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { LCS_BUDGET, TAB_WIDTH } from "./constants.ts";
import type {
	ChangeEntry,
	Cell,
	DiffRow,
	DiffStats,
	FileDiff,
	FileSnapshot,
} from "./types.ts";

export function splitLines(text: string): string[] {
	const lines = text
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (
		lines.length > 1 &&
		lines[lines.length - 1] === "" &&
		text.endsWith("\n")
	) {
		lines.pop();
	}
	return lines;
}

export function expandTabs(text: string): string {
	return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

interface Op {
	type: "eq" | "del" | "ins";
	a?: number;
	b?: number;
}

function lcsOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	const dp: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		const row = dp[i] ?? new Uint32Array(m + 1);
		const next = dp[i + 1] ?? new Uint32Array(m + 1);
		for (let j = m - 1; j >= 0; j--) {
			row[j] =
				a[i] === b[j]
					? (next[j + 1] ?? 0) + 1
					: Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: "eq", a: i, b: j });
			i++;
			j++;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			ops.push({ type: "del", a: i });
			i++;
		} else {
			ops.push({ type: "ins", b: j });
			j++;
		}
	}
	while (i < n) ops.push({ type: "del", a: i++ });
	while (j < m) ops.push({ type: "ins", b: j++ });
	return ops;
}

function blockReplaceOps(a: string[], b: string[]): Op[] {
	const ops: Op[] = [];
	for (let i = 0; i < a.length; i++) ops.push({ type: "del", a: i });
	for (let j = 0; j < b.length; j++) ops.push({ type: "ins", b: j });
	return ops;
}

export function buildDiff(
	before: FileSnapshot,
	after: FileSnapshot,
): { rows: DiffRow[]; added: number; removed: number; note?: string } {
	if (before.kind === "binary" || after.kind === "binary") {
		return {
			rows: [],
			added: 0,
			removed: 0,
			note: "Binary file — diff not shown.",
		};
	}
	if (before.kind === "toolarge" || after.kind === "toolarge") {
		return {
			rows: [],
			added: 0,
			removed: 0,
			note: "File too large — diff not shown.",
		};
	}

	const a = before.kind === "text" ? splitLines(before.text ?? "") : [];
	const b = after.kind === "text" ? splitLines(after.text ?? "") : [];

	// Trim common prefix and suffix so the costly LCS runs only on the changed middle.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const midOps =
		midA.length * midB.length > LCS_BUDGET
			? blockReplaceOps(midA, midB)
			: lcsOps(midA, midB);

	const ops: Op[] = [];
	for (let i = 0; i < start; i++) ops.push({ type: "eq", a: i, b: i });
	for (const op of midOps) {
		ops.push({
			type: op.type,
			a: op.a !== undefined ? op.a + start : undefined,
			b: op.b !== undefined ? op.b + start : undefined,
		});
	}
	for (let k = 0; endA + k < a.length; k++)
		ops.push({ type: "eq", a: endA + k, b: endB + k });

	const rows: DiffRow[] = [];
	let added = 0;
	let removed = 0;
	let p = 0;
	while (p < ops.length) {
		const op = ops[p];
		if (!op) break;
		if (op.type === "eq") {
			const aIndex = op.a ?? 0;
			const bIndex = op.b ?? 0;
			rows.push({
				left: { type: "same", num: aIndex + 1, text: a[aIndex] ?? "" },
				right: { type: "same", num: bIndex + 1, text: b[bIndex] ?? "" },
			});
			p++;
			continue;
		}
		const dels: Op[] = [];
		while (p < ops.length && ops[p]?.type === "del") {
			const next = ops[p++];
			if (next) dels.push(next);
		}
		const inss: Op[] = [];
		while (p < ops.length && ops[p]?.type === "ins") {
			const next = ops[p++];
			if (next) inss.push(next);
		}
		const span = Math.max(dels.length, inss.length);
		for (let x = 0; x < span; x++) {
			const d = dels[x];
			const s = inss[x];
			if (d) removed++;
			if (s) added++;
			const dIndex = d?.a ?? 0;
			const sIndex = s?.b ?? 0;
			rows.push({
				left: d
					? { type: "del", num: dIndex + 1, text: a[dIndex] ?? "" }
					: { type: "none" },
				right: s
					? { type: "add", num: sIndex + 1, text: b[sIndex] ?? "" }
					: { type: "none" },
			});
		}
	}

	return { rows, added, removed };
}

export function displayPathFor(cwd: string, absPath: string): string {
	const rel = relative(cwd, absPath);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const fromHome = relative(homedir(), absPath);
	if (fromHome && !fromHome.startsWith("..") && !isAbsolute(fromHome))
		return `~/${fromHome}`;
	return absPath;
}

// Truncate a path from the left so the file name (right side) stays visible.
export function truncatePathLeft(text: string, width: number): string {
	if (width <= 1) return truncateToWidth(text, width);
	if (visibleWidth(text) <= width) return text;
	let tail = text;
	while (tail.length > 0 && visibleWidth(tail) > width - 1)
		tail = tail.slice(1);
	return `…${tail}`;
}

export function buildFileDiffs(
	cwd: string,
	changes: Map<string, ChangeEntry>,
): FileDiff[] {
	const files: FileDiff[] = [];
	for (const [absPath, entry] of changes) {
		const { rows, added, removed, note } = buildDiff(entry.before, entry.after);
		if (!note && added === 0 && removed === 0) continue; // No net change: hide it.
		files.push({
			absPath,
			displayPath: displayPathFor(cwd, absPath),
			rows,
			added,
			removed,
			isNew: entry.before.kind === "absent" && entry.after.kind !== "absent",
			note,
		});
	}
	files.sort((x, y) => x.displayPath.localeCompare(y.displayPath));
	return files;
}

export function diffStats(files: FileDiff[]): DiffStats {
	return files.reduce<DiffStats>(
		(acc, file) => ({
			files: acc.files + 1,
			added: acc.added + file.added,
			removed: acc.removed + file.removed,
		}),
		{ files: 0, added: 0, removed: 0 },
	);
}

export function fileChangeLabel(count: number): string {
	return `${count} file change${count === 1 ? "" : "s"}`;
}
