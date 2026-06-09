import type { Terminal } from "@earendil-works/pi-tui";

export type WheelDirection = "up" | "down";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

export function enableMouseWheel(terminal: Terminal): () => void {
	terminal.write(ENABLE_MOUSE);
	let disabled = false;
	return () => {
		if (disabled) return;
		disabled = true;
		terminal.write(DISABLE_MOUSE);
	};
}

export function parseWheelInput(data: string): WheelDirection | undefined {
	// SGR mouse mode: ESC [ < button ; x ; y M
	// Wheel up = 64, wheel down = 65. Modifier bits can be ORed in, so clear
	// Shift/Alt/Ctrl/Motion bits before checking the wheel code.
	const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[mM]$/);
	if (sgr) {
		const code = Number.parseInt(sgr[1]!, 10);
		const wheel = code & ~(4 | 8 | 16 | 32);
		if (wheel === 64) return "up";
		if (wheel === 65) return "down";
	}

	// X10 mouse mode fallback: ESC [ M Cb Cx Cy.
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const code = data.charCodeAt(3) - 32;
		const wheel = code & ~(4 | 8 | 16 | 32);
		if (wheel === 64) return "up";
		if (wheel === 65) return "down";
	}
	return undefined;
}
