/**
 * session-recap — Claude-Code-style 会话 recap，空闲一段时间后用便宜模型总结本次会话。
 *
 * 触发：agent_end 后启动空闲计时器（默认 20s）。计时到点且仍空闲、且自上次 recap
 *       以来有新内容时，调用便宜模型生成一句话 recap。
 * 展示：作为自定义「内联消息」渲染在对话流底部——紧跟在 working-timer 的
 *       「✻ Worked for …」之后、音乐播放器 widget 之上。消息 content 留空、recap 文本
 *       放在 details 里、由渲染器画出，因此不进 LLM context；随会话历史保留，/resume 后仍在。
 * 模型：默认 openai-codex/gpt-5.4-mini（复用你的订阅鉴权，不烧 Opus 额度）。
 *
 * 配置（~/.pi/agent/settings.json 或 项目级 .pi/settings.json 的 "sessionRecap" 块）：
 *   {
 *     "sessionRecap": {
 *       "enabled": true,
 *       "model": "openai-codex/gpt-5.4-mini",
 *       "idleDelayMs": 20000,
 *       "maxChars": 140,
 *       "contextChars": 8000,
 *       "language": "auto"          // "auto" = 跟随对话语言；也可填 "中文" / "English"
 *     }
 *   }
 *
 * 命令：
 *   /recap            立即刷新一次 recap
 *   /recap refresh    同上
 *   /recap on|off     运行时开关
 *   /recap status     查看当前配置
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types (defensive, version-tolerant)
// ---------------------------------------------------------------------------

type AnyModel = any;

interface RecapConfig {
	enabled: boolean;
	model: string;
	idleDelayMs: number;
	maxChars: number;
	contextChars: number;
	language: string;
}

/** Stored on the inline custom message; the renderer draws from this. */
interface RecapDetails {
	recap: string;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

interface BranchEntry {
	id?: string;
	type?: string;
	customType?: string;
	message?: MessageLike;
}

// ---------------------------------------------------------------------------
// Inline message renderer (module scope; no per-session state needed)
// ---------------------------------------------------------------------------

// customType for the inline recap message. It renders in the conversation flow,
// right below working-timer's "✻ Worked for …" message and above the music widget.
const MSG_TYPE = "session-recap/line";
const RECAP_PREFIX_TEXT = "※ recap: ";

function graphemes(text: string): string[] {
	const Segmenter = (Intl as any).Segmenter;
	if (typeof Segmenter === "function") {
		return Array.from(
			new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
			(part: any) => part.segment as string,
		);
	}
	return Array.from(text);
}

/**
 * Text's built-in word wrapper keeps a long path/URL token intact. For a short
 * recap that often leaves dozens of unused columns and looks like the line is
 * wrapping before the terminal edge. Wrap by display cells instead so the recap
 * uses the actual render(width) supplied by the TUI.
 */
function hardWrapPlainText(text: string, firstWidth: number, nextWidth: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	let limit = Math.max(1, firstWidth);

	const flush = (): void => {
		lines.push(current.trimEnd());
		current = "";
		currentWidth = 0;
		limit = Math.max(1, nextWidth);
	};

	for (const segment of graphemes(text)) {
		if (segment === "\n") {
			flush();
			continue;
		}
		if (currentWidth === 0 && segment === " ") continue;

		const segmentWidth = visibleWidth(segment);
		if (currentWidth > 0 && currentWidth + segmentWidth > limit) {
			flush();
			if (segment === " ") continue;
		}

		// Extremely narrow terminals can make a wide grapheme impossible to fit.
		// Clip rather than returning a line wider than render(width)'s contract.
		if (currentWidth === 0 && segmentWidth > limit) {
			const clipped = truncateToWidth(segment, limit, "");
			if (clipped) {
				current = clipped;
				currentWidth = visibleWidth(clipped);
				flush();
			}
			continue;
		}

		current += segment;
		currentWidth += segmentWidth;
	}

	if (current || lines.length === 0) lines.push(current.trimEnd());
	return lines;
}

const renderRecapMessage: MessageRenderer<RecapDetails> = (message, _options, theme) => {
	const recap = (message.details?.recap ?? "").trim();
	const prefix = theme.fg("dim", "※ ") + theme.fg("muted", theme.bold("recap: "));
	const prefixWidth = visibleWidth(RECAP_PREFIX_TEXT);
	const styleRecap = (text: string): string => theme.fg("muted", theme.italic(text));

	return {
		invalidate(): void {},
		render(width: number): string[] {
			const safeWidth = Math.max(1, Math.floor(width));
			if (safeWidth <= prefixWidth) {
				return [truncateToWidth(prefix, safeWidth, "")];
			}

			const recapLines = hardWrapPlainText(recap, safeWidth - prefixWidth, safeWidth);
			const lines = [prefix + styleRecap(recapLines[0] ?? "")];
			for (const line of recapLines.slice(1)) {
				lines.push(styleRecap(line));
			}

			return lines.map((line) =>
				visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line,
			);
		},
	};
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "sessionRecap";

const DEFAULTS: RecapConfig = {
	enabled: true,
	model: "openai-codex/gpt-5.4-mini",
	idleDelayMs: 20_000,
	maxChars: 140,
	contextChars: 8_000,
	language: "auto",
};

const SYSTEM_PROMPT = [
	"You write a single-line recap of a coding-agent session, in the style of Claude Code's session recap.",
	"Output exactly ONE concise line: what this session accomplished, plus the immediate next step if there is one.",
	"Do NOT start with 'The user asked', 'This session', 'In this conversation', or similar preambles.",
	"No markdown, no bullets, no quotes, no trailing period needed. Be specific and concrete.",
	"Write in the SAME language the conversation uses (e.g. reply in Chinese if the conversation is in Chinese).",
].join("\n");

// ---------------------------------------------------------------------------
// Per-extension-instance state
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let lastSummarizedLeafId: string | null = null;
	let runtimeEnabled = true;

	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let activeAbort: AbortController | undefined;
	let seq = 0;

	// Inline recap message renders below "✻ Worked for …", above the music widget.
	pi.registerMessageRenderer<RecapDetails>(MSG_TYPE, renderRecapMessage);

	// ---- helpers ---------------------------------------------------------

	function unref(t: ReturnType<typeof setTimeout>): void {
		(t as unknown as { unref?: () => void }).unref?.();
	}

	function clearIdleTimer(): void {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	}

	function cancelInFlight(): void {
		seq++;
		activeAbort?.abort();
		activeAbort = undefined;
	}

	function describeError(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	function report(area: string, err: unknown): void {
		const msg = describeError(err);
		// Stale ctx after session replacement is expected; stay quiet.
		if (msg.includes("stale")) return;
		console.warn(`[session-recap] ${area}: ${msg}`);
	}

	// ---- config (global + project merge) ---------------------------------

	function readJson(path: string): Record<string, unknown> {
		try {
			if (!existsSync(path)) return {};
			return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch (err) {
			report(`settings ${path}`, err);
			return {};
		}
	}

	function getConfig(ctx: ExtensionContext): RecapConfig {
		const home =
			process.env.PI_CODING_AGENT_DIR ||
			join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
		const global = (readJson(join(home, "settings.json"))[SETTINGS_KEY] ??
			{}) as Partial<RecapConfig>;
		const project = (readJson(join(ctx.cwd, ".pi", "settings.json"))[SETTINGS_KEY] ??
			{}) as Partial<RecapConfig>;
		const merged = { ...DEFAULTS, ...global, ...project };
		return {
			enabled: merged.enabled !== false,
			model: (merged.model || DEFAULTS.model).trim(),
			idleDelayMs:
				Number.isFinite(merged.idleDelayMs) && merged.idleDelayMs! >= 0
					? Math.floor(merged.idleDelayMs!)
					: DEFAULTS.idleDelayMs,
			maxChars:
				Number.isFinite(merged.maxChars) && merged.maxChars! > 0
					? Math.floor(merged.maxChars!)
					: DEFAULTS.maxChars,
			contextChars:
				Number.isFinite(merged.contextChars) && merged.contextChars! > 0
					? Math.floor(merged.contextChars!)
					: DEFAULTS.contextChars,
			language: (merged.language || DEFAULTS.language).trim(),
		};
	}

	// ---- session reading -------------------------------------------------

	function extractText(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return (content as ContentBlock[])
			.map((b) => {
				if (!b || typeof b !== "object") return "";
				if (b.type === "text") return b.text ?? "";
				if (b.type === "toolCall" && b.name) return `[tool: ${b.name}]`;
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}

	function getBranch(ctx: ExtensionContext): BranchEntry[] {
		try {
			return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
		} catch {
			return [];
		}
	}

	/** Build the conversation text and detect whether there is new content. */
	function collect(
		ctx: ExtensionContext,
		cfg: RecapConfig,
	): { text: string; leafId: string | null; hasContent: boolean } {
		const branch = getBranch(ctx);
		const leafId =
			(typeof ctx.sessionManager.getLeafId === "function"
				? ctx.sessionManager.getLeafId()
				: null) ?? null;

		let firstUser = "";
		const turns: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractText(entry.message?.content).trim();
			if (!text) continue;
			if (role === "user" && !firstUser) firstUser = text;
			turns.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		}

		if (turns.length === 0) {
			return { text: "", leafId, hasContent: false };
		}

		// Keep the first prompt (intent) + the tail (recent progress), capped.
		let body = turns.join("\n\n");
		if (body.length > cfg.contextChars) {
			const tail = body.slice(-cfg.contextChars);
			const head = firstUser ? `User (first request): ${firstUser}\n\n…\n\n` : "";
			body = head + tail;
		}
		return { text: body, leafId, hasContent: true };
	}

	// ---- model call ------------------------------------------------------

	function pickModel(ctx: ExtensionContext, ref: string): AnyModel | undefined {
		const slash = ref.indexOf("/");
		if (slash <= 0) return undefined;
		const provider = ref.slice(0, slash).trim();
		const modelId = ref.slice(slash + 1).trim();
		try {
			return ctx.modelRegistry.find(provider, modelId);
		} catch {
			return undefined;
		}
	}

	function cleanLine(text: string, maxChars: number): string {
		let line =
			text
				.split("\n")
				.map((s) => s.trim())
				.find(Boolean) ?? "";
		line = line
			.replace(/^[-•*\d.)\s]+/, "")
			.replace(/^recap\s*[:：]\s*/i, "")
			.replace(/^['"`]+|['"`]+$/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (line.length > maxChars) line = `${line.slice(0, maxChars - 1).trimEnd()}…`;
		return line;
	}

	async function generate(
		ctx: ExtensionContext,
		cfg: RecapConfig,
		conversation: string,
	): Promise<string | null> {
		const model = pickModel(ctx, cfg.model);
		if (!model) {
			report("model", `"${cfg.model}" not found in registry`);
			return null;
		}

		let apiKey: string | undefined;
		let headers: Record<string, string> | undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				report("auth", auth.error);
				return null;
			}
			apiKey = auth.apiKey;
			headers = auth.headers;
		} catch (err) {
			report("auth", err);
			return null;
		}

		const abort = new AbortController();
		activeAbort = abort;

		const langLine =
			cfg.language && cfg.language.toLowerCase() !== "auto"
				? `Write the recap in: ${cfg.language}.`
				: "Write the recap in the same language as the conversation.";

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: `${langLine}\n\nSummarize this session in one line (≤ ${cfg.maxChars} chars):\n\n${conversation}`,
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 200,
					reasoning: "low",
					signal: abort.signal,
					apiKey,
					headers,
				},
			);

			if (activeAbort === abort) activeAbort = undefined;

			const raw = (response.content ?? [])
				.filter((b: ContentBlock) => b.type === "text" && typeof b.text === "string")
				.map((b: ContentBlock) => b.text as string)
				.join("\n");
			const line = cleanLine(raw, cfg.maxChars);
			return line || null;
		} catch (err) {
			if (abort.signal.aborted) return null;
			report("generate", err);
			return null;
		}
	}

	// ---- display: inline custom message ----------------------------------

	// Emit the recap as an inline message in the conversation flow. content is left
	// empty (so convertToLlm sends nothing meaningful to the model — no context
	// pollution); the visible text lives in details.recap and is drawn by the renderer.
	// It lands directly below working-timer's "✻ Worked for …" message (added at
	// agent_end) and above the music player widget.
	function emitRecapMessage(recap: string): void {
		pi.sendMessage<RecapDetails>(
			{ customType: MSG_TYPE, content: "", display: true, details: { recap } },
			{ triggerTurn: false },
		);
	}

	// ---- orchestration ---------------------------------------------------

	async function runRecap(
		ctx: ExtensionContext,
		opts: { force?: boolean; notify?: boolean } = {},
	): Promise<void> {
		const cfg = getConfig(ctx);
		if (!cfg.enabled || !runtimeEnabled) return;

		const { text, leafId, hasContent } = collect(ctx, cfg);
		if (!hasContent) {
			if (opts.notify && ctx.hasUI) ctx.ui.notify("[recap] 没有可总结的内容", "info");
			return;
		}
		// Skip if nothing new since last recap (unless forced).
		if (!opts.force && leafId && leafId === lastSummarizedLeafId) return;

		cancelInFlight();
		const mySeq = ++seq;
		if (opts.notify && ctx.hasUI) ctx.ui.notify("[recap] 生成中…", "info");

		const recap = await generate(ctx, cfg, text);
		if (mySeq !== seq) return; // superseded by a new turn
		if (!recap) return;

		lastSummarizedLeafId = leafId;
		emitRecapMessage(recap);
	}

	function scheduleIdleRecap(ctx: ExtensionContext): void {
		const cfg = getConfig(ctx);
		if (!cfg.enabled || !runtimeEnabled) return;

		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			// Only fire if the user hasn't started a new turn in the meantime.
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
			void runRecap(ctx);
		}, cfg.idleDelayMs);
		unref(idleTimer);
	}

	// ---- events ----------------------------------------------------------

	pi.on("session_start", async (_event, _ctx) => {
		// Reset per-session in-memory state. Past recap messages re-render from the
		// session history automatically via the registered renderer, so there is no
		// widget/state to restore here.
		clearIdleTimer();
		cancelInFlight();
		lastSummarizedLeafId = null;
		runtimeEnabled = true;
	});

	// A new turn is starting → a pending idle recap for the previous turn is now
	// stale; stop any pending/in-flight work (the already-shown messages stay).
	pi.on("before_agent_start", async (_event, _ctx) => {
		clearIdleTimer();
		cancelInFlight();
	});

	// Turn finished → wait for idle, then summarize.
	pi.on("agent_end", async (_event, ctx) => {
		scheduleIdleRecap(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		clearIdleTimer();
		cancelInFlight();
	});

	// ---- command ---------------------------------------------------------

	pi.registerCommand("recap", {
		description: "立即刷新会话 recap（on/off/status 控制开关）",
		getArgumentCompletions: (prefix: string) => {
			const items = ["refresh", "on", "off", "status"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "off") {
				runtimeEnabled = false;
				clearIdleTimer();
				cancelInFlight();
				ctx.ui.notify("[recap] 已关闭（本会话）", "info");
				return;
			}
			if (arg === "on") {
				runtimeEnabled = true;
				ctx.ui.notify("[recap] 已开启", "info");
				return;
			}
			if (arg === "status") {
				const cfg = getConfig(ctx);
				ctx.ui.notify(
					`[recap] enabled=${cfg.enabled && runtimeEnabled} model=${cfg.model} idle=${Math.round(
						cfg.idleDelayMs / 1000,
					)}s`,
					"info",
				);
				return;
			}
			// default / "refresh": force an immediate recap
			await ctx.waitForIdle();
			await runRecap(ctx, { force: true, notify: true });
		},
	});
}
