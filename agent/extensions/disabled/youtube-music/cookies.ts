// YouTube cookie extraction from local Chromium-based browsers.
//
// Vendored & retargeted from pi-web-access/chrome-cookies.ts (same proven AES
// decryption + node:sqlite reader) but pointed at youtube.com / google.com auth
// cookies so youtubei.js can authenticate as the logged-in user.
//
// No network access; reads the browser's local "Cookies" SQLite DB and the OS
// keychain/secret-store for the decryption key, exactly like the upstream tool.

import { execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

// IMPORTANT: query ONLY youtube.com-domain cookies. Mixing in google.com
// cookies (different __Secure-3PSID/3PAPISID values) breaks YT Music auth and
// makes the API return a "Sign in" prompt even though session.logged_in is true.
const YT_ORIGINS = ["https://music.youtube.com", "https://www.youtube.com"];

// The cookie that marks an *active YouTube* login (separate from a Google login).
const YT_LOGIN_MARKER = "LOGIN_INFO";

// Cookies needed for youtubei.js SAPISIDHASH auth + YT Music session.
const ALL_COOKIE_NAMES = new Set([
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"__Secure-1PSIDCC",
	"__Secure-1PAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
	"__Secure-3PSIDCC",
	"__Secure-3PAPISID",
	"LOGIN_INFO",
	"PREF",
	"VISITOR_INFO1_LIVE",
	"VISITOR_PRIVACY_METADATA",
	"YSC",
	"SIDCC",
	"CONSENT",
	"SOCS",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Helium", baseDir: "Library/Application Support/net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium" },
	{ name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
	{ name: "Brave", baseDir: "Library/Application Support/BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
	{ name: "Edge", baseDir: "Library/Application Support/Microsoft Edge", keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge" },
	{ name: "Arc", baseDir: "Library/Application Support/Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
	{ name: "Brave", baseDir: ".config/BraveSoftware/Brave-Browser", secretToolApp: "brave" },
];

/** Read & decrypt YT cookies from one (browser, profile). null if unreadable. */
async function readProfileCookies(
	config: BrowserConfig,
	profile: string,
	currentPlatform: ReturnType<typeof platform>,
	hosts: string[],
	warnings: string[],
): Promise<CookieMap | null> {
	const cookiesPath = join(homedir(), config.baseDir, profile, "Cookies");
	if (!existsSync(cookiesPath)) return null;

	const password = await readBrowserPassword(config, currentPlatform);
	if (!password) {
		warnings.push(`Could not read ${config.name} cookie encryption password`);
		return null;
	}
	const key = pbkdf2Sync(password, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1");
	const tempDir = mkdtempSync(join(tmpdir(), "pi-ytm-cookies-"));
	try {
		const tempDb = join(tempDir, "Cookies");
		copyFileSync(cookiesPath, tempDb);
		copySidecar(cookiesPath, tempDb, "-wal");
		copySidecar(cookiesPath, tempDb, "-shm");
		const metaVersion = await readMetaVersion(tempDb);
		const stripHash = metaVersion >= 24;
		const rows = await queryCookieRows(tempDb, hosts);
		if (!rows) {
			warnings.push(`Failed to query ${config.name} cookie database`);
			return null;
		}
		const cookies: CookieMap = {};
		for (const row of rows) {
			const name = row.name as string;
			if (!ALL_COOKIE_NAMES.has(name)) continue;
			if (cookies[name]) continue;
			let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
			if (!value) {
				const encrypted = row.encrypted_value;
				if (encrypted instanceof Uint8Array) value = decryptCookieValue(encrypted, key, stripHash);
			}
			if (value) cookies[name] = value;
		}
		return Object.keys(cookies).length ? cookies : null;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/** List candidate profile dir names for a browser root (Default, Profile 1, ...). */
function discoverProfiles(root: string): string[] {
	if (!existsSync(root)) return [];
	try {
		const dirs = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name)))
			.map((d) => d.name);
		// Default first, then Profile 1, 2, ...
		return dirs.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b)));
	} catch {
		return [];
	}
}

export interface ProfileCookies {
	cookies: CookieMap;
	browser: string; // e.g. "Chrome"
	profile: string; // e.g. "Profile 1"
	label: string; // "Chrome/Profile 1"
	hasLogin: boolean; // has an active YouTube login (LOGIN_INFO)
}

/**
 * Enumerate all browser profiles that carry a Google/YouTube session, with their
 * decrypted cookies. Profiles with an active YouTube login (LOGIN_INFO) come
 * first. When `profile` is given (not "auto") only that profile is considered.
 */
export async function listYouTubeProfiles(options?: { profile?: string }): Promise<ProfileCookies[]> {
	const currentPlatform = platform();
	const configs =
		currentPlatform === "darwin"
			? MACOS_BROWSER_CONFIGS
			: currentPlatform === "linux"
				? LINUX_BROWSER_CONFIGS
				: [];
	if (configs.length === 0) return [];

	const hosts = YT_ORIGINS.map((origin) => new URL(origin).hostname);
	const explicit = options?.profile && options.profile !== "auto" ? options.profile : undefined;
	const warnings: string[] = [];
	const out: ProfileCookies[] = [];

	for (const config of configs) {
		const root = join(homedir(), config.baseDir);
		const profiles = explicit ? [explicit] : discoverProfiles(root);
		for (const profile of profiles) {
			const cookies = await readProfileCookies(config, profile, currentPlatform, hosts, warnings);
			if (!cookies || !cookies["SAPISID"]) continue;
			out.push({
				cookies,
				browser: config.name,
				profile,
				label: `${config.name}/${profile}`,
				hasLogin: Boolean(cookies[YT_LOGIN_MARKER]),
			});
		}
	}
	// Logged-in profiles first.
	out.sort((a, b) => Number(b.hasLogin) - Number(a.hasLogin));
	return out;
}

/**
 * Extract YouTube auth cookies. When `profile` is omitted or "auto", scans all
 * browser profiles and picks the one with an *active YouTube login* (LOGIN_INFO).
 * Returns null if no signed-in YouTube profile is found.
 */
export async function getYouTubeCookies(
	options?: { profile?: string; requiredCookies?: string[] },
): Promise<{ cookies: CookieMap; warnings: string[]; browser: string } | null> {
	const required = options?.requiredCookies ?? [];
	const profiles = await listYouTubeProfiles({ profile: options?.profile });
	const match = profiles.find((p) => required.every((n) => Boolean(p.cookies[n])));
	if (!match) return null;
	return { cookies: match.cookies, warnings: [], browser: match.label };
}

/** Serialize a cookie map into a Cookie header string for youtubei.js. */
export function cookieMapToHeader(cookies: CookieMap): string {
	return Object.entries(cookies)
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, stripHash: boolean): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3) return null;
	const prefix = buf.subarray(0, 3).toString("utf8");
	if (!/^v\d\d$/.test(prefix)) return null;
	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";
	try {
		const iv = Buffer.alloc(16, 0x20);
		const decipher = createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(false);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const unpadded = removePkcs7Padding(plaintext);
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	if (!padding || padding > 16) return buf;
	return buf.subarray(0, buf.length - padding);
}

function readBrowserPassword(config: BrowserConfig, currentPlatform: ReturnType<typeof platform>): Promise<string | null> {
	if (currentPlatform === "darwin") {
		if (!config.keychainAccount || !config.keychainService) return Promise.resolve(null);
		return readKeychainPassword(config.keychainAccount, config.keychainService);
	}
	if (currentPlatform === "linux") return readLinuxPassword(config.secretToolApp);
	return Promise.resolve(null);
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("security", ["find-generic-password", "-w", "-a", account, "-s", service], { timeout: 5000 }, (err, stdout) => {
			if (err) { resolve(null); return; }
			resolve(stdout.trim() || null);
		});
	});
}

function readLinuxPassword(secretToolApp: string | undefined): Promise<string> {
	if (!secretToolApp) return Promise.resolve("peanuts");
	return new Promise((resolve) => {
		execFile("secret-tool", ["lookup", "application", secretToolApp], { timeout: 5000 }, (err, stdout) => {
			if (err) { resolve("peanuts"); return; }
			resolve(stdout.trim() || "peanuts");
		});
	});
}

let sqliteModule: typeof import("node:sqlite") | null = null;
async function importSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (sqliteModule) return sqliteModule;
	const orig = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		const msg = typeof warning === "string" ? warning : warning?.message ?? "";
		if (msg.includes("SQLite is an experimental feature")) return;
		return (orig as Function)(warning, ...args);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = await import("node:sqlite");
		return sqliteModule;
	} catch {
		return null;
	} finally {
		process.emitWarning = orig;
	}
}

function supportsReadBigInts(): boolean {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > 24) return true;
	if (major < 24) return false;
	return minor >= 4;
}

async function readMetaVersion(dbPath: string): Promise<number> {
	const sqlite = await importSqlite();
	if (!sqlite) return 0;
	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		const rows = db.prepare("SELECT value FROM meta WHERE key = 'version'").all() as Array<Record<string, unknown>>;
		const val = rows[0]?.value;
		if (typeof val === "number") return Math.floor(val);
		if (typeof val === "bigint") return Number(val);
		if (typeof val === "string") return parseInt(val, 10) || 0;
		return 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

async function queryCookieRows(dbPath: string, hosts: string[]): Promise<Array<Record<string, unknown>> | null> {
	const sqlite = await importSqlite();
	if (!sqlite) return null;
	const clauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const esc = candidate.replaceAll("'", "''");
			clauses.push(`host_key = '${esc}'`);
			clauses.push(`host_key = '.${esc}'`);
			clauses.push(`host_key LIKE '%.${esc}'`);
		}
	}
	const where = clauses.join(" OR ");
	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		return db
			.prepare(`SELECT name, value, host_key, encrypted_value FROM cookies WHERE (${where}) ORDER BY expires_utc DESC`)
			.all() as Array<Record<string, unknown>>;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

function expandHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [host];
	const candidates = new Set<string>();
	candidates.add(host);
	for (let i = 1; i <= parts.length - 2; i++) {
		const c = parts.slice(i).join(".");
		if (c) candidates.add(c);
	}
	return Array.from(candidates);
}

function copySidecar(srcDb: string, targetDb: string, suffix: string): void {
	const sidecar = `${srcDb}${suffix}`;
	if (!existsSync(sidecar)) return;
	try {
		copyFileSync(sidecar, `${targetDb}${suffix}`);
	} catch {
		// best effort
	}
}
