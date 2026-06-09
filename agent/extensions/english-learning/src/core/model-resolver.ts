import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	OPENAI_SUBSCRIPTION_PROVIDER,
	REWRITE_MODEL_PRIORITIES,
	TRANSLATE_MODEL_PRIORITIES,
} from "./config.ts";
import type { ModelChoice, ModelPurpose } from "../types.ts";

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function isOpenAISubscriptionModel(model: Model<Api>): boolean {
	return model.provider === OPENAI_SUBSCRIPTION_PROVIDER;
}

function scoreSubscriptionModel(model: Model<Api>): number {
	const key = modelKey(model).toLowerCase();
	let score = 0;
	if (key.includes("gpt")) score += 40;
	if (key.includes("mini")) score += 35;
	if (key.includes("5.4-mini")) score += 24;
	if (key.includes("5.4")) score += 12;
	if (key.includes("5.5")) score += 10;
	if (key.includes("spark")) score -= 5;
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
		.filter((model) => isOpenAISubscriptionModel(model) && model.id.toLowerCase().includes("mini"))
		.sort((a, b) => scoreSubscriptionModel(b) - scoreSubscriptionModel(a))) {
		add(model, "available OpenAI subscription mini model");
	}

	for (const model of available
		.filter(isOpenAISubscriptionModel)
		.sort((a, b) => scoreSubscriptionModel(b) - scoreSubscriptionModel(a))) {
		add(model, "available OpenAI subscription model");
	}

	return choices;
}

export function resolveModel(ctx: ExtensionContext, purpose: ModelPurpose): ModelChoice | undefined {
	return resolveModelCandidates(ctx, purpose)[0];
}

export function formatModelChoice(choice: ModelChoice | undefined): string {
	if (!choice) return "none";
	const provider = choice.model.provider === OPENAI_SUBSCRIPTION_PROVIDER ? "openai subscription" : choice.model.provider;
	return `${provider}/${choice.model.id} (${choice.reason})`;
}
