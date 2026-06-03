// statusline — owns the footer surface and renders the generic session status:
//   line 1: working directory (+ git branch, + session name)
//   line 2: token/cost stats · (provider) model • <reasoning effort, colored>
//   line 3+: extension status lines contributed via ctx.ui.setStatus()
//
// This is intentionally feature-agnostic. Interactive affordances (e.g. the
// diff-review entry) live in their own extensions as belowEditor widgets; this
// extension never reaches into them.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StatuslineFooter } from "./src/footer.ts";

export default function statuslineExtension(pi: ExtensionAPI) {
	let activeFooter: StatuslineFooter | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Take ownership of the footer for this session. setFooter replaces the
		// built-in footer and disposes any previous custom footer for us.
		ctx.ui.setFooter(
			(tui, theme, footerData) => {
				activeFooter = new StatuslineFooter(
					tui,
					theme,
					ctx,
					footerData,
					() => pi.getThinkingLevel(),
				);
				return activeFooter;
			},
		);
	});

	// Restore the built-in footer when this session/runtime goes away.
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
		activeFooter = undefined;
	});

	// Repaint immediately when the model or its thinking level changes (Ctrl+P
	// cycling, /model, /think, session restore, …). Token/cost/context stats are
	// already refreshed by the app's render loop during streaming.
	const refresh = () => activeFooter?.requestRender();
	pi.on("model_select", () => refresh());
	pi.on("thinking_level_select", () => refresh());
}
