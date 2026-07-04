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

import React, { createContext, useContext, useState, useCallback } from 'react';
import { deleteStory as deleteStoryApi } from '../api';

// Shape of a chapter as returned by GET /v1/storyboard/generations/:storyId
// (see runtime/service/endpoints/storyboard/generations/generation-get-story-data.ts:35)
export type Chapter = {
    length: number; // word count
    content: string; // raw markdown (## Title\n\nbody)
    generationTimeMs?: number; // time in ms the LLM took to generate this chapter
};

// Shape of a chapter expansion payload (chapter-XXX.json) returned by GET.
// Contains everything needed to re-trigger the chapter expansion independently:
// plotpoints, context snapshot, model config, and the full expanded result.
// See storyboard-generations.yml ChapterPayload schema.
export type ChapterPayload = {
    storyId: string;
    storyline: string;
    chapterCount: number;
    chapterNumber: string;
    chapterIndex: number;
    title: string;
    plotpoints: string[];
    context: {
        appending: string[];
        request: string;
    };
    config: {
        model: string;
        endpoint: string;
        systemInstructions: string;
        openingMessage: string;
    };
    expansion: {
        minWords: number;
        wordCount: number;
    };
    generationTimeMs?: number; // time in ms the LLM took to generate this chapter
    result: {
        title: string;
        content: string;
    };
};

// Shape of the story data returned by the GET endpoint.
// plotlines is the raw text of plotpoint.md; chapters is sorted list of chapter files.
// payloads is the sorted list of chapter-XXX.json expansion payloads.
export type StoryData = {
    plotlines: string;
    chapters: Chapter[];
    payloads: ChapterPayload[];
};

// A single story session in the dashboard.
// `id` is a client-side unique id (timestamp) used for React keys and selection.
// `storyId` is the UUID-like string the user supplies / is generated when creating
// a new story via POST /v1/storyboard/generations/:storyId.
export type StoryEntry = {
    id: number;
    storyId: string;
    title: string;
    storyline: string;
    chapterCount: number;
    // Progressive data fetched via GET polling. Starts as an empty story (status 200
    // returns { plotlines: '', chapters: [] } for an existing-but-empty dir — see
    // generation-get-story-data.test.ts:110-142). We use null to mean "not yet
    // fetched/pending first poll" and a StoryData object once fetched.
    data: StoryData | null;
    isProcessing: boolean; // true while polling for new chapters
    error: string; // populated if create or fetch failed
    // True for entries that came from the server's GET /list endpoint (BootstrapLayer
    // or Refresh). The list endpoint now returns full StoryMeta objects (storyId,
    // storyline, chapterCount, createdAt) so remote entries are seeded with the
    // server's chapterCount and storyline. Locally-added entries (Add button /
    // SectionStoryInput) have isRemote = false.
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
    // Poll every 3s. The generation-create-new-story handler writes plotpoint.md
    // almost immediately and chapter files one at a time (see generation-create-new-story.ts:181),
    // so 3s gives a smooth progressive reveal without hammering the server.
    pollIntervalMs: 3000
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
