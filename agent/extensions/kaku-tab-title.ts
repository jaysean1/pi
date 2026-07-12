import path from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "kaku-tab-title";
const MAX_TITLE_CHARS = 28;
const MAX_CONTEXT_CHARS = 3000;

const TITLE_SYSTEM_PROMPT = `You generate short terminal tab titles for coding-agent sessions.
Return only the title, no quotes, no markdown, no explanation.
Rules:
- 2 to 5 words when possible
- <= 28 characters when possible
- Same language as the user's task
- Summarize the task intent, not errors or internal limitations
- Never output JSON, brackets, code fences, or fallback/apology text`;

type PickedModel = {
	model: any;
	auth: { apiKey: string; headers?: Record<string, string | null> };
};

type SavedState =
	| { kind: "llm"; title: string }
	| { kind: "llm-started"; title?: string }
	| { kind: "llm-failed"; error?: string }
	| { kind: "manual"; title: string }
	| { kind: "manual-reset" };

function projectTitle(ctx: ExtensionContext): string {
	return sanitizeTitle(path.basename(ctx.cwd) || ctx.cwd, MAX_TITLE_CHARS) || "pi";
}

function isDisallowedTitleChar(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x00ad ||
		code === 0x034f ||
		code === 0x061c ||
		code === 0x180e ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x206f) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xfeff
	);
}

function truncateChars(text: string, maxChars: number): string {
	const chars = [...text];
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function sanitizeTitle(input: string, maxChars = MAX_TITLE_CHARS): string {
	let text = [...input]
		.filter((ch) => !isDisallowedTitleChar(ch))
		.join("")
		.split(/\r?\n/)
		.find((line) => line.trim().length > 0)
		?.trim() ?? "";

	text = text
		.replace(/^```[a-z]*\s*/i, "")
		.replace(/^[-*•]\s*/, "")
		.replace(/^title\s*[:：]\s*/i, "")
		.replace(/^["'`“”‘’]+|["'`“”‘’.。]+$/g, "")
		.replace(/[{}\[\]<>]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return truncateChars(text, maxChars);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function buildTitleContext(event: any, ctx: ExtensionContext): string {
	const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
	const eventMessages = Array.isArray(event?.messages) ? event.messages : [];
	const branchMessages = ctx.sessionManager
		.getBranch()
		.filter((entry: any) => entry.type === "message")
		.map((entry: any) => entry.message);
	const messages = eventMessages.length > 0 ? eventMessages : branchMessages;

	let firstUser = prompt;
	let lastAssistant = "";
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: string }).role;
		const text = textFromContent((message as { content?: unknown }).content).trim();
		if (!text) continue;
		if (role === "user" && !firstUser) firstUser = text;
		if (role === "assistant") lastAssistant = text;
	}

	const context = [
		`Project: ${projectTitle(ctx)}`,
		firstUser ? `User task:\n${firstUser}` : "",
		lastAssistant ? `Assistant result:\n${lastAssistant}` : "",
	]
		.filter(Boolean)
		.join("\n\n");

	return truncateChars(context, MAX_CONTEXT_CHARS);
}

async function authFor(ctx: ExtensionContext, model: any): Promise<PickedModel | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	return { model, auth: { apiKey: auth.apiKey, headers: auth.headers } };
}

async function pickTitleModel(ctx: ExtensionContext): Promise<PickedModel | null> {
	const preferred: Array<[string, string]> = [
		["openai-codex", "gpt-5.3-codex-spark"],
		["openai-codex", "gpt-5.4-mini"],
		["openai-codex", "gpt-5.5"],
		["openai", "gpt-5.4-mini"],
		["openai", "gpt-5.4-nano"],
	];

	for (const [provider, id] of preferred) {
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) continue;
		const picked = await authFor(ctx, model);
		if (picked) return picked;
	}

	if (ctx.model?.provider?.startsWith("openai")) {
		const picked = await authFor(ctx, ctx.model);
		if (picked) return picked;
	}

	const available = await ctx.modelRegistry.getAvailable();
	const model =
		available.find((m: any) => m.provider === "openai-codex" && /spark|mini|nano/i.test(m.id)) ??
		available.find((m: any) => String(m.provider).startsWith("openai"));
	return model ? authFor(ctx, model) : null;
}

function fallbackTitleFromPrompt(event: any, ctx: ExtensionContext): string {
	const prompt = typeof event?.prompt === "string" ? event.prompt : "";
	return sanitizeTitle(prompt) || projectTitle(ctx);
}

async function generateTitle(event: any, ctx: ExtensionContext): Promise<string> {
	const picked = await pickTitleModel(ctx);
	if (!picked) throw new Error("No authenticated OpenAI/Codex model found");

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildTitleContext(event, ctx) }],
		timestamp: Date.now(),
	};

	const response = await complete(
		picked.model,
		{ systemPrompt: TITLE_SYSTEM_PROMPT, messages: [userMessage] },
		{
			apiKey: picked.auth.apiKey,
			headers: picked.auth.headers,
			maxTokens: 40,
			reasoningEffort: "low",
			textVerbosity: "low",
			timeoutMs: 10_000,
			maxRetries: 0,
		},
	);

	const raw = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const title = sanitizeTitle(raw);
	if (!title) {
		throw new Error(
			`Model returned an empty title (${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}; content=${JSON.stringify(response.content).slice(0, 300)})`,
		);
	}
	return title;
}

export default function kakuTabTitle(pi: ExtensionAPI) {
	let manualTitle: string | undefined;
	let generatedTitle: string | undefined;
	let provisionalTitle: string | undefined;
	let titleAttempted = false;
	let titleGeneration = 0;
	let lastTerminalApplied: string | undefined;
	let lastKakuApplied: string | undefined;

	function currentBaseTitle(ctx: ExtensionContext): string {
		return manualTitle || generatedTitle || provisionalTitle || projectTitle(ctx);
	}

	async function applyTitle(ctx: ExtensionContext, status?: "working") {
		const base = currentBaseTitle(ctx);
		const title = status === "working" ? sanitizeTitle(`${base} · working`) : base;
		if (!title) return;

		if (title !== lastTerminalApplied) {
			ctx.ui.setTitle(title);
			lastTerminalApplied = title;
		}
		if (process.env.TERM_PROGRAM !== "Kaku" || title === lastKakuApplied) return;

		const paneArgs = process.env.WEZTERM_PANE ? ["--pane-id", process.env.WEZTERM_PANE] : [];
		let lastError = "unknown error";
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const result = await pi.exec("kaku", ["cli", "set-tab-title", ...paneArgs, title], { timeout: 3000 });
				if (!result.killed && result.code === 0) {
					lastKakuApplied = title;
					return;
				}
				lastError = `exit=${result.code}${result.killed ? ", killed" : ""}${result.stderr ? `: ${result.stderr.trim()}` : ""}`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200));
		}

		console.warn(`[${STATE_TYPE}] Failed to apply Kaku tab title after 2 attempts: ${lastError}`);
	}

	async function startTitleGeneration(event: any, ctx: ExtensionContext) {
		if (titleAttempted || manualTitle) return;

		titleAttempted = true;
		const generation = ++titleGeneration;
		const title = fallbackTitleFromPrompt(event, ctx);
		provisionalTitle = title;
		pi.appendEntry(STATE_TYPE, { kind: "llm-started", title } satisfies SavedState);
		await applyTitle(ctx, "working");

		void (async () => {
			try {
				const title = await generateTitle(event, ctx);
				if (generation !== titleGeneration || manualTitle) return;
				generatedTitle = title;
				provisionalTitle = undefined;
				pi.appendEntry(STATE_TYPE, { kind: "llm", title } satisfies SavedState);
				ctx.ui.notify(`Tab title: ${title}`, "info");
				await applyTitle(ctx, ctx.isIdle() ? undefined : "working");
			} catch (error) {
				if (generation !== titleGeneration || manualTitle) return;
				const message = error instanceof Error ? error.message : String(error);
				pi.appendEntry(STATE_TYPE, { kind: "llm-failed", error: message } satisfies SavedState);
				if (ctx.hasUI) ctx.ui.notify(`Tab title failed: ${truncateChars(message, 90)}`, "warning");
			}
		})();
	}

	function restoreState(ctx: ExtensionContext) {
		manualTitle = undefined;
		generatedTitle = undefined;
		provisionalTitle = undefined;
		titleAttempted = false;
		lastTerminalApplied = undefined;
		lastKakuApplied = undefined;
		titleGeneration++;

		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as SavedState | undefined;
			if (!data || typeof data !== "object") continue;
			if (data.kind === "llm" && data.title) {
				generatedTitle = sanitizeTitle(data.title);
				provisionalTitle = undefined;
				titleAttempted = true;
			} else if (data.kind === "llm-started") {
				if (data.title) provisionalTitle = sanitizeTitle(data.title);
				titleAttempted = true;
			} else if (data.kind === "llm-failed") {
				titleAttempted = true;
			} else if (data.kind === "manual" && data.title) {
				manualTitle = sanitizeTitle(data.title);
			} else if (data.kind === "manual-reset") {
				manualTitle = undefined;
				generatedTitle = undefined;
				provisionalTitle = undefined;
				titleAttempted = false;
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		await applyTitle(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await startTitleGeneration(event, ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await applyTitle(ctx, "working");
	});

	pi.on("agent_end", async (_event, ctx) => {
		await applyTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		titleGeneration++;
		await applyTitle(ctx);
	});

	pi.registerCommand("tab-name", {
		description: "Set current Kaku tab title; no args restores automatic title",
		handler: async (args, ctx) => {
			const title = sanitizeTitle(args || "");
			if (title) {
				titleGeneration++;
				manualTitle = title;
				pi.appendEntry(STATE_TYPE, { kind: "manual", title } satisfies SavedState);
				await applyTitle(ctx);
				ctx.ui.notify(`Tab title: ${title}`, "info");
			} else {
				titleGeneration++;
				manualTitle = undefined;
				generatedTitle = undefined;
				provisionalTitle = undefined;
				titleAttempted = false;
				pi.appendEntry(STATE_TYPE, { kind: "manual-reset" } satisfies SavedState);
				await applyTitle(ctx);
				ctx.ui.notify("Tab title will auto-generate after next message", "info");
			}
		},
	});
}
