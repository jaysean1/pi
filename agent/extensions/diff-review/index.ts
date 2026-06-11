// Diff-review extension entry point.
// Not for diff rendering internals.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, Focusable } from "@earendil-works/pi-tui";
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
import { isOverlayOpen, openOverlay } from "./src/ui/overlay.ts";
import { DiffReviewWidget } from "./src/ui/widget.ts";

// aboveEditor widget key. The diff entry is a passive status line rendered just
// above the input (the slot the now-disabled youtube-music bar used to occupy).
const WIDGET_KEY = "diff-review";

export default function diffReviewExtension(pi: ExtensionAPI) {
	let debugKeysUntil = 0;
	let persistWarningShown = false;
	let activeWidget: DiffReviewWidget | undefined;
	let activeEditor: (EditorComponent & Partial<Focusable>) | undefined;
	// Session-cumulative change set, keyed by absolute path.
	const changes = new Map<string, ChangeEntry>();

	const refreshReviewWidget = () => {
		activeWidget?.requestRender();
	};

	// Keep the diff status line pinned to the very bottom of the aboveEditor stack
	// (directly above the input), unaffected by the rpiv-todo overlay. setWidget
	// removes-then-reinserts the key, so re-calling pinWidget moves us to the end of
	// pi's aboveEditor map. The todo overlay re-registers its own widget when the
	// `todo` tool runs and on session churn, which would otherwise push us up; we
	// re-pin on a deferred macrotask so we settle *after* the todo overlay's
	// synchronous re-registration, with a second pass to heal async churn (theme
	// switch / cell-size invalidations).
	const repinTimers = new Set<ReturnType<typeof setTimeout>>();
	const pinWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				activeWidget = new DiffReviewWidget(tui, theme, {
					getFiles: () => buildFileDiffs(ctx.cwd, changes),
				});
				return activeWidget;
			},
			{ placement: "aboveEditor" },
		);
	};
	const schedulePin = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		for (const t of repinTimers) clearTimeout(t);
		repinTimers.clear();
		for (const delay of [0, 150]) {
			const timer = setTimeout(() => {
				repinTimers.delete(timer);
				try {
					pinWidget(ctx);
				} catch {}
			}, delay);
			timer.unref?.();
			repinTimers.add(timer);
		}
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
			refreshReviewWidget();
		}
	};

	const saveChanges = (ctx: ExtensionContext) => {
		try {
			persistChanges(ctx, changes);
		} catch (error) {
			warnPersistFailure(ctx, "save", error);
		} finally {
			refreshReviewWidget();
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
		refreshReviewWidget();
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

	// Capture original content before a write/edit runs, then latest content after
	// it succeeds. Only write/edit are tracked: bash and other tools never touch
	// the review set, keeping it free of generated/process-file noise.
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

	// Keep the diff status line pinned directly above the input. The rpiv-todo
	// overlay registers/re-registers its widget when the `todo` tool runs and on
	// session churn, which would push us up the aboveEditor stack; re-pinning
	// afterwards moves us back to the bottom (closest to the input) with the todo
	// list above us. Turn/agent boundaries are natural settle points that catch any
	// todo create/complete/hide churn during a turn.
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "todo" && !event.isError) schedulePin(ctx);
	});
	pi.on("session_compact", (_event, ctx) => schedulePin(ctx));
	pi.on("session_tree", (_event, ctx) => schedulePin(ctx));
	pi.on("agent_start", (_event, ctx) => schedulePin(ctx));
	pi.on("agent_end", (_event, ctx) => schedulePin(ctx));
	pi.on("turn_end", (_event, ctx) => schedulePin(ctx));

	// Two layers make the hotkey reliable across terminals, mirroring the
	// session-footer-switcher extension: a raw-input safety net plus an editor
	// wrapper that catches the key while the editor has focus.
	pi.on("session_start", (_event, ctx) => {
		loadChanges(ctx);
		if (!ctx.hasUI) return;

		// Pin the diff status line directly above the input (the slot the now-disabled
		// youtube-music bar used to occupy). Pin immediately for first-frame display,
		// then re-pin after the dispatch settles so we sit *below* any aboveEditor
		// widget the rpiv-todo overlay registers in its own session_start handler. The
		// stack settles as [todo list] / [diff status] / [input].
		pinWidget(ctx);
		schedulePin(ctx);

		// Raw terminal input safety net for the open-review shortcut (more reliable
		// across terminals than the registered shortcut alone). Also powers
		// /review debug-keys. Stays passive while the overlay is open so the overlay
		// owns its own keys. No focus handling — the widget is a passive status line.
		const unsubInput = ctx.ui.onTerminalInput((data) => {
			if (Date.now() <= debugKeysUntil) {
				ctx.ui.notify(
					`key: ${describeKeyInput(data)}`,
					isToggleKey(data) ? "info" : "warning",
				);
			}
			if (isOverlayOpen()) return undefined;
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
			activeEditor = new EditorShortcutBridge(base, () => open(ctx));
			return activeEditor;
		});

		pi.on("session_shutdown", () => {
			for (const t of repinTimers) clearTimeout(t);
			repinTimers.clear();
			unsubInput();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			activeWidget = undefined;
			activeEditor = undefined;
		});
	});
}
