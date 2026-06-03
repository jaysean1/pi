// Local config + state for the youtube-music extension.
// Stored under ~/.pi/cache/youtube-music/ so it survives restarts and is
// outside the source tree.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface YtmConfig {
	/** WebSocket control daemon port for youtube-music-cli --web-only. */
	port: number;
	/** Auth token shared with the daemon (generated once). */
	token: string;
	/** Browser profile to read cookies from. "auto" scans for the YouTube-logged-in one. */
	browserProfile: string;
	/**
	 * Target a specific account by email/name (case-insensitive substring). When set,
	 * auto-detect picks the logged-in profile whose YT Music account matches this,
	 * instead of just the first logged-in profile. Useful with multiple accounts.
	 */
	account?: string;
	/**
	 * Optional manual cookie override. If set (or env YTM_COOKIE), used verbatim
	 * instead of auto-extracting from the browser. Paste the full Cookie header
	 * from a logged-in music.youtube.com request.
	 */
	cookie?: string;
	/** Path to the youtube-music-cli binary (defaults to "youtube-music-cli"). */
	enginePath: string;
}

const DIR = join(homedir(), ".pi", "cache", "youtube-music");
const FILE = join(DIR, "config.json");

let cached: YtmConfig | undefined;

function randomToken(): string {
	return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

const DEFAULTS: YtmConfig = {
	port: 8782,
	token: "",
	browserProfile: "auto",
	account: "jaysean.qian@gmail.com",
	enginePath: "youtube-music-cli",
};

export function configDir(): string {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
	return DIR;
}

export function loadConfig(): YtmConfig {
	if (cached) return cached;
	let cfg: YtmConfig = { ...DEFAULTS };
	try {
		if (existsSync(FILE)) {
			cfg = { ...cfg, ...(JSON.parse(readFileSync(FILE, "utf8")) as Partial<YtmConfig>) };
		}
	} catch {
		// ignore malformed config; fall back to defaults
	}
	if (!cfg.token) {
		cfg.token = randomToken();
		saveConfig(cfg);
	}
	// env override always wins for the cookie
	if (process.env.YTM_COOKIE) cfg.cookie = process.env.YTM_COOKIE;
	cached = cfg;
	return cfg;
}

export function saveConfig(cfg: YtmConfig): void {
	configDir();
	try {
		const diskCfg: YtmConfig = { ...cfg };
		// YTM_COOKIE is a runtime-only override; don't accidentally persist it
		// when another command rewrites the config.
		if (process.env.YTM_COOKIE && diskCfg.cookie === process.env.YTM_COOKIE) delete diskCfg.cookie;
		writeFileSync(FILE, JSON.stringify(diskCfg, null, 2), { mode: 0o600 });
		try { chmodSync(FILE, 0o600); } catch {}
		cached = cfg;
	} catch {
		// best effort
	}
}
