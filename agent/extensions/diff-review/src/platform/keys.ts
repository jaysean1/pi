// Detect diff-review keyboard shortcuts.
// Not for UI rendering or file persistence.

import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import {
	MODIFIER_COMMAND_LIKE,
	MODIFIER_SHIFT,
	TOGGLE_KEY,
	TOGGLE_SEQUENCE_KAKU,
} from "../core/constants.ts";

export function isToggleKey(data: string): boolean {
	if (data === TOGGLE_SEQUENCE_KAKU) return true;
	if (matchesKey(data, TOGGLE_KEY)) return true;
	const csiPrefix = `${String.fromCharCode(27)}[1;`;
	if (!data.startsWith(csiPrefix) || !data.endsWith("C")) return false;
	const rawModifier = data.slice(csiPrefix.length, -1).split(":")[0];
	if (!rawModifier) return false;
	const modifier = Number.parseInt(rawModifier, 10) - 1;
	return (
		(modifier & MODIFIER_SHIFT) !== 0 &&
		(modifier & MODIFIER_COMMAND_LIKE) !== 0
	);
}

// Human-readable description of a raw key sequence, for the /review debug-keys helper.
export function describeKeyInput(data: string): string {
	const key = parseKey(data) ?? "unparsed";
	const escaped = data
		.split(String.fromCharCode(27))
		.join("\\x1b")
		.split("\r")
		.join("\\r")
		.split("\n")
		.join("\\n")
		.split("\t")
		.join("\\t");
	const codes = Array.from(data, (ch) =>
		ch.charCodeAt(0).toString(16).padStart(2, "0"),
	).join(" ");
	return `${key} | ${escaped || "(empty)"} | ${codes || "no-bytes"}`;
}
