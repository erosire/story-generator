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
    type StoryEntry
} from './store';
import { storyCacheGet, storyCacheResetForTests } from './storyCache';

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
});
