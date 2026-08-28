// ---------------------------------------------------------------------------
// PATCH handler — updates story metadata, re-expands a chapter, rewrites
// a chapter with user-provided context, deletes a chapter's expanded
// content, or removes a chapter entirely.
//
// The handler accepts:
//   - storyName (string): update story metadata in plotpoint.json
//   - expandChapterIndex (number): trigger chapter re-expansion (chain)
//   - rewriteChapter (number) + rewriteContext (string): rewrite a single
//     chapter using the full story summary context + user instructions
//   - deleteChapterIndex (number) + deleteChapterRevisionIndex (number,
//     optional): remove a single revision from a chapter's revisions[].
//     Absent deleteChapterRevisionIndex → the LATEST revision is removed.
//     When the deleted revision was the chapter's last, the chapter returns
//     to plotlines-only (markdown removed, context preserved) so it can be
//     expanded again.
//   - removeChapterIndex (number): remove the chapter ENTIRELY — its
//     plotpoint.json entry, its chapter-XXX.json/.md files (including every
//     revision), and renumbers the chapters after it to fill the gap.
//
// Only one of expandChapterIndex, rewriteChapter, deleteChapterIndex, or
// removeChapterIndex may be provided per request.
// When both expandChapterIndex and storyName are provided, metadata is updated
// first, then re-expansion starts in the background.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { DATABASE_BASE_DIR, MIN_WORDS_PER_CHAPTER, parseClientId, TARGET_WORD_COUNT_PROMPT } from './generation-config';
import {
    buildExpandRequest,
    createStoryClient,
    decrementPlotpointChapterCompleted,
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

    // ── Validate the per-request LLM clientId (optional) ──────────────────
    // Same contract as generation-create-new-story.ts: explicit non-string or
    // unknown clientId values are a 400; absent clientId is legal and the
    // background re-expansion/rewrite falls back to the default client. The
    // value is never persisted in plotpoint.json — it only selects the LLM
    // client for whatever this PATCH triggers.
    const clientIdCheck = parseClientId(body.clientId);
    if (clientIdCheck.error) {
        return {
            status: 400,
            response: { error: clientIdCheck.error }
        };
    }
    const clientId = clientIdCheck.clientId;

    // Resolve the shared database root and the story-generator-owned directory.
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

    // ── Chapter operation fields ──────────────────────────────────────────
    const expandChapterIndex = typeof body.expandChapterIndex === 'number' ? body.expandChapterIndex : undefined;
    const rewriteChapterIndex = typeof body.rewriteChapter === 'number' ? body.rewriteChapter : undefined;
    const rewriteContext = typeof body.rewriteContext === 'string' ? body.rewriteContext : undefined;
    const rewriteRevisionIndex = typeof body.rewriteRevisionIndex === 'number' ? body.rewriteRevisionIndex : undefined;
    const deleteChapterIndex = typeof body.deleteChapterIndex === 'number' ? body.deleteChapterIndex : undefined;
    const deleteChapterRevisionIndex =
        typeof body.deleteChapterRevisionIndex === 'number' ? body.deleteChapterRevisionIndex : undefined;
    const removeChapterIndex = typeof body.removeChapterIndex === 'number' ? body.removeChapterIndex : undefined;

    // Mutually exclusive: expandChapterIndex / rewriteChapter / deleteChapterIndex /
    // removeChapterIndex each drive a distinct chapter operation — only one may
    // run per request.
    const exclusiveOpCount = [
        expandChapterIndex !== undefined,
        rewriteChapterIndex !== undefined,
        deleteChapterIndex !== undefined,
        removeChapterIndex !== undefined
    ].filter(Boolean).length;
    if (exclusiveOpCount > 1) {
        return {
            status: 400,
            response: {
                error: 'Only one of expandChapterIndex, rewriteChapter, deleteChapterIndex, or removeChapterIndex may be provided per request.'
            }
        };
    }

    // deleteChapterRevisionIndex only makes sense alongside deleteChapterIndex.
    if (deleteChapterRevisionIndex !== undefined && deleteChapterIndex === undefined) {
        return {
            status: 400,
            response: { error: 'deleteChapterRevisionIndex requires deleteChapterIndex' }
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
        deleteChapterIndex === undefined &&
        removeChapterIndex === undefined &&
        Object.keys(updatedMeta).length === 0
    ) {
        return {
            status: 400,
            response: {
                error: 'No valid update fields provided. Supported: storyName (string), expandChapterIndex (number), rewriteChapter (number) + rewriteContext (string), deleteChapterIndex (number), removeChapterIndex (number)'
            }
        };
    }

    // If only metadata was updated, return success immediately
    if (
        expandChapterIndex === undefined &&
        rewriteChapterIndex === undefined &&
        deleteChapterIndex === undefined &&
        removeChapterIndex === undefined
    ) {
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

    // ── Handle chapter revision deletion ────────────────────────────────
    // Synchronous (unlike expand/rewrite): removes ONE revision from the
    // chapter's revisions[] — the revision currently selected in the UI
    // (deleteChapterRevisionIndex), or the LATEST revision when the field is
    // absent. Only when the deleted revision was the chapter's LAST does the
    // chapter return to plotlines-only (markdown removed, chapterCompleted
    // decremented); with revisions remaining the chapter stays expanded.
    //
    // Markdown mirror handling (chapter-XXX.md exists for filesystem viewing
    // only — the API never reads it):
    //   - revisions emptied           → remove the .md entirely
    //   - the latest revision deleted → rewrite the .md with the new latest
    //   - an older revision deleted   → .md untouched (it mirrors the latest)
    //
    // The payload's context.appending + context.request are deliberately
    // preserved so PATCH expandChapterIndex can re-expand the chapter at any
    // point — deleting the only revision is what returns the chapter to a
    // plotlines-only, expandable-again state.
    //
    // Edge case: deleting while a background expansion is in flight is not
    // blocked — the progressive writer in expandChapter (story-utils.ts) would
    // repopulate revisions[] on its next flush. Same accepted trade-off as the
    // rewrite/re-expand paths, which the UI also fires blind.
    if (deleteChapterIndex !== undefined) {
        if (deleteChapterIndex < 0) {
            return {
                status: 400,
                response: { error: 'deleteChapterIndex must be a non-negative integer' }
            };
        }

        if (deleteChapterRevisionIndex !== undefined && deleteChapterRevisionIndex < 0) {
            return {
                status: 400,
                response: { error: 'deleteChapterRevisionIndex must be a non-negative integer' }
            };
        }

        const deletePayload = readChapterPayload(chapterDir, deleteChapterIndex);

        if (!deletePayload) {
            return {
                status: 404,
                response: { error: `Chapter ${deleteChapterIndex} not found for story '${storyId}'` }
            };
        }

        const deleteChapterNumber = (deletePayload as any).chapterNumber as string;
        const deleteChapterTitle = (deletePayload as any).title as string;

        const existingRevisions: Array<{ content: string; wordCount?: number; generationTimeMs?: number }> =
            Array.isArray((deletePayload as any).revisions) ? (deletePayload as any).revisions : [];

        if (existingRevisions.length === 0) {
            return {
                status: 400,
                response: { error: `Chapter ${deleteChapterIndex} has no revisions to delete` }
            };
        }

        // Target: the explicitly selected revision, or the latest one when the
        // caller passes no revision index.
        const targetRevisionIndex = deleteChapterRevisionIndex ?? existingRevisions.length - 1;

        if (targetRevisionIndex >= existingRevisions.length) {
            return {
                status: 400,
                response: {
                    error: `Revision ${targetRevisionIndex} does not exist on chapter ${deleteChapterIndex} (chapter has ${existingRevisions.length} revision${existingRevisions.length === 1 ? '' : 's'})`
                }
            };
        }

        // Whether the deleted revision was the latest — decides the .md rewrite.
        // Whether the chapter was complete BEFORE the deletion — gates the
        // chapterCompleted decrement (mirrors the wasPreviouslyComplete gate in
        // writeChapterFiles, which increments on first completion).
        const wasLatest = targetRevisionIndex === existingRevisions.length - 1;
        const wasComplete = existingRevisions.some(
            (r) => typeof r?.generationTimeMs === 'number' && r.generationTimeMs > 0
        );

        existingRevisions.splice(targetRevisionIndex, 1);
        (deletePayload as any).revisions = existingRevisions;

        const paddedDelete = String(deleteChapterIndex + 1).padStart(3, '0');
        const deleteJsonPath = path.join(chapterDir, `chapter-${paddedDelete}.json`);
        fs.writeFileSync(deleteJsonPath, JSON.stringify(deletePayload, null, 2), 'utf-8');

        const deleteMdPath = path.join(chapterDir, `chapter-${paddedDelete}.md`);
        if (existingRevisions.length === 0) {
            // No content left — remove the mirror entirely.
            if (fs.existsSync(deleteMdPath)) {
                fs.rmSync(deleteMdPath);
            }
        } else if (wasLatest && fs.existsSync(deleteMdPath)) {
            // The deleted revision was the mirrored one — rewrite the .md with
            // the new latest revision. Per-revision titles are not stored
            // (revisions carry content/wordCount/generationTimeMs only), so
            // the payload's title is the best heading available.
            const newLatest = existingRevisions[existingRevisions.length - 1];
            fs.writeFileSync(deleteMdPath, `## ${deleteChapterTitle}\n\n${newLatest.content}`, 'utf-8');
        }

        // Only when the revision array empties does the chapter drop out of
        // "complete" — otherwise it remains expanded and the counter stands.
        if (existingRevisions.length === 0 && wasComplete) {
            decrementPlotpointChapterCompleted(databaseDir);
        }

        console.log(
            `[PATCH] Deleted chapter ${deleteChapterIndex} revision ${targetRevisionIndex} for story '${storyId}' (remaining: ${existingRevisions.length})`
        );

        return {
            status: 200,
            response: {
                storyId,
                ...updatedMeta,
                deleteChapterIndex,
                deleteChapterRevisionIndex: targetRevisionIndex,
                chapterNumber: deleteChapterNumber,
                title: deleteChapterTitle,
                revisionsRemaining: existingRevisions.length,
                message:
                    existingRevisions.length === 0
                        ? `Chapter ${deleteChapterIndex} revision ${targetRevisionIndex} deleted — the chapter is plotlines only and can be expanded again`
                        : `Chapter ${deleteChapterIndex} revision ${targetRevisionIndex} deleted`
            }
        };
    }

    // ── Handle full chapter removal ──────────────────────────────────────
    // Synchronous (no LLM work). Removes the chapter ENTIRELY — the opposite
    // of deleteChapterIndex, which only strips one revision and keeps the
    // chapter (and its plotpoints/context) for re-expansion:
    //   1. plotpoint.json — the chapter entry is spliced out of chapters[],
    //      every later entry is renumbered (number = position + 1),
    //      chapterCount drops by one, and chapterCompleted drops when the
    //      removed chapter carried finalized revisions.
    //   2. chapter/ files — the removed chapter's chapter-XXX.json/.md are
    //      deleted, and every later chapter's files are renamed down one slot
    //      (chapter-003 → chapter-002, ...) with their payload metadata
    //      updated to match (chapterIndex, chapterNumber, chapterCount).
    //      Renames run in ASCENDING order: each destination slot was vacated
    //      either by the deletion (first step) or by the previous rename.
    //   3. context.appending — each shifted payload's appending[] has the
    //      removed chapter's summary entry spliced out so positions stay
    //      aligned with the new chapter indices (appending[i] ↔ chapter i,
    //      see buildAppendingFromChapters in story-utils.ts).
    //
    // Re-expansion of any surviving chapter keeps working: its payload
    // (context.appending + context.request) travels with the renamed file.
    //
    // Edge case: removing while a background expansion is in flight is not
    // blocked — same accepted trade-off as the delete/rewrite paths, which
    // the UI also fires blind. A chain expansion (reExpandChapter) stops on
    // its next assertStoryExists/missing-payload check.
    if (removeChapterIndex !== undefined) {
        if (removeChapterIndex < 0) {
            return {
                status: 400,
                response: { error: 'removeChapterIndex must be a non-negative integer' }
            };
        }

        const chapters = Array.isArray(plotpointData.chapters) ? plotpointData.chapters : [];

        if (removeChapterIndex >= chapters.length) {
            return {
                status: 404,
                response: { error: `Chapter ${removeChapterIndex} not found for story '${storyId}'` }
            };
        }

        // Capture the removed chapter's identity for the response BEFORE the splice.
        const removedChapter = chapters[removeChapterIndex];
        const removedTitle =
            typeof removedChapter?.title === 'string' && removedChapter.title.length > 0
                ? removedChapter.title
                : `Chapter ${removeChapterIndex + 1}`;

        // Whether the removed chapter was "complete" (had finalized revisions)
        // — gates the chapterCompleted decrement, mirroring the wasComplete
        // rule of the deleteChapterIndex branch (generationTimeMs > 0 marks a
        // finalized revision; streaming entries carry 0).
        const removedPayload = readChapterPayload(chapterDir, removeChapterIndex);
        const removedRevisions: Array<{ generationTimeMs?: number }> = Array.isArray(
            (removedPayload as any)?.revisions
        )
            ? (removedPayload as any).revisions
            : [];
        const wasComplete = removedRevisions.some(
            (r) => typeof r?.generationTimeMs === 'number' && r.generationTimeMs > 0
        );

        const previousChapterCount = chapters.length;
        const newChapterCount = previousChapterCount - 1;

        // 1. Splice the chapter out of plotpoint.json and renumber the tail.
        chapters.splice(removeChapterIndex, 1);
        chapters.forEach((ch: any, i: number) => {
            ch.number = String(i + 1);
        });
        plotpointData.chapters = chapters;
        plotpointData.chapterCount = newChapterCount;
        if (wasComplete) {
            plotpointData.chapterCompleted = Math.max(0, (plotpointData.chapterCompleted ?? 1) - 1);
        }
        fs.writeFileSync(plotpointJsonPath, JSON.stringify(plotpointData, null, 2), 'utf-8');

        // 2. Shift the chapter files down one slot.
        if (fs.existsSync(chapterDir)) {
            // Delete the removed chapter's payload + markdown mirror (every
            // revision dies with them — that is the point of this operation).
            const paddedRemoved = String(removeChapterIndex + 1).padStart(3, '0');
            for (const ext of ['json', 'md']) {
                const removedPath = path.join(chapterDir, `chapter-${paddedRemoved}.${ext}`);
                if (fs.existsSync(removedPath)) {
                    fs.rmSync(removedPath);
                }
            }

            // Rename every later chapter's files into the vacated slot.
            // Ascending order keeps each destination free: slot removeChapterIndex
            // was just deleted, and slot i-1 was vacated by the previous iteration.
            for (let oldIdx = removeChapterIndex + 1; oldIdx < previousChapterCount; oldIdx++) {
                const newIdx = oldIdx - 1;
                const paddedOld = String(oldIdx + 1).padStart(3, '0');
                const paddedNew = String(newIdx + 1).padStart(3, '0');

                const oldJsonPath = path.join(chapterDir, `chapter-${paddedOld}.json`);
                const newJsonPath = path.join(chapterDir, `chapter-${paddedNew}.json`);
                if (fs.existsSync(oldJsonPath)) {
                    fs.renameSync(oldJsonPath, newJsonPath);

                    // Update the payload's identity + context so re-expansion
                    // and the GET handler (which indexes by chapterIndex) stay
                    // consistent. A corrupted payload keeps its renamed file —
                    // the GET handler skips corrupted JSON anyway.
                    try {
                        const payload = JSON.parse(fs.readFileSync(newJsonPath, 'utf-8'));
                        payload.chapterIndex = newIdx;
                        payload.chapterNumber = String(newIdx + 1);
                        payload.chapterCount = newChapterCount;
                        if (
                            payload.context &&
                            Array.isArray(payload.context.appending) &&
                            payload.context.appending.length > removeChapterIndex
                        ) {
                            // Drop the removed chapter's summary entry so
                            // appending[i] stays aligned with chapter i.
                            payload.context.appending.splice(removeChapterIndex, 1);
                        }
                        fs.writeFileSync(newJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
                    } catch {
                        console.warn(
                            `[PATCH] Could not rewrite shifted payload chapter-${paddedNew}.json for story '${storyId}' (corrupted?) — file renamed without metadata update`
                        );
                    }
                }

                const oldMdPath = path.join(chapterDir, `chapter-${paddedOld}.md`);
                const newMdPath = path.join(chapterDir, `chapter-${paddedNew}.md`);
                if (fs.existsSync(oldMdPath)) {
                    fs.renameSync(oldMdPath, newMdPath);
                }
            }
        }

        console.log(
            `[PATCH] Removed chapter ${removeChapterIndex} ('${removedTitle}') for story '${storyId}' — ${newChapterCount} chapter(s) remain, later chapters renumbered`
        );

        return {
            status: 200,
            response: {
                storyId,
                ...updatedMeta,
                removeChapterIndex,
                title: removedTitle,
                chaptersRemaining: newChapterCount,
                message: `Chapter ${removeChapterIndex} removed — ${newChapterCount} chapter(s) remain`
            }
        };
    }

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

        // Fire-and-forget: rewrite the single chapter (no chain expansion).
        // clientId selects the LLM client for this rewrite (absent → default).
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
            chapterDir,
            clientId
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
    // This mirrors the pattern in generation-create-new-story.ts.
    // clientId selects the LLM client for the chain (absent → default).
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
        chapterDir,
        clientId
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
    // Per-request LLM client id (validated in the handler). Absent → default client.
    clientId?: string;
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

    // Create a fresh LLM client (reused across all expansions in the chain).
    // The per-request clientId is applied to the whole re-expansion chain so
    // every chapter touched by this PATCH is written by the same LLM client.
    const client = createStoryClient(options.clientId);

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
        '> As the world best selling novel writer, you must do the followings:',
        `- Review the chapter "${chapterNumber}: ${chapterTitle}", understand the sequence of events completely`,
        `- ${rewriteContext}`,
        '- Use the full story summary and all the provided context to ensure consistency',
        '- Write in highly graphical explicit details',
        `- The chapter must be a minimum of ${TARGET_WORD_COUNT_PROMPT} words at least!`,
        '- Describe everything in slow-paced vivid imagery. Expand on every details',
        '- Do not output a wall of text! Use short and long paragraphs',
        '- The chapter must be in active voice. Show the story in every vivid details, do not tell it!'
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
    // Per-request LLM client id (validated in the handler). Absent → default client.
    clientId?: string;
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

    const client = createStoryClient(options.clientId);

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
