// Bash command classification for diff-review tracking.
// Keep this conservative: skip scans only for commands that are clearly read-only.

const READ_ONLY_COMMANDS = new Set([
	"[",
	"awk",
	"basename",
	"cat",
	"cd",
	"clear",
	"cut",
	"date",
	"df",
	"dirname",
	"dirs",
	"du",
	"echo",
	"egrep",
	"false",
	"fgrep",
	"file",
	"find",
	"grep",
	"head",
	"history",
	"hostname",
	"jq",
	"less",
	"ls",
	"md5sum",
	"more",
	"popd",
	"printf",
	"ps",
	"pushd",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sed",
	"sha1sum",
	"sha256sum",
	"sleep",
	"sort",
	"stat",
	"tail",
	"test",
	"type",
	"tr",
	"tree",
	"true",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
	"where",
	"yq",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"rev-list",
	"rev-parse",
	"show",
	"status",
]);

function parseToolInput(input: unknown): unknown {
	if (typeof input !== "string") return input;
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}

export function extractBashCommand(input: unknown): string | undefined {
	const value = parseToolInput(input);
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const command = record.command ?? record.cmd;
	return typeof command === "string" ? command : undefined;
}

function hasCommandSubstitution(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (!quote && ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
	}
	return false;
}

function maskQuotedShell(command: string): string {
	let out = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	for (const ch of command) {
		if (quote) {
			if (quote !== "'" && escaped) {
				escaped = false;
				out += ch === "\n" ? "\n" : " ";
				continue;
			}
			if (quote !== "'" && ch === "\\") {
				escaped = true;
				out += " ";
				continue;
			}
			if (ch === quote) quote = undefined;
			out += ch === "\n" ? "\n" : " ";
			continue;
		}

		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			out += " ";
			continue;
		}
		out += ch;
	}

	return out;
}

function stripComments(command: string): string {
	return command
		.split("\n")
		.map((line) => {
			const match = line.match(/(^|\s)#/);
			return match?.index === undefined ? line : line.slice(0, match.index);
		})
		.join("\n");
}

interface OutputRedirection {
	targetStart: number;
	operator: string;
}

function outputRedirectionAt(
	command: string,
	index: number,
): OutputRedirection | undefined {
	if (index > 0 && command[index - 1] === "\\") return undefined;

	const ch = command[index];
	if (ch === "&" && command[index + 1] === ">") {
		let end = index + 2;
		if (command[end] === ">") end++;
		return { targetStart: end, operator: command.slice(index, end) };
	}

	let redirect = index;
	while (/\d/.test(command[redirect] ?? "")) redirect++;
	if (command[redirect] !== ">") return undefined;

	let end = redirect + 1;
	if (command[end] === ">" || command[end] === "|" || command[end] === "&") {
		end++;
	}
	return { targetStart: end, operator: command.slice(redirect, end) };
}

function readRedirectionTarget(
	command: string,
	start: number,
): { token: string; end: number } | undefined {
	let i = start;
	while (i < command.length && /\s/.test(command[i]!)) i++;
	if (i >= command.length) return undefined;

	let token = "";
	while (i < command.length) {
		const ch = command[i]!;
		if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&") break;
		if (ch === "\\") {
			token += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		token += ch;
		i++;
	}
	return token ? { token, end: i } : undefined;
}

function isSafeOutputRedirectTarget(
	operator: string,
	target: string | undefined,
): boolean {
	if (!target) return false;
	if (target === "/dev/null") return true;
	if (operator === ">&") return target === "-" || /^\d+$/.test(target);
	return false;
}

function hasOutputRedirection(maskedCommand: string): boolean {
	// Only file-writing output redirections should make an otherwise read-only
	// command scan the project. Harmless shell plumbing such as `2>/dev/null`,
	// `>/dev/null`, and `2>&1` does not touch reviewable files.
	for (let i = 0; i < maskedCommand.length; i++) {
		const redirect = outputRedirectionAt(maskedCommand, i);
		if (!redirect) continue;
		const target = readRedirectionTarget(maskedCommand, redirect.targetStart);
		if (!isSafeOutputRedirectTarget(redirect.operator, target?.token)) return true;
		i = target?.end ?? redirect.targetStart;
	}
	return false;
}

function commandBase(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const base = token.split(/[\\/]/).pop();
	return base?.toLowerCase();
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function unwrapCommand(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const base = commandBase(tokens[i]);
		if (isEnvAssignment(tokens[i]!)) {
			i++;
			continue;
		}
		if (base === "command" || base === "builtin" || base === "time") {
			i++;
			continue;
		}
		if (base === "env") {
			i++;
			while (i < tokens.length) {
				const t = tokens[i]!;
				if (isEnvAssignment(t)) {
					i++;
					continue;
				}
				if (t === "-i" || t === "-") {
					i++;
					continue;
				}
				if (t === "-u" || t === "--unset") {
					i += 2;
					continue;
				}
				if (t.startsWith("--unset=")) {
					i++;
					continue;
				}
				break;
			}
			continue;
		}
		if (base === "timeout") {
			i++;
			while (i < tokens.length && tokens[i]!.startsWith("-")) {
				const opt = tokens[i]!;
				i++;
				if (["-k", "--kill-after", "-s", "--signal"].includes(opt)) i++;
			}
			if (i < tokens.length) i++; // duration
			continue;
		}
		break;
	}
	return tokens.slice(i);
}

function includesAny(tokens: string[], values: Set<string>): boolean {
	return tokens.some((token) => values.has(token));
}

function isReadOnlyFind(tokens: string[]): boolean {
	return !includesAny(
		tokens,
		new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]),
	);
}

function isReadOnlySed(tokens: string[]): boolean {
	return !tokens.some(
		(token) =>
			token === "-i" ||
			token.startsWith("-i") ||
			token === "--in-place" ||
			token.startsWith("--in-place="),
	);
}

function gitSubcommand(tokens: string[]): {
	subcommand: string | undefined;
	rest: string[];
} {
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
			i += 2;
			continue;
		}
		if (token === "-c") {
			i += 2;
			continue;
		}
		if (
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=") ||
			token.startsWith("-c")
		) {
			i++;
			continue;
		}
		if (token.startsWith("-")) {
			i++;
			continue;
		}
		return { subcommand: token.toLowerCase(), rest: tokens.slice(i + 1) };
	}
	return { subcommand: undefined, rest: [] };
}

function isReadOnlyGit(tokens: string[]): boolean {
	const { subcommand, rest } = gitSubcommand(tokens);
	if (!subcommand) return true; // plain `git` prints help
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "remote") {
		return rest.length === 0 || rest.every((t) => t === "-v" || t === "--verbose");
	}
	if (subcommand === "stash") return rest[0] === "list" || rest[0] === "show";
	if (subcommand === "config") {
		return rest.some((t) =>
			["--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list"].includes(t),
		);
	}
	if (subcommand === "branch") {
		return (
			rest.every((t) => t.startsWith("-")) &&
			!rest.some(
				(t) =>
					/^-[dDmcC]$/.test(t) ||
					["--delete", "--move", "--copy", "--set-upstream-to"].includes(t),
			)
		);
	}
	if (subcommand === "tag") {
		return (
			rest.length === 0 ||
			rest.every((t) => t === "-l" || t === "--list" || t.startsWith("--list="))
		);
	}
	return false;
}

function isReadOnlySegment(segment: string): boolean {
	const tokens = unwrapCommand(segment.trim().split(/\s+/).filter(Boolean));
	if (tokens.length === 0) return true;
	const base = commandBase(tokens[0]);
	if (!base) return false;
	if (base === "git") return isReadOnlyGit(tokens);
	if (base === "find") return isReadOnlyFind(tokens);
	if (base === "sed") return isReadOnlySed(tokens);
	return READ_ONLY_COMMANDS.has(base);
}

function isClearlyReadOnlyBashCommand(command: string): boolean {
	if (hasCommandSubstitution(command)) return false;
	const masked = stripComments(maskQuotedShell(command));
	if (hasOutputRedirection(masked)) return false;
	const segments = masked
		.split(/&&|\|\||[;|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	return segments.length > 0 && segments.every(isReadOnlySegment);
}

export function shouldTrackBashCommand(input: unknown): boolean {
	const command = extractBashCommand(input);
	if (!command?.trim()) return true;
	return !isClearlyReadOnlyBashCommand(command);
}
