import { createHash } from "node:crypto";
import { TRANSLATION_CACHE_MAX_ENTRIES } from "./config.ts";
import type { TranslatableSegment, TranslationDirection, TranslationSegment } from "../types.ts";

const GLOBAL_STATE_KEY = "__englishLearningTranslationCacheV3";
const CACHE_VERSION = "translation-v3";

interface CachedSegmentTranslation {
	source: string;
	translation: string;
}

export interface TranslationCacheEntry {
	key: string;
	createdAt: number;
	lastAccessedAt: number;
	modelLabel: string;
	direction: TranslationDirection;
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

function cacheKey(text: string, direction: TranslationDirection): string {
	return createHash("sha256")
		.update(CACHE_VERSION)
		.update("\0")
		.update(direction)
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

function matchesSegments(
	entry: TranslationCacheEntry,
	direction: TranslationDirection,
	segments: TranslationSegment[],
): boolean {
	if (entry.direction !== direction) return false;
	const translatable = translatableSegments(segments);
	if (translatable.length !== entry.segments.length) return false;
	return translatable.every((segment, index) => segment.source === entry.segments[index]?.source);
}

export function getCachedTranslations(
	text: string,
	direction: TranslationDirection,
	segments: TranslationSegment[],
): TranslationCacheEntry | undefined {
	const entries = state().entries;
	const key = cacheKey(text, direction);
	const entry = entries.get(key);
	if (!entry) return undefined;
	if (!matchesSegments(entry, direction, segments)) {
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
	direction: TranslationDirection,
	segments: TranslationSegment[],
	modelLabel: string,
): TranslationCacheEntry | undefined {
	const translatable = translatableSegments(segments);
	if (translatable.length === 0) return undefined;
	if (translatable.some((segment) => segment.status !== "done" || !segment.translation.trim())) {
		return undefined;
	}

	const now = Date.now();
	const key = cacheKey(text, direction);
	const entry: TranslationCacheEntry = {
		key,
		createdAt: now,
		lastAccessedAt: now,
		modelLabel,
		direction,
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
