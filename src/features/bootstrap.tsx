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
//   1b. If localStorage came up EMPTY (iOS Safari private mode wipes it on
//      tab close; Safari ITP evicts 7-day-unused keys; quota churn can drop
//      the key), recover the records from the DURABLE INDEXEDDB MIRROR
//      (storyCacheGet — see src/context/storyCache.ts) and self-heal
//      localStorage with the recovered payload before hydrating.
//   1c. If localStorage HAS records but the mirror is RICHER (the per-story
//      quota ladder shed chapters from a story's localStorage key while the
//      un-shed mirror kept them), UPGRADE the records from the mirror per
//      story (upgradeRecordsFromIdbMirror) before hydrating — cached
//      chapters that were shed come back.
//   2. Then call fetchStoryList(config.baseUrl) to check the server for
//      updates, and merge via mergeServerStoryList (src/context/store.tsx):
//      server metadata refreshes cached entries, new server stories are
//      added, and cache-only stories are RETAINED (flagged missingFromServer)
//      so they stay visible in the sidebar. The merged records are written
//      back to localStorage by the store's auto-persist effect (and mirrored
//      to IndexedDB by saveRecordsToStorage).
//   3. On fetch error, keep the cached records and set a loadWarning (read
//      by the dashboard header / sidebar so the user can see the backend is
//      unreachable).
//
// OFFLINE CONTRACT (the reason this layer exists in this shape): the
// deployment's baseUrl points at a LAN host (src/config.ts —
// LOCAL_AREA_NETWORK_HOST_NAME:5252). Served from an HTTPS origin (GitHub
// Pages) or with the server off, EVERY fetch rejects immediately (mixed
// content / connection refused). In that state this layer's ONLY job is to
// put the localStorage records cache on screen and leave it alone:
//   - The catch path NEVER touches records — only loadWarning.
//   - The sidebar's periodic refresh (features/sidebar.tsx) mirrors this:
//     its catch is silent for the same reason.
// Cached records reach localStorage synchronously the moment a story is
// viewed (saveRecordsToStorage in src/context/store.tsx), so any story that
// was ever loaded from the server is viewable offline forever after.
//
// Renders null — purely a side-effect component. This is a FEATURE (owns the
// bootstrap business logic), moved from the old src/components/BootstrapLayer.

import React from 'react';
import { useStoryStore } from '../context';
import { fetchStoryList } from '../api';
import {
    getLastStoryId,
    loadRecordsFromStorage,
    loadRecordsFromIdbMirror,
    upgradeRecordsFromIdbMirror,
    mergeServerStoryList,
    type StoryEntry
} from '../context/store';

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
        let cachedRecords = loadRecordsFromStorage();

        // ── Step 1c: Upgrade from the IndexedDB mirror when the mirror is
        // RICHER ────────────────────────────────────────────────────────────
        // The per-story localStorage quota ladder sheds weight under quota
        // (a story that no longer fits loses revisions or its whole chapter
        // payload — ONLY that story), but the IndexedDB mirror NEVER sheds —
        // it always holds the full-fidelity payload. After a shed session
        // the mirror holds chapters the localStorage copy lost; this pass
        // restores them per story before hydration. Async, so the hydration
        // + server check are chained after it. When localStorage is EMPTY
        // this is skipped — step 1b's full recovery already returns the
        // un-shed mirror payload.
        const hydrateAndCheckServer = (records: StoryEntry[], cacheWarning?: string) => {
            if (records.length > 0) {
                setStore((prev) => {
                    // Don't overwrite records that were pre-seeded via initialStore
                    // prop (eg. by tests).
                    if (prev.records.length > 0) return prev;

                    const lastStoryId = getLastStoryId();
                    const selected = lastStoryId
                        ? records.find((m) => m.storyId === lastStoryId) ?? records[0]
                        : records[0] ?? null;
                    return {
                        ...prev,
                        records,
                        selected: selected ?? prev.selected,
                        // Surface the recovery/upgrade event to the sidebar's
                        // cache chip (informational, cleared on the next
                        // successful sync by nothing — it is session-scoped
                        // context, so it persists until reload).
                        ...(cacheWarning !== undefined ? { cacheWarning } : {})
                    };
                });
            }

            // ── Step 2: Check the server for updates, then update the cache ──
            // Runs in background after the cache hydration. The merge keeps
            // cached chapter data / storylines, refreshes metadata for known
            // stories, adds stories new on the server, and RETAINS cache-only
            // stories (flagged missingFromServer). The resulting records are
            // written back to localStorage by the store's auto-persist effect
            // (and mirrored to IndexedDB by saveRecordsToStorage).
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
        };

        if (cachedRecords.length === 0) {
            // localStorage empty → try the durable mirror before rendering
            // an empty dashboard. loadRecordsFromIdbMirror also self-heals
            // localStorage with the recovered payload (see store.tsx).
            loadRecordsFromIdbMirror()
                .then((recovered) => {
                    if (recovered && recovered.length > 0) {
                        console.info(
                            `[BootstrapLayer] localStorage cache empty — recovered ${recovered.length} story record(s) from the IndexedDB mirror.`
                        );
                        hydrateAndCheckServer(
                            recovered,
                            'Recovered your stories from local app storage — the browser cache had been cleared.'
                        );
                    } else {
                        hydrateAndCheckServer(cachedRecords);
                    }
                })
                .catch(() => {
                    // Mirror unavailable (no IndexedDB / error) — proceed as
                    // if it returned null.
                    hydrateAndCheckServer(cachedRecords);
                });
        } else {
            // HYDRATE SYNCHRONOUSLY FIRST — the cache-first contract requires
            // the cached stories to paint on the FIRST render, before any
            // async work. The upgrade pass below then enriches them.
            hydrateAndCheckServer(cachedRecords);
            // localStorage has records → try to UPGRADE them from the
            // un-shed mirror (restore shed chapters). Async: when the mirror
            // holds richer payloads, re-hydrate with the upgraded records
            // (the setStore guard only skips when records are ALREADY
            // present, so pass upgraded records directly through a second
            // setStore that replaces the freshly hydrated ones).
            upgradeRecordsFromIdbMirror(cachedRecords)
                .then((upgraded) => {
                    if (upgraded) {
                        setStore((prev) => {
                            if (prev.records.length > 0) return prev;
                            const lastStoryId = getLastStoryId();
                            const selected = lastStoryId
                                ? upgraded.find((m) => m.storyId === lastStoryId) ?? upgraded[0]
                                : upgraded[0] ?? null;
                            return {
                                ...prev,
                                records: upgraded,
                                selected: selected ?? prev.selected,
                                cacheWarning:
                                    'Restored cached chapters from local app storage that the browser cache had shed.'
                            };
                        });
                    }
                })
                .catch(() => {
                    // Mirror unavailable — the synchronous hydration stands.
                });
        }
        // Intentionally run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
});
