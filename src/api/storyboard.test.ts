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

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-abc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storyline: 'A sci-fi adventure.', chapterCount: 3 })
        });
        expect(result).toEqual({ storyId: 'story-abc' });
    });

    it('throws an Error containing the server message on 400 (missing storyline)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(400, { error: 'storyline is required' })
        );

        await expect(
            createNewStory(BASE_URL, 'story-x', { storyline: '', chapterCount: 1 })
        ).rejects.toThrow('storyline is required');
    });

    it('falls back to a status-based message when the server body is not JSON', async () => {
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

        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });
});

describe('fetchStoryData', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('returns { status: "data", data } on 200 with unified chapters', async () => {
        const chapters = [
            {
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'The Beginning',
                plotpoints: ['Opening scene'],
                expanded: true,
                content: '## The Beginning\n\nIt was a dark and stormy night...',
                length: 9,
                generationTimeMs: 1000
            },
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'The Journey',
                plotpoints: ['Character development'],
                expanded: false
            }
        ];
        const meta = { storyline: 'A test story', chapterCount: 2, createdAt: '2026-07-01T10:00:00Z' };
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { chapters, meta })
        );

        const result = await fetchStoryData(BASE_URL, 'story-1');

        expect(result).toEqual({
            status: 'data',
            data: { chapters, meta }
        });
    });

    it('returns { status: "not-found" } on 404 (story dir not created yet)', async () => {
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

    const makeStoryMeta = (overrides: Partial<StoryMeta> = {}): StoryMeta => ({
        storyId: 'story-abc',
        chapterCount: 5,
        createdAt: '2026-07-03T12:00:00Z',
        ...overrides
    });

    it('returns { stories: StoryMeta[] } on 200 with story metadata', async () => {
        const metas: StoryMeta[] = [
            makeStoryMeta({ storyId: 'story-1', chapterCount: 3, createdAt: '2026-07-03T12:00:00Z' }),
            makeStoryMeta({ storyId: 'story-2', chapterCount: 7, createdAt: '2026-07-02T10:00:00Z' })
        ];
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { stories: metas })
        );

        const result = await fetchStoryList(BASE_URL);

        expect(result).toEqual({ stories: metas });
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
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

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
            mockResponse(200, { chapters: [], meta: null }),
            mockResponse(200, {
                chapters: [
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['a'], expanded: true, content: 'a', length: 1 }
                ],
                meta: null
            }),
            mockResponse(200, {
                chapters: [
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['a'], expanded: true, content: 'a', length: 1 },
                    { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['b'], expanded: true, content: 'b', length: 1 },
                    { chapterNumber: '3', chapterIndex: 2, title: 'Ch3', plotpoints: ['c'], expanded: true, content: 'c', length: 1 }
                ],
                meta: null
            })
        ];

        const onData = vi.fn();

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 3,
            onData
        });

        expect(result.status).toBe('data');
        expect(result.data.chapters.length).toBe(3);
        // onData should have fired once per data-bearing poll (3 times).
        expect(onData).toHaveBeenCalledTimes(3);
    });

    it('returns "stopped" when shouldStop returns true before any fetch', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation(() => Promise.resolve(mockResponse(200, { chapters: [], meta: null })));

        const result = await pollStoryData({
            baseUrl: BASE_URL,
            storyId: 'story-1',
            expectedChapterCount: 1,
            pollIntervalMs: 10,
            shouldStop: () => true,
            onData: () => {}
        });

        expect(result).toEqual({ status: 'stopped' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns "error" when fetchStoryData reports a hard error', async () => {
        const responses = [
            mockResponse(200, { chapters: [], meta: null }),
            mockResponse(500, { error: 'server on fire' })
        ];

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 1
        });

        expect(result).toEqual({ status: 'error', error: 'server on fire' });
    });

    it('keeps polling on 404 without terminating', async () => {
        const responses = [
            mockResponse(404, {}),
            mockResponse(404, {}),
            mockResponse(200, {
                chapters: [
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['x'], expanded: true, content: 'x', length: 1 }
                ],
                meta: null
            })
        ];
        const onData = vi.fn();

        const result = await runPollWithResponses(responses, {
            expectedChapterCount: 1,
            onData
        });

        expect(result.status).toBe('data');
        expect(result.data.chapters.length).toBe(1);
        // onData must NOT have been called on 404 polls — only on the final 200.
        expect(onData).toHaveBeenCalledTimes(1);
    });
});
