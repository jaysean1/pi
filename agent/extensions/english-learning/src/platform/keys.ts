import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { TRANSLATE_KEY, TRANSLATE_SEQUENCE_KAKU } from "../core/config.ts";

const CSI = String.fromCharCode(27) + "[";

export function isTranslateToggleKey(data: string): boolean {
	if (data === TRANSLATE_SEQUENCE_KAKU) return true;
	if (matchesKey(data, TRANSLATE_KEY)) return true;

	// Common Kitty / CSI-u variants for Command(Super)+Shift+M. The Kaku private
	// sequence above is the reliable path; these keep the shortcut portable in
	// terminals that pass Super-modified letters directly.
	if (
		data === `${CSI}109;10u` ||
		data === `${CSI}77;9u` ||
		data === `${CSI}77;10u`
	) {
		return true;
	}

	const parsed = parseKey(data);
	return parsed === "super+shift+m" || parsed === "shift+super+m";
}

export function isTranslateToggleKeyPress(data: string): boolean {
	return isTranslateToggleKey(data) && !isKeyRelease(data) && !isKeyRepeat(data);
}

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
