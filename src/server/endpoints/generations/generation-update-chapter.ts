// ---------------------------------------------------------------------------
// PATCH handler — updates story metadata, re-expands a chapter, or rewrites
// a chapter with user-provided context.
//
// The handler accepts:
//   - storyName (string): update story metadata in plotpoint.json
//   - expandChapterIndex (number): trigger chapter re-expansion (chain)
//   - rewriteChapter (number) + rewriteContext (string): rewrite a single
//     chapter using the full story summary context + user instructions
//
// Only one of expandChapterIndex or rewriteChapter may be provided per request.
// When both expandChapterIndex and storyName are provided, metadata is updated
// first, then re-expansion starts in the background.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { DATABASE_BASE_DIR, MIN_WORDS_PER_CHAPTER } from './generation-config';
import {
    buildExpandRequest,
    createStoryClient,
    expandChapter,
    readChapterPayload,
    readPlotpointData,
    writeChapterFiles,
    writeChapterPayload
} from './story-utils';

export const generationUpdateChapter = asHandlerMethod(async (_, parameters, variables) => {
    const { path: pathParams, body } = parameters;

    const storyId = pathParams.storyId;

    if (!storyId) {
        return {
            status: 400,
            response: { error: 'storyId is required' }
        };
    }

    // Resolve the project root and story directory
    const projectRoot = variables.root;
    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR, storyId);
    const chapterDir = path.join(databaseDir, 'chapter');

    // Verify the story exists
    if (!fs.existsSync(databaseDir)) {
        return {
            status: 404,
            response: { error: `Story '${storyId}' not found` }
        };
    }

    // Read story metadata from plotpoint.json (single source of truth)
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');
    if (!fs.existsSync(plotpointJsonPath)) {
        return {
            status: 404,
            response: { error: `Story '${storyId}' has no plotpoint.json metadata` }
        };
    }

    let plotpointData: Record<string, any>;
    try {
        plotpointData = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
    } catch {
        return {
            status: 500,
            response: { error: `Story '${storyId}' has corrupted plotpoint.json` }
        };
    }

    // ── Handle story metadata updates ─────────────────────────────────────
    // Accept storyName and any other writable metadata fields.
    const updatedMeta: Record<string, any> = {};
    if (body.storyName !== undefined && typeof body.storyName === 'string' && body.storyName.length > 0) {
        plotpointData.storyName = body.storyName;
        updatedMeta.storyName = body.storyName;
    }

    // Persist metadata changes to plotpoint.json
    if (Object.keys(updatedMeta).length > 0) {
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointData, null, 2), 'utf-8');
        console.log(`[PATCH] Updated story '${storyId}' metadata:`, updatedMeta);
    }

    // ── Handle chapter re-expansion ───────────────────────────────────────
    const expandChapterIndex = typeof body.expandChapterIndex === 'number' ? body.expandChapterIndex : undefined;
    const rewriteChapterIndex = typeof body.rewriteChapter === 'number' ? body.rewriteChapter : undefined;
    const rewriteContext = typeof body.rewriteContext === 'string' ? body.rewriteContext : undefined;
    const rewriteRevisionIndex = typeof body.rewriteRevisionIndex === 'number' ? body.rewriteRevisionIndex : undefined;

    // Mutually exclusive: cannot provide both expandChapterIndex and rewriteChapter
    if (expandChapterIndex !== undefined && rewriteChapterIndex !== undefined) {
        return {
            status: 400,
            response: { error: 'Cannot provide both expandChapterIndex and rewriteChapter. Choose one.' }
        };
    }

    // rewriteChapter requires rewriteContext
    if (rewriteChapterIndex !== undefined && (!rewriteContext || rewriteContext.length === 0)) {
        return {
            status: 400,
            response: { error: 'rewriteContext is required when rewriteChapter is provided' }
        };
    }

    if (
        expandChapterIndex === undefined &&
        rewriteChapterIndex === undefined &&
        Object.keys(updatedMeta).length === 0
    ) {
        return {
            status: 400,
            response: {
                error: 'No valid update fields provided. Supported: storyName (string), expandChapterIndex (number), rewriteChapter (number) + rewriteContext (string)'
            }
        };
    }

    // If only metadata was updated, return success immediately
    if (expandChapterIndex === undefined && rewriteChapterIndex === undefined) {
        return {
            status: 200,
            response: {
                storyId,
                ...updatedMeta,
                message: 'Story metadata updated'
            }
        };
    }

    // ── Extract story metadata (needed by both re-expand and rewrite) ─────
    const storyMeta = {
        storyId: plotpointData.storyId,
        storyline: plotpointData.storyline ?? '',
        chapterCount: plotpointData.chapterCount ?? 0,
        createdAt: plotpointData.createdAt ?? ''
    };

    // ── Handle chapter rewrite ────────────────────────────────────────────
    if (rewriteChapterIndex !== undefined) {
        if (rewriteChapterIndex < 0) {
            return {
                status: 400,
                response: { error: 'rewriteChapter must be a non-negative integer' }
            };
        }

        const chapterPayload = readChapterPayload(chapterDir, rewriteChapterIndex);

        if (!chapterPayload) {
            return {
                status: 404,
                response: { error: `Chapter ${rewriteChapterIndex} not found for story '${storyId}'` }
            };
        }

        const rewritePayloadContext = (chapterPayload as any).context;
        const rewritePlotpoints = (chapterPayload as any).plotpoints as string[];
        const rewriteChapterNumber = (chapterPayload as any).chapterNumber as string;
        const rewriteChapterTitle = (chapterPayload as any).title as string;
        const originalRequest = rewritePayloadContext?.request as string | undefined;

        if (!rewritePayloadContext || !Array.isArray(rewritePayloadContext.appending)) {
            return {
                status: 500,
                response: {
                    error: `Chapter ${rewriteChapterIndex} payload is missing context.appending. Cannot rewrite without the original conversation context.`
                }
            };
        }

        // Guard: check if story folder still exists
        const assertStoryExists = () => {
            if (!fs.existsSync(databaseDir)) {
                throw new Error(`Story folder deleted — aborting rewrite for storyId: ${storyId}`);
            }
        };

        // Build the context appending array. When a specific revision is selected
        // (rewriteRevisionIndex), replace the chapter's own entry in the context
        // with that revision's content so the LLM sees the version the user is
        // actively viewing — not whatever was last written to context.appending.
        let rewriteAppending = [...rewritePayloadContext.appending];
        if (typeof rewriteRevisionIndex === 'number' && rewriteRevisionIndex >= 0) {
            const revisions = (chapterPayload as any).revisions;
            if (Array.isArray(revisions) && rewriteRevisionIndex < revisions.length) {
                const selectedRevision = revisions[rewriteRevisionIndex];
                if (
                    selectedRevision &&
                    typeof selectedRevision.content === 'string' &&
                    selectedRevision.content.length > 0
                ) {
                    const revisionEntry = `## ${rewriteChapterTitle}\n\n${selectedRevision.content}`;
                    // Replace the chapter's entry at its own index in the context
                    if (rewriteChapterIndex < rewriteAppending.length) {
                        rewriteAppending[rewriteChapterIndex] = revisionEntry;
                    } else {
                        // Edge case: appending is shorter than expected — pad and insert
                        while (rewriteAppending.length <= rewriteChapterIndex) {
                            rewriteAppending.push('');
                        }
                        rewriteAppending[rewriteChapterIndex] = revisionEntry;
                    }
                    console.log(
                        `Rewrite context: replaced appending[${rewriteChapterIndex}] with revision ${rewriteRevisionIndex} content for storyId: ${storyId}`
                    );
                } else {
                    console.warn(
                        `Rewrite revision ${rewriteRevisionIndex} has empty/missing content for storyId: ${storyId}, using stored context`
                    );
                }
            } else if (typeof rewriteRevisionIndex === 'number') {
                console.warn(
                    `Rewrite revision index ${rewriteRevisionIndex} out of range (revisions length: ${Array.isArray(revisions) ? revisions.length : 0}) for storyId: ${storyId}, using stored context`
                );
            }
        }

        // Build the rewrite request: preset rewrite instructions + user context
        // rewriteContext is guaranteed non-empty by the guard above
        const rewriteRequest = buildRewriteRequest(rewriteChapterNumber, rewriteChapterTitle, rewriteContext!);

        // Fire-and-forget: rewrite the single chapter (no chain expansion)
        rewriteChapterBg({
            storyId,
            storyline: storyMeta.storyline,
            chapterCount: storyMeta.chapterCount,
            chapterIndex: rewriteChapterIndex,
            chapterNumber: rewriteChapterNumber,
            chapterTitle: rewriteChapterTitle,
            plotpoints: Array.isArray(rewritePlotpoints) ? rewritePlotpoints : [],
            appending: rewriteAppending,
            request: rewriteRequest,
            originalRequest,
            assertStoryExists,
            databaseDir,
            chapterDir
        }).catch((err) => {
            console.error(`Chapter rewrite failed for storyId ${storyId} chapter ${rewriteChapterIndex}:`, err);
        });

        return {
            status: 200,
            response: {
                storyId,
                ...updatedMeta,
                rewriteChapter: rewriteChapterIndex,
                chapterNumber: rewriteChapterNumber,
                title: rewriteChapterTitle,
                message: `Chapter ${rewriteChapterIndex} rewrite started`
            }
        };
    }

    // ── Re-expansion path ─────────────────────────────────────────────────
    // expandChapterIndex is guaranteed to be defined here: we returned early
    // if both expandChapterIndex and rewriteChapterIndex were undefined (line 110),
    // and the rewrite path above already returned if rewriteChapterIndex was defined.
    const expandIdx = expandChapterIndex!;

    if (expandIdx < 0) {
        return {
            status: 400,
            response: { error: 'expandChapterIndex must be a non-negative integer' }
        };
    }

    // ── Re-expansion path ─────────────────────────────────────────────────
    const chapterPayload = readChapterPayload(chapterDir, expandIdx);

    if (!chapterPayload) {
        return {
            status: 404,
            response: { error: `Chapter ${expandIdx} not found for story '${storyId}'` }
        };
    }

    // Extract the stored context and request from the chapter payload
    const payloadContext = (chapterPayload as any).context;
    const plotpoints = (chapterPayload as any).plotpoints as string[];
    const chapterNumber = (chapterPayload as any).chapterNumber as string;
    const chapterTitle = (chapterPayload as any).title as string;

    if (!payloadContext || !Array.isArray(payloadContext.appending)) {
        return {
            status: 500,
            response: {
                error: `Chapter ${expandIdx} payload is missing context.appending. Cannot re-expand without the original conversation context.`
            }
        };
    }

    if (!payloadContext.request || typeof payloadContext.request !== 'string') {
        return {
            status: 500,
            response: {
                error: `Chapter ${expandIdx} payload is missing context.request. Cannot re-expand without the original request prompt.`
            }
        };
    }

    // Guard: check if story folder still exists (user may have deleted during processing)
    const assertStoryExists = () => {
        if (!fs.existsSync(databaseDir)) {
            throw new Error(`Story folder deleted — aborting generation for storyId: ${storyId}`);
        }
    };

    // Start chapter re-expansion in the background (fire-and-forget)
    // This mirrors the pattern in generation-create-new-story.ts
    reExpandChapter({
        storyId,
        storyline: storyMeta.storyline,
        chapterCount: storyMeta.chapterCount,
        chapterIndex: expandIdx,
        chapterNumber,
        chapterTitle,
        plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
        appending: payloadContext.appending,
        request: payloadContext.request,
        assertStoryExists,
        databaseDir,
        chapterDir
    }).catch((err) => {
        console.error(`Chapter re-expansion failed for storyId ${storyId} chapter ${expandIdx}:`, err);
    });

    // Return immediately while re-expansion runs in the background
    return {
        status: 200,
        response: {
            storyId,
            ...updatedMeta,
            expandChapterIndex: expandIdx,
            chapterNumber,
            title: chapterTitle,
            message: `Chapter ${expandIdx} re-expansion started`
        }
    };
});

/**
 * Background task: re-expand a chapter and all subsequent pending chapters.
 *
 * Starting from the requested chapterIndex, this function expands each chapter
 * using the stored LLM context. After expanding chapter N, it propagates the
 * updated context to chapter N+1 and checks whether N+1 is "pending" (has no
 * expanded content). If so, it continues expanding N+1, then N+2, and so on,
 * until either there are no more chapters or the next chapter is already
 * expanded.
 *
 * This ensures that re-expanding an early chapter automatically brings all
 * downstream pending chapters up-to-date in a single background task.
 */
const reExpandChapter = async (options: {
    storyId: string;
    storyline: string;
    chapterCount: number;
    chapterIndex: number;
    chapterNumber: string;
    chapterTitle: string;
    plotpoints: string[];
    appending: string[];
    request: string;
    assertStoryExists: () => void;
    databaseDir: string;
    chapterDir: string;
}) => {
    const {
        storyId,
        storyline,
        chapterCount,
        chapterIndex: startChapterIndex,
        assertStoryExists,
        databaseDir,
        chapterDir
    } = options;

    // Create a fresh LLM client (reused across all expansions in the chain)
    const client = createStoryClient();

    // Add the storyline to the conversation context
    client.user('You know the story I like');
    client.assistant(storyline);

    // ── Iterative chain expansion ────────────────────────────────────────────
    // Start from the requested chapter. After each expansion, propagate context
    // to the next chapter and check whether it is pending. If pending, continue
    // expanding. Stop when there are no more chapters or the next chapter is
    // already expanded.
    let currentIndex = startChapterIndex;
    let currentAppending = [...options.appending];
    let currentRequest = options.request;
    let currentChapterNumber = options.chapterNumber;
    let currentPlotpoints = options.plotpoints;

    while (currentIndex < chapterCount) {
        assertStoryExists();

        console.log(`Re-expanding chapter ${currentChapterNumber} (index ${currentIndex}) for storyId: ${storyId}`);

        // Track generation time
        const expandStartMs = Date.now();

        // Expand the chapter using the stored context (appending[] + request)
        const result = await expandChapter({
            client,
            appending: [...currentAppending], // Clone to avoid mutation during expansion
            chapterDir,
            assertStoryExists,
            chapterNumber: currentChapterNumber,
            chapterIndex: currentIndex,
            request: currentRequest,
            minWords: MIN_WORDS_PER_CHAPTER
        });

        const generationTimeMs = Date.now() - expandStartMs;

        // Write the updated chapter files (md + json)
        writeChapterFiles({
            chapterDir,
            chapterIndex: currentIndex,
            storyId,
            storyline,
            chapterCount,
            chapterNumber: currentChapterNumber,
            plotpoints: Array.isArray(currentPlotpoints) ? currentPlotpoints : [],
            contextAppending: currentAppending,
            request: currentRequest,
            result,
            generationTimeMs
        });

        console.log(
            `Chapter ${currentChapterNumber} re-expansion complete for storyId: ${storyId} (${result.content.split(' ').length} words, ${generationTimeMs}ms)`
        );

        // ── Propagate updated context to the next chapter ──────────────────────
        // During initial creation, each chapter N+1's context.appending has
        // chapter N's expanded content at position `chapterIndex`. After
        // re-expanding chapter N, we must update chapter N+1's JSON payload so
        // its context.appending reflects the new content. This ensures that if
        // chapter N+1 is later re-expanded, it uses the correct preceding context.
        //
        // If the next chapter's chapter-XXX.json doesn't exist (e.g. initial
        // generation was interrupted before reaching that chapter), we create a
        // skeleton payload via writeChapterPayload so the chapter becomes
        // expandable.
        const nextIndex = currentIndex + 1;
        if (nextIndex >= chapterCount) {
            // No more chapters — chain expansion is complete
            break;
        }

        const newExpandedEntry = `## ${result.title}\n\n${result.content}`;
        const nextPayload = readChapterPayload(chapterDir, nextIndex);

        if (nextPayload && Array.isArray((nextPayload as any).context?.appending)) {
            // ── Update existing next-chapter payload ────────────────────────
            const nextAppending = [...(nextPayload as any).context.appending];

            // The re-expanded chapter's content sits at position `currentIndex`
            // in the next chapter's context.appending (the rolling context pattern).
            if (nextIndex > 0 && nextAppending.length > currentIndex) {
                nextAppending[currentIndex] = newExpandedEntry;

                // Update the payload in memory and write it back
                (nextPayload as any).context.appending = nextAppending;
                const paddedNext = String(nextIndex + 1).padStart(3, '0');
                const nextJsonPath = path.join(chapterDir, `chapter-${paddedNext}.json`);
                assertStoryExists();
                fs.writeFileSync(nextJsonPath, JSON.stringify(nextPayload, null, 2), 'utf-8');
                console.log(`Updated context.appending in chapter-${paddedNext}.json for storyId: ${storyId}`);
            }
        } else if (!nextPayload) {
            // ── Create skeleton for missing next-chapter payload ────────────
            // The next chapter has no .json (generation was interrupted before
            // it was reached). Create a skeleton so the user can expand it.
            const plotpointChapters = readPlotpointData(databaseDir);
            if (plotpointChapters && plotpointChapters[nextIndex]) {
                const nextChapterData = plotpointChapters[nextIndex];
                const nextRequest = buildExpandRequest(nextChapterData.number, nextChapterData.title);

                // Build context: start from current chapter's context and
                // insert the new expanded content at the current chapter's position.
                const nextAppending = [...currentAppending];
                if (nextAppending.length > currentIndex) {
                    nextAppending[currentIndex] = newExpandedEntry;
                }

                assertStoryExists();
                writeChapterPayload({
                    chapterDir,
                    chapterIndex: nextIndex,
                    storyId,
                    storyline,
                    chapterCount,
                    chapterNumber: nextChapterData.number,
                    plotpoints: Array.isArray(nextChapterData.plotpoints) ? nextChapterData.plotpoints : [],
                    contextAppending: nextAppending,
                    request: nextRequest
                });
                console.log(
                    `Created skeleton chapter-${String(nextIndex + 1).padStart(3, '0')}.json for storyId: ${storyId} (was missing)`
                );
            }
        }

        // ── Check if the next chapter is pending ───────────────────────────
        // A chapter is "pending" when its revisions[] is empty or has no
        // non-empty content (i.e. the LLM has not yet generated its content).
        // If the next chapter is already expanded, stop the chain — the user
        // only requested re-expansion of the starting chapter, and downstream
        // chapters that already have content should not be overwritten.
        const nextPayloadAfterUpdate = readChapterPayload(chapterDir, nextIndex);
        if (!nextPayloadAfterUpdate) {
            console.log(
                `Could not read chapter ${nextIndex} payload after propagation, stopping chain expansion for storyId: ${storyId}`
            );
            break;
        }

        const nextRevisions = (nextPayloadAfterUpdate as any).revisions;
        const nextIsExpanded =
            Array.isArray(nextRevisions) &&
            nextRevisions.length > 0 &&
            nextRevisions.some((r: any) => typeof r.content === 'string' && r.content.length > 0);

        if (nextIsExpanded) {
            console.log(`Chapter ${nextIndex} is already expanded, stopping chain expansion for storyId: ${storyId}`);
            break;
        }

        // ── Prepare for next iteration ─────────────────────────────────────
        // Read the next chapter's data from its (now-updated) payload and
        // continue the loop to expand it.
        currentIndex = nextIndex;
        currentAppending = (nextPayloadAfterUpdate as any).context?.appending ?? currentAppending;
        currentRequest = (nextPayloadAfterUpdate as any).context?.request ?? currentRequest;
        currentChapterNumber = (nextPayloadAfterUpdate as any).chapterNumber ?? String(nextIndex + 1);
        currentPlotpoints = (nextPayloadAfterUpdate as any).plotpoints ?? [];
    }

    console.log(`Chain expansion complete for storyId: ${storyId} (last expanded index: ${currentIndex})`);
};

// ---------------------------------------------------------------------------
// Rewrite Chapter
// ---------------------------------------------------------------------------

/**
 * Build the rewrite request prompt for a chapter.
 *
 * Unlike buildExpandRequest (which uses plotpoint-driven instructions),
 * rewrite uses the full summary context and the user's custom rewriteContext
 * to produce a rewritten version of the chapter.
 */
const buildRewriteRequest = (chapterNumber: string, chapterTitle: string, rewriteContext: string): string => {
    return [
        '> As the world best selling writer, you must do the following:',
        `- Review the chapter "${chapterNumber}: ${chapterTitle}", understand the sequence of events completely`,
        `- ${rewriteContext}`,
        '- Use the full story summary and all provided context to ensure consistency',
        '- Write in highly graphical explicit details',
        '- Describe everything in slow-paced vivid imagery. Expand on every detail',
        '- Do not output a wall of text! Use short and long paragraphs',
        '- Must be in active voice. Show the story in every details, do not tell it!'
    ].join('\n');
};

/**
 * Background task: rewrite a single chapter using user-provided context.
 *
 * Unlike reExpandChapter which chains to subsequent pending chapters,
 * rewriteChapterBg only rewrites the targeted chapter. It uses the full
 * story summary (appending[]) as context and the user-provided rewriteContext
 * as the expansion request (instead of buildExpandRequest).
 */
const rewriteChapterBg = async (options: {
    storyId: string;
    storyline: string;
    chapterCount: number;
    chapterIndex: number;
    chapterNumber: string;
    chapterTitle: string;
    plotpoints: string[];
    appending: string[];
    request: string;
    originalRequest?: string;
    assertStoryExists: () => void;
    databaseDir: string;
    chapterDir: string;
}) => {
    const {
        storyId,
        storyline,
        chapterCount,
        chapterIndex,
        chapterNumber,
        chapterTitle,
        plotpoints,
        appending,
        request,
        originalRequest,
        assertStoryExists,
        chapterDir
    } = options;

    const client = createStoryClient();

    // Prime with storyline context (same as initial expansion)
    client.user('You know the story I like');
    client.assistant(storyline);

    assertStoryExists();

    console.log(`Rewriting chapter ${chapterNumber} (index ${chapterIndex}) for storyId: ${storyId}`);

    const expandStartMs = Date.now();

    // Expand the single chapter using the full summary + user rewrite context
    const result = await expandChapter({
        client,
        appending: [...appending],
        chapterDir,
        assertStoryExists,
        chapterNumber,
        chapterIndex,
        request,
        minWords: MIN_WORDS_PER_CHAPTER
    });

    const generationTimeMs = Date.now() - expandStartMs;

    // Write the updated chapter files (md + json) — single chapter, no chain.
    // IMPORTANT: Use originalRequest (the original expand request) instead of
    // request (the rewrite prompt) for context.request in the JSON. This
    // preserves the chapter's original expand context so future re-expansion
    // uses the correct plotpoint-driven prompt instead of the rewrite prompt.
    // The rewrite result is stored as a new revision in revisions[].
    writeChapterFiles({
        chapterDir,
        chapterIndex,
        storyId,
        storyline,
        chapterCount,
        chapterNumber,
        plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
        contextAppending: appending,
        request: originalRequest ?? request,
        result,
        generationTimeMs
    });

    console.log(
        `Chapter ${chapterNumber} rewrite complete for storyId: ${storyId} (${result.content.split(' ').length} words, ${generationTimeMs}ms)`
    );
};
