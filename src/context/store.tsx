// Context store for the story generator dashboard.
//
// This mirrors the lightning-agent pattern (library/workflow/lightning-agent/context/store.ts)
// but for the storyboard API:
//   - records: list of story sessions (each with a storyId, storyline input, and
//     progressively-fetched story data)
//   - selected: the currently active story entry (same reference as one in records)
//   - config: API base URL + poll interval (overridable for tests)
//
// PERSISTENCE (two-tier, PER STORY):
//   - localStorage (synchronous) — the instant first paint. One key per story
//     ('storyGenerator:story:<storyId>'). Written on every records change,
//     but each story's write only touches ITS OWN key and change-detects
//     against the stored value, so a background job's poll ticks never
//     rewrite other stories. Quota-limited (~5MB): a story that no longer
//     fits sheds ITS OWN weight (revisions → metadata-only), never another
//     story's data.
//   - IndexedDB (durable mirror, ./storyCache.ts) — the mobile-survival copy,
//     keyed 'story:<storyId>' the same way. iOS Safari private mode wipes
//     localStorage on tab close and ITP evicts it under pressure; IndexedDB
//     has orders-of-magnitude larger quotas and a granted
//     navigator.storage.persist() request (asked at boot, see storyCache.ts)
//     opts the origin out of ITP's 7-day capricious eviction. Every records
//     write is mirrored per story (fire-and-forget, unchanged stories
//     skipped), the write's OUTCOME is surfaced (didLastMirrorWriteFail) so a
//     both-tiers-dead device stops showing the hedged copy, and
//     BootstrapLayer rehydrates the durable copy at boot.
//
// Unlike localContextStore, this distribution package cannot import @presource/react
// (it is not in package.json deps — see distribution/story-generator/package.json).
// We use plain React context + useState instead, exposing a custom hook
// `useStoryStore` that mirrors the lightning-agent `lightningAgentStore()` accessor
// pattern (read + mutate triggers re-render).

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { LOCAL_AREA_NETWORK_STORYBOARD_PORT, resolveStoryboardApiHostName } from '../config';
import { deleteStory as deleteStoryApi, type ActiveJob, type StoryMeta } from '../api';
import { storyCacheGet, storyCacheSet, storyCacheFingerprint } from './storyCache';

// ── localStorage helpers ──────────────────────────────────────────────
const STORAGE_KEY_STORY = 'storyGenerator:lastStoryId';
const STORAGE_KEY_EXPANDED_PREFIX = 'storyGenerator:expanded:';
// LEGACY single-blob records key (the ENTIRE records array as one value).
// Kept only for the migration read in loadRecordsFromStorage — the layout is
// now PER STORY (see STORAGE_KEY_STORY_PREFIX below) and the blob is removed
// on first load.
const STORAGE_KEY_RECORDS = 'storyGenerator:records';
// PER-STORY records keys: 'storyGenerator:story:<storyId>' → one story's
// PersistableStoryEntry. WHY PER STORY: a story's background job (plotline
// generation / chapter expansion) streams poll updates into the store every
// ~2s, and each of those re-persists. With the old single blob EVERY story's
// cache entry was rewritten on every tick — and once the blob outgrew the
// ~5MB quota, the weight-shedding ladder NULLLED OTHER STORIES' cached
// chapter data to fit (the reported bug: one story generating = every other
// story's cache cleared). With one key per storyId, a story's progress only
// ever rewrites its own key, and quota shedding (see saveSingleStoryToStorage)
// can only ever shed the story that caused it.
const STORAGE_KEY_STORY_PREFIX = 'storyGenerator:story:';
// The last-selected LLM client id. NOTE: this is a client-side convenience
// only (remembers the user's dropdown choice between browser sessions). The
// server never persists clientId with a story — it travels with every
// generation payload (POST create/fork, PATCH expand/rewrite), which is why
// the store keeps it in `config` rather than per-story records.
const STORAGE_KEY_CLIENT_ID = 'storyGenerator:clientId';

// localStorage key for ONE story's persistable record.
const storyStorageKey = (storyId: string): string => STORAGE_KEY_STORY_PREFIX + storyId;

/** Read the last-selected storyId from localStorage. Returns null if absent. */
export const getLastStoryId = (): string | null => {
    try {
        return localStorage.getItem(STORAGE_KEY_STORY);
    } catch {
        return null;
    }
};

/** Persist the last-selected storyId to localStorage. */
export const setLastStoryId = (storyId: string | null) => {
    try {
        if (storyId) {
            localStorage.setItem(STORAGE_KEY_STORY, storyId);
        } else {
            localStorage.removeItem(STORAGE_KEY_STORY);
        }
    } catch {
        // localStorage unavailable (SSR / private browsing) — silently ignore.
    }
};

/** Read the last-selected LLM client id from localStorage. Null if absent. */
export const getClientId = (): string | null => {
    try {
        return localStorage.getItem(STORAGE_KEY_CLIENT_ID);
    } catch {
        return null;
    }
};

/** Persist the selected LLM client id to localStorage. */
export const setClientId = (clientId: string | null) => {
    try {
        if (clientId) {
            localStorage.setItem(STORAGE_KEY_CLIENT_ID, clientId);
        } else {
            localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
        }
    } catch {
        // ignore
    }
};

/** Read the expanded chapter indices for a story. Returns [] if absent. */
export const getExpandedChapters = (storyId: string): number[] => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_EXPANDED_PREFIX + storyId);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
};

/** Persist the expanded chapter indices for a story. */
export const setExpandedChapters = (storyId: string, indices: number[]) => {
    try {
        localStorage.setItem(STORAGE_KEY_EXPANDED_PREFIX + storyId, JSON.stringify(indices));
    } catch {
        // ignore
    }
};

/** Remove the expanded-chapters key for a story (called when the story is deleted). */
export const clearExpandedChapters = (storyId: string) => {
    try {
        localStorage.removeItem(STORAGE_KEY_EXPANDED_PREFIX + storyId);
    } catch {
        // ignore
    }
};

/**
 * Remove ONE story's cached record key (called when the story is deleted).
 * The next full save would also purge it (orphan-key cleanup), but deleting
 * the key here means the story is gone from the cache the moment the delete
 * action runs — even if the tab closes before the next persist effect fires.
 */
export const deleteStoryRecordFromStorage = (storyId: string) => {
    try {
        localStorage.removeItem(storyStorageKey(storyId));
        // The key is gone — drop the fingerprint/rung state with it so a
        // later save for a re-created storyId cannot skip against stale
        // persistence state.
        forgetPersistedStory(storyId);
    } catch {
        // ignore
    }
};

// ── Records persistence (synchronous, quota-resilient, PER STORY) ──────
// Persists the story records to localStorage — one key per story
// ('storyGenerator:story:<storyId>') — so the dashboard loads instantly with
// cached data even if the server is unreachable.
//
// SYNCHRONOUS BY CONTRACT: the offline-viewing requirement is "any story
// loaded from the server (viewed) is immediately cached for viewing without
// the server running". The previous idle-deferred write (requestIdleCallback)
// could be dropped when the tab closed / the page reloaded shortly after
// viewing — the fetched data never reached localStorage and the offline
// dashboard came up with an EMPTY story list. The write now happens
// synchronously inside the provider's records-changed effect, so the cache
// is durable the moment fetched data lands in the store.
//
// PER-STORY ISOLATION (the reason for the one-key-per-story layout): a story
// with a background job (plotline generation, chapter expansion) streams poll
// updates into the store every ~2s, and each update re-persists. With the
// old single-blob cache ('storyGenerator:records'), EVERY story's entry was
// rewritten on every tick — and once the blob exceeded the ~5MB quota, the
// weight-shedding ladder DROPPED OTHER STORIES' cached chapter data to fit
// (one story generating ⇒ every other story's offline cache wiped). Per
// story, the quota ladder (saveStoryAtRung) can only shed the story that
// caused the write: full content → latest revision per chapter → metadata
// only — that story's LIST entry always survives offline. MAKE-ROOM (pass 2
// in saveRecordsToStorage) is the single exception: when a story fails ALL
// of its own rungs because the ORIGIN-WIDE quota is exhausted by the other
// stories, the OLDEST cached stories are degraded one rung at a time (each
// step recoverable from the IndexedDB mirror at the next boot) until it
// fits — so "cache write failed" only ever means storage is genuinely
// unavailable or truly full.

// Minimal subset of StoryEntry we actually persist. Omits transient fields
// that don't survive across sessions (error, isProcessing, serverProcessing).
type PersistableStoryEntry = Pick<StoryEntry, 'id' | 'storyId' | 'storyName' | 'title' | 'storyline' | 'chapterRequested' | 'chapterCompleted' | 'createdDate' | 'lastActionedAt' | 'lastUpdatedAt' | 'dataStale' | 'status' | 'isRemote' | 'missingFromServer'> & {
    data: StoryData | null;
};

/** Strip transient fields from a StoryEntry for persistence. */
const toPersistable = (entry: StoryEntry): PersistableStoryEntry => ({
    id: entry.id,
    storyId: entry.storyId,
    storyName: entry.storyName,
    title: entry.title,
    storyline: entry.storyline,
    chapterRequested: entry.chapterRequested,
    chapterCompleted: entry.chapterCompleted,
    createdDate: entry.createdDate,
    lastActionedAt: entry.lastActionedAt,
    // Persisted so staleness survives reloads: a cached payload flagged
    // dataStale must still refresh after the browser restarts.
    lastUpdatedAt: entry.lastUpdatedAt,
    dataStale: entry.dataStale,
    status: entry.status,
    data: entry.data,
    isRemote: entry.isRemote,
    missingFromServer: entry.missingFromServer
});

/**
 * Rehydrate one persisted (PersistableStoryEntry) record into a full
 * StoryEntry — shared by the per-story localStorage read, the legacy-blob
 * migration, and the IndexedDB mirror recovery so all three apply identical
 * defaults to legacy/transient fields.
 */
const rehydratePersistable = (entry: PersistableStoryEntry): StoryEntry => ({
    ...entry,
    createdDate: entry.createdDate || new Date(0).toISOString(),
    chapterRequested: entry.chapterRequested || 0,
    chapterCompleted: entry.chapterCompleted || 0,
    status: entry.status || 'generating',
    // Cache-only flag persists across reloads so the story still renders
    // (and deletes locally) before the next successful list sync.
    missingFromServer: entry.missingFromServer ?? false,
    // Staleness flag persists across reloads: a cached payload older
    // than the server's last write must still trigger a refresh after
    // the browser restarts. Legacy cached entries lack the field →
    // not stale until the next list sync computes the delta.
    dataStale: entry.dataStale ?? false,
    // Transient live-job flag starts false on rehydrate — the server's
    // in-memory job registry is the only source of truth and is
    // re-synced by the next list fetch (BootstrapLayer / sidebar
    // auto-refresh).
    serverProcessing: false,
    isProcessing: false,
    error: ''
});

/** True when `candidate` carries chapter data that `current` does not. */
const hasRicherStoryData = (candidate: StoryData | null, current: StoryData | null): boolean => {
    if (!candidate) return false;
    if (!current) return true;

    const currentChapters = current.chapters ?? [];
    return (candidate.chapters ?? []).some((chapter, index) => {
        const currentChapter = currentChapters[index];
        if (!currentChapter) return true;
        return (chapter.revisions?.length ?? 0) > (currentChapter.revisions?.length ?? 0);
    });
};

/**
 * Merge two cache-layout copies of one story. The per-story layout owns the
 * metadata, but a richer legacy chapter payload must never be replaced by a
 * metadata-only or revision-trimmed copy.
 */
const mergePersistableCopies = (
    current: PersistableStoryEntry,
    legacy: PersistableStoryEntry
): PersistableStoryEntry =>
    hasRicherStoryData(legacy.data, current.data) ? { ...current, data: legacy.data } : current;

/** Read every per-story record key ('storyGenerator:story:*'). */
const readPerStoryPersistables = (): PersistableStoryEntry[] => {
    const entries: PersistableStoryEntry[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(STORAGE_KEY_STORY_PREFIX)) continue;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            // A corrupted/non-object key is skipped, not fatal — one bad
            // story must not take down the whole cached dashboard.
            if (parsed && typeof parsed === 'object' && parsed.storyId) {
                entries.push(parsed as PersistableStoryEntry);
            }
        } catch {
            // Corrupted JSON in this one story's key — skip it.
        }
    }
    return entries;
};

/**
 * Synchronous read of cached records from localStorage.
 * Used on initial mount to hydrate the store instantly before the server
 * round-trip completes. Returns [] on any error (SSR, corrupted data, etc.).
 *
 * PER-STORY LAYOUT: each story lives under its own key
 * ('storyGenerator:story:<storyId>'), so stories are hydrated independently.
 * LEGACY MIGRATION: the old single-blob layout is always merged with the
 * per-story layout. This matters after an interrupted migration: existing
 * per-story keys must not hide legacy-only stories. The migration removes the
 * blob before writing replacements so an origin near quota never needs to
 * hold two complete copies at once. If any story cannot be converted at full
 * fidelity, its legacy entry is retained for a later retry.
 */
export const loadRecordsFromStorage = (): StoryEntry[] => {
    try {
        const perStory = readPerStoryPersistables();
        const raw = localStorage.getItem(STORAGE_KEY_RECORDS);
        if (!raw) return perStory.map(rehydratePersistable);

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // A corrupt legacy blob must not hide valid per-story records.
            return perStory.map(rehydratePersistable);
        }
        if (!Array.isArray(parsed)) return perStory.map(rehydratePersistable);

        // Do not delete a blob containing an unrecognised record. Valid
        // records can still hydrate this session, while the original value is
        // kept intact for a future version/manual recovery.
        const validLegacy = parsed.filter(
            (entry): entry is PersistableStoryEntry =>
                !!entry && typeof entry === 'object' && typeof (entry as PersistableStoryEntry).storyId === 'string'
        );
        const canMigrate = validLegacy.length === parsed.length;
        const legacy = validLegacy.map((entry) => toPersistable(rehydratePersistable(entry)));

        const merged = [...perStory];
        const indexByStoryId = new Map(merged.map((entry, index) => [entry.storyId, index]));
        legacy.forEach((legacyEntry) => {
            const index = indexByStoryId.get(legacyEntry.storyId);
            if (index === undefined) {
                indexByStoryId.set(legacyEntry.storyId, merged.length);
                merged.push(legacyEntry);
                return;
            }
            merged[index] = mergePersistableCopies(merged[index], legacyEntry);
        });

        if (canMigrate) {
            migrateLegacyRecords(merged, legacy, raw);
        }
        return merged.map(rehydratePersistable);
    } catch {
        return [];
    }
};

/**
 * Merge a fresh server story list into the current store records.
 *
 * This is the single cache↔server sync path used by BOTH the initial
 * bootstrap (BootstrapLayer) and the periodic sidebar refresh
 * (SectionStoryTabs), so the cache-first contract stays consistent:
 *
 *   load cache → check server → update cache (via the records-persist
 *   effect downstream) → repeat at interval.
 *
 * Rules:
 *   - Stories present on the server keep any locally-cached payload
 *     (chapter `data`, `storyline`, transient flags) while their metadata
 *     (storyName, chapterRequested/Completed, createdDate, status) is
 *     refreshed from the server — the server is the source of truth for
 *     metadata, the cache is the source of truth for content.
 *   - The user-action timestamp (lastActionedAt) is CLIENT-OWNED: the server
 *     never reports it and the merge never overwrites it. The overlay spread
 *     (`...existing`) carries it through untouched so the sidebar's "last
 *     actioned on top" ordering survives every list sync.
 *   - Staleness delta: each server entry carries lastUpdatedDate (plotpoint.json
 *     mtime). When it differs from the entry's stored lastUpdatedAt (the
 *     timestamp of the cached `data`'s fetch), the entry is flagged
 *     `dataStale: true` — the cached payload predates a server write and the
 *     next view re-fetches instead of showing stale content. Unknown values
 *     (legacy server / legacy cache) never flag stale.
 *   - Stories present ONLY in the cache (absent from a successful server
 *     response) are RETAINED and flagged `missingFromServer: true` — they
 *     must stay visible in the sidebar and deletable without a server call.
 *   - An empty server response is treated as "no information" and returns
 *     null so callers leave the cached records untouched (we cannot tell a
 *     wiped server from an unreachable/misbehaving one).
 *   - The current selection is re-resolved against the merged records by
 *     storyId (entries may have been replaced); when nothing is selected
 *     the last-used storyId (localStorage) wins, then the first record.
 */
export const mergeServerStoryList = (
    prev: Pick<StoryStore, 'records' | 'selected'>,
    stories: StoryMeta[] | undefined
): { records: StoryEntry[]; selected: StoryEntry | null } | null => {
    // Empty/missing list → not a sync signal; keep cached records as-is.
    if (!stories || stories.length === 0) return null;

    const prevByStoryId = new Map(prev.records.map((r) => [r.storyId, r]));
    const serverIds = new Set(stories.map((s) => s.storyId));

    // Server-known entries: overlay fresh metadata onto the existing entry
    // (or build a new remote entry for stories never seen before).
    // `serverProcessing` mirrors the server's per-story live background-job
    // flag (plotpoint.json's derived status is NOT enough — a story can sit
    // at 'generating' with its job dead after a server restart). The overlay
    // happens on every list sync so the flag tracks the registry closely.
    const serverEntries: StoryEntry[] = stories.map((meta, index) => {
        const existing = prevByStoryId.get(meta.storyId);
        if (existing) {
            return {
                ...existing,
                storyName: meta.storyName,
                title: meta.storyName || existing.title,
                chapterRequested: meta.chapterRequested,
                chapterCompleted: meta.chapterCompleted,
                createdDate: meta.createdDate || existing.createdDate,
                status: meta.status,
                // Server-confirmed live background thread. A server predating
                // the registry omits the field → treated as not processing.
                serverProcessing: meta.processing ?? false,
                // The registry is the AUTHORITY on "a job is running for this
                // story": when a successful list sync reports processing=false,
                // any lingering local isProcessing is stale (e.g. the main poll
                // loop set it while the job ran and was cancelled by the same
                // flag drop) and must retire — otherwise the tile would animate
                // forever and the poll loop would never stop. Preserved while
                // the registry CONFIRMS work (processing=true), covering the
                // window where this session's POST/PATCH is still in flight.
                // Cache-only stories (absent from the response) keep their flag
                // — see cacheOnlyEntries below.
                isProcessing: meta.processing ? existing.isProcessing : false,
                // Static-memory staleness delta: the server's lastUpdatedDate
                // (plotpoint.json mtime) vs the timestamp recorded when the
                // cached `data` was fetched. Different (and both known) →
                // dataStale: the cached payload predates a server write and
                // must be re-fetched on next view. Equal → dataStale clears
                // (the delta was resolved by a fetch that already saw the
                // latest write — e.g. the poll loop landing fresh data and the
                // list sync arriving after). Unknown timestamps (legacy server
                // omits lastUpdatedDate, or entry has no stored lastUpdatedAt)
                // never flag stale — we can't prove a delta without both
                // values, and false-positives would refetch every sync.
                dataStale:
                    meta.lastUpdatedDate && existing.lastUpdatedAt
                        ? meta.lastUpdatedDate !== existing.lastUpdatedAt
                        : false,
                // Track the server's latest timestamp as the entry's
                // lastUpdatedAt. NOTE: this field doubles as "when our cached
                // data was fetched" — SectionStoryContent updates it when it
                // stores fetched data, so between syncs it reflects the fetch,
                // and a list sync only marks dataStale when the server moved
                // BEYOND what the fetch saw. A server write that happens and
                // is then fully fetched lands the values back in agreement.
                lastUpdatedAt: meta.lastUpdatedDate ?? existing.lastUpdatedAt,
                missingFromServer: false
            };
        }
        // New server story — negative id namespace (see BootstrapLayer) so
        // server-seeded entries never collide with locally created
        // Date.now() ids. data starts null; SectionStoryContent polls it in
        // on selection.
        return {
            id: -(Date.now() + index + 1),
            storyId: meta.storyId,
            storyName: meta.storyName,
            title: meta.storyName || meta.storyId.slice(0, 8),
            storyline: '',
            chapterRequested: meta.chapterRequested,
            chapterCompleted: meta.chapterCompleted,
            createdDate: meta.createdDate,
            // Record the server's timestamp; data is null for new entries so
            // there is no cached payload that could be stale — dataStale is
            // explicitly false (not undefined) so consumers comparing strictly
            // see a settled value.
            lastUpdatedAt: meta.lastUpdatedDate,
            status: meta.status,
            data: null,
            isProcessing: false,
            serverProcessing: meta.processing ?? false,
            error: '',
            isRemote: true,
            dataStale: false,
            missingFromServer: false
        };
    });

    // Cache-only entries: NOT on the server but cached locally — keep them
    // visible (requirement: "stories may exist in cache but missing in
    // server — display on the sidebar regardless") and flag them so the
    // delete path knows to purge the cache instead of calling DELETE.
    // serverProcessing resets to false: with no server entry there is no
    // live-job confirmation, and the next list sync re-establishes it.
    const cacheOnlyEntries: StoryEntry[] = prev.records
        .filter((r) => !serverIds.has(r.storyId))
        .map((r) => ({ ...r, missingFromServer: true, serverProcessing: false }));

    const records = [...serverEntries, ...cacheOnlyEntries];

    // Re-resolve the selection against the merged list. The previously
    // selected storyId always survives the merge (server entry or retained
    // cache-only entry), so this only fails when prev.selected pointed at
    // an entry that was never in records (e.g. ad-hoc initialStore seeds).
    let selected: StoryEntry | null = null;
    if (prev.selected) {
        selected = records.find((r) => r.storyId === prev.selected!.storyId) ?? null;
    }
    if (!selected && records.length > 0) {
        const lastStoryId = getLastStoryId();
        selected = (lastStoryId ? records.find((r) => r.storyId === lastStoryId) : undefined) ?? records[0];
    }
    return { records, selected };
};

// Handle for the pending idle write — allows coalescing rapid updates.
let pendingIdleHandle: number | null = null;
// Raw entries (not yet persistable-stripped) — the deferred write routes
// through saveRecordsToStorage, which does the toPersistable mapping itself.
let pendingRecords: StoryEntry[] | null = null;

// Session-scoped cache-health state (see saveRecordsToStorage). Module-level
// because the save is synchronous/static while the consumer is React state.
// Story IDs are retained so one failed key does not mark every tile failed.
const lastSaveFailedStoryIds = new Set<string>();

// Outcome of the most recent SETTLED IndexedDB mirror sync (see the
// fire-and-forget storyCacheSet in saveRecordsToStorage). NOT reset while a
// sync is in flight — the flag holds the last settled verdict until the next
// one lands, so the persist effect's deriveCacheHealth() snapshot always
// describes a real, settled outcome and can never ping-pong the store's
// cacheMirrorWriteFailed between "failed" and "ok" on every records change.
let lastMirrorWriteFailed = false;

/** True when the last saveRecordsToStorage could not write localStorage. */
export const didLastSaveFail = (): boolean => lastSaveFailedStoryIds.size > 0;

/** Story IDs whose localStorage key failed during the last records save. */
export const getLastSaveFailedStoryIds = (): string[] => [...lastSaveFailedStoryIds];

/** True when the most recent settled mirror sync failed (no durable tier). */
export const didLastMirrorWriteFail = (): boolean => lastMirrorWriteFailed;

/**
 * Tier-aware cache-health snapshot: what the LAST save left behind.
 *   - cacheWriteFailed / cacheWriteFailedStoryIds: the synchronous
 *     localStorage tier's outcome (unchanged semantics from the previous
 *     fix — scoped per story).
 *   - cacheMirrorWriteFailed: the durable IndexedDB tier's outcome. When BOTH
 *     are true, NO tier accepted the payload — the sidebar must present the
 *     stronger condition (stories cannot be saved on this device) instead of
 *     the hedged "durable local app storage may still be available" copy,
 *     which overpromises in private mode / storage-dead WebViews.
 */
export type CacheHealth = {
    cacheWriteFailed: boolean;
    cacheWriteFailedStoryIds: string[];
    cacheMirrorWriteFailed: boolean;
};

/** Snapshot of both cache tiers' health after the latest save/settled mirror. */
export const deriveCacheHealth = (): CacheHealth => ({
    cacheWriteFailed: didLastSaveFail(),
    cacheWriteFailedStoryIds: getLastSaveFailedStoryIds(),
    cacheMirrorWriteFailed: didLastMirrorWriteFail()
});

/**
 * Serialize one entry's chapter payload with its revision history trimmed to
 * the LATEST revision per chapter. A quota-shedding rung — the dropdown's
 * default selection is the last index, so the visible body survives even
 * when revision history is dropped.
 */
const trimToLatestRevisions = (entry: PersistableStoryEntry): PersistableStoryEntry => {
    if (!entry.data) return entry;
    return {
        ...entry,
        data: {
            ...entry.data,
            chapters: (entry.data.chapters ?? []).map((ch) => {
                const revisions = ch.revisions ?? [];
                return revisions.length > 1
                    ? { ...ch, revisions: [revisions[revisions.length - 1]] }
                    : ch;
            })
        }
    };
};

// Shed rung of a story's cached payload — the ladder (lightest last):
//   0 = full fidelity (all revisions)
//   1 = latest revision per chapter
//   2 = metadata-only (data: null) — the story list always survives offline
const buildShedRung = (entry: PersistableStoryEntry, rung: number): PersistableStoryEntry => {
    if (rung >= 2) return { ...entry, data: null };
    if (rung === 1) return trimToLatestRevisions(entry);
    return entry;
};

// OLDEST-FIRST comparator for make-room shedding (see saveRecordsToStorage
// pass 2). Keyed by lastActionedAt (client-owned user-action stamp) falling
// back to createdDate — the same recency key the sidebar sorts by. Stories
// with no usable timestamp sort first (we know least about them, so they are
// the safest to shed).
const oldestFirst = (a: PersistableStoryEntry, b: PersistableStoryEntry): number => {
    const timeOf = (entry: PersistableStoryEntry): number => {
        const parsed = Date.parse(entry.lastActionedAt || entry.createdDate || '');
        return Number.isNaN(parsed) ? 0 : parsed;
    };
    return timeOf(a) - timeOf(b);
};

// Per-story persistence state — WHAT IS CURRENTLY IN THE STORY'S KEY. The
// fingerprint is the cheap structural signature (storyCacheFingerprint —
// updated timestamp + persisted fields + chapter structure, never the
// multi-MB chapter bytes); the rung is the shed level the key was written
// at. Together they let an unchanged story be skipped for the cost of one
// small fingerprint build + one key-existence read — no multi-MB
// JSON.stringify, no setItem — which is the whole point: a generating
// story's poll ticks and the periodic list syncs fire saveRecordsToStorage
// every few seconds, and every OTHER story would otherwise pay a full
// serialization on each of those just to be compared and discarded.
//
// The fingerprint is only TRUSTED when the key still exists
// (localStorage.getItem(key) !== null — cheap): a map entry can go stale
// when the key is removed out-of-band (test localStorage.clear(),
// migration/self-heal rewriting keys), and the null check makes the module
// self-heal by falling back to the exact write path. The maps are also
// cleaned up wherever a key is deliberately removed (orphan cleanup,
// deleteStory).
const persistedFingerprints = new Map<string, string>();
const persistedRungs = new Map<string, number>();

/** Drop the persistence-state entries for one story (key removed). */
const forgetPersistedStory = (storyId: string): void => {
    persistedFingerprints.delete(storyId);
    persistedRungs.delete(storyId);
};

/**
 * Write ONE story's persistable record to its own localStorage key
 * ('storyGenerator:story:<storyId>') at a given minimum shed rung. Writes
 * only when the payload actually changed (cheap string comparison against
 * the stored value) so a poll tick for one story never rewrites the other
 * stories' keys.
 *
 * UNCHANGED-STORY SKIP: when the entry's fingerprint matches what the key
 * already holds (see persistedFingerprints), the story IS the cache — return
 * immediately without serializing the chapter payload or writing anything.
 * `allowSkip=false` (make-room shedding) forces the write: the caller is
 * deliberately DOWNGRADING the key to a lighter rung even though the store
 * entry itself did not change.
 *
 * QUOTA LADDER: each rung from `minRung` up is serialized lazily and
 * ATTEMPTED against the real localStorage.setItem, so a payload that exceeds
 * the quota falls through to the next-lighter rung instead of dropping
 * everything in one step.
 *
 * Returns the rung index that was accepted (>= minRung), or -1 when every
 * rung failed (storage disabled / private mode / origin quota exhausted —
 * the caller decides whether make-room shedding can help, see
 * saveRecordsToStorage pass 2).
 */
const saveStoryAtRung = (
    entry: PersistableStoryEntry,
    minRung: number,
    allowSkip = true,
    maxRung = 2
): number => {
    const key = storyStorageKey(entry.storyId);
    const fingerprint = storyCacheFingerprint(entry);
    // Already cached, updated timestamp (and everything persisted) unchanged
    // → nothing to write. The rung the key holds is tracked alongside.
    if (
        allowSkip &&
        persistedFingerprints.get(entry.storyId) === fingerprint &&
        localStorage.getItem(key) !== null
    ) {
        return persistedRungs.get(entry.storyId) ?? 0;
    }
    for (let rung = Math.max(0, minRung); rung <= Math.min(2, maxRung); rung++) {
        let incoming: string;
        try {
            incoming = JSON.stringify(buildShedRung(entry, rung));
        } catch {
            // Serialization failed (poisoned record) — shed to the next rung.
            continue;
        }
        try {
            if (localStorage.getItem(key) !== incoming) {
                localStorage.setItem(key, incoming);
            }
            // Write accepted (or unchanged) — this rung is the story's new
            // cache content; record its state and stop shedding.
            persistedFingerprints.set(entry.storyId, fingerprint);
            persistedRungs.set(entry.storyId, rung);
            return rung;
        } catch {
            // QuotaExceededError (or storage unavailable) — shed further.
        }
    }
    return -1;
};

/**
 * Convert the legacy blob without ever requiring it and all replacement keys
 * to coexist. Full-fidelity writes are required here: entries that cannot be
 * converted are kept in a smaller residual legacy blob instead of silently
 * shedding chapter data during migration.
 */
const migrateLegacyRecords = (
    merged: PersistableStoryEntry[],
    legacy: PersistableStoryEntry[],
    originalRaw: string
): void => {
    const mergedByStoryId = new Map(merged.map((entry) => [entry.storyId, entry]));
    const targets = [...new Set(legacy.map((entry) => entry.storyId))]
        .map((storyId) => mergedByStoryId.get(storyId))
        .filter((entry): entry is PersistableStoryEntry => entry !== undefined);
    const originals = new Map<string, string | null>();
    let blobRemoved = false;

    const rollback = () => {
        try {
            // Clear converted copies first. The exact original blob then fits
            // under the same quota it occupied before migration began.
            targets.forEach((entry) => {
                localStorage.removeItem(storyStorageKey(entry.storyId));
                forgetPersistedStory(entry.storyId);
            });
            localStorage.setItem(STORAGE_KEY_RECORDS, originalRaw);
            originals.forEach((raw, storyId) => {
                if (raw !== null) localStorage.setItem(storyStorageKey(storyId), raw);
            });
        } catch {
            // Best effort under a storage device that became unavailable
            // mid-operation. The in-memory merged result still hydrates.
        }
    };

    try {
        // Permission preflight that consumes no additional quota. If writes
        // are disabled, leave the legacy blob untouched and hydrate from it.
        localStorage.setItem(STORAGE_KEY_RECORDS, originalRaw);
        targets.forEach((entry) => {
            originals.set(entry.storyId, localStorage.getItem(storyStorageKey(entry.storyId)));
        });

        localStorage.removeItem(STORAGE_KEY_RECORDS);
        blobRemoved = true;
        if (localStorage.getItem(STORAGE_KEY_RECORDS) !== null) {
            blobRemoved = false;
            return;
        }

        const unresolved = targets.filter((entry) => saveStoryAtRung(entry, 0, false, 0) < 0);
        if (unresolved.length > 0) {
            // Keep only entries that still need conversion. A later load
            // unions these with successful per-story keys and retries.
            localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(unresolved));
        }
    } catch {
        if (blobRemoved) rollback();
    }
};

/** Remove every per-story key whose storyId is absent from `records`. */
const removeOrphanStoryKeys = (validIds: Set<string>): void => {
    try {
        // Collect first, remove after — removing keys while iterating
        // localStorage shifts the indices under the cursor.
        const doomed: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(STORAGE_KEY_STORY_PREFIX)) continue;
            if (!validIds.has(key.slice(STORAGE_KEY_STORY_PREFIX.length))) {
                doomed.push(key);
            }
        }
        doomed.forEach((key) => {
            localStorage.removeItem(key);
            // The key is gone — its fingerprint/rung state is stale. Without
            // this a re-created storyId could be skipped against a key that
            // no longer exists (the skip's null guard would catch it, but
            // keeping the maps in lockstep is the cheap, explicit path).
            forgetPersistedStory(key.slice(STORAGE_KEY_STORY_PREFIX.length));
        });
    } catch {
        // Best effort — an orphaned key is harmless (it belongs to a story
        // no longer in the store and is simply never read again).
    }
};

/** Remove the legacy allocation before saving the authoritative full record set. */
const removeLegacyBlob = (): void => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_RECORDS);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        // Preserve unreadable/unknown data rather than guessing that it is
        // safe to discard. Valid legacy arrays are already represented by the
        // complete `records` argument at this point.
        if (
            !Array.isArray(parsed) ||
            !parsed.every(
                (entry) =>
                    !!entry &&
                    typeof entry === 'object' &&
                    typeof (entry as PersistableStoryEntry).storyId === 'string'
            )
        ) {
            return;
        }
        localStorage.removeItem(STORAGE_KEY_RECORDS);
    } catch {
        // The per-story write path below records any affected story IDs.
    }
};

/**
 * Synchronous write of the records to localStorage — PER STORY. Each entry
 * goes to its own key ('storyGenerator:story:<storyId>'), so one story's
 * progress (a generating/expanding job re-persists every poll tick) only
 * ever rewrites that story's key.
 *
 * PASS 1 — per-story quota ladder: every story saves at its own lightest
 * rung (full → trimmed revisions → metadata-only). A story that sheds itself
 * degrades only ITS OWN cached data. Stories whose cheap fingerprint
 * (storyCacheFingerprint — updated timestamp + persisted fields + chapter
 * structure) matches what their key already holds are SKIPPED entirely: no
 * multi-MB serialization, no read-modify-write — already cached + unchanged
 * timestamp = nothing to do. Only stories whose fingerprint changed (new
 * chapter landed, user action, staleness flip) pay the serialization.
 *
 * PASS 2 — make room (LAST RESORT): localStorage quota is ORIGIN-WIDE (~5MB
 * shared by every key), so a story can fail ALL of its own rungs purely
 * because the OTHER cached stories fill the budget — without this pass a
 * full cache would mark the new story as "cache write failed" even though
 * plenty of shedable content exists. When
 * a story failed its own ladder, the OLDEST cached stories (recency key:
 * lastActionedAt || createdDate — the sidebar's own sort key) are degraded
 * ONE RUNG at a time (trim revision history → metadata-only), retrying the
 * failed story's full ladder after each step, until it fits or nothing
 * shedable remains. This is the old single-blob ladder's space-reclaiming
 * job, but scoped: it only engages on a genuine failure, sheds progressively
 * (never jumps straight to wiping content), and every shed payload stays
 * recoverable — the IndexedDB mirror never sheds, and
 * upgradeRecordsFromIdbMirror restores the chapters at the next boot.
 *
 * The failed-story ID set (→ store.cacheWriteFailedStoryIds → that story's
 * warning tile state) is populated ONLY when a story still could not be saved
 * after everything shedable was shed — i.e. localStorage is unavailable or
 * truly full. A metadata-only save is a SUCCESSFUL save.
 *
 * ORPHAN CLEANUP: keys for stories no longer in `records` (deleted) are
 * removed, so deleting a story purges its cache without a full-blob rewrite.
 *
 * INDEXEDDB MIRROR (see ./storyCache.ts): the FULL-FIDELITY array is ALWAYS
 * mirrored to IndexedDB fire-and-forget, regardless of which localStorage
 * rung won. localStorage is ~5MB and wiped entirely by iOS Safari private
 * mode / ITP 7-day eviction; IndexedDB has orders-of-magnitude larger quotas
 * and survives both. The mirror therefore holds the UNSHED cache, and
 * upgradeRecordsFromIdbMirror restores that richness at boot when the
 * localStorage copy is poorer than the mirror. The mirror write's outcome is
 * recorded (lastMirrorWriteFailed → didLastMirrorWriteFail → deriveCacheHealth)
 * so a BOTH-TIERS-DEAD save — localStorage unavailable AND the mirror failed
 * (storage-disabled WebView, evicted private mode) — can be told apart from a
 * localStorage-only failure whose durable copy still landed.
 */
export const saveRecordsToStorage = (records: StoryEntry[]): void => {
    const serializable = records.map(toPersistable);
    const validIds = new Set(serializable.map((entry) => entry.storyId));

    // Reset per-story cache health optimistically at the start of each save.
    lastSaveFailedStoryIds.clear();
    // The mirror outcome flag is deliberately NOT reset here: it holds the
    // most recent SETTLED sync's verdict until this save's storyCacheSet
    // settles and overwrites it. Resetting it synchronously would make the
    // persist effect's snapshot read "mirror ok" for every save, so a dead
    // mirror tier would never surface (and an earlier design that ping-ponged
    // the flag against an async store notification looped the renderer).
    // The persist effect therefore always derives the LAST SETTLED outcome.
    // Mirror the FULL payload to IndexedDB FIRST (fire-and-forget) — the
    // durable tier never sheds, so even when localStorage must degrade the
    // mirror keeps every revision for the next boot's upgrade pass. The
    // mirror sync is per story internally (unchanged stories skipped), so a
    // poll tick for one story does not re-put the others.
    void storyCacheSet(serializable).then((ok) => {
        // Surface the outcome beyond the console: on mobile the mirror is
        // the survivor tier, so a failed mirror write combined with a failed
        // localStorage tier means NOTHING durable holds the records — the
        // persist effect's deriveCacheHealth() reads this flag on the next
        // records change and the sidebar stops showing the hedged
        // "may still be available" copy (see cacheMirrorWriteFailed).
        //
        // Deliberately NO store notification from this async landing: the
        // provider's mirror flag is derived in the persist effect (the
        // synchronous, effect-time snapshot) — an out-of-band setState from
        // this fire-and-forget microtask interleaves with pending store
        // updates and React's act-flush update replay can turn it into an
        // unbounded render loop under RTL's waitFor (observed in
        // App.test.tsx). The flag converges by the next records change
        // (poll ticks / list syncs fire saves every few seconds).
        lastMirrorWriteFailed = !ok;
        if (!ok) {
            // Logged, not thrown — the localStorage tier is independent.
            console.warn('[storyCache] IndexedDB mirror write failed (localStorage copy retained)');
        }
    });

    // Any blob left by an old or interrupted migration is dead allocation at
    // this point: `records` is the complete, merged store set. Free it before
    // per-story writes so stale duplicate bytes cannot force every rung over
    // the origin quota.
    removeLegacyBlob();

    // ── Pass 1: every story saves at its own lightest rung ────────────────
    // savedRungs tracks the rung each story's key currently holds (needed by
    // pass 2 to know how much shed headroom a story has left).
    const savedRungs = new Map<string, number>();
    const failed: PersistableStoryEntry[] = [];
    serializable.forEach((entry) => {
        const rung = saveStoryAtRung(entry, 0);
        if (rung >= 0) savedRungs.set(entry.storyId, rung);
        else failed.push(entry);
    });

    // ── Pass 2: make room for stories the shared quota could not fit ──────
    // Only engages on a genuine pass-1 failure — the common poll-tick save
    // (one story updated, everything fits) never touches other stories.
    if (failed.length > 0) {
        // Shed candidates: stories that DID save, oldest first. A story
        // already at rung 2 (metadata-only) has nothing left to give.
        const shedable = serializable
            .filter((entry) => savedRungs.has(entry.storyId))
            .sort(oldestFirst);
        for (const failedEntry of failed) {
            let saved = false;
            // Degrade one story ONE RUNG per step (oldest first), retrying
            // the failed story's FULL ladder after every step — and keep
            // cycling while ANY story still has shed headroom. A single pass
            // over the list is not enough: one big old story may need to go
            // trim → metadata-only before the failed story fits.
            let headroom = true;
            while (!saved && headroom) {
                headroom = false;
                for (const other of shedable) {
                    const currentRung = savedRungs.get(other.storyId) ?? 2;
                    if (currentRung >= 2) continue; // already minimal — nothing to take
                    headroom = true;
                    // Degrade the other story ONE rung further (trim first,
                    // metadata-only only if trimming was not enough).
                    // allowSkip=false: the store entry did NOT change — the
                    // fingerprint skip would keep the key at its current
                    // rung, but shedding is exactly the point here.
                    const shedRung = saveStoryAtRung(other, currentRung + 1, false);
                    if (shedRung >= 0) savedRungs.set(other.storyId, shedRung);
                    // Space changed — give the failed story its FULL ladder
                    // back (it deserves a chance at full fidelity, not just
                    // the rung it failed at).
                    const retryRung = saveStoryAtRung(failedEntry, 0);
                    if (retryRung >= 0) {
                        savedRungs.set(failedEntry.storyId, retryRung);
                        saved = true;
                        break;
                    }
                }
            }
            if (!saved) {
                // Nothing shedable remained — storage is genuinely
                // unavailable or truly full. The in-memory store keeps
                // working for this session and the IndexedDB mirror (which
                // never sheds) holds the full payload for recovery.
                lastSaveFailedStoryIds.add(failedEntry.storyId);
            }
        }
    }

    // Purge keys of stories removed from the records list (deleted) so a
    // deleted story can never resurrect from a stale key on the next boot.
    removeOrphanStoryKeys(validIds);
};

/**
 * Recover the records cache from the IndexedDB mirror.
 *
 * Called by BootstrapLayer on mount when localStorage hydration found
 * NOTHING (private-mode wipe, ITP eviction, quota churn) but the durable
 * IndexedDB mirror may still hold the last written payload. Restores the
 * records into localStorage (so the synchronous tier is self-healing) and
 * returns them for the store hydration — null when this tier has nothing.
 */
export const loadRecordsFromIdbMirror = async (): Promise<StoryEntry[] | null> => {
    const mirrored = await storyCacheGet();
    if (!mirrored || mirrored.length === 0) return null;
    try {
        // Self-heal the localStorage tier PER STORY: write each recovered
        // record back to its own key so subsequent synchronous saves start
        // from this state. Failure is fine (private mode will keep failing)
        // — the returned records still hydrate the store for THIS session.
        mirrored.forEach((entry) => {
            try {
                const raw = JSON.stringify(entry);
                if (localStorage.getItem(storyStorageKey(entry.storyId)) !== raw) {
                    localStorage.setItem(storyStorageKey(entry.storyId), raw);
                }
            } catch {
                // localStorage still unavailable — the in-memory hydration
                // below still recovers the session.
            }
        });
        // The superseded legacy blob (if any) has been re-keyed per story —
        // remove it so it cannot resurrect stale stories on the next boot.
        try {
            localStorage.removeItem(STORAGE_KEY_RECORDS);
        } catch {
            // Best effort.
        }
        // Rehydrate with the same defaults loadRecordsFromStorage applies
        // (transient flags reset, legacy fields defaulted), then order
        // NEWEST-FIRST by the sidebar's sort key (lastActionedAt falling
        // back to createdDate) — storyCacheGet returns key-lexicographic
        // order, which is meaningless for the store's records ordering.
        return mirrored
            .map((entry) => rehydratePersistable(entry as PersistableStoryEntry))
            .sort(
                (a, b) =>
                    Date.parse(b.lastActionedAt || b.createdDate || '0') -
                    Date.parse(a.lastActionedAt || a.createdDate || '0')
            );
    } catch {
        return null;
    }
};

/**
 * Upgrade the localStorage cache from the IndexedDB mirror when the mirror
 * holds RICHER content (per story).
 *
 * WHY: the localStorage quota ladder (saveSingleStoryToStorage) sheds weight
 * under quota — a story that no longer fits loses revisions or its whole
 * chapter payload. The IndexedDB mirror NEVER sheds, so after a shed session
 * the mirror holds chapters the localStorage copy no longer does. At boot,
 * per storyId:
 *   - localStorage entry has NO data and the mirror HAS data → take the
 *     mirror's data (chapter bodies restored).
 *   - both have data → take whichever entry has MORE revisions per chapter
 *     (the mirror's un-shed history wins).
 *   - otherwise keep the localStorage entry.
 *
 * Returns the upgraded array (same order) or null when there is nothing to
 * upgrade (no mirror / mirror poorer than localStorage). BootstrapLayer
 * merges the result into the hydrated records before rendering.
 */
export const upgradeRecordsFromIdbMirror = async (records: StoryEntry[]): Promise<StoryEntry[] | null> => {
    const mirrored = await storyCacheGet();
    if (!mirrored || mirrored.length === 0) return null;

    const mirrorByStoryId = new Map(mirrored.map((m) => [m.storyId, m]));
    let changed = false;

    const upgraded = records.map((entry) => {
        const mirror = mirrorByStoryId.get(entry.storyId);
        if (!mirror || !mirror.data) return entry;

        // Case 1: localStorage entry has NO chapter payload but the mirror
        // does — restore it (metadata-only shed / quota wipe recovery).
        if (!entry.data) {
            changed = true;
            return { ...entry, data: mirror.data as StoryData };
        }

        // Case 2: both hold data — the mirror wins when it carries MORE
        // revisions anywhere (the ladder trimmed those revisions away).
        const localChapters = entry.data.chapters ?? [];
        const mirrorChapters = (mirror.data.chapters ?? []) as Chapter[];
        const mirrorRicher = localChapters.some((ch, i) => {
            const mCh = mirrorChapters[i];
            if (!mCh) return false;
            return (mCh.revisions?.length ?? 0) > (ch.revisions?.length ?? 0);
        });
        if (mirrorRicher) {
            changed = true;
            return { ...entry, data: mirror.data as StoryData };
        }
        return entry;
    });

    return changed ? upgraded : null;
};

/**
 * Schedule a non-blocking write of records to localStorage.
 * Coalesces rapid successive calls: only the latest records payload is written.
 * Uses requestIdleCallback when available, falls back to setTimeout(0).
 *
 * KEPT for API compatibility with existing tests, but the provider no longer
 * routes through it — the offline-cache contract requires the SYNCHRONOUS
 * saveRecordsToStorage above (a deferred write can be lost when the tab
 * closes before the idle callback fires, which is exactly the
 * "server unreachable → empty list" bug this module fixes). The deferred
 * write path itself routes through the per-story saveRecordsToStorage so
 * both entrypoints share one cache layout.
 */
export const scheduleSaveRecordsToStorage = (records: StoryEntry[]): void => {
    pendingRecords = records;

    // If a write is already scheduled, the new payload replaces it — no extra work.
    if (pendingIdleHandle !== null) return;

    const write = () => {
        pendingIdleHandle = null;
        if (!pendingRecords) return;
        const toWrite = pendingRecords;
        pendingRecords = null;
        try {
            // Same per-story write path as the synchronous contract — one
            // key per story, change-detected, quota-shed per story.
            saveRecordsToStorage(toWrite);
        } catch {
            // Storage full or unavailable — silently ignore.
        }
    };

    if (typeof requestIdleCallback === 'function') {
        pendingIdleHandle = requestIdleCallback(write, { timeout: 2000 });
    } else {
        // Fallback: defer to next macrotask so we don't block the current render.
        pendingIdleHandle = setTimeout(write, 0) as unknown as number;
    }
};

/**
 * Cancel any pending idle/timeout write. Useful in test cleanup to prevent
 * a stale write from a previous test leaking into the next one.
 */
export const cancelPendingStorageWrites = (): void => {
    if (pendingIdleHandle !== null) {
        if (typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(pendingIdleHandle);
        } else {
            clearTimeout(pendingIdleHandle as unknown as number);
        }
        pendingIdleHandle = null;
        pendingRecords = null;
    }
};

// Shape of a unified chapter as returned by GET /v1/storyboard/generations/:storyId.
// Each chapter includes its plotpoints and expansion status. If the chapter has
// been expanded, revisions[] is present with one entry per generation attempt;
// otherwise expanded is false and only plotpoints are available.
// See story-generator.yml UnifiedChapter schema.
export type Chapter = {
    chapterNumber: string; // "1", "2", etc.
    chapterIndex: number; // 0-based index
    title: string; // chapter title from the LLM
    plotpoints: string[]; // plotpoints for this chapter
    expanded: boolean; // true if chapter-XXX.json has non-empty result.content
    canReExpand: boolean; // true if chapter-XXX.json exists (created by the chapter's own expansion)
    revisions?: Array<{
        content: string; // raw markdown body
        wordCount: number; // word count for this revision
        generationTimeMs: number; // time in ms the LLM took to generate
    }>;
};

// Shape of the story data returned by the GET endpoint.
// chapters is the unified array of all chapters (expanded or not).
// meta contains story metadata from story.json (or null if absent).
// meta.status is the raw plotpoint.json status when present ('generating' |
// 'completed' | 'failed') — SectionStoryContent uses it (with the chapter
// count) to offer the resume action for interrupted plotline generation.
// meta.lastUpdatedAt mirrors the list endpoint's lastUpdatedDate (mtime of
// plotpoint.json) — the staleness key the static memory compares against the
// cached record to decide whether `data` is stale and must be re-fetched.
export type StoryData = {
    chapters: Chapter[];
    meta: {
        storyName?: string;
        storyline: string;
        chapterCount: number;
        createdAt: string;
        status?: string;
        lastUpdatedAt?: string;
    } | null;
};

// A single story session in the dashboard.
// `id` is a client-side unique id (timestamp) used for React keys and selection.
// `storyId` is the UUID-like string the user supplies / is generated when creating
// a new story via POST /v1/storyboard/generations/:storyId.
export type StoryEntry = {
    id: number;
    storyId: string;
    storyName?: string;
    title: string;
    storyline: string;
    chapterRequested: number;
    chapterCompleted: number;
    createdDate: string; // ISO 8601 timestamp from the server's collection endpoint
    // ISO 8601 timestamp of the last USER-ACTIONED event on this story —
    // bumped ONLY by data-mutating user actions (POST/PATCH flows: generate,
    // fork, expand, rewrite, append, resume, terminate, delete revision/
    // chapter, rename) via touchStory()/the action handlers. VIEWING does not
    // count: selecting a story or reading its content is read-only (GET) and
    // must never change this timestamp. Deliberately NOT the server's
    // last-modified time either: background generation writes, poll
    // refreshes, and list syncs NEVER touch this field, so the sidebar's
    // "last actioned on top" ordering reflects what the user changed, not
    // what they looked at or what the server wrote. Optional: entries that
    // predate the feature (legacy localStorage cache, freshly synced server
    // stories) have undefined and fall back to createdDate for sorting.
    // Persisted with the records cache so the ordering survives page reloads.
    lastActionedAt?: string;
    // The story's last-updated timestamp from the server (ISO string): the
    // mtime of plotpoint.json. Tracked in THREE places, and they must agree:
    //   - list endpoint: StoryMeta.lastUpdatedDate (mergeServerStoryList copies
    //     it here on every sync)
    //   - per-story GET: StoryData.meta.lastUpdatedAt (SectionStoryContent
    //     refreshes it whenever it fetches fresh data)
    // Undefined means "unknown" — legacy servers predating the field, stories
    // the server cannot stat, cache entries persisted before the feature.
    // Persisted so the staleness comparison survives reloads.
    lastUpdatedAt?: string;
    // True when the server's lastUpdatedAt differs from the cached `data`'s
    // fetch timestamp — i.e. plotpoint.json was rewritten after we fetched,
    // so the cached chapters/storyline may be out of date and the next view
    // must trigger a one-shot re-fetch instead of showing stale content.
    // Set by mergeServerStoryList (delta between the server's
    // lastUpdatedDate and the entry's stored lastUpdatedAt) and cleared by
    // SectionStoryContent once fresh data lands. Persisted so a reload while
    // stale doesn't wrongly show the old payload as fresh. Optional because
    // entries seeded by tests / initialStore may omit it.
    dataStale?: boolean;
    status: 'generating' | 'completed' | 'failed';
    // Progressive data fetched via GET polling. Starts as an empty story (status 200
    // returns { chapters: [], meta: null } for an existing-but-empty dir — see
    // generation-get-story-data.test.ts:110-142). We use null to mean "not yet
    // fetched/pending first poll" and a StoryData object once fetched.
    data: StoryData | null;
    isProcessing: boolean; // true while polling for new chapters
    // Server-confirmed live background thread (mirrors StoryMeta.processing
    // from the server's in-memory job registry). Covers jobs started by ANY
    // session/device — including this one's chapter expansions and rewrites
    // that never set isProcessing. Transient: never persisted (the server
    // registry is process-local, so a server restart blanks it) and reset to
    // false on localStorage rehydrate until the next list sync re-establishes
    // it. The sidebar animates the tile when this OR isProcessing is true.
    serverProcessing?: boolean;
    error: string; // populated if create or fetch failed
    // True for entries that came from the server's GET /v1/storyboard/generations endpoint (BootstrapLayer
    // or Refresh). The collection endpoint returns metadata (storyId, chapterRequested,
    // createdDate, status) but not storyline (which is free-form user text). Remote
    // entries are seeded with the server's chapterRequested but have an empty storyline.
    // Locally-added entries (Add button / SectionStoryInput) have isRemote = false
    // and may carry a storyline from the input form.
    isRemote: boolean;
    // True when the story exists in the local cache but was ABSENT from the last
    // successful server list fetch (e.g. deleted on the server by another
    // session, or created while the server was unreachable). Such stories stay
    // visible in the sidebar regardless (cache is the source of truth for
    // display); deleting them skips the server DELETE and purges the local
    // cache only. Cleared by the next list sync that contains the storyId, or
    // as soon as the story's own GET endpoint answers data again.
    // Optional because entries seeded by tests / initialStore may omit it.
    missingFromServer?: boolean;
};

// The full store shape. `selected` is `StoryEntry | null` (null = nothing selected).
export type StoryStore = {
    records: StoryEntry[];
    selected: StoryEntry | null;
    config: {
        baseUrl: string; // e.g. 'http://localhost:5252/v1/storyboard/generations' (LAN host instead when the UI itself is not loaded from localhost — see resolveStoryboardApiHostName in ../config)
        // Poll cadence for the per-chapter completion pollers (re-expand /
        // rewrite). The MAIN story poll loop no longer uses this interval:
        // it polls at activePollIntervalMs while a background job runs and
        // does not poll at all otherwise (see SectionStoryContent).
        pollIntervalMs: number;
        // FAST poll cadence used while a background job is running for the
        // selected story (create/append/resume stream chapters one at a time;
        // the 2s default keeps the progressive reveal near-live without
        // hammering the server). Idle stories are NEVER polled — there is
        // nothing to update while no job writes their files.
        activePollIntervalMs: number;
        // The LLM client id selected in the top-right header dropdown. Sent as
        // `clientId` in every generation payload (create/fork POST,
        // expand/rewrite/metadata PATCH) and persisted to localStorage. Never
        // stored on the server with the story — see generation-config.ts
        // (resolveClient / parseClientId) on the server side.
        clientId: string;
    };
    // Selectable LLM client ids for the header dropdown, fetched from
    // GET /v1/storyboard/clients (see fetchClientOptions). Starts empty until
    // the fetch resolves; the current config.clientId is always offered as an
    // option even if absent from this list (stale server / fetch failure).
    clientOptions: string[];
    // Optional non-blocking banner set by BootstrapLayer when the initial
    // fetchStoryList fails (eg. server unreachable). The dashboard header reads
    // this and shows a small inline warning. Optional because legacy tests /
    // consumers that don't trigger the bootstrap won't set it.
    loadWarning?: string;
    // Optional non-blocking banner for LOCAL-CACHE health (the sidebar's
    // cache chip). Set when the cache is degraded — e.g. localStorage writes
    // fail entirely (iOS private mode / storage disabled) so stories can no
    // longer be saved for offline reading, or a boot recovery/upgrade pass
    // restored records from the IndexedDB mirror (informational). Transient:
    // never persisted; recomputed by the persist effect / bootstrap each
    // session. Optional because tests seeding initialStore omit it.
    cacheWarning?: string;
    // True when the LAST saveRecordsToStorage could not write localStorage
    // at all for at least one story (every ladder rung failed). This aggregate
    // drives the cache-health chip; tile warnings use the scoped ID list below.
    cacheWriteFailed?: boolean;
    // Story IDs whose localStorage cache-copy write failed in the LAST save.
    // IndexedDB is asynchronous and may still have accepted its durable copy,
    // so this state deliberately describes only the synchronous quick-cache
    // tier. Transient and recomputed on every records save.
    cacheWriteFailedStoryIds?: string[];
    // True when the most recent SETTLED IndexedDB mirror sync failed. The
    // mirror write is fire-and-forget, so its outcome lands AFTER the
    // synchronous persist effect ran — the flag is therefore DERIVED in the
    // persist effect from didLastMirrorWriteFail() (the last settled
    // verdict), which converges by the next records change (poll ticks /
    // list syncs fire saves every few seconds). Combined with
    // cacheWriteFailed it means NO tier accepted the payload (private mode /
    // storage-dead WebView), which the sidebar presents as the stronger
    // "cannot be saved on this device" condition. Transient: never persisted.
    cacheMirrorWriteFailed?: boolean;
    // True when the BOOT-TIME write-probe (classifyStorageTiers in
    // storyCache.ts, run by BootstrapLayer) found localStorage unable to
    // accept writes while records worth saving exist (hydrated from cache or
    // recovered from the mirror). Set once per session; the copy explains the
    // private/incognito / storage-disabled cause and that stories will only
    // last for this visit. Not set for fresh installs with working storage
    // (nothing to warn about) — later save failures are covered by
    // cacheWriteFailed. Transient: never persisted.
    storageUnavailableAtBoot?: boolean;
    // Click counter for the sidebar's story tiles. Bumped by EVERY user click
    // on a tile (StorySidebar's itemProps.onClick) — including re-clicks on the
    // already-selected story. The content feature (StoryContent's selection
    // catch-up effect) watches this nonce: a CHANGE is the "user clicked a
    // story" signal that forces a one-shot server re-check of the selected
    // story's data (GET → compare/merge → recache) even when the cached payload
    // exists and is not flagged dataStale. Without it, a finished, previously
    // cached story would never be re-validated against the server on view —
    // the cached copy would be shown as-is until an unrelated list sync
    // happened to flag staleness. Transient: never persisted (it only matters
    // within the live session; a reload restarts the count and the first
    // effect run re-primes from whatever value the initialStore carries).
    selectionNonce: number;
    // Live snapshot of the server's in-memory background-thread job registry —
    // the `jobs` array from the last successful GET /v1/storyboard/generations
    // (generation-job-registry.ts; one entry per running thread: create/fork/
    // append/resume/expand/rewrite). activeJobs.length IS the number of
    // background threads currently running on the server — the sidebar's
    // "Stories" header renders this as the running-jobs count. Transient, like
    // the per-entry isProcessing/serverProcessing flags: never persisted (the
    // registry is process-local and blanks on server restart) and reset to []
    // on localStorage rehydrate until the next list sync re-establishes it.
    activeJobs: ActiveJob[];
};

type StoryStoreContextValue = {
    store: StoryStore;
    // Update the store via a producer function. Mirrors localContextStore's reactivity
    // (mutating a returned proxy triggers a re-render); here we use a controlled
    // setState so React re-renders on every update.
    setStore: (updater: (prev: StoryStore) => StoryStore) => void;
    // Delete a story by storyId. Calls DELETE API then removes the entry from the store.
    deleteStory: (storyId: string) => Promise<void>;
    // Bump the user-action timestamp (lastActionedAt) for a story. Called by
    // every data-mutating user action on a story (POST/PATCH flows — see
    // StoryEntry.lastActionedAt). VIEWING (selection, reading content) must
    // NOT call this — read-only actions never change the ordering timestamp.
    // Background work (poll loops, list syncs, server job writes) must NEVER
    // call it either.
    touchStory: (storyId: string) => void;
};

// Default LLM client id. Must stay in sync with the server-side fallback in
// generation-config.ts (`CLIENT = CLIENTS.Qwen27B`) — the server applies the
// same default when a payload carries no clientId, so a fresh UI and a
// server-only fallback can never disagree on which model a story is written by.
// ('Qwen27B' is the selectable-id rename of the old 'Qwen3_8' CLIENTS entry —
// see generation-config.ts. A stale 'Qwen3_8' persisted in localStorage is
// rejected by the server's parseClientId with the current id list, which is
// why this constant must move in lockstep with the CLIENTS map.)
export const DEFAULT_CLIENT_ID = 'Qwen27B';

const DEFAULT_CONFIG: StoryStore['config'] = {
    // Every storyboard endpoint (list stories, story CRUD, clients) lives on
    // the SAME dedicated service port — LOCAL_AREA_NETWORK_STORYBOARD_PORT
    // (5252, config/environment/src/port.ts), matching the `port` each
    // service-route*.ts in src/server/endpoints/generations declares. Dial it
    // directly instead of the underload gateway (DATABASE_PORT 5000): the
    // gateway would only 307-redirect /v1/storyboard/* to 5252 anyway.
    // HOST RESOLUTION (resolveStoryboardApiHostName, ../config): the host
    // mirrors the ORIGIN the UI was loaded from — UI served from localhost
    // (the dev server, vite.config.ts server.port 8000) dials the API at
    // http://localhost:5252 (same machine); UI served from any other host
    // falls back to the LAN constant. Previously the host was pinned to
    // LOCAL_AREA_NETWORK_HOST_NAME (192.168.8.128) unconditionally, which
    // forced even localhost-loaded sessions onto the machine's LAN interface.
    // Override via config in production by wrapping with a different provider value.
        baseUrl: `http://${resolveStoryboardApiHostName()}:${LOCAL_AREA_NETWORK_STORYBOARD_PORT}/v1/storyboard/generations`,
    // Poll every 10s. The generation-create-new-story handler writes plotpoint.md
    // almost immediately and chapter files one at a time (see generation-create-new-story.ts:181),
    // so 10s gives a smooth progressive reveal without hammering the server.
    pollIntervalMs: 10000,
    // Fast cadence for ACTIVE background work (see StoryStore['config']).
    // 2s keeps chapter streaming responsive; only applies while a job is
    // actually running for the story — idle stories are not polled at all.
    activePollIntervalMs: 2000,
    // Default LLM client — overridden by localStorage (user's previous choice)
    // or an explicit configOverrides.clientId (tests / deployments).
    clientId: DEFAULT_CLIENT_ID
};

const StoryStoreContext = createContext<StoryStoreContextValue | null>(null);

// Provider that gives the dashboard its reactive store + configurator.
// `configOverrides` lets consumers (e.g. tests) swap the baseUrl and poll interval.
export const StoryStoreProvider: React.FC<{
    children: React.ReactNode;
    configOverrides?: Partial<StoryStore['config']>;
    initialStore?: Partial<StoryStore>;
}> = ({ children, configOverrides, initialStore }) => {
    const [store, setStoreState] = useState<StoryStore>(() => ({
        records: initialStore?.records ?? [],
        selected: initialStore?.selected ?? null,
        clientOptions: initialStore?.clientOptions ?? [],
        // Click nonce starts at 0 (or the seed's value) — see StoryStore.selectionNonce.
        selectionNonce: initialStore?.selectionNonce ?? 0,
        // Registry snapshot starts empty — it is server-process state, re-synced
        // by the first list fetch (BootstrapLayer) like the transient flags.
        activeJobs: initialStore?.activeJobs ?? [],
        cacheWriteFailed: initialStore?.cacheWriteFailed ?? false,
        cacheWriteFailedStoryIds: initialStore?.cacheWriteFailedStoryIds ?? [],
        cacheMirrorWriteFailed: initialStore?.cacheMirrorWriteFailed ?? false,
        storageUnavailableAtBoot: initialStore?.storageUnavailableAtBoot ?? false,
        config: {
            ...DEFAULT_CONFIG,
            ...configOverrides,
            // Precedence: explicit override > user's persisted choice
            // (localStorage) > package default. getClientId() only runs when
            // no explicit override was given, so tests pinning configOverrides
            // are immune to localStorage carried over between runs.
            clientId: configOverrides?.clientId ?? getClientId() ?? DEFAULT_CONFIG.clientId
        }
    }));

    // Stable setStore callback so consumers can use it in effects without re-subscribing.
    const setStore = useCallback(
        (updater: (prev: StoryStore) => StoryStore) => setStoreState((prev) => updater(prev)),
        []
    );

    // Persist selected storyId to localStorage whenever it changes.
    useEffect(() => {
        setLastStoryId(store.selected?.storyId ?? null);
    }, [store.selected?.storyId]);

    // Persist the selected LLM client id whenever it changes. Client-local
    // convenience only — the server never stores clientId with a story.
    //
    // BACKSTOP ONLY: the primary write happens synchronously in the dropdown's
    // change handler (HeaderControls.handleClientChange in
    // src/components/StoryGeneratorApp.tsx). Passive effects are deferred and
    // not guaranteed to flush before page unload, so this effect must NOT be
    // the only persistence path — it exists to cover any OTHER caller that
    // writes config.clientId directly through setStore (tests, future
    // consumers) without going through the dropdown handler.
    useEffect(() => {
        setClientId(store.config.clientId || null);
    }, [store.config.clientId]);

    // Auto-persist records to localStorage whenever they change.
    // SYNCHRONOUS (saveRecordsToStorage, not the idle-deferred variant): the
    // offline-cache contract is "a story viewed from the server is cached
    // immediately". A requestIdleCallback write can be dropped when the tab
    // is closed / reloaded before the idle slot fires — that is precisely the
    // reported failure (server unreachable later → empty story list, because
    // the viewed story never reached localStorage). The synchronous write
    // makes every fetch that lands in the store durable immediately.
    // Writes are PER STORY (one key per storyId, change-detected) and quota-
    // resilient (per-story shedding ladder in saveSingleStoryToStorage) — a
    // generating story's poll ticks rewrite only its own key, and a story
    // that exceeds the quota sheds only its own weight, never another
    // story's cached chapters.
    //
    // CACHE-HEALTH INDICATION: after each save, failed story IDs are mirrored
    // into the store. This keeps tile warnings scoped to the keys that failed;
    // IndexedDB may still have accepted the asynchronous durable mirror copy —
    // UNLESS the mirror sync also failed, in which case deriveCacheHealth
    // reports BOTH tiers dead and the sidebar escalates the copy (see
    // cacheMirrorWriteFailed in the store shape).
    const didHydrateRef = useRef(false);
    useEffect(() => {
        // Skip the very first render — we don't want to overwrite localStorage
        // with the empty initial state before BootstrapLayer hydrates.
        if (!didHydrateRef.current) {
            didHydrateRef.current = true;
            return;
        }
        // Unmounted-guard: after the provider unmounts (test teardown, page
        // unload), a late-arriving fetch promise can still call setStore →
        // this effect → a mirror write that would resurrect wiped records
        // (the didHydrateRef flips false in the cleanup effect below).
        if (!didHydrateRef.current) return;
        saveRecordsToStorage(store.records);
        const health = deriveCacheHealth();
        setStoreState((prev) => {
            const previousIds = prev.cacheWriteFailedStoryIds ?? [];
            const sameIds =
                previousIds.length === health.cacheWriteFailedStoryIds.length &&
                previousIds.every((storyId, index) => storyId === health.cacheWriteFailedStoryIds[index]);
            const sameMirror = (prev.cacheMirrorWriteFailed ?? false) === health.cacheMirrorWriteFailed;
            return prev.cacheWriteFailed === health.cacheWriteFailed && sameIds && sameMirror
                ? prev
                : {
                      ...prev,
                      cacheWriteFailed: health.cacheWriteFailed,
                      cacheWriteFailedStoryIds: health.cacheWriteFailedStoryIds,
                      cacheMirrorWriteFailed: health.cacheMirrorWriteFailed
                  };
        });
    }, [store.records]);
    // Unmount latch: flip didHydrateRef.current to false so late microtasks
    // (a fetch resolving after unmount) cannot write the cache/mirror after
    // test teardown or page unload (see the unmounted-guard above).
    useEffect(
        () => () => {
            didHydrateRef.current = false;
        },
        []
    );

    // Delete a story by storyId.
    //
    // Three paths:
    //   - Server-known story: call the DELETE API, then remove the entry.
    //   - Cache-only story (flagged missingFromServer by the last successful
    //     list sync): the server has no record of it, so the DELETE would just
    //     404 — skip the network call and purge the local cache instead.
    //   - Stale-flag story: the server no longer has the story but the client
    //     doesn't know yet (deleted by another session after the last list
    //     sync, or the list sync never succeeded — e.g. server unreachable at
    //     page load, so missingFromServer was never set). The DELETE answers
    //     404 (generation-delete-story.ts) — treated as an idempotent SUCCESS:
    //     the story is provably gone server-side, so fall through and purge
    //     the local cache anyway. Without this, the DELETE throws, the entry
    //     survives in `records`, the records auto-persist effect keeps
    //     rewriting it to localStorage, and the story resurrects after a page
    //     reload. Any OTHER error (network down, 5xx) rethrows: the server may
    //     still hold the story, so the record must stay (the next successful
    //     list sync either flags it missingFromServer or re-adds it).
    //
    // Removing the entry from `records` feeds the records-persist effect
    // above, which rewrites localStorage without the story — that is what
    // "removes it completely from the cache" (plus the per-story
    // expanded-chapters key cleared here, and lastStoryId cleared by the
    // selected-persist effect when the deleted story was selected).
    const deleteStory = useCallback(
        async (storyId: string) => {
            const entry = store.records.find((r) => r.storyId === storyId);
            if (!entry?.missingFromServer) {
                try {
                    await deleteStoryApi(store.config.baseUrl, storyId);
                } catch (err) {
                    // 404 = already gone from the server → idempotent success,
                    // continue with the local purge. `status` is attached by
                    // the API client (src/api/storyboard.ts deleteStory).
                    const status = (err as { status?: number } | null)?.status;
                    if (status !== 404) throw err;
                }
            }
            // Purge the per-story UI preference cache + the story's own
            // record key alongside the record (the next full save's orphan
            // cleanup would also catch the record key, but this makes the
            // purge immediate).
            clearExpandedChapters(storyId);
            deleteStoryRecordFromStorage(storyId);
            setStore((prev) => ({
                ...prev,
                records: prev.records.filter((r) => r.storyId !== storyId),
                // Clear selection if the deleted story was selected
                selected: prev.selected?.storyId === storyId ? null : prev.selected
            }));
        },
        [store.records, store.config.baseUrl, setStore]
    );

    // Bump the user-action timestamp for one story. Sets lastActionedAt = now
    // on the matching record(s). The `selected` reference is intentionally
    // left untouched: the sidebar reads lastActionedAt from `records` (not
    // from `selected`), and every merge/poll path re-resolves `selected` by
    // storyId anyway — churning the selected object here would just trigger
    // extra effect re-runs downstream.
    const touchStory = useCallback(
        (storyId: string) => {
            // Capture the timestamp at call time (the user-action moment), not
            // inside the updater (which React may defer/re-run).
            const now = new Date().toISOString();
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) => (e.storyId === storyId ? { ...e, lastActionedAt: now } : e))
            }));
        },
        [setStore]
    );

    return (
        <StoryStoreContext.Provider value={{ store, setStore, deleteStory, touchStory }}>
            {children}
        </StoryStoreContext.Provider>
    );
};

// Access the store + setter. Throws if used outside a provider to catch wiring bugs
// early (mirrors the implicit assumption that lightningAgentStore() is always called
// inside <ContextProvider>).
export function useStoryStore(): StoryStoreContextValue {
    const ctx = useContext(StoryStoreContext);
    if (!ctx) {
        throw new Error('useStoryStore must be used inside <StoryStoreProvider>');
    }
    return ctx;
}

