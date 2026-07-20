// Tests path-only filtering without calling Codex or consuming image-generation quota.
// Covers successful saves, fallback safety, immutability, and extension registration.

import assert from "node:assert/strict";
import test from "node:test";

import activate, { filterSavedCodexImageResult } from "./index.ts";

type Part =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

function successfulEvent(content: Part[]) {
	return {
		toolName: "codex_generate_image",
		content,
		details: { savedPath: "/tmp/generated/image.webp" },
		isError: false,
	};
}

test("removes inline images after a successful disk save", () => {
	const content: Part[] = [
		{ type: "text", text: "Saved image to /tmp/generated/image.webp" },
		{ type: "image", data: "large-base64-payload", mimeType: "image/webp" },
	];

	const result = filterSavedCodexImageResult(successfulEvent(content));

	assert.deepEqual(result, {
		content: [{ type: "text", text: "Saved image to /tmp/generated/image.webp" }],
	});
	assert.equal(content.length, 2, "the original tool result must not be mutated");
});

test("keeps inline images when no saved path is available", () => {
	const event = successfulEvent([
		{ type: "text", text: "Image was not saved to disk." },
		{ type: "image", data: "base64", mimeType: "image/png" },
	]);
	event.details = { saveMode: "none" };

	assert.equal(filterSavedCodexImageResult(event), undefined);
});

test("keeps inline images for failed tool results", () => {
	const event = successfulEvent([
		{ type: "image", data: "base64", mimeType: "image/png" },
	]);
	event.isError = true;

	assert.equal(filterSavedCodexImageResult(event), undefined);
});

test("ignores other tools and results without image content", () => {
	const otherTool = successfulEvent([
		{ type: "image", data: "base64", mimeType: "image/png" },
	]);
	otherTool.toolName = "read";

	assert.equal(filterSavedCodexImageResult(otherTool), undefined);
	assert.equal(
		filterSavedCodexImageResult(
			successfulEvent([{ type: "text", text: "Already path-only" }]),
		),
		undefined,
	);
});

test("registers a tool_result hook that returns the filtered result", () => {
	const handlers = new Map<string, (event: any) => unknown>();
	const pi = {
		on(name: string, handler: (event: any) => unknown) {
			handlers.set(name, handler);
		},
	};

	activate(pi as any);
	const handler = handlers.get("tool_result");
	assert.equal(typeof handler, "function");
	assert.deepEqual(
		handler?.(
			successfulEvent([
				{ type: "text", text: "Saved" },
				{ type: "image", data: "base64", mimeType: "image/png" },
			]),
		),
		{ content: [{ type: "text", text: "Saved" }] },
	);
});
