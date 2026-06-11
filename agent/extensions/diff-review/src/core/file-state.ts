// Track file snapshots and persisted review state.
// Not for rendering diff or browse UI.

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_FILE_BYTES, PERSISTED_STATE_VERSION } from "./constants.ts";
import type {
	ChangeEntry,
	FileSnapshot,
	PersistedReviewState,
	SnapshotKind,
} from "./types.ts";

export function snapshotFile(absPath: string): FileSnapshot {
	try {
		const st = statSync(absPath);
		if (!st.isFile()) return { kind: "absent" };
		if (st.size > MAX_FILE_BYTES) return { kind: "toolarge" };
		const buf = readFileSync(absPath);
		if (buf.includes(0)) return { kind: "binary" };
		return { kind: "text", text: buf.toString("utf8") };
	} catch {
		// Missing file: treat as a creation (empty original).
		return { kind: "absent" };
	}
}

export function extractPath(args: unknown): string | undefined {
	let value: unknown = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const candidate =
		record.path ?? record.file_path ?? record.filePath ?? record.file;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: undefined;
}

// Resolve a tool-supplied path to an absolute path. Tracking is global: paths
// outside the current working directory are kept, not filtered out.
export function resolveInputPath(cwd: string, p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Persisted review state
// ---------------------------------------------------------------------------

function isSnapshotKind(value: unknown): value is SnapshotKind {
	return (
		value === "text" ||
		value === "absent" ||
		value === "binary" ||
		value === "toolarge" ||
		value === "skipped"
	);
}

function parseSnapshot(value: unknown): FileSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (!isSnapshotKind(record.kind)) return undefined;
	if (record.kind === "text") {
		if (typeof record.text !== "string") return undefined;
		return { kind: "text", text: record.text };
	}
	return { kind: record.kind };
}

function parseChangeEntry(value: unknown): ChangeEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const before = parseSnapshot(record.before);
	const after = parseSnapshot(record.after);
	return before && after ? { before, after } : undefined;
}

function reviewStateDir(): string {
	return join(getAgentDir(), "state", "diff-review");
}

function stateHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeStateLabel(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	return cleaned || "session";
}

function reviewStateFile(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const sessionId = ctx.sessionManager.getSessionId();
	const identity = sessionFile ?? sessionId ?? "unknown";
	const label = sessionFile
		? basename(sessionFile).replace(/\.jsonl$/i, "")
		: `memory-${sessionId ?? "unknown"}`;
	return join(reviewStateDir(), `${stateHash(identity)}-${safeStateLabel(label)}.json`);
}

export function loadPersistedChanges(ctx: ExtensionContext): Map<string, ChangeEntry> {
	const loaded = new Map<string, ChangeEntry>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(reviewStateFile(ctx), "utf8"));
	} catch {
		return loaded;
	}
	if (!parsed || typeof parsed !== "object") return loaded;
	const record = parsed as Record<string, unknown>;
	if (record.version !== PERSISTED_STATE_VERSION) return loaded;
	if (!Array.isArray(record.changes)) return loaded;
	for (const item of record.changes) {
		if (!Array.isArray(item) || item.length !== 2) continue;
		const [absPath, rawEntry] = item;
		if (typeof absPath !== "string" || absPath.length === 0) continue;
		const entry = parseChangeEntry(rawEntry);
		if (entry) loaded.set(absPath, entry);
	}
	return loaded;
}

export function replaceChanges(
	target: Map<string, ChangeEntry>,
	source: Map<string, ChangeEntry>,
): void {
	target.clear();
	for (const [absPath, entry] of source) target.set(absPath, entry);
}

export function clearPersistedChanges(ctx: ExtensionContext): void {
	try {
		unlinkSync(reviewStateFile(ctx));
	} catch (error) {
		if ((error as { code?: string } | undefined)?.code !== "ENOENT") throw error;
	}
}

export function persistChanges(
	ctx: ExtensionContext,
	changes: Map<string, ChangeEntry>,
): void {
	if (changes.size === 0) {
		clearPersistedChanges(ctx);
		return;
	}
	const sessionFile = ctx.sessionManager.getSessionFile();
	const payload: PersistedReviewState = {
		version: PERSISTED_STATE_VERSION,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile,
		updatedAt: new Date().toISOString(),
		changes: Array.from(changes.entries()),
	};
	const dir = reviewStateDir();
	const target = reviewStateFile(ctx);
	const tmp = `${target}.${process.pid}.tmp`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
	renameSync(tmp, target);
}
