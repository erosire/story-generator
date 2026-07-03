// Tests for the storyboard API client (src/api/storyboard.ts).
//
// Covers:
//   - createNewStory: success path (200 + { storyId }) and error path (400 with
//     { error }) matching the server's validation responses.
//   - fetchStoryData: 200 data, 404 not-found, and other-error branches.
//   - fetchStoryList: 200 with StoryMeta[] (new shape), 200 with empty array,
//     and error branches.
//   - pollStoryData: terminates when chapters reach expectedChapterCount, stops
//     cleanly when shouldStop returns true, and surfaces a hard error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNewStory, fetchStoryData, fetchStoryList, pollStoryData } from './storyboard';
import type { StoryMeta } from './storyboard';

const BASE_URL = 'http://test.local/v1/storyboard/generations';

// Build a minimal Response-like object that fetch mock returns.
const mockResponse = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as any;

describe('createNewStory', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts storyline + chapterCount and returns the storyId on success', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { storyId: 'story-abc' })
        );

        const result = await createNewStory(BASE_URL, 'story-abc', {
            storyline: 'A sci-fi adventure.',
            chapterCount: 3
        });

        // Asserts the request was shaped exactly as the server expects:
        // - method POST, Content-Type json, URL = BASE_URL/<storyId>
        // - body is JSON-encoded { storyline, chapterCount }
        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-abc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storyline: 'A sci-fi adventure.', chapterCount: 3 })
        });
        expect(result).toEqual({ storyId: 'story-abc' });
    });

    it('throws an Error containing the server message on 400 (missing storyline)', async () => {
        // Server returns { error: 'storyline is required' } on body validation failure
        // (generation-create-new-story.ts:222).
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(400, { error: 'storyline is required' })
        );

        await expect(
            createNewStory(BASE_URL, 'story-x', { storyline: '', chapterCount: 1 })
        ).rejects.toThrow('storyline is required');
    });

    it('falls back to a status-based message when the server body is not JSON', async () => {
        // A 500 without a JSON body should still surface a descriptive error.
        const badResponse = {
            ok: false,
            status: 500,
            json: async () => {
                throw new SyntaxError('not json');
            }
        } as any;
        (globalThis.fetch as any).mockResolvedValueOnce(badResponse);

        await expect(
            createNewStory(BASE_URL, 'story-x', { storyline: 'x', chapterCount: 1 })
        ).rejects.toThrow('Failed to create story (HTTP 500)');
    });

    it('URL-encodes the storyId so special characters survive the path', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { storyId: 'a/b c' })
        );

        await createNewStory(BASE_URL, 'a/b c', { storyline: 'x', chapterCount: 1 });

        // encodeURIComponent('a/b c') === 'a%2Fb%20c'
        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });
});

describe('fetchStoryData', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('returns { status: "data", data } on 200 with plotlines and chapters', async () => {
        // Mirrors the fixture in generation-get-story-data.test.ts:30-34.
        const chapters = [
            { length: 9, content: '## The Beginning\n\nIt was a dark and stormy night...' },
            { length: 8, content: '## The Journey\n\nThe next morning, they set out...' }
        ];
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { plotlines: '> Chapter 1', chapters })
        );

        const result = await fetchStoryData(BASE_URL, 'story-1');

        expect(result).toEqual({
            status: 'data',
            data: { plotlines: '> Chapter 1', chapters }
        });
    });

    it('returns { status: "not-found" } on 404 (story dir not created yet)', async () => {
        // Mirrors generation-get-story-data.test.ts:93-108 (non-existent story).
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(404, { error: 'x' }));

        const result = await fetchStoryData(BASE_URL, 'nope');

        expect(result).toEqual({ status: 'not-found' });
    });

    it('returns { status: "error", error } on 500', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(500, { error: 'boom' }));

        const result = await fetchStoryData(BASE_URL, 'story-1');

        expect(result).toEqual({ status: 'error', error: 'boom' });
    });
});

describe('fetchStoryList', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    // Server now returns { stories: StoryMeta[] } with full metadata per story
    // (see generation-list-stories.ts). Each entry has storyId, storyline,
    // chapterCount, and createdAt.
    const makeStoryMeta = (overrides: Partial<StoryMeta> = {}): StoryMeta => ({
        storyId: 'story-abc',
        storyline: 'A sci-fi adventure about Mars.',
        chapterCount: 5,
        createdAt: '2026-07-03T12:00:00Z',
        ...overrides
    });

    it('returns { stories: StoryMeta[] } on 200 with story metadata', async () => {
        const metas: StoryMeta[] = [
            makeStoryMeta({ storyId: 'story-1', storyline: 'First story', chapterCount: 3, createdAt: '2026-07-03T12:00:00Z' }),
            makeStoryMeta({ storyId: 'story-2', storyline: 'Second story', chapterCount: 7, createdAt: '2026-07-02T10:00:00Z' })
        ];
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { stories: metas })
        );

        const result = await fetchStoryList(BASE_URL);

        expect(result).toEqual({ stories: metas });
        // URL should be BASE_URL/list (URL-encoded)
        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/list`);
        expect((fetch as any).mock.calls[0][1]).toEqual({ method: 'GET' });
    });

    it('returns { stories: [] } when server returns an empty list', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { stories: [] })
        );

        const result = await fetchStoryList(BASE_URL);

        expect(result).toEqual({ stories: [] });
    });

    it('returns { stories: [] } when stories field is missing from response', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {})
        );

        const result = await fetchStoryList(BASE_URL);

        expect(result).toEqual({ stories: [] });
    });

    it('throws an Error containing the server message on 500', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(500, { error: 'server on fire' })
        );

        await expect(fetchStoryList(BASE_URL)).rejects.toThrow('server on fire');
    });

    it('falls back to a status-based message when the server body is not JSON', async () => {
        const badResponse = {
            ok: false,
            status: 502,
            json: async () => { throw new SyntaxError('not json'); }
        } as any;
        (globalThis.fetch as any).mockResolvedValueOnce(badResponse);

        await expect(fetchStoryList(BASE_URL)).rejects.toThrow('Failed to list stories (HTTP 502)');
    });
});

describe('pollStoryData', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        // Speed up the inter-poll wait so tests don't actually sleep for seconds.
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    // Helper that drives the poll loop forward through fake timers + a sequence
    // of mocked fetch responses. Each response is consumed by one loop iteration;
    // between iterations the loop awaits setTimeout(pollIntervalMs).
    const runPollWithResponses = async (
        responses: any[],
        params: {
            baseUrl?: string;
            storyId?: string;
            expectedChapterCount: number;
            pollIntervalMs?: number;
            shouldStop?: () => boolean;
            onData?: (data: any) => void;
        }
    ) => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation(() => {
            const next = responses.shift();
            if (!next) throw new Error('ran out of mock responses');
            return Promise.resolve(next);
        });

        const pollPromise = pollStoryData({
            baseUrl: params.baseUrl ?? BASE_URL,
            storyId: params.storyId ?? 'story-1',
            expectedChapterCount: params.expectedChapterCount,
            pollIntervalMs: params.pollIntervalMs ?? 10,
            shouldStop: params.shouldStop ?? (() => false),
            onData: params.onData ?? (() => {})
        });

        // Advance fake timers until the poll loop has consumed all responses.
        // We tick a few times to flush microtasks + the setTimeout wait.
        let ticks = 0;
        while (responses.length > 0 && ticks < 50) {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(10);
            ticks++;
        }
        await Promise.resolve();

        return pollPromise;
    };

    it('terminates and returns the final data once chapter count reaches expected', async () => {
        // Three polls: 0 chapters, 1 chapter, 3 chapters (meets expected 3).
        const responses = [
            mockResponse(200, { plotlines: 'pp', chapters: [] }),
            mockResponse(200, { plotlines: 'pp', chapters: [{ length: 1, content: 'a' }] }),
            mockResponse(200, {
                plotlines: 'pp',
                chapters: [
                    { length: 1, content: 'a' },
                    { length: 1, content: 'b' },
                    { length: 1, content: 'c' }
                ]
            })
        ];

        const onData = vi.fn();

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 3,
            onData
        });

        expect(result).toEqual({
            status: 'data',
            data: {
                plotlines: 'pp',
                chapters: [
                    { length: 1, content: 'a' },
                    { length: 1, content: 'b' },
                    { length: 1, content: 'c' }
                ]
            }
        });
        // onData should have fired once per data-bearing poll (3 times).
        expect(onData).toHaveBeenCalledTimes(3);
    });

    it('returns "stopped" when shouldStop returns true before any fetch', async () => {
        // shouldStop is true from the start — the loop bails before fetch.
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation(() => Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] })));

        const result = await pollStoryData({
            baseUrl: BASE_URL,
            storyId: 'story-1',
            expectedChapterCount: 1,
            pollIntervalMs: 10,
            shouldStop: () => true,
            onData: () => {}
        });

        expect(result).toEqual({ status: 'stopped' });
        // And crucially, no fetch call was ever made.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns "error" when fetchStoryData reports a hard error', async () => {
        const responses = [
            mockResponse(200, { plotlines: 'pp', chapters: [] }),
            mockResponse(500, { error: 'server on fire' })
        ];

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 1
        });

        expect(result).toEqual({ status: 'error', error: 'server on fire' });
    });

    it('keeps polling on 404 without terminating', async () => {
        // 404 means dir not created yet — loop should keep going.
        const responses = [
            mockResponse(404, {}),
            mockResponse(404, {}),
            mockResponse(200, {
                plotlines: 'pp',
                chapters: [{ length: 1, content: 'x' }]
            })
        ];
        const onData = vi.fn();

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 1,
            onData
        });

        expect(result).toEqual({
            status: 'data',
            data: { plotlines: 'pp', chapters: [{ length: 1, content: 'x' }] }
        });
        // onData must NOT have been called on 404 polls — only on the final 200.
        expect(onData).toHaveBeenCalledTimes(1);
    });
});
