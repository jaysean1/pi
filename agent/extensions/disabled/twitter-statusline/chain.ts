// Focus-chain coordination between the twitter-statusline preview and the
// diff-review footer, implemented over globalThis so the two independent
// extensions can cooperate without importing each other.
//
// Down navigation (↓ from an empty input):  input → Twitter → diff footer
// Up navigation   (↑ / Esc):                diff footer → Twitter → input
//
// The diff-review extension publishes `__piDiffChain` and reads
// `__piTwitterChain`; this module is the twitter-statusline side of that
// contract. Keep the key strings and shapes in sync with the diff-review edit.

/** Handle published by twitter-statusline; consumed by diff-review. */
export interface TwitterChainHandle {
	/** Move focus to the Twitter preview (entry point of the chain). */
	focusPreview: () => void;
	/** Whether the Twitter preview currently holds focus. */
	isPreviewFocused: () => boolean;
}

/** Handle published by diff-review; consumed by twitter-statusline. */
export interface DiffChainHandle {
	/** Move focus to the diff-review footer. */
	focusFooter: () => void;
	/** Whether the diff footer currently holds focus. */
	isFooterFocused: () => boolean;
}

const TWITTER_KEY = "__piTwitterChain";
const DIFF_KEY = "__piDiffChain";

type Root = typeof globalThis & {
	[TWITTER_KEY]?: TwitterChainHandle;
	[DIFF_KEY]?: DiffChainHandle;
};

function root(): Root {
	return globalThis as Root;
}

export function publishTwitterChain(handle: TwitterChainHandle | undefined): void {
	if (handle) root()[TWITTER_KEY] = handle;
	else delete root()[TWITTER_KEY];
}

export function getDiffChain(): DiffChainHandle | undefined {
	return root()[DIFF_KEY];
}
