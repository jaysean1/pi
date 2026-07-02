import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple, type UserMessage } from "@earendil-works/pi-ai/compat";
import { MAX_TRANSLATE_CHARS, OPENAI_SUBSCRIPTION_PROVIDER, TRANSLATE_TIMEOUT_MS } from "../core/config.ts";
import { getLastAssistantText } from "../core/last-assistant.ts";
import { segmentMarkdown } from "../core/markdown-segments.ts";
import { resolveModelCandidates } from "../core/model-resolver.ts";
import {
	buildTranslateSystemPrompt,
	buildTranslateUserPrompt,
	getTranslationDirectionLabels,
} from "../core/prompts.ts";
import { SegmentTranslationParser } from "../core/stream-protocol.ts";
import { detectTranslationDirection, estimateMaxTokensFromChars, textFromContent } from "../core/text-utils.ts";
import {
	applyCachedTranslations,
	getCachedTranslations,
	storeCachedTranslations,
} from "../core/translation-cache.ts";
import type { ModelChoice, TranslationCloseReason, TranslationDirection, TranslationSegment } from "../types.ts";
import { TranslationOverlay } from "../ui/translation-overlay.ts";

interface ActiveOverlay {
	close(reason?: TranslationCloseReason): void;
	abort(): void;
}

interface ResolvedAuth {
	ok: true;
	apiKey?: string;
	headers?: Record<string, string>;
}

let activeOverlay: ActiveOverlay | undefined;

function formatProviderLabel(provider: string): string {
	return provider === OPENAI_SUBSCRIPTION_PROVIDER ? "openai subscription" : provider;
}

function formatOverlayModelLabel(choice: ModelChoice): string {
	return `(${formatProviderLabel(choice.model.provider)}) ${choice.model.id}`;
}

export function isTranslationOverlayOpen(): boolean {
	return activeOverlay !== undefined;
}

export function closeTranslationOverlay(): void {
	activeOverlay?.close("toggle");
}

export async function openOrToggleTranslation(
	ctx: ExtensionContext,
	options: { force?: boolean } = {},
): Promise<void> {
	// Kept for backward-compatible `/english translate --force`; direction is now auto-detected.
	void options;
	if (activeOverlay) {
		activeOverlay.close("toggle");
		return;
	}

	if (ctx.mode !== "tui") {
		ctx.ui.notify("Segmented translation requires Pi TUI mode.", "warning");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the agent to finish before translating the last response.", "warning");
		return;
	}

	const last = getLastAssistantText(ctx);
	if (!last) {
		ctx.ui.notify("No assistant message found to translate.", "warning");
		return;
	}
	if (last.text.length > MAX_TRANSLATE_CHARS) {
		ctx.ui.notify(`Last assistant message is too long to translate (${last.text.length} chars).`, "error");
		return;
	}
	const direction = detectTranslationDirection(last.text);
	const labels = getTranslationDirectionLabels(direction);

	const segmentation = segmentMarkdown(last.text);
	if (segmentation.segments.length === 0) {
		ctx.ui.notify("No displayable text found in the last assistant message.", "warning");
		return;
	}

	const cached = getCachedTranslations(last.text, direction, segmentation.segments);
	if (cached) applyCachedTranslations(cached, segmentation.segments);

	const candidates = !cached && segmentation.translatableCount > 0 ? resolveModelCandidates(ctx, "translate") : [];
	if (!cached && segmentation.translatableCount > 0 && candidates.length === 0) {
		ctx.ui.notify(
			"No OpenAI subscription model available for translation. Run /login and select ChatGPT Plus/Pro (Codex Subscription).",
			"error",
		);
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
	timeout.unref?.();
	let overlay: TranslationOverlay | undefined;

	activeOverlay = {
		close: (reason = "toggle") => overlay?.requestClose(reason),
		abort: () => controller.abort(),
	};

	try {
		await ctx.ui.custom<TranslationCloseReason>(
			(tui, theme, _keybindings, done) => {
				overlay = new TranslationOverlay(tui, theme, segmentation.segments, {
					sourceLanguageLabel: labels.sourceLanguageLabel,
					targetLanguageLabel: labels.targetLanguageLabel,
					modelLabel: cached
						? `${cached.modelLabel} · cached`
						: candidates[0]
							? formatOverlayModelLabel(candidates[0])
							: "none needed",
					translatableCount: segmentation.translatableCount,
					codeBlockCount: segmentation.codeBlockCount,
					done,
					onClose: () => controller.abort(),
				});

				queueMicrotask(() => {
					if (!overlay) return;
					if (segmentation.translatableCount === 0) {
						overlay.setRunStatus("done", "Only code blocks were found; nothing was translated.");
						return;
					}
					if (cached) {
						overlay.setRunStatus("done", `Loaded ${segmentation.translatableCount} segment(s) from cache.`);
						return;
					}
					void runSegmentedTranslation(
						ctx,
						overlay,
						segmentation.segments,
						candidates,
						controller.signal,
						last.text,
						direction,
					);
				});

				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
				onHandle: (handle) => {
					queueMicrotask(() => handle.focus());
					setTimeout(() => handle.focus(), 0);
				},
			},
		);
	} finally {
		clearTimeout(timeout);
		controller.abort();
		activeOverlay = undefined;
	}
}

async function runSegmentedTranslation(
	ctx: ExtensionContext,
	overlay: TranslationOverlay,
	segments: TranslationSegment[],
	candidates: ModelChoice[],
	signal: AbortSignal,
	sourceText: string,
	direction: TranslationDirection,
): Promise<void> {
	const promptText = buildTranslateUserPrompt(segments, direction);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: Date.now(),
	};

	const systemPrompt = buildTranslateSystemPrompt(direction);
	const failures: string[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const choice = candidates[i]!;
		if (signal.aborted || overlay.isClosed()) return;
		overlay.setModelLabel(formatOverlayModelLabel(choice));

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
		if (!auth.ok) {
			failures.push(`${choice.model.provider}/${choice.model.id}: ${auth.error}`);
			continue;
		}

		overlay.setRunStatus(
			"streaming",
			`Streaming translation... (${i + 1}/${candidates.length})`,
		);

		const before = hasAnyTranslatedText(segments);
		try {
			await runSingleModelTranslation(
				overlay,
				segments,
				choice,
				auth,
				userMessage,
				promptText,
				systemPrompt,
				signal,
			);
			const cached = storeCachedTranslations(sourceText, direction, segments, formatOverlayModelLabel(choice));
			overlay.setRunStatus("done", cached ? "Done · cached for reuse" : "Done");
			return;
		} catch (error) {
			if (signal.aborted || overlay.isClosed()) {
				overlay.setRunStatus("aborted", "Translation cancelled.");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${choice.model.provider}/${choice.model.id}: ${message}`);

			// If a model already streamed content, do not mix another model's output
			// into the same segment cards. Surface the error instead.
			if (hasAnyTranslatedText(segments) && !before) {
				markPendingSegmentsError(segments, overlay, message);
				overlay.setRunStatus("error", message);
				return;
			}

			const next = candidates[i + 1];
			if (next) {
				overlay.setRunStatus(
					"streaming",
					`Failed (${shortError(message)}). Trying next model...`,
				);
			}
		}
	}

	const finalMessage = failures.length > 0 ? failures.join("\n") : "No translation model could be used.";
	markPendingSegmentsError(segments, overlay, finalMessage);
	overlay.setRunStatus("error", finalMessage);
}

async function runSingleModelTranslation(
	overlay: TranslationOverlay,
	segments: TranslationSegment[],
	choice: ModelChoice,
	auth: ResolvedAuth,
	userMessage: UserMessage,
	promptText: string,
	systemPrompt: string,
	signal: AbortSignal,
): Promise<void> {
	let rawOutput = "";
	const parser = new SegmentTranslationParser({
		onSegmentStart: (id) => overlay.setSegmentStatus(id, "streaming"),
		onDelta: (id, delta) => overlay.appendTranslation(id, delta),
		onSegmentEnd: (id) => overlay.setSegmentStatus(id, "done"),
	});

	const stream = streamSimple(
		choice.model,
		{
			systemPrompt,
			messages: [userMessage],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			maxTokens: estimateMaxTokensFromChars(promptText.length, choice.model.maxTokens),
			// Match session-recap's subscription path: OpenAI Codex subscription
			// rejects unsupported sampling params such as temperature, so let the
			// provider use its defaults.
			reasoning: undefined,
		},
	);

	for await (const event of stream) {
		if (signal.aborted || overlay.isClosed()) return;
		if (event.type === "text_delta") {
			rawOutput += event.delta;
			parser.push(event.delta);
		} else if (event.type === "done") {
			const finalText = textFromContent(event.message.content);
			if (!rawOutput && finalText) rawOutput = finalText;
		} else if (event.type === "error") {
			throw new Error(event.error.errorMessage ?? "translation stream error");
		}
	}

	parser.finish();
	if (!parser.sawTags && rawOutput.trim()) applyUntaggedFallback(segments, overlay, rawOutput);
	for (const segment of segments) {
		if (!segment.translatable) continue;
		if (segment.status === "pending") overlay.setSegmentStatus(segment.id, "error", "missing tagged translation");
		else if (segment.status === "streaming") overlay.setSegmentStatus(segment.id, "done");
	}
}

function hasAnyTranslatedText(segments: TranslationSegment[]): boolean {
	return segments.some((segment) => segment.translatable && segment.translation.trim().length > 0);
}

function markPendingSegmentsError(
	segments: TranslationSegment[],
	overlay: TranslationOverlay,
	message: string,
): void {
	for (const segment of segments) {
		if (segment.translatable && segment.status !== "done") overlay.setSegmentStatus(segment.id, "error", message);
	}
}

function shortError(message: string): string {
	const firstLine = message.split("\n")[0] ?? message;
	return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
}

function applyUntaggedFallback(
	segments: TranslationSegment[],
	overlay: TranslationOverlay,
	rawOutput: string,
): void {
	const translatable = segments.filter((segment) => segment.translatable);
	if (translatable.length === 1) {
		overlay.appendTranslation(translatable[0]!.id, rawOutput.trim());
		overlay.setSegmentStatus(translatable[0]!.id, "done");
		return;
	}
	for (const segment of translatable) {
		overlay.setSegmentStatus(segment.id, "error", "model returned untagged output");
	}
}
