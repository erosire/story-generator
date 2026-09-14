// Tests for the background cache layer (src/features/backgroundCache.tsx).
//
// The layer progressively fetches story data that is NOT cached in this
// browser — one story at a time, in the background, after boot and after
// every list sync that adds new uncached stories. These tests pin the
// candidate rules (what gets fetched, what is deliberately skipped), the
// store merge shape, and the attempted-once failure policy.
//
// Rendering: <StoryStoreProvider initialStore={...}> + the layer ONLY — no
// BootstrapLayer/sidebar/content — so the fetch mock's calls are attributable
// to this layer alone. Landed data is asserted through the per-story
// localStorage keys the provider's records-persist effect writes.
//
// Store updates (simulating a list sync) go through a probe component that
// captures setStore — `initialStore` is only read by the provider's useState
// INITIALIZER, so re-rendering the provider with a different initialStore
// would be a no-op. Calling setStore is the real path a list sync takes.

import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StoryStoreProvider, useStoryStore, type StoryEntry } from '../context';
import { BackgroundCacheLayer } from './backgroundCache';
import { storyCacheResetForTests } from '../context/storyCache';

const BASE_URL = 'http://test.local/v1/storyboard/generations';

const mockResponse = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as any;

// Minimal StoryEntry factory — data null (uncached) by default.
const makeEntry = (overrides: Partial<StoryEntry>): StoryEntry => ({
    id: 1,
    storyId: 'story-a',
    title: 'Story A',
    storyline: '',
    chapterRequested: 1,
    chapterCompleted: 0,
    createdDate: '2026-08-14T00:00:00.000Z',
    status: 'completed',
    data: null,
    isProcessing: false,
    error: '',
    isRemote: true,
    ...overrides
});

// The chapter payload the mock per-story GET answers with.
const storyPayload = (storyline: string) => ({
    chapters: [
        {
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Ch1',
            plotpoints: ['plot'],
            expanded: true,
            canReExpand: true,
            revisions: [{ content: '## Ch1\n\nbody', wordCount: 2, generationTimeMs: 100 }]
        }
    ],
    meta: { storyline, chapterCount: 1, createdAt: '2026-08-14T00:00:00.000Z' }
});

// Probe: captures the provider's setStore so tests can drive records changes
// (the same path a sidebar list sync takes). Rendered inside the provider.
let capturedSetStore: ((updater: (prev: any) => any) => void) | null = null;
const SetStoreProbe: React.FC = () => {
    const { setStore } = useStoryStore();
    capturedSetStore = setStore;
    return null;
};

describe('BackgroundCacheLayer (progressive background fetch)', () => {
    beforeEach(() => {
        localStorage.clear();
        capturedSetStore = null;
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: any) => {
                if (!init || init.method === 'GET') {
                    if (url === BASE_URL || url === `${BASE_URL}/`) {
                        return Promise.resolve(mockResponse(200, { stories: [] }));
                    }
                    return Promise.resolve(
                        mockResponse(200, storyPayload(`storyline of ${String(url).split('/').pop()}`))
                    );
                }
                return Promise.resolve(mockResponse(200, {}));
            })
        );
    });
    afterEach(async () => {
        await act(async () => {
            await storyCacheResetForTests();
        });
        vi.unstubAllGlobals();
    });

    const renderLayer = (records: StoryEntry[], selected: StoryEntry | null = null) =>
        render(
            <StoryStoreProvider initialStore={{ records, selected }} configOverrides={{ baseUrl: BASE_URL }}>
                <SetStoreProbe />
                <BackgroundCacheLayer />
            </StoryStoreProvider>
        );

    // Simulate a sidebar list sync landing `records` (a REAL store update —
    // new array reference → the layer's effect re-runs).
    const syncRecords = (records: StoryEntry[]) => {
        act(() => {
            capturedSetStore!((prev: any) => ({ ...prev, records }));
        });
    };

    const storyGets = (fetchMock: any, storyId: string) =>
        fetchMock.mock.calls.filter(([url]: any[]) => String(url) === `${BASE_URL}/${storyId}`).length;

    const cachedStoryRaw = (storyId: string): string => localStorage.getItem(`storyGenerator:story:${storyId}`) ?? '';

    it('fetches every uncached story and lands its data in the store records cache', async () => {
        const fetchMock = globalThis.fetch as any;
        renderLayer([makeEntry({ id: 1, storyId: 'bg-a', title: 'A' }), makeEntry({ id: 2, storyId: 'bg-b', title: 'B' })]);

        // Both stories get exactly ONE background GET each (serial pass, no
        // duplicates from the effect re-running when each fetch lands).
        await waitFor(() => {
            expect(storyGets(fetchMock, 'bg-a')).toBe(1);
            expect(storyGets(fetchMock, 'bg-b')).toBe(1);
        });

        // The landed payloads were merged into the store and persisted by the
        // records-persist effect to the per-story localStorage keys.
        await waitFor(() => {
            expect(cachedStoryRaw('bg-a')).toContain('storyline of bg-a');
            expect(cachedStoryRaw('bg-b')).toContain('storyline of bg-b');
        });
    });

    it('skips stories that are cached, missing from the server, or processing', async () => {
        const fetchMock = globalThis.fetch as any;
        renderLayer([
            // Cached → skip.
            makeEntry({ id: 1, storyId: 'skip-cached', data: { chapters: [], meta: null } }),
            // Cache-only (server lost it) → skip.
            makeEntry({ id: 2, storyId: 'skip-missing', missingFromServer: true }),
            // Live job on the server → the job-gated poll loop owns it → skip.
            makeEntry({ id: 3, storyId: 'skip-server-job', serverProcessing: true }),
            // Local never-submitted story → nothing to fetch → skip.
            makeEntry({ id: 4, storyId: 'skip-local', isRemote: false, chapterRequested: 0 })
        ]);

        // Give the layer every chance to (wrongly) fetch.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(storyGets(fetchMock, 'skip-cached')).toBe(0);
        expect(storyGets(fetchMock, 'skip-missing')).toBe(0);
        expect(storyGets(fetchMock, 'skip-server-job')).toBe(0);
        expect(storyGets(fetchMock, 'skip-local')).toBe(0);
    });

    it('does not retry a failed story (attempted-once), even when a sync re-runs the effect', async () => {
        const fetchMock = globalThis.fetch as any;
        // This story's GET always fails (network error).
        fetchMock.mockImplementation((url: string) => {
            if (url === `${BASE_URL}/flaky-1`) return Promise.reject(new TypeError('Failed to fetch'));
            if (url === BASE_URL || url === `${BASE_URL}/`) {
                return Promise.resolve(mockResponse(200, { stories: [] }));
            }
            return Promise.resolve(mockResponse(200, storyPayload('ok')));
        });

        renderLayer([makeEntry({ id: 1, storyId: 'flaky-1' })]);

        await waitFor(() => {
            expect(storyGets(fetchMock, 'flaky-1')).toBe(1);
        });

        // A records change re-runs the effect (fresh array reference — the
        // attempted-once policy must keep the failed story out of the
        // candidate set: still exactly ONE GET, no retry storm).
        syncRecords([makeEntry({ id: 1, storyId: 'flaky-1' })]);
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(storyGets(fetchMock, 'flaky-1')).toBe(1);
    });

    it('fetches a NEW uncached story that a later list sync adds (records change re-arm)', async () => {
        const fetchMock = globalThis.fetch as any;
        // Start with an empty store; the "sync" adds an uncached story.
        renderLayer([]);

        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
        expect(storyGets(fetchMock, 'late-1')).toBe(0);

        syncRecords([makeEntry({ id: 5, storyId: 'late-1' })]);

        await waitFor(() => {
            expect(storyGets(fetchMock, 'late-1')).toBe(1);
        });
        await waitFor(() => {
            expect(cachedStoryRaw('late-1')).toContain('storyline of late-1');
        });
    });
});
