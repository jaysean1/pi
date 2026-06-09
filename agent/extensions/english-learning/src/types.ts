export type TranslationSegmentKind =
	| "heading"
	| "paragraph"
	| "bullet"
	| "quote"
	| "code";

export type TranslationStatus =
	| "pending"
	| "streaming"
	| "done"
	| "error";

export interface SegmentBase {
	id: number;
	kind: TranslationSegmentKind;
	source: string;
}

export interface TranslatableSegment extends SegmentBase {
	kind: Exclude<TranslationSegmentKind, "code">;
	translatable: true;
	translation: string;
	status: TranslationStatus;
	error?: string;
}

export interface CodeSegment extends SegmentBase {
	kind: "code";
	translatable: false;
	language?: string;
}

export type TranslationSegment = TranslatableSegment | CodeSegment;

export interface MarkdownSegmentsResult {
	segments: TranslationSegment[];
	translatableCount: number;
	codeBlockCount: number;
}

export type TranslationCloseReason = "escape" | "toggle" | "done";

export type ModelPurpose = "rewrite" | "translate";

export interface ModelChoice {
	model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
	reason: string;
}
