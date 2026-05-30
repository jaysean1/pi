// Shared terminal UI formatting helpers.
// Not for business state or event registration.

import { isAbsolute, relative, resolve, sep } from "node:path";
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

export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
