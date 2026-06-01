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
const SUMMARY_WRITE_DELAY_MS = 0;
const SUMMARY_RETRY_MS = 50;

interface RunDurationDetails {
	elapsedMs: number;
}

let startedAtMs: number | undefined;
let activeCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let pendingSummaryTimer: ReturnType<typeof setTimeout> | undefined;
let summaryGeneration = 0;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);

	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${totalSeconds}s`;
}

function renderWorkingMessage(now = Date.now()): string {
	const elapsed =
		startedAtMs === undefined ? "0s" : formatElapsed(now - startedAtMs);
	return `${BASE_MESSAGE} (${elapsed})`;
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

function unrefTimer(
	timer: ReturnType<typeof setInterval | typeof setTimeout>,
): void {
	const maybeNodeTimer = timer as unknown as { unref?: () => void };
	maybeNodeTimer.unref?.();
}

function updateWorkingMessage(): void {
	if (!activeCtx || startedAtMs === undefined) return;
	activeCtx.ui.setWorkingMessage(renderWorkingMessage());
}

function cancelPendingSummary(): void {
	summaryGeneration++;
	if (pendingSummaryTimer !== undefined) {
		clearTimeout(pendingSummaryTimer);
		pendingSummaryTimer = undefined;
	}
}

function scheduleRunDurationSummary(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	elapsedMs: number,
): void {
	const generation = ++summaryGeneration;

	const writeWhenIdle = () => {
		pendingSummaryTimer = undefined;
		if (generation !== summaryGeneration) return;

		if (!ctx.isIdle()) {
			pendingSummaryTimer = setTimeout(writeWhenIdle, SUMMARY_RETRY_MS);
			unrefTimer(pendingSummaryTimer);
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

	pendingSummaryTimer = setTimeout(writeWhenIdle, SUMMARY_WRITE_DELAY_MS);
	unrefTimer(pendingSummaryTimer);
}

function startTimer(ctx: ExtensionContext): void {
	cancelPendingSummary();
	activeCtx = ctx;
	startedAtMs ??= Date.now();
	updateWorkingMessage();

	if (refreshTimer !== undefined) return;
	refreshTimer = setInterval(updateWorkingMessage, REFRESH_MS);
	unrefTimer(refreshTimer);
}

function stopTimer(ctx?: ExtensionContext): void {
	if (refreshTimer !== undefined) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	const ctxToReset = ctx ?? activeCtx;
	startedAtMs = undefined;
	activeCtx = undefined;
	ctxToReset?.ui.setWorkingMessage();
}

export default function (pi: ExtensionAPI): void {
	pi.registerMessageRenderer<RunDurationDetails>(
		SUMMARY_TYPE,
		renderRunDuration,
	);

	pi.on("before_agent_start", () => {
		startedAtMs = Date.now();
	});

	pi.on("agent_start", (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		const elapsedMs =
			startedAtMs === undefined ? undefined : Date.now() - startedAtMs;
		stopTimer(ctx);
		if (ctx.hasUI && elapsedMs !== undefined) {
			scheduleRunDurationSummary(pi, ctx, elapsedMs);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelPendingSummary();
		stopTimer(ctx);
	});
}
