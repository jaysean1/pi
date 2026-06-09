import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	FAST_MODEL_KEYWORDS,
	REWRITE_MODEL_PRIORITIES,
	TRANSLATE_MODEL_PRIORITIES,
} from "./config.ts";
import type { ModelChoice, ModelPurpose } from "../types.ts";

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function scoreFastModel(model: Model<Api>, purpose: ModelPurpose): number {
	const key = modelKey(model).toLowerCase();
	let score = 0;
	if (model.provider === "openai") score += 100;
	if (key.includes("gpt")) score += 40;
	if (key.includes("mini")) score += 35;
	if (key.includes("4.1-mini")) score += purpose === "rewrite" ? 22 : 12;
	if (key.includes("5-mini")) score += purpose === "translate" ? 22 : 16;
	if (key.includes("5.4-mini")) score += 18;
	for (const keyword of FAST_MODEL_KEYWORDS) {
		if (key.includes(keyword)) score += 8;
	}
	if (key.includes("codex")) score -= purpose === "translate" ? 15 : 6;
	if (key.includes("thinking")) score -= 10;
	return score;
}

export function resolveModelCandidates(ctx: ExtensionContext, purpose: ModelPurpose): ModelChoice[] {
	const available = ctx.modelRegistry.getAvailable();
	const priorities = purpose === "rewrite" ? REWRITE_MODEL_PRIORITIES : TRANSLATE_MODEL_PRIORITIES;
	const choices: ModelChoice[] = [];
	const seen = new Set<string>();
	const add = (model: Model<Api> | undefined, reason: string) => {
		if (!model) return;
		const key = modelKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		choices.push({ model, reason });
	};

	// For translation, include the current Pi model first. It is the model/provider
	// that just worked for the conversation, so it is the safest fallback for
	// subscription/OAuth-backed providers even if it is not the absolute fastest.
	if (purpose === "translate" && ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
		add(ctx.model, "current Pi model / logged subscription");
	}

	for (const priority of priorities) {
		const slash = priority.indexOf("/");
		const provider = priority.slice(0, slash);
		const id = priority.slice(slash + 1);
		add(
			available.find((candidate) => candidate.provider === provider && candidate.id === id),
			`preferred ${priority}`,
		);
	}

	for (const model of available
		.filter((model) => model.provider === "openai" && model.id.toLowerCase().includes("mini"))
		.sort((a, b) => scoreFastModel(b, purpose) - scoreFastModel(a, purpose))) {
		add(model, "available OpenAI mini model");
	}

	for (const model of available
		.filter((model) => FAST_MODEL_KEYWORDS.some((keyword) => modelKey(model).toLowerCase().includes(keyword)))
		.sort((a, b) => scoreFastModel(b, purpose) - scoreFastModel(a, purpose))) {
		add(model, "available fast model");
	}

	if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
		add(ctx.model, "current Pi model fallback");
	}

	return choices;
}

export function resolveModel(ctx: ExtensionContext, purpose: ModelPurpose): ModelChoice | undefined {
	return resolveModelCandidates(ctx, purpose)[0];
}

export function formatModelChoice(choice: ModelChoice | undefined): string {
	if (!choice) return "none";
	return `${choice.model.provider}/${choice.model.id} (${choice.reason})`;
}
