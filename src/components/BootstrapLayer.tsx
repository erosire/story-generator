// Bootstrap layer: fetches the list of all existing stories on mount and seeds
// the store with one entry per story.
//
// Mirrors library/workflow/lightning-agent/components/PersistenceLayer.tsx
// (a hidden component mounted inside <ContextProvider> whose sole job is to
// load existing state into the store on mount — renders nothing).
//
// Behavior:
//   - On mount, hydrates from localStorage first so the dashboard appears
//     instantly with cached data (even if the server is unreachable).
//   - Then calls fetchStoryList(config.baseUrl) to get fresh data from the server.
//   - If the list is non-empty, merges server entries into the store (preserving
//     locally-cached chapter data for entries that haven't changed).
//   - On error, sets a loadWarning on store.config (read by the dashboard
//     header so the user can see the backend is unreachable).
//   - Renders null — purely a side-effect component.

import React from 'react';
import { useStoryStore } from '../context';
import { fetchStoryList, type StoryMeta } from '../api';
import { getLastStoryId, loadRecordsFromStorage } from '../context/store';

// Build a StoryEntry from a StoryMeta object returned by GET /list.
// The list endpoint now returns full metadata (storyId, storyName, storyline,
// chapterCount, createdAt) so we can seed the entry with the server's values.
// storyName is used as the display title when available; falls back to the
// first 8 chars of storyId (matches AddNewButton's convention in SectionStoryTabs.tsx).
const makeEntryFromStoryMeta = (meta: StoryMeta, index: number) => ({
    id: -(Date.now() + index + 1),
    storyId: meta.storyId,
    storyName: meta.storyName,
    title: meta.storyName || meta.storyId.slice(0, 8),
    storyline: '',
    chapterCount: meta.chapterCount,
    data: null,
    isProcessing: false,
    error: '',
    // Marked remote so SectionStoryContent polls to hydrate on selection.
    // Now that the list returns chapterCount, the polling uses the known target
    // instead of stability-based termination.
    isRemote: true
});

// Hidden bootstrap layer. Renders nothing; only effects.
export const BootstrapLayer: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();

    // Ref to prevent double-fetch in React StrictMode dev double-mount.
    const didFetchRef = React.useRef(false);

    React.useEffect(() => {
        if (didFetchRef.current) return;
        didFetchRef.current = true;

        // Capture the baseUrl at mount — store.config is captured here, so if
        // the consumer swaps it later the bootstrap only fires once.
        const baseUrl = store.config.baseUrl;

        // ── Step 1: Hydrate from localStorage instantly ──────────────────
        // This makes the dashboard appear immediately with cached data
        // (stories + chapter content) without waiting for the server.
        const cachedRecords = loadRecordsFromStorage();
        if (cachedRecords.length > 0) {
            setStore((prev) => {
                // Don't overwrite records that were pre-seeded via initialStore
                // prop (eg. by tests).
                if (prev.records.length > 0) return prev;

                const lastStoryId = getLastStoryId();
                const selected = lastStoryId
                    ? cachedRecords.find((m) => m.storyId === lastStoryId) ?? cachedRecords[0]
                    : cachedRecords[0] ?? null;
                return { ...prev, records: cachedRecords, selected: selected ?? prev.selected };
            });
        }

        // ── Step 2: Fetch fresh data from the server ────────────────────
        // Runs in background after localStorage hydration. Merges server
        // entries into the store, preserving locally-cached chapter data.
        fetchStoryList(baseUrl)
            .then(({ stories }) => {
                // No stories → leave store.records as-is (may already have
                // cached records from localStorage).
                if (!stories || stories.length === 0) {
                    return;
                }

                // Server returns stories sorted by createdAt descending (newest
                // first). Build one StoryEntry per StoryMeta using the full
                // metadata (storyline, chapterCount, etc.).
                const entries = stories.map((meta, i) => makeEntryFromStoryMeta(meta, i));

                setStore((prev) => {
                    // Merge server entries on top of existing records.
                    // Preserve locally-cached data (chapter content, storyline)
                    // for entries that already exist in the store.
                    const prevByStoryId = new Map(prev.records.map((r) => [r.storyId, r]));
                    const merged = entries.map((e) => {
                        const existing = prevByStoryId.get(e.storyId);
                        if (existing) {
                            // Keep the local entry's data (chapters, storyline)
                            // but update metadata from the server (chapterCount
                            // may have changed if generation completed while offline).
                            return {
                                ...e,
                                data: existing.data,
                                storyline: existing.storyline || e.storyline
                            };
                        }
                        return e;
                    });
                    // If no entry is currently selected, try restoring the last
                    // selected storyId from localStorage. Fall back to the first
                    // entry if the saved storyId no longer exists.
                    const lastStoryId = getLastStoryId();
                    const selected = prev.selected
                        ?? (lastStoryId ? merged.find((m) => m.storyId === lastStoryId) ?? merged[0] : merged[0])
                        ?? null;
                    return { ...prev, records: merged, selected };
                });
            })
            .catch((err: Error) => {
                // Surface a non-blocking warning rather than crashing the dashboard —
                // the user can still see cached data from localStorage and Add a
                // story locally and POST (the bootstrap failure shouldn't block
                // the whole UI).
                setStore((prev) => ({ ...prev, loadWarning: err.message }));
                console.warn('[BootstrapLayer] Failed to list existing stories.', err);
            });
        // Intentionally run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
});
