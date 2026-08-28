// Tests for the storyboard API client (src/api/storyboard.ts).
//
// Covers:
//   - createNewStory: success path (200 + { storyId }) and error path (400 with
//     { error }) matching the server's validation responses. Also the per-request
//     clientId field in both the plain-body and forkFrom branches.
//   - fetchStoryData: 200 data, 404 not-found, and other-error branches.
//   - fetchStoryList: 200 with StoryMeta[] (new shape), 200 with empty array,
//     and error branches.
//   - updateChapter / rewriteChapter / deleteChapter: PATCH payloads (incl.
//     clientId where applicable) and error branches.
//   - removeChapter: the remove-entire-chapter PATCH (removeChapterIndex)
//     payload, URL encoding, and error branches.
//   - appendStoryPlotpoints: the "[->]" append dialog's POST — append
//     envelope shape (notes omitted when blank, clientId optional) and
//     the 400/500 error branches.
//   - fetchClientOptions: URL derivation from the generations baseUrl,
//     200 list, malformed-body fallback, and error branches.
//   - pollStoryData: terminates when chapters reach expectedChapterCount, stops
//     cleanly when shouldStop returns true, and surfaces a hard error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createNewStory,
    fetchStoryData,
    fetchStoryList,
    fetchClientOptions,
    pollStoryData,
    updateChapter,
    rewriteChapter,
    deleteChapter,
    removeChapter,
    appendStoryPlotpoints,
    resumeStoryPlotpoints
} from './storyboard';
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

        // No clientId argument → the field is omitted entirely, keeping the
        // legacy wire shape for callers without a client selection.
        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-abc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storyline: 'A sci-fi adventure.', chapterCount: 3 })
        });
        expect(result).toEqual({ storyId: 'story-abc' });
    });

    it('includes clientId in the POST body when provided', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { storyId: 'story-abc' })
        );

        const result = await createNewStory(
            BASE_URL,
            'story-abc',
            { storyline: 'A sci-fi adventure.', chapterCount: 3 },
            undefined,
            'Nvidia'
        );

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-abc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storyline: 'A sci-fi adventure.', chapterCount: 3, clientId: 'Nvidia' })
        });
        expect(result).toEqual({ storyId: 'story-abc' });
    });

    it('includes clientId alongside forkFrom in the fork branch', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { storyId: 'fork-abc' })
        );

        const result = await createNewStory(
            BASE_URL,
            'fork-abc',
            // storyline/chapterCount are not needed for a fork (the server
            // inherits them from the source story) — same `{}` shape the UI
            // passes in SectionStoryContent.handleFork.
            {} as any,
            { sourceStoryId: 'source-story', chapterIndex: 1 },
            'Modal'
        );

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/fork-abc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                forkFrom: { sourceStoryId: 'source-story', chapterIndex: 1 },
                clientId: 'Modal'
            })
        });
        expect(result).toEqual({ storyId: 'fork-abc' });
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

describe('updateChapter (PATCH)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('patches the chapter index without clientId (legacy callers)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                expandChapterIndex: 2,
                chapterNumber: '3',
                title: 'Ch3',
                message: 'Chapter 2 re-expansion started'
            })
        );

        const result = await updateChapter(BASE_URL, 'story-1', 2);

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expandChapterIndex: 2 })
        });
        expect(result).toEqual({
            storyId: 'story-1',
            expandChapterIndex: 2,
            chapterNumber: '3',
            title: 'Ch3',
            message: 'Chapter 2 re-expansion started'
        });
    });

    it('patches the chapter index together with the selected clientId', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                expandChapterIndex: 0,
                chapterNumber: '1',
                title: 'Ch1',
                message: 'Chapter 0 re-expansion started'
            })
        );

        await updateChapter(BASE_URL, 'story-1', 0, 'Qwen3_8');

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expandChapterIndex: 0, clientId: 'Qwen3_8' })
        });
    });

    it('throws with the server message when the server rejects the clientId', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(400, { error: "Unknown clientId 'nope'. Available clients: Qwen3_8" })
        );

        await expect(updateChapter(BASE_URL, 'story-1', 0, 'nope')).rejects.toThrow(
            "Unknown clientId 'nope'. Available clients: Qwen3_8"
        );
    });
});

describe('rewriteChapter (PATCH)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('patches rewriteChapter + rewriteContext + rewriteRevisionIndex + clientId', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                rewriteChapter: 1,
                chapterNumber: '2',
                title: 'Ch2',
                message: 'Chapter 1 rewrite started'
            })
        );

        const result = await rewriteChapter(BASE_URL, 'story-1', 1, 'Make it dramatic', 0, 'Telnyx');

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rewriteChapter: 1,
                rewriteContext: 'Make it dramatic',
                rewriteRevisionIndex: 0,
                clientId: 'Telnyx'
            })
        });
        expect(result).toEqual({
            storyId: 'story-1',
            rewriteChapter: 1,
            chapterNumber: '2',
            title: 'Ch2',
            message: 'Chapter 1 rewrite started'
        });
    });

    it('omits optional fields when rewriteRevisionIndex and clientId are absent', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                rewriteChapter: 0,
                chapterNumber: '1',
                title: 'Ch1',
                message: 'Chapter 0 rewrite started'
            })
        );

        await rewriteChapter(BASE_URL, 'story-1', 0, 'Slow it down');

        expect((fetch as any).mock.calls[0][1].body).toBe(
            JSON.stringify({ rewriteChapter: 0, rewriteContext: 'Slow it down' })
        );
    });
});

describe('deleteChapter (PATCH)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('patches deleteChapterIndex + deleteChapterRevisionIndex (no clientId — deletion is local, no LLM work)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                deleteChapterIndex: 2,
                deleteChapterRevisionIndex: 0,
                chapterNumber: '3',
                title: 'Ch3',
                revisionsRemaining: 1,
                message: 'Chapter 2 revision 0 deleted'
            })
        );

        const result = await deleteChapter(BASE_URL, 'story-1', 2, 0);

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteChapterIndex: 2, deleteChapterRevisionIndex: 0 })
        });
        expect(result).toEqual({
            storyId: 'story-1',
            deleteChapterIndex: 2,
            deleteChapterRevisionIndex: 0,
            chapterNumber: '3',
            title: 'Ch3',
            revisionsRemaining: 1,
            message: 'Chapter 2 revision 0 deleted'
        });
    });

    it('omits deleteChapterRevisionIndex when no revision index is given (server deletes the latest)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                deleteChapterIndex: 0,
                deleteChapterRevisionIndex: 1,
                chapterNumber: '1',
                title: 'Ch1',
                revisionsRemaining: 1,
                message: 'Chapter 0 revision 1 deleted'
            })
        );

        const result = await deleteChapter(BASE_URL, 'story-1', 0);

        expect((fetch as any).mock.calls[0][1].body).toBe(JSON.stringify({ deleteChapterIndex: 0 }));
        expect(result.deleteChapterRevisionIndex).toBe(1);
        expect(result.revisionsRemaining).toBe(1);
    });

    it('URL-encodes the storyId', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'a/b c',
                deleteChapterIndex: 0,
                deleteChapterRevisionIndex: 0,
                chapterNumber: '1',
                title: 'Ch1',
                revisionsRemaining: 0,
                message: 'Chapter 0 revision 0 deleted — the chapter is plotlines only and can be expanded again'
            })
        );

        await deleteChapter(BASE_URL, 'a/b c', 0, 0);

        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });

    it('throws with the server message on 404 (unknown chapter)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(404, { error: "Chapter 5 not found for story 'story-1'" })
        );

        await expect(deleteChapter(BASE_URL, 'story-1', 5)).rejects.toThrow(
            "Chapter 5 not found for story 'story-1'"
        );
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

        await expect(deleteChapter(BASE_URL, 'story-1', 0)).rejects.toThrow('Failed to delete chapter (HTTP 500)');
    });
});

describe('removeChapter (PATCH)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('patches removeChapterIndex and returns the removal summary (no clientId — removal is local, no LLM work)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'story-1',
                removeChapterIndex: 1,
                title: 'The Middle',
                chaptersRemaining: 2,
                message: 'Chapter 1 removed — 2 chapter(s) remain'
            })
        );

        const result = await removeChapter(BASE_URL, 'story-1', 1);

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removeChapterIndex: 1 })
        });
        expect(result).toEqual({
            storyId: 'story-1',
            removeChapterIndex: 1,
            title: 'The Middle',
            chaptersRemaining: 2,
            message: 'Chapter 1 removed — 2 chapter(s) remain'
        });
    });

    it('URL-encodes the storyId', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, {
                storyId: 'a/b c',
                removeChapterIndex: 0,
                title: 'Ch1',
                chaptersRemaining: 0,
                message: 'Chapter 0 removed — 0 chapter(s) remain'
            })
        );

        await removeChapter(BASE_URL, 'a/b c', 0);

        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });

    it('throws with the server message on 404 (unknown chapter)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(404, { error: "Chapter 5 not found for story 'story-1'" })
        );

        await expect(removeChapter(BASE_URL, 'story-1', 5)).rejects.toThrow(
            "Chapter 5 not found for story 'story-1'"
        );
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

        await expect(removeChapter(BASE_URL, 'story-1', 0)).rejects.toThrow('Failed to remove chapter (HTTP 500)');
    });
});

describe('fetchClientOptions', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('derives the /v1/storyboard/clients URL from the generations baseUrl', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { clients: ['Nvidia', 'Qwen3_8', 'Telnyx'] })
        );

        const result = await fetchClientOptions(BASE_URL);

        // .../v1/storyboard/generations → .../v1/storyboard/clients
        expect((fetch as any).mock.calls[0][0]).toBe('http://test.local/v1/storyboard/clients');
        expect((fetch as any).mock.calls[0][1]).toEqual({ method: 'GET' });
        expect(result).toEqual(['Nvidia', 'Qwen3_8', 'Telnyx']);
    });

    it('returns [] when the response body is malformed (stale deployment)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, {}));

        const result = await fetchClientOptions(BASE_URL);

        // The UI still renders the persisted client id as its sole option, so
        // the fetch degrades to an empty list instead of throwing.
        expect(result).toEqual([]);
    });

    it('throws with the server message on non-200', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(500, { error: 'client registry on fire' })
        );

        await expect(fetchClientOptions(BASE_URL)).rejects.toThrow('client registry on fire');
    });

    it('falls back to a status-based message when the body is not JSON', async () => {
        const badResponse = {
            ok: false,
            status: 502,
            json: async () => {
                throw new SyntaxError('not json');
            }
        } as any;
        (globalThis.fetch as any).mockResolvedValueOnce(badResponse);

        await expect(fetchClientOptions(BASE_URL)).rejects.toThrow('Failed to fetch client options (HTTP 502)');
    });
});

describe('appendStoryPlotpoints (POST append envelope)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts the append envelope without notes or clientId (legacy wire shape)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'story-1', appended: 3 }));

        const result = await appendStoryPlotpoints(BASE_URL, 'story-1', { chapterCount: 3 });

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ append: { chapterCount: 3 } })
        });
        expect(result).toEqual({ storyId: 'story-1', appended: 3 });
    });

    it('includes the trimmed notes and clientId when provided', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'story-1', appended: 2 }));

        const result = await appendStoryPlotpoints(BASE_URL, 'story-1', { chapterCount: 2, notes: '  the arc turns dark  ' }, 'Nvidia');

        expect((fetch as any).mock.calls[0][1].body).toBe(
            JSON.stringify({ append: { chapterCount: 2, notes: 'the arc turns dark' }, clientId: 'Nvidia' })
        );
        expect(result).toEqual({ storyId: 'story-1', appended: 2 });
    });

    it('omits blank notes entirely (dialog textarea left empty)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'story-1', appended: 1 }));

        await appendStoryPlotpoints(BASE_URL, 'story-1', { chapterCount: 1, notes: '   ' });

        expect((fetch as any).mock.calls[0][1].body).toBe(JSON.stringify({ append: { chapterCount: 1 } }));
    });

    it('URL-encodes the storyId for append', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'a/b c', appended: 1 }));

        await appendStoryPlotpoints(BASE_URL, 'a/b c', { chapterCount: 1 });

        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });

    it('throws with the server validation message on 400', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(400, { error: "Story 'nope' not found" }));

        await expect(appendStoryPlotpoints(BASE_URL, 'nope', { chapterCount: 1 })).rejects.toThrow("Story 'nope' not found");
    });

    it('falls back to a status-based message when the body is not JSON', async () => {
        const badResponse = {
            ok: false,
            status: 500,
            json: async () => {
                throw new SyntaxError('not json');
            }
        } as any;
        (globalThis.fetch as any).mockResolvedValueOnce(badResponse);

        await expect(appendStoryPlotpoints(BASE_URL, 'story-1', { chapterCount: 1 })).rejects.toThrow(
            'Failed to append chapters (HTTP 500)'
        );
    });
});

describe('resumeStoryPlotpoints (POST resume envelope)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts the resume envelope with an empty object when no target/clientId is given', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'story-1', resumed: 2, chapterCount: 3 }));

        const result = await resumeStoryPlotpoints(BASE_URL, 'story-1', {});

        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/story-1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resume: {} })
        });
        expect(result).toEqual({ storyId: 'story-1', resumed: 2, chapterCount: 3 });
    });

    it('includes the chapter target and clientId when provided (interrupted-append case)', async () => {
        // chapterRequested (6) > meta.chapterCount (3): the client still
        // remembers an append the server never finished, so the raised target
        // travels with the resume envelope.
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'story-1', resumed: 3, chapterCount: 6 }));

        const result = await resumeStoryPlotpoints(BASE_URL, 'story-1', { chapterCount: 6 }, 'Nvidia');

        expect((fetch as any).mock.calls[0][1].body).toBe(
            JSON.stringify({ resume: { chapterCount: 6 }, clientId: 'Nvidia' })
        );
        expect(result).toEqual({ storyId: 'story-1', resumed: 3, chapterCount: 6 });
    });

    it('URL-encodes the storyId for resume', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(mockResponse(200, { storyId: 'a/b c', resumed: 1, chapterCount: 2 }));

        await resumeStoryPlotpoints(BASE_URL, 'a/b c', { chapterCount: 2 });

        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}/a%2Fb%20c`);
    });

    it('throws with the server validation message on 400 (e.g. already complete)', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(400, { error: "Story 'done' plotline generation is already complete (3/3 chapters)" })
        );

        await expect(resumeStoryPlotpoints(BASE_URL, 'done', {})).rejects.toThrow(
            "Story 'done' plotline generation is already complete (3/3 chapters)"
        );
    });

    it('falls back to a status-based message when the body is not JSON', async () => {
        const badResponse = {
            ok: false,
            status: 500,
            json: async () => {
                throw new SyntaxError('not json');
            }
        } as any;
        (globalThis.fetch as any).mockResolvedValueOnce(badResponse);

        await expect(resumeStoryPlotpoints(BASE_URL, 'story-1', {})).rejects.toThrow(
            'Failed to resume story (HTTP 500)'
        );
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
                revisions: [
                    { content: '## The Beginning\n\nIt was a dark and stormy night...', wordCount: 9, generationTimeMs: 1000 }
                ]
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
        chapterRequested: 5,
        chapterCompleted: 0,
        createdDate: '2026-07-03T12:00:00Z',
        status: 'generating',
        ...overrides
    });

    it('returns { stories: StoryMeta[] } on 200 with story metadata', async () => {
        const metas: StoryMeta[] = [
            makeStoryMeta({ storyId: 'story-1', chapterRequested: 3, createdDate: '2026-07-03T12:00:00Z' }),
            makeStoryMeta({ storyId: 'story-2', chapterRequested: 7, createdDate: '2026-07-02T10:00:00Z' })
        ];
        (globalThis.fetch as any).mockResolvedValueOnce(
            mockResponse(200, { stories: metas })
        );

        const result = await fetchStoryList(BASE_URL);

        expect(result).toEqual({ stories: metas });
        expect((fetch as any).mock.calls[0][0]).toBe(`${BASE_URL}`);
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
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['a'], expanded: true, revisions: [{ content: 'a', wordCount: 1, generationTimeMs: 0 }] }
                ],
                meta: null
            }),
            mockResponse(200, {
                chapters: [
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['a'], expanded: true, revisions: [{ content: 'a', wordCount: 1, generationTimeMs: 0 }] },
                    { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['b'], expanded: true, revisions: [{ content: 'b', wordCount: 1, generationTimeMs: 0 }] },
                    { chapterNumber: '3', chapterIndex: 2, title: 'Ch3', plotpoints: ['c'], expanded: true, revisions: [{ content: 'c', wordCount: 1, generationTimeMs: 0 }] }
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
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['x'], expanded: true, revisions: [{ content: 'x', wordCount: 1, generationTimeMs: 0 }] }
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
