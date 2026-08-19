// API client for the storyboard generations endpoints.
//
// Routes (see src/server/endpoints/story-generator.yml):
//
// Route 1 — Collection: GET /v1/storyboard/generations
//   returns: { stories: StoryMeta[] }
//   Each entry includes metadata (storyId, chapterRequested, chapterCompleted,
//   createdDate, status). Storyline is intentionally omitted
//   because it is free-form user text not needed by the sidebar.
//   See generation-list-stories.ts.
//
// Route 2 — Story-specific: /v1/storyboard/generations/:storyId
//   - POST /v1/storyboard/generations/:storyId
//       body: { storyline: string, chapterCount: number, clientId?: string }
//       (or { forkFrom: { sourceStoryId, chapterIndex }, clientId?: string })
//       returns: { storyId: string }
//       behavior: fire-and-forget background generation. For direct creates
//       (the dashboard Generate button) the server generates the PLOTLINE ONLY:
//       it writes plotpoint.json (status 'completed') and a skeleton
//       chapter-NNN.json payload per chapter (LLM context, empty revisions[]).
//       Chapters are NOT auto-expanded — the client expands them individually
//       via PATCH expandChapterIndex, which consumes each skeleton's stored
//       context. Fork mode still re-expands chapters from the fork point.
//       clientId selects the LLM client on the server (see Route 3 +
//       fetchClientOptions); it is NEVER stored with the story.
//       See generation-create-new-story.ts.
//
//   - GET /v1/storyboard/generations/:storyId
//       returns: { chapters: Chapter[], meta: StoryMeta | null }
//       Each chapter includes plotpoints and expansion status. Expanded chapters
//       include content/length/generationTimeMs; pending chapters have expanded=false.
//       404 if the storyId dir doesn't exist yet (no POST issued / generation
//       hasn't started creating files). See generation-get-story-data.ts.
//
//   - PATCH /v1/storyboard/generations/:storyId
//       body: { storyName?: string, expandChapterIndex?: number,
//               rewriteChapter?: number, rewriteContext?: string,
//               clientId?: string }
//       returns: { storyId, storyName?, expandChapterIndex?, rewriteChapter?,
//                  chapterNumber?, title?, message }
//       behavior: Updates story metadata (e.g. storyName), triggers
//       fire-and-forget re-expansion of a single chapter (expandChapterIndex),
//       or rewrites a chapter with user-provided context (rewriteChapter +
//       rewriteContext). expandChapterIndex chains to subsequent pending
//       chapters; rewriteChapter only rewrites the targeted chapter. clientId
//       selects the LLM client for the triggered work (never stored).
//       See generation-update-chapter.ts.
//
//   - DELETE /v1/storyboard/generations/:storyId
//       returns: { success: boolean, storyId: string }
//       behavior: Permanently deletes a story and all its data.
//       See generation-delete-story.ts.
//
// Route 3 — Clients: GET /v1/storyboard/clients
//   returns: { clients: string[] }
//   The selectable LLM client ids (keys of the server's CLIENTS map).
//   fetchClientOptions() derives the URL from the generations baseUrl.
//   See generation-list-clients.ts.
//
// `pollStoryData` repeatedly hits GET /v1/storyboard/generations/:storyId until a stop condition is met:
//   - chapter count reaches the requested chapterRequested, OR
//   - the response is a 404 (treated as "not started yet", keep polling), OR
//   - a non-200/non-404 error occurs, OR
//   - the caller signals cancellation via shouldStop().
//
// The caller (SectionStoryContent) supplies shouldStop() so unmounting or
// selecting a different story cancels the active poll loop.

import type { StoryData } from '../context';

// Story metadata returned by GET /v1/storyboard/generations/.
// Matches the server's StoryListEntry schema in story-generator.yml.
// Each entry corresponds to a directory under the service's temporary/database/storyboard/
// and includes summary information derived from plotpoint.json by generation-list-stories.
// Note: storyline is intentionally omitted from the list response — it is
// free-form user text that can be arbitrarily long and is not needed by the
// sidebar which only renders storyName/storyId (as title) and chapterRequested (as badge).
export type StoryMeta = {
    storyId: string;
    storyName?: string;
    chapterRequested: number;
    chapterCompleted: number;
    createdDate: string;
    status: 'generating' | 'completed' | 'failed';
};

// Result of a single GET poll attempt. `status` distinguishes terminal 200
// (story complete-ish) from transient 404 (still booting up) from hard errors.
export type PollResult =
    | { status: 'data'; data: StoryData }
    | { status: 'not-found' }
    | { status: 'error'; error: string };

// Create a new story via POST. Server returns the storyId immediately and
// kicks off background generation. Throws on network failure or non-200 response.
//
// When `forkFrom` is provided, the server forks an existing story instead of
// creating from scratch. It copies plotlines and pre-fork chapters from the
// source story, then re-expands from chapterIndex onwards.
//
// `clientId` (optional) is the id of the LLM client the deployment should use
// for this generation — chosen from the top-right dropdown (options fetched
// via fetchClientOptions). The server validates it against its CLIENTS map
// (400 on unknown ids) and never stores it; absent clientId → default client.
export async function createNewStory(
    baseUrl: string,
    storyId: string,
    body: { storyline: string; chapterCount: number },
    forkFrom?: { sourceStoryId: string; chapterIndex: number },
    clientId?: string
): Promise<{ storyId: string }> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    // clientId is only serialized when provided — the server treats an absent
    // value as "use the default client", so callers without a selection keep
    // the old wire shape.
    const clientField = clientId !== undefined && clientId.length > 0 ? { clientId } : {};
    const payload = forkFrom
        ? { forkFrom, ...clientField }
        : { ...body, ...clientField };
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

    // 200 — server always returns { chapters, meta } (may both be empty
    // for a freshly created dir; see generation-get-story-data.test.ts:128-133).
    const data = (await response.json()) as StoryData;
    return { status: 'data', data };
}

// Fetch the list of all stories via GET /v1/storyboard/generations.
//
// The server returns { stories: StoryMeta[] } where each entry contains
// story metadata (storyId, chapterRequested, chapterCompleted, createdDate,
// status) from plotpoint.json (see generation-list-stories.ts). Stories are
// sorted by createdDate descending (newest first) on the server side.
// Storyline is intentionally omitted from the list response.
//
// The list never includes chapter content — callers issue a second
// GET with a specific storyId for that.
//
// Throws on network failure or non-200 so the caller can surface a load error.
export async function fetchStoryList(baseUrl: string): Promise<{ stories: StoryMeta[] }> {
    const url = `${baseUrl}`;
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
        let message = `Failed to list stories (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    // The server always returns { stories: StoryMeta[] } (may be empty when no
    // story directories exist yet — see generation-list-stories.ts).
    const data = (await response.json()) as { stories: StoryMeta[] };
    return { stories: Array.isArray(data.stories) ? data.stories : [] };
}

// Poll the GET endpoint in a loop until a termination condition is met.
//
// Termination:
//   - When `expectedChapterCount` is a positive number: terminate once
//     `data.chapters.length >= expectedChapterCount` (target known — fresh POST).
//   - When `expectedChapterCount` is 0/omitted (remote story, count unknown):
//     terminate after the data has been stable across `stablePolls` consecutive
//     polls (i.e. chapter count and expanded count both unchanged). The server writes
//     plotpoint.md first then adds chapter-NNN.md files one at a time
//     (generation-create-new-story.ts:74 then :181), so stability implies the
//     background generation has finished for an already-existing story too.
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

// Number of consecutive stable polls required to declare a remote story "done"
// when we don't have an expected chapter count. 2 means: poll N, poll N+1 with
// identical data → done. Tuned so the user sees the final state confirmed by a
// second poll rather than guessing from a single unchanged round.
const REMOTE_STABLE_POLLS = 2;

export async function pollStoryData(params: {
    baseUrl: string;
    storyId: string;
    // Target chapter count for fresh-POST stories. Pass 0 (or omit) for a remote
    // story whose target count is unknown — termination then uses poll-stability.
    expectedChapterCount?: number;
    pollIntervalMs: number;
    shouldStop: () => boolean;
    onData: (data: StoryData) => void;
}): Promise<PollFinalResult> {
    const { baseUrl, storyId, pollIntervalMs, shouldStop, onData } = params;
    const expectedChapterCount = params.expectedChapterCount ?? 0;
    const hasTarget = expectedChapterCount > 0;

    let last: StoryData = { chapters: [], meta: null };

    // Stable-poll tracking for the no-target (remote) mode. We count how many
    // consecutive polls returned data identical to the previous one. Reset to 0
    // whenever the data changes (so a chapter appearing between polls re-arms
    // the counter and we wait for another stable round before declaring done).
    let stableCount = 0;
    let lastSignature = '';

    // Signature of a StoryData used for equality comparison in remote stable mode.
    // We track the total number of chapters and the number of expanded chapters
    // (plot outline generation adds chapters, chapter expansion flips expanded flags,
    // so both dimensions capture meaningful state changes).
    const signatureOf = (data: StoryData) =>
        `${data.chapters.length}|${data.chapters.filter((c) => c.expanded).length}`;

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

            if (hasTarget) {
                // Completion check: once the server has written all requested chapters
                // AND all of them have been expanded (result.content is non-empty),
                // we stop polling. Checking only chapter count is not enough because
                // plotpoint.json is written with all chapter entries before any
                // chapter expansion starts — see generation-create-new-story.ts.
                //
                // NOTE: direct creates (Generate button) are plotline-only — the API
                // never auto-expands chapters, so for those stories this loop keeps
                // polling (doubles as a live refresh) until every chapter is expanded
                // through its own PATCH flow, or the loop is cancelled via shouldStop()
                // (story switch / unmount). Individual expansions stop it early: the
                // per-chapter re-expand poller (SectionStoryContent) clears
                // isProcessing when the expanded chapter completes.
                const allExpanded =
                    result.data.chapters.length >= expectedChapterCount &&
                    result.data.chapters.every((ch) => ch.expanded);
                if (allExpanded) {
                    return { status: 'data', data: result.data };
                }
            } else {
                // No target — use stability. Compare signature to the previous poll;
                // match increments the counter, mismatch resets it (and stores the
                // new signature as the comparison baseline).
                const sig = signatureOf(result.data);
                if (sig === lastSignature) {
                    stableCount++;
                } else {
                    stableCount = 1;
                    lastSignature = sig;
                }
                if (stableCount >= REMOTE_STABLE_POLLS) {
                    return { status: 'data', data: result.data };
                }
            }
        }
        // 'not-found' means the dir doesn't exist yet — keep polling. This also
        // applies to a remote storyId that the user selected before the server's
        // background generation created its dir (eg. race between list + create).

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

// Delete a story via DELETE. Server removes the entire story folder and returns
// { success: true, storyId }. Throws on network failure or non-200 response.
export async function deleteStory(
    baseUrl: string,
    storyId: string
): Promise<{ success: boolean; storyId: string }> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const response = await fetch(url, { method: 'DELETE' });

    if (!response.ok) {
        let message = `Failed to delete story (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    return (await response.json()) as { success: boolean; storyId: string };
}

// Re-expand a chapter via PATCH. Server starts background re-expansion and
// returns immediately with chapter info. The UI should poll GET to detect
// when re-expansion completes (generationTimeMs in the chapter payload changes).
// Throws on network failure or non-200 response.
//
// `clientId` (optional) selects the LLM client for the re-expansion chain —
// the server validates and applies it per-request, never persists it.
export type UpdateChapterResponse = {
    storyId: string;
    expandChapterIndex: number;
    chapterNumber: string;
    title: string;
    message: string;
};

export async function updateChapter(
    baseUrl: string,
    storyId: string,
    chapterIndex: number,
    clientId?: string
): Promise<UpdateChapterResponse> {
    // clientId is included only when provided (see createNewStory).
    const clientField = clientId !== undefined && clientId.length > 0 ? { clientId } : {};
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expandChapterIndex: chapterIndex, ...clientField })
    });

    if (!response.ok) {
        let message = `Failed to update chapter (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    return (await response.json()) as UpdateChapterResponse;
}

// Rewrite a chapter via PATCH with user-provided context. Unlike re-expansion,
// rewrite uses the full story summary context + user's rewriteContext as the
// expansion prompt. Only rewrites the single targeted chapter (no chain).
// Throws on network failure or non-200 response.
//
// `clientId` (optional) selects the LLM client for the rewrite (never stored).
export type RewriteChapterResponse = {
    storyId: string;
    rewriteChapter: number;
    chapterNumber: string;
    title: string;
    message: string;
};

export async function rewriteChapter(
    baseUrl: string,
    storyId: string,
    chapterIndex: number,
    rewriteContext: string,
    rewriteRevisionIndex?: number,
    clientId?: string
): Promise<RewriteChapterResponse> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const body: Record<string, unknown> = { rewriteChapter: chapterIndex, rewriteContext };
    if (rewriteRevisionIndex !== undefined) {
        body.rewriteRevisionIndex = rewriteRevisionIndex;
    }
    // clientId is included only when provided (see createNewStory).
    if (clientId !== undefined && clientId.length > 0) {
        body.clientId = clientId;
    }
    const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let message = `Failed to rewrite chapter (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    return (await response.json()) as RewriteChapterResponse;
}

// Update story metadata via PATCH. Accepts any writable field (storyName, etc.)
// and returns the updated metadata. Throws on network failure or non-200 response.
export async function updateStoryMeta(
    baseUrl: string,
    storyId: string,
    body: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const url = `${baseUrl}/${encodeURIComponent(storyId)}`;
    const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let message = `Failed to update story (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    return (await response.json()) as Record<string, unknown>;
}

// ── Clients endpoint ────────────────────────────────────────────────────────
// Fetch the selectable LLM client ids from GET /v1/storyboard/clients
// (see generation-list-clients.ts + story-generator.yml).
//
// The clients route is a sibling of the generations route: the store's
// baseUrl always points at .../v1/storyboard/generations, so we remap the
// trailing "generations" segment to "clients". If the base URL doesn't match
// that shape (custom deployment with a different layout) the remap is a
// no-op and the request will 404 — callers are expected to catch and fall
// back to just offering the persisted/default client id.
//
// Returns the server's client id list (may be empty). Throws on network
// failure or non-200 so the caller can surface/fall back deliberately.
export async function fetchClientOptions(baseUrl: string): Promise<string[]> {
    // Derive the clients URL from the generations base URL.
    const clientsUrl = baseUrl.replace(/\/generations\/?$/, '/clients');
    const response = await fetch(clientsUrl, { method: 'GET' });

    if (!response.ok) {
        let message = `Failed to fetch client options (HTTP ${response.status})`;
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore
        }
        throw new Error(message);
    }

    const data = (await response.json()) as { clients?: unknown };
    // Defensive: the server always sends { clients: string[] }, but a stale
    // deployment without the /v1/storyboard/clients route answers 404 above;
    // a 200 with a malformed body degrades to [] so the dropdown still renders
    // the persisted clientId as its only option.
    return Array.isArray(data.clients) ? (data.clients as string[]) : [];
}
