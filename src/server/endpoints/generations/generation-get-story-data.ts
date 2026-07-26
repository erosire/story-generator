import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { resolveStoryboardDir } from './story-utils';
import { DATABASE_BASE_DIR } from './generation-config';

export const generationGetStoryData = asHandlerMethod(async (_, parameters, variables) => {
    const { root: projectRoot } = variables;

    // Get the storyId from the path parameters
    const storyId = parameters.path.storyId;

    if (!storyId) {
        return {
            status: 400,
            response: { error: 'storyId is required' }
        };
    }

    // Dual-purpose endpoint per storyboard-generations.yml: when storyId is the
    // reserved literal "list", return all story IDs (directory names from
    // temporary/database/storyboard/). No chapter/plotlines data is included —
    // callers must issue a second GET with a specific storyId for details.
    if (storyId === 'list') {
        const storyboardRoot = path.join(projectRoot, DATABASE_BASE_DIR);
        let stories: string[] = [];
        if (fs.existsSync(storyboardRoot)) {
            // readdirSync with { withFileTypes: true } returns Dirent objects; we
            // filter to directories only so stray files don't get reported as stories.
            stories = fs
                .readdirSync(storyboardRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
        }
        return {
            status: 200,
            response: { stories }
        };
    }

    // Resolve the storyboard directory for a specific storyId
    const databaseDir = resolveStoryboardDir(projectRoot, storyId);

    if (!fs.existsSync(databaseDir)) {
        return {
            status: 404,
            response: { error: `Story '${storyId}' not found` }
        };
    }

    // Read plotpoint.json — single source of truth for story metadata + chapter data.
    // Before generation, it holds { chapters: [], status: 'generating' } plus story metadata.
    const plotpointJsonPath = path.join(databaseDir, 'plotpoint.json');
    let meta: { storyName?: string; storyline: string; chapterCount: number; createdAt: string } | null = null;
    let plotpointChapters: { number: string; title: string; plotpoints: string[] }[] = [];
    if (fs.existsSync(plotpointJsonPath)) {
        try {
            const plotpointData = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
            // Extract story metadata (storyName, storyline, chapterCount, createdAt) from the same file
            if (plotpointData.storyline || plotpointData.chapterCount || plotpointData.createdAt) {
                meta = {
                    ...(plotpointData.storyName ? { storyName: plotpointData.storyName } : {}),
                    storyline: plotpointData.storyline ?? '',
                    chapterCount: plotpointData.chapterCount ?? 0,
                    createdAt: plotpointData.createdAt ?? ''
                };
            }
            if (Array.isArray(plotpointData.chapters)) {
                plotpointChapters = plotpointData.chapters;
            }
        } catch {
            // Corrupted plotpoint.json — treat as no plotpoints yet
        }
    }

    // Read all chapter expansion data from the chapter/ subfolder.
    // All data comes from chapter-XXX.json files — the .md files are only for
    // filesystem viewing and are not used by the API response.
    const chapterDir = path.join(databaseDir, 'chapter');
    const payloadByIndex: Record<number, Record<string, unknown>> = {};

    if (fs.existsSync(chapterDir)) {
        // Read chapter-XXX.json payloads (full expansion metadata + history)
        const jsonFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort();
        for (const f of jsonFiles) {
            try {
                const payload = JSON.parse(fs.readFileSync(path.join(chapterDir, f), 'utf-8'));
                if (typeof payload === 'object' && payload !== null && typeof (payload as any).chapterIndex === 'number') {
                    payloadByIndex[(payload as any).chapterIndex] = payload;
                }
            } catch {
                // Skip corrupted JSON files
            }
        }
    }

    // Build the unified chapters array. Each chapter entry is built entirely
    // from the chapter-XXX.json payload — the .md files are only for
    // filesystem viewing and are not used by the API.
    // Chapters that haven't been expanded yet (skeleton with empty revisions[])
    // still appear with their plotpoints and an `expanded: false` flag.
    const chapters = plotpointChapters.map((ch, index) => {
        const payload = payloadByIndex[index];
        const hasPayload = typeof payload === 'object' && payload !== null;
        // A chapter is "expanded" when its revisions[] has at least one entry
        // with non-empty content (i.e. the LLM has completed generation at least once).
        const revisions: Array<{ content: string; wordCount: number; generationTimeMs: number }> = [];
        if (hasPayload) {
            const payloadObj = payload as any;
            // Read from revisions[] — the sole source of truth for content
            if (Array.isArray(payloadObj.revisions)) {
                for (const rev of payloadObj.revisions) {
                    if (rev && typeof rev.content === 'string') {
                        revisions.push({
                            content: rev.content,
                            wordCount: typeof rev.wordCount === 'number' ? rev.wordCount : 0,
                            generationTimeMs: typeof rev.generationTimeMs === 'number' ? rev.generationTimeMs : 0
                        });
                    }
                }
            }
        }
        const expanded = revisions.length > 0 && revisions.some((r) => r.content.length > 0);
        // canReExpand is true when the chapter-XXX.json payload exists — this
        // file stores the LLM conversation context needed for re-expansion.
        const canReExpand = hasPayload;

        return {
            chapterNumber: ch.number,
            chapterIndex: index,
            title: ch.title,
            plotpoints: Array.isArray(ch.plotpoints) ? ch.plotpoints : [],
            expanded,
            canReExpand,
            ...(expanded ? { revisions } : {})
        };
    });

    return {
        status: 200,
        response: { chapters, meta }
    };
});
