// Constants used by diff-review modules.
// Not for session-specific state.

import { Key } from "@earendil-works/pi-tui";

export const TOGGLE_KEY = Key.superShift("right");
// Kaku terminal (WezTerm-based) emits this custom CSI for Command+Shift+Right.
// See /Applications/Kaku.app/Contents/Resources/setup_zsh.sh: bindkey '^[[992~'.
export const TOGGLE_SEQUENCE_KAKU = "\x1b[992~";
export const COMMAND_OPEN = "review";
export const COMMAND_DEMO = "review-demo";
export const TRACKED_TOOLS = new Set(["write", "edit"]);
export const PERSISTED_STATE_VERSION = 1;

export const MAX_FILE_BYTES = 512 * 1024; // Skip diffing files larger than this.
export const LCS_BUDGET = 4_000_000; // Skip exact LCS when midA*midB exceeds this; fall back to block replace.
export const SIDEBAR_MIN = 20;
export const SIDEBAR_MAX = 36;
export const SIDEBAR_RATIO = 0.2;
export const BROWSE_SIDEBAR_MIN = 24;
export const BROWSE_SIDEBAR_MAX = 52;
export const BROWSE_SIDEBAR_RATIO = 0.32;
export const LINE_NUM_WIDTH = 4;
export const DIFF_MARK_WIDTH = 2;
export const TAB_WIDTH = 2;
export const PANEL_HEIGHT_RATIO = 1;
export const MAX_BROWSE_CHILDREN = 400;

export const IGNORED_BROWSE_NAMES = new Set([
	".cache",
	".git",
	".next",
	".nuxt",
	".parcel-cache",
	".pytest_cache",
	".turbo",
	".venv",
	"__pycache__",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"tmp",
]);

// Super-modified arrow keys are reported differently per terminal. Besides the
// terminal-specific sequence above, match the CSI form ESC [ 1 ; <mod> C (right
// arrow) where <mod-1> carries shift + a command-like bit (Super / Hyper / Meta).
export const MODIFIER_SHIFT = 1;
export const MODIFIER_COMMAND_LIKE = 8 | 16 | 32;
