// Context store for the story generator dashboard.
//
// This mirrors the lightning-agent pattern (library/workflow/lightning-agent/context/store.ts)
// but for the storyboard API:
//   - records: list of story sessions (each with a storyId, storyline input, and
//     progressively-fetched story data)
//   - selected: the currently active story entry (same reference as one in records)
//   - config: API base URL + poll interval (overridable for tests)
//
// Unlike localContextStore, this distribution package cannot import @presource/react
// (it is not in package.json deps — see distribution/story-generator/package.json).
// We use plain React context + useState instead, exposing a custom hook
// `useStoryStore` that mirrors the lightning-agent `lightningAgentStore()` accessor
// pattern (read + mutate triggers re-render).

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { LOCAL_AREA_NETWORK_HOST_NAME, LOCAL_AREA_NETWORK_STORYBOARD_PORT } from '@config/environment';
import { deleteStory as deleteStoryApi, type ActiveJob, type StoryMeta } from '../api';

// ── localStorage helpers ──────────────────────────────────────────────
const STORAGE_KEY_STORY = 'storyGenerator:lastStoryId';
const STORAGE_KEY_EXPANDED_PREFIX = 'storyGenerator:expanded:';
const STORAGE_KEY_RECORDS = 'storyGenerator:records';
// The last-selected LLM client id. NOTE: this is a client-side convenience
// only (remembers the user's dropdown choice between browser sessions). The
// server never persists clientId with a story — it travels with every
// generation payload (POST create/fork, PATCH expand/rewrite), which is why
// the store keeps it in `config` rather than per-story records.
const STORAGE_KEY_CLIENT_ID = 'storyGenerator:clientId';

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

// ── Records persistence (async) ────────────────────────────────────────
// Persists the full story records array to localStorage so the dashboard
// loads instantly with cached data even if the server is unreachable.
// Writes are scheduled via requestIdleCallback (or setTimeout fallback)
// to keep the main thread responsive.

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
 * Synchronous read of cached records from localStorage.
 * Used on initial mount to hydrate the store instantly before the server
 * round-trip completes. Returns [] on any error (SSR, corrupted data, etc.).
 */
export const loadRecordsFromStorage = (): StoryEntry[] => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_RECORDS);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Rehydrate with default transient fields (isProcessing=false, error='').
        // Legacy entries from localStorage may lack createdDate — fall back to epoch
        // so they sort to the bottom (server will supply the real value on refresh).
        return parsed.map((entry: PersistableStoryEntry) => ({
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
        }));
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
let pendingRecords: PersistableStoryEntry[] | null = null;

/**
 * Schedule a non-blocking write of records to localStorage.
 * Coalesces rapid successive calls: only the latest records payload is written.
 * Uses requestIdleCallback when available, falls back to setTimeout(0).
 */
export const scheduleSaveRecordsToStorage = (records: StoryEntry[]): void => {
    const serializable = records.map(toPersistable);
    pendingRecords = serializable;

    // If a write is already scheduled, the new payload replaces it — no extra work.
    if (pendingIdleHandle !== null) return;

    const write = () => {
        pendingIdleHandle = null;
        if (!pendingRecords) return;
        const toWrite = pendingRecords;
        pendingRecords = null;
        try {
            // Only write if data actually changed (cheap JSON comparison).
            const raw = localStorage.getItem(STORAGE_KEY_RECORDS);
            const incoming = JSON.stringify(toWrite);
            if (raw !== incoming) {
                localStorage.setItem(STORAGE_KEY_RECORDS, incoming);
            }
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
    canReExpand: boolean; // true if chapter-XXX.json exists (LLM context available for re-expansion)
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
        baseUrl: string; // e.g. 'http://192.168.8.128:5252/v1/storyboard/generations'
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
    // Override via config in production by wrapping with a different provider value.
        baseUrl: `http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_STORYBOARD_PORT}/v1/storyboard/generations`,
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
        // Registry snapshot starts empty — it is server-process state, re-synced
        // by the first list fetch (BootstrapLayer) like the transient flags.
        activeJobs: initialStore?.activeJobs ?? [],
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
    // Writes are scheduled non-blocking via requestIdleCallback so the UI
    // thread is never blocked by storage I/O.
    const didHydrateRef = useRef(false);
    useEffect(() => {
        // Skip the very first render — we don't want to overwrite localStorage
        // with the empty initial state before BootstrapLayer hydrates.
        if (!didHydrateRef.current) {
            didHydrateRef.current = true;
            return;
        }
        scheduleSaveRecordsToStorage(store.records);
    }, [store.records]);

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
            // Purge the per-story UI preference cache alongside the record.
            clearExpandedChapters(storyId);
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

