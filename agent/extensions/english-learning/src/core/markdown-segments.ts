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

function makeTextSegment(
	id: number,
	kind: Exclude<TranslationSegmentKind, "code">,
	lines: string[],
): TranslationSegment | undefined {
	const source = lines.join("\n").trim();
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

function isBlockBoundary(line: string): boolean {
	return (
		line.trim() === "" ||
		FENCE_RE.test(line) ||
		HEADING_RE.test(line) ||
		BULLET_RE.test(line) ||
		QUOTE_RE.test(line) ||
		INDENTED_CODE_RE.test(line)
	);
}

export function segmentMarkdown(text: string): MarkdownSegmentsResult {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const segments: TranslationSegment[] = [];
	let nextId = 1;

	const push = (segment: TranslationSegment | undefined) => {
		if (!segment) return;
		segments.push(segment);
		nextId++;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") continue;

		const fence = line.match(FENCE_RE);
		if (fence) {
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
			const block = [line];
			while (i + 1 < lines.length && INDENTED_CODE_RE.test(lines[i + 1] ?? "")) {
				i++;
				block.push(lines[i] ?? "");
			}
			push(makeCodeSegment(nextId, block));
			continue;
		}

		if (HEADING_RE.test(line)) {
			push(makeTextSegment(nextId, "heading", [line]));
			continue;
		}

		if (BULLET_RE.test(line)) {
			const block = [line];
			while (i + 1 < lines.length) {
				const next = lines[i + 1] ?? "";
				if (next.trim() === "" || FENCE_RE.test(next) || HEADING_RE.test(next)) break;
				if (BULLET_RE.test(next)) break;
				if (QUOTE_RE.test(next)) break;
				i++;
				block.push(next);
			}
			push(makeTextSegment(nextId, "bullet", block));
			continue;
		}

		if (QUOTE_RE.test(line)) {
			const block = [line];
			while (i + 1 < lines.length && QUOTE_RE.test(lines[i + 1] ?? "")) {
				i++;
				block.push(lines[i] ?? "");
			}
			push(makeTextSegment(nextId, "quote", block));
			continue;
		}

		const paragraph = [line];
		while (i + 1 < lines.length && !isBlockBoundary(lines[i + 1] ?? "")) {
			i++;
			paragraph.push(lines[i] ?? "");
		}
		push(makeTextSegment(nextId, "paragraph", paragraph));
	}

	return {
		segments,
		translatableCount: segments.filter((segment) => segment.translatable).length,
		codeBlockCount: segments.filter((segment) => !segment.translatable).length,
	};
}
