import type { TranslationDirection } from "../types.ts";

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_RE = /[A-Za-z]/g;
const LETTER_RE = /[A-Za-z\u3400-\u9fff\uf900-\ufaff]/g;

export function stripFencedCodeBlocks(text: string): string {
	return text
		.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "")
		.replace(/<pre[\s\S]*?<\/pre>/gi, "");
}

export function isLikelyEnglish(text: string): boolean {
	const withoutCode = stripFencedCodeBlocks(text);
	const letters = withoutCode.match(LETTER_RE)?.length ?? 0;
	if (letters < 5) return false;
	const latin = withoutCode.match(LATIN_RE)?.length ?? 0;
	const cjk = withoutCode.match(CJK_RE)?.length ?? 0;
	return latin / Math.max(1, letters) >= 0.55 && cjk / Math.max(1, withoutCode.length) < 0.12;
}

export function detectTranslationDirection(text: string): TranslationDirection {
	const withoutCode = stripFencedCodeBlocks(text);
	const latin = withoutCode.match(LATIN_RE)?.length ?? 0;
	const cjk = withoutCode.match(CJK_RE)?.length ?? 0;
	const letters = latin + cjk;

	// Treat Chinese-only snippets and meaningful Chinese presence as Chinese-first
	// even when mixed with English identifiers, paths, commands, or product names.
	if (cjk > 0 && latin === 0) return "zh-to-en";
	if (cjk >= 4 && cjk / Math.max(1, letters) >= 0.2) return "zh-to-en";
	return "en-to-zh";
}

export function shouldSkipInputRewrite(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed) return true;
	// Do not rewrite slash commands or user bash commands. Passing Tab through
	// preserves Pi's built-in completion for these special input modes.
	return trimmed.startsWith("/") || trimmed.startsWith("!");
}

export function normalizeRewriteOutput(text: string): string {
	let result = text.trim();
	result = result.replace(/^```(?:\w+)?\s*/, "").replace(/```$/, "").trim();
	if (
		(result.startsWith('"') && result.endsWith('"')) ||
		(result.startsWith("“") && result.endsWith("”"))
	) {
		result = result.slice(1, -1).trim();
	}
	return result;
}

export function estimateMaxTokensFromChars(chars: number, ceiling: number | undefined): number {
	const estimated = Math.ceil(chars / 2.2) + 700;
	const clamped = Math.max(1024, Math.min(12_000, estimated));
	return Math.min(ceiling ?? clamped, clamped);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
