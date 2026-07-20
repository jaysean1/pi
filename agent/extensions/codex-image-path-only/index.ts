// Removes saved Codex image payloads before Pi stores tool results in session history.
// Keeps inline images when generation or disk saving did not complete successfully.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_IMAGE_TOOL = "codex_generate_image";

type ToolResultLike<T extends { type: string }> = {
	toolName: string;
	content: readonly T[];
	details?: unknown;
	isError?: boolean;
};

function savedPathFromDetails(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const savedPath = (details as { savedPath?: unknown }).savedPath;
	return typeof savedPath === "string" && savedPath.trim().length > 0 ? savedPath : undefined;
}

export function filterSavedCodexImageResult<T extends { type: string }>(
	event: ToolResultLike<T>,
): { content: T[] } | undefined {
	if (event.toolName !== CODEX_IMAGE_TOOL || event.isError === true) return undefined;
	if (!savedPathFromDetails(event.details)) return undefined;

	const content = event.content.filter((part) => part.type !== "image");
	return content.length === event.content.length ? undefined : { content };
}

export default function codexImagePathOnly(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => filterSavedCodexImageResult(event));
}
