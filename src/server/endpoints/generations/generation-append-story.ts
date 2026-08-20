// ---------------------------------------------------------------------------
// Append handler — extends an EXISTING story with N new plotline chapters.
//
// Triggered by the dashboard's "[->]" append dialog (SectionStoryContent),
// which POSTs { append: { chapterCount, notes? } } to the SAME storyId as
// the story being extended (see generation-create-new-story.ts handler —
// the append branch runs before the plain create branch).
//
// Append semantics:
//   - The story must already exist with a plotpoint.json, a stored storyline,
//     and at least one chapter WITH plotpoints (there is nothing to continue
//     from otherwise). Validation runs synchronously in the handler so the
//     client surfaces the exact 400 reason.
//   - The LLM is primed exactly like forkStory (generation-fork-story.ts:175-177):
//     system/opening from createStoryClient, then user(STORY_REQUEST_MESSAGE) +
//     assistant(storyline). The appending[] context holds the in-order
//     plotpoint summaries of every existing chapter; for the most recent
//     chapters that have been expanded, their latest expanded prose replaces
//     the summary so the model continues from actual text (same pattern as
//     the fork's priming pass, generation-fork-story.ts:199-215).
//   - It is asked for plotlines of exactly chapterCount NEW chapters,
//     numbered existingCount+1 .. existingCount+chapterCount.
//   - On success the results are APPENDED to plotpoint.json after the current
//     chapter list (10 existing + 3 appended = 13 chapters), chapter numbers
//     are renumbered sequentially, chapterCount becomes the new total, and
//     plotpoint.md gains the new entries. The original stories fields
//     (storyline/storyName/chapterCompleted/status/createdAt) are untouched.
//   - A skeleton chapter-XXX.json payload is written for every new chapter
//     (stored LLM context, empty revisions[]) so each one can be expanded
//     individually via PATCH expandChapterIndex — the append itself NEVER
//     expands a chapter (plotpoints only, mirroring the dashboard's
//     plotOnly generate flow).
//   - On LLM validation failure NOTHING is written — the story state is left
//     untouched and the error is logged by the fire-and-forget caller.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { arrayEach } from '@presource/core';
import {
    DATABASE_BASE_DIR,
    MIN_PLOTPOINTS_PER_CHAPTER,
    PREVIOUS_EXPANDED_CHAPTERS,
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

export type AppendStoryChaptersOptions = {
    storyId: string;
    // How many NEW chapters to append (added on top of the existing count).
    chapterCount: number;
    // Optional free-form author notes from the append dialog — injected into
    // the plotline request so the model steers the new plotlines.
    notes?: string;
    root: string;
    // Optional per-request LLM client id (validated by parseClientId in the
    // create-new-story handler before appendStoryChapters is invoked).
    clientId?: string;
};

/**
 * Synchronously validate that a story can be appended to. Throws an Error
 * whose message is user-facing (surfaced as the handler's 400 body).
 * Returns the resolved database dir + parsed plotpoint.json meta on success.
 */
export const validateAppendableStory = (projectRoot: string, storyId: string): {
    databaseDir: string;
    meta: Record<string, any>;
} => {
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
    // story to continue.
    if (!meta?.storyline || typeof meta.storyline !== 'string' || meta.storyline.length === 0) {
        throw new Error(`Story '${storyId}' has no storyline to continue from`);
    }
    if (!Array.isArray(meta.chapters) || meta.chapters.length === 0) {
        throw new Error(`Story '${storyId}' has no chapters to append to`);
    }
    // Every existing chapter needs plotpoints — the appending[] context and
    // the all-chapter summary snapshots are built from them, and one empty
    // chapter would leave the LLM with a broken outline to continue from.
    for (const ch of meta.chapters) {
        if (!Array.isArray(ch?.plotpoints) || ch.plotpoints.length === 0) {
            throw new Error(`Story '${storyId}' has a chapter without plotpoints`);
        }
    }
    return { databaseDir, meta };
};

/**
 * Append plotlines for chapterCount new chapters to an existing story.
 * Runs in the background (fire-and-forget) — the handler returns 200 as soon
 * as validation passes; the dashboard's GET polling picks the new chapters up
 * as soon as plotpoint.json is rewritten.
 */
export const appendStoryChapters = async (options: AppendStoryChaptersOptions) => {
    const { storyId, chapterCount, notes, root: projectRoot, clientId } = options;

    // Synchronous guard — the handler already validated, but re-check so a
    // story deleted between handler validation and background start fails fast.
    const { databaseDir, meta } = validateAppendableStory(projectRoot, storyId);
    const storyline = meta.storyline;
    const existingChapters: Array<{ number: string; title: string; plotpoints: string[] }> = meta.chapters;
    const existingCount = existingChapters.length;

    // Chapter folder must exist before the skeleton payloads below.
    const chapterDir = path.join(databaseDir, 'chapter');
    fs.mkdirSync(chapterDir, { recursive: true });

    // The story dir can be deleted mid-LLM-call (user deletes from the list);
    // guard every post-call write with this, matching generateStory's contract.
    const assertStoryExists = () => {
        if (!fs.existsSync(databaseDir)) {
            throw new Error(`Story folder deleted — aborting append for storyId: ${storyId}`);
        }
    };

    // ── Prime the LLM client ──────────────────────────────────────────────
    // createStoryClient() seeds the system instructions + opening exchange;
    // then the story request + storyline, exactly like generateStory
    // (generation-create-new-story.ts:300-301) and forkStory (:175-177).
    const client = createStoryClient(clientId);
    client.user(STORY_REQUEST_MESSAGE);
    client.assistant(storyline);

    // In-order plotpoint summaries of the existing chapters. validateAppendableStory
    // guarantees every chapter has plotpoints, so buildAppendingFromChapters
    // returns exactly existingCount entries with indices aligned to chapters[].
    const appending = buildAppendingFromChapters(existingChapters);

    // Mirror the fork's priming pass (generation-fork-story.ts:199-215): for
    // the most recent PREVIOUS_EXPANDED_CHAPTERS chapters that have expanded
    // prose, replace their summaries with the latest revision content so the
    // model continues from actual text, not just plotpoints.
    for (let i = Math.max(0, existingCount - PREVIOUS_EXPANDED_CHAPTERS); i < existingCount; i++) {
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

    // ── Request the NEW plotlines ─────────────────────────────────────────
    // The prompt states exactly how many chapters to produce and that earlier
    // chapters must not be revisited — the LLM's returned `number` fields are
    // therefore ignored and chapters are renumbered here deterministically.
    const request = [
        `> The story so far contains ${existingCount} finished chapters, summarized in order above.`,
        `> Continue the story: submit me the detailed plotpoints of the NEXT ${chapterCount} new chapters. They become chapters ${existingCount + 1} to ${existingCount + chapterCount}.`,
        '> The plotpoint must includes all the important dialogues',
        `> There must be at least ${MIN_PLOTPOINTS_PER_CHAPTER} plotpoints per chapter`,
        '> Must clearly outlines how each chapter starts, and how each chapter ends',
        '> Do NOT re-summarize, revise or renumber the earlier chapters.',
        // Optional author notes from the append dialog — steer the new plotlines.
        ...(notes ? [notes] : [])
    ].join('\n');

    // Single structured call. Stall/retry plumbing deliberately stays in the
    // create path (generation-create-new-story.ts) — a failed append leaves
    // the story untouched, and the user can simply re-open the dialog.
    const result = await callStructured(client, {
        request,
        response: Type.Object({
            chapters: Type.Array(
                Type.Object({
                    number: Type.String({ description: 'the chapter number' }),
                    title: Type.String({ description: 'the title of the chapter' }),
                    plotpoints: Type.Array(Type.String(), { description: 'the detailed plotpoints of the chapter' })
                }),
                { description: 'a list of NEW chapter plotpoints to append' }
            )
        })
    });

    // callStructured resolves { response: { chapters } } (both client.format
    // and client.structure share that envelope — see the destructuring in
    // generateStory, generation-create-new-story.ts:387-389). Guard against a
    // malformed payload whose response lacks a chapters array.
    const responseChapters: unknown = (result as any)?.response?.chapters;
    const generatedChapters: Array<{ number: string; title: string; plotpoints: string[] }> = Array.isArray(responseChapters)
        ? responseChapters.map((ch: any) => ({
              number: String(ch?.number ?? ''),
              title: String(ch?.title ?? ''),
              plotpoints: Array.isArray(ch?.plotpoints) ? ch.plotpoints : []
          }))
        : [];

    // Terminal validation: the exact requested count AND at least one
    // plotpoint per chapter. On failure NOTHING is written — the throw is
    // caught by the fire-and-forget caller in the handler.
    if (generatedChapters.length !== chapterCount || generatedChapters.some((ch) => ch.plotpoints.length === 0)) {
        throw new Error(
            `Append failed for story '${storyId}': LLM returned ${generatedChapters.length}/${chapterCount} chapters ` +
                `with usable plotpoints`
        );
    }

    assertStoryExists();

    // ── Renumber + append ─────────────────────────────────────────────────
    // Deterministic numbering regardless of whatever `number` the LLM echoed.
    const appendedChapters = generatedChapters.map((ch, i) => ({
        number: String(existingCount + i + 1),
        title: ch.title || `Chapter ${existingCount + i + 1}`,
        plotpoints: ch.plotpoints
    }));
    const allChapters = [...existingChapters, ...appendedChapters];
    const totalChapterCount = existingCount + chapterCount;

    // Rewrite plotpoint.json — the single source of truth. Spreading `meta`
    // preserves storyline/storyName/chapterCompleted/status/validation/createdAt;
    // only the chapter list and total count change (10 existing + 3 appended = 13).
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');
    const updatedMeta = {
        ...meta,
        storyId,
        chapters: allChapters,
        chapterCount: totalChapterCount
    };
    fs.writeFileSync(plotpointJsonPath, JSON.stringify(updatedMeta, null, 2), 'utf-8');
    console.log(`[APPEND] plotpoint.json updated for story '${storyId}' (${existingCount} + ${chapterCount} = ${totalChapterCount} chapters)`);

    // Append the new entries to plotpoint.md (filesystem viewing only — the
    // API reads plotpoint.json; generation-get-story-data.ts).
    const plotpointMdPath = path.join(databaseDir, 'plotpoint.md');
    const mdEntries = appendedChapters
        .map((ch) => `> ${ch.number}: ${ch.title}\n\n${ch.plotpoints.map((p) => `- ${p}`).join('\n')}`)
        .join('\n\n---\n\n');
    const existingMd = fs.existsSync(plotpointMdPath) ? fs.readFileSync(plotpointMdPath, 'utf-8') : '';
    fs.writeFileSync(plotpointMdPath, existingMd ? `${existingMd}\n\n---\n\n${mdEntries}` : mdEntries, 'utf-8');

    // ── Skeleton payloads for the new chapters ────────────────────────────
    // Same contract as the plotline-only generate path (generation-create-new-story.ts:698-711):
    // each new chapter stores the full all-summary context it would see on its
    // first expansion, so PATCH expandChapterIndex works immediately without
    // any chapter content having been generated.
    const fullAppending = buildAppendingFromChapters(allChapters);
    arrayEach(appendedChapters, ({ index, value: chapter }) => {
        assertStoryExists();
        writeChapterPayload({
            chapterDir,
            chapterIndex: existingCount + index,
            storyId,
            storyline,
            chapterCount: totalChapterCount,
            chapterNumber: chapter.number,
            plotpoints: chapter.plotpoints,
            contextAppending: fullAppending,
            request: buildExpandRequest(chapter.number, chapter.title)
        });
    });

    console.log(`[APPEND] Story '${storyId}' extended with ${chapterCount} new plotline chapters (no expansion performed)`);
};