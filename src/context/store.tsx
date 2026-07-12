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
import { deleteStory as deleteStoryApi } from '../api';

// ── localStorage helpers ──────────────────────────────────────────────
const STORAGE_KEY_STORY = 'storyGenerator:lastStoryId';
const STORAGE_KEY_EXPANDED_PREFIX = 'storyGenerator:expanded:';
const STORAGE_KEY_RECORDS = 'storyGenerator:records';

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

// ── Records persistence (async) ────────────────────────────────────────
// Persists the full story records array to localStorage so the dashboard
// loads instantly with cached data even if the server is unreachable.
// Writes are scheduled via requestIdleCallback (or setTimeout fallback)
// to keep the main thread responsive.

// Minimal subset of StoryEntry we actually persist. Omits transient fields
// that don't survive across sessions (error, isProcessing).
type PersistableStoryEntry = Pick<StoryEntry, 'id' | 'storyId' | 'storyName' | 'title' | 'storyline' | 'chapterRequested' | 'chapterCompleted' | 'createdDate' | 'status' | 'isRemote'> & {
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
    status: entry.status,
    data: entry.data,
    isRemote: entry.isRemote
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
            isProcessing: false,
            error: ''
        }));
    } catch {
        return [];
    }
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
// been expanded, content/length/generationTimeMs are present; otherwise expanded
// is false and only plotpoints are available.
// See storyboard-generations.yml UnifiedChapter schema.
export type Chapter = {
    chapterNumber: string; // "1", "2", etc.
    chapterIndex: number; // 0-based index
    title: string; // chapter title from the LLM
    plotpoints: string[]; // plotpoints for this chapter
    expanded: boolean; // true if chapter-XXX.json has non-empty result.content
    canReExpand: boolean; // true if chapter-XXX.json exists (LLM context available for re-expansion)
    content?: string; // raw markdown (## Title\n\nbody) — only when expanded
    length?: number; // word count — only when expanded
    generationTimeMs?: number; // time in ms the LLM took to generate — only when expanded
    history?: Array<{ title: string; content: string; generationTimeMs: number; wordCount: number }>;
};

// Shape of the story data returned by the GET endpoint.
// chapters is the unified array of all chapters (expanded or not).
// meta contains story metadata from story.json (or null if absent).
export type StoryData = {
    chapters: Chapter[];
    meta: { storyName?: string; storyline: string; chapterCount: number; createdAt: string } | null;
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
    createdDate: string; // ISO 8601 timestamp from the server's /list endpoint
    status: 'generating' | 'completed' | 'failed';
    // Progressive data fetched via GET polling. Starts as an empty story (status 200
    // returns { chapters: [], meta: null } for an existing-but-empty dir — see
    // generation-get-story-data.test.ts:110-142). We use null to mean "not yet
    // fetched/pending first poll" and a StoryData object once fetched.
    data: StoryData | null;
    isProcessing: boolean; // true while polling for new chapters
    error: string; // populated if create or fetch failed
    // True for entries that came from the server's GET /list endpoint (BootstrapLayer
    // or Refresh). The list endpoint returns metadata (storyId, chapterRequested,
    // createdDate, status) but not storyline (which is free-form user text). Remote
    // entries are seeded with the server's chapterRequested but have an empty storyline.
    // Locally-added entries (Add button / SectionStoryInput) have isRemote = false
    // and may carry a storyline from the input form.
    isRemote: boolean;
};

// The full store shape. `selected` is `StoryEntry | null` (null = nothing selected).
export type StoryStore = {
    records: StoryEntry[];
    selected: StoryEntry | null;
    config: {
        baseUrl: string; // e.g. 'http://192.168.8.128:5000/v1/storyboard/generations'
        pollIntervalMs: number; // how often to re-poll while isProcessing
    };
    // Optional non-blocking banner set by BootstrapLayer when the initial
    // fetchStoryList fails (eg. server unreachable). The dashboard header reads
    // this and shows a small inline warning. Optional because legacy tests /
    // consumers that don't trigger the bootstrap won't set it.
    loadWarning?: string;
    // Transient cross-component signal: when a non-empty string is set here,
    // SectionStoryInput picks it up, populates the textarea, focuses it, and
    // scrolls the cursor to the bottom. The input component then clears this
    // field so it doesn't re-trigger. Set by content-area action buttons
    // (e.g. "Extend" in SectionStoryContent) that need to hand off text to
    // the storyline input without direct component coupling.
    pendingStoryline?: string;
};

type StoryStoreContextValue = {
    store: StoryStore;
    // Update the store via a producer function. Mirrors localContextStore's reactivity
    // (mutating a returned proxy triggers a re-render); here we use a controlled
    // setState so React re-renders on every update.
    setStore: (updater: (prev: StoryStore) => StoryStore) => void;
    // Delete a story by storyId. Calls DELETE API then removes the entry from the store.
    deleteStory: (storyId: string) => Promise<void>;
};

const DEFAULT_CONFIG: StoryStore['config'] = {
    // Default to the same base the runtime service tests use
    // (runtime/service/endpoints/storyboard/generations/generation-get-story-data.test.ts:4-5).
    // Override via config in production by wrapping with a different provider value.
        baseUrl: 'http://192.168.8.128:5000/v1/storyboard/generations',
    // Poll every 10s. The generation-create-new-story handler writes plotpoint.md
    // almost immediately and chapter files one at a time (see generation-create-new-story.ts:181),
    // so 10s gives a smooth progressive reveal without hammering the server.
    pollIntervalMs: 10000
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
        config: { ...DEFAULT_CONFIG, ...configOverrides }
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

    // Delete a story: call DELETE API, then remove from local store.
    const deleteStory = useCallback(
        async (storyId: string) => {
            await deleteStoryApi(store.config.baseUrl, storyId);
            setStore((prev) => ({
                ...prev,
                records: prev.records.filter((r) => r.storyId !== storyId),
                // Clear selection if the deleted story was selected
                selected: prev.selected?.storyId === storyId ? null : prev.selected
            }));
        },
        [store.config.baseUrl, setStore]
    );

    return (
        <StoryStoreContext.Provider value={{ store, setStore, deleteStory }}>
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
