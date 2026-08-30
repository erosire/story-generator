// ---------------------------------------------------------------------------
// Fork handler — creates a new story by copying plotlines and pre-fork
// chapters from an existing source story, then re-expands from the fork
// chapter onwards.
//
// Fork semantics:
//   - Chapters 0..chapterIndex-1 are copied verbatim (both .json and .md).
//   - Chapters chapterIndex..end are re-expanded using the source story's
//     stored context (chapter-XXX.json holds the LLM context for each).
//   - The new story gets its own storyId, plotpoint.json, and chapter folder.
//   - Re-expansion runs sequentially in the background (fire-and-forget).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { MIN_WORDS_PER_CHAPTER, PREVIOUS_EXPANDED_CHAPTERS, STORY_REQUEST_MESSAGE, DATABASE_BASE_DIR } from './generation-config';
import {
    createStoryClient,
    expandChapter,
    buildExpandRequest,
    readChapterPayload,
    readPlotpointData,
    writeChapterPayload,
    writeChapterFiles
} from './story-utils';
// Abort signal from the job registry — a user-requested Terminate (PATCH
// abortJob) must stop this background flow at its next checkpoint boundary.
import { isStoryAborted } from './generation-job-registry';

export type ForkStoryOptions = {
    newStoryId: string;
    sourceStoryId: string;
    chapterIndex: number;
    root: string;
    // Optional per-request LLM client id (validated by parseClientId in the
    // create-new-story handler before forkStory is invoked). Re-expansion of
    // the forked chapters uses this client; absent id → default client.
    clientId?: string;
};

/**
 * Fork a story: copy everything up to the fork chapter, then re-expand
 * from the fork chapter onwards. Runs in the background (fire-and-forget).
 */
export const forkStory = async (options: ForkStoryOptions) => {
    const { newStoryId, sourceStoryId, chapterIndex, root: projectRoot, clientId } = options;

    const sourceDir = path.join(projectRoot, DATABASE_BASE_DIR, sourceStoryId);
    const newDir = path.join(projectRoot, DATABASE_BASE_DIR, newStoryId);

    // ── Validate source story exists ──────────────────────────────────────
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source story '${sourceStoryId}' not found`);
    }

    const sourcePlotpointPath = path.join(sourceDir, 'plotpoint.json');
    if (!fs.existsSync(sourcePlotpointPath)) {
        throw new Error(`Source story '${sourceStoryId}' has no plotpoint.json`);
    }

    // ── Read source metadata ──────────────────────────────────────────────
    const sourceMeta = JSON.parse(fs.readFileSync(sourcePlotpointPath, 'utf-8'));
    const { storyline, chapterCount, chapters: plotpointChapters } = sourceMeta;
    // Preserve storyName from source story if it exists; otherwise derive from storyline
    const storyName = sourceMeta.storyName
        || storyline.split('\n')[0].trim().slice(0, 120)
        || storyline.slice(0, 120);

    if (!Array.isArray(plotpointChapters) || plotpointChapters.length === 0) {
        throw new Error(`Source story '${sourceStoryId}' has no chapters in plotpoint.json`);
    }

    if (chapterIndex < 0 || chapterIndex >= plotpointChapters.length) {
        throw new Error(
            `chapterIndex ${chapterIndex} is out of range for source story '${sourceStoryId}' (${plotpointChapters.length} chapters)`
        );
    }

    // ── Create new story directory structure ───────────────────────────────
    const newChapterDir = path.join(newDir, 'chapter');
    fs.mkdirSync(newChapterDir, { recursive: true });

    const createdAt = new Date().toISOString();

    // ── Copy chapters before the fork point ────────────────────────────────
    // Chapters 0..chapterIndex-1 are copied verbatim (both .json and .md).
    const sourceChapterDir = path.join(sourceDir, 'chapter');

    // Count how many of the copied chapters are already expanded (have finalized
    // revisions). This sets the initial chapterCompleted so the list endpoint
    // doesn't need to scan chapter files.
    let copiedCompletedCount = 0;
    for (let i = 0; i < chapterIndex; i++) {
        const padded = String(i + 1).padStart(3, '0');
        const srcJson = path.join(sourceChapterDir, `chapter-${padded}.json`);
        if (fs.existsSync(srcJson)) {
            try {
                const data = JSON.parse(fs.readFileSync(srcJson, 'utf-8'));
                const revisions = data?.revisions;
                if (
                    Array.isArray(revisions) &&
                    revisions.length > 0 &&
                    revisions.some((r: any) => typeof r.content === 'string' && r.content.length > 0)
                ) {
                    copiedCompletedCount++;
                }
            } catch {
                // Corrupted JSON — skip
            }
        }
    }

    // Write plotpoint.json for the new story (new storyId, same metadata)
    const newPlotpointData = {
        storyId: newStoryId,
        storyName,
        storyline,
        chapterCount,
        chapterCompleted: copiedCompletedCount,
        chapters: plotpointChapters,
        createdAt
    };
    fs.writeFileSync(path.join(newDir, 'plotpoint.json'), JSON.stringify(newPlotpointData, null, 2), 'utf-8');
    console.log(`[FORK] plotpoint.json written for new story '${newStoryId}'`);

    // Write plotpoint.md for filesystem viewing
    const plotpointContent = plotpointChapters
        .map((ch: any) => {
            const points = Array.isArray(ch.plotpoints)
                ? ch.plotpoints.map((p: string) => `- ${p}`).join('\n')
                : '(missing)';
            return `> ${ch.number}: ${ch.title}\n\n${points}`;
        })
        .join('\n\n---\n\n');
    fs.writeFileSync(path.join(newDir, 'plotpoint.md'), plotpointContent, 'utf-8');

    for (let i = 0; i < chapterIndex; i++) {
        const padded = String(i + 1).padStart(3, '0');

        // Copy .json
        const srcJson = path.join(sourceChapterDir, `chapter-${padded}.json`);
        if (fs.existsSync(srcJson)) {
            const data = JSON.parse(fs.readFileSync(srcJson, 'utf-8'));
            // Update storyId in the copied payload
            data.storyId = newStoryId;
            fs.writeFileSync(path.join(newChapterDir, `chapter-${padded}.json`), JSON.stringify(data, null, 2), 'utf-8');
        }

        // Copy .md
        const srcMd = path.join(sourceChapterDir, `chapter-${padded}.md`);
        if (fs.existsSync(srcMd)) {
            fs.copyFileSync(srcMd, path.join(newChapterDir, `chapter-${padded}.md`));
        }

        console.log(`[FORK] Copied chapter ${i} to new story '${newStoryId}'`);
    }

    // ── Copy chapter payloads for fork+ chapters (for re-expansion context) ─
    // We copy the .json files so the re-expansion has the stored context,
    // but we'll overwrite them with fresh results during expansion.
    for (let i = chapterIndex; i < plotpointChapters.length; i++) {
        const padded = String(i + 1).padStart(3, '0');
        const srcJson = path.join(sourceChapterDir, `chapter-${padded}.json`);

        if (fs.existsSync(srcJson)) {
            const data = JSON.parse(fs.readFileSync(srcJson, 'utf-8'));
            // Update storyId in the payload but keep the rest (context, etc.)
            data.storyId = newStoryId;
            fs.writeFileSync(path.join(newChapterDir, `chapter-${padded}.json`), JSON.stringify(data, null, 2), 'utf-8');
        }
    }

    // ── Sequentially re-expand chapters from chapterIndex onwards ───────────
    // Uses the per-request clientId when the caller supplied one, otherwise
    // falls back to the default client inside resolveClient.
    const client = createStoryClient(clientId);

    // Prime the conversation with the story context
    client.user(STORY_REQUEST_MESSAGE);
    client.assistant(storyline);

    // Build the appending[] context from plotpoint summaries
    const originalSummaries: string[] = [];
    const appending: string[] = [];

    for (const ch of plotpointChapters) {
        if (!Array.isArray(ch.plotpoints) || ch.plotpoints.length === 0) {
            continue;
        }
        const entry = [
            `> ${ch.number}: ${ch.title}`,
            '\n\n',
            ch.plotpoints.map((plot: string) => `- ${plot}`).join('\n')
        ].join('\n\n');
        appending.push(entry);
        originalSummaries.push(entry);
    }

    // If we have chapters before the fork point, replace their summaries
    // with expanded content from the source story's .json files.
    // Content lives exclusively in revisions[] — read the latest revision.
    for (let i = 0; i < chapterIndex; i++) {
        const padded = String(i + 1).padStart(3, '0');
        const srcJson = path.join(sourceChapterDir, `chapter-${padded}.json`);

        if (fs.existsSync(srcJson)) {
            const data = JSON.parse(fs.readFileSync(srcJson, 'utf-8'));
            const revisions = data?.revisions;
            if (Array.isArray(revisions) && revisions.length > 0) {
                // Use the latest revision (last entry) as the expanded content
                const latestRev = revisions[revisions.length - 1];
                if (latestRev && typeof latestRev.content === 'string' && latestRev.content.length > 0) {
                    const chapterTitle = data.title ?? `Chapter ${i + 1}`;
                    appending[i] = `## ${chapterTitle}\n\n${latestRev.content}`;
                }
            }
        }
    }

    // Now expand each chapter from chapterIndex onwards
    for (let i = chapterIndex; i < plotpointChapters.length; i++) {
        const ch = plotpointChapters[i];
        const { number, title, plotpoints } = ch;

        console.log(`[FORK] Expanding chapter ${number}: ${title} (${i + 1}/${plotpointChapters.length}) for story '${newStoryId}'`);

        const request = buildExpandRequest(number, title);

        // Snapshot context before expansion
        const contextSnapshot = [...appending];

        // Write skeleton payload before LLM call (same pattern as create-new-story)
        writeChapterPayload({
            chapterDir: newChapterDir,
            chapterIndex: i,
            storyId: newStoryId,
            storyline,
            chapterCount,
            chapterNumber: number,
            plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
            contextAppending: contextSnapshot,
            request
        });

        const expandStartMs = Date.now();

        // Guard mirrors the other background flows: the forked dir can be
        // deleted mid-expansion (user deletes from the list) AND a
        // user-requested job termination (PATCH abortJob) is equally terminal
        // — both throw to unwind the fire-and-forget promise.
        const assertStoryExists = () => {
            // Abort check FIRST — a pending termination wins over folder state.
            if (isStoryAborted(newStoryId)) {
                throw new Error(`Story fork aborted by user request — storyId: ${newStoryId}`);
            }
            if (!fs.existsSync(newDir)) {
                throw new Error(`Forked story folder deleted — aborting generation for storyId: ${newStoryId}`);
            }
        };

        const result = await expandChapter({
            client,
            appending,
            chapterDir: newChapterDir,
            assertStoryExists,
            chapterNumber: number,
            chapterIndex: i,
            request,
            minWords: MIN_WORDS_PER_CHAPTER
        });

        const generationTimeMs = Date.now() - expandStartMs;

        writeChapterFiles({
            chapterDir: newChapterDir,
            chapterIndex: i,
            storyId: newStoryId,
            storyline,
            chapterCount,
            chapterNumber: number,
            plotpoints: Array.isArray(plotpoints) ? plotpoints : [],
            contextAppending: contextSnapshot,
            request,
            result,
            generationTimeMs
        });

        // Restore older expanded chapters back to plotpoint summaries.
        // We keep at most PREVIOUS_EXPANDED_CHAPTERS expanded chapters
        // immediately before the current index.
        const restoreFrom = i - PREVIOUS_EXPANDED_CHAPTERS - 1;
        if (restoreFrom >= 0) {
            appending[restoreFrom] = originalSummaries[restoreFrom];
        }

        // Replace current chapter's entry with expanded content for next chapter's context
        appending[i] = `## ${result.title}\n\n${result.content}`;

        console.log(`[FORK] Chapter ${number} expanded (${result.content.split(' ').length} words, ${generationTimeMs}ms)`);
    }

    console.log(`[FORK] Story generation complete for forked story '${newStoryId}' (source: '${sourceStoryId}', fork from chapter ${chapterIndex})`);
};
