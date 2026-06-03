// Registers ask_user_question so Pi can ask structured clarifying questions.
// Not for storing user answers outside the active Pi session.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "ask_user_question";
const CONFIG_PATH = join(homedir(), ".config", "pi-ask-user-question", "config.json");
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_QUESTIONS = 4;
const MAX_PREVIEW_LINES = 12;
const VIEWPORT_PADDING_LINES = 1;
const PREVIEW_MIN_WIDTH = 100;
const PREVIEW_COLUMN_GAP = 4;
const MIN_LEFT_COLUMN_WIDTH = 48;
const MIN_PREVIEW_COLUMN_WIDTH = 45;
const MAX_LEFT_COLUMN_RATIO = 0.5;
const PREVIEW_BORDER_HORIZONTAL_OVERHEAD = 2;
const PREVIEW_INNER_PADDING_HORIZONTAL = 1;
const PREVIEW_BOX_MIN_CONTENT_WIDTH = 40;

const RESERVED_LABELS = new Set([
	"other",
	"type something.",
	"chat about this",
	"done with this question",
	"submit",
]);

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short option label, ideally 1-5 words." }),
	description: Type.Optional(Type.String({ description: "One sentence explaining the trade-off for this option." })),
	preview: Type.Optional(Type.String({ description: "Optional markdown or text preview shown when this option is focused." })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "Full clarifying question. Use the user's language and end with a question mark." }),
	header: Type.Optional(Type.String({ description: "Short tab label, max 16 characters, such as Scope or Style." })),
	options: Type.Array(OptionSchema, {
		description: `Structured options. Provide ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Set true only when the user may choose multiple options." })),
	allowCustom: Type.Optional(Type.Boolean({ description: "For single-select questions, allow the user to type a custom answer. Defaults to true." })),
});

const AskUserQuestionParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: `One to ${MAX_QUESTIONS} structured questions to ask before proceeding.`,
		minItems: 1,
		maxItems: MAX_QUESTIONS,
	}),
});

type AskUserQuestionParams = Static<typeof AskUserQuestionParamsSchema>;
type AnswerKind = "option" | "custom" | "multi";
type Row =
	| { kind: "option"; optionIndex: number }
	| { kind: "custom" }
	| { kind: "done" }
	| { kind: "chat" };

interface ExtensionConfig {
	defaultAllowCustom?: boolean;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface NormalisedOption {
	label: string;
	description?: string;
	preview?: string;
}

interface NormalisedQuestion {
	question: string;
	header: string;
	options: NormalisedOption[];
	multiSelect: boolean;
	allowCustom: boolean;
}

interface AnswerDetails {
	questionIndex: number;
	question: string;
	header: string;
	kind: AnswerKind;
	answer: string | null;
	selected?: string[];
	preview?: string;
}

interface QuestionnaireResult {
	answers: AnswerDetails[];
	cancelled: boolean;
	reason?: "cancelled" | "chat";
	error?: string;
}

interface ValidationOk {
	ok: true;
	questions: NormalisedQuestion[];
}

interface ValidationFail {
	ok: false;
	message: string;
	error: string;
}

type ValidationResult = ValidationOk | ValidationFail;

const DEFAULT_PROMPT_SNIPPET = `Ask the user 1-${MAX_QUESTIONS} structured clarifying questions when requirements are ambiguous, instead of guessing.`;

const DEFAULT_PROMPT_GUIDELINES = [
	`Use ${TOOL_NAME} when the user's request is underspecified and a wrong assumption would change the outcome.`,
	`Use ${TOOL_NAME} in the user's language. Keep questions short, concrete, and decision-oriented.`,
	`Use ${TOOL_NAME} with ${MIN_OPTIONS}-${MAX_OPTIONS} options per question. Each option needs a clear label and a description explaining the trade-off.`,
	`Use ${TOOL_NAME} once per uncertainty cluster: group related decisions into one call instead of asking many back-to-back questions.`,
	`Do not author reserved fallback labels yourself: Other, Type something., Chat about this, Done with this question, or Submit. The UI adds fallback rows when needed.`,
];

function loadConfig(): ExtensionConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as ExtensionConfig;
	} catch {
		return {};
	}
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function cleanOptionalString(value: unknown): string | undefined {
	const cleaned = cleanString(value);
	return cleaned.length > 0 ? cleaned : undefined;
}

function isReservedLabel(label: string): boolean {
	return RESERVED_LABELS.has(label.trim().toLowerCase());
}

function getPromptSnippet(config: ExtensionConfig): string {
	return typeof config.promptSnippet === "string" && config.promptSnippet.trim().length > 0
		? config.promptSnippet.trim()
		: DEFAULT_PROMPT_SNIPPET;
}

function getPromptGuidelines(config: ExtensionConfig): string[] {
	return Array.isArray(config.promptGuidelines) &&
		config.promptGuidelines.length > 0 &&
		config.promptGuidelines.every((item) => typeof item === "string" && item.trim().length > 0)
		? config.promptGuidelines.map((item) => item.trim())
		: DEFAULT_PROMPT_GUIDELINES;
}

function normaliseParams(params: AskUserQuestionParams, config: ExtensionConfig): ValidationResult {
	if (!Array.isArray(params.questions) || params.questions.length === 0) {
		return { ok: false, message: "Error: ask_user_question requires at least one question.", error: "no_questions" };
	}
	if (params.questions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			message: `Error: ask_user_question supports at most ${MAX_QUESTIONS} questions per call.`,
			error: "too_many_questions",
		};
	}

	const seenQuestions = new Set<string>();
	const questions: NormalisedQuestion[] = [];

	for (let i = 0; i < params.questions.length; i++) {
		const source = params.questions[i];
		const question = cleanString(source.question);
		if (!question) {
			return { ok: false, message: `Error: question ${i + 1} is empty.`, error: "empty_question" };
		}
		const questionKey = question.toLowerCase();
		if (seenQuestions.has(questionKey)) {
			return { ok: false, message: `Error: duplicate question: ${question}`, error: "duplicate_question" };
		}
		seenQuestions.add(questionKey);

		if (!Array.isArray(source.options) || source.options.length < MIN_OPTIONS) {
			return {
				ok: false,
				message: `Error: question ${i + 1} needs at least ${MIN_OPTIONS} options.`,
				error: "too_few_options",
			};
		}
		if (source.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				message: `Error: question ${i + 1} has more than ${MAX_OPTIONS} options.`,
				error: "too_many_options",
			};
		}

		const seenOptions = new Set<string>();
		const options: NormalisedOption[] = [];
		for (const option of source.options) {
			const label = cleanString(option.label);
			if (!label) {
				return { ok: false, message: `Error: question ${i + 1} has an empty option label.`, error: "empty_option" };
			}
			if (isReservedLabel(label)) {
				return { ok: false, message: `Error: reserved option label is not allowed: ${label}`, error: "reserved_label" };
			}
			const labelKey = label.toLowerCase();
			if (seenOptions.has(labelKey)) {
				return { ok: false, message: `Error: duplicate option label: ${label}`, error: "duplicate_option_label" };
			}
			seenOptions.add(labelKey);
			options.push({
				label,
				description: cleanOptionalString(option.description),
				preview: cleanOptionalString(option.preview),
			});
		}

		const multiSelect = source.multiSelect === true;
		const defaultAllowCustom = config.defaultAllowCustom !== false;
		questions.push({
			question,
			header: cleanOptionalString(source.header)?.slice(0, 16) ?? `Q${i + 1}`,
			options,
			multiSelect,
			allowCustom: multiSelect ? false : source.allowCustom ?? defaultAllowCustom,
		});
	}

	return { ok: true, questions };
}

function rowsForQuestion(question: NormalisedQuestion): Row[] {
	const rows: Row[] = question.options.map((_option, optionIndex) => ({ kind: "option", optionIndex }));
	if (question.multiSelect) {
		rows.push({ kind: "done" });
	} else if (question.allowCustom) {
		rows.push({ kind: "custom" });
	}
	rows.push({ kind: "chat" });
	return rows;
}

function buildToolResult(content: string, result: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text: content }],
		details: result,
	};
}

function formatSuccessfulContent(answers: AnswerDetails[]): string {
	return answers
		.map((answer) => {
			const prefix = `${answer.questionIndex + 1}. ${answer.question}`;
			if (answer.kind === "multi") return `${prefix}\nSelected: ${(answer.selected ?? []).join(", ")}`;
			if (answer.kind === "custom") return `${prefix}\nUser wrote: ${answer.answer ?? ""}`;
			return `${prefix}\nUser selected: ${answer.answer ?? ""}`;
		})
		.join("\n\n");
}

async function askWithStructuredDialog(ctx: ExtensionContext, questions: NormalisedQuestion[]): Promise<QuestionnaireResult> {
	return ctx.ui.custom<QuestionnaireResult>(
		(tui, theme, _keybindings, done) => {
			let currentTab = 0;
			let rowIndex = 0;
			let editMode = false;
			let editQuestionIndex = -1;
			let warning: string | undefined;
			let cachedWidth: number | undefined;
			let cachedRows: number | undefined;
			let cachedLines: string[] | undefined;
			const answers = new Map<number, AnswerDetails>();
			const multiSelections = new Map<number, Set<number>>();
			const isMultiQuestion = questions.length > 1;
			const reviewTab = questions.length;
			const totalTabs = isMultiQuestion ? questions.length + 1 : questions.length;

			const editorTheme: EditorTheme = {
				borderColor: (s: string) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			function refresh(): void {
				cachedWidth = undefined;
				cachedRows = undefined;
				cachedLines = undefined;
				tui.requestRender();
			}

			function orderedAnswers(): AnswerDetails[] {
				return [...answers.entries()].sort(([a], [b]) => a - b).map(([, answer]) => answer);
			}

			function finish(cancelled: boolean, reason?: "cancelled" | "chat"): void {
				done({ answers: orderedAnswers(), cancelled, reason });
			}

			function allAnswered(): boolean {
				return questions.every((_question, index) => answers.has(index));
			}

			function currentQuestion(): NormalisedQuestion | undefined {
				return currentTab < questions.length ? questions[currentTab] : undefined;
			}

			function currentRows(): Row[] {
				const question = currentQuestion();
				return question ? rowsForQuestion(question) : [];
			}

			function moveToNextStep(): void {
				warning = undefined;
				rowIndex = 0;
				if (!isMultiQuestion) {
					finish(false);
					return;
				}
				currentTab = currentTab < questions.length - 1 ? currentTab + 1 : reviewTab;
				refresh();
			}

			function saveSingleOption(questionIndex: number, optionIndex: number): void {
				const question = questions[questionIndex];
				const option = question.options[optionIndex];
				answers.set(questionIndex, {
					questionIndex,
					question: question.question,
					header: question.header,
					kind: "option",
					answer: option.label,
					preview: option.preview,
				});
			}

			function saveCustomAnswer(questionIndex: number, answer: string): void {
				const question = questions[questionIndex];
				answers.set(questionIndex, {
					questionIndex,
					question: question.question,
					header: question.header,
					kind: "custom",
					answer,
				});
			}

			function saveMultiAnswer(questionIndex: number): boolean {
				const question = questions[questionIndex];
				const selected = [...(multiSelections.get(questionIndex) ?? new Set<number>())].sort((a, b) => a - b);
				if (selected.length === 0) return false;
				const labels = selected.map((index) => question.options[index].label);
				answers.set(questionIndex, {
					questionIndex,
					question: question.question,
					header: question.header,
					kind: "multi",
					answer: labels.join(", "),
					selected: labels,
				});
				return true;
			}

			function toggleMultiOption(questionIndex: number, optionIndex: number): void {
				const selected = multiSelections.get(questionIndex) ?? new Set<number>();
				if (selected.has(optionIndex)) selected.delete(optionIndex);
				else selected.add(optionIndex);
				multiSelections.set(questionIndex, selected);
				warning = undefined;
				refresh();
			}

			function activateRow(): void {
				const question = currentQuestion();
				if (!question) return;
				const rows = currentRows();
				const row = rows[rowIndex];
				if (!row) return;

				if (row.kind === "chat") {
					finish(true, "chat");
					return;
				}

				if (row.kind === "custom") {
					editMode = true;
					editQuestionIndex = currentTab;
					editor.setText(answers.get(currentTab)?.kind === "custom" ? answers.get(currentTab)?.answer ?? "" : "");
					warning = undefined;
					refresh();
					return;
				}

				if (row.kind === "done") {
					if (!saveMultiAnswer(currentTab)) {
						warning = "Choose at least one option before continuing.";
						refresh();
						return;
					}
					moveToNextStep();
					return;
				}

				if (question.multiSelect) {
					toggleMultiOption(currentTab, row.optionIndex);
					return;
				}

				saveSingleOption(currentTab, row.optionIndex);
				moveToNextStep();
			}

			editor.onSubmit = (value: string) => {
				const trimmed = value.trim();
				if (!trimmed) {
					warning = "Type an answer, or press Esc to go back.";
					refresh();
					return;
				}
				saveCustomAnswer(editQuestionIndex, trimmed);
				editMode = false;
				editQuestionIndex = -1;
				editor.setText("");
				moveToNextStep();
			};

			function handleReviewInput(data: string): void {
				if (matchesKey(data, Key.enter)) {
					if (allAnswered()) finish(false);
					else {
						warning = "Answer every question before submitting.";
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.escape)) finish(true, "cancelled");
			}

			function handleInput(data: string): void {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editQuestionIndex = -1;
						editor.setText("");
						warning = undefined;
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (isMultiQuestion && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
					currentTab = (currentTab + 1) % totalTabs;
					rowIndex = 0;
					warning = undefined;
					refresh();
					return;
				}
				if (isMultiQuestion && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					rowIndex = 0;
					warning = undefined;
					refresh();
					return;
				}

				if (currentTab === reviewTab && isMultiQuestion) {
					handleReviewInput(data);
					return;
				}

				const rows = currentRows();
				if (matchesKey(data, Key.up)) {
					rowIndex = Math.max(0, rowIndex - 1);
					warning = undefined;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					rowIndex = Math.min(rows.length - 1, rowIndex + 1);
					warning = undefined;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					activateRow();
					return;
				}
				if (/^[1-9]$/.test(data)) {
					const picked = Number(data) - 1;
					if (picked >= 0 && picked < rows.length) {
						rowIndex = picked;
						activateRow();
					}
					return;
				}
				if (matchesKey(data, Key.escape)) finish(true, "cancelled");
			}

			function addWrapped(lines: string[], text: string, width: number, indent = "", colour?: (value: string) => string): void {
				const innerWidth = Math.max(1, width - indent.length);
				for (const rawLine of text.split("\n")) {
					const wrapped = wrapTextWithAnsi(rawLine || " ", innerWidth);
					for (const line of wrapped) {
						const content = colour ? colour(line) : line;
						lines.push(truncateToWidth(`${indent}${content}`, width));
					}
				}
			}

			function fitMiddleLines(lines: string[], maxLines: number, width: number): string[] {
				if (maxLines <= 0) return [];
				if (lines.length <= maxLines) return lines;

				const marker = truncateToWidth(theme.fg("dim", " … content truncated to keep choices visible"), width);
				if (maxLines === 1) return [marker];
				if (maxLines === 2) return [marker, lines[lines.length - 1] ?? ""];

				const keepHead = Math.max(1, Math.min(6, Math.floor((maxLines - 1) / 3)));
				const keepTail = maxLines - keepHead - 1;
				return [...lines.slice(0, keepHead), marker, ...lines.slice(-keepTail)];
			}

			function fitDialogLines(topLines: string[], bodyLines: string[], bottomLines: string[], maxLines: number, width: number): string[] {
				if (maxLines <= 0) return [];
				if (bottomLines.length >= maxLines) return bottomLines.slice(-maxLines);

				const topBudget = Math.max(0, maxLines - bottomLines.length);
				const clippedTop = topLines.slice(0, topBudget);
				const bodyBudget = maxLines - clippedTop.length - bottomLines.length;
				return [...clippedTop, ...fitMiddleLines(bodyLines, bodyBudget, width), ...bottomLines];
			}

			function previewForFocusedRow(question: NormalisedQuestion, rows: Row[]): string | undefined {
				const row = rows[rowIndex];
				if (!row || row.kind !== "option") return;
				return question.options[row.optionIndex]?.preview;
			}

			function previewBoxWidth(contentLines: string[], maxWidth: number): number {
				const maxContentWidth = Math.max(
					1,
					maxWidth - PREVIEW_BORDER_HORIZONTAL_OVERHEAD - 2 * PREVIEW_INNER_PADDING_HORIZONTAL,
				);
				let contentWidth = Math.min(PREVIEW_BOX_MIN_CONTENT_WIDTH, maxContentWidth);
				for (const line of contentLines) {
					contentWidth = Math.max(contentWidth, visibleWidth(line.replace(/\s+$/, "")));
				}
				return Math.min(maxWidth, contentWidth + PREVIEW_BORDER_HORIZONTAL_OVERHEAD + 2 * PREVIEW_INNER_PADDING_HORIZONTAL);
			}

			function renderBorderedPreviewBox(contentLines: string[], width: number, hidden: number): string[] {
				const dashSpan = Math.max(1, width - PREVIEW_BORDER_HORIZONTAL_OVERHEAD);
				const contentWidth = Math.max(1, dashSpan - 2 * PREVIEW_INNER_PADDING_HORIZONTAL);
				const pad = " ".repeat(PREVIEW_INNER_PADDING_HORIZONTAL);
				const lines = [theme.fg("accent", `┌${"─".repeat(dashSpan)}┐`)];

				for (const line of contentLines) {
					const padded = truncateToWidth(theme.fg("dim", line), contentWidth, "", true);
					lines.push(`${theme.fg("accent", "│")}${pad}${padded}${pad}${theme.fg("accent", "│")}`);
				}

				if (hidden > 0) {
					const indicator = ` ✂ ── ${hidden} lines hidden ── `;
					const space = dashSpan - indicator.length;
					const leftFill = "─".repeat(Math.max(0, Math.floor(space / 2)));
					const rightFill = "─".repeat(Math.max(0, dashSpan - leftFill.length - indicator.length));
					lines.push(truncateToWidth(theme.fg("accent", `└${leftFill}${indicator}${rightFill}┘`), width));
				} else {
					lines.push(theme.fg("accent", `└${"─".repeat(dashSpan)}┘`));
				}

				return lines;
			}

			function renderPreviewLines(preview: string, width: number): string[] {
				const bodyWidth = Math.max(
					1,
					width - PREVIEW_BORDER_HORIZONTAL_OVERHEAD - 2 * PREVIEW_INNER_PADDING_HORIZONTAL,
				);
				const wrappedLines: string[] = [];
				for (const rawLine of preview.split("\n")) {
					const wrapped = wrapTextWithAnsi(rawLine || " ", bodyWidth);
					for (const line of wrapped) {
						wrappedLines.push(line);
					}
				}
				const contentLines = wrappedLines.slice(0, MAX_PREVIEW_LINES);
				const hidden = Math.max(0, wrappedLines.length - contentLines.length);
				const boxWidth = previewBoxWidth(contentLines, width);
				return renderBorderedPreviewBox(contentLines, boxWidth, hidden);
			}

			function addPreview(lines: string[], question: NormalisedQuestion, rows: Row[], width: number): void {
				const preview = previewForFocusedRow(question, rows);
				if (!preview) return;
				lines.push("");
				lines.push(...renderPreviewLines(preview, width));
			}

			function rowDisplayLabel(question: NormalisedQuestion, row: Row, rowNumber: number, selectedMulti: Set<number>): string {
				if (row.kind === "option") {
					const option = question.options[row.optionIndex];
					if (!option) return `${rowNumber}.`;
					const checkbox = question.multiSelect ? (selectedMulti.has(row.optionIndex) ? "[x] " : "[ ] ") : "";
					return `${rowNumber}. ${checkbox}${option.label}`;
				}
				const label =
					row.kind === "custom" ? "Type something." : row.kind === "done" ? "Done with this question" : "Chat about this";
				return `${rowNumber}. ${label}`;
			}

			function adaptiveChoiceColumnWidth(
				question: NormalisedQuestion,
				rows: Row[],
				width: number,
				selectedMulti: Set<number>,
			): number {
				let desired = MIN_LEFT_COLUMN_WIDTH;
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					if (!row) continue;
					desired = Math.max(desired, 2 + visibleWidth(rowDisplayLabel(question, row, i + 1, selectedMulti)));
				}
				const ratioCapped = Math.min(desired, Math.floor(width * MAX_LEFT_COLUMN_RATIO));
				const available = width - PREVIEW_COLUMN_GAP - MIN_PREVIEW_COLUMN_WIDTH;
				return Math.max(MIN_LEFT_COLUMN_WIDTH, Math.min(ratioCapped, Math.max(1, available)));
			}

			function padToWidth(line: string, width: number): string {
				const clipped = truncateToWidth(line, width);
				return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
			}

			function joinPreviewColumns(leftLines: string[], rightLines: string[], leftWidth: number, width: number): string[] {
				const rightWidth = Math.max(1, width - leftWidth - PREVIEW_COLUMN_GAP);
				const gap = " ".repeat(PREVIEW_COLUMN_GAP);
				const rows = Math.max(leftLines.length, rightLines.length);
				const out: string[] = [];
				for (let i = 0; i < rows; i++) {
					const left = padToWidth(leftLines[i] ?? "", leftWidth);
					const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
					out.push(truncateToWidth(`${left}${gap}${right}`, width));
				}
				return out;
			}

			function renderChoiceLines(question: NormalisedQuestion, rows: Row[], width: number, selectedMulti: Set<number>): string[] {
				const lines: string[] = [];
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					if (!row) continue;
					const focused = i === rowIndex;
					const prefix = focused ? theme.fg("accent", "> ") : "  ";

					if (row.kind === "option") {
						const option = question.options[row.optionIndex];
						if (!option) continue;
						lines.push(
							truncateToWidth(
								prefix + theme.fg(focused ? "accent" : "text", rowDisplayLabel(question, row, i + 1, selectedMulti)),
								width,
							),
						);
						if (option.description) {
							addWrapped(lines, option.description, width, "     ", (line) => theme.fg("muted", line));
						}
						continue;
					}

					lines.push(
						truncateToWidth(
							prefix + theme.fg(focused ? "accent" : "muted", rowDisplayLabel(question, row, i + 1, selectedMulti)),
							width,
						),
					);
				}
				return lines;
			}

			function renderChoicesWithPreview(question: NormalisedQuestion, rows: Row[], width: number, selectedMulti: Set<number>): string[] {
				const preview = previewForFocusedRow(question, rows);
				if (!preview || width < PREVIEW_MIN_WIDTH) {
					const lines = renderChoiceLines(question, rows, width, selectedMulti);
					addPreview(lines, question, rows, width);
					return lines;
				}

				const leftWidth = adaptiveChoiceColumnWidth(question, rows, width, selectedMulti);
				const rightWidth = Math.max(1, width - leftWidth - PREVIEW_COLUMN_GAP);
				if (rightWidth < MIN_PREVIEW_COLUMN_WIDTH) {
					const lines = renderChoiceLines(question, rows, width, selectedMulti);
					addPreview(lines, question, rows, width);
					return lines;
				}

				return joinPreviewColumns(
					renderChoiceLines(question, rows, leftWidth, selectedMulti),
					renderPreviewLines(preview, rightWidth),
					leftWidth,
					width,
				);
			}

			function answerSummary(answer: AnswerDetails | undefined): string | undefined {
				if (!answer) return undefined;
				if (answer.kind === "multi") return `Selected: ${(answer.selected ?? []).join(", ")}`;
				if (answer.kind === "custom") return `Custom: ${answer.answer ?? ""}`;
				return `Selected: ${answer.answer ?? ""}`;
			}

			function renderTabs(width: number): string[] {
				if (!isMultiQuestion) return [];
				const parts = questions.map((question, index) => {
					const marker = answers.has(index) ? "✓" : "○";
					const label = ` ${marker} ${question.header} `;
					if (index === currentTab) return theme.bg("selectedBg", theme.fg("text", label));
					return theme.fg(answers.has(index) ? "success" : "muted", label);
				});
				const submit = currentTab === reviewTab
					? theme.bg("selectedBg", theme.fg("text", " Submit "))
					: theme.fg(allAnswered() ? "success" : "dim", " Submit ");
				return [truncateToWidth(` ${parts.join(" ")} ${submit}`, width), ""];
			}

			function renderQuestion(width: number): string[] {
				const question = currentQuestion();
				if (!question) return [];
				const lines: string[] = [];
				const rows = currentRows();
				addWrapped(lines, question.question, width, " ", (line) => theme.fg("text", theme.bold(line)));

				const summary = answerSummary(answers.get(currentTab));
				if (summary) {
					addWrapped(lines, summary, width, " ", (line) => theme.fg("success", line));
				}
				lines.push("");

				const selectedMulti = multiSelections.get(currentTab) ?? new Set<number>();
				lines.push(...renderChoicesWithPreview(question, rows, width, selectedMulti));

				if (editMode) {
					lines.push("");
					lines.push(truncateToWidth(theme.fg("muted", " Your answer:"), width));
					for (const line of editor.render(Math.max(1, width - 2))) {
						lines.push(truncateToWidth(` ${line}`, width));
					}
				}

				return lines;
			}

			function renderReview(width: number): string[] {
				const lines: string[] = [];
				lines.push(truncateToWidth(theme.fg("accent", theme.bold(" Review answers")), width));
				lines.push("");
				for (let i = 0; i < questions.length; i++) {
					const question = questions[i];
					const answer = answers.get(i);
					lines.push(truncateToWidth(theme.fg("muted", ` ${question.header}: ${question.question}`), width));
					addWrapped(lines, answerSummary(answer) ?? "Unanswered", width, "   ", (line) =>
						theme.fg(answer ? "success" : "warning", line),
					);
				}
				lines.push("");
				lines.push(
					truncateToWidth(
						allAnswered()
							? theme.fg("success", " Enter to submit")
							: theme.fg("warning", " Some questions are unanswered"),
						width,
					),
				);
				return lines;
			}

			function render(width: number): string[] {
				const safeWidth = Math.max(20, width);
				const safeRows = Math.max(1, tui.terminal.rows - VIEWPORT_PADDING_LINES);
				if (cachedLines && cachedWidth === safeWidth && cachedRows === safeRows) return cachedLines;

				const topLines: string[] = [];
				topLines.push(theme.fg("accent", "─".repeat(safeWidth)));
				topLines.push(truncateToWidth(theme.fg("toolTitle", theme.bold(" ask_user_question")), safeWidth));
				topLines.push(...renderTabs(safeWidth));

				const bodyLines = isMultiQuestion && currentTab === reviewTab ? renderReview(safeWidth) : renderQuestion(safeWidth);

				const bottomLines: string[] = [];
				if (warning) {
					bottomLines.push("");
					addWrapped(bottomLines, warning, safeWidth, " ", (line) => theme.fg("warning", line));
				}

				bottomLines.push("");
				const help = editMode
					? " Enter submit text • Esc back"
					: isMultiQuestion
						? " Tab/←→ tabs • ↑↓ move • Enter/Space choose • Esc cancel"
						: " ↑↓ move • Enter/Space choose • Esc cancel";
				bottomLines.push(truncateToWidth(theme.fg("dim", help), safeWidth));
				bottomLines.push(theme.fg("accent", "─".repeat(safeWidth)));

				const lines = fitDialogLines(topLines, bodyLines, bottomLines, safeRows, safeWidth);
				cachedWidth = safeWidth;
				cachedRows = safeRows;
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedWidth = undefined;
					cachedRows = undefined;
					cachedLines = undefined;
				},
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 0, right: 0, bottom: 0 },
			},
		},
	);
}

function renderToolResultSummary(result: QuestionnaireResult | undefined, theme: Theme): string {
	if (!result) return "";
	if (result.cancelled) {
		return theme.fg("warning", result.reason === "chat" ? "User chose to chat" : "Cancelled");
	}
	return result.answers
		.map((answer) => {
			const value = answer.kind === "multi" ? (answer.selected ?? []).join(", ") : answer.answer ?? "";
			return `${theme.fg("success", "✓")} ${theme.fg("accent", answer.header)}: ${value}`;
		})
		.join("\n");
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	const config = loadConfig();

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: `Ask the user one or more structured clarifying questions during execution.
Use this when proceeding would require guessing. The UI lets the user choose options, select multiple options where allowed, type a custom answer for single-select questions, or switch back to free-form chat.`,
		promptSnippet: getPromptSnippet(config),
		promptGuidelines: getPromptGuidelines(config),
		parameters: AskUserQuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const validation = normaliseParams(params as AskUserQuestionParams, config);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			if (!ctx.hasUI) {
				return buildToolResult("Error: UI not available. Ask the user directly instead of guessing.", {
					answers: [],
					cancelled: true,
					error: "no_ui",
				});
			}

			const result = await askWithStructuredDialog(ctx, validation.questions);
			if (result.cancelled && result.reason === "chat") {
				return buildToolResult("User chose to continue in free-form chat. Do not guess; ask a short follow-up in normal conversation.", result);
			}
			if (result.cancelled) {
				return buildToolResult("User cancelled the questionnaire. Do not assume an answer.", result);
			}
			return buildToolResult(formatSuccessfulContent(result.answers), result);
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const labels = questions
				.map((question: { header?: string; question?: string }, index: number) => question.header ?? question.question ?? `Q${index + 1}`)
				.join(", ");
			const text = `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg(
				"muted",
				`${questions.length} question${questions.length === 1 ? "" : "s"}`,
			)}${labels ? ` ${theme.fg("dim", truncateToWidth(labels, 60))}` : ""}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireResult | undefined;
			const summary = renderToolResultSummary(details, theme);
			if (summary) return new Text(summary, 0, 0);
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "", 0, 0);
		},
	});

	pi.registerCommand("ask-question-demo", {
		description: "Open a demo ask_user_question dialog",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ask_user_question demo needs the interactive UI.", "warning");
				return;
			}
			const questions: NormalisedQuestion[] = [
				{
					question: "What style should the answer use?",
					header: "Style",
					multiSelect: false,
					allowCustom: true,
					options: [
						{ label: "Concise", description: "Short answer with only key actions." },
						{ label: "Detailed", description: "More context, trade-offs, and commands." },
					],
				},
				{
					question: "Which evidence should I include?",
					header: "Evidence",
					multiSelect: true,
					allowCustom: false,
					options: [
						{ label: "Commands", description: "Show terminal commands and outputs." },
						{ label: "File paths", description: "List changed or inspected files." },
						{ label: "Assumptions", description: "State assumptions that need confirmation." },
					],
				},
			];
			const result = await askWithStructuredDialog(ctx, questions);
			ctx.ui.notify(result.cancelled ? "Demo cancelled." : "Demo answered.", result.cancelled ? "warning" : "info");
		},
	});
}
