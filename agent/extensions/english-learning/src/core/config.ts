import { Key } from "@earendil-works/pi-tui";

export const EXTENSION_ID = "english-learning";
export const COMMAND_NAME = "english";

// Command+Shift+M is forwarded by the user's Kaku config as a private CSI
// sequence (\x1b[993~), matching the session/diff shortcut style while avoiding
// pi-web-access's Ctrl+Shift+S and Kaku's built-in Cmd+Shift+S split toggle.
export const TRANSLATE_KEY = Key.superShift("m");
export const TRANSLATE_SEQUENCE_KAKU = "\x1b[993~";

export const REWRITE_TIMEOUT_MS = 8_000;
export const TRANSLATE_TIMEOUT_MS = 120_000;
export const MAX_TRANSLATE_CHARS = 80_000;

export const REWRITE_MODEL_PRIORITIES = [
	"openai/gpt-5-mini",
	"openai/gpt-5.4-mini",
	"openai/gpt-4.1-mini",
	"openai/gpt-5.1-codex-mini",
] as const;

export const TRANSLATE_MODEL_PRIORITIES = [
	"openai/gpt-5-mini",
	"openai/gpt-5.4-mini",
	"openai/gpt-4.1-mini",
	"openai/gpt-5.1-codex-mini",
] as const;

export const FAST_MODEL_KEYWORDS = [
	"mini",
	"lite",
	"haiku",
	"flash",
	"turbo",
] as const;
