// Shared diff-review data shapes.
// Not for runtime logic or Pi UI registration.

export type SnapshotKind = "text" | "absent" | "binary" | "toolarge" | "skipped";

export interface FileSnapshot {
	kind: SnapshotKind;
	text?: string;
}

export interface ChangeEntry {
	before: FileSnapshot;
	after: FileSnapshot;
}

export interface PersistedReviewState {
	version: number;
	sessionId?: string;
	sessionFile?: string;
	updatedAt: string;
	changes: Array<[string, ChangeEntry]>;
}

export type CellType = "same" | "add" | "del" | "none";

export interface Cell {
	type: CellType;
	num?: number;
	text?: string;
}

export interface DiffRow {
	left: Cell;
	right: Cell;
}

export interface FileDiff {
	absPath?: string;
	displayPath: string;
	rows: DiffRow[];
	added: number;
	removed: number;
	isNew?: boolean;
	note?: string;
}

export type Focus = "list" | "diff";
export type ActiveTab = "diff" | "browse";
export type BrowseFocus = "tree" | "preview";
export type BrowseNodeKind = "directory" | "file";
export type ReviewOpenMode = "auto" | "diff" | "browse";
export type ReviewCloseAction = "dismiss" | "clear";

export interface BrowseNode {
	absPath: string;
	name: string;
	kind: BrowseNodeKind;
	depth: number;
	expanded: boolean;
	loaded: boolean;
	children: BrowseNode[];
	parent?: BrowseNode;
	error?: string;
	truncated?: boolean;
}

export interface FilePreview {
	title: string;
	lines: string[];
	note?: string;
}

export interface WrappedPreviewLine {
	num?: number;
	text: string;
}

export interface WrappedDiffRow {
	left: Cell;
	right: Cell;
}

export type UnifiedDiffLineType = "same" | "add" | "del";

export interface UnifiedDiffLine {
	type: UnifiedDiffLineType;
	oldNum?: number;
	newNum?: number;
	text: string;
}

export interface DiffStats {
	files: number;
	added: number;
	removed: number;
}
