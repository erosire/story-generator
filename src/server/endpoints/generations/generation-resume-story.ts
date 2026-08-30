// ---------------------------------------------------------------------------
// Resume handler — continues PLOTLINE generation for a story whose
// generation stopped before its chapter target was reached.
//
// Triggered by the dashboard's resume button (SectionStoryContent), which
// POSTs { resume: { chapterCount? } } to the story's own storyId (the branch
// sits in generation-create-new-story.ts after the append branch).
//
// Why this exists: background generation jobs (generateStory in
// generation-create-new-story.ts) are plain async functions — a server
// restart / crash kills them mid-flight, leaving plotpoint.json frozen with
// status 'generating' and fewer chapters than chapterCount. markStoryFailed
// (validation budget exhausted) is a second stop mode: status 'failed' with
// every accepted chapter preserved. Both states are resumable.
//
// Resume semantics:
//   - The resumable baseline is the COMPLETE PREFIX of meta.chapters: a
//     chapter counts as complete only when it passes the SAME acceptance
//     checks as the create flow (generation-create-new-story.ts:534-556 —
//     no refusal phrase, >= MIN_PLOTPOINTS_PER_CHAPTER plotpoints). Anything
//     from the first incomplete chapter onward is a partially-streamed or
//     failed tail and is REGENERATED from scratch.
//   - The chapter target defaults to meta.chapterCount (the number the
//     original Generate asked for). The caller may raise it
//     (resume.chapterCount) — that covers an interrupted APPEND, where the
//     intended larger total only existed in the client's chapterRequested
//     (mergeServerStoryList eventually rolls it back, so the client sends it
//     while it still knows it). Raising the target rewrites chapterCount on
//     success; lowering a target below the complete prefix is a 400
//     ('already complete').
//   - Generation mirrors the create flow's per-chapter agentic chain: ONE
//     structured call per missing chapter with the byte-stable request
//     wording (generation-create-new-story.ts:462-468), re-issued VERBATIM
//     on up to MAX_PLOT_ATTEMPTS retries. A single-call-for-everything
//     approach (the append flow's) is deliberately avoided here: resuming a
//     story that died on chapter 1 would mean one giant call spanning every
//     chapter — the exact stall/truncation failure mode the per-chapter loop
//     was built to eliminate.
//   - The LLM is primed like append (user(STORY_REQUEST_MESSAGE) +
//     assistant(storyline)), then the complete-prefix summaries (recent
//     expanded chapters' prose replacing their summaries — same pattern as
//     generation-append-story.ts:156-167) are committed as ONE assistant
//     message (expandChapter's convention, story-utils.ts:212). Accepted
//     regenerated chapters chain as tool-call messages exactly like create
//     (generation-create-new-story.ts:580-591). NOTE: appendStoryChapters
//     never injects its summaries into the actual request; resume does —
//     without them the model would continue blind from the storyline alone.
//   - plotpoint.json is rewritten after EVERY accepted chapter (status
//     'generating') so the dashboard's GET polling watches the outline grow
//     back chapter by chapter. plotpoint.md is rebuilt from the current
//     chapter list on the same cadence (create's writePlotpointFile
//     convention, generation-create-new-story.ts:407-420).
//   - Terminal failure mirrors markStoryFailed: status 'failed' + validation
//     record, every accepted chapter preserved plus the broken latest
//     attempt left in its slot for inspection. The failed state is itself
//     resumable — the user clicks resume again and generation restarts from
//     the (now invalid-tail-free) complete prefix.
//   - On full completion: status 'completed' (plotline-only semantics, see
//     the plotOnly block at generation-create-new-story.ts:628-667) and a
//     skeleton chapter-XXX.json is written for EVERY chapter that lacks one
//     — an interrupted create has NO payloads at all (plotOnly writes them
//     only at the end). Existing payloads are NEVER overwritten: they may
//     carry expanded revisions[] that a blind writeChapterPayload would wipe.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import {
    DATABASE_BASE_DIR,
    MAX_PLOT_ATTEMPTS,
    MIN_PLOTPOINTS_PER_CHAPTER,
    PREVIOUS_EXPANDED_CHAPTERS,
    REFUSAL_PATTERNS,
    STORY_REQUEST_MESSAGE
} from './generation-config';
import {
    buildAppendingFromChapters,
    buildExpandRequest,
    callStructured,
    createStoryClient,
    readChapterPayload,
    writeChapterPayload
} from './story-utils';
// Abort signal from the job registry — a user-requested Terminate (PATCH
// abortJob) must stop this background flow at its next checkpoint boundary.
import { isStoryAborted } from './generation-job-registry';

export type ResumeStoryChaptersOptions = {
    storyId: string;
    // Optional total chapter target. Absent → meta.chapterCount (the original
    // Generate target). Larger values cover the interrupted-append case (see
    // header). Never lowered silently — a target within the complete prefix
    // is rejected by validateResumableStory with 'already complete'.
    chapterCount?: number;
    root: string;
    // Optional per-request LLM client id (validated by parseClientId in the
    // handler before resumeStoryPlotlines is invoked).
    clientId?: string;
};

// Result of validateResumableStory — everything the background job needs,
// re-derived there once more (deletion between handler and job start).
export type ResumableStoryState = {
    databaseDir: string;
    meta: Record<string, any>;
    // Leading chapters passing the create flow's acceptance checks.
    completeChapters: Array<{ number: string; title: string; plotpoints: string[] }>;
    // Chapters still to generate (target - completeChapters.length) — >= 1.
    remaining: number;
    // Final chapter total after the resume completes.
    target: number;
};

/**
 * A chapter is "complete" only when it would pass the create flow's
 * per-chapter validation (generation-create-new-story.ts:534-556): no
 * refusal phrase FIRST (a refusal is a content-level rejection even when the
 * list is long enough), then the minimum plotpoint count. A failed story's
 * preserved broken chapter deliberately fails this check so resume
 * regenerates it instead of continuing after a refusal.
 */
const isChapterPlotlineComplete = (chapter: any): boolean => {
    if (!chapter || !Array.isArray(chapter.plotpoints)) return false;
    if (chapter.plotpoints.length < MIN_PLOTPOINTS_PER_CHAPTER) return false;
    for (const plotpoint of chapter.plotpoints) {
        for (const pattern of REFUSAL_PATTERNS) {
            if (String(plotpoint).toLowerCase().includes(pattern.toLowerCase())) {
                return false;
            }
        }
    }
    return true;
};

/**
 * Synchronously resolve the resumable state of a story. Throws an Error
 * whose message is user-facing (surfaced as the handler's 400 body).
 */
export const validateResumableStory = (
    projectRoot: string,
    storyId: string,
    targetOverride?: number
): ResumableStoryState => {
    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR, storyId);
    if (!fs.existsSync(databaseDir)) {
        throw new Error(`Story '${storyId}' not found`);
    }
    const plotpointPath = path.join(databaseDir, 'plotpoint.json');
    if (!fs.existsSync(plotpointPath)) {
        throw new Error(`Story '${storyId}' has no plotpoint.json`);
    }
    let meta: Record<string, any>;
    try {
        meta = JSON.parse(fs.readFileSync(plotpointPath, 'utf-8'));
    } catch {
        throw new Error(`Story '${storyId}' has a corrupted plotpoint.json`);
    }
    // The LLM is primed with the stored storyline — without one there is no
    // story to resume from.
    if (!meta?.storyline || typeof meta.storyline !== 'string' || meta.storyline.length === 0) {
        throw new Error(`Story '${storyId}' has no storyline to resume from`);
    }
    if (!Array.isArray(meta.chapters)) {
        throw new Error(`Story '${storyId}' has no chapter list to resume`);
    }
    if (targetOverride !== undefined && (typeof targetOverride !== 'number' || targetOverride < 1)) {
        throw new Error('resume.chapterCount must be a positive number');
    }
    const target = targetOverride ?? meta.chapterCount;
    if (typeof target !== 'number' || target < 1) {
        throw new Error(`Story '${storyId}' has no chapter target to resume toward`);
    }
    // Complete prefix: stop at the first chapter failing the acceptance
    // checks — generation is sequential, so everything after it is a
    // partial/failed tail to regenerate, never a gap to keep.
    const chapters: Array<{ number: string; title: string; plotpoints: string[] }> = meta.chapters;
    let completeCount = 0;
    while (completeCount < chapters.length && isChapterPlotlineComplete(chapters[completeCount])) {
        completeCount++;
    }
    const remaining = target - completeCount;
    if (remaining <= 0) {
        throw new Error(
            `Story '${storyId}' plotline generation is already complete (${completeCount}/${target} chapters)`
        );
    }
    return { databaseDir, meta, completeChapters: chapters.slice(0, completeCount), remaining, target };
};

/**
 * Continue plotline generation from the complete prefix up to the chapter
 * target. Runs in the background (fire-and-forget) — the handler returns 200
 * as soon as validation passes; the dashboard's GET polling picks up each
 * accepted chapter as plotpoint.json is rewritten.
 */
export const resumeStoryPlotlines = async (options: ResumeStoryChaptersOptions) => {
    const { storyId, root: projectRoot, clientId } = options;

    // Re-validate — the story may have been deleted or completed between the
    // handler's synchronous check and this background start.
    const { databaseDir, meta, completeChapters, remaining, target } = validateResumableStory(
        projectRoot,
        storyId,
        options.chapterCount
    );
    const storyline: string = meta.storyline;

    const chapterDir = path.join(databaseDir, 'chapter');
    fs.mkdirSync(chapterDir, { recursive: true });

    // The story dir can be deleted mid-LLM-call (user deletes from the list);
    // guard every post-call write with this, matching generateStory's contract.
    // A user-requested job termination (PATCH abortJob) is equally terminal —
    // the story keeps its status 'generating' + accepted chapters, so a later
    // resume click simply restarts from the same complete prefix.
    const assertStoryExists = () => {
        // Abort check FIRST — a pending termination wins over folder state.
        if (isStoryAborted(storyId)) {
            throw new Error(`Story resume aborted by user request — storyId: ${storyId}`);
        }
        if (!fs.existsSync(databaseDir)) {
            throw new Error(`Story folder deleted — aborting resume for storyId: ${storyId}`);
        }
    };

    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');
    const plotpointMdPath = path.join(databaseDir, 'plotpoint.md');

    // Accumulated outline for this run: the complete prefix plus one slot per
    // regenerated chapter, appended as calls succeed.
    const chapters: Array<{ number: string; title: string; plotpoints: string[] }> = [...completeChapters];
    let plotAttempts = 0;

    // Once failure is committed the run is terminal; the user re-resumes.
    let storyFailed = false;

    // Rewrite plotpoint.json + plotpoint.md from the CURRENT accumulated
    // outline (create's writePlotpointFile convention). Spreading `meta`
    // preserves storyline/storyName/chapterCompleted/createdAt — only the
    // chapter list, target count, status and validation record move.
    const writeProgress = (validation: Record<string, unknown>, status: string) => {
        if (storyFailed) return;
        assertStoryExists();
        const plotpointJson = {
            ...meta,
            storyId,
            chapterCount: target,
            chapters: chapters.map(({ number, title, plotpoints }) => ({
                number,
                title,
                plotpoints: Array.isArray(plotpoints) ? plotpoints : []
            })),
            validation,
            status
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointJson, null, 2), 'utf-8');
        const mdContent = chapters
            .map((ch) => `> ${ch.number}: ${ch.title}\n\n${ch.plotpoints.map((p) => `- ${p}`).join('\n')}`)
            .join('\n\n---\n\n');
        fs.writeFileSync(plotpointMdPath, mdContent, 'utf-8');
    };

    // Terminal failure — mirror markStoryFailed (generation-create-new-story.ts:319-348):
    // status 'failed', accepted chapters preserved, broken attempt inspectable.
    const markStoryFailed = (reason: string) => {
        if (storyFailed) return;
        storyFailed = true;
        assertStoryExists();
        const plotpointJson = {
            ...meta,
            storyId,
            chapterCount: target,
            chapters: chapters.map(({ number, title, plotpoints }) => ({
                number,
                title,
                plotpoints: Array.isArray(plotpoints) ? plotpoints : []
            })),
            status: 'failed',
            validation: { valid: false, reason: `resume: ${reason}`, attempt: plotAttempts }
        };
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointJson, null, 2), 'utf-8');
        console.error(
            `[RESUME] Story '${storyId}' marked as failed during resume (${reason}, ` +
                `${chapters.length} chapter(s) preserved)`
        );
    };

    // Trim away any incomplete/partial tail IMMEDIATELY so polling clients see
    // the true resume baseline before the first regenerated chapter lands.
    writeProgress(
        { valid: true, reason: `resume started, ${remaining} chapter(s) to generate`, attempt: plotAttempts },
        'generating'
    );

    // ── Prime the LLM client ──────────────────────────────────────────────
    // Same priming as append (generation-append-story.ts:143-145), then the
    // complete-prefix context as ONE assistant message (expandChapter's
    // appending convention, story-utils.ts:210-212) so the model continues
    // from what actually happened instead of continuing blind.
    const client = createStoryClient(clientId);
    client.user(STORY_REQUEST_MESSAGE);
    client.assistant(storyline);

    if (completeChapters.length > 0) {
        const appending = buildAppendingFromChapters(completeChapters);
        // Replace the most recent prefix chapters' summaries with their latest
        // expanded prose when available (mirrors generation-append-story.ts:156-167).
        for (let i = Math.max(0, completeChapters.length - PREVIOUS_EXPANDED_CHAPTERS); i < completeChapters.length; i++) {
            const payload = readChapterPayload(chapterDir, i);
            const revisions = Array.isArray(payload?.revisions) ? (payload!.revisions as any[]) : [];
            for (let r = revisions.length - 1; r >= 0; r--) {
                const rev = revisions[r];
                if (rev && typeof rev.content === 'string' && rev.content.length > 0) {
                    const chapterTitle = payload!.title ?? `Chapter ${i + 1}`;
                    appending[i] = `## ${chapterTitle}\n\n${rev.content}`;
                    break;
                }
            }
        }
        client.assistant(appending.join('\n'));
    }

    // ── Per-chapter agentic chain (mirrors generateStory) ─────────────────
    // ONE structured call per missing chapter; each accepted chapter is
    // committed to the conversation as an assistant tool_call so the next
    // chapter's request sees the regenerated chapters 1..N of this run.
    const chapterPlotpointSchema = Type.Object({
        title: Type.String({ description: 'the title of the chapter without the chapter number' }),
        plotpoints: Type.Array(Type.String(), {
            description:
                'each entry describes the important events and dialogues that happens in the chapter. Must be in simple and concise dot points'
        })
    });

    for (let chapterIndex = completeChapters.length; chapterIndex < target; chapterIndex++) {
        const chapterLabel = chapterIndex + 1;
        console.log(`[RESUME] Generating plotpoints for chapter ${chapterLabel}/${target} (storyId: ${storyId})`);

        // Byte-identical to the create flow's request (generation-create-new-story.ts:462-468)
        // so resumed chapters are produced under the same contract.
        const request = [
            `> Submit me the detailed plotpoints of the next chapter (chapter ${chapterLabel} of ${target})`,
            '> The plotpoint must includes all the important dialogues happens in the chapter',
            `> There must be at least ${MIN_PLOTPOINTS_PER_CHAPTER} plotpoints for the chapter`,
            '> Must clearly outlines how the chapter starts, and how the chapter ends with the first and last plotpoints only',
            '> Do not include plotpoints or events that belong to any other chapter'
        ].join('\n');

        let acceptedChapter: { number: string; title: string; plotpoints: string[] } | null = null;
        let chapterFailureReason = `chapter ${chapterLabel} plotpoint generation produced no usable response`;

        // 1 initial attempt + MAX_PLOT_ATTEMPTS retries, re-issued verbatim —
        // same budget policy as the create flow.
        for (let chapterAttempt = 0; chapterAttempt <= MAX_PLOT_ATTEMPTS && !acceptedChapter; chapterAttempt++) {
            assertStoryExists();
            if (chapterAttempt > 0) plotAttempts++;

            let response: { title: string; plotpoints: string[] };
            try {
                ({ response } = await callStructured(client, { request, response: chapterPlotpointSchema }));
            } catch (err) {
                // A deleted story folder aborts immediately — nothing left to retry into.
                if (!fs.existsSync(databaseDir)) throw err;
                // A user-requested job termination aborts immediately too —
                // the retry budget below must NOT eat the abort and keep
                // issuing LLM calls the user explicitly cancelled.
                if (isStoryAborted(storyId)) throw err;
                chapterFailureReason = err instanceof Error ? err.message : String(err);
                console.error(
                    `[RESUME] Chapter ${chapterLabel} call failed ` +
                        `(attempt ${chapterAttempt + 1}/${MAX_PLOT_ATTEMPTS + 1}): ${chapterFailureReason}. Retrying identical request...`
                );
                continue;
            }

            // Chapter numbers are server-assigned by position (same as create —
            // the schema carries no number field on purpose).
            const normalized = {
                number: String(chapterLabel),
                title: String(response.title ?? ''),
                plotpoints: Array.isArray(response.plotpoints) ? response.plotpoints : []
            };

            // Preserve the latest attempt in the chapter's slot so a terminal
            // failure keeps the broken chapter inspectable (create parity).
            chapters[chapterIndex] = normalized;

            if (!isChapterPlotlineComplete(normalized)) {
                chapterFailureReason =
                    `chapter ${chapterLabel} returned ${normalized.plotpoints.length} usable plotpoints ` +
                    `(minimum: ${MIN_PLOTPOINTS_PER_CHAPTER}, no refusals)`;
                console.error(
                    `[RESUME] Chapter ${chapterLabel} plotpoint validation failed ` +
                        `(attempt ${chapterAttempt + 1}/${MAX_PLOT_ATTEMPTS + 1}): ${chapterFailureReason}. Retrying identical request...`
                );
                continue;
            }

            acceptedChapter = normalized;
        }

        if (!acceptedChapter) {
            markStoryFailed(chapterFailureReason);
            return;
        }

        // Agentic chain step — commit request + tool_call so the next chapter
        // sees this one (generation-create-new-story.ts:580-591).
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

        // Progressive visibility: each accepted chapter appears in the
        // dashboard's polling as soon as it validates.
        writeProgress(
            { valid: true, reason: `chapter ${chapterLabel}/${target} plotpoints accepted (resumed)`, attempt: plotAttempts },
            'generating'
        );
        console.log(
            `[RESUME] Chapter ${chapterLabel}/${target} plotpoints accepted: "${acceptedChapter.title}" ` +
                `(${acceptedChapter.plotpoints.length} plotpoints)`
        );
    }

    // ── Completion (plotline-only, mirrors the plotOnly block) ────────────
    assertStoryExists();

    // Skeleton payloads for chapters that LACK one — interrupted creates have
    // none at all. Existing payloads are left untouched: they may hold
    // expanded revisions[] a blind skeleton write would destroy.
    const summaryList = buildAppendingFromChapters(chapters);
    for (let i = 0; i < chapters.length; i++) {
        assertStoryExists();
        if (readChapterPayload(chapterDir, i) !== null) continue;
        const chapter = chapters[i];
        writeChapterPayload({
            chapterDir,
            chapterIndex: i,
            storyId,
            storyline,
            chapterCount: target,
            chapterNumber: chapter.number,
            plotpoints: Array.isArray(chapter.plotpoints) ? chapter.plotpoints : [],
            contextAppending: [...summaryList],
            request: buildExpandRequest(chapter.number, chapter.title)
        });
    }

    writeProgress({ valid: true, reason: 'plotline complete (resumed)', attempt: plotAttempts }, 'completed');

    console.log(
        `[RESUME] Plotline generation resumed to completion for storyId: ${storyId} ` +
            `(${completeChapters.length} kept + ${target - completeChapters.length} regenerated = ${target} chapters)`
    );
};
