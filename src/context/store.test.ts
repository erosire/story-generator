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
    mergeServerStoryList,
    saveRecordsToStorage,
    type StoryEntry
} from './store';

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

// ── Offline cache durability (saveRecordsToStorage) ─────────────────────
// The offline-viewing contract: a story fetched from the server must be in
// localStorage the moment it lands in the store, so a later session with the
// server unreachable still shows the full story list and chapter content.
// These tests pin the synchronous write, its change-detection, and the
// quota-shedding ladder.
describe('saveRecordsToStorage (synchronous offline cache)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('writes the full records payload synchronously', () => {
        const entry = makeEntry({
            storyId: 'offline-story-1',
            data: { chapters: [], meta: null }
        });

        saveRecordsToStorage([entry]);

        const raw = localStorage.getItem('storyGenerator:records');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!);
        expect(parsed).toEqual([
            {
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
            }
        ]);
    });

    it('skips the write when the payload is unchanged', () => {
        const entry = makeEntry({ storyId: 'offline-story-1', data: { chapters: [], meta: null } });
        saveRecordsToStorage([entry]);
        const first = localStorage.getItem('storyGenerator:records');

        // Second call with identical records must not rewrite the value —
        // the raw string stays byte-identical (and no quota churn happens).
        saveRecordsToStorage([entry]);
        expect(localStorage.getItem('storyGenerator:records')).toBe(first);
    });

    it('rewrites when the payload changes (e.g. newly fetched chapter data)', () => {
        saveRecordsToStorage([makeEntry({ storyId: 'offline-story-1', data: null })]);
        const before = localStorage.getItem('storyGenerator:records');
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

        const after = localStorage.getItem('storyGenerator:records')!;
        expect(after).not.toBe(before);
        // The fetched chapter content is IN the cache — this is what a later
        // offline session reads via loadRecordsFromStorage.
        expect(after).toContain('offline body');
    });

    it('sheds older entries to metadata-only when the payload exceeds the quota', () => {
        // Simulate the real-world quota: setItem throws for LARGE payloads
        // (full chapter content > ~5MB) but succeeds for small ones — exactly
        // how the browser behaves, and why the shedding ladder exists.
        //
        // jsdom quirk: localStorage's methods live on the prototype one level
        // ABOVE the Storage.prototype the instance reports — spy on
        // Object.getPrototypeOf(localStorage) so the override is actually
        // reachable through the `localStorage` global the store code uses.
        // vitest quirk: mockImplementation REPLACES the real method entirely
        // (it does not wrap/call through), so the mock must explicitly
        // delegate to the captured original for the under-quota case.
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

        // Many entries so the shedding ladder has something to shed. The
        // entries carry full chapter content (two revisions each) so the
        // pass-0/pass-1 payloads exceed QUOTA_LIMIT while the metadata-only
        // ladder rungs fit under it.
        const entries = Array.from({ length: 6 }, (_, i) =>
            makeEntry({
                id: i + 1,
                storyId: `story-${i}`,
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: `Chapter of ${i}`,
                            plotpoints: ['p'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [
                                { content: `old rev ${i}`, wordCount: 1, generationTimeMs: 1 },
                                { content: `latest rev ${i}`, wordCount: 1, generationTimeMs: 2 }
                            ]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
            })
        );

        saveRecordsToStorage(entries);

        // The ladder shed enough weight to fit under the (simulated) quota —
        // SOMETHING was written.
        const raw = localStorage.getItem('storyGenerator:records');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!) as StoryEntry[];
        expect(parsed.length).toBe(6);
        // Every entry shed to metadata-only (data: null) — the LIST survives
        // offline even when the full content does not fit.
        parsed.forEach((e) => expect(e.data).toBeNull());

        setItem.mockRestore();
    });

    it('gives up silently when storage is entirely unavailable', () => {
        // Both attempts fail (e.g. storage disabled / private mode edge) —
        // the call must not throw (the in-memory store keeps working).
        // Spy on the prototype ABOVE the instance (jsdom quirk — see the
        // quota test above). The getItem spy is the load-bearing one here:
        // saveRecordsToStorage reads the current value BEFORE writing, so a
        // failing getItem short-circuits the write path entirely (the catch
        // swallows it) — the contract under test is "never throws".
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
