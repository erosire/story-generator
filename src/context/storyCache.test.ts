// Tests for the IndexedDB durable mirror tier (src/context/storyCache.ts).
//
// The mirror exists because localStorage alone does not survive mobile
// reality: iOS Safari private mode wipes it on tab close (setItem throws),
// Safari ITP evicts 7-day-unused keys, and the ~5MB quota sheds content.
// saveRecordsToStorage mirrors every winning rung's payload into IndexedDB
// (fire-and-forget), and loadRecordsFromIdbMirror recovers it when
// localStorage boots empty.
//
// These tests run against fake-indexeddb (installed via vitest.config.ts
// setupFiles → src/test/setup.ts), so the REAL module code paths execute —
// no mocks of the cache module itself.

import { beforeEach, describe, expect, it } from 'vitest';
import {
    storyCacheGet,
    storyCacheSet,
    storyCacheClear,
    storyCacheResetForTests,
    type PersistableStoryEntryShape
} from './storyCache';

// Minimal valid persisted-record factory — same shape the store persists.
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

describe('storyCache (IndexedDB durable mirror)', () => {
    beforeEach(async () => {
        await storyCacheResetForTests();
    });

    it('writes and reads back the records payload (structured clone round-trip)', async () => {
        const records = [
            makeRecord({
                storyId: 'idb-1',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Idb Chapter',
                            plotpoints: ['plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Idb Chapter\n\nidb body', wordCount: 2, generationTimeMs: 100 }]
                        }
                    ],
                    meta: { storyline: 's', chapterCount: 1, createdAt: '2026-08-01T00:00:00.000Z' }
                }
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

    it('overwrites the previous payload on the next write (last write wins)', async () => {
        await storyCacheSet([makeRecord({ storyId: 'first' })]);
        await storyCacheSet([makeRecord({ storyId: 'second' })]);

        const read = await storyCacheGet();
        expect(read).toEqual([makeRecord({ storyId: 'second' })]);
    });

    it('clear removes the payload', async () => {
        await storyCacheSet([makeRecord({ storyId: 'clear-me' })]);
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
});
