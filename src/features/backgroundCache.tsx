// Background cache layer: PROGRESSIVELY fetches story data that is not yet
// cached in this browser, one story at a time, entirely in the background.
//
// WHY: the cache-first contract so far only cached stories the user OPENED
// (the selection catch-up GET in features/content.tsx). Every other synced
// story stayed metadata-only (data === null, cloud-off icon) — offline, the
// sidebar showed titles but no chapters for anything the user never clicked.
// This layer closes that gap: after boot (and after every list sync adds a
// new uncached story), it walks the uncached stories SERIALLY — one GET per
// story, a small stagger between fetches — and merges each landed payload
// into the store, where the records-persist effect caches it. The dashboard
// becomes fully offline-readable over time without the user visiting every
// story.
//
// CANDIDATE RULES — a story is fetched in the background ONLY when ALL hold:
//   - entry.data === null          → nothing cached yet (the exact gap).
//   - !entry.missingFromServer     → the server actually has it (a cache-only
//                                    story cannot be fetched — skip, no 404
//                                    spam).
//   - isRemote || chapterRequested > 0 → fetchable at all (a locally added,
//                                    never-submitted story has no endpoint
//                                    payload yet — same pollable check as
//                                    features/content.tsx).
//   - !isProcessing && !serverProcessing → a live background job is already
//                                    streaming this story's data via the
//                                    job-gated poll loop (content.tsx); a
//                                    parallel background GET would duplicate
//                                    it.
//
// SERIAL + ONE-SHOT-PER-STORY: fetches run strictly one at a time with
// BACKGROUND_FETCH_DELAY_MS between them (progressive, never a burst). A
// story that FAILS (network down, 404, server error) is marked attempted for
// this session and NOT retried by this layer — retrying on every poll tick
// (records change every ~2s while anything generates) would hammer a dead
// story. The story is still fetched on selection (the catch-up GET) and on
// the next page load; a later successful list sync also re-runs this effect,
// but attemptedRef keeps failed stories out of the candidate set.
//
// RACE SAFETY:
//   - inFlightRef — stories whose GET is currently running. The effect
//     re-runs on EVERY records change (including each landed fetch); the
//     in-flight set stops the next run from duplicating a fetch that is
//     still in the air.
//   - per-run `cancelled` flag — an effect re-run stops the PREVIOUS loop
//     from STARTING more fetches (the cleanup flips it), but an in-flight
//     fetch that lands after cancellation is STILL merged: its payload is
//     fresh and valid, discarding it would just re-download it on the next
//     pass.
//   - unmountedRef — no setStore after unmount (React state-on-unmounted
//     guard; mirrors the unmount latch in the store provider).
//
// MERGE SHAPE: identical to the selection catch-up in features/content.tsx
// (data + storyline + missingFromServer=false + static-memory timestamp sync
// + dataStale clear + storyName/title adoption) so a background-fetched story
// and a user-opened story end up in exactly the same store state.
//
// Renders null — purely a side-effect component (same pattern as
// BootstrapLayer). Mounted once in src/App.tsx next to BootstrapLayer.

import React from 'react';
// scriptPause — the @presource/core delay helper (promise-based setTimeout
// wrapper) used for the stagger between background fetches.
import { scriptPause } from '@presource/core';
import { useStoryStore } from '../context';
import { fetchStoryData } from '../api';
import type { StoryEntry } from '../context/store';

// Delay between consecutive background fetches — keeps the progressive fill
// from bursting the server when many stories are uncached at once.
const BACKGROUND_FETCH_DELAY_MS = 400;

export const BackgroundCacheLayer: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const records = store.records;

    // Stories whose background GET is currently in the air — survives across
    // effect re-runs (a ref, not state) so a re-run never duplicates them.
    const inFlightRef = React.useRef<Set<string>>(new Set());
    // Stories this layer already ATTEMPTED and failed this session — excluded
    // from future candidate sets (see the ONE-SHOT-PER-STORY note above).
    const attemptedRef = React.useRef<Set<string>>(new Set());
    // Unmount latch — no setStore after the provider/layer unmounts.
    const unmountedRef = React.useRef(false);
    React.useEffect(
        () => () => {
            unmountedRef.current = true;
        },
        []
    );

    React.useEffect(() => {
        // Per-run cancellation flag: the cleanup (next records change /
        // unmount) flips it so the PREVIOUS loop stops STARTING new fetches.
        // An in-flight fetch that lands after cancellation is still merged —
        // its payload is fresh and valid (see the header note).
        let cancelled = false;

        // Candidate set for THIS pass: uncached, fetchable, not already being
        // fetched (in-flight or attempted-and-failed — see the header notes).
        const candidates = records.filter(
            (entry) =>
                entry.data === null &&
                entry.missingFromServer !== true &&
                !entry.isProcessing &&
                entry.serverProcessing !== true &&
                (entry.isRemote || entry.chapterRequested > 0) &&
                !inFlightRef.current.has(entry.storyId) &&
                !attemptedRef.current.has(entry.storyId)
        );
        if (candidates.length === 0) return;

        const run = async () => {
            for (const entry of candidates) {
                // A newer effect run took over — stop STARTING new fetches.
                if (cancelled) return;
                const storyId = entry.storyId;
                const entryId = entry.id;
                inFlightRef.current.add(storyId);
                try {
                    const result = await fetchStoryData(store.config.baseUrl, storyId);
                    // Not a usable payload (404 / malformed / network error):
                    // mark attempted so this pass and later re-runs skip it —
                    // no retry storm against a dead story (see header).
                    if (result.status !== 'data' || !Array.isArray(result.data?.chapters)) {
                        attemptedRef.current.add(storyId);
                        continue;
                    }
                    // Merge the landed payload — same shape as the selection
                    // catch-up in features/content.tsx. Deliberately NOT
                    // gated on `cancelled`: a fetch that completes after a
                    // re-run still carries fresh, valid data — merging it is
                    // strictly better than dropping it and re-downloading.
                    if (unmountedRef.current) return;
                    setStore((prev) => {
                        const merge = (e: StoryEntry): StoryEntry =>
                            e.id === entryId
                                ? {
                                      ...e,
                                      data: { chapters: result.data.chapters, meta: result.data.meta },
                                      storyline: result.data.meta?.storyline ?? e.storyline,
                                      // The story provably exists on the server.
                                      missingFromServer: false,
                                      // Static-memory sync: adopt the server's
                                      // fetch-time stamp (meta.lastUpdatedAt =
                                      // the plotpoint.json mtime this payload
                                      // reflects) and clear the stale flag —
                                      // mirrors content.tsx's onData/catch-up.
                                      ...(result.data.meta?.lastUpdatedAt
                                          ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                          : {}),
                                      dataStale: false,
                                      ...(result.data.meta?.storyName
                                          ? { storyName: result.data.meta.storyName, title: result.data.meta.storyName }
                                          : {})
                                  }
                                : e;
                        const nextRecords = prev.records.map(merge);
                        return {
                            ...prev,
                            records: nextRecords,
                            // Keep the selected entry in sync when the
                            // background fetch targeted it (same reference
                            // the rest of the store maintains).
                            selected: prev.selected?.id === entryId
                                ? nextRecords.find((e) => e.id === entryId) ?? prev.selected
                                : prev.selected
                        };
                    });
                } catch {
                    // Network failure — attempted-once (see header); the next
                    // selection or page load retries instead.
                    attemptedRef.current.add(storyId);
                } finally {
                    inFlightRef.current.delete(storyId);
                }
                // Stagger between fetches — progressive, never a burst.
                if (!cancelled) await scriptPause(BACKGROUND_FETCH_DELAY_MS);
            }
        };

        void run();
        // Cancel this loop when the next records change (or unmount) re-runs
        // the effect — the new run recomputes candidates from fresh state.
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [records, store.config.baseUrl]);

    return null;
});
