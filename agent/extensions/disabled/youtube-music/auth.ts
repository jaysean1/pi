// Authenticated youtubei.js (Innertube) client for the logged-in user.
//
// Cookie resolution order:
//   1. config.cookie / env YTM_COOKIE  (manual override, most reliable)
//   2. auto-detected from local Chromium browsers (cookies.ts) — picks the first
//      profile whose YT Music library is actually *usable* (skips accounts that
//      are signed-out or have no YouTube channel).
//
// The same authenticated client is reused for reads (library/playlists) and
// writes (like / remove-like).

import { Innertube, Log } from "youtubei.js";
import { cookieMapToHeader, listYouTubeProfiles, type ProfileCookies } from "./cookies.ts";
import { loadConfig, saveConfig } from "./config.ts";

export interface AuthResult {
	yt: Innertube;
	source: string; // where the cookie came from, for diagnostics
}

let client: Innertube | null = null;
let clientSource = "";
let clientCookieHeader = "";
let lastError: string | undefined;

export function getAuthError(): string | undefined {
	return lastError;
}

export function isReady(): boolean {
	return client !== null;
}

/** Cookie header that matches the authenticated client; used by mpv/yt-dlp. */
export function getPlaybackCookieHeader(): string | undefined {
	const cfg = loadConfig();
	return (clientCookieHeader || cfg.cookie || process.env.YTM_COOKIE || "").trim() || undefined;
}

function collectText(obj: any, out: string[] = [], depth = 0): string[] {
	if (!obj || typeof obj !== "object" || depth > 25) return out;
	for (const k of Object.keys(obj)) {
		if (k === "text" && typeof obj[k] === "string") out.push(obj[k]);
		collectText(obj[k], out, depth + 1);
	}
	return out;
}

/**
 * Is this client actually signed in to YouTube Music? We only reject a genuine
 * "Sign in" wall (not-logged-in). A "YouTube channel required" notice does NOT
 * disqualify: the account can still play tracks, like songs, and use Liked Music
 * — it just can't create custom playlists. (That notice is also intermittent.)
 */
async function probeUsable(yt: Innertube): Promise<boolean> {
	try {
		const res: any = await yt.actions.execute("/browse", {
			browseId: "FEmusic_liked_playlists",
			client: "YTMUSIC",
		});
		const signInWall = collectText(res.data).some((t) => /sign in to/i.test(t));
		return !signInWall;
	} catch {
		return false;
	}
}

/** Best-effort account identity (name + email), lowercased, for matching/diagnostics. */
async function getAccountIdentity(yt: Innertube): Promise<string> {
	try {
		const am: any = await yt.actions.execute("/account/account_menu", { client: "WEB" });
		const parts: string[] = [];
		(function w(o: any, d = 0) {
			if (!o || typeof o !== "object" || d > 30) return;
			for (const k of Object.keys(o)) {
				if (k === "email" || k === "accountName") {
					const t = o[k]?.runs?.map((r: any) => r.text).join("") ?? o[k]?.simpleText ?? (typeof o[k] === "string" ? o[k] : "");
					if (t) parts.push(String(t));
				}
				w(o[k], d + 1);
			}
		})(am.data);
		return [...new Set(parts)].join(" ").toLowerCase();
	} catch {
		return "";
	}
}

async function makeClient(cookie: string): Promise<Innertube | null> {
	try {
		Log.setLevel(Log.Level.ERROR);
		return await Innertube.create({ cookie, retrieve_player: false, generate_session_locally: true });
	} catch (err) {
		lastError = `Failed to init YouTube client: ${err instanceof Error ? err.message : String(err)}`;
		return null;
	}
}

/**
 * Get (and cache) an authenticated, *usable* Innertube client.
 * Returns null when no usable signed-in session is available; getAuthError() explains why.
 */
export async function getClient(force = false): Promise<AuthResult | null> {
	if (client && !force) return { yt: client, source: clientSource };
	lastError = undefined;
	if (force) {
		client = null;
		clientSource = "";
	}
	const cfg = loadConfig();

	// 1) Manual cookie override.
	if (cfg.cookie && cfg.cookie.trim()) {
		const yt = await makeClient(cfg.cookie.trim());
		if (!yt) return null;
		if (!(await probeUsable(yt))) {
			lastError = "The provided cookie does not grant access to this YouTube Music library. Paste a fresh Cookie header from the signed-in music.youtube.com account.";
			return null;
		}
		client = yt;
		clientSource = process.env.YTM_COOKIE ? "env:YTM_COOKIE" : "config.cookie";
		clientCookieHeader = cfg.cookie.trim();
		return { yt, source: clientSource };
	}

	// 2) Auto-detect from browsers; prefer a *usable* logged-in profile.
	const profiles = await listYouTubeProfiles({ profile: cfg.browserProfile });
	if (profiles.length === 0) {
		lastError = "No signed-in YouTube session found in any browser. Log into music.youtube.com in Chrome, or set YTM_COOKIE.";
		return null;
	}

	const want = cfg.account?.trim().toLowerCase();
	let firstLoggedIn: ProfileCookies | undefined;
	const usable: { p: ProfileCookies; yt: Innertube; header: string }[] = [];

	for (const p of profiles) {
		if (p.hasLogin && !firstLoggedIn) firstLoggedIn = p;
		const header = cookieMapToHeader(p.cookies);
		const yt = await makeClient(header);
		if (!yt) continue;
		if (!(await probeUsable(yt))) continue;
		if (!want) {
			// No account targeting: take the first usable profile.
			return pin(cfg, p, yt, header);
		}
		usable.push({ p, yt, header });
	}

	// Account targeting: pick the usable profile whose account matches.
	if (want) {
		const ids: string[] = [];
		for (const { p, yt, header } of usable) {
			const id = await getAccountIdentity(yt);
			ids.push(`${p.label}: ${id || "(unknown)"}`);
			if (id.includes(want)) return pin(cfg, p, yt, header);
		}
		lastError =
			`No logged-in profile matches account "${cfg.account}". ` +
			(ids.length ? `Found: ${ids.join("; ")}. ` : "") +
			`Log into ${cfg.account} at music.youtube.com in Chrome, then run /ytm auth.`;
		return null;
	}

	// Nothing usable.
	if (firstLoggedIn) {
		lastError =
			`Signed in as ${firstLoggedIn.label}, but YouTube Music returned a sign-in wall. ` +
			`Re-open music.youtube.com in that browser and confirm you're logged in, then run /ytm auth.`;
	} else {
		lastError =
			"Found a Google session but you're not signed in to YouTube. Open music.youtube.com in Chrome and log in.";
	}
	return null;
}

function pin(cfg: ReturnType<typeof loadConfig>, p: ProfileCookies, yt: Innertube, cookieHeader: string): AuthResult {
	client = yt;
	clientSource = `browser:${p.label}`;
	clientCookieHeader = cookieHeader;
	// Pin the working profile so future startups are fast & deterministic.
	if (cfg.browserProfile === "auto" && p.browser === "Chrome") {
		saveConfig({ ...cfg, browserProfile: p.profile });
	}
	return { yt, source: clientSource };
}

/** Drop the cached client (e.g. after cookie expiry) so the next call re-auths. */
export function resetClient(): void {
	client = null;
	clientSource = "";
	clientCookieHeader = "";
}
