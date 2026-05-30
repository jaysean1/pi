// Open reviewed files in external desktop apps.
// Not for diff tracking or overlay navigation.

import { extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileDiff } from "../core/types.ts";

interface LaunchCommand {
	command: string;
	args: string[];
}

function isHtmlFile(absPath: string): boolean {
	const ext = extname(absPath).toLowerCase();
	return ext === ".html" || ext === ".htm";
}

function browserLaunchCommands(absPath: string): LaunchCommand[] {
	if (process.platform === "darwin")
		return [{ command: "open", args: [absPath] }];
	if (process.platform === "win32")
		return [{ command: "cmd", args: ["/c", "start", "", absPath] }];
	return [
		{ command: "xdg-open", args: [absPath] },
		{ command: "open", args: [absPath] },
	];
}

function cursorLaunchCommands(absPath: string): LaunchCommand[] {
	if (process.platform === "darwin") {
		return [
			{ command: "open", args: ["-a", "Cursor", absPath] },
			{ command: "cursor", args: [absPath] },
		];
	}
	return [{ command: "cursor", args: [absPath] }];
}

async function runLaunchCommands(
	pi: ExtensionAPI,
	commands: LaunchCommand[],
): Promise<{ ok: true } | { ok: false; error: string }> {
	let lastError = "No launch command was available.";
	for (const candidate of commands) {
		try {
			const result = await pi.exec(candidate.command, candidate.args, {
				timeout: 8_000,
			});
			if (result.code === 0) return { ok: true };
			lastError = `${candidate.command} exited ${result.code}: ${result.stderr || result.stdout || "no output"}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	return { ok: false, error: lastError };
}

export function openExternalFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	absPath: string | undefined,
	displayPath: string,
): void {
	if (!absPath) {
		ctx.ui.notify(
			`No real file path is available for ${displayPath}.`,
			"warning",
		);
		return;
	}
	const html = isHtmlFile(absPath);
	const target = html ? "default browser" : "Cursor";
	void runLaunchCommands(
		pi,
		html ? browserLaunchCommands(absPath) : cursorLaunchCommands(absPath),
	).then((result) => {
		if (result.ok) {
			ctx.ui.notify(`Opened ${displayPath} in ${target}.`, "info");
		} else {
			ctx.ui.notify(
				`Could not open ${displayPath} in ${target}: ${result.error}`,
				"error",
			);
		}
	});
}

export function openReviewedFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	file: FileDiff,
): void {
	openExternalFile(pi, ctx, file.absPath, file.displayPath);
}
