import type {
	MarkdownSegmentsResult,
	TranslationSegment,
	TranslationSegmentKind,
} from "../types.ts";

const FENCE_RE = /^\s*(```|~~~)\s*([^`]*)?$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const BULLET_RE = /^\s{0,6}(?:[-*+]\s+|\d+[.)]\s+)/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

// Keep related Markdown blocks together so the diff view reads as a few coherent
// sections. Large responses are still split on natural blank-line boundaries to
// keep model tags reliable and streaming updates responsive.
const SOFT_TEXT_SEGMENT_CHARS = 1_800;
const HARD_TEXT_SEGMENT_CHARS = 3_200;

type TextSegmentKind = Exclude<TranslationSegmentKind, "code">;

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

function hasText(lines: string[]): boolean {
	return lines.some((line) => line.trim() !== "");
}

function textLength(lines: string[]): number {
	return lines.join("\n").trim().length;
}

function inferTextKind(lines: string[]): TextSegmentKind {
	const first = lines.find((line) => line.trim() !== "") ?? "";
	if (HEADING_RE.test(first)) return "heading";
	if (BULLET_RE.test(first)) return "bullet";
	if (QUOTE_RE.test(first)) return "quote";
	return "paragraph";
}

function makeTextSegment(
	id: number,
	kind: TextSegmentKind,
	lines: string[],
): TranslationSegment | undefined {
	const source = trimBlankEdges(lines).join("\n").trim();
	if (!source) return undefined;
	return {
		id,
		kind,
		source,
		translatable: true,
		translation: "",
		status: "pending",
	};
}

function makeCodeSegment(
	id: number,
	lines: string[],
	language?: string,
): TranslationSegment | undefined {
	const source = lines.join("\n").trimEnd();
	if (!source.trim()) return undefined;
	return {
		id,
		kind: "code",
		source,
		language: language?.trim() || undefined,
		translatable: false,
	};
}

export function segmentMarkdown(text: string): MarkdownSegmentsResult {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const segments: TranslationSegment[] = [];
	let nextId = 1;
	let textBuffer: string[] = [];

	const push = (segment: TranslationSegment | undefined) => {
		if (!segment) return;
		segments.push(segment);
		nextId++;
	};

	const flushText = () => {
		if (!hasText(textBuffer)) {
			textBuffer = [];
			return;
		}
		push(makeTextSegment(nextId, inferTextKind(textBuffer), textBuffer));
		textBuffer = [];
	};

	const appendText = (line: string) => {
		if (line.trim() === "" && textBuffer.length === 0) return;
		textBuffer.push(line);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		const fence = line.match(FENCE_RE);
		if (fence) {
			flushText();
			const marker = fence[1]!;
			const language = fence[2]?.trim().split(/\s+/)[0];
			const block = [line];
			i++;
			while (i < lines.length) {
				const current = lines[i] ?? "";
				block.push(current);
				if (current.trim().startsWith(marker)) break;
				i++;
			}
			push(makeCodeSegment(nextId, block, language));
			continue;
		}

		if (INDENTED_CODE_RE.test(line)) {
			flushText();
			const block = [line];
			while (i + 1 < lines.length && INDENTED_CODE_RE.test(lines[i + 1] ?? "")) {
				i++;
				block.push(lines[i] ?? "");
			}
			push(makeCodeSegment(nextId, block));
			continue;
		}

		if (HEADING_RE.test(line) && hasText(textBuffer)) {
			flushText();
		}

		appendText(line);

		if (!hasText(textBuffer)) continue;
		const length = textLength(textBuffer);
		const next = lines[i + 1] ?? "";
		if (length >= HARD_TEXT_SEGMENT_CHARS) {
			flushText();
		} else if (length >= SOFT_TEXT_SEGMENT_CHARS && (line.trim() === "" || next.trim() === "" || HEADING_RE.test(next))) {
			flushText();
		}
	}

	flushText();

	return {
		segments,
		translatableCount: segments.filter((segment) => segment.translatable).length,
		codeBlockCount: segments.filter((segment) => !segment.translatable).length,
	};
}
