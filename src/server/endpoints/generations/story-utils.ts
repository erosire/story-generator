// ---------------------------------------------------------------------------
// Story Generation Utilities — shared helpers for chapter expansion.
//
// Extracted from generation-create-new-story.ts so both create-new-story
// and update-chapter (PATCH) can reuse the core expansion logic.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { KIMIK2_INSTRUCTIONS, KIMIK2_OPENING } from '@runtime/data/prompts';
import { type TSchema, Type } from '@sinclair/typebox';
import { jsonComplete } from '@presource/core';
import { resolveClient, DATABASE_BASE_DIR, EXPAND_TIMEOUT_MS, OPENING_USER_MESSAGE, useApiMethod } from './generation-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpandChapterResult = {
    title: string;
    content: string;
};

// ---------------------------------------------------------------------------
// Structured Output Dispatch
// ---------------------------------------------------------------------------

/**
 * Call the LLM client's structured output method, dispatching between
 * `.structure()` (tool-calling) and `.format()` (native structured output)
 * based on the `useApiMethod` config setting.
 *
 * Both methods share the identical `SimpleClientStructuredOutputConfiguration<T>`
 * signature, so this helper is fully type-safe.
 */
export const callStructured = <T extends TSchema>(
    client: ReturnType<typeof createStoryClient>,
    config: { request: string; response: T; onUpdate?: (update: string) => Promise<void> }
) => {
    if (useApiMethod === 'format') {
        return client.format(config);
    }
    return client.structure(config);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the storyboard directory for a given storyId.
 * @param root - The shared temporary/database root injected by the service.
 */
export const resolveStoryboardDir = (root: string, storyId: string): string => {
    return path.join(root, DATABASE_BASE_DIR, storyId);
};

/**
 * Create an LLM client pre-configured for story generation.
 *
 * @param clientId - Optional per-request client id (from the request payload,
 *   validated by parseClientId in the handlers). Resolved via resolveClient()
 *   against generation-config CLIENTS; absent/unknown ids fall back to the
 *   default client so the selection is always per-request and never persisted.
 *
 * Clones the selected shared simpleClient to avoid shared mutable state
 * between concurrent generations.
 * The clone is then primed with system instructions and opening conversation messages.
 */
export const createStoryClient = (clientId?: string) => {
    const client = resolveClient(clientId).clone();

    client.system(KIMIK2_INSTRUCTIONS);
    client.user(OPENING_USER_MESSAGE);
    client.assistant(KIMIK2_OPENING);

    return client;
};

/**
 * The first user message seeded into the conversation history.
 * Re-exported here for convenience so consumers don't need to import from generation-config directly.
 */
export { OPENING_USER_MESSAGE } from './generation-config';

/**
 * Build the appending[] context from plotpoint chapter data.
 * Each entry is a plotpoint summary string for one chapter.
 */
export const buildAppendingFromChapters = (
    chapters: Array<{ number: string; title: string; plotpoints: string[] }>
): string[] => {
    const appending: string[] = [];
    for (const { number, title, plotpoints } of chapters) {
        if (!Array.isArray(plotpoints) || plotpoints.length === 0) {
            continue;
        }
        const entry = [`> ${number}: ${title}`, '\n\n', plotpoints.map((plot) => `- ${plot}`).join('\n')].join('\n\n');
        appending.push(entry);
    }
    return appending;
};

/**
 * Expand a single chapter using the LLM client.
 *
 * @param opts.client       - The LLM client (will be cloned internally to avoid mutation)
 * @param opts.appending    - The current rolling context array
 * @param opts.chapterDir   - Path to the chapter/ directory
 * @param opts.assertStoryExists - Guard function that throws if the story folder was deleted
 * @param opts.chapterNumber - The chapter number string (e.g. "1")
 * @param opts.chapterIndex  - Zero-based index of the chapter
 * @param opts.request      - The expansion request prompt
 * @param opts.minWords     - Optional minimum word count; expansion retries until met
 * @returns The expanded title and content
 */
export const expandChapter = async (opts: {
    client: ReturnType<typeof createStoryClient>;
    appending: string[];
    chapterDir: string;
    assertStoryExists: () => void;
    chapterNumber: string;
    chapterIndex: number;
    request: string;
    minWords?: number;
}): Promise<ExpandChapterResult> => {
    const { client, appending, chapterDir, assertStoryExists, chapterNumber, chapterIndex, request, minWords } = opts;

    let title: string = `Chapter ${chapterNumber}`;
    let content: string = '';
    let wordCount = 0;
    let attempts = 0;

    // Write chapter to chapter/chapter-XXX.md with zero-padded index
    const paddedNumber = String(chapterIndex + 1).padStart(3, '0');
    const chapterFilePath = path.join(chapterDir, `chapter-${paddedNumber}.md`);
    const chapterJsonPath = path.join(chapterDir, `chapter-${paddedNumber}.json`);

    // Progressive write buffer — during LLM streaming, onUpdate receives
    // partially-complete JSON. We use jsonComplete to parse it and write
    // to disk at most once per 10 seconds to avoid I/O race conditions.
    //
    // Both .md AND .json are written progressively — the UI reads .json
    // (via GET /{storyId}) and polls every 3s. Without updating .json,
    // the UI never sees content until writeChapterFiles() runs at the end.
    const PROGRESSIVE_BUFFER_MS = 3_000;
    let chapterProgressiveLastWrite = 0;
    let chapterProgressiveError: Error | null = null;

    /**
     * Create an activity-based stall detector for chapter expansion.
     *
     * Unlike a simple absolute timeout, this detector resets its timer every
     * time the onUpdate callback writes new content. The timeout only fires
     * when the LLM stream stops producing output for EXPAND_TIMEOUT_MS.
     *
     * Two-phase protection:
     *   1. If NO writes have occurred yet (LLM hasn't started streaming),
     *      fires after EXPAND_TIMEOUT_MS as a startup/initial-response timeout.
     *   2. If writes HAVE occurred but then stall, fires after
     *      EXPAND_TIMEOUT_MS of no new output (stall timeout).
     *
     * This means active generation (word count increasing) keeps resetting
     * the timer and will NOT trigger a timeout.
     */
    const createExpandStallDetector = (
        label: string,
        startTimeMs: number
    ): { promise: Promise<never>; cancel: () => void } => {
        let intervalId: ReturnType<typeof setInterval>;
        const promise = new Promise<never>((_, reject) => {
            intervalId = setInterval(() => {
                if (chapterProgressiveLastWrite > 0) {
                    // Phase 2: Writes have started — check for stall
                    const stallMs = Date.now() - chapterProgressiveLastWrite;
                    if (stallMs >= EXPAND_TIMEOUT_MS) {
                        clearInterval(intervalId);
                        reject(
                            new Error(
                                `${label} stalled — no new output for ${Math.round(stallMs / 1000)}s ` +
                                    `(limit: ${Math.round(EXPAND_TIMEOUT_MS / 1000)}s). Terminating and retrying...`
                            )
                        );
                    }
                } else {
                    // Phase 1: No writes yet — check startup timeout
                    const elapsedMs = Date.now() - startTimeMs;
                    if (elapsedMs >= EXPAND_TIMEOUT_MS) {
                        clearInterval(intervalId);
                        reject(
                            new Error(
                                `${label} timed out after ${Math.round(elapsedMs / 1000)}s with no output ` +
                                    `(limit: ${Math.round(EXPAND_TIMEOUT_MS / 1000)}s). Terminating and retrying...`
                            )
                        );
                    }
                }
            }, 10_000); // check every 10 seconds
        });
        return { promise, cancel: () => clearInterval(intervalId) };
    };

    do {
        assertStoryExists();
        attempts++;

        // Clone client so we can add context messages without affecting the original
        const contextClient = client.clone();

        // Append the appending[] context as an assistant message
        // (represents the story context seen so far)
        contextClient.assistant(appending.join('\n'));

        // Reset progressive error flag and stall tracking before each attempt
        chapterProgressiveError = null;
        chapterProgressiveLastWrite = 0;

        // Create activity-based stall detector — resets every time onUpdate writes
        const expandStartMs = Date.now();
        const stall = createExpandStallDetector(
            `expandChapter(chapter ${chapterNumber}, attempt ${attempts})`,
            expandStartMs
        );

        try {
            // Race the LLM call against the stall detector. The stall detector
            // only rejects when no progressive writes occur for EXPAND_TIMEOUT_MS,
            // so active generation (word count increasing) keeps resetting the timer.
            ({
                response: { title, content }
            } = await Promise.race([
                callStructured(contextClient, {
                    request,
                    response: Type.Object({
                        title: Type.String({ description: 'the title of the expanded chapter' }),
                        content: Type.String({ description: 'the content of the expanded chapter' })
                    }),
                    onUpdate: async (rawContent: string) => {
                        const now = Date.now();
                        if (now - chapterProgressiveLastWrite < PROGRESSIVE_BUFFER_MS) return;
                        const parsed = jsonComplete(rawContent);
                        if (!parsed) {
                            // jsonComplete failed — if content looks like JSON the model
                            // is producing invalid tool_call arguments. Record the error
                            // so we can throw immediately after format() returns.
                            if (rawContent.length > 0) {
                                const trimmed = rawContent.trimStart();
                                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                                    chapterProgressiveError = new Error(
                                        `Invalid JSON in chapter expansion streaming (length: ${trimmed.length}): ${trimmed.slice(0, 120)}…`
                                    );
                                }
                            }
                            return;
                        }
                        chapterProgressiveLastWrite = now;

                        const progressiveTitle =
                            typeof parsed.title === 'string' ? parsed.title : `Chapter ${chapterNumber}`;
                        const progressiveContent = typeof parsed.content === 'string' ? parsed.content : '';
                        if (progressiveContent.length > 0) {
                            assertStoryExists();
                            fs.mkdirSync(chapterDir, { recursive: true });

                            // Write .md for filesystem viewing
                            fs.writeFileSync(
                                chapterFilePath,
                                `## ${progressiveTitle}\n\n${progressiveContent}`,
                                'utf-8'
                            );

                            // Write .json — the UI reads this via GET /{storyId}
                            // Polls every 3s, so this is what makes content appear.
                            // Content is written directly to revisions[] (no result object).
                            try {
                                let chapterJson: Record<string, any> = {};
                                if (fs.existsSync(chapterJsonPath)) {
                                    chapterJson = JSON.parse(fs.readFileSync(chapterJsonPath, 'utf-8'));
                                }
                                if (!Array.isArray(chapterJson.revisions)) {
                                    chapterJson.revisions = [];
                                }
                                const progressiveWordCount = progressiveContent.split(/\s+/).filter(Boolean).length;
                                // Check if the last entry is an in-progress streaming entry
                                // (generationTimeMs === 0 marks it as not-yet-finalized).
                                const lastIdx = chapterJson.revisions.length - 1;
                                const lastRev = lastIdx >= 0 ? chapterJson.revisions[lastIdx] : null;
                                const isStreamingEntry =
                                    lastRev &&
                                    typeof lastRev.generationTimeMs === 'number' &&
                                    lastRev.generationTimeMs === 0;
                                if (isStreamingEntry) {
                                    // Update the existing streaming entry in place
                                    chapterJson.revisions[lastIdx].content = progressiveContent;
                                    chapterJson.revisions[lastIdx].wordCount = progressiveWordCount;
                                } else {
                                    // Append a new streaming entry
                                    chapterJson.revisions.push({
                                        content: progressiveContent,
                                        wordCount: progressiveWordCount,
                                        generationTimeMs: 0
                                    });
                                }
                                fs.writeFileSync(chapterJsonPath, JSON.stringify(chapterJson, null, 2), 'utf-8');
                            } catch (err) {
                                console.warn(`[progressive] Failed to update chapter JSON: ${err}`);
                            }

                            console.log(
                                `Chapter ${chapterNumber} (progressive, ${progressiveContent.split(' ').length} words) written to ${chapterFilePath}`
                            );
                        }
                    }
                }),
                stall.promise
            ]));

            stall.cancel();

            // Immediately after format() returns, check whether the
            // progressive write buffer detected invalid JSON during streaming.
            // Only throw if format() did NOT return valid content — this
            // prevents stale intermediate streaming errors from discarding
            // a successful final parse (the root cause of false retries).
            if (chapterProgressiveError) {
                if (typeof content !== 'string' || content.length === 0) {
                    throw chapterProgressiveError;
                }
                // format() returned valid content — clear the stale error
                chapterProgressiveError = null;
            }
        } catch (err) {
            stall.cancel();
            const isStallTimeout = err instanceof Error && err.message.includes('timed out');
            if (isStallTimeout) {
                console.error(
                    `[TIMEOUT] expandChapter stalled for chapter ${chapterNumber} (attempt ${attempts}): ${err}. Terminating and retrying...`
                );
            } else {
                console.error(
                    `[ERROR] expandChapter failed for chapter ${chapterNumber} (attempt ${attempts}): ${err}. Retrying...`
                );
            }
            // Reset so the do-while retries
            content = '';
            title = `Chapter ${chapterNumber}`;
            wordCount = 0;
        }

        // Guard: ensure content is a valid string before operating on it
        if (typeof content !== 'string' || content.length === 0) {
            if (content !== '') {
                console.warn(
                    `expandChapter returned invalid content (type: ${typeof content}, length: ${content?.length}). Retrying...`
                );
            }
            content = '';
            wordCount = 0;
        } else {
            wordCount = content.split(' ').length;
        }

        if (typeof title !== 'string' || title.length === 0) {
            title = `Chapter ${chapterNumber}`;
        }

        console.log(`Expanded complete: ${wordCount} words (attempt ${attempts})`);

        // Save current attempt to file immediately (will be overwritten on next retry)
        assertStoryExists();
        fs.mkdirSync(chapterDir, { recursive: true });
        fs.writeFileSync(chapterFilePath, `## ${title}\n\n${content}`, 'utf-8');
        console.log(`Written to ${chapterFilePath} (attempt ${attempts})`);

        if (minWords && wordCount < minWords) {
            console.log(`Word count ${wordCount} is below minimum ${minWords}. Retrying...`);
        }
    } while (minWords && wordCount < minWords);

    // Return expanded content so the caller can update appending[]
    return { title, content };
};

/**
 * Build the expansion request prompt for a chapter.
 */
export const buildExpandRequest = (chapterNumber: string, chapterTitle: string): string => {
    return [
        '> As the world best-selling author, you must do the following:',
        `- Expand the chapter "${chapterNumber}: ${chapterTitle}", using the plotpoints provided for the chapter.`,
        '- You must follow each of the plotpoint beat for beat without deviations.',
        '- Make sure the expanded chapter is in highly graphical explicit details',
        '- Describe everything in slow-paced vivid imagery. Expand on every details.',
        '- Do not output a wall of text! Must use short and long paragraphs, putting emphasis on dialogues',
        '- Must be written in active voice. Dialogue-driven story like Japanese Light Novels. Show the story, do not tell it!',
        // `> Must be a minimum of ${TARGET_WORD_COUNT_PROMPT} in total.`,
        '- The chapter must starts from the first plotpoint',
        '- The chapter must not contains plotpoints from different chapters',
        '- Do not include events that had not happened yet in the chapter',
        '- The chapter must ends with the last plotpoint'
    ].join('\n');
};

/**
 * Read the chapter payload JSON for a given chapter index.
 * Returns null if the file doesn't exist or is corrupted.
 */
export const readChapterPayload = (chapterDir: string, chapterIndex: number): Record<string, unknown> | null => {
    const paddedNumber = String(chapterIndex + 1).padStart(3, '0');
    const chapterJsonPath = path.join(chapterDir, `chapter-${paddedNumber}.json`);

    if (!fs.existsSync(chapterJsonPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(chapterJsonPath, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
};

/**
 * Increment the chapterCompleted counter in plotpoint.json.
 * Called when a chapter transitions from incomplete (no finalized revisions)
 * to complete (at least one finalized revision).
 */
export const incrementPlotpointChapterCompleted = (databaseDir: string): void => {
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');
    try {
        const data = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        data.chapterCompleted = (data.chapterCompleted ?? 0) + 1;
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
        // If plotpoint.json is missing or corrupted, skip silently
    }
};

/**
 * Read the plotpoint.json for a story.
 * Returns null if the file doesn't exist or is corrupted.
 */
export const readPlotpointData = (
    databaseDir: string
): { number: string; title: string; plotpoints: string[] }[] | null => {
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');

    if (!fs.existsSync(plotpointJsonPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(plotpointJsonPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.chapters)) {
            return data.chapters;
        }
        return null;
    } catch {
        return null;
    }
};

/**
 * Write a skeleton chapter-XXX.json BEFORE the LLM call. This persists the
 * conversation context (appending[], request) so the chapter can be re-expanded
 * even if the LLM call fails, times out, or the process crashes during
 * expansion. writeChapterFiles() overwrites this with the full result afterwards.
 */
export const writeChapterPayload = (opts: {
    chapterDir: string;
    chapterIndex: number;
    storyId: string;
    storyline: string;
    chapterCount: number;
    chapterNumber: string;
    plotpoints: string[];
    contextAppending: string[];
    request: string;
}): void => {
    const {
        chapterDir,
        chapterIndex,
        storyId,
        storyline,
        chapterCount,
        chapterNumber,
        plotpoints,
        contextAppending,
        request
    } = opts;

    const paddedNumber = String(chapterIndex + 1).padStart(3, '0');
    const chapterJsonPath = path.join(chapterDir, `chapter-${paddedNumber}.json`);

    // Skeleton payload — all context needed for re-expansion is present.
    // Content lives exclusively in revisions[] — no deprecated result object,
    // no top-level expansion or generationTimeMs (each revision carries its own).
    const payload = {
        storyId,
        storyline,
        chapterCount,
        chapterNumber,
        chapterIndex,
        title: `Chapter ${chapterNumber}`,
        plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
        context: {
            appending: contextAppending,
            request
        },
        config: {
            systemInstructions: KIMIK2_INSTRUCTIONS,
            openingMessage: KIMIK2_OPENING
        },
        revisions: [] as Array<{ content: string; wordCount: number; generationTimeMs: number }>
    };

    fs.mkdirSync(chapterDir, { recursive: true });
    fs.writeFileSync(chapterJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`Chapter payload (skeleton) written to ${chapterJsonPath}`);
};

/**
 * Write the chapter-XXX.md and chapter-XXX.json files after expansion.
 * Overwrites any skeleton JSON written earlier by writeChapterPayload.
 *
 * Before writing, reads the existing chapter-XXX.json (if any) and appends
 * the previous result as a revision into the revisions[] array. This preserves
 * all past expansions so the UI can browse older versions via tabs. The .md
 * file always contains only the latest expanded content (for filesystem viewing).
 */
export const writeChapterFiles = (opts: {
    chapterDir: string;
    chapterIndex: number;
    storyId: string;
    storyline: string;
    chapterCount: number;
    chapterNumber: string;
    plotpoints: string[];
    contextAppending: string[];
    request: string;
    result: ExpandChapterResult;
    generationTimeMs: number;
}): void => {
    const {
        chapterDir,
        chapterIndex,
        storyId,
        storyline,
        chapterCount,
        chapterNumber,
        plotpoints,
        contextAppending,
        request,
        result,
        generationTimeMs
    } = opts;

    const paddedNumber = String(chapterIndex + 1).padStart(3, '0');

    // Write the readable markdown file (latest expansion only — for filesystem viewing)
    const chapterFilePath = path.join(chapterDir, `chapter-${paddedNumber}.md`);
    fs.writeFileSync(chapterFilePath, `## ${result.title}\n\n${result.content}`, 'utf-8');
    console.log(`Chapter markdown written to ${chapterFilePath}`);

    // Read the existing JSON payload to preserve expansion revisions.
    // Content lives exclusively in revisions[]. The deprecated result object,
    // expansion, and top-level generationTimeMs are no longer written.
    // Also supports reading legacy history[], result, expansion, and
    // generationTimeMs entries from older files for migration.
    const chapterJsonPath = path.join(chapterDir, `chapter-${paddedNumber}.json`);
    let revisions: Array<{ content: string; wordCount: number; generationTimeMs: number }> = [];
    try {
        if (fs.existsSync(chapterJsonPath)) {
            const existing = JSON.parse(fs.readFileSync(chapterJsonPath, 'utf-8'));
            // Read from revisions[] format
            if (Array.isArray(existing.revisions)) {
                revisions = existing.revisions;
            }
            // Legacy: migrate history[] entries to revisions format
            else if (Array.isArray(existing.history)) {
                revisions = existing.history.map((h: any) => ({
                    content: h.content ?? '',
                    wordCount: typeof h.wordCount === 'number' ? h.wordCount : 0,
                    generationTimeMs: typeof h.generationTimeMs === 'number' ? h.generationTimeMs : 0
                }));
            }
            // Legacy: migrate result into revisions if no streaming entry exists
            // (result existed in older chapter files before the revisions-only switch)
            if (existing.result && typeof existing.result.content === 'string' && existing.result.content.length > 0) {
                const lastRev = revisions.length > 0 ? revisions[revisions.length - 1] : null;
                const hasStreamingEntry = lastRev && lastRev.generationTimeMs === 0;
                if (!hasStreamingEntry) {
                    revisions.push({
                        content: existing.result.content,
                        wordCount: typeof existing.expansion?.wordCount === 'number' ? existing.expansion.wordCount : 0,
                        generationTimeMs: typeof existing.generationTimeMs === 'number' ? existing.generationTimeMs : 0
                    });
                }
            }
        }
    } catch {
        // Corrupted or unreadable — start with fresh revisions
    }

    // Check if this chapter was previously incomplete (no finalized revisions).
    // If so, this write transitions it to "complete" and we need to increment
    // the chapterCompleted counter in plotpoint.json.
    const wasPreviouslyComplete = revisions.some(
        (r: { generationTimeMs?: number }) => typeof r.generationTimeMs === 'number' && r.generationTimeMs > 0
    );

    // Finalize the latest revision: if the last entry is a streaming entry
    // (generationTimeMs === 0), update it in place with the final values.
    // Otherwise, append as a new revision.
    const newRevision = {
        content: result.content,
        wordCount: result.content.split(' ').length,
        generationTimeMs
    };
    const lastIdx = revisions.length - 1;
    const lastRev = lastIdx >= 0 ? revisions[lastIdx] : null;
    if (lastRev && lastRev.generationTimeMs === 0) {
        // Update the streaming entry with final values
        revisions[lastIdx] = newRevision;
    } else {
        // Append as a new revision
        revisions.push(newRevision);
    }

    // If this chapter just became complete for the first time, increment the
    // chapterCompleted counter in plotpoint.json. This avoids the list endpoint
    // having to scan every chapter JSON file to count completions.
    if (!wasPreviouslyComplete) {
        const databaseDir = path.dirname(chapterDir);
        incrementPlotpointChapterCompleted(databaseDir);
    }

    // Write the full payload JSON file — revisions[] is the sole source of truth.
    // No deprecated result object, no expansion, no top-level generationTimeMs.
    const chapterPayload = {
        storyId,
        storyline,
        chapterCount,
        chapterNumber,
        chapterIndex,
        title: result.title,
        plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
        context: {
            appending: contextAppending,
            request
        },
        config: {
            systemInstructions: KIMIK2_INSTRUCTIONS,
            openingMessage: KIMIK2_OPENING
        },
        revisions
    };
    fs.writeFileSync(chapterJsonPath, JSON.stringify(chapterPayload, null, 2), 'utf-8');
    console.log(`Chapter payload written to ${chapterJsonPath} (revisions: ${revisions.length} total)`);
};
