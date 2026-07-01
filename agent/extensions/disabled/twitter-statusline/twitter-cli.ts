// Data layer for the twitter-statusline extension.
//
// Wraps the `twitter` CLI (the same binary used by the onboard `twitter-feed`
// skill, which transparently reuses the Chrome login cookies) and adds a small
// on-disk cache so the preview can rotate locally without hammering the network.
//
// Nothing here ever throws to the caller: every CLI failure degrades to the
// previous cache so the statusline never crashes the session.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TweetAuthor {
	id?: string;
	name: string;
	screenName: string;
	profileImageUrl?: string;
}

export interface TweetMetrics {
	likes: number;
	retweets: number;
	replies: number;
	quotes?: number;
	views?: number;
	bookmarks?: number;
}

export interface TweetMedia {
	type: string;
	url: string;
	width?: number;
	height?: number;
}

export interface Tweet {
	id: string;
	text: string;
	author: TweetAuthor;
	metrics: TweetMetrics;
	createdAtLocal?: string;
	createdAtISO?: string;
	media: TweetMedia[];
	urls?: string[];
	isRetweet?: boolean;
	retweetedBy?: string | null;
	lang?: string;
	score?: number | null;
}

export interface FeedCache {
	tweets: Tweet[];
	fetchedMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI = "twitter";
const CLI_TIMEOUT_MS = 20_000;
const FEED_COUNT = 20;
const CACHE_DIR = path.join(os.homedir(), ".pi", "cache", "twitter-statusline");
const CACHE_FILE = path.join(CACHE_DIR, "feed.json");

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

function runTwitter(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			CLI,
			args,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr?.toString().trim() || error.message;
					reject(new Error(detail));
					return;
				}
				resolve(stdout.toString());
			},
		);
	});
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toMedia(raw: unknown): TweetMedia[] {
	if (!Array.isArray(raw)) return [];
	const out: TweetMedia[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const m = item as Record<string, unknown>;
		if (typeof m.url === "string") {
			out.push({
				type: typeof m.type === "string" ? m.type : "media",
				url: m.url,
				width: typeof m.width === "number" ? m.width : undefined,
				height: typeof m.height === "number" ? m.height : undefined,
			});
		}
	}
	return out;
}

function toTweet(raw: unknown): Tweet | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" && typeof r.id !== "number") return undefined;
	const authorRaw = (r.author ?? {}) as Record<string, unknown>;
	const metricsRaw = (r.metrics ?? {}) as Record<string, unknown>;
	return {
		id: String(r.id),
		text: typeof r.text === "string" ? r.text : "",
		author: {
			id: authorRaw.id != null ? String(authorRaw.id) : undefined,
			name: typeof authorRaw.name === "string" ? authorRaw.name : "",
			screenName:
				typeof authorRaw.screenName === "string" ? authorRaw.screenName : "",
			profileImageUrl:
				typeof authorRaw.profileImageUrl === "string"
					? authorRaw.profileImageUrl
					: undefined,
		},
		metrics: {
			likes: num(metricsRaw.likes),
			retweets: num(metricsRaw.retweets),
			replies: num(metricsRaw.replies),
			quotes: num(metricsRaw.quotes),
			views: num(metricsRaw.views),
			bookmarks: num(metricsRaw.bookmarks),
		},
		createdAtLocal:
			typeof r.createdAtLocal === "string" ? r.createdAtLocal : undefined,
		createdAtISO: typeof r.createdAtISO === "string" ? r.createdAtISO : undefined,
		media: toMedia(r.media),
		urls: Array.isArray(r.urls) ? (r.urls.filter((u) => typeof u === "string") as string[]) : [],
		isRetweet: r.isRetweet === true,
		retweetedBy: typeof r.retweetedBy === "string" ? r.retweetedBy : null,
		lang: typeof r.lang === "string" ? r.lang : undefined,
		score: typeof r.score === "number" ? r.score : null,
	};
}

function parseDataArray(stdout: string): Tweet[] {
	const parsed = JSON.parse(stdout) as { ok?: boolean; data?: unknown };
	if (parsed.ok === false) {
		throw new Error("twitter CLI returned ok=false");
	}
	const data = parsed.data;
	if (!Array.isArray(data)) return [];
	const tweets: Tweet[] = [];
	for (const entry of data) {
		const t = toTweet(entry);
		if (t) tweets.push(t);
	}
	return tweets;
}

// ---------------------------------------------------------------------------
// Hot ranking
// ---------------------------------------------------------------------------

/** Engagement score used as a local tie-breaker on top of the CLI's --filter. */
export function hotScore(t: Tweet): number {
	const m = t.metrics;
	return m.likes + m.retweets * 2 + (m.quotes ?? 0) * 2 + m.replies + (m.bookmarks ?? 0);
}

function rankHot(tweets: Tweet[]): Tweet[] {
	// Keep the CLI's --filter ordering as the primary signal, but drop obviously
	// empty entries and de-duplicate by id.
	const seen = new Set<string>();
	const filtered = tweets.filter((t) => {
		if (!t.text.trim() && t.media.length === 0) return false;
		if (seen.has(t.id)) return false;
		seen.add(t.id);
		return true;
	});
	return filtered;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

/** Fetch the score-ranked home timeline ("hot" feed). */
export async function fetchHotFeed(): Promise<Tweet[]> {
	const stdout = await runTwitter([
		"feed",
		"--filter",
		"-n",
		String(FEED_COUNT),
		"--json",
	]);
	return rankHot(parseDataArray(stdout));
}

export interface TweetThread {
	tweet: Tweet;
	replies: Tweet[];
}

/** Fetch a single tweet with its replies. data[0] is the tweet, rest are replies. */
export async function fetchTweet(id: string, maxReplies = 8): Promise<TweetThread> {
	const stdout = await runTwitter(["tweet", id, "-n", String(maxReplies), "--json"]);
	const all = parseDataArray(stdout);
	if (all.length === 0) throw new Error("tweet not found");
	return { tweet: all[0]!, replies: all.slice(1) };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function loadCache(): FeedCache | undefined {
	try {
		const text = readFileSync(CACHE_FILE, "utf8");
		const data = JSON.parse(text) as Partial<FeedCache>;
		if (!Array.isArray(data.tweets)) return undefined;
		const tweets = data.tweets
			.map((t) => toTweet(t))
			.filter((t): t is Tweet => Boolean(t));
		return { tweets, fetchedMs: num(data.fetchedMs) };
	} catch {
		return undefined;
	}
}

export function saveCache(cache: FeedCache): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
	} catch {
		// Cache is best-effort; never surface a write failure.
	}
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(cache: FeedCache | undefined): boolean {
	if (!cache) return true;
	return Date.now() - cache.fetchedMs > STALE_AFTER_MS;
}
