// Tests for the story store's client-owned timestamp + static-memory
// staleness plumbing.
//
// lastActionedAt is the sidebar's "last actioned on top" sort key. It is
// CLIENT-OWNED: bumped only by data-mutating user actions (POST/PATCH flows —
// see touchStory in store.tsx; read-only viewing like selection never counts),
// never by server metadata. These tests pin the two non-UI invariants:
//   1. mergeServerStoryList preserves the client-owned timestamp across list
//      syncs (overlay spread) and leaves it undefined for stories new to the
//      client (they fall back to createdDate for sorting).
//   2. loadRecordsFromStorage round-trips the timestamp from the localStorage
//     records cache so the ordering survives page reloads.
//
// lastUpdatedAt/dataStale implement the STATIC MEMORY (browser cache)
// staleness contract: the server reports lastUpdatedDate (plotpoint.json
// mtime) on every list entry; the entry's stored lastUpdatedAt records when
// the cached `data` was fetched. mergeServerStoryList flags dataStale when
// the two differ (cached payload predates a server write) and both the flag
// and the timestamp round-trip through localStorage so a reload while stale
// still refreshes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    loadRecordsFromStorage,
    loadRecordsFromIdbMirror,
    upgradeRecordsFromIdbMirror,
    mergeServerStoryList,
    saveRecordsToStorage,
    didLastSaveFail,
    didLastMirrorWriteFail,
    deriveCacheHealth,
    getLastSaveFailedStoryIds,
    type StoryEntry
} from './store';
import { storyCacheGet, storyCacheSet, storyCacheResetForTests } from './storyCache';

// Minimal valid StoryEntry factory — only the fields merge/persist code and
// types require; tests override the fields they assert on.
const makeEntry = (overrides: Partial<StoryEntry>): StoryEntry => ({
    id: 1,
    storyId: 'story-a',
    title: 'Story A',
    storyline: '',
    chapterRequested: 1,
    chapterCompleted: 0,
    createdDate: '2026-08-01T00:00:00.000Z',
    status: 'generating',
    data: null,
    isProcessing: false,
    error: '',
    isRemote: true,
    ...overrides
});

// Minimal StoryMeta for the server list payload.
const makeMeta = (overrides: Record<string, unknown>) => ({
    storyId: 'story-a',
    chapterRequested: 1,
    chapterCompleted: 0,
    createdDate: '2026-08-01T00:00:00.000Z',
    status: 'generating' as const,
    ...overrides
});

describe('lastActionedAt (user-action timestamp)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('mergeServerStoryList preserves the client-owned timestamp across a server sync', () => {
        const prevRecords = [makeEntry({ storyId: 'story-a', lastActionedAt: '2026-08-05T12:00:00.000Z' })];
        const prev = { records: prevRecords, selected: prevRecords[0] };

        // Server sync refreshes metadata for the same storyId.
        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-a' })]);

        expect(merged).not.toBeNull();
        // The user-action timestamp survives the metadata refresh untouched —
        // the server never reports it and the merge never overwrites it.
        expect(merged!.records[0].lastActionedAt).toBe('2026-08-05T12:00:00.000Z');
        // The re-resolved selection carries it too.
        expect(merged!.selected?.lastActionedAt).toBe('2026-08-05T12:00:00.000Z');
    });

    it('mergeServerStoryList leaves lastActionedAt undefined for stories new to the client', () => {
        const prev = { records: [], selected: null };

        // A story the client has never seen arrives from the server.
        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-new' })]);

        expect(merged).not.toBeNull();
        // No user action has happened in this browser — the field stays
        // undefined and sidebar sorting falls back to createdDate.
        expect(merged!.records[0].lastActionedAt).toBeUndefined();
    });

    it('mergeServerStoryList keeps the timestamp on cache-only (missingFromServer) entries', () => {
        const prevRecords = [
            makeEntry({ storyId: 'story-cached', lastActionedAt: '2026-08-06T08:30:00.000Z' })
        ];
        const prev = { records: prevRecords, selected: null };

        // Server list contains ONLY a different story — story-cached becomes
        // cache-only (missingFromServer) but must keep its timestamp.
        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-server' })]);

        expect(merged).not.toBeNull();
        const cacheOnly = merged!.records.find((r) => r.storyId === 'story-cached');
        expect(cacheOnly?.missingFromServer).toBe(true);
        expect(cacheOnly?.lastActionedAt).toBe('2026-08-06T08:30:00.000Z');
    });

    it('loadRecordsFromStorage round-trips the timestamp from the records cache', () => {
        localStorage.setItem(
            'storyGenerator:records',
            JSON.stringify([
                makeEntry({
                    storyId: 'story-a',
                    lastActionedAt: '2026-08-07T10:00:00.000Z'
                })
            ])
        );

        const records = loadRecordsFromStorage();
        expect(records.length).toBe(1);
        expect(records[0].lastActionedAt).toBe('2026-08-07T10:00:00.000Z');
    });

    it('loadRecordsFromStorage leaves legacy entries without the timestamp undefined', () => {
        // Entry predating the feature — no lastActionedAt key at all.
        localStorage.setItem(
            'storyGenerator:records',
            JSON.stringify([makeEntry({ storyId: 'story-legacy' })])
        );

        const records = loadRecordsFromStorage();
        expect(records.length).toBe(1);
        expect(records[0].lastActionedAt).toBeUndefined();
        // createdDate still hydrates (the sorting fallback) for legacy entries.
        expect(records[0].createdDate).toBe('2026-08-01T00:00:00.000Z');
    });
});

describe('lastUpdatedAt / dataStale (static-memory staleness)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('mergeServerStoryList flags dataStale when the server timestamp moved past the cached fetch', () => {
        // The entry's data was fetched when plotpoint.json's mtime was T1.
        const prevRecords = [makeEntry({ storyId: 'story-a', lastUpdatedAt: '2026-08-01T10:00:00.000Z', data: { chapters: [], meta: null } })];
        const prev = { records: prevRecords, selected: prevRecords[0] };

        // A later list sync reports the server rewrote plotpoint.json at T2 —
        // the cached payload predates that write, so it is stale.
        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-a', lastUpdatedDate: '2026-08-01T11:00:00.000Z' })]);

        expect(merged).not.toBeNull();
        expect(merged!.records[0].dataStale).toBe(true);
        // The entry adopts the server's latest timestamp.
        expect(merged!.records[0].lastUpdatedAt).toBe('2026-08-01T11:00:00.000Z');
    });

    it('mergeServerStoryList clears dataStale when the timestamps agree', () => {
        // The poll loop already fetched data AFTER the last server write, so
        // the entry's stored timestamp matches the server's — the delta is
        // resolved; an earlier stale flag must clear (SectionStoryContent
        // writes lastUpdatedAt=meta.lastUpdatedAt on every fetch).
        const prevRecords = [makeEntry({ storyId: 'story-a', lastUpdatedAt: '2026-08-01T11:00:00.000Z', dataStale: true, data: { chapters: [], meta: null } })];
        const prev = { records: prevRecords, selected: prevRecords[0] };

        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-a', lastUpdatedDate: '2026-08-01T11:00:00.000Z' })]);

        expect(merged).not.toBeNull();
        expect(merged!.records[0].dataStale).toBe(false);
        expect(merged!.records[0].lastUpdatedAt).toBe('2026-08-01T11:00:00.000Z');
    });

    it('mergeServerStoryList never flags stale when either timestamp is unknown', () => {
        // Unknown on the SERVER side: a legacy server predating lastUpdatedDate.
        const prevWithStamp = [makeEntry({ storyId: 'story-a', lastUpdatedAt: '2026-08-01T10:00:00.000Z', data: { chapters: [], meta: null } })];
        const mergedServerUnknown = mergeServerStoryList({ records: prevWithStamp, selected: prevWithStamp[0] }, [makeMeta({ storyId: 'story-a' })]);
        expect(mergedServerUnknown!.records[0].dataStale).toBe(false);

        // Unknown on the CLIENT side: a legacy cache entry never fetched with
        // timestamps. We cannot prove a delta without both values — flagging
        // stale would refetch every sync for every legacy story.
        const prevNoStamp = [makeEntry({ storyId: 'story-b', data: { chapters: [], meta: null } })];
        const mergedClientUnknown = mergeServerStoryList({ records: prevNoStamp, selected: prevNoStamp[0] }, [makeMeta({ storyId: 'story-b', lastUpdatedDate: '2026-08-01T11:00:00.000Z' })]);
        expect(mergedClientUnknown!.records[0].dataStale).toBe(false);
        // The entry still ADOPTS the server's timestamp so future syncs can compare.
        expect(mergedClientUnknown!.records[0].lastUpdatedAt).toBe('2026-08-01T11:00:00.000Z');
    });

    it('mergeServerStoryList records the timestamp for stories new to the client without flagging stale', () => {
        const prev = { records: [], selected: null };

        // New server story: data is null (nothing cached), so nothing can be
        // stale — but the timestamp is tracked from the first sync on.
        const merged = mergeServerStoryList(prev, [makeMeta({ storyId: 'story-new', lastUpdatedDate: '2026-08-02T09:00:00.000Z' })]);

        expect(merged).not.toBeNull();
        expect(merged!.records[0].dataStale).toBe(false);
        expect(merged!.records[0].lastUpdatedAt).toBe('2026-08-02T09:00:00.000Z');
    });

    it('loadRecordsFromStorage round-trips lastUpdatedAt and dataStale from the records cache', () => {
        // A cached payload flagged stale must STILL refresh after a browser
        // restart — both fields persist.
        localStorage.setItem(
            'storyGenerator:records',
            JSON.stringify([
                makeEntry({
                    storyId: 'story-a',
                    lastUpdatedAt: '2026-08-03T12:00:00.000Z',
                    dataStale: true,
                    data: { chapters: [], meta: null }
                })
            ])
        );

        const records = loadRecordsFromStorage();
        expect(records.length).toBe(1);
        expect(records[0].lastUpdatedAt).toBe('2026-08-03T12:00:00.000Z');
        expect(records[0].dataStale).toBe(true);
    });

    it('loadRecordsFromStorage defaults dataStale to false for legacy cache entries', () => {
        // Entry persisted before the feature — no lastUpdatedAt/dataStale keys.
        localStorage.setItem(
            'storyGenerator:records',
            JSON.stringify([makeEntry({ storyId: 'story-legacy' })])
        );

        const records = loadRecordsFromStorage();
        expect(records.length).toBe(1);
        expect(records[0].dataStale).toBe(false);
        expect(records[0].lastUpdatedAt).toBeUndefined();
    });
});

// ── Offline cache durability (saveRecordsToStorage, per-story keys) ────
// The offline-viewing contract: a story fetched from the server must be in
// localStorage the moment it lands in the store, so a later session with the
// server unreachable still shows the full story list and chapter content.
//
// PER-STORY LAYOUT: each story persists to its own key
// ('storyGenerator:story:<storyId>') — a story's background job (generate /
// expand) re-persists every poll tick, and the per-story keying guarantees
// that can never rewrite, shed, or drop ANOTHER story's cached data (the
// old single-blob layout wiped the whole cache when the blob outgrew the
// quota). These tests pin the per-story write, its change detection, the
// per-story quota ladder, the cross-story isolation, and the legacy-blob
// migration.
describe('saveRecordsToStorage (synchronous offline cache, per-story keys)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('writes each story to its own per-story key synchronously', () => {
        const entry = makeEntry({
            storyId: 'offline-story-1',
            data: { chapters: [], meta: null }
        });

        saveRecordsToStorage([entry]);

        const raw = localStorage.getItem('storyGenerator:story:offline-story-1');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed).toEqual({
            id: 1,
            storyId: 'offline-story-1',
            storyName: undefined,
            title: 'Story A',
            storyline: '',
            chapterRequested: 1,
            chapterCompleted: 0,
            createdDate: '2026-08-01T00:00:00.000Z',
            lastActionedAt: undefined,
            lastUpdatedAt: undefined,
            dataStale: undefined,
            status: 'generating',
            data: { chapters: [], meta: null },
            isRemote: true,
            missingFromServer: undefined
        });
    });

    it('skips the write when a story payload is unchanged', () => {
        const entry = makeEntry({ storyId: 'offline-story-1', data: { chapters: [], meta: null } });
        saveRecordsToStorage([entry]);
        const first = localStorage.getItem('storyGenerator:story:offline-story-1');

        // Second call with identical records must not rewrite the value —
        // the raw string stays byte-identical (and no quota churn happens).
        saveRecordsToStorage([entry]);
        expect(localStorage.getItem('storyGenerator:story:offline-story-1')).toBe(first);
    });

    it('rewrites only the changed story key (e.g. newly fetched chapter data)', () => {
        saveRecordsToStorage([makeEntry({ storyId: 'offline-story-1', data: null })]);
        const before = localStorage.getItem('storyGenerator:story:offline-story-1');
        expect(before).not.toContain('Cached Chapter');

        // The user views the story and fresh data lands in the store.
        saveRecordsToStorage([
            makeEntry({
                storyId: 'offline-story-1',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Cached Chapter',
                            plotpoints: ['plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Cached Chapter\n\noffline body', wordCount: 2, generationTimeMs: 100 }]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            })
        ]);

        const after = localStorage.getItem('storyGenerator:story:offline-story-1')!;
        expect(after).not.toBe(before);
        // The fetched chapter content is IN the cache — this is what a later
        // offline session reads via loadRecordsFromStorage.
        expect(after).toContain('offline body');
    });

    it('saving one story never rewrites another story’s cached key', () => {
        // THE per-story isolation regression: story A is mid-generation and
        // streams new chapter data on every poll tick; story B sits finished
        // in the cache. A's progress must not touch B's key (with the old
        // single-blob layout every tick rewrote the WHOLE cache).
        const storyA = makeEntry({ id: 1, storyId: 'progress-a', data: { chapters: [], meta: null } });
        const storyB = makeEntry({
            id: 2,
            storyId: 'progress-b',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Finished Chapter',
                        plotpoints: ['plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Finished Chapter\n\nfinished body', wordCount: 2, generationTimeMs: 100 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });

        saveRecordsToStorage([storyA, storyB]);
        const bBefore = localStorage.getItem('storyGenerator:story:progress-b');
        const aBefore = localStorage.getItem('storyGenerator:story:progress-a');

        // A's job lands new chapter data — a save triggered by A's progress.
        saveRecordsToStorage([
            {
                ...storyA,
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Streaming Chapter',
                            plotpoints: ['plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Streaming Chapter\n\nstreaming body', wordCount: 2, generationTimeMs: 100 }]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            },
            storyB
        ]);

        // A's key changed; B's key is byte-for-byte UNTOUCHED.
        expect(localStorage.getItem('storyGenerator:story:progress-a')).not.toBe(aBefore);
        expect(localStorage.getItem('storyGenerator:story:progress-b')).toBe(bBefore);
    });

    it('sheds ONLY the oversized story to metadata-only; other stories keep full data', () => {
        // REGRESSION for the reported bug ("story generating ⇒ every other
        // story's cache cleared"): the old single-blob quota ladder nulled
        // OTHER entries' data when the blob exceeded the quota. Per story,
        // the shed can only ever hit the story that caused the write.
        //
        // Simulated quota: setItem throws for payloads > 2000 chars. story-big
        // carries two 2500-char revisions (full AND latest-only both exceed
        // the limit → it sheds to metadata-only); story-small's key is tiny
        // and must keep its full chapter data.
        const QUOTA_LIMIT = 2000;
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (String(value).length > QUOTA_LIMIT) {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                // Under quota → real write (explicit passthrough — the mock
                // fully replaces the method, it does not call through).
                return originalSetItem.call(this, key, value);
            });

        const bigEntry = makeEntry({
            id: 1,
            storyId: 'story-big',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Big Chapter',
                        plotpoints: ['p'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [
                            { content: 'x'.repeat(2500) + ' old', wordCount: 1, generationTimeMs: 1 },
                            { content: 'x'.repeat(2500) + ' latest', wordCount: 1, generationTimeMs: 2 }
                        ]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });
        const smallEntry = makeEntry({
            id: 2,
            storyId: 'story-small',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Small Chapter',
                        plotpoints: ['p'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: 'small body', wordCount: 2, generationTimeMs: 1 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });

        saveRecordsToStorage([bigEntry, smallEntry]);

        // Both stories survive (the LIST always persists offline).
        expect(localStorage.getItem('storyGenerator:story:story-big')).not.toBeNull();
        expect(localStorage.getItem('storyGenerator:story:story-small')).not.toBeNull();

        // The oversized story shed to metadata-only (rung 3).
        const big = JSON.parse(localStorage.getItem('storyGenerator:story:story-big')!) as StoryEntry;
        expect(big.data).toBeNull();

        // The small story kept its FULL data — it was never touched by the
        // other story's quota failure.
        const small = JSON.parse(localStorage.getItem('storyGenerator:story:story-small')!) as StoryEntry;
        expect(small.data!.chapters[0].revisions).toEqual([
            { content: 'small body', wordCount: 2, generationTimeMs: 1 }
        ]);

        setItem.mockRestore();
    });

    // Shared fixture for the make-room tests: two identically-shaped stories
    // with big chapter payloads (two padded revisions each). Sizes below are
    // MEASURED from the exact JSON the store writes (toPersistable output ==
    // the entry minus its transient fields — JSON.stringify drops undefined),
    // so the origin-wide quota mock's thresholds are exact, not guessed.
    const bigChapters = (pad: string) => ({
        chapters: [
            {
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'Ch',
                plotpoints: ['p'],
                expanded: true,
                canReExpand: true,
                revisions: [
                    { content: pad + ' old', wordCount: 3, generationTimeMs: 1 },
                    { content: pad + ' latest', wordCount: 3, generationTimeMs: 2 }
                ]
            }
        ],
        meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
    });
    const trimmedChapters = (d: { chapters: Array<{ revisions: Array<unknown> }> }) => ({
        ...d,
        chapters: [{ ...d.chapters[0], revisions: [d.chapters[0].revisions[d.chapters[0].revisions.length - 1]] }]
    });
    // Size of the exact JSON a shed rung writes for `entry` with `data`
    // (toPersistable drops the transient fields — JSON.stringify drops
    // undefined — so this matches the store's serialized output exactly).
    const persistedSize = (e: StoryEntry, data: unknown): number =>
        JSON.stringify({ ...e, data, isProcessing: undefined, error: undefined, serverProcessing: undefined })
            .length;
    // Origin-wide quota mock: setItem throws when the TOTAL size of all
    // tracked keys would exceed the limit (how the browser's ~5MB per-origin
    // budget actually behaves — unlike the per-value mocks above).
    const installOriginQuotaMock = (quotaLimit: number) => {
        const sizes = new Map<string, number>();
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const originalRemoveItem = storageProto.removeItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                let projected = String(value).length;
                sizes.forEach((size, k) => {
                    if (k !== key) projected += size;
                });
                if (projected > quotaLimit) {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                originalSetItem.call(this, key, value);
                sizes.set(key, String(value).length);
            });
        const removeItem = vi
            .spyOn(storageProto, 'removeItem')
            .mockImplementation(function (this: Storage, key: string) {
                sizes.delete(key);
                originalRemoveItem.call(this, key);
            });
        return {
            restore: () => {
                setItem.mockRestore();
                removeItem.mockRestore();
            }
        };
    };

    it('makes room for a story the full cache cannot fit by shedding the oldest story one rung', () => {
        // REGRESSION for the "cache write failed" report: pass 1 sheds only
        // the story that caused the write — but the quota is ORIGIN-WIDE, so
        // once the other cached stories fill the budget a growing story
        // fails ALL of its own rungs (even metadata-only) and every tile
        // flipped to "cache write failed". Pass 2 must reclaim space from
        // the OLDEST cached story — one rung at a time (trim revision
        // history BEFORE dropping content) — until the story fits.
        const ancient = makeEntry({
            id: 1,
            storyId: 'shed-old-1',
            title: 'Shed Old',
            createdDate: '2026-08-01T00:00:00.000Z',
            data: bigChapters('x'.repeat(400))
        });
        const active = makeEntry({
            id: 2,
            storyId: 'shed-new-1',
            title: 'Shed New',
            createdDate: '2026-08-02T00:00:00.000Z',
            data: bigChapters('y'.repeat(400))
        });

        // F/T/M = the full / trimmed / metadata-only payload sizes of one
        // story (identical fixtures → identical sizes). The quota admits the
        // FIRST story's full payload but NONE of the second story's rungs
        // while the first is full — and after the first sheds to trimmed,
        // only the second's metadata-only rung fits:
        //   pass 1:      F ≤ LIMIT ✓;  F+F, F+T, F+M > LIMIT → active fails
        //   make-room:   shed ancient to T; retry: T+F, T+T > LIMIT,
        //                T+M ≤ LIMIT → active saves metadata-only.
        // LIMIT = F + 100 satisfies every inequality with ≥100 chars of
        // margin (base payload ≈ 300 chars, one padded revision ≈ 445).
        const fullSize = persistedSize(active, active.data);
        const QUOTA_LIMIT = fullSize + 100;
        const mock = installOriginQuotaMock(QUOTA_LIMIT);
        // try/finally: a failed assertion must not leak the quota mock into
        // subsequent tests (a stale sizes map would make every later
        // localStorage write throw and cascade failures).
        try {
            saveRecordsToStorage([ancient, active]);

            // The active story WAS saved — at its metadata-only rung (the
            // ladder's floor). NOT a cache-write failure.
            const savedActive = JSON.parse(
                localStorage.getItem('storyGenerator:story:shed-new-1')!
            ) as StoryEntry;
            expect(savedActive.data).toBeNull();

            // The oldest story degraded EXACTLY ONE rung to make room:
            // revision history trimmed, chapter content KEPT (never nulled
            // outright).
            const savedOld = JSON.parse(
                localStorage.getItem('storyGenerator:story:shed-old-1')!
            ) as StoryEntry;
            expect(savedOld.data).not.toBeNull();
            expect(savedOld.data!.chapters[0].revisions).toEqual([
                { content: 'x'.repeat(400) + ' latest', wordCount: 3, generationTimeMs: 2 }
            ]);

            // A metadata-only save is a successful save — no write-failed
            // state.
            expect(didLastSaveFail()).toBe(false);

            // Re-saving the SAME (unchanged) store entries must not re-bloat
            // the shed story's key back to full fidelity: the fingerprint
            // skip recognizes both stories as already-cached-unchanged and
            // keeps the shed (trimmed) state on disk. The shed state
            // persists until the next boot's mirror upgrade pass restores
            // it, not on every poll tick.
            const oldKeyAfterShed = localStorage.getItem('storyGenerator:story:shed-old-1');
            const activeKeyAfterShed = localStorage.getItem('storyGenerator:story:shed-new-1');
            saveRecordsToStorage([ancient, active]);
            expect(localStorage.getItem('storyGenerator:story:shed-old-1')).toBe(oldKeyAfterShed);
            expect(localStorage.getItem('storyGenerator:story:shed-new-1')).toBe(activeKeyAfterShed);
        } finally {
            mock.restore();
        }
    });

    it('flags the write failure only after every shedable story was exhausted', () => {
        // Same quota as the make-room test, but the active story's key can
        // NEVER accept a write (simulating storage that is truly full /
        // unavailable for this story). The make-room pass must still run to
        // exhaustion — the oldest story sheds trim → metadata-only — and
        // only THEN is lastSaveFailed set.
        const ancient = makeEntry({
            id: 1,
            storyId: 'shed-old-2',
            title: 'Shed Old',
            createdDate: '2026-08-01T00:00:00.000Z',
            data: bigChapters('x'.repeat(400))
        });
        const active = makeEntry({
            id: 2,
            storyId: 'hopeless-1',
            title: 'Shed New',
            createdDate: '2026-08-02T00:00:00.000Z',
            data: bigChapters('y'.repeat(400))
        });

        const fullSize = persistedSize(active, active.data);
        const QUOTA_LIMIT = fullSize + 100;
        const sizes = new Map<string, number>();
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                // This story's key is unwritable no matter the payload.
                if (key === 'storyGenerator:story:hopeless-1') {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                let projected = String(value).length;
                sizes.forEach((size, k) => {
                    if (k !== key) projected += size;
                });
                if (projected > QUOTA_LIMIT) {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                originalSetItem.call(this, key, value);
                sizes.set(key, String(value).length);
            });

        // try/finally (see the make-room test above — a failed assertion
        // must not leak the quota mock into subsequent tests).
        try {
            saveRecordsToStorage([ancient, active]);

            // The shedable story was degraded ALL the way to metadata-only
            // (the pass cycles until no shed headroom remains)...
            const savedOld = JSON.parse(
                localStorage.getItem('storyGenerator:story:shed-old-2')!
            ) as StoryEntry;
            expect(savedOld.data).toBeNull();
            // ...the hopeless story was never written (its key does not
            // exist)...
            expect(localStorage.getItem('storyGenerator:story:hopeless-1')).toBeNull();
            // ...and only then the write-failure state is flagged.
            expect(didLastSaveFail()).toBe(true);
            expect(getLastSaveFailedStoryIds()).toEqual(['hopeless-1']);
            expect(getLastSaveFailedStoryIds()).not.toContain('shed-old-2');
        } finally {
            setItem.mockRestore();
        }
    });

    it('engages the intermediate rung: trims revisions before dropping chapter content', () => {
        // Per-story ladder ordering: full fidelity → latest-revision-only →
        // metadata-only. One story with two 400-char revisions: the FULL
        // payload exceeds QUOTA_LIMIT (1000) but the trimmed payload fits —
        // rung 2 must engage, keeping the chapter body with its LATEST
        // revision (the dropdown's default selection) instead of dropping
        // the data outright.
        const QUOTA_LIMIT = 1000;
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (String(value).length > QUOTA_LIMIT) {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                return originalSetItem.call(this, key, value);
            });

        saveRecordsToStorage([
            makeEntry({
                id: 1,
                storyId: 'story-rungs',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Rung Chapter',
                            plotpoints: ['p'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [
                                { content: 'x'.repeat(400) + ' old', wordCount: 1, generationTimeMs: 1 },
                                { content: 'x'.repeat(400) + ' latest', wordCount: 1, generationTimeMs: 2 }
                            ]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            })
        ]);

        const parsed = JSON.parse(localStorage.getItem('storyGenerator:story:story-rungs')!) as StoryEntry;
        // Rung 2 engaged, NOT rung 3: the data survives with only the LATEST
        // revision (the older revision was shed).
        expect(parsed.data).not.toBeNull();
        expect(parsed.data!.chapters[0].revisions).toEqual([
            { content: 'x'.repeat(400) + ' latest', wordCount: 1, generationTimeMs: 2 }
        ]);

        setItem.mockRestore();
    });

    it('skips unchanged stories entirely — no rewrite when the updated timestamp is unchanged', () => {
        // The optimization contract: a story that is already cached and
        // whose updated timestamp (and every other persisted field) is
        // unchanged IS the cache — the save must not re-serialize its
        // multi-MB chapter payload and must not write its key again. The
        // second save below passes a DEEP-EQUAL but distinct copy (new
        // object identities, as a poll merge would produce) — the
        // fingerprint skip must treat it as unchanged.
        const chapters = [
            {
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'Skip Chapter',
                plotpoints: ['plot'],
                expanded: true,
                canReExpand: true,
                revisions: [{ content: '## Skip Chapter\n\nskip body', wordCount: 3, generationTimeMs: 100 }]
            }
        ];
        const entry = makeEntry({
            storyId: 'skip-1',
            lastUpdatedAt: '2026-08-15T10:00:00.000Z',
            data: { chapters, meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-15T10:00:00.000Z' } }
        });

        saveRecordsToStorage([entry]);
        const written = localStorage.getItem('storyGenerator:story:skip-1');
        expect(written).not.toBeNull();

        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const setItem = vi.spyOn(storageProto, 'setItem');
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            // Same state, fresh object identities (what every poll merge /
            // list sync produces for an untouched story).
            saveRecordsToStorage([
                makeEntry({
                    storyId: 'skip-1',
                    lastUpdatedAt: '2026-08-15T10:00:00.000Z',
                    data: {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'Skip Chapter',
                                plotpoints: ['plot'],
                                expanded: true,
                                canReExpand: true,
                                revisions: [{ content: '## Skip Chapter\n\nskip body', wordCount: 3, generationTimeMs: 100 }]
                            }
                        ],
                        meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-15T10:00:00.000Z' }
                    }
                })
            ]);

            // No write for the unchanged story…
            const keyWrites = setItem.mock.calls.filter(([key]) => key === 'storyGenerator:story:skip-1');
            expect(keyWrites).toEqual([]);
            // …and no multi-MB re-serialization either — the whole point of
            // the fingerprint skip (the exact-compare fallback would still
            // have paid the JSON.stringify of the full payload).
            const bigSerializations = stringify.mock.calls.filter(([value]) =>
                String(value).includes('skip body')
            );
            expect(bigSerializations).toEqual([]);
            // The cached payload is untouched.
            expect(localStorage.getItem('storyGenerator:story:skip-1')).toBe(written);

            // A CHANGED updated timestamp repaints the key (fingerprint miss
            // → the full write path runs).
            saveRecordsToStorage([
                makeEntry({
                    storyId: 'skip-1',
                    lastUpdatedAt: '2026-08-15T11:00:00.000Z',
                    data: {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'Skip Chapter',
                                plotpoints: ['plot'],
                                expanded: true,
                                canReExpand: true,
                                revisions: [{ content: '## Skip Chapter\n\nskip body', wordCount: 3, generationTimeMs: 100 }]
                            }
                        ],
                        meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-15T10:00:00.000Z' }
                    }
                })
            ]);
            expect(
                setItem.mock.calls.filter(([key]) => key === 'storyGenerator:story:skip-1').length
            ).toBe(1);
            expect(localStorage.getItem('storyGenerator:story:skip-1')).toContain(
                '"lastUpdatedAt":"2026-08-15T11:00:00.000Z"'
            );
        } finally {
            stringify.mockRestore();
            setItem.mockRestore();
        }
    });

    it('purges per-story keys of stories removed from the records list', () => {
        // Deleting a story removes it from `records`; the next save must
        // purge its cache key so it cannot resurrect after a reload.
        const storyA = makeEntry({ id: 1, storyId: 'purge-a' });
        const storyB = makeEntry({ id: 2, storyId: 'purge-b' });
        saveRecordsToStorage([storyA, storyB]);
        expect(localStorage.getItem('storyGenerator:story:purge-b')).not.toBeNull();

        saveRecordsToStorage([storyA]);
        expect(localStorage.getItem('storyGenerator:story:purge-a')).not.toBeNull();
        expect(localStorage.getItem('storyGenerator:story:purge-b')).toBeNull();
    });

    it('migrates the legacy single-blob records key into per-story keys on load', () => {
        // A cache persisted before the per-story layout: one 'records' blob
        // holding the whole array. The first load re-keys it per story and
        // removes the superseded blob.
        const legacyEntry = makeEntry({ id: 7, storyId: 'legacy-1', data: { chapters: [], meta: null } });
        localStorage.setItem('storyGenerator:records', JSON.stringify([legacyEntry]));

        const records = loadRecordsFromStorage();
        expect(records.length).toBe(1);
        expect(records[0].storyId).toBe('legacy-1');

        // Migration happened: per-story key written, legacy blob removed.
        expect(localStorage.getItem('storyGenerator:story:legacy-1')).not.toBeNull();
        expect(localStorage.getItem('storyGenerator:records')).toBeNull();

        // A subsequent load reads from the per-story key (no re-migration).
        expect(loadRecordsFromStorage().length).toBe(1);
    });

    it('migrates a legacy blob near quota without requiring old and new copies to coexist', () => {
        const legacyEntry = {
            id: 8,
            storyId: 'legacy-near-quota',
            title: 'Legacy Near Quota',
            storyline: 'quota migration',
            chapterRequested: 1,
            chapterCompleted: 1,
            createdDate: '2026-08-01T00:00:00.000Z',
            dataStale: false,
            status: 'completed' as const,
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Quota Chapter',
                        plotpoints: ['plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [
                            { content: `## Quota Chapter\n\n${'x'.repeat(600)}`, wordCount: 1, generationTimeMs: 1 }
                        ]
                    }
                ],
                meta: { storyline: 'quota migration', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            },
            isRemote: true,
            missingFromServer: false
        };
        const legacyRaw = JSON.stringify([legacyEntry]);
        // The blob fits exactly. A duplicate per-story value cannot coexist
        // with it, but that same value fits once the blob allocation is freed.
        const mock = installOriginQuotaMock(legacyRaw.length);
        try {
            localStorage.setItem('storyGenerator:records', legacyRaw);

            const records = loadRecordsFromStorage();

            expect(records.map((entry) => entry.storyId)).toEqual(['legacy-near-quota']);
            expect(records[0].data!.chapters[0].revisions![0].content).toContain('x'.repeat(100));
            expect(localStorage.getItem('storyGenerator:records')).toBeNull();
            expect(localStorage.getItem('storyGenerator:story:legacy-near-quota')).toContain('Quota Chapter');
        } finally {
            mock.restore();
        }
    });

    it('unions a partial migration and preserves the richer copy for duplicate story IDs', () => {
        const legacyRich = makeEntry({
            id: 11,
            storyId: 'partial-legacy-rich',
            title: 'Legacy title',
            data: bigChapters('legacy-rich')
        });
        const currentMetadata = makeEntry({
            id: 12,
            storyId: 'partial-legacy-rich',
            title: 'Current metadata title',
            data: null
        });
        const currentRich = makeEntry({
            id: 13,
            storyId: 'partial-current-rich',
            title: 'Current rich title',
            data: bigChapters('current-rich')
        });
        const currentOnly = makeEntry({ id: 14, storyId: 'partial-current-only', title: 'Current only' });
        const legacyOnly = makeEntry({ id: 15, storyId: 'partial-legacy-only', title: 'Legacy only' });

        localStorage.setItem(
            'storyGenerator:story:partial-legacy-rich',
            JSON.stringify(currentMetadata)
        );
        localStorage.setItem(
            'storyGenerator:story:partial-current-rich',
            JSON.stringify(currentRich)
        );
        localStorage.setItem(
            'storyGenerator:story:partial-current-only',
            JSON.stringify(currentOnly)
        );
        localStorage.setItem(
            'storyGenerator:records',
            JSON.stringify([
                legacyRich,
                makeEntry({ storyId: 'partial-current-rich', title: 'Legacy metadata', data: null }),
                legacyOnly
            ])
        );

        const records = loadRecordsFromStorage();
        expect(new Set(records.map((entry) => entry.storyId))).toEqual(
            new Set([
                'partial-legacy-rich',
                'partial-current-rich',
                'partial-current-only',
                'partial-legacy-only'
            ])
        );

        const upgraded = records.find((entry) => entry.storyId === 'partial-legacy-rich')!;
        expect(upgraded.title).toBe('Current metadata title');
        expect(upgraded.data!.chapters[0].revisions).toHaveLength(2);
        expect(upgraded.data!.chapters[0].revisions![0].content).toContain('legacy-rich');

        const retained = records.find((entry) => entry.storyId === 'partial-current-rich')!;
        expect(retained.title).toBe('Current rich title');
        expect(retained.data!.chapters[0].revisions![0].content).toContain('current-rich');
        expect(records.find((entry) => entry.storyId === 'partial-legacy-only')).toBeDefined();

        expect(localStorage.getItem('storyGenerator:records')).toBeNull();
        expect(localStorage.getItem('storyGenerator:story:partial-legacy-only')).not.toBeNull();
    });

    it('retains a legacy-only record when conversion of that story key fails', () => {
        const converted = makeEntry({ id: 16, storyId: 'legacy-converted', title: 'Converted' });
        const unresolved = makeEntry({ id: 17, storyId: 'legacy-unresolved', title: 'Unresolved' });
        localStorage.setItem('storyGenerator:records', JSON.stringify([converted, unresolved]));

        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (key === 'storyGenerator:story:legacy-unresolved') {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                return originalSetItem.call(this, key, value);
            });
        try {
            const firstLoad = loadRecordsFromStorage();
            expect(new Set(firstLoad.map((entry) => entry.storyId))).toEqual(
                new Set(['legacy-converted', 'legacy-unresolved'])
            );
            expect(localStorage.getItem('storyGenerator:story:legacy-converted')).not.toBeNull();
            expect(localStorage.getItem('storyGenerator:story:legacy-unresolved')).toBeNull();

            const residual = JSON.parse(localStorage.getItem('storyGenerator:records')!) as StoryEntry[];
            expect(residual.map((entry) => entry.storyId)).toEqual(['legacy-unresolved']);

            // A later boot must still union the successful key with the
            // residual blob; the failed story can never become hidden merely
            // because at least one per-story key exists.
            expect(new Set(loadRecordsFromStorage().map((entry) => entry.storyId))).toEqual(
                new Set(['legacy-converted', 'legacy-unresolved'])
            );
        } finally {
            setItem.mockRestore();
        }
    });

    it('removes a stale legacy allocation before an ordinary new-story save', () => {
        const staleRaw = JSON.stringify([
            makeEntry({
                id: 20,
                storyId: 'stale-legacy-story',
                data: bigChapters('z'.repeat(700))
            })
        ]);
        const fresh = makeEntry({ id: 21, storyId: 'fresh-after-legacy', data: { chapters: [], meta: null } });
        const mock = installOriginQuotaMock(staleRaw.length);
        try {
            localStorage.setItem('storyGenerator:records', staleRaw);

            saveRecordsToStorage([fresh]);

            expect(localStorage.getItem('storyGenerator:records')).toBeNull();
            expect(localStorage.getItem('storyGenerator:story:fresh-after-legacy')).not.toBeNull();
            expect(didLastSaveFail()).toBe(false);
            expect(getLastSaveFailedStoryIds()).toEqual([]);
        } finally {
            mock.restore();
        }
    });

    it('gives up silently when storage is entirely unavailable', () => {
        // All rungs fail (e.g. storage disabled / private mode edge) —
        // the call must not throw (the in-memory store keeps working).
        // Spy on the prototype ABOVE the instance (jsdom quirk — see the
        // quota test above). The getItem spy is the load-bearing one here:
        // saveSingleStoryToStorage reads the current value BEFORE writing,
        // so a failing getItem short-circuits the write path entirely (the
        // catch swallows it) — the contract under test is "never throws".
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });
        const getItem = vi.spyOn(storageProto, 'getItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });

        expect(() => saveRecordsToStorage([makeEntry({ storyId: 'offline-story-1' })])).not.toThrow();
        expect(getItem).toHaveBeenCalled();

        getItem.mockRestore();
        setItem.mockRestore();

        // ── Private-mode quota-0 shape (the mobile iOS Safari failure) ──
        // Reads still work; EVERY write throws QuotaExceededError. This is
        // the shape the mobile report came from: every rung of every story
        // fails, so the rung ladder must flag EVERY story (the in-memory
        // store keeps the session alive) and the failure must be observable
        // (didLastSaveFail + the scoped ID list → the sidebar's warning
        // tile state) — never a crash, never a silent "Cached locally".
        const quotaSetItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        });
        try {
            const entries = [
                makeEntry({ id: 1, storyId: 'private-1', data: { chapters: [], meta: null } }),
                makeEntry({ id: 2, storyId: 'private-2', data: { chapters: [], meta: null } })
            ];
            expect(() => saveRecordsToStorage(entries)).not.toThrow();
            expect(didLastSaveFail()).toBe(true);
            // Failed IDs contain EVERY story — nothing was persisted.
            expect(getLastSaveFailedStoryIds()).toEqual(['private-1', 'private-2']);
        } finally {
            quotaSetItem.mockRestore();
        }
    });
});

// ── IndexedDB durable mirror (the mobile-survival tier) ─────────────────
// localStorage alone does not survive iOS Safari private mode (wiped on tab
// close, setItem throws) or ITP 7-day eviction. saveRecordsToStorage mirrors
// every winning payload into IndexedDB (see src/context/storyCache.ts), and
// loadRecordsFromIdbMirror recovers it when localStorage boots empty. These
// tests run against fake-indexeddb (setupFiles) — real module code paths.
describe('IndexedDB mirror (saveRecordsToStorage / loadRecordsFromIdbMirror)', () => {
    beforeEach(async () => {
        localStorage.clear();
        await storyCacheResetForTests();
    });

    it('mirrors the written records payload into IndexedDB', async () => {
        const entry = makeEntry({
            storyId: 'mirror-1',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Mirrored Chapter',
                        plotpoints: ['plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Mirrored Chapter\n\nmirrored body', wordCount: 2, generationTimeMs: 100 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });

        saveRecordsToStorage([entry]);

        // The mirror is fire-and-forget — wait for the put to complete.
        await vi.waitFor(async () => {
            const mirrored = await storyCacheGet();
            expect(mirrored).not.toBeNull();
        });
        const mirrored = (await storyCacheGet())!;
        expect(mirrored.length).toBe(1);
        expect(mirrored[0].storyId).toBe('mirror-1');
        // Full content survives the mirror (structured clone of the FULL
        // payload — the mirror never sheds, same shape the localStorage cache
        // holds when it fits).
        expect(mirrored[0].data!.chapters[0].revisions).toEqual([
            { content: '## Mirrored Chapter\n\nmirrored body', wordCount: 2, generationTimeMs: 100 }
        ]);
    });

    it('mirrors the FULL-fidelity payload even when localStorage had to shed (mirror is richer)', async () => {
        // Quota simulation: setItem throws for payloads > 2100 chars. The
        // MIRROR must always carry the UNSHED full payload — it is the
        // recovery source for upgradeRecordsFromIdbMirror at the next boot,
        // regardless of which per-story rung localStorage had to accept.
        const QUOTA_LIMIT = 2100;
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const originalSetItem = storageProto.setItem;
        const setItem = vi
            .spyOn(storageProto, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (String(value).length > QUOTA_LIMIT) {
                    throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                }
                return originalSetItem.call(this, key, value);
            });

        // Same fixture as the ladder-engagement test (newest-first ordering).
        const entries = [
            makeEntry({
                id: 2,
                storyId: 'mirror-new',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'New Chapter',
                            plotpoints: ['p'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [
                                { content: 'y'.repeat(300) + ' old', wordCount: 4, generationTimeMs: 1 },
                                { content: 'y'.repeat(300) + ' latest', wordCount: 4, generationTimeMs: 2 }
                            ]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-02T00:00:00.000Z' }
                }
            }),
            makeEntry({
                id: 1,
                storyId: 'mirror-old',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Old Chapter',
                            plotpoints: ['p'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [
                                { content: 'x'.repeat(300) + ' old', wordCount: 3, generationTimeMs: 1 },
                                { content: 'x'.repeat(300) + ' latest', wordCount: 3, generationTimeMs: 2 }
                            ]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            })
        ];

        saveRecordsToStorage(entries);

        await vi.waitFor(async () => {
            const mirrored = await storyCacheGet();
            expect(mirrored).not.toBeNull();
        });
        const mirrored = (await storyCacheGet())!;
        expect(mirrored.length).toBe(2);
        // The mirror holds BOTH entries at FULL fidelity (every revision) —
        // the durable tier never sheds, whatever localStorage had to do.
        expect(mirrored[0].data!.chapters[0].revisions).toEqual([
            { content: 'y'.repeat(300) + ' old', wordCount: 4, generationTimeMs: 1 },
            { content: 'y'.repeat(300) + ' latest', wordCount: 4, generationTimeMs: 2 }
        ]);
        expect(mirrored[1].data!.chapters[0].revisions).toEqual([
            { content: 'x'.repeat(300) + ' old', wordCount: 3, generationTimeMs: 1 },
            { content: 'x'.repeat(300) + ' latest', wordCount: 3, generationTimeMs: 2 }
        ]);

        setItem.mockRestore();
    });

    it('mirrors the FULL payload when localStorage is entirely unavailable (private mode)', async () => {
        // iOS Safari private mode: EVERY localStorage write throws. The
        // fallback path mirrors the full-fidelity payload to IndexedDB (no
        // shedding needed — IndexedDB quotas are huge) so the next session
        // can recover the complete cache.
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });
        const getItem = vi.spyOn(storageProto, 'getItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });

        const entry = makeEntry({
            storyId: 'private-mode-1',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Private Chapter',
                        plotpoints: ['plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Private Chapter\n\nprivate body', wordCount: 2, generationTimeMs: 100 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });

        expect(() => saveRecordsToStorage([entry])).not.toThrow();

        await vi.waitFor(async () => {
            const mirrored = await storyCacheGet();
            expect(mirrored).not.toBeNull();
        });
        const mirrored = (await storyCacheGet())!;
        expect(mirrored.length).toBe(1);
        expect(mirrored[0].storyId).toBe('private-mode-1');
        expect(mirrored[0].data!.chapters[0].revisions).toEqual([
            { content: '## Private Chapter\n\nprivate body', wordCount: 2, generationTimeMs: 100 }
        ]);

        getItem.mockRestore();
        setItem.mockRestore();
    });

    // ── Mirror-failure surfacing (the silent-failure regression) ─────────
    // The fire-and-forget storyCacheSet in saveRecordsToStorage used to log
    // a failed mirror write and move on: on mobile the mirror is the
    // SURVIVOR tier, so a both-tiers-dead device (localStorage unavailable
    // AND the mirror failed — private mode / storage-dead WebView) kept
    // showing the hedged "durable local app storage may still be available"
    // copy while NOTHING durable held the records. The outcome is now
    // recorded (didLastMirrorWriteFail) and observable (deriveCacheHealth →
    // store.cacheMirrorWriteFailed in the provider's persist effect).
    it('surfaces a mirror failure alongside the localStorage failure (both tiers dead)', async () => {
        // localStorage tier: private-mode quota-0 — reads work, writes throw.
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        });
        // Mirror tier: IndexedDB unavailable (storage-dead WebView shape).
        vi.stubGlobal('indexedDB', undefined);
        try {
            const entry = makeEntry({ storyId: 'both-dead-1', data: { chapters: [], meta: null } });
            expect(() => saveRecordsToStorage([entry])).not.toThrow();

            // The mirror write settles asynchronously — wait for the outcome.
            await vi.waitFor(() => {
                expect(didLastMirrorWriteFail()).toBe(true);
            });
            // BOTH tiers are observable as dead in one health snapshot —
            // the state the sidebar escalates its copy from.
            expect(didLastSaveFail()).toBe(true);
            expect(deriveCacheHealth()).toEqual({
                cacheWriteFailed: true,
                cacheWriteFailedStoryIds: ['both-dead-1'],
                cacheMirrorWriteFailed: true
            });
        } finally {
            vi.unstubAllGlobals();
            setItem.mockRestore();
        }
    });

    it('keeps the hedged state when localStorage fails but the mirror accepted the payload', async () => {
        // localStorage quota-dead, mirror HEALTHY (the normal iOS
        // private-mode shape: IndexedDB still works there) — the previous
        // fix's semantics must hold: the failure is scoped to the quick-cache
        // tier and the durable copy did land.
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        });
        try {
            const entry = makeEntry({
                storyId: 'hedged-1',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Hedged Chapter',
                            plotpoints: ['plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Hedged Chapter\n\nhedged body', wordCount: 2, generationTimeMs: 100 }]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            });
            saveRecordsToStorage([entry]);

            expect(didLastSaveFail()).toBe(true);
            // The full-fidelity payload landed in the durable mirror…
            await vi.waitFor(async () => {
                const mirrored = await storyCacheGet();
                expect(mirrored).not.toBeNull();
            });
            const mirrored = (await storyCacheGet())!;
            expect(mirrored[0].data!.chapters[0].revisions).toEqual([
                { content: '## Hedged Chapter\n\nhedged body', wordCount: 2, generationTimeMs: 100 }
            ]);
            // …so the health snapshot stays hedged: localStorage-only failure.
            expect(didLastMirrorWriteFail()).toBe(false);
            expect(deriveCacheHealth()).toEqual({
                cacheWriteFailed: true,
                cacheWriteFailedStoryIds: ['hedged-1'],
                cacheMirrorWriteFailed: false
            });
        } finally {
            setItem.mockRestore();
        }
    });

    it('loadRecordsFromIdbMirror recovers records when localStorage is empty and self-heals localStorage', async () => {
        // Simulate the private-mode/eviction aftermath: localStorage records
        // key is gone, but a previous session mirrored the payload.
        const entry = makeEntry({ storyId: 'recover-1', data: { chapters: [], meta: null } });
        saveRecordsToStorage([entry]);
        localStorage.clear(); // the wipe

        const recovered = await loadRecordsFromIdbMirror();
        expect(recovered).not.toBeNull();
        expect(recovered!.length).toBe(1);
        expect(recovered![0].storyId).toBe('recover-1');
        // Transient flags are reset on recovery (same defaults as
        // loadRecordsFromStorage).
        expect(recovered![0].isProcessing).toBe(false);
        expect(recovered![0].error).toBe('');

        // Self-heal: localStorage holds the recovered payload again.
        const healed = loadRecordsFromStorage();
        expect(healed.length).toBe(1);
        expect(healed[0].storyId).toBe('recover-1');
    });

    it('loadRecordsFromIdbMirror returns null when the mirror is empty', async () => {
        const recovered = await loadRecordsFromIdbMirror();
        expect(recovered).toBeNull();
    });

    it('upgradeRecordsFromIdbMirror restores chapters the localStorage ladder shed', async () => {
        // The core "cached chapters gone on click" regression: localStorage
        // shed a story to metadata-only under quota, but the mirror still
        // holds its chapters. The upgrade pass must return the entry with the
        // mirror's data restored.
        const fullEntry = makeEntry({
            storyId: 'upgrade-1',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Upgraded Chapter',
                        plotpoints: ['plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Upgraded Chapter\n\nrestored body', wordCount: 2, generationTimeMs: 100 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });
        // Mirror the full payload, then simulate the shed localStorage state.
        saveRecordsToStorage([fullEntry]);
        const shedEntry = { ...fullEntry, data: null };

        const upgraded = await upgradeRecordsFromIdbMirror([shedEntry]);
        expect(upgraded).not.toBeNull();
        expect(upgraded!.length).toBe(1);
        expect(upgraded![0].storyId).toBe('upgrade-1');
        expect(upgraded![0].data).not.toBeNull();
        expect(upgraded![0].data!.chapters[0].revisions).toEqual([
            { content: '## Upgraded Chapter\n\nrestored body', wordCount: 2, generationTimeMs: 100 }
        ]);
    });

    it('upgradeRecordsFromIdbMirror restores trimmed revisions from the mirror', async () => {
        // Ladder rung 2 trims a story to its latest revision; the mirror kept
        // both. The upgrade must restore the richer revision history.
        const revisions = [
            { content: '## Ch\n\nold rev', wordCount: 3, generationTimeMs: 1 },
            { content: '## Ch\n\nlatest rev', wordCount: 3, generationTimeMs: 2 }
        ];
        const fullEntry = makeEntry({
            storyId: 'upgrade-2',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Ch',
                        plotpoints: ['p'],
                        expanded: true,
                        canReExpand: true,
                        revisions
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });
        saveRecordsToStorage([fullEntry]);
        const trimmedEntry = {
            ...fullEntry,
            data: {
                ...fullEntry.data!,
                chapters: [{ ...fullEntry.data!.chapters[0], revisions: [revisions[1]] }]
            }
        };

        const upgraded = await upgradeRecordsFromIdbMirror([trimmedEntry]);
        expect(upgraded).not.toBeNull();
        expect(upgraded![0].data!.chapters[0].revisions).toEqual(revisions);
    });

    it('upgradeRecordsFromIdbMirror returns null when localStorage already matches the mirror', async () => {
        const entry = makeEntry({
            storyId: 'upgrade-3',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Ch',
                        plotpoints: ['p'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: 'body', wordCount: 1, generationTimeMs: 1 }]
                    }
                ],
                meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
            }
        });
        saveRecordsToStorage([entry]);

        const upgraded = await upgradeRecordsFromIdbMirror([entry]);
        expect(upgraded).toBeNull();
    });

    it('upgradeRecordsFromIdbMirror returns null when the mirror is empty', async () => {
        const upgraded = await upgradeRecordsFromIdbMirror([makeEntry({ storyId: 'upgrade-4' })]);
        expect(upgraded).toBeNull();
    });

    // ── T1: MIRROR-ONLY APPEND ──────────────────────────────────────────
    // The structural "new stories never cache forever" regression: a NEW
    // story whose localStorage writes failed at EVERY rung (mobile origin
    // quota exhausted by old cached stories) left no localStorage key, but
    // saveRecordsToStorage always fires the mirror sync with the complete
    // records — so the durable mirror DID catch the full payload. On the
    // next boot the upgrade pass only MAPPED the localStorage records, so
    // the mirror's copy of the new story was silently dropped: it came back
    // from the server list as data:null and showed "Not saved locally"
    // every session, forever. The append fixes that drop.
    it('upgradeRecordsFromIdbMirror APPENDS mirror-only stories with their data', async () => {
        const a = makeEntry({
            id: 1,
            storyId: 'append-a',
            title: 'Story A',
            data: { chapters: [], meta: null }
        });
        const b = makeEntry({
            id: 2,
            storyId: 'append-b',
            title: 'Story B',
            lastUpdatedAt: '2026-08-20T10:00:00.000Z',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Append Chapter',
                        plotpoints: ['append plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [
                            { content: '## Append Chapter\n\nappend body', wordCount: 3, generationTimeMs: 100 }
                        ]
                    }
                ],
                meta: { storyline: 'append storyline', chapterCount: 1, createdAt: '2026-08-20T10:00:00.000Z' }
            }
        });
        // localStorage holds ONLY story A (story B's writes failed at every
        // rung); the durable mirror caught BOTH full payloads.
        localStorage.setItem('storyGenerator:story:append-a', JSON.stringify(a));
        await storyCacheSet([a, b]);

        // The reload: localStorage hydration finds A only…
        const hydrated = loadRecordsFromStorage();
        expect(hydrated.map((entry) => entry.storyId)).toEqual(['append-a']);

        // …and the upgrade pass must surface B WITH its cached chapters
        // instead of silently dropping it.
        const upgraded = await upgradeRecordsFromIdbMirror(hydrated);
        expect(upgraded).not.toBeNull();
        expect(upgraded!.map((entry) => entry.storyId)).toEqual(['append-a', 'append-b']);
        const appendedB = upgraded!.find((entry) => entry.storyId === 'append-b')!;
        expect(appendedB.data).not.toBeNull();
        expect(appendedB.data!.chapters[0].revisions).toEqual([
            { content: '## Append Chapter\n\nappend body', wordCount: 3, generationTimeMs: 100 }
        ]);
        // Appended entries rehydrate through the same defaults the recovery
        // path applies (transient flags reset, not carried from the mirror).
        expect(appendedB.isProcessing).toBe(false);
        expect(appendedB.error).toBe('');
        expect(appendedB.missingFromServer).toBe(false);
    });

    // ── T3: RICHER-WINS NEVER-DOWNGRADE ─────────────────────────────────
    // The boot re-put poison scenario: hydration found a metadata-only
    // localStorage copy (quota shed) while the mirror still held the
    // chapters; the persist effect then saved the hydrated data:null
    // record — the pre-fix mirror sync overwrote the ONLY full copy with
    // metadata. storyCacheSet must keep the richer stored entry.
    it('storyCacheSet never downgrades a stored mirror entry to data:null (richer-wins)', async () => {
        const full = makeEntry({
            storyId: 'downgrade-guard-1',
            lastUpdatedAt: '2026-08-20T11:00:00.000Z',
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Guard Chapter',
                        plotpoints: ['guard plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [
                            { content: '## Guard Chapter\n\nguard body', wordCount: 3, generationTimeMs: 100 }
                        ]
                    }
                ],
                meta: { storyline: 'guard storyline', chapterCount: 1, createdAt: '2026-08-20T11:00:00.000Z' }
            }
        });
        expect(await storyCacheSet([full])).toBe(true);

        // Same story with its data shed to null (unchanged metadata — the
        // exact record a quota-shed hydration feeds back into the persist
        // effect on the next boot).
        const shed = { ...full, data: null };
        expect(await storyCacheSet([shed])).toBe(true);

        // The mirror still holds the RICH copy — not the metadata-only one.
        const mirrored = (await storyCacheGet())!;
        expect(mirrored.length).toBe(1);
        expect(mirrored[0].storyId).toBe('downgrade-guard-1');
        expect(mirrored[0].data).not.toBeNull();
        expect(mirrored[0].data!.chapters[0].revisions).toEqual([
            { content: '## Guard Chapter\n\nguard body', wordCount: 3, generationTimeMs: 100 }
        ]);

        // And a LEGITIMATE later change (fresh rich data, new timestamp)
        // still overwrites — the guard never wedges the mirror stale.
        const fresh = {
            ...full,
            lastUpdatedAt: '2026-08-20T12:00:00.000Z',
            data: {
                ...full.data!,
                chapters: [
                    {
                        ...full.data!.chapters[0],
                        title: 'Guard Chapter v2',
                        revisions: [
                            { content: '## Guard Chapter v2\n\nfresher body', wordCount: 3, generationTimeMs: 200 }
                        ]
                    }
                ]
            }
        };
        expect(await storyCacheSet([fresh])).toBe(true);
        const after = (await storyCacheGet())!;
        expect(after[0].data!.chapters[0].title).toBe('Guard Chapter v2');
    });

    // ── T4: CROSS-LOAD CHANGE DETECTION (no boot re-put burst) ──────────
    // mirrorSignatures is an in-memory map, empty on every fresh page load —
    // the pre-fix first sync after boot re-put EVERY story as a multi-MB
    // structured-clone burst (and a slow phone's transaction watchdog could
    // abort it, silently rolling back the new story's first full put). The
    // stored-value fingerprint comparison must skip identical payloads with
    // ZERO puts. Simulated with a FRESH module instance against the SAME
    // database (fake-indexeddb's factory global survives vi.resetModules).
    it('storyCacheSet skips identical payloads after a fresh page load (no redundant puts)', async () => {
        const a = makeEntry({
            id: 1,
            storyId: 'crossload-a',
            lastUpdatedAt: '2026-08-20T10:00:00.000Z',
            data: { chapters: [], meta: null }
        });
        const b = makeEntry({
            id: 2,
            storyId: 'crossload-b',
            lastUpdatedAt: '2026-08-20T11:00:00.000Z',
            data: { chapters: [], meta: null }
        });
        // First session: the sync commits both payloads.
        expect(await storyCacheSet([a, b])).toBe(true);

        // The "page reload": fresh module (empty in-memory signature map),
        // same database. Spy on the IDBObjectStore.prototype.put the way
        // fake-indexeddb implements puts — a skipped put must not be issued.
        const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
        try {
            vi.resetModules();
            const freshCache = await import('./storyCache');
            expect(await freshCache.storyCacheSet([a, b])).toBe(true);
            // The stored fingerprints matched the incoming payloads → reads
            // replaced writes: ZERO puts issued.
            expect(putSpy).not.toHaveBeenCalled();
            // …and the mirror payload is intact.
            const read = await freshCache.storyCacheGet();
            expect(read!.map((r) => r.storyId).sort()).toEqual(['crossload-a', 'crossload-b']);
        } finally {
            putSpy.mockRestore();
            // Re-baseline the module registry so later dynamic imports never
            // see the throwaway instance (static bindings are unaffected).
            vi.resetModules();
        }
    });
});

// ── T6: MID-SESSION STORAGE DEATH ───────────────────────────────────────
// The fingerprint-skip inside saveStoryAtRung read localStorage.getItem
// UNGUARDED: a storage device dying mid-session (hardened WebView revoking
// storage, eviction storm) after a SUCCESSFUL same-session save leaves a
// persistedFingerprints entry behind, so the next save hit the getItem in
// the skip condition and the throw escaped saveStoryAtRung — crashing the
// provider's persist effect and the whole records save. The guarded read
// must fall through to the quota ladder (whose per-rung catch handles the
// dead storage) and flag the per-story failure instead of throwing.
describe('saveRecordsToStorage (mid-session storage death)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('does not throw when storage dies after a successful same-session save (per-story failure flagged)', () => {
        const entry = makeEntry({ storyId: 'die-mid-session', data: { chapters: [], meta: null } });
        // First save lands normally — the fingerprint-skip state is primed.
        saveRecordsToStorage([entry]);
        expect(localStorage.getItem('storyGenerator:story:die-mid-session')).not.toBeNull();

        // …then the storage device dies mid-session: EVERY access throws.
        const storageProto = Object.getPrototypeOf(localStorage) as Storage;
        const getItem = vi.spyOn(storageProto, 'getItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });
        const setItem = vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
            throw new DOMException('SecurityError', 'SecurityError');
        });
        try {
            expect(() => saveRecordsToStorage([entry])).not.toThrow();
            // The failed save is OBSERVABLE, scoped per story — never a
            // silent success and never a crash (the in-memory store keeps
            // the session alive; the mirror tier gets its own chance).
            expect(didLastSaveFail()).toBe(true);
            expect(getLastSaveFailedStoryIds()).toEqual(['die-mid-session']);
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
        }
    });
});
