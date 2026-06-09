import type { TranslationSegment } from "../types.ts";

export const REWRITE_SYSTEM_PROMPT = `You rewrite user input into natural, concise English.

Rules:
- If the input is Chinese, translate it into natural English.
- If the input is English, improve grammar, tone, and clarity.
- Preserve meaning, constraints, file paths, code, commands, URLs, numbers, keyboard shortcuts, and technical terms.
- Do not answer the user's request.
- Do not add explanations.
- Return only the rewritten English text.`;

export const TRANSLATE_SYSTEM_PROMPT = `You are a professional English-to-Simplified-Chinese translator for language learning.

You will receive independent text segments with numeric ids. Translate each segment into natural Simplified Chinese.

Rules:
- Output one tag per translated segment, exactly in this form: <t id="SEGMENT_ID">中文翻译</t>
- Preserve Markdown meaning and list markers when they are part of the segment.
- Preserve inline code, identifiers, file paths, commands, URLs, numbers, and keyboard shortcuts exactly when possible.
- Do not translate code identifiers or inline code.
- Do not translate or mention code blocks; code blocks are intentionally omitted from the translation request.
- Do not summarize.
- Do not explain.
- Return only <t id="...">...</t> tags.`;

export function buildTranslateUserPrompt(segments: TranslationSegment[]): string {
	const translatable = segments.filter((segment) => segment.translatable);
	return [
		"Translate these segments independently. Keep the same ids.",
		"",
		...translatable.map((segment) =>
			[
				`<segment id="${segment.id}" kind="${segment.kind}">`,
				segment.source,
				"</segment>",
			].join("\n"),
		),
	].join("\n");
}
