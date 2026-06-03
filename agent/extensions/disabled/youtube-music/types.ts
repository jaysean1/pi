// Shared data types for the youtube-music extension.

export interface Playlist {
	/** Playlist id usable with yt.music.getPlaylist (no "VL" prefix). */
	id: string;
	title: string;
	subtitle?: string;
	count?: number;
}

export interface Track {
	videoId: string;
	title: string;
	artists: string;
	duration: number; // seconds
	album?: string;
}

/** Live player state mirrored from the youtube-music-cli WS daemon. */
export interface PlayerState {
	track?: { videoId?: string; title?: string; artists?: string; duration?: number };
	isPlaying: boolean;
	progress: number; // seconds
	duration: number; // seconds
	volume: number; // 0-100
	shuffle: boolean;
	repeat: "off" | "all" | "one";
}
