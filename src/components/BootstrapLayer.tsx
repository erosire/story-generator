// Bootstrap layer: fetches the list of all existing stories on mount and seeds
// the store with one entry per story.
//
// Mirrors library/workflow/lightning-agent/components/PersistenceLayer.tsx
// (a hidden component mounted inside <ContextProvider> whose sole job is to
// load existing state into the store on mount — renders nothing).
//
// Cache-first behavior (the store is the display source of truth):
//   1. On mount, hydrate from localStorage INSTANTLY so the dashboard appears
//      with cached data (stories + chapter content) even if the server is
//      slow or unreachable.
//   2. Then call fetchStoryList(config.baseUrl) to check the server for
//      updates, and merge via mergeServerStoryList (src/context/store.tsx):
//      server metadata refreshes cached entries, new server stories are
//      added, and cache-only stories are RETAINED (flagged missingFromServer)
//      so they stay visible in the sidebar. The merged records are written
//      back to localStorage by the store's auto-persist effect.
//   3. On fetch error, keep the cached records and set a loadWarning (read
//      by the dashboard header / sidebar so the user can see the backend is
//      unreachable).
//
// Renders null — purely a side-effect component.

import React from 'react';
import { useStoryStore } from '../context';
import { fetchStoryList } from '../api';
import { getLastStoryId, loadRecordsFromStorage, mergeServerStoryList } from '../context/store';

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

        // ── Step 2: Check the server for updates, then update the cache ──
        // Runs in background after localStorage hydration. The merge keeps
        // cached chapter data / storylines, refreshes metadata for known
        // stories, adds stories new on the server, and RETAINS cache-only
        // stories (flagged missingFromServer). The resulting records are
        // written back to localStorage by the store's auto-persist effect.
        fetchStoryList(baseUrl)
            .then(({ stories, jobs }) => {
                setStore((prev) => {
                    // activeJobs is updated in BOTH branches: the `jobs` array
                    // is authoritative on its own (an empty registry answer is
                    // a real answer — the server's in-memory registry blanks on
                    // restart), unlike an empty story list which is treated as
                    // "no information" for the records merge.
                    // Empty server list → mergeServerStoryList returns null:
                    // not a sync signal — keep the cached records untouched.
                    const merged = mergeServerStoryList(prev, stories ?? []);
                    if (!merged) {
                        return {
                            ...prev,
                            activeJobs: jobs ?? [],
                            // Still clear any previous warning — the server answered.
                            loadWarning: undefined
                        };
                    }
                    return {
                        ...prev,
                        records: merged.records,
                        selected: merged.selected,
                        activeJobs: jobs ?? [],
                        // A successful list sync clears the unreachable-server
                        // warning from a previous failure.
                        loadWarning: undefined
                    };
                });
            })
            .catch((err: Error) => {
                // Surface a non-blocking warning rather than crashing the dashboard —
                // the user can still see cached data from localStorage and Add a
                // story locally and POST (the bootstrap failure shouldn't block
                // the whole UI). Cached records are left intact.
                setStore((prev) => ({ ...prev, loadWarning: err.message }));
                console.warn('[BootstrapLayer] Failed to list existing stories.', err);
            });
        // Intentionally run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
});
