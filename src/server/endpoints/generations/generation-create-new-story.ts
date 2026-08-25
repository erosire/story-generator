import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { type TSchema, Type } from '@sinclair/typebox';
import { arrayEach, arrayEachAsync, jsonComplete } from '@presource/core';
import {
    DATABASE_BASE_DIR,
    MAX_PLOT_ATTEMPTS,
    MAX_STALL_RETRIES,
    MIN_PLOTPOINTS_PER_CHAPTER,
    MIN_WORDS_PER_CHAPTER,
    parseClientId,
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
import { appendStoryChapters, validateAppendableStory } from './generation-append-story';
import { resumeStoryPlotlines, validateResumableStory } from './generation-resume-story';
import { acquireStoryJob, releaseStoryJob } from './generation-job-registry';

// Generate the story in the background
const generateStory = async (options: {
    storyId: string;
    storyName: string;
    storyline: string;
    chapterCount: number;
    root: string;
    // Per-request LLM client id (validated by parseClientId in the handler).
    // Not persisted — travels with the request and is used for every
    // per-chapter attempt of the generation.
    clientId?: string;
    // Plotline-only mode (the dashboard Generate button): after plotline
    // validation writes a skeleton chapter-XXX.json payload for EVERY chapter
    // and stops — chapters are never auto-expanded by this call. The user
    // expands chapters one at a time via PATCH expandChapterIndex
    // (generation-update-chapter.ts), which reads each skeleton's stored LLM
    // context.
    plotOnly?: boolean;
}) => {
    const { storyId, storyName, storyline, chapterCount, root: projectRoot } = options;
    const plotOnly = options.plotOnly ?? false;

    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR, storyId);

    // Reserve the story directory before any asynchronous work begins. A
    // duplicate POST must never reopen an existing story, especially a failed
    // story whose plotpoints are being kept for manual use.
    // The non-recursive mkdir is the filesystem-level guard that prevents two
    // same-ID generators from both passing an existsSync check.
    fs.mkdirSync(path.dirname(databaseDir), { recursive: true });
    fs.mkdirSync(databaseDir, { recursive: false });

    // Create a fresh client only after the new story entry has been reserved.
    // This prevents duplicate requests from consuming an LLM client while the
    // original story directory remains the sole owner of the generation.
    // options.clientId selects the LLM client from the request payload — absent
    // id falls back to the default (CLIENT) inside resolveClient.
    const client = createStoryClient(options.clientId);

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

    // Accumulated outline: one slot per chapter, filled sequentially by the
    // per-chapter generation loop. Streaming partials land in the slot of the
    // chapter currently being generated; accepted chapters stay put. A failed
    // generation therefore retains every usable chapter instead of an empty
    // array (markStoryFailed writes this array verbatim).
    const chapters: Array<{ number: string; title: string; plotpoints: string[] }> = [];
    let plotAttempts = 0;

    // Once failure is committed, every late callback from the failed LLM call
    // must become a no-op; the failed directory is then immutable until a user
    // explicitly edits or expands it.
    let storyFailed = false;

    // Each streamed plot request receives a token. A timed-out request may
    // continue emitting callbacks after Promise.race rejects, so callbacks from
    // older request tokens must not write over the current story state.
    let activePlotCallId = 0;

    // Chapter-scoped progressive write: the streamed JSON is ONE chapter
    // object ({number,title,plotpoints}) for the chapter currently being
    // generated. The on-disk outline is the accepted chapters (slots
    // 0..chapterIndex-1) plus this streamed chapter merged at its slot —
    // the outline grows one chapter at a time as calls succeed.
    const progressivePlotpointWrite = async (chapterIndex: number, rawContent: string) => {
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
        // Chapter numbers are not model output — the chapter being streamed is
        // known by position (chapterIndex), so the number is assigned here.
        const partialChapter = {
            number: String(chapterIndex + 1),
            title: String(parsed.title ?? ''),
            plotpoints: Array.isArray(parsed.plotpoints) ? parsed.plotpoints : []
        };

        // Merge the streaming chapter into its slot so markStoryFailed
        // can preserve the plotpoints that were available before the failure.
        chapters[chapterIndex] = partialChapter;

        // The stream can yield control through an async callback boundary. Check
        // the terminal flag again immediately before touching the failed entry.
        if (storyFailed) return;

        // Only slots 0..chapterIndex are materialized — slice guards against
        // a sparse tail if a later chapter somehow streamed first.
        const visibleChapters = chapters.slice(0, chapterIndex + 1);
        const plotpointJson = {
            storyId,
            storyName,
            storyline,
            chapterCount,
            chapters: visibleChapters,
            status: 'generating',
            createdAt
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointJson, null, 2), 'utf-8');
        console.log(
            `Plotpoint JSON (progressive) written to ${plotpointJsonPath} (${visibleChapters.length} chapters, streaming chapter ${chapterIndex + 1})`
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

    // ── Terminal failure handling ─────────────────────────────────────────
    // On any unrecoverable failure (validation exhaustion, repeated call
    // errors, stalls), mark the current story as "failed" — WITHOUT spinning
    // up a new story entry. The old one-shot outline (a single response
    // covering every chapter) needed the story-level [retry N] chain because
    // a bad response meant regenerating everything from scratch. Progressive
    // generation instead retries the failed chapter's IDENTICAL payload in
    // place (see the chapter loop below) — the model gets another attempt
    // without the server telling it that it was wrong — so a terminal failure
    // here just preserves the entry in the list, where it can be inspected,
    // forked, or expanded manually.
    /**
     * Mark the current story as failed and stop generation for this entry.
     */
    const markStoryFailed = (reason: string) => {
        // Failure handling can be reached by more than one asynchronous path
        // when a stream races a timeout. Commit it once so no late callback
        // can rewrite the failed entry.
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
                `${chapters.length} chapter(s) preserved)`
        );
    };

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

    // Write the LLM's plotpoint response to disk immediately (before validation).
    // This ensures plotpoint.json always reflects the latest LLM output
    // so it can be inspected even when validation fails.
    // NOTE: plotpoint.md is only written for manual debugging — the API reads .json only.
    //
    // Optional `status` override: only plotline-only completion passes
    // 'completed' here (chapters are never auto-expanded, so chapterCompleted
    // stays 0 and the list endpoint's deriveStatus — generation-list-stories.ts
    // — would otherwise report 'generating' forever). Full-generation calls
    // omit it: those stories never write a top-level status field and keep
    // deriving 'completed' from chapter-completion counts.
    const writePlotpointFile = (
        validationStatus?: {
            valid: boolean;
            reason?: string;
            attempt: number;
        },
        status?: string
    ) => {
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
            createdAt,
            ...(status ? { status } : {})
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

    // ── Progressive per-chapter plotpoint generation (agentic chain) ────────
    // Request ONE chapter's plotpoints per structured call until all
    // chapterCount chapters are collected, instead of asking for the entire
    // outline in a single response. After each successful call the request and
    // the model's tool call are committed to the conversation history, so the
    // request for chapter N sees chapters 1..N-1 already present as sequential
    // tool calls — the model returns each chapter's plotpoints in a tool call
    // and we request the next one from there.
    //
    // Benefits over the one-shot outline this replaced:
    //   - Each response spans a single chapter → smaller outputs, less stall
    //     surface, fewer truncated/malformed JSON failures.
    //   - Validation (plotpoint count below MIN_PLOTPOINTS_PER_CHAPTER,
    //     refusal phrases) retries ONLY the failing chapter instead of
    //     regenerating the whole outline; the old validation and
    //     missing-plotpoint loops collapsed into the per-chapter retry
    //     budget below.
    //   - The chapter count is structurally guaranteed by the loop, so the
    //     old "Chapter count mismatch" failure mode no longer exists.
    // No `number` field in the schema: chapters are generated one call at a
    // time, so the server already knows each chapter's sequential position and
    // assigns the number itself (chapterLabel) — asking the model to echo a
    // number would only invite off-by-one drift.
    const chapterPlotpointSchema = Type.Object({
        title: Type.String({ description: 'the title of the chapter without the chapter number' }),
        plotpoints: Type.Array(Type.String(), {
            description:
                'List of plotpoints. Each entry summarises the important events and dialogues that happens in the chapter. Must be in simple and concise dot points'
        })
    });

    for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex++) {
        const chapterLabel = chapterIndex + 1;
        console.log(`Generating plotpoints for chapter ${chapterLabel}/${chapterCount} (storyId: ${storyId})`);

        // The chapter's request — re-issued VERBATIM on every retry. The model
        // gets another attempt without the server telling it that it was wrong:
        // no escalation, no refusal meta-instructions, no mention of prior
        // failures (the failed attempt never enters the conversation chain).
        const request = [
            `> Submit me the detailed plotpoints of the next chapter (chapter ${chapterLabel} of ${chapterCount})`,
            '> The plotpoint must includes all the important dialogues happens in the chapter',
            `> There must be at least ${MIN_PLOTPOINTS_PER_CHAPTER} plotpoints for the chapter`,
            '> Must clearly outlines how the chapter starts, and how the chapter ends with the first and last plotpoints only',
            '> Do not include plotpoints or events that belong to any other chapter'
        ].join('\n');

        let acceptedChapter: { number: string; title: string; plotpoints: string[] } | null = null;
        let chapterFailureReason = `chapter ${chapterLabel} plotpoint generation produced no usable response`;

        // 1 initial attempt + up to MAX_PLOT_ATTEMPTS retries for THIS chapter.
        // On retry only this chapter is re-asked, with the byte-identical
        // payload — earlier accepted chapters stay untouched in the
        // conversation chain.
        for (let chapterAttempt = 0; chapterAttempt <= MAX_PLOT_ATTEMPTS && !acceptedChapter; chapterAttempt++) {
            assertStoryExists();
            // Count retry attempts (not the initial call) for the validation record.
            if (chapterAttempt > 0) plotAttempts++;

            let response: { title: string; plotpoints: string[] };
            try {
                ({ response } = await callStructuredWithStallRetry({
                    request,
                    response: chapterPlotpointSchema,
                    // Chapter-scoped progressive write: merges this streaming
                    // chapter into the accumulated outline on disk.
                    onUpdate: (raw) => progressivePlotpointWrite(chapterIndex, raw)
                }));
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                // A deleted story folder aborts immediately — there is nothing
                // left to retry into (assertStoryExists contract).
                if (!fs.existsSync(databaseDir)) throw err;
                // Any other failure retries the identical payload in place.
                chapterFailureReason = reason;
                console.error(
                    `[PLOTPOINT] Chapter ${chapterLabel} call failed ` +
                        `(attempt ${chapterAttempt + 1}/${MAX_PLOT_ATTEMPTS + 1}): ${reason}. Retrying identical request...`
                );
                continue;
            }

            // format()/structure() only resolve on schema-valid data — any
            // streaming JSON error recorded by the progressive buffer is stale
            // (same stale-error guard as the old flow, minus the empty-chapters
            // branch: the outline is accumulated, never wholesale replaced).
            consumeProgressiveError();

            // Normalize. The chapter number is server-assigned (sequential
            // generation, see chapterPlotpointSchema); only title/plotpoints
            // come from the model (the fallbacks keep proxies/models that echo
            // blank fields from breaking the chain).
            const normalized = {
                number: String(chapterLabel),
                title: String(response.title ?? ''),
                plotpoints: Array.isArray(response.plotpoints) ? response.plotpoints : []
            };

            // Preserve the latest attempt (accepted or not) under the chapter's
            // slot so a terminal failure keeps the broken chapter inspectable in
            // the failed plotpoint.json — the old flow did the same with the
            // last invalid whole-outline response.
            chapters[chapterIndex] = normalized;

            // Per-chapter validation, sharing this retry budget — the retry
            // itself is the identical request above, not a corrective prompt.
            //
            // Refusal phrases are checked FIRST: a refusal is a content-level
            // rejection and must keep its distinct terminal failure reason
            // even when the refusing response also falls short of the minimum
            // plotpoint count.
            if (detectRefusals([normalized])) {
                chapterFailureReason = `chapter ${chapterLabel} contains refusal phrase ("I cannot fulfill" or "I will not")`;
                console.error(
                    `Chapter ${chapterLabel} plotpoint validation failed ` +
                        `(attempt ${chapterAttempt + 1}/${MAX_PLOT_ATTEMPTS + 1}): ${chapterFailureReason}. Retrying identical request...`
                );
                continue;
            }
            // Minimum count: the prompt above demands at least
            // MIN_PLOTPOINTS_PER_CHAPTER plotpoints, so any SHORTER list fails
            // validation and retries the byte-identical payload. MORE than the
            // minimum is always accepted. This check subsumes the old
            // empty-plotpoints branch (0 is below the minimum).
            if (normalized.plotpoints.length < MIN_PLOTPOINTS_PER_CHAPTER) {
                chapterFailureReason =
                    `chapter ${chapterLabel} returned ${normalized.plotpoints.length} plotpoints ` +
                    `(minimum: ${MIN_PLOTPOINTS_PER_CHAPTER})`;
                console.error(
                    `Chapter ${chapterLabel} plotpoint validation failed ` +
                        `(attempt ${chapterAttempt + 1}/${MAX_PLOT_ATTEMPTS + 1}): ${chapterFailureReason}. Retrying identical request...`
                );
                continue;
            }

            acceptedChapter = normalized;
        }

        // Terminal per-chapter failure — keep the broken chapter in the failed
        // entry and stop (no [retry N] story entry is spun up).
        if (!acceptedChapter) {
            markStoryFailed(chapterFailureReason);
            return;
        }

        // ── Agentic chain step ────────────────────────────────────────────
        // Commit the successful exchange to the conversation history: the user
        // request that produced this chapter, then an assistant message
        // carrying the chapter's tool call. structure()/format() append the
        // NEXT request only to a local copy of the messages (they never mutate
        // client.messages — simple-client.ts:1010-1013/:1279-1281), so only
        // what is committed here is visible to the next chapter's call: chapter
        // N+1 is generated with chapters 1..N present as sequential tool calls.
        // The tool-call JSON follows the harness convention of storing tool
        // calls as assistant message content (simple-harness.ts:208-215) and
        // uses the well-known structure tool name 'respond'
        // (simple-client.ts:1025) — exactly what the model emitted.
        client.user(request);
        client.assistant(
            JSON.stringify({
                tool_calls: [
                    {
                        id: `call_plotpoint_chapter_${chapterLabel}`,
                        type: 'function',
                        function: { name: 'respond', arguments: JSON.stringify(acceptedChapter) }
                    }
                ]
            })
        );

        // Finalize the chapter on disk (plotpoint.json + plotpoint.md). This
        // per-chapter validation record is informational — the terminal
        // plotline-only write below overwrites it with 'plotline complete'.
        writePlotpointFile({
            valid: true,
            reason: `chapter ${chapterLabel}/${chapterCount} plotpoints accepted`,
            attempt: plotAttempts
        });
        console.log(
            `Chapter ${chapterLabel}/${chapterCount} plotpoints accepted: "${acceptedChapter.title}" ` +
                `(${acceptedChapter.plotpoints.length} plotpoints)`
        );
    }

    // ── Plotline-only completion (dashboard Generate button) ──────────────
    // plotOnly: the API stops here and NEVER calls the LLM for chapter
    // expansion. Everything below (appending[] context + per-chapter
    // expansion loop) runs only for legacy full-generation calls.
    //
    // A skeleton chapter-XXX.json payload is written for every chapter with
    // the exact context the first expansion would have seen: all-plotline
    // summaries + buildExpandRequest. Without this, the UI's per-chapter
    // "Expand Chapter" action (PATCH expandChapterIndex) would 404 —
    // generation-update-chapter.ts reads the stored LLM context from
    // chapter-XXX.json before re-expanding. Once a user expands a chapter,
    // reExpandChapter (generation-update-chapter.ts) propagates its expanded
    // content into the next chapter's skeleton payload, so later expansions
    // still see the preceding prose.
    //
    // Client interaction: the dashboard's target-mode poll
    // (pollStoryData in src/api/storyboard.ts) keeps the GET loop alive
    // until every chapter is expanded, so for a plotline-only story it
    // doubles as a live-refresh loop and is cancelled by shouldStop() when
    // the user switches stories or unmounts. Individual chapter expansions
    // run their own completion poll (SectionStoryContent reExpand effect).
    if (plotOnly) {
        assertStoryExists();

        // Compile one plotline summary per chapter — identical entries to
        // what the expansion pass below would push into appending[] at the
        // start. Plotlines are guaranteed non-empty here (missingPlotpointChapters
        // check above), so map is safe and deterministic.
        const summaryList = chapters.map(({ number, title, plotpoints }) =>
            [`> ${number}: ${title}`, '\n\n', plotpoints.map((plot) => `- ${plot}`).join('\n')].join('\n\n')
        );

        // Persist a skeleton payload per chapter so each one is immediately
        // expandable from the UI (canReExpand=true in the GET response).
        arrayEach(chapters, ({ index, value: chapter }) => {
            assertStoryExists();
            writeChapterPayload({
                chapterDir,
                chapterIndex: index,
                storyId,
                storyline,
                chapterCount,
                chapterNumber: chapter.number,
                plotpoints: Array.isArray(chapter.plotpoints) ? chapter.plotpoints : [],
                contextAppending: [...summaryList],
                request: buildExpandRequest(chapter.number, chapter.title)
            });
        });

        // Final state: plotline complete. status 'completed' tells the list
        // endpoint (deriveStatus, generation-list-stories.ts) this story is
        // done — chapterCompleted stays 0 and only advances as the user
        // expands chapters (incrementPlotpointChapterCompleted in
        // story-utils.ts bumps it for each first-time expansion).
        writePlotpointFile({ valid: true, reason: 'plotline complete', attempt: plotAttempts }, 'completed');

        console.log(
            `Plotline generation complete for storyId: ${storyId} (${chapters.length} chapters) — plot-only, chapter expansion skipped`
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

    // ── Validate the per-request LLM clientId (optional) ──────────────────
    // Runs BEFORE the fork/create branches so both paths share one contract:
    // an explicit unknown or non-string clientId is a 400, an absent clientId
    // is legal (generation falls back to the default client in resolveClient).
    // The value is never stored — it only selects the client for this request
    // and every per-chapter attempt of its background generation.
    const clientIdCheck = parseClientId(body.clientId);
    if (clientIdCheck.error) {
        return {
            status: 400,
            response: { error: clientIdCheck.error }
        };
    }
    const clientId = clientIdCheck.clientId;

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

        // Start fork in the background (fire-and-forget). The fork re-expands
        // chapters with the same per-request clientId the caller selected.
        // The job registry guard rejects a second concurrent job on the same
        // storyId (see generation-job-registry.ts).
        if (!acquireStoryJob(storyId)) {
            return {
                status: 400,
                response: { error: `Story '${storyId}' already has a generation job in progress` }
            };
        }
        forkStory({ newStoryId: storyId, sourceStoryId, chapterIndex, clientId, root: projectRoot })
            .catch((err) => {
                console.error(`Story fork failed for storyId ${storyId}:`, err);
            })
            .finally(() => releaseStoryJob(storyId));

        return {
            status: 200,
            response: { storyId }
        };
    }

    // ── Append request ──────────────────────────────────────────────────────
    // When body.append is present, EXTEND the existing story in place (the
    // dashboard's "[->]" append dialog): the LLM generates plotlines for
    // append.chapterCount NEW chapters which are stored AFTER the current
    // chapter list (10 existing + 3 appended = 13 chapters). Unlike fork
    // (new storyId) and create (fresh storyId), append targets the SAME
    // storyId the path carries. See generation-append-story.ts for the full
    // semantics — plotpoints only, no chapter expansion, skeleton payloads
    // written so the new chapters are expandable via PATCH.
    //
    // `notes` is optional free-form author guidance injected into the plotline
    // prompt. A blank/whitespace-only notes value is a 400 (the client omits
    // the field when the textarea is empty instead of sending ''); a non-empty
    // value is forwarded trimmed.
    if (body.append && typeof body.append === 'object') {
        const { chapterCount, notes } = body.append;

        if (typeof chapterCount !== 'number' || chapterCount < 1) {
            return {
                status: 400,
                response: { error: 'append.chapterCount must be a positive number' }
            };
        }

        if (notes !== undefined && (typeof notes !== 'string' || notes.trim().length === 0)) {
            return {
                status: 400,
                response: { error: 'append.notes must be a non-empty string' }
            };
        }

        // Synchronous story validation BEFORE firing the background job so the
        // client gets the exact 400 reason (unknown story, missing plotpoint.json,
        // no storyline, no plotpoints) instead of a silent background failure.
        try {
            validateAppendableStory(projectRoot, storyId);
        } catch (err: any) {
            return {
                status: 400,
                response: { error: err?.message ?? `Story '${storyId}' cannot be appended to` }
            };
        }

        // Start the append in the background (fire-and-forget) — LLM plotline
        // generation takes seconds to minutes; the dashboard's GET polling
        // picks up the rewritten plotpoint.json when it lands. The per-request
        // clientId (validated above) selects the model for the plotline call.
        if (!acquireStoryJob(storyId)) {
            return {
                status: 400,
                response: { error: `Story '${storyId}' already has a generation job in progress` }
            };
        }
        appendStoryChapters({
            storyId,
            chapterCount,
            notes: notes !== undefined ? notes.trim() : undefined,
            clientId,
            root: projectRoot
        })
            .catch((err) => {
                console.error(`Story append failed for storyId ${storyId}:`, err);
            })
            .finally(() => releaseStoryJob(storyId));

        return {
            status: 200,
            response: { storyId, appended: chapterCount }
        };
    }

    // ── Resume request ────────────────────────────────────────────────────
    // When body.resume is present, CONTINUE the existing story's interrupted
    // plotline generation in place (the dashboard's resume button — shown
    // when a story's chapter list no longer grows, e.g. after a server
    // restart killed the original background job, or after markStoryFailed
    // exhausted a chapter's retry budget). Unlike append (extends beyond the
    // current total), resume fills UP TO the chapter target: the complete
    // prefix of existing chapters is kept, the partial/failed tail is
    // regenerated, and chapterCount moves only when resume.chapterCount
    // raises it past meta.chapterCount (interrupted-append case).
    //
    // `resume.chapterCount` is optional — absent → the story's own
    // meta.chapterCount target. Present → the total the client expected
    // (its chapterRequested while it still remembers an interrupted append).
    if (body.resume && typeof body.resume === 'object') {
        const { chapterCount: resumeTarget } = body.resume;

        if (resumeTarget !== undefined && (typeof resumeTarget !== 'number' || resumeTarget < 1)) {
            return {
                status: 400,
                response: { error: 'resume.chapterCount must be a positive number' }
            };
        }

        // Synchronous resumability check BEFORE firing the background job so
        // the client surfaces the exact 400 reason (unknown story, corrupted
        // plotpoint.json, no storyline, nothing left to resume).
        let resumable;
        try {
            resumable = validateResumableStory(projectRoot, storyId, resumeTarget);
        } catch (err: any) {
            return {
                status: 400,
                response: { error: err?.message ?? `Story '${storyId}' cannot be resumed` }
            };
        }

        // Start the resume in the background (fire-and-forget), guarded by the
        // job registry so a click during genuine in-flight generation is a
        // clean 400 instead of two writers corrupting plotpoint.json.
        if (!acquireStoryJob(storyId)) {
            return {
                status: 400,
                response: { error: `Story '${storyId}' already has a generation job in progress` }
            };
        }
        resumeStoryPlotlines({
            storyId,
            chapterCount: resumeTarget,
            clientId,
            root: projectRoot
        })
            .catch((err) => {
                console.error(`Story resume failed for storyId ${storyId}:`, err);
            })
            .finally(() => releaseStoryJob(storyId));

        // `resumed` = chapters about to be regenerated; `chapterCount` = the
        // final target so the client can align its chapterRequested.
        return {
            status: 200,
            response: { storyId, resumed: resumable.remaining, chapterCount: resumable.target }
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

    // Start story generation in the background (fire-and-forget). clientId is
    // optional — absent id means the default client (see resolveClient).
    //
    // plotOnly: true — the dashboard's Generate button only asks for the
    // plotline: chapters are produced as plotpoints and stop there. No LLM
    // chapter expansion happens in this request; the user expands individual
    // chapters afterwards via PATCH expandChapterIndex (generation-update-chapter.ts),
    // which consumes the skeleton chapter payloads written by the plotline
    // pass. Fork requests above keep the full plotline + expansion flow.
    //
    // The job registry guard turns a duplicate POST for the same storyId into
    // a clean 400 instead of a background crash at the reserved-directory mkdir
    // (generateStory fs.mkdirSync, line 59), and stops create from racing a
    // resume already running for the same story.
    if (!acquireStoryJob(storyId)) {
        return {
            status: 400,
            response: { error: `Story '${storyId}' already has a generation job in progress` }
        };
    }
    generateStory({
        storyId,
        storyName,
        storyline,
        chapterCount,
        clientId,
        plotOnly: true,
        root: projectRoot
    })
        .catch((err) => {
            console.error(`Story generation failed for storyId ${storyId}:`, err);
        })
        .finally(() => releaseStoryJob(storyId));

    // Return the storyId immediately to the requester
    return {
        status: 200,
        response: { storyId }
    };
});
