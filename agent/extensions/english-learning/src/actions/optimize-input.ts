import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple, type UserMessage } from "@earendil-works/pi-ai";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { EXTENSION_ID, REWRITE_TIMEOUT_MS } from "../core/config.ts";
import { resolveModel } from "../core/model-resolver.ts";
import { REWRITE_SYSTEM_PROMPT } from "../core/prompts.ts";
import { normalizeRewriteOutput } from "../core/text-utils.ts";

let activeRewrite: AbortController | undefined;

export async function optimizeCurrentInput(
	ctx: ExtensionContext,
	editor: EditorComponent,
): Promise<void> {
	const sourceText = editor.getExpandedText?.() ?? editor.getText();
	if (!sourceText.trim()) return;

	activeRewrite?.abort();
	const controller = new AbortController();
	activeRewrite = controller;
	const timeout = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
	timeout.unref?.();

	ctx.ui.setStatus(EXTENSION_ID, "optimizing English…");
	try {
		const choice = resolveModel(ctx, "rewrite");
		if (!choice) {
			ctx.ui.notify(
				"No OpenAI subscription model available for English optimization. Run /login and select ChatGPT Plus/Pro (Codex Subscription).",
				"error",
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
		if (!auth.ok) {
			ctx.ui.notify(`English optimization auth failed: ${auth.error}`, "error");
			return;
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: sourceText }],
			timestamp: Date.now(),
		};

		const stream = streamSimple(
			choice.model,
			{
				systemPrompt: REWRITE_SYSTEM_PROMPT,
				messages: [userMessage],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				maxTokens: Math.min(choice.model.maxTokens ?? 2_048, 2_048),
			},
		);

		let streamedText = "";
		let finalText = "";
		let stopReason = "unknown";
		let errorMessage: string | undefined;
		for await (const event of stream) {
			if (controller.signal.aborted) return;
			if (event.type === "text_delta") {
				streamedText += event.delta;
			} else if (event.type === "done") {
				stopReason = event.reason;
				finalText = event.message.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
			} else if (event.type === "error") {
				stopReason = event.reason;
				errorMessage = event.error.errorMessage;
			}
		}

		if (controller.signal.aborted || stopReason === "aborted") return;
		if (errorMessage) throw new Error(errorMessage);
		const rewritten = normalizeRewriteOutput(streamedText || finalText);
		if (!rewritten) {
			ctx.ui.notify(
				`English optimization returned empty text from ${choice.model.provider}/${choice.model.id} (stop: ${stopReason}).`,
				"warning",
			);
			return;
		}

		const currentText = editor.getExpandedText?.() ?? editor.getText();
		if (currentText !== sourceText) {
			ctx.ui.notify("Input changed while optimizing; discarded the old rewrite.", "warning");
			return;
		}

		editor.setText(rewritten);
		ctx.ui.notify(`Optimized input with ${choice.model.id}.`, "info");
	} catch (error) {
		if (controller.signal.aborted) return;
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`English optimization failed: ${message}`, "error");
	} finally {
		clearTimeout(timeout);
		if (activeRewrite === controller) activeRewrite = undefined;
		ctx.ui.setStatus(EXTENSION_ID, undefined);
	}
}

export function cancelInputOptimization(): void {
	activeRewrite?.abort();
	activeRewrite = undefined;
}
