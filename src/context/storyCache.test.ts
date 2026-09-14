// Tests for the IndexedDB durable mirror tier (src/context/storyCache.ts).
//
// The mirror exists because localStorage alone does not survive mobile
// reality: iOS Safari private mode wipes it on tab close (setItem throws),
// Safari ITP evicts 7-day-unused keys, and the ~5MB quota sheds content.
// saveRecordsToStorage mirrors every story into IndexedDB PER STORY (one key
// per storyId â€” see storyCacheSet), and loadRecordsFromIdbMirror recovers it
// when localStorage boots empty.
//
// PER-STORY KEYING CONTRACT: each story lives under its own 'story:<storyId>'
// key, so one story's background job (generation/expansion poll ticks) can
// never rewrite or shed another story's mirror entry. storyCacheSet receives
// the COMPLETE records array (the caller â€” saveRecordsToStorage â€” always
// passes the full store records) and syncs the key set to it: unchanged
// stories are skipped, stories absent from the array are deleted.
//
// These tests run against fake-indexeddb (installed via vitest.config.ts
// setupFiles â†’ src/test/setup.ts), so the REAL module code paths execute â€”
// no mocks of the cache module itself.

import { beforeEach, describe, expect, it } from 'vitest';
import {
    storyCacheGet,
    storyCacheSet,
    storyCacheClear,
    storyCacheFingerprint,
    storyCacheResetForTests,
    type PersistableStoryEntryShape
} from './storyCache';

// Minimal valid persisted-record factory â€” same shape the store persists.
const makeRecord = (overrides: Partial<PersistableStoryEntryShape>): PersistableStoryEntryShape => ({
    id: 1,
    storyId: 'story-a',
    title: 'Story A',
    storyline: '',
    chapterRequested: 1,
    chapterCompleted: 0,
    createdDate: '2026-08-01T00:00:00.000Z',
    status: 'generating',
    data: null,
    isRemote: true,
    ...overrides
});

// Chapter payload with one expanded chapter (used to verify the structured
// clone preserves nested revision content).
const chapterData = (content: string) => ({
    chapters: [
        {
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Idb Chapter',
            plotpoints: ['plot'],
            expanded: true,
            canReExpand: true,
            revisions: [{ content, wordCount: 2, generationTimeMs: 100 }]
        }
    ],
    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
});

describe('storyCache (IndexedDB durable mirror, per-story keys)', () => {
    beforeEach(async () => {
        await storyCacheResetForTests();
    });

    it('writes and reads back per-story records (structured clone round-trip)', async () => {
        const records = [
            makeRecord({
                storyId: 'idb-1',
                data: chapterData('## Idb Chapter\n\nidb body')
            })
        ];

        const written = await storyCacheSet(records);
        expect(written).toBe(true);

        const read = await storyCacheGet();
        // Exact deep equality: the structured clone preserves the full shape,
        // including the nested chapter revision content.
        expect(read).toEqual(records);
    });

    it('resolves null when nothing was ever written', async () => {
        const read = await storyCacheGet();
        expect(read).toBeNull();
    });

    it('stores each story under its OWN key â€” independent entries coexist', async () => {
        // The per-story contract: saving story B must not touch story A.
        await storyCacheSet([makeRecord({ storyId: 'story-a' })]);
        await storyCacheSet([makeRecord({ storyId: 'story-a' }), makeRecord({ storyId: 'story-b' })]);

        const read = await storyCacheGet();
        expect(read).not.toBeNull();
        // Returned ordered by storage key (lexicographic by storyId).
        expect(read!.map((r) => r.storyId)).toEqual(['story-a', 'story-b']);
    });

    it('updating one story leaves the other story mirror entry untouched', async () => {
        const first = makeRecord({ storyId: 'story-a', title: 'Original A' });
        await storyCacheSet([first, makeRecord({ storyId: 'story-b', title: 'B' })]);

        // Story A's job finishes â€” only A's payload changes.
        await storyCacheSet([makeRecord({ storyId: 'story-a', title: 'Updated A' }), makeRecord({ storyId: 'story-b', title: 'B' })]);

        const read = await storyCacheGet();
        expect(read!.find((r) => r.storyId === 'story-a')!.title).toBe('Updated A');
        // Story B's entry survived A's update byte-for-byte (deep equal).
        expect(read!.find((r) => r.storyId === 'story-b')).toEqual(makeRecord({ storyId: 'story-b', title: 'B' }));
    });

    it('deleting a story from the records set removes its mirror key (full-set sync)', async () => {
        await storyCacheSet([makeRecord({ storyId: 'story-a' }), makeRecord({ storyId: 'story-gone' })]);

        // The next save no longer contains story-gone (it was deleted) â€”
        // its key must be purged so it cannot resurrect.
        await storyCacheSet([makeRecord({ storyId: 'story-a' })]);

        const read = await storyCacheGet();
        expect(read!.map((r) => r.storyId)).toEqual(['story-a']);
    });

    it('replaces a story mirror entry when its payload changes (change detection)', async () => {
        await storyCacheSet([makeRecord({ storyId: 'story-a', title: 'Before' })]);
        await storyCacheSet([makeRecord({ storyId: 'story-a', title: 'After' })]);

        const read = await storyCacheGet();
        expect(read).toEqual([makeRecord({ storyId: 'story-a', title: 'After' })]);
    });

    it('read falls back to the legacy single-blob key when no per-story keys exist', async () => {
        // A cache persisted before the per-story layout: one 'records' blob.
        // fake-indexeddb gives us a raw handle to seed it.
        const indexedDbFactory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
        const legacyBlob = [makeRecord({ storyId: 'legacy-1' })];
        await new Promise<void>((resolve, reject) => {
            const open = indexedDbFactory.open('storyGenerator', 1);
            open.onupgradeneeded = () => {
                if (!open.result.objectStoreNames.contains('kv')) {
                    open.result.createObjectStore('kv');
                }
            };
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('kv', 'readwrite');
                tx.objectStore('kv').put(legacyBlob, 'records');
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
        });

        const read = await storyCacheGet();
        expect(read).toEqual(legacyBlob);
    });

    it('sync deletes the superseded legacy blob after per-story keys exist', async () => {
        // Seed the legacy blob, then run one per-story sync.
        const indexedDbFactory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
        await new Promise<void>((resolve, reject) => {
            const open = indexedDbFactory.open('storyGenerator', 1);
            open.onupgradeneeded = () => {
                if (!open.result.objectStoreNames.contains('kv')) {
                    open.result.createObjectStore('kv');
                }
            };
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('kv', 'readwrite');
                tx.objectStore('kv').put([makeRecord({ storyId: 'old-blob-story' })], 'records');
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
        });

        await storyCacheSet([makeRecord({ storyId: 'story-a' })]);

        // The read only sees the per-story key â€” the legacy blob (and its
        // stale story) is gone.
        const read = await storyCacheGet();
        expect(read!.map((r) => r.storyId)).toEqual(['story-a']);
    });

    it('clear removes every per-story key', async () => {
        await storyCacheSet([makeRecord({ storyId: 'clear-me' }), makeRecord({ storyId: 'clear-me-too' })]);
        const cleared = await storyCacheClear();
        expect(cleared).toBe(true);

        const read = await storyCacheGet();
        expect(read).toBeNull();
    });

    it('reset-for-tests empties the store between tests', async () => {
        await storyCacheSet([makeRecord({ storyId: 'leaky' })]);
        await storyCacheResetForTests();
        const read = await storyCacheGet();
        expect(read).toBeNull();
    });

    it('reset-for-tests clears the change-detection cache (identical payload re-puts)', async () => {
        const records = [makeRecord({ storyId: 'sig-1' })];
        await storyCacheSet(records);
        await storyCacheResetForTests();
        // Same payload after the reset â€” must be written again (the mirror
        // was wiped; a stale signature must not skip the put).
        await storyCacheSet(records);
        const read = await storyCacheGet();
        expect(read).toEqual(records);
    });
});

// â”€â”€ storyCacheFingerprint (the cheap change detector) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The fingerprint is what lets both cache tiers skip unchanged stories
// without serializing multi-MB chapter payloads. It must be EXACTLY as
// sensitive as "the persisted payload changed": equal state â‡’ equal
// fingerprint; any persisted-field change â‡’ different fingerprint.
describe('storyCacheFingerprint (cheap change detection)', () => {
    const base = (): PersistableStoryEntryShape => ({
        id: 1,
        storyId: 'fp-1',
        title: 'Story A',
        storyline: 'a storyline',
        chapterRequested: 2,
        chapterCompleted: 1,
        createdDate: '2026-08-16T00:00:00.000Z',
        lastActionedAt: '2026-08-16T09:00:00.000Z',
        lastUpdatedAt: '2026-08-16T08:00:00.000Z',
        status: 'generating',
        data: chapterData('## Ch\n\nbody'),
        isRemote: true
    });

    it('is stable for identical state (fresh object identities)', () => {
        const a = storyCacheFingerprint(base());
        const b = storyCacheFingerprint(base());
        expect(a).toBe(b);
    });

    it('changes when the updated timestamp changes', () => {
        const before = storyCacheFingerprint(base());
        const after = storyCacheFingerprint({ ...base(), lastUpdatedAt: '2026-08-16T09:30:00.000Z' });
        expect(after).not.toBe(before);
    });

    it('changes when the user-action timestamp changes', () => {
        const before = storyCacheFingerprint(base());
        const after = storyCacheFingerprint({ ...base(), lastActionedAt: '2026-08-16T10:00:00.000Z' });
        expect(after).not.toBe(before);
    });

    it('changes when the revision structure changes (expand/rewrite/delete)', () => {
        const before = storyCacheFingerprint(base());
        const withExtraRevision = base();
        withExtraRevision.data!.chapters[0].revisions = [
            ...(withExtraRevision.data!.chapters[0].revisions ?? []),
            { content: '## Ch\n\nnewer', wordCount: 2, generationTimeMs: 1 }
        ];
        expect(storyCacheFingerprint(withExtraRevision)).not.toBe(before);

        const withRevisionRemoved = base();
        withRevisionRemoved.data!.chapters[0].revisions = [];
        expect(storyCacheFingerprint(withRevisionRemoved)).not.toBe(before);
    });

    it('changes when a chapter is added or a chapter expansion flag flips', () => {
        const before = storyCacheFingerprint(base());
        const withExtraChapter = base();
        withExtraChapter.data!.chapters = [
            ...withExtraChapter.data!.chapters,
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'Ch2',
                plotpoints: [],
                expanded: false,
                canReExpand: false
            }
        ];
        expect(storyCacheFingerprint(withExtraChapter)).not.toBe(before);

        const flipped = base();
        flipped.data!.chapters[0].expanded = false;
        expect(storyCacheFingerprint(flipped)).not.toBe(before);
    });

    it('changes when data presence changes (cached payload dropped vs empty)', () => {
        const emptyChapters = storyCacheFingerprint({ ...base(), data: { chapters: [], meta: null } });
        const noData = storyCacheFingerprint({ ...base(), data: null });
        expect(noData).not.toBe(emptyChapters);
    });

    it('changes when persisted metadata changes (status, staleness, name)', () => {
        const before = storyCacheFingerprint(base());
        expect(storyCacheFingerprint({ ...base(), status: 'completed' })).not.toBe(before);
        expect(storyCacheFingerprint({ ...base(), dataStale: true })).not.toBe(before);
        expect(storyCacheFingerprint({ ...base(), title: 'Renamed' })).not.toBe(before);
        expect(storyCacheFingerprint({ ...base(), storyName: 'Renamed' })).not.toBe(before);
        expect(storyCacheFingerprint({ ...base(), missingFromServer: true })).not.toBe(before);
        expect(storyCacheFingerprint({ ...base(), chapterCompleted: 2 })).not.toBe(before);
    });
});
