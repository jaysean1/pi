// Shows elapsed prompt time beside Pi's built-in working message.
// Not for queueing messages while the agent is still streaming.

import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";

const BASE_MESSAGE = "Working...";
const REFRESH_MS = 1000;
const SUMMARY_TYPE = "working-timer/run-duration";
const STATUS_KEY = "working-timer";
const SUMMARY_WRITE_DELAY_MS = 0;
const SUMMARY_RETRY_MS = 50;

type Timer = ReturnType<typeof setTimeout>;

interface RunDurationDetails {
	elapsedMs: number;
}

interface TimerState {
	startedAtMs?: number;
	activeCtx?: ExtensionContext;
	refreshTimer?: Timer;
	pendingSummaryTimer?: Timer;
	summaryGeneration: number;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);

	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${totalSeconds}s`;
}

const renderRunDuration: MessageRenderer<RunDurationDetails> = (
	message,
	_options,
	theme,
) => {
	const elapsedMs = message.details?.elapsedMs ?? 0;
	const line = theme.fg("dim", `\u273b Worked for ${formatElapsed(elapsedMs)}`);
	return {
		render: () => [line],
		invalidate: () => {},
	};
};

function unrefTimer(timer: Timer): void {
	const maybeNodeTimer = timer as unknown as { unref?: () => void };
	maybeNodeTimer.unref?.();
}

export default function (pi: ExtensionAPI): void {
	// Keep runtime state inside the extension factory. Pi-subagents starts child
	// AgentSession instances in the same Node process and may load this extension
	// for both the parent session and subagent sessions. Module-level timer state
	// would be shared across those runtimes, letting a child subagent clear the
	// parent's in-flight timer and causing the visible Working/Worked-for status to
	// freeze or disappear.
	const state: TimerState = { summaryGeneration: 0 };

	function getElapsedLabel(now = Date.now()): string {
		return state.startedAtMs === undefined
			? "0s"
			: formatElapsed(now - state.startedAtMs);
	}

	function renderWorkingMessage(now = Date.now()): string {
		return `${BASE_MESSAGE} (${getElapsedLabel(now)})`;
	}

	function renderStatusMessage(now = Date.now()): string {
		return `✻ Working for ${getElapsedLabel(now)}`;
	}

	function updateWorkingMessage(): void {
		if (!state.activeCtx || state.startedAtMs === undefined) return;
		const now = Date.now();
		state.activeCtx.ui.setWorkingMessage(renderWorkingMessage(now));
		// `setWorkingMessage()` only affects Pi's transient streaming loader. Mirror
		// the timer into the extension status surface as well, so it remains visible
		// with custom footers/statuslines and in layouts where the loader is hidden.
		state.activeCtx.ui.setStatus(STATUS_KEY, renderStatusMessage(now));
	}

	function cancelPendingSummary(): void {
		state.summaryGeneration++;
		if (state.pendingSummaryTimer !== undefined) {
			clearTimeout(state.pendingSummaryTimer);
			state.pendingSummaryTimer = undefined;
		}
	}

	function scheduleRunDurationSummary(
		ctx: ExtensionContext,
		elapsedMs: number,
	): void {
		const generation = ++state.summaryGeneration;

		const writeWhenIdle = () => {
			state.pendingSummaryTimer = undefined;
			if (generation !== state.summaryGeneration) return;

			if (!ctx.isIdle()) {
				state.pendingSummaryTimer = setTimeout(
					writeWhenIdle,
					SUMMARY_RETRY_MS,
				);
				unrefTimer(state.pendingSummaryTimer);
				return;
			}

			pi.sendMessage<RunDurationDetails>(
				{
					customType: SUMMARY_TYPE,
					content: "",
					display: true,
					details: { elapsedMs },
				},
				{ triggerTurn: false },
			);
		};

		state.pendingSummaryTimer = setTimeout(
			writeWhenIdle,
			SUMMARY_WRITE_DELAY_MS,
		);
		unrefTimer(state.pendingSummaryTimer);
	}

	function startTimer(ctx: ExtensionContext): void {
		cancelPendingSummary();
		state.activeCtx = ctx;
		state.startedAtMs ??= Date.now();
		updateWorkingMessage();

		if (state.refreshTimer !== undefined) return;
		state.refreshTimer = setInterval(updateWorkingMessage, REFRESH_MS);
		unrefTimer(state.refreshTimer);
	}

	function stopTimer(ctx?: ExtensionContext): void {
		if (state.refreshTimer !== undefined) {
			clearInterval(state.refreshTimer);
			state.refreshTimer = undefined;
		}

		const ctxToReset = ctx ?? state.activeCtx;
		state.startedAtMs = undefined;
		state.activeCtx = undefined;
		ctxToReset?.ui.setWorkingMessage();
		ctxToReset?.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.registerMessageRenderer<RunDurationDetails>(
		SUMMARY_TYPE,
		renderRunDuration,
	);

	pi.on("before_agent_start", () => {
		state.startedAtMs = Date.now();
	});

	pi.on("agent_start", (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		const elapsedMs =
			state.startedAtMs === undefined
				? undefined
				: Date.now() - state.startedAtMs;
		stopTimer(ctx);
		if (ctx.hasUI && elapsedMs !== undefined) {
			scheduleRunDurationSummary(ctx, elapsedMs);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelPendingSummary();
		stopTimer(ctx);
	});
}
