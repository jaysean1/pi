// Playback engine: drives `youtube-music-cli --web-only` (mpv + yt-dlp) over its
// WebSocket control API. The daemon is a dumb executor (play URL / pause / volume);
// THIS module owns the queue, the current index and progress, because the daemon
// neither advances progress nor auto-plays the next track on its own.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { getPlaybackCookieHeader } from "./auth.ts";
import { configDir, loadConfig } from "./config.ts";
import type { PlayerState, Track } from "./types.ts";

interface EngineTrack {
	videoId: string;
	title: string;
	artists: { name: string }[];
	duration?: number;
}

function toEngineTrack(t: Track): EngineTrack {
	return { videoId: t.videoId, title: t.title, artists: t.artists ? [{ name: t.artists }] : [], duration: t.duration };
}

type Listener = () => void;
const ENGINE_VERSION = 2;

class Engine {
	readonly version = ENGINE_VERSION;
	private proc: ChildProcess | undefined;
	private ws: WebSocket | undefined;
	private starting: Promise<boolean> | undefined;
	private connected = false;

	private queue: Track[] = [];
	private index = 0;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private listeners = new Set<Listener>();
	private lastError: string | undefined;
	private playbackCookieFile: string | undefined;
	private mpvWrapperPath: string | undefined;

	private state: PlayerState = {
		track: undefined,
		isPlaying: false,
		progress: 0,
		duration: 0,
		volume: 70,
		shuffle: false,
		repeat: "off",
	};

	// --- lifecycle ----------------------------------------------------------

	/** Ensure the daemon is running and the WS is connected. Idempotent. */
	async ensure(): Promise<boolean> {
		if (this.connected) return true;
		if (this.starting) return this.starting;
		this.starting = this.startInternal().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async startInternal(): Promise<boolean> {
		const cfg = loadConfig();
		if (!this.proc) {
			try {
				// A stale daemon from an older extension version may still be bound to
				// this port but lack our MPV cookie wrapper. Replace it so yt-dlp can
				// authenticate and actually produce audio.
				this.killDaemonOnPort(cfg.port);
				const env = this.buildEngineEnv();
				// detached:true -> the daemon is its own process-group leader, so the
				// mpv child it spawns shares the group and we can kill both at once.
				this.proc = spawn(
					cfg.enginePath,
					["--web-only", "--web-host", "127.0.0.1", "--web-port", String(cfg.port), "--web-auth", cfg.token],
					{ stdio: "ignore", detached: true, env },
				);
				this.proc.on("exit", () => {
					this.proc = undefined;
					this.connected = false;
					this.ws = undefined;
				});
				this.proc.on("error", (e) => {
					this.lastError = `engine spawn failed: ${e.message}`;
				});
			} catch (e) {
				this.lastError = `engine spawn failed: ${e instanceof Error ? e.message : String(e)}`;
				return false;
			}
		}
		const ok = await this.connectWithRetry(cfg.port, cfg.token);
		if (!ok && !this.lastError) this.lastError = "could not connect to engine WebSocket";
		return ok;
	}

	private buildEngineEnv(): typeof process.env {
		const env: typeof process.env = { ...process.env };
		const cookieHeader = getPlaybackCookieHeader();
		if (!cookieHeader) return env;

		const dir = configDir();
		const cookieFile = join(dir, "yt-dlp-cookies.txt");
		const wrapper = join(dir, "mpv-with-youtube-cookies.sh");
		const realMpv = resolveRealMpv(wrapper);
		try {
			writeFileSync(cookieFile, cookieHeaderToNetscape(cookieHeader), { mode: 0o600 });
			chmodSync(cookieFile, 0o600);
			writeFileSync(
				wrapper,
				`#!/bin/sh\nexec ${shellQuote(realMpv)} --ytdl-raw-options=cookies=${shellQuote(cookieFile)} "$@"\n`,
				{ mode: 0o700 },
			);
			chmodSync(wrapper, 0o700);
			this.playbackCookieFile = cookieFile;
			this.mpvWrapperPath = wrapper;
			env.MPV_PATH = wrapper;
		} catch (err) {
			this.lastError = `failed to prepare yt-dlp cookies: ${err instanceof Error ? err.message : String(err)}`;
		}
		return env;
	}

	private killDaemonOnPort(port: number): void {
		if (process.platform === "win32") return;
		const res = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		const pids = (res.stdout ?? "")
			.split(/\s+/)
			.map((s) => Number.parseInt(s, 10))
			.filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
		for (const pid of pids) {
			try { process.kill(-pid, "SIGKILL"); } catch {
				try { process.kill(pid, "SIGKILL"); } catch {}
			}
			try { spawnSync("pkill", ["-f", `mpvsocket-${pid}-`]); } catch {}
		}
	}

	private connectWithRetry(port: number, token: string, attempts = 25, delayMs = 400): Promise<boolean> {
		return new Promise((resolve) => {
			let n = 0;
			const tryOnce = () => {
				n++;
				let settled = false;
				const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				const cleanup = () => {
					ws.removeAllListeners();
				};
				ws.on("open", () => {
					this.ws = ws;
					this.connected = true;
					this.lastError = undefined;
					ws.on("message", (buf: Buffer) => this.onMessage(buf));
					ws.on("close", () => {
						this.connected = false;
						this.ws = undefined;
					});
					ws.on("error", () => {});
					settled = true;
					resolve(true);
				});
				ws.on("error", () => {
					if (settled) return;
					cleanup();
					try { ws.terminate(); } catch {}
					if (n >= attempts) return resolve(false);
					setTimeout(tryOnce, delayMs);
				});
			};
			tryOnce();
		});
	}

	shutdown(): void {
		this.stopTicker();
		try { this.send({ category: "STOP" }); } catch {}
		try { this.ws?.close(); } catch {}
		this.ws = undefined;
		this.connected = false;
		this.queue = [];
		this.index = 0;
		this.state.track = undefined;
		this.state.isPlaying = false;
		this.state.progress = 0;
		this.state.duration = 0;
		this.emit();
		const pid = this.proc?.pid;
		this.proc = undefined;
		if (!pid) return;
		// The daemon spawns mpv with detached:true (its own process group), so it
		// won't die with the daemon. Kill mpv directly via its IPC socket name,
		// which embeds the daemon's pid: /tmp/mpvsocket-<daemonPid>-<session>.
		if (process.platform !== "win32") {
			try { spawnSync("pkill", ["-f", `mpvsocket-${pid}-`]); } catch {}
		}
		try { process.kill(-pid, "SIGKILL"); } catch {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
	}

	getError(): string | undefined {
		return this.lastError;
	}

	getDiagnostics(): string {
		const pid = this.proc?.pid ? String(this.proc.pid) : "(none)";
		const track = this.state.track?.title ? `${this.state.track.title} — ${this.state.track.artists ?? ""}`.trim() : "(none)";
		return [
			`pid=${pid}`,
			`connected=${this.connected}`,
			`playing=${this.state.isPlaying}`,
			`track=${track}`,
			`progress=${Math.round(this.state.progress)}/${Math.round(this.state.duration || this.state.track?.duration || 0)}`,
			`mpv=${this.mpvWrapperPath ?? process.env.MPV_PATH ?? "mpv"}`,
			`cookies=${this.playbackCookieFile ?? "(not prepared)"}`,
			`log=~/.youtube-music-cli/debug.log`,
			`error=${this.lastError ?? "(none)"}`,
		].join("\n");
	}

	// --- subscription -------------------------------------------------------

	onState(cb: Listener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	getState(): PlayerState {
		return this.state;
	}

	private emit(): void {
		for (const cb of this.listeners) {
			try { cb(); } catch {}
		}
	}

	// --- commands -----------------------------------------------------------

	private send(action: Record<string, unknown>): void {
		if (this.ws && this.connected) {
			try { this.ws.send(JSON.stringify({ type: "command", action })); } catch {}
		}
	}

	/** Replace the queue and start playing at `index`. Spawns the daemon if needed. */
	async play(tracks: Track[], index: number, _playlistTitle = ""): Promise<boolean> {
		this.queue = tracks.slice();
		this.index = Math.max(0, Math.min(index, tracks.length - 1));
		const ok = await this.ensure();
		if (!ok) return false;
		this.send({ category: "SET_QUEUE", queue: this.queue.map(toEngineTrack) });
		this.playCurrent();
		return true;
	}

	private playCurrent(): void {
		const t = this.queue[this.index];
		if (!t) return;
		this.send({ category: "SET_QUEUE_POSITION", position: this.index });
		this.send({ category: "PLAY", track: toEngineTrack(t) });
		this.state.track = { videoId: t.videoId, title: t.title, artists: t.artists, duration: t.duration };
		this.state.duration = t.duration || 0;
		this.state.progress = 0;
		this.state.isPlaying = true;
		this.startTicker();
		this.emit();
	}

	togglePlay(): void {
		if (!this.state.track) return;
		this.state.isPlaying = !this.state.isPlaying;
		this.send({ category: this.state.isPlaying ? "RESUME" : "PAUSE" });
		this.emit();
	}

	next(): void {
		if (this.queue.length === 0) return;
		if (this.state.repeat === "one") return this.playCurrent();
		let i = this.index + 1;
		if (i >= this.queue.length) {
			if (this.state.repeat === "all") i = 0;
			else { this.stopAtEnd(); return; }
		}
		this.index = i;
		this.playCurrent();
	}

	prev(): void {
		if (this.queue.length === 0) return;
		if (this.state.progress > 3) return this.playCurrent(); // restart current
		this.index = this.index <= 0 ? 0 : this.index - 1;
		this.playCurrent();
	}

	setVolume(vol: number): void {
		this.state.volume = Math.max(0, Math.min(100, Math.round(vol)));
		this.send({ category: "SET_VOLUME", volume: this.state.volume });
		this.emit();
	}

	private stopAtEnd(): void {
		this.state.isPlaying = false;
		this.send({ category: "STOP" });
		this.stopTicker();
		this.emit();
	}

	// --- progress ticking (daemon doesn't advance it) -----------------------

	private startTicker(): void {
		this.stopTicker();
		this.ticker = setInterval(() => {
			if (!this.state.isPlaying) return;
			this.state.progress += 1;
			const dur = this.state.duration;
			if (dur > 0 && this.state.progress >= dur) {
				this.next(); // auto-advance at track end
				return;
			}
			this.emit();
		}, 1000);
		this.ticker.unref?.();
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	// --- incoming -----------------------------------------------------------

	private onMessage(buf: Buffer): void {
		let msg: any;
		try { msg = JSON.parse(buf.toString()); } catch { return; }
		if (msg?.type === "state-update" && msg.state) {
			// Reconcile only fields the user might change daemon-side.
			const s = msg.state;
			if (typeof s.volume === "number") this.state.volume = s.volume;
			this.emit();
		}
	}
}

function cookieHeaderToNetscape(cookieHeader: string): string {
	const lines = ["# Netscape HTTP Cookie File", "# Generated by pi youtube-music extension for local yt-dlp playback."];
	for (const part of cookieHeader.split(/;\s*/)) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (!name) continue;
		lines.push([".youtube.com", "TRUE", "/", "TRUE", "2147483647", name, value].join("\t"));
	}
	return `${lines.join("\n")}\n`;
}

function resolveRealMpv(wrapperPath: string): string {
	const configured = process.env.MPV_PATH?.trim();
	if (configured && configured !== wrapperPath) return configured;
	const res = spawnSync("sh", ["-lc", "command -v mpv"], { encoding: "utf8" });
	return res.stdout.trim() || "mpv";
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const ENGINE_KEY = "__piYoutubeMusicEngine__";
const globals = globalThis as typeof globalThis & { [ENGINE_KEY]?: (Engine & { version?: number }) };

// Keep playback/queue/progress alive when pi replaces sessions or hot-reloads
// extensions. If the engine implementation changes, replace the old global so
// stale daemons are restarted with the current mpv/yt-dlp cookie wrapper.
if (!globals[ENGINE_KEY] || globals[ENGINE_KEY]?.version !== ENGINE_VERSION) {
	try { globals[ENGINE_KEY]?.shutdown(); } catch {}
	globals[ENGINE_KEY] = new Engine();
}
export const engine = globals[ENGINE_KEY] as Engine;
