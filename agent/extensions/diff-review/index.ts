// Diff-review extension entry point.
// Not for diff rendering internals.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	COMMAND_DEMO,
	COMMAND_OPEN,
	TOGGLE_KEY,
	TRACKED_TOOLS,
} from "./src/core/constants.ts";
import type { ChangeEntry, ReviewOpenMode } from "./src/core/types.ts";
import { buildFileDiffs } from "./src/core/diff-engine.ts";
import {
	clearPersistedChanges,
	extractPath,
	loadPersistedChanges,
	persistChanges,
	replaceChanges,
	resolveInputPath,
	snapshotFile,
} from "./src/core/file-state.ts";
import { demoFiles } from "./src/demo.ts";
import { describeKeyInput, isToggleKey } from "./src/platform/keys.ts";
import { openExternalFile, openReviewedFile } from "./src/platform/launcher.ts";
import { EditorShortcutBridge } from "./src/ui/editor-bridge.ts";
import { DiffReviewFooter } from "./src/ui/footer.ts";
import { isOverlayOpen, openOverlay } from "./src/ui/overlay.ts";

export default function diffReviewExtension(pi: ExtensionAPI) {
	let debugKeysUntil = 0;
	let persistWarningShown = false;
	let activeFooter: DiffReviewFooter | undefined;
	let activeEditor: (EditorComponent & Partial<Focusable>) | undefined;
	// Session-cumulative change set, keyed by absolute path.
	const changes = new Map<string, ChangeEntry>();

	const focusReviewFooter = (): boolean => {
		if (!activeFooter) return false;
		activeFooter.focus();
		return true;
	};

	const refreshReviewFooter = () => {
		activeFooter?.requestRender();
	};

	const warnPersistFailure = (
		ctx: ExtensionContext,
		action: "load" | "save" | "clear",
		error: unknown,
	) => {
		if (persistWarningShown) return;
		persistWarningShown = true;
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Diff review could not ${action} saved state: ${message}`, "warning");
	};

	const loadChanges = (ctx: ExtensionContext) => {
		try {
			replaceChanges(changes, loadPersistedChanges(ctx));
			persistWarningShown = false;
		} catch (error) {
			replaceChanges(changes, new Map());
			warnPersistFailure(ctx, "load", error);
		} finally {
			refreshReviewFooter();
		}
	};

	const saveChanges = (ctx: ExtensionContext) => {
		try {
			persistChanges(ctx, changes);
		} catch (error) {
			warnPersistFailure(ctx, "save", error);
		} finally {
			refreshReviewFooter();
		}
	};

	const clearChanges = (ctx: ExtensionContext) => {
		const tracked = buildFileDiffs(ctx.cwd, changes);
		const total = changes.size;
		changes.clear();
		try {
			clearPersistedChanges(ctx);
		} catch (error) {
			warnPersistFailure(ctx, "clear", error);
		}
		ctx.ui.notify(
			`Cleared ${total} tracked file(s); ${tracked.length} had changes to review.`,
			"info",
		);
		refreshReviewFooter();
	};

	const open = (ctx: ExtensionContext, mode: ReviewOpenMode = "auto") => {
		const files = buildFileDiffs(ctx.cwd, changes);
		void openOverlay(
			ctx,
			files,
			mode,
			(file) => openReviewedFile(pi, ctx, file),
			(absPath, displayPath) => openExternalFile(pi, ctx, absPath, displayPath),
			(action) => {
				if (action === "clear") clearChanges(ctx);
			},
		);
	};

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Open the diff review overlay",
		handler: (ctx) => open(ctx),
	});

	pi.registerCommand(COMMAND_OPEN, {
		description: "Review files created or modified in this session",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "debug-keys") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Key debug needs the interactive UI.", "warning");
					return;
				}
				debugKeysUntil = Date.now() + 10_000;
				ctx.ui.notify(
					"Key debug on for 10s. Press Command+Shift+Right now.",
					"info",
				);
				return;
			}
			if (sub === "status") {
				const tracked = buildFileDiffs(ctx.cwd, changes);
				ctx.ui.notify(
					`Tracking ${changes.size} file(s); ${tracked.length} with changes to review.`,
					"info",
				);
				return;
			}
			if (sub === "clear") {
				clearChanges(ctx);
				return;
			}
			if (sub === "browse" || sub === "diff") {
				open(ctx, sub);
				return;
			}
			if (sub) {
				ctx.ui.notify(
					"Usage: /review, /review browse, /review diff, /review status, /review clear, or /review debug-keys",
					"error",
				);
				return;
			}
			open(ctx);
		},
	});

	pi.registerCommand(COMMAND_DEMO, {
		description: "Open the diff review overlay with sample data",
		handler: async (_args, ctx) => {
			void openOverlay(
				ctx,
				demoFiles(),
				"diff",
				(file) => openReviewedFile(pi, ctx, file),
				(absPath, displayPath) =>
					openExternalFile(pi, ctx, absPath, displayPath),
			);
		},
	});

	// Capture the original content before a write/edit runs, then the latest
	// content after it succeeds. tool_call and tool_result carry validated args
	// (an object with the path) and are the same hooks the git-checkpoint example
	// uses, unlike tool_execution_* which can carry raw arguments.
	pi.on("tool_call", (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		const raw = extractPath(event.input);
		if (!raw) return;
		const absPath = resolveInputPath(ctx.cwd, raw);
		if (!changes.has(absPath)) {
			// Initialise after == before so a tool that errors without writing leaves
			// no net change and is filtered out. tool_result updates after on success.
			const baseline = snapshotFile(absPath);
			changes.set(absPath, { before: baseline, after: baseline });
			saveChanges(ctx);
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName) || event.isError) return;
		const raw = extractPath(event.input);
		if (!raw) return;
		const absPath = resolveInputPath(ctx.cwd, raw);
		let entry = changes.get(absPath);
		if (!entry) {
			// tool_call did not record a baseline; treat the prior state as empty.
			entry = { before: { kind: "absent" }, after: { kind: "absent" } };
			changes.set(absPath, entry);
		}
		entry.after = snapshotFile(absPath);
		saveChanges(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		saveChanges(ctx);
	});

	// Two layers make the hotkey reliable across terminals, mirroring the
	// session-footer-switcher extension: a raw-input safety net plus an editor
	// wrapper that catches the key while the editor has focus.
	pi.on("session_start", (_event, ctx) => {
		loadChanges(ctx);
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const component = new DiffReviewFooter(
				tui,
				theme,
				ctx,
				footerData,
				() => buildFileDiffs(ctx.cwd, changes),
				() => open(ctx),
				() => {
					if (!activeEditor) return;
					tui.setFocus(activeEditor);
					tui.requestRender();
				},
			);
			activeFooter = component;
			return component;
		});

		// Layer 1: raw terminal input. Also powers /review debug-keys. It stays
		// passive while the overlay is open so the overlay owns its own keys.
		const unsubInput = ctx.ui.onTerminalInput((data) => {
			if (Date.now() <= debugKeysUntil) {
				ctx.ui.notify(
					`key: ${describeKeyInput(data)}`,
					isToggleKey(data) ? "info" : "warning",
				);
			}
			if (isOverlayOpen()) return undefined;
			if (
				activeFooter &&
				activeEditor?.focused === true &&
				!activeFooter.focused &&
				matchesKey(data, Key.down) &&
				ctx.ui.getEditorText().trim().length === 0
			) {
				activeFooter.focus();
				return { consume: true };
			}
			if (isToggleKey(data)) {
				open(ctx);
				return { consume: true };
			}
			return undefined;
		});

		// Layer 2: wrap the editor so the key is caught while the editor has focus.
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const base =
				previousFactory?.(tui, editorTheme, keybindings) ??
				new CustomEditor(tui, editorTheme, keybindings);
			activeEditor = new EditorShortcutBridge(
				base,
				() => open(ctx),
				focusReviewFooter,
			);
			return activeEditor;
		});

		pi.on("session_shutdown", () => {
			unsubInput();
			ctx.ui.setFooter(undefined);
			activeFooter = undefined;
			activeEditor = undefined;
		});
	});
}
