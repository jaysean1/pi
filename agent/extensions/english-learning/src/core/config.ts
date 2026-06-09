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
export const TRANSLATION_CACHE_MAX_ENTRIES = 50;

export const OPENAI_SUBSCRIPTION_PROVIDER = "openai-codex";

const OPENAI_SUBSCRIPTION_MODEL_PRIORITIES = [
	"openai-codex/gpt-5.4-mini",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.3-codex-spark",
] as const;

export const REWRITE_MODEL_PRIORITIES = OPENAI_SUBSCRIPTION_MODEL_PRIORITIES;
export const TRANSLATE_MODEL_PRIORITIES = OPENAI_SUBSCRIPTION_MODEL_PRIORITIES;
