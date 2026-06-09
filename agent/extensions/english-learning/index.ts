import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, Focusable } from "@earendil-works/pi-tui";
import { cancelInputOptimization, optimizeCurrentInput } from "./src/actions/optimize-input.ts";
import {
	closeTranslationOverlay,
	isTranslationOverlayOpen,
	openOrToggleTranslation,
} from "./src/actions/translate-last.ts";
import { COMMAND_NAME, EXTENSION_ID, TRANSLATE_KEY } from "./src/core/config.ts";
import { formatModelChoice, resolveModel } from "./src/core/model-resolver.ts";
import { clearTranslationCache, getTranslationCacheStats } from "./src/core/translation-cache.ts";
import { describeKeyInput, isTranslateToggleKey, isTranslateToggleKeyPress } from "./src/platform/keys.ts";
import { EnglishEditorBridge } from "./src/ui/editor-bridge.ts";

type Cleanup = () => void;
const GLOBAL_STATE_KEY = "__englishLearningExtensionState";

interface GlobalState {
	cleanup?: Cleanup;
}

function globalState(): GlobalState {
	const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: GlobalState };
	return (root[GLOBAL_STATE_KEY] ??= {});
}

export default function englishLearningExtension(pi: ExtensionAPI) {
	let debugKeysUntil = 0;
	let activeEditor: (EditorComponent & Partial<Focusable>) | undefined;
	let lastShortcutToggleAt = 0;
	const state = globalState();

	const openTranslation = (ctx: ExtensionContext, force = false) => {
		void openOrToggleTranslation(ctx, { force });
	};

	const toggleTranslationFromShortcut = (ctx: ExtensionContext) => {
		const now = Date.now();
		if (now - lastShortcutToggleAt < 200) return;
		lastShortcutToggleAt = now;
		openTranslation(ctx);
	};

	const translateShortcut = {
		description: "Translate the last English assistant response segment-by-segment",
		handler: (ctx: ExtensionContext) => toggleTranslationFromShortcut(ctx),
	};
	pi.registerShortcut(TRANSLATE_KEY, translateShortcut);

	pi.registerCommand(COMMAND_NAME, {
		description: "English learning tools: optimize input and translate last response",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";
			if (sub === "translate" || sub === "t") {
				await openOrToggleTranslation(ctx, { force: parts.includes("--force") });
				return;
			}
			if (sub === "status") {
				const cache = getTranslationCacheStats();
				ctx.ui.notify(
					[
						`English learning ${isTranslationOverlayOpen() ? "translation overlay open" : "ready"}.`,
						`Rewrite model: ${formatModelChoice(resolveModel(ctx, "rewrite"))}`,
						`Translate model: ${formatModelChoice(resolveModel(ctx, "translate"))}`,
						`Translation cache: ${cache.size}/${cache.maxSize}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "cancel" || sub === "close") {
				cancelInputOptimization();
				closeTranslationOverlay();
				ctx.ui.setStatus(EXTENSION_ID, undefined);
				ctx.ui.notify("English learning operations cancelled.", "info");
				return;
			}
			if (sub === "clear-cache") {
				clearTranslationCache();
				ctx.ui.notify("English learning translation cache cleared.", "info");
				return;
			}
			if (sub === "debug-keys") {
				debugKeysUntil = Date.now() + 10_000;
				ctx.ui.notify("Key debug on for 10s. Press Command+Shift+M now.", "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /english status, /english translate [--force], /english cancel, /english clear-cache, /english debug-keys",
				"info",
			);
		},
	});

	pi.on("session_shutdown", () => {
		state.cleanup?.();
		state.cleanup = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Match session-footer-switcher: dispose any stale runtime hooks before
		// installing the current version. This prevents duplicate raw-input/editor
		// bridges after /reload or session replacement.
		state.cleanup?.();
		state.cleanup = undefined;

		const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (Date.now() <= debugKeysUntil) {
				ctx.ui.notify(
					`key: ${describeKeyInput(data)}`,
					isTranslateToggleKey(data) ? "info" : "warning",
				);
			}
			if (isTranslateToggleKey(data)) {
				if (isTranslateToggleKeyPress(data)) toggleTranslationFromShortcut(ctx);
				return { consume: true };
			}
			return undefined;
		});

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const base =
				previousFactory?.(tui, editorTheme, keybindings) ??
				new CustomEditor(tui, editorTheme, keybindings);
			activeEditor = new EnglishEditorBridge(base, {
				onOptimize: (editor) => {
					void optimizeCurrentInput(ctx, editor);
				},
				onTranslateToggle: () => toggleTranslationFromShortcut(ctx),
			});
			return activeEditor;
		});

		let cleaned = false;
		state.cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			unsubscribeInput();
			cancelInputOptimization();
			ctx.ui.setStatus(EXTENSION_ID, undefined);
			ctx.ui.setEditorComponent(previousFactory);
			activeEditor = undefined;
		};
	});
}
