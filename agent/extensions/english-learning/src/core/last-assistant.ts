import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textFromContent } from "./text-utils.ts";

export interface LastAssistantText {
	entryId: string;
	text: string;
	stopReason?: string;
}

export function getLastAssistantText(ctx: ExtensionContext): LastAssistantText | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown; stopReason?: string };
		if (message.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (!text) continue;
		return {
			entryId: entry.id,
			text,
			stopReason: message.stopReason,
		};
	}
	return undefined;
}
