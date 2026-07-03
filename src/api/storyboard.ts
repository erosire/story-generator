// API client for the storyboard generations endpoints.
//
// Two endpoints (see runtime/service/endpoints/storyboard/generations/):
//   - POST /v1/storyboard/generations/:storyId
//       body: { storyline: string, chapterCount: number }
//       returns: { storyId: string }
//       behavior: fire-and-forget background generation; the server writes
//       plotpoint.md immediately and chapter-NNN.md files one at a time.
//       See generation-create-new-story.ts:236 (background task) and :241 (return).
//
//   - GET /v1/storyboard/generations/:storyId
//       returns: { plotlines: string, chapters: { length, content }[] }
//       404 if the storyId dir doesn't exist yet (no POST issued / generation
//       hasn't started creating files). See generation-get-story-data.ts:19-24.
//
// `pollStoryData` repeatedly hits GET until a stop condition is met:
//   - chapter count reaches the requested chapterCount, OR
//   - the response is a 404 (treated as "not started yet", keep polling), OR
//   - a non-200/non-404 error occurs, OR
//   - the caller signals cancellation via shouldStop().
//
// The caller (SectionStoryContent) supplies shouldStop() so unmounting or
// selecting a different story cancels the active poll loop.

import type { StoryData } from '../context';

// Result of a single GET poll attempt. `status` distinguishes terminal 200
// (story complete-ish) from transient 404 (still booting up) from hard errors.
export type PollResult =
    | { status: 'data'; data: StoryData }
    | { status: 'not-found' }
    | { status: 'error'; error: string };

// Create a new story via POST. Server returns the storyId immediately and
// kicks off background generation. Throws on network failure or non-200 response.
export async function createNewStory(
    baseUrl: string,
    storyId: string,
    body: { storyline: string; chapterCount: number }
): Promise<{ storyId: string }> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        // Server returns 400 with { error } for invalid bodies (see
        // generation-create-new-story.ts:213, :222, :230). Surface the message.
        let message = `Failed to create story (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore JSON parse error — keep the default message
        }
        throw new Error(message);
    }

    return (await response.json()) as { storyId: string };
}

// Fetch the current story data once via GET. Maps HTTP status to PollResult.
// 404 → 'not-found' (transient; story dir not created yet). 200 → 'data'.
// Anything else → 'error' with the server's error message if present.
export async function fetchStoryData(
    baseUrl: string,
    storyId: string
): Promise<PollResult> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const response = await fetch(url, { method: 'GET' });

    if (response.status === 404) {
        // Background generation hasn't created the dir yet — expected right
        // after POST, since generateStory runs fire-and-forget (see
        // generation-create-new-story.ts:236).
        return { status: 'not-found' };
    }

    if (!response.ok) {
        let message = `Failed to fetch story data (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        return { status: 'error', error: message };
    }

    // 200 — server always returns { plotlines, chapters } (may both be empty
    // for a freshly created dir; see generation-get-story-data.test.ts:128-133).
    const data = (await response.json()) as StoryData;
    return { status: 'data', data };
}

// Poll the GET endpoint in a loop until a termination condition is met.
//
// Termination:
//   - chapters.length reaches expectedChapterCount (generation finished), OR
//   - PollResult is 'error' (hard failure — we give up), OR
//   - shouldStop() returns true (caller cancelled: unmount, selection changed).
//
// `onData` is invoked on every successful fetch so the UI progressively reveals
// plotpoint.md (written almost immediately) and chapter files as they appear.
//
// `pollIntervalMs` is the wait between successive GET polls.
//
// Returns a 'data' result with the final fetched StoryData, or an 'error'/'stopped'
// terminal result so the caller can update isProcessing accordingly.
export type PollFinalResult =
    | { status: 'data'; data: StoryData }
    | { status: 'error'; error: string }
    | { status: 'stopped' };

export async function pollStoryData(params: {
    baseUrl: string;
    storyId: string;
    expectedChapterCount: number;
    pollIntervalMs: number;
    shouldStop: () => boolean;
    onData: (data: StoryData) => void;
}): Promise<PollFinalResult> {
    const { baseUrl, storyId, expectedChapterCount, pollIntervalMs, shouldStop, onData } = params;

    let last: StoryData = { plotlines: '', chapters: [] };

    // Loop until completion, hard error, or external cancellation.
    while (true) {
        // Check cancellation before each network round-trip so unmounting during
        // the wait between polls doesn't trigger an extra fetch + setState.
        if (shouldStop()) return { status: 'stopped' };

        const result = await fetchStoryData(baseUrl, storyId);

        if (result.status === 'error') {
            return { status: 'error', error: result.error };
        }

        if (result.status === 'data') {
            last = result.data;
            onData(result.data);

            // Completion check: once the server has written all requested chapters,
            // we stop polling. Note: plotlines can be written before any chapter
            // (generation-create-new-story.ts:74), so we gate on chapter count only.
            if (result.data.chapters.length >= expectedChapterCount) {
                return { status: 'data', data: result.data };
            }
        }
        // 'not-found' means the dir doesn't exist yet — keep polling.

        // Wait before the next round. Cancellation check after the wait guards
        // against posting setState on an unmounted component.
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

// Small helper to wait without exporting setTimeout directly. Used by tests
// that want to assert the polling loop's timing behaviour.
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
