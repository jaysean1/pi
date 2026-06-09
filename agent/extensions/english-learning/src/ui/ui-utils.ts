import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function padTo(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	if (pad > 0) return text + " ".repeat(pad);
	return truncateToWidth(text, width, "");
}

export function wrapBlock(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
		if (wrapped.length === 0) lines.push("");
		else lines.push(...wrapped);
	}
	return lines;
}

export function prefixWrapped(
	label: string,
	text: string,
	width: number,
	style: (line: string) => string = (line) => line,
): string[] {
	const labelWidth = visibleWidth(label);
	const continuation = " ".repeat(labelWidth);
	const contentWidth = Math.max(1, width - labelWidth);
	const wrapped = wrapBlock(text, contentWidth);
	return wrapped.map((line, index) =>
		style(padTo(`${index === 0 ? label : continuation}${line}`, width)),
	);
}
