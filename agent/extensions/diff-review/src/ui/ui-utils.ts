// Diff-review terminal UI formatting helpers (diff colours + action button).
// Generic statusline helpers (cwd/tokens/status) now live in the statusline
// extension's render-utils. Not for business state or event registration.

import type { Theme } from "@earendil-works/pi-coding-agent";

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function ansiFg(theme: Theme, truecolor: string, fallback256: number): string {
	return theme.getColorMode() === "truecolor"
		? truecolor
		: `\x1b[38;5;${fallback256}m`;
}

export function colourBlindDiff(
	theme: Theme,
	type: "add" | "del",
	text: string,
): string {
	// Okabe-Ito colour-blind-safe pair for light terminals:
	// addition = blue, deletion = vermillion/orange. The A+/D- tags avoid relying on colour alone.
	const ansi =
		type === "add"
			? ansiFg(theme, "\x1b[38;2;0;114;178m", 25)
		: ansiFg(theme, "\x1b[38;2;213;94;0m", 166);
	return `${ansi}${theme.bold(text)}\x1b[39m`;
}

export function actionBlue(theme: Theme, text: string): string {
	return `${ansiFg(theme, "\x1b[38;2;86;156;214m", 75)}${text}\x1b[39m`;
}
