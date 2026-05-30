// Sample data for the /review-demo command.
// Not for production file tracking.

import { buildDiff } from "./core/diff-engine.ts";
import type { FileDiff, FileSnapshot } from "./core/types.ts";

export function demoFiles(): FileDiff[] {
	const before: FileSnapshot = {
		kind: "text",
		text: [
			"import { add } from './math';",
			"",
			"function main() {",
			"  const x = 1;",
			"  console.log(add(x, 1));",
			"}",
			"",
			"main();",
			"",
		].join("\n"),
	};
	const after: FileSnapshot = {
		kind: "text",
		text: [
			"import { add, mul } from './math';",
			"",
			"function main() {",
			"  const x = 2;",
			"  const y = mul(x, 3);",
			"  console.log(add(x, y));",
			"}",
			"",
			"main();",
			"",
		].join("\n"),
	};
	const sample = buildDiff(before, after);
	const created = buildDiff(
		{ kind: "absent" },
		{
			kind: "text",
			text: ["# Notes", "", "First line.", "Second line.", ""].join("\n"),
		},
	);
	return [
		{
			displayPath: "src/main.ts",
			rows: sample.rows,
			added: sample.added,
			removed: sample.removed,
		},
		{
			displayPath: "docs/NOTES.md",
			rows: created.rows,
			added: created.added,
			removed: created.removed,
			isNew: true,
		},
		{
			displayPath: "assets/logo.png",
			rows: [],
			added: 0,
			removed: 0,
			note: "Binary file — diff not shown.",
		},
	];
}
