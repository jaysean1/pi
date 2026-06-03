// Data layer: authenticated reads (library playlists, tracks) + writes (like).
//
// Uses youtubei.js directly. We bypass yt.music.getLibrary() because its strict
// parser throws on some accounts; instead we do a raw /browse of the YT Music
// library endpoints and walk the JSON defensively.

import { getClient, resetClient } from "./auth.ts";
import type { Playlist, Track } from "./types.ts";

const LIKED_PLAYLISTS_BROWSE = "FEmusic_liked_playlists";
const MAX_TRACKS = 400; // safety cap across continuations

type AnyObj = Record<string, any>;

function deepCollect(obj: any, key: string, out: any[] = [], depth = 0): any[] {
	if (!obj || typeof obj !== "object" || depth > 40) return out;
	for (const k of Object.keys(obj)) {
		if (k === key) out.push(obj[k]);
		deepCollect(obj[k], key, out, depth + 1);
	}
	return out;
}

/** Find the first browseEndpoint.browseId anywhere under a node (prefer VL...). */
function findBrowseId(node: any): string | undefined {
	const eps = deepCollect(node, "browseEndpoint");
	let first: string | undefined;
	for (const ep of eps) {
		const id = ep?.browseId;
		if (typeof id !== "string") continue;
		if (id.startsWith("VL") || id.startsWith("PL") || id === "LM") return id;
		first ??= id;
	}
	return first;
}

/** Strip a leading "VL" so the id is usable with yt.music.getPlaylist(). */
function normalizePlaylistId(browseId: string): string {
	return browseId.startsWith("VL") ? browseId.slice(2) : browseId;
}

function runsText(node: any): string {
	if (!node) return "";
	if (typeof node === "string") return node;
	if (Array.isArray(node.runs)) return node.runs.map((r: AnyObj) => r.text).join("");
	if (typeof node.text === "string") return node.text;
	return "";
}

/**
 * List the signed-in user's playlists from the YT Music library, plus a
 * synthetic "Liked Music" entry. Returns [] when not authenticated.
 */
export async function getLibraryPlaylists(): Promise<Playlist[]> {
	const auth = await getClient();
	if (!auth) return [];
	const res: any = await auth.yt.actions.execute("/browse", {
		browseId: LIKED_PLAYLISTS_BROWSE,
		client: "YTMUSIC",
	});

	const playlists: Playlist[] = [];
	const seen = new Set<string>();

	// Always offer Liked Music (the canonical liked-songs auto-playlist).
	playlists.push({ id: "LM", title: "Liked Music", subtitle: "Auto playlist" });
	seen.add("LM");

	const items = deepCollect(res.data, "musicTwoRowItemRenderer");
	for (const item of items) {
		const browseId = findBrowseId(item);
		if (!browseId) continue;
		const id = normalizePlaylistId(browseId);
		if (seen.has(id)) continue;
		const title = runsText(item.title);
		if (!title) continue;
		const subtitle = runsText(item.subtitle);
		seen.add(id);
		playlists.push({ id, title, subtitle: subtitle || undefined });
	}
	return playlists;
}

function flexColumnText(item: any, index: number): string {
	const col = item?.flex_columns?.[index];
	const runs = col?.title?.runs;
	if (Array.isArray(runs)) return runs.map((r: AnyObj) => r.text).join("");
	return "";
}

/**
 * Resolve a track's videoId. Regular library playlists expose `item.id`, but the
 * "Liked Music" auto-playlist returns MusicResponsiveListItems whose `.id` is
 * undefined — there the videoId only lives in the flex-column title's
 * watchEndpoint (and the overlay play button). Fall back to a defensive deep
 * search so both shapes map correctly.
 */
function findVideoId(item: any): string | undefined {
	if (typeof item?.id === "string" && item.id) return item.id;
	for (const v of deepCollect(item, "videoId")) {
		if (typeof v === "string" && v) return v;
	}
	return undefined;
}

function mapTrack(item: any): Track | null {
	const videoId = findVideoId(item);
	if (!videoId) return null;
	const title = (typeof item.title === "string" ? item.title : runsText(item.title)) || flexColumnText(item, 0);
	// Songs expose .artists; videos expose .authors; fall back to flex column 1.
	const people = Array.isArray(item.artists) && item.artists.length
		? item.artists
		: Array.isArray(item.authors)
			? item.authors
			: [];
	const artists = people.length
		? people.map((a: AnyObj) => a?.name).filter(Boolean).join(", ")
		: flexColumnText(item, 1) || runsText(item.subtitle);
	const duration =
		typeof item.duration?.seconds === "number"
			? item.duration.seconds
			: typeof item.duration === "number"
				? item.duration
				: 0;
	const album = item.album?.name;
	return { videoId, title: title || "Unknown", artists: artists || "Unknown Artist", duration, album };
}

/** Fetch a playlist's tracks (follows continuations up to MAX_TRACKS). */
export async function getPlaylistTracks(playlistId: string): Promise<{ title: string; tracks: Track[] }> {
	const auth = await getClient();
	if (!auth) return { title: "", tracks: [] };
	const id = normalizePlaylistId(playlistId);

	let pl: any;
	try {
		pl = await auth.yt.music.getPlaylist(id);
	} catch (err) {
		// Cookie may have expired; reset so next attempt re-auths.
		resetClient();
		throw err;
	}

	const header = pl.header as AnyObj | undefined;
	const title = runsText(header?.title) || "Playlist";
	const tracks: Track[] = [];

	const collect = (items: any[]) => {
		for (const it of items ?? []) {
			if (it?.type === "ContinuationItem") continue;
			const t = mapTrack(it);
			if (t) tracks.push(t);
		}
	};
	collect(pl.items ?? pl.contents ?? []);

	let guard = 0;
	while (pl?.has_continuation && tracks.length < MAX_TRACKS && guard < 20) {
		guard++;
		try {
			pl = await pl.getContinuation();
			collect(pl.items ?? pl.contents ?? []);
		} catch {
			break;
		}
	}
	return { title, tracks: tracks.slice(0, MAX_TRACKS) };
}

/** Like (thumbs up) a track. */
export async function likeTrack(videoId: string): Promise<boolean> {
	return rate("/like/like", videoId);
}

/** Remove a like/dislike from a track. */
export async function removeLike(videoId: string): Promise<boolean> {
	return rate("/like/removelike", videoId);
}

async function rate(endpoint: string, videoId: string): Promise<boolean> {
	const auth = await getClient();
	if (!auth) return false;
	try {
		const res: any = await auth.yt.actions.execute(endpoint, {
			target: { videoId },
			client: "YTMUSIC",
		});
		return res?.success !== false;
	} catch {
		return false;
	}
}
