import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { type TSchema, Type } from '@sinclair/typebox';
import { arrayEachAsync, jsonComplete } from '@presource/core';
import {
    DATABASE_BASE_DIR,
    MAX_PLOT_ATTEMPTS,
    MAX_STALL_RETRIES,
    MAX_STORY_ATTEMPTS,
    MIN_PLOTPOINTS_PER_CHAPTER,
    MIN_WORDS_PER_CHAPTER,
    PLOTPOINT_STALL_TIMEOUT_MS,
    PREVIOUS_EXPANDED_CHAPTERS,
    REFUSAL_PATTERNS,
    STORY_REQUEST_MESSAGE
} from './generation-config';
import {
    buildExpandRequest,
    callStructured,
    createStoryClient,
    expandChapter,
    writeChapterFiles,
    writeChapterPayload
} from './story-utils';
import { forkStory } from './generation-fork-story';

// Generate the story in the background
const generateStory = async (options: {
    storyId: string;
    storyName: string;
    storyline: string;
    chapterCount: number;
    attempt?: number;
    retryIndex?: number;
    root: string;
}) => {
    const { storyId, storyName, storyline, chapterCount, root: projectRoot } = options;
    const attempt = options.attempt ?? 1;
    // Keep the retry number independent from the logical attempt number so a
    // pre-existing retry directory can be skipped without reusing its path.
    const retryIndex = options.retryIndex ?? Number(storyId.match(/-retry-(\d+)$/)?.[1] ?? 0);

    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR, storyId);

    // Reserve the story directory before any asynchronous work begins. A
    // duplicate POST or a racing retry must never reopen an existing story,
    // especially a failed story whose plotpoints are being kept for manual use.
    // The non-recursive mkdir is the filesystem-level guard that prevents two
    // same-ID generators from both passing an existsSync check.
    fs.mkdirSync(path.dirname(databaseDir), { recursive: true });
    fs.mkdirSync(databaseDir, { recursive: false });

    // Create a fresh client only after the new story entry has been reserved.
    // This prevents duplicate requests from consuming an LLM client while the
    // original story directory remains the sole owner of the generation.
    const client = createStoryClient();

    // Helper: check if story folder still exists (user may have deleted the story)
    const assertStoryExists = () => {
        if (!fs.existsSync(databaseDir)) {
            throw new Error(`Story folder deleted — aborting generation for storyId: ${storyId}`);
        }
    };

    // Ensure database and chapter folders exist
    const chapterDir = path.join(databaseDir, 'chapter');
    fs.mkdirSync(chapterDir, { recursive: true });

    const plotpointPath = path.join(databaseDir, 'plotpoint.md');
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');

    // Write placeholder plotpoint.json immediately so list and get-story-data
    // endpoints can return this story right away (before LLM responds).
    // plotpoint.json is the single source of truth for story metadata + chapter data.
    const createdAt = new Date().toISOString();
    const placeholderMeta = {
        storyId,
        storyName,
        storyline,
        chapterCount,
        chapterCompleted: 0,
        createdAt,
        chapters: [],
        status: 'generating'
    };
    fs.writeFileSync(plotpointJsonPath, JSON.stringify(placeholderMeta, null, 2), 'utf-8');
    fs.writeFileSync(plotpointPath, `> Generating plot outline for ${chapterCount} chapters...`, 'utf-8');
    console.log(`Placeholder written to ${plotpointJsonPath} and ${plotpointPath}`);

    // ── Progressive write buffer ────────────────────────────────────────
    // During LLM streaming, onUpdate receives partially-complete JSON.
    // We use jsonComplete to parse it and write to disk at most once
    // per PROGRESSIVE_BUFFER_MS to avoid I/O race conditions.
    //
    // When jsonComplete fails on non-empty content, the model is emitting
    // invalid tool_call JSON. We record the error in progressiveError so
    // the caller can check after format() returns and trigger a retry
    // immediately (instead of waiting for full validation).
    const PROGRESSIVE_BUFFER_MS = 3_000;
    let plotpointLastWriteTime = 0;
    let progressiveError: Error | null = null;

    // Keep the latest parsed stream result so a failed generation retains
    // usable partial chapters instead of replacing them with an empty array.
    let chapters: Array<{ number: string; title: string; plotpoints: string[] }> = [];
    let plotAttempts = 0;

    // Once failure is committed, every late callback from the failed LLM call
    // must become a no-op; the failed directory is then immutable until a user
    // explicitly edits or expands it.
    let storyFailed = false;

    // Each streamed plot request receives a token. A timed-out request may
    // continue emitting callbacks after Promise.race rejects, so callbacks from
    // older request tokens must not write over the current story state.
    let activePlotCallId = 0;

    const progressivePlotpointWrite = async (rawContent: string) => {
        // A completed failure is intentionally terminal for this story entry.
        if (storyFailed) return;

        const now = Date.now();
        if (now - plotpointLastWriteTime < PROGRESSIVE_BUFFER_MS) return;
        const parsed = jsonComplete(rawContent);
        if (!parsed) {
            // jsonComplete failed — if content looks like JSON (starts with
            // '{' or '[') the model is producing invalid tool_call arguments.
            // Record the error so the caller can retry immediately after
            // format() returns. Note: throwing here is NOT effective because
            // simple-client catches all errors inside the SSE parsing loop.
            if (rawContent.length > 0) {
                const trimmed = rawContent.trimStart();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    progressiveError = new Error(
                        `Invalid JSON in plotpoint streaming (length: ${trimmed.length}): ${trimmed.slice(0, 120)}…`
                    );
                }
            }
            return;
        }
        plotpointLastWriteTime = now;

        assertStoryExists();
        const partialChapters = Array.isArray(parsed.chapters)
            ? parsed.chapters.map((ch: any) => ({
                  number: String(ch.number ?? ''),
                  title: String(ch.title ?? ''),
                  plotpoints: Array.isArray(ch.plotpoints) ? ch.plotpoints : []
              }))
            : [];

        // Capture the latest complete partial response so markCompleteAndRetry
        // can preserve the plotpoints that were available before the failure.
        if (Array.isArray(parsed.chapters)) {
            chapters = partialChapters;
        }

        // The stream can yield control through an async callback boundary. Check
        // the terminal flag again immediately before touching the failed entry.
        if (storyFailed) return;

        const plotpointJson = {
            storyId,
            storyName,
            storyline,
            chapterCount,
            chapters: partialChapters,
            status: 'generating',
            createdAt
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointJson, null, 2), 'utf-8');
        console.log(
            `Plotpoint JSON (progressive) written to ${plotpointJsonPath} (${partialChapters.length} chapters)`
        );
    };

    /**
     * Check whether the progressive write buffer detected invalid JSON during
     * streaming. If so, clears the error and returns it. Returns null otherwise.
     * Call this immediately after every format() call that uses
     * progressivePlotpointWrite as its onUpdate callback.
     */
    const consumeProgressiveError = (): Error | null => {
        const err = progressiveError;
        if (err) {
            progressiveError = null;
        }
        return err;
    };

    // ── Stall detection ──────────────────────────────────────────────────
    // Detects when the LLM stream stops sending data during plotpoint
    // generation. If no progressive writes occur for PLOTPOINT_STALL_TIMEOUT_MS,
    // the call is terminated and retried (up to MAX_STALL_RETRIES times).

    /** Reset stall tracking before each callStructured invocation. */
    const resetStallTracking = () => {
        plotpointLastWriteTime = 0;
        progressiveError = null;
    };

    /**
     * Create a stall detector that rejects if no progressive writes occur
     * for PLOTPOINT_STALL_TIMEOUT_MS after the first write.
     */
    const createStallDetector = (): { promise: Promise<never>; cancel: () => void } => {
        let intervalId: ReturnType<typeof setInterval>;
        const promise = new Promise<never>((_, reject) => {
            intervalId = setInterval(() => {
                if (plotpointLastWriteTime > 0) {
                    const stallMs = Date.now() - plotpointLastWriteTime;
                    if (stallMs >= PLOTPOINT_STALL_TIMEOUT_MS) {
                        clearInterval(intervalId);
                        reject(
                            new Error(
                                `Plotpoint streaming stalled — no writes for ${Math.round(stallMs / 1000)}s. ` +
                                    `Terminating and retrying...`
                            )
                        );
                    }
                }
            }, 10_000); // check every 10 seconds
        });
        return { promise, cancel: () => clearInterval(intervalId) };
    };

    /**
     * Call callStructured with stall detection and automatic retry.
     * If the LLM stream stalls (no progressive writes for PLOTPOINT_STALL_TIMEOUT_MS),
     * the call is terminated and retried up to MAX_STALL_RETRIES times.
     */
    const callStructuredWithStallRetry = async <T extends TSchema>(config: {
        request: string;
        response: T;
        onUpdate?: (update: string) => Promise<void>;
    }) => {
        let stallAttempts = 0;
        while (true) {
            resetStallTracking();
            const callId = ++activePlotCallId;
            const stall = createStallDetector();
            // Wrap the stream callback so a previous stalled call cannot write
            // into the story while its replacement request is running.
            const requestConfig = {
                ...config,
                onUpdate: config.onUpdate
                    ? async (update: string) => {
                          if (storyFailed || activePlotCallId !== callId) return;
                          await config.onUpdate?.(update);
                      }
                    : undefined
            };
            try {
                const result = await Promise.race([callStructured(client, requestConfig), stall.promise]);
                stall.cancel();
                // Invalidate callbacks that arrive after the structured result
                // has resolved but before the client has fully unwound its stream.
                if (activePlotCallId === callId) activePlotCallId = 0;
                return result;
            } catch (err) {
                stall.cancel();
                // Invalidate the rejected/stalled request before starting a new
                // one, preventing late SSE updates from being treated as fresh.
                if (activePlotCallId === callId) activePlotCallId = 0;
                if (err instanceof Error && err.message.includes('stalled')) {
                    stallAttempts++;
                    console.error(`[STALL] ${err.message} (attempt ${stallAttempts}/${MAX_STALL_RETRIES})`);
                    if (stallAttempts >= MAX_STALL_RETRIES) {
                        throw new Error(
                            `Plotpoint streaming stalled ${MAX_STALL_RETRIES} times consecutively. Aborting.`
                        );
                    }
                    continue;
                }
                throw err;
            }
        }
    };

    // Prime the conversation history via client methods.
    // The client already has system + opening messages from createStoryClient().
    // We just need to add the story request messages.
    client.user(STORY_REQUEST_MESSAGE);
    client.assistant(storyline);

    // ── Plotpoint Generation ──────────────────────────────────────────
    // On any failure (validation, stall, etc.), mark the current story
    // as "complete" (without chapter expansion) and spin up a new story
    // entry for the next attempt. This preserves the failed story in the
    // list so it can be inspected, forked, or expanded manually.
    /**
     * Mark the current story as complete (without chapter expansion) and
     * spin up a new story entry for the next attempt, if attempts remain.
     */
    const markCompleteAndRetry = (reason: string) => {
        // Failure handling can be reached by more than one asynchronous path
        // when a stream races a timeout. Commit it once so no retry can rewrite
        // the failed entry or create duplicate retry entries.
        if (storyFailed) return;
        storyFailed = true;
        activePlotCallId = 0;

        assertStoryExists();
        const completedPlotpoint = {
            storyId,
            storyName,
            storyline,
            chapterCount,
            chapters: chapters.map(({ number, title, plotpoints }) => ({
                number,
                title,
                plotpoints: Array.isArray(plotpoints) ? plotpoints : []
            })),
            status: 'failed',
            validation: { valid: false, reason, attempt: plotAttempts },
            createdAt
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(completedPlotpoint, null, 2), 'utf-8');
        fs.writeFileSync(plotpointPath, `> Plotpoint generation failed: ${reason}`, 'utf-8');
        console.log(
            `Story ${storyId} marked as failed (plotpoint generation failed: ${reason}, ` +
                `${chapters.length} chapters with plotpoints)`
        );

        // Spin up a new story entry for the next attempt
        // Strip any existing retry suffixes from storyId/storyName to keep retry IDs flat.
        // Without this, nested retries produce compound IDs like "abc-retry-1-retry-2-retry-3"
        // instead of the intended flat pattern "abc-retry-1", "abc-retry-2", "abc-retry-3".
        if (attempt < MAX_STORY_ATTEMPTS) {
            const baseStoryId = storyId.replace(/-retry-\d+$/, '');
            const baseStoryName = storyName.replace(/\s*\[retry \d+\]$/, '');
            // Never reuse a directory, including one left by an earlier failed
            // run. This preserves both the current failure and old retry history.
            let nextRetryIndex = Math.max(attempt, retryIndex + 1);
            let retryStoryId = `${baseStoryId}-retry-${nextRetryIndex}`;
            while (fs.existsSync(path.join(projectRoot, DATABASE_BASE_DIR, retryStoryId))) {
                nextRetryIndex++;
                retryStoryId = `${baseStoryId}-retry-${nextRetryIndex}`;
            }
            const retryStoryName = `${baseStoryName} [retry ${nextRetryIndex}]`;
            console.log(
                `Spinning up retry story ${retryStoryId} (attempt ${attempt + 1}/${MAX_STORY_ATTEMPTS})`
            );
            generateStory({
                storyId: retryStoryId,
                storyName: retryStoryName,
                storyline,
                chapterCount,
                attempt: attempt + 1,
                retryIndex: nextRetryIndex,
                root: projectRoot
            }).catch((err) => {
                console.error(`Retry story generation failed for ${retryStoryId}:`, err);
            });
        } else {
            console.log(
                `Max story attempts (${MAX_STORY_ATTEMPTS}) reached for original story ${storyId}. ` +
                    `No more retries.`
            );
        }
    };

    try {
        ({
            response: { chapters }
        } = await callStructuredWithStallRetry({
            request: [
                //
                `> Submit me the detailed plotpoints of the next ${chapterCount} chapters`,
                '> The plotpoint must includes all the important dialogues',
                `> There must be at least ${MIN_PLOTPOINTS_PER_CHAPTER} plotpoints per chapter`,
                '> Must clearly outlines how each chapter starts, and how each chapter ends'
            ].join('\n'),
            response: Type.Object({
                chapters: Type.Array(
                    Type.Object({
                        number: Type.String({ description: 'the chapter number' }),
                        title: Type.String({ description: 'the title of the chapter' }),
                        plotpoints: Type.Array(Type.String(), { description: 'the detailed plotpoints of the chapter' })
                    }),
                    { description: 'a list of chapter plotpoints to submit' }
                )
            }),
            onUpdate: progressivePlotpointWrite
        }));
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[PLOTPOINT] Initial call failed for storyId ${storyId} (attempt ${attempt}): ${reason}`);
        markCompleteAndRetry(reason);
        return;
    }

    // Immediately after format() returns, check whether the progressive
    // write buffer detected invalid JSON during streaming. Only force an
    // empty chapters array when format() did NOT return valid data.
    // This prevents stale intermediate streaming errors from discarding
    // a successful final parse (the root cause of false validation triggers).
    if (!Array.isArray(chapters) || chapters.length === 0) {
        if (consumeProgressiveError()) {
            chapters = [];
        }
    } else {
        // format() returned valid data — discard any stale progressive error
        consumeProgressiveError();
    }

    // Helper: detect refusal phrases in plotlines
    const detectRefusals = (chapterList: Array<{ plotpoints?: string[] }>): boolean => {
        for (const ch of chapterList) {
            if (!Array.isArray(ch.plotpoints)) continue;
            for (const plotpoint of ch.plotpoints) {
                for (const pattern of REFUSAL_PATTERNS) {
                    if (plotpoint.toLowerCase().includes(pattern.toLowerCase())) {
                        return true;
                    }
                }
            }
        }
        return false;
    };

    // Helper: validate chapter count matches requested amount
    const validateChapterCount = (chapterList: Array<unknown>): boolean => {
        return chapterList.length === chapterCount;
    };

    // Write the LLM's plotpoint response to disk immediately (before validation).
    // This ensures plotpoint.json always reflects the latest LLM output
    // so it can be inspected even when validation fails.
    // NOTE: plotpoint.md is only written for manual debugging — the API reads .json only.
    const writePlotpointFile = (validationStatus?: { valid: boolean; reason?: string; attempt: number }) => {
        // A late validation callback must not turn a committed failed entry
        // back into a generating entry or replace its preserved output.
        if (storyFailed) return;
        assertStoryExists();

        // Write plotpoint.json — single source of truth for story metadata + chapters
        const plotpointJson = {
            storyId,
            storyName,
            storyline,
            chapterCount,
            chapters: chapters.map(({ number, title, plotpoints }) => ({
                number,
                title,
                plotpoints: Array.isArray(plotpoints) ? plotpoints : []
            })),
            validation: validationStatus ?? { valid: 'pending', attempt: 0, reason: 'initial response' },
            createdAt
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointJson, null, 2), 'utf-8');
        console.log(`Plotpoint JSON written to ${plotpointJsonPath} (${chapters.length} chapters)`);

        // Write plotpoint.md for manual debugging only (cast to any[] — LLM may return unexpected shapes)
        const rawChapters = chapters as Array<Record<string, any>>;
        const content = rawChapters
            .map((ch) => {
                const num = ch.number ?? ch.chapter_number ?? ch.chapterNumber ?? ch.id ?? '?';
                const title = ch.title ?? ch.chapter_title ?? ch.chapterTitle ?? '?';
                const plots = ch.plotpoints ?? ch.plot_points ?? ch.outlines ?? [];
                const points = Array.isArray(plots) ? plots.map((p: any) => `- ${p}`).join('\n') : '(missing)';
                return `> ${num}: ${title}\n\n${points}`;
            })
            .join('\n\n---\n\n');

        fs.writeFileSync(plotpointPath, content, 'utf-8');
        console.log(`Plotpoint MD written to ${plotpointPath} (${chapters.length} chapters)`);
    };

    // Write the initial LLM response immediately so it's on disk regardless of validation outcome
    writePlotpointFile();

    // Validate plot generation: check for refusals and chapter count mismatch.
    // Retry up to MAX_PLOT_ATTEMPTS times if validation fails.
    plotAttempts = 0;

    const validatePlot = (chapterList: unknown): { valid: boolean; reason?: string } => {
        if (!Array.isArray(chapterList)) {
            return { valid: false, reason: `chapters is not an array (type: ${typeof chapterList})` };
        }
        if (chapterList.length === 0) {
            return { valid: false, reason: 'chapters array is empty' };
        }
        if (!validateChapterCount(chapterList)) {
            return {
                valid: false,
                reason: `Chapter count mismatch: requested ${chapterCount} chapters but got ${chapterList.length}`
            };
        }
        if (detectRefusals(chapterList as Array<{ plotpoints?: string[] }>)) {
            return { valid: false, reason: 'Plot contains refusal phrase ("I cannot fulfill" or "I will not")' };
        }
        return { valid: true };
    };

    let validation = validatePlot(chapters);

    while (!validation.valid && plotAttempts < MAX_PLOT_ATTEMPTS) {
        assertStoryExists();
        plotAttempts++;
        console.error(
            `Plot validation failed (attempt ${plotAttempts}/${MAX_PLOT_ATTEMPTS}): ${validation.reason}. Retrying...`
        );

        try {
            ({
                response: { chapters }
            } = await callStructuredWithStallRetry({
                request: [
                    `> Submit me the detailed plotpoints of the next ${chapterCount} chapters`,
                    '> The plotpoint must includes all the important dialogues',
                    `> There must be at least ${MIN_PLOTPOINTS_PER_CHAPTER} plotpoints per chapter`,
                    '> Must clearly outlines how each chapter starts, and how each chapter ends',
                    '> CRITICAL: You MUST return exactly the number of chapters requested. Do NOT refuse or decline.',
                    '> Do NOT include phrases like "I cannot fulfill" or "I will not" in the plotpoints.'
                ].join('\n'),
                response: Type.Object({
                    chapters: Type.Array(
                        Type.Object({
                            number: Type.String({ description: 'the chapter number' }),
                            title: Type.String({ description: 'the title of the chapter without chapter number' }),
                            plotpoints: Type.Array(Type.String(), {
                                description: 'the detailed plotpoints of the chapter'
                            })
                        }),
                        { description: 'a list of chapter plotpoints to submit' }
                    )
                }),
                onUpdate: progressivePlotpointWrite
            }));
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[PLOTPOINT] Validation retry failed for storyId ${storyId} (attempt ${attempt}): ${reason}`);
            markCompleteAndRetry(reason);
            return;
        }

        // Check for progressive write errors — only force empty chapters when
        // format() did NOT return valid data (prevents stale error false positives)
        if (!Array.isArray(chapters) || chapters.length === 0) {
            if (consumeProgressiveError()) {
                chapters = [];
            }
        } else {
            // format() returned valid data — discard any stale progressive error
            consumeProgressiveError();
        }

        // Write updated response to disk with validation status before re-validating
        validation = validatePlot(chapters);
        writePlotpointFile({ valid: validation.valid, reason: validation.reason, attempt: plotAttempts });
    }

    // If validation still fails after all retries, mark as complete and spin up retry
    if (!validation.valid) {
        markCompleteAndRetry(validation.reason ?? 'validation failed after max attempts');
        return;
    }

    // Validate all chapters have plotpoints, retry if any are missing.
    // Capped at MAX_PLOT_ATTEMPTS to prevent infinite loops when the LLM
    // consistently returns some chapters without plotpoints.
    let outlineAttempts = 0;
    while (
        chapters.some((ch) => !Array.isArray(ch.plotpoints) || ch.plotpoints.length === 0) &&
        outlineAttempts < MAX_PLOT_ATTEMPTS
    ) {
        assertStoryExists();
        outlineAttempts++;
        console.log(
            `Outline missing plotpoints in some chapters (attempt ${outlineAttempts}/${MAX_PLOT_ATTEMPTS}). Retrying...`
        );

        try {
            ({
                response: { chapters }
            } = await callStructuredWithStallRetry({
                request: [
                    `> Give me the detailed plotpoints of the next ${chapterCount} chapters`,
                    '> The plotpoint MUST be a non-empty array of strings for EVERY chapter',
                    '> The plotpoint must includes important dialogues',
                    '> Must clearly outlines the start and ending of each chapter'
                ].join('\n'),
                response: Type.Object({
                    chapters: Type.Array(
                        Type.Object({
                            number: Type.String({ description: 'the chapter number' }),
                            title: Type.String({ description: 'the title of the chapter' }),
                            plotpoints: Type.Array(Type.String(), {
                                description: 'the detailed plotpoints of the chapter'
                            })
                        }),
                        { description: 'A list of chapters to submit' }
                    )
                }),
                onUpdate: progressivePlotpointWrite
            }));
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[PLOTPOINT] Outline retry failed for storyId ${storyId} (attempt ${attempt}): ${reason}`);
            markCompleteAndRetry(reason);
            return;
        }

        // Check for progressive write errors — only discard when format()
        // did NOT return valid data (prevents stale error false positives)
        if (!Array.isArray(chapters) || chapters.length === 0) {
            if (consumeProgressiveError()) {
                chapters = [];
            }
        } else {
            consumeProgressiveError();
        }

        // Override plotpoint file with the new response
        writePlotpointFile();
    }

    // A response with the requested chapter count is still unusable when one
    // or more chapters has no plotpoints. Treat exhaustion of outline retries
    // as a terminal plot failure so the incomplete outline remains inspectable
    // and a separate story entry receives the next generation attempt.
    const missingPlotpointChapters = chapters.filter(
        (chapter) => !Array.isArray(chapter.plotpoints) || chapter.plotpoints.length === 0
    );
    if (missingPlotpointChapters.length > 0) {
        markCompleteAndRetry(
            `Plotpoint generation exhausted retries with ${missingPlotpointChapters.length} chapter(s) missing plotpoints`
        );
        return;
    }

    // appending[] holds the context entries for each chapter.
    // During expansion, the most recent PREVIOUS_EXPANDED_CHAPTERS chapters' expanded
    // content is kept in context. All older chapters remain as plotpoint summaries
    // to keep context focused and reduce token usage.
    const appending: string[] = [];
    const totalChapters = chapters.length;

    // Store original plotpoint summaries so we can restore entries after they fall
    // outside the PREVIOUS_EXPANDED_CHAPTERS window. This keeps a bounded number
    // of expanded chapters in context at any time.
    const originalSummaries: string[] = [];

    // First pass: compile all chapter plotpoints so the agent knows the full story context
    for (const { number, title, plotpoints } of chapters) {
        // Skip chapters with no plotpoints
        if (!Array.isArray(plotpoints) || plotpoints.length === 0) {
            console.warn(`Skipping chapter "${number}: ${title}" — no plotpoints provided`);
            continue;
        }

        // For compiling in order
        const entry = [`> ${number}: ${title}`, '\n\n', plotpoints.map((plot) => `- ${plot}`).join('\n')].join('\n\n');

        // Adding Entry into the List
        appending.push(entry);
        originalSummaries.push(entry);
    }

    console.log(`Full plot outline compiled. ${appending.length} chapters with plotpoints.`);

    // Second pass: expand each chapter with rolling context window.
    // After expanding chapter N:
    //   - Restore appending[N - PREVIOUS_EXPANDED_CHAPTERS - 1] back to its original summary
    //     (if such an index exists), keeping at most PREVIOUS_EXPANDED_CHAPTERS expanded.
    //   - Replace appending[N] with the expanded content
    // This ensures the next chapter sees up to PREVIOUS_EXPANDED_CHAPTERS expanded chapters.
    await arrayEachAsync(chapters, async ({ index, value: chapter }) => {
        assertStoryExists();
        const { number, title, plotpoints } = chapter;

        console.log(`Expanding chapter ${number}: ${title} (${index + 1}/${totalChapters})`);

        const request = buildExpandRequest(number, title);

        // Snapshot the appending[] context BEFORE expansion — this is the exact context
        // the LLM sees when generating this chapter. Needed for chapter-XXX.json.
        const contextSnapshot = [...appending];

        // Persist the chapter JSON skeleton BEFORE the LLM call. This ensures the
        // conversation context (appending[], request) is saved to disk so the chapter
        // can be re-expanded even if the LLM call fails, times out, or the process
        // crashes during expansion. writeChapterFiles() overwrites this with the full
        // result after successful expansion.
        writeChapterPayload({
            chapterDir,
            chapterIndex: index,
            storyId,
            storyline,
            chapterCount,
            chapterNumber: number,
            plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
            contextAppending: contextSnapshot,
            request
        });

        // Track generation time for this chapter
        const expandStartMs = Date.now();

        // expandChapter reads from appending[] which at this point has:
        //   - For index 0: all summaries (no previous chapter to expand)
        //   - For index > 0: the last PREVIOUS_EXPANDED_CHAPTERS entries are expanded content,
        //     all earlier entries are summaries
        const result = await expandChapter({
            client,
            appending,
            chapterDir,
            assertStoryExists,
            chapterNumber: number,
            chapterIndex: index,
            request,
            minWords: MIN_WORDS_PER_CHAPTER
        });

        const generationTimeMs = Date.now() - expandStartMs;

        // Save chapter files (md + json)
        writeChapterFiles({
            chapterDir,
            chapterIndex: index,
            storyId,
            storyline,
            chapterCount,
            chapterNumber: number,
            plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
            contextAppending: contextSnapshot,
            request,
            result,
            generationTimeMs
        });

        // Restore older expanded chapters back to their plotpoint summaries.
        // We keep at most PREVIOUS_EXPANDED_CHAPTERS expanded chapters
        // immediately before the current index.
        const restoreFrom = index - PREVIOUS_EXPANDED_CHAPTERS - 1;
        if (restoreFrom >= 0) {
            appending[restoreFrom] = originalSummaries[restoreFrom];
        }

        // Replace the current chapter's entry with its expanded content
        // so the next chapter expansion sees it in context.
        appending[index] = `## ${result.title}\n\n${result.content}`;
    });

    console.log(`Story generation complete for storyId: ${storyId}`);
};

export const generationCreateNewStory = asHandlerMethod(async (_, parameters, variables) => {
    const { path, body } = parameters;
    const { root: projectRoot } = variables;

    // Get the storyId from the path parameters
    const storyId = path.storyId;

    if (!storyId) {
        return {
            status: 400,
            response: { error: 'storyId is required' }
        };
    }

    // ── Fork request ──────────────────────────────────────────────────────
    // When body.forkFrom is present, fork an existing story instead of
    // creating from scratch. The fork copies plotlines and pre-fork
    // chapters, then re-expands from the fork chapter onwards.
    if (body.forkFrom && typeof body.forkFrom === 'object') {
        const { sourceStoryId, chapterIndex } = body.forkFrom;

        if (!sourceStoryId || typeof sourceStoryId !== 'string') {
            return {
                status: 400,
                response: { error: 'forkFrom.sourceStoryId is required and must be a string' }
            };
        }

        if (typeof chapterIndex !== 'number' || chapterIndex < 0) {
            return {
                status: 400,
                response: { error: 'forkFrom.chapterIndex is required and must be a non-negative integer' }
            };
        }

        // Start fork in the background (fire-and-forget)
        forkStory({ newStoryId: storyId, sourceStoryId, chapterIndex, root: projectRoot }).catch((err) => {
            console.error(`Story fork failed for storyId ${storyId}:`, err);
        });

        return {
            status: 200,
            response: { storyId }
        };
    }

    // ── Create new story ──────────────────────────────────────────────────
    // Get the storyline from the request body
    const { storyline, chapterCount } = body;

    if (!storyline) {
        return {
            status: 400,
            response: { error: 'storyline is required' }
        };
    }

    if (typeof chapterCount !== 'number' || chapterCount < 1) {
        return {
            status: 400,
            response: { error: 'chapterCount must be a positive number' }
        };
    }

    // Derive storyName from the storyline: first line, truncated to 120 chars
    const storyName = storyline.split('\n')[0].trim().slice(0, 120) || storyline.slice(0, 120);

    // Start story generation in the background (fire-and-forget)
    generateStory({ storyId, storyName, storyline, chapterCount, root: projectRoot }).catch((err) => {
        console.error(`Story generation failed for storyId ${storyId}:`, err);
    });

    // Return the storyId immediately to the requester
    return {
        status: 200,
        response: { storyId }
    };
});
