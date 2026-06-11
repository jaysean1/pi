// Terminal mouse-wheel support for the diff-review overlay.
// Ported from the english-learning extension, with two changes: a fast
// touchpad flick often delivers several SGR reports in one input chunk, so
// parsing returns every wheel event instead of the first one; and click /
// release reports can be detected so callers swallow them instead of letting
// them fall through to key matching.

export type WheelDirection = "up" | "down";

// Structural terminal type so this module works with the overlay's narrow
// tui typing without importing pi-tui's Terminal.
export interface WheelTerminal {
	write(data: string): void;
}

// ?1000h: report button presses (wheel included). ?1006h: SGR encoding with
// unambiguous coordinates. Both are widely supported (iTerm2, WezTerm, kitty,
// Terminal.app, Ghostty); older terminals fall back to X10 reports.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

// SGR mouse report: ESC [ < button ; x ; y (M = press, m = release).
const SGR_EVENT = /\x1b\[<(\d+);\d+;\d+[mM]/g;
// X10 mouse report: ESC [ M followed by three payload bytes.
const X10_PREFIX = "\x1b[M";
// Shift(4) / Alt(8) / Ctrl(16) / motion(32) bits ORed into the button code.
const MODIFIER_BITS = 4 | 8 | 16 | 32;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export function enableMouseWheel(terminal: WheelTerminal): () => void {
	terminal.write(ENABLE_MOUSE);
	let disabled = false;
	return () => {
		if (disabled) return;
		disabled = true;
		terminal.write(DISABLE_MOUSE);
	};
}

function wheelFromButton(code: number): WheelDirection | undefined {
	const wheel = code & ~MODIFIER_BITS;
	if (wheel === WHEEL_UP) return "up";
	if (wheel === WHEEL_DOWN) return "down";
	return undefined;
}

// Every wheel event in the chunk, in order. Terminals batch reports during
// fast touchpad scrolling; aggregating them keeps momentum scrolling smooth.
export function parseWheelEvents(data: string): WheelDirection[] {
	const events: WheelDirection[] = [];
	for (const match of data.matchAll(SGR_EVENT)) {
		const direction = wheelFromButton(Number.parseInt(match[1] ?? "", 10));
		if (direction) events.push(direction);
	}
	// X10 reports are fixed-length: 3-byte prefix + 3 payload bytes.
	let at = data.indexOf(X10_PREFIX);
	while (at !== -1 && at + 6 <= data.length) {
		const direction = wheelFromButton(data.charCodeAt(at + 3) - 32);
		if (direction) events.push(direction);
		at = data.indexOf(X10_PREFIX, at + 6);
	}
	return events;
}

// True when the chunk consists solely of mouse reports (clicks, releases,
// non-wheel buttons). Callers swallow these so they never reach key matching.
export function isMouseSequence(data: string): boolean {
	if (data.length === 0) return false;
	const stripped = data
		.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "")
		.replace(/\x1b\[M[\s\S]{3}/g, "");
	return stripped.length === 0;
}
