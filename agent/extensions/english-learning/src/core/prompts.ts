import type { TranslationDirection, TranslationSegment } from "../types.ts";

export const REWRITE_SYSTEM_PROMPT = `You rewrite user input into natural, concise English.

Rules:
- If the input is Chinese, translate it into natural English.
- If the input is English, improve grammar, tone, and clarity.
- Preserve meaning, constraints, file paths, code, commands, URLs, numbers, keyboard shortcuts, and technical terms.
- Do not answer the user's request.
- Do not add explanations.
- Return only the rewritten English text.`;

export interface TranslationDirectionLabels {
	sourceLanguageLabel: string;
	targetLanguageLabel: string;
	targetLanguageInstruction: string;
	tagExample: string;
}

export function getTranslationDirectionLabels(
	direction: TranslationDirection,
): TranslationDirectionLabels {
	return direction === "zh-to-en"
		? {
			sourceLanguageLabel: "Chinese",
			targetLanguageLabel: "English",
			targetLanguageInstruction: "natural English",
			tagExample: "English translation",
		}
		: {
			sourceLanguageLabel: "English",
			targetLanguageLabel: "Simplified Chinese",
			targetLanguageInstruction: "natural Simplified Chinese",
			tagExample: "中文翻译",
		};
}

export function buildTranslateSystemPrompt(direction: TranslationDirection): string {
	const labels = getTranslationDirectionLabels(direction);
	return `You are a professional ${labels.sourceLanguageLabel}-to-${labels.targetLanguageLabel} translator for language learning.

You will receive independent text segments with numeric ids. Translate each segment into ${labels.targetLanguageInstruction}.

Rules:
- Output one tag per translated segment, exactly in this form: <t id="SEGMENT_ID">${labels.tagExample}</t>
- Preserve Markdown meaning and list markers when they are part of the segment.
- Preserve inline code, identifiers, file paths, commands, URLs, numbers, and keyboard shortcuts exactly when possible.
- Do not translate code identifiers or inline code.
- Do not translate or mention code blocks; code blocks are intentionally omitted from the translation request.
- Do not summarize.
- Do not explain.
- Return only <t id="...">...</t> tags.`;
}

export function buildTranslateUserPrompt(
	segments: TranslationSegment[],
	direction: TranslationDirection,
): string {
	const labels = getTranslationDirectionLabels(direction);
	const translatable = segments.filter((segment) => segment.translatable);
	return [
		`Translate these segments independently from ${labels.sourceLanguageLabel} to ${labels.targetLanguageLabel}. Keep the same ids.`,
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
