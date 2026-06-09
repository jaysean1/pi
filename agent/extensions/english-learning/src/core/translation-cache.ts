import { createHash } from "node:crypto";
import { TRANSLATION_CACHE_MAX_ENTRIES } from "./config.ts";
import type { TranslatableSegment, TranslationSegment } from "../types.ts";

const GLOBAL_STATE_KEY = "__englishLearningTranslationCache";
const CACHE_VERSION = "translation-v2";

interface CachedSegmentTranslation {
	source: string;
	translation: string;
}

export interface TranslationCacheEntry {
	key: string;
	createdAt: number;
	lastAccessedAt: number;
	modelLabel: string;
	segments: CachedSegmentTranslation[];
}

interface TranslationCacheState {
	entries: Map<string, TranslationCacheEntry>;
}

function state(): TranslationCacheState {
	const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: TranslationCacheState };
	return (root[GLOBAL_STATE_KEY] ??= { entries: new Map() });
}

function translatableSegments(segments: TranslationSegment[]): TranslatableSegment[] {
	return segments.filter((segment): segment is TranslatableSegment => segment.translatable);
}

function cacheKey(text: string): string {
	return createHash("sha256")
		.update(CACHE_VERSION)
		.update("\0")
		.update(text)
		.digest("hex");
}

function touch(entry: TranslationCacheEntry): void {
	const entries = state().entries;
	entry.lastAccessedAt = Date.now();
	entries.delete(entry.key);
	entries.set(entry.key, entry);
}

function trimCache(): void {
	const entries = state().entries;
	while (entries.size > TRANSLATION_CACHE_MAX_ENTRIES) {
		const oldestKey = entries.keys().next().value as string | undefined;
		if (!oldestKey) break;
		entries.delete(oldestKey);
	}
}

function matchesSegments(entry: TranslationCacheEntry, segments: TranslationSegment[]): boolean {
	const translatable = translatableSegments(segments);
	if (translatable.length !== entry.segments.length) return false;
	return translatable.every((segment, index) => segment.source === entry.segments[index]?.source);
}

export function getCachedTranslations(
	text: string,
	segments: TranslationSegment[],
): TranslationCacheEntry | undefined {
	const entries = state().entries;
	const key = cacheKey(text);
	const entry = entries.get(key);
	if (!entry) return undefined;
	if (!matchesSegments(entry, segments)) {
		entries.delete(key);
		return undefined;
	}
	touch(entry);
	return entry;
}

export function applyCachedTranslations(
	entry: TranslationCacheEntry,
	segments: TranslationSegment[],
): number {
	let applied = 0;
	const translatable = translatableSegments(segments);
	for (let i = 0; i < translatable.length; i++) {
		const segment = translatable[i]!;
		const cached = entry.segments[i];
		if (!cached || cached.source !== segment.source) continue;
		segment.translation = cached.translation;
		segment.status = "done";
		segment.error = undefined;
		applied++;
	}
	return applied;
}

export function storeCachedTranslations(
	text: string,
	segments: TranslationSegment[],
	modelLabel: string,
): TranslationCacheEntry | undefined {
	const translatable = translatableSegments(segments);
	if (translatable.length === 0) return undefined;
	if (translatable.some((segment) => segment.status !== "done" || !segment.translation.trim())) {
		return undefined;
	}

	const now = Date.now();
	const key = cacheKey(text);
	const entry: TranslationCacheEntry = {
		key,
		createdAt: now,
		lastAccessedAt: now,
		modelLabel,
		segments: translatable.map((segment) => ({
			source: segment.source,
			translation: segment.translation.trimEnd(),
		})),
	};

	const entries = state().entries;
	entries.delete(key);
	entries.set(key, entry);
	trimCache();
	return entry;
}

export function clearTranslationCache(): void {
	state().entries.clear();
}

export function getTranslationCacheStats(): { size: number; maxSize: number } {
	return {
		size: state().entries.size,
		maxSize: TRANSLATION_CACHE_MAX_ENTRIES,
	};
}
