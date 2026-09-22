// Bootstrap layer: fetches the list of all existing stories on mount and seeds
// the store with one entry per story.
//
// Mirrors library/workflow/lightning-agent/components/PersistenceLayer.tsx
// (a hidden component mounted inside <ContextProvider> whose sole job is to
// load existing state into the store on mount — renders nothing).
//
// Cache-first behavior (the store is the display source of truth):
//   0a. On mount, request persistent storage (navigator.storage.persist —
//      best-effort, never throws; the Safari ITP 7-day-eviction mitigation
//      for BOTH cache tiers — see src/context/storyCache.ts).
//   0b. Classify local storage health with a tiny write-probe
//      (classifyStorageTiers): when localStorage cannot accept writes while
//      records worth saving exist (private/incognito mode, storage-disabled
//      WebView), store.storageUnavailableAtBoot is set so the sidebar names
//      the cause ("stories will only last for this visit"). Healthy storage
//      and record-less fresh installs stay unwarned.
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
//      unreachable). When the failure has the deployed mobile shape — an
//      HTTPS page dialing the plain-HTTP API — the browser itself blocked
//      the request (mixed content), and the warning is EXTENDED to name that
//      cause and the two deployment-level remedies (see MIXED_CONTENT_DIAGNOSIS
//      below + isMixedContentBlocked in src/config.ts).
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
import { isMixedContentBlocked } from '../config';
import { classifyStorageTiers, requestPersistentStorage } from '../context/storyCache';
import {
    getLastStoryId,
    loadRecordsFromStorage,
    loadRecordsFromIdbMirror,
    upgradeRecordsFromIdbMirror,
    mergeServerStoryList,
    type StoryEntry
} from '../context/store';

// Mixed-content diagnosis appended to the raw fetch error when the session is
// the deployed mobile shape: an HTTPS page (GitHub Pages) dialing the plain
// HTTP storyboard API. The browser blocks every such request before it leaves
// the page, so the raw "Failed to fetch" alone misleads — without this the
// user cannot tell a down server from a page that can NEVER reach it. The copy
// names the cause and both deployment-level remedies; the app-side fix (serving
// either side over a matching scheme) is out of this layer's control by design.
const MIXED_CONTENT_DIAGNOSIS =
    'this page is served over HTTPS but the story API uses plain HTTP, which the browser blocks as mixed content — open this dashboard over the same http:// network origin instead, or serve the story API over HTTPS';

// Hidden bootstrap layer. Renders nothing; only effects.
export const BootstrapLayer: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();

    // Ref to prevent double-fetch in React StrictMode dev double-mount.
    const didFetchRef = React.useRef(false);

    React.useEffect(() => {
        if (didFetchRef.current) return;
        didFetchRef.current = true;

        // ── Step 0a: ask for persistent storage (Safari ITP mitigation) ──
        // Best-effort and never throwing (see storyCache.ts): a granted
        // navigator.storage.persist() opts this origin out of Safari's
        // 7-day capricious eviction of ALL script-writable storage — both
        // the localStorage quick-cache and the IndexedDB mirror. Called
        // BEFORE any cache work so the very first session already benefits;
        // declined/unsupported requests resolve false silently.
        void requestPersistentStorage();

        // Capture the baseUrl at mount — store.config is captured here, so if
        // the consumer swaps it later the bootstrap only fires once.
        const baseUrl = store.config.baseUrl;

        // ── Step 0b: classify local storage health (write-probe) ─────────
        // A tiny setItem/removeItem pair distinguishes the private-mode /
        // storage-disabled shapes (every write throws; window.localStorage
        // can be null outright in storage-dead WebViews) from a merely empty
        // cache — a successful hydration does NOT prove writability because
        // reads can still work while writes fail (iOS private-mode quota-0).
        // Combined with hasIndexedDB (inside classifyStorageTiers) this is
        // the storage-writable / localStorage-dead / everything-dead
        // classification; only the localStorage leg drives a flag (when
        // everything is dead there is nothing to hydrate anyway), and the
        // sidebar renders the storage-unavailable copy for it.
        const storageWritable = classifyStorageTiers().localStorageWritable;

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
                        ...(cacheWarning !== undefined ? { cacheWarning } : {}),
                        // Boot-time storage classification (step 0b): there
                        // ARE records worth saving but localStorage cannot
                        // accept writes — flag it so the sidebar's chip names
                        // the private-mode/storage-disabled cause instead of
                        // leaving the session's persistence silently dead.
                        // Only reachable with records.length > 0, which is
                        // exactly the "only warn when there is something to
                        // lose" contract; healthy storage never sets it.
                        ...(storageWritable ? {} : { storageUnavailableAtBoot: true })
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
                    //
                    // MIXED-CONTENT DIAGNOSIS: on the deployed mobile shape
                    // (HTTPS page + plain-HTTP API, see ../config.ts) every
                    // request is blocked by the browser itself — the raw
                    // "Failed to fetch" never mentions WHY. Append the cause
                    // and both deployment-level remedies so the warning is
                    // actionable instead of misleading.
                    const message = isMixedContentBlocked(baseUrl)
                        ? `${err.message} — ${MIXED_CONTENT_DIAGNOSIS}`
                        : err.message;
                    setStore((prev) => ({ ...prev, loadWarning: message }));
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
            // holds richer payloads, overlay the restored chapters into the
            // ALREADY-HYDRATED records per storyId.
            //
            // WHY AN OVERLAY (not the old wholesale replace + early return):
            // the old guard `if (prev.records.length > 0) return prev;` made
            // this pass dead code — hydrateAndCheckServer above populates
            // records SYNCHRONOUSLY, so records were always non-empty before
            // this async mirror read resolved, the upgrade never applied, and
            // a reload (especially offline) degraded every quota-shed story to
            // metadata-only (cloud-off icon) even though the mirror still held
            // its chapters (the reported "says it cached, offline reload shows
            // cloud icon" bug).
            //
            // Overlay rules per storyId (see upgradeRecordsFromIdbMirror for
            // how `upgraded` is produced from the mirror):
            //   - current entry has NO data (rung-2 metadata-only shed) and
            //     the mirror holds chapters → restore the mirror's data on
            //     top of the entry's CURRENT metadata (a list sync may have
            //     already merged fresher metadata before this async pass ran).
            //   - current entry is STILL the boot-hydration object and the
            //     mirror has richer revisions (rung-1 trim) → wholesale
            //     upgrade (revision history restored).
            //   - anything else (a fresh fetch/list sync already replaced the
            //     hydrated entry) → leave the current state alone; fresher
            //     data must never be downgraded to the mirror's older copy.
            upgradeRecordsFromIdbMirror(cachedRecords)
                .then((upgraded) => {
                    if (upgraded) {
                        setStore((prev) => {
                            const hydratedById = new Map(cachedRecords.map((e) => [e.storyId, e]));
                            const upgradedByStoryId = new Map(upgraded.map((e) => [e.storyId, e]));
                            let changed = false;
                            const records = prev.records.map((entry) => {
                                const upgradedEntry = upgradedByStoryId.get(entry.storyId);
                                if (!upgradedEntry) return entry;
                                const mirrorData = upgradedEntry.data;
                                if (!mirrorData) return entry;
                                if (!entry.data) {
                                    // Rung-2 metadata-only shed → restore the
                                    // mirror's chapter payload.
                                    changed = true;
                                    const restored: StoryEntry = { ...entry, data: mirrorData };
                                    // Staleness guard: the restored payload
                                    // reflects the mirror write (stamped
                                    // upgradedEntry.lastUpdatedAt). If the
                                    // entry's stamp has since moved PAST it
                                    // (a newer list sync / fetch merged in),
                                    // the restored copy predates a server
                                    // write — flag it stale so the next view
                                    // re-fetches instead of showing the old
                                    // payload as fresh. Equal/unknown stamps
                                    // leave the flag alone.
                                    if (
                                        entry.lastUpdatedAt &&
                                        upgradedEntry.lastUpdatedAt &&
                                        entry.lastUpdatedAt !== upgradedEntry.lastUpdatedAt
                                    ) {
                                        restored.dataStale = true;
                                    }
                                    return restored;
                                }
                                // Still the pure hydration object → the
                                // boot snapshot stands, take the wholesale
                                // upgraded entry (richer revision history).
                                if (hydratedById.get(entry.storyId) === entry) {
                                    changed = true;
                                    return upgradedEntry;
                                }
                                // A newer fetch/sync replaced the entry —
                                // its state beats the mirror copy.
                                return entry;
                            });
                            if (!changed) return prev;
                            // Re-point the selection by storyId — a restored
                            // entry is a new object, the stale reference
                            // would render the pre-restore copy.
                            const selected = prev.selected
                                ? records.find((r) => r.storyId === prev.selected!.storyId) ?? prev.selected
                                : prev.selected;
                            return {
                                ...prev,
                                records,
                                selected,
                                // Surface the restore event to the sidebar's
                                // cache chip (informational; see store.cacheWarning).
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
