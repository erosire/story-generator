import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { resolveProjectRoot } from './story-utils';
import { DATABASE_BASE_DIR } from './generation-config';

// Story metadata shape returned by the /list endpoint.
// Field names differ from what is stored in plotpoint.json:
//   - plotpoint.json stores `createdAt` and `chapterCount` (written by generation-create-new-story)
//   - The API response renames them to `createdDate` and `chapterRequested` per the spec
//   - `chapterCompleted` is derived by counting expanded chapter files in the chapter/ subdirectory
//   - `status` is derived from the plotpoint.json `status` field ('generating', 'failed')
//     combined with chapter completion (all chapters expanded → 'completed')
//
// Note: storyline is intentionally omitted from the list response — it is
// free-form user text that can be arbitrarily long and is not needed by the
// sidebar which only renders storyName/storyId (as title) and chapterRequested (as badge).
type StoryMeta = {
    storyId: string;
    storyName?: string;
    chapterRequested: number;
    chapterCompleted: number;
    createdDate: string;
    status: 'generating' | 'completed' | 'failed';
};

// Count how many chapters have been expanded (have non-empty revisions[] in chapter-XXX.json)
// This scans the chapter/ subdirectory and reads each .json payload to determine expansion status.
const countCompletedChapters = (storyDir: string): number => {
    const chapterDir = path.join(storyDir, 'chapter');
    if (!fs.existsSync(chapterDir)) return 0;

    // Read all .json files from the chapter directory — each represents one chapter
    const jsonFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json'));
    let completed = 0;

    for (const f of jsonFiles) {
        try {
            const raw = fs.readFileSync(path.join(chapterDir, f), 'utf-8');
            const payload = JSON.parse(raw);
            // A chapter is "completed" when revisions[] has at least one entry
            // with non-empty content (matches the expanded check in generation-get-story-data.ts)
            const revisions = payload?.revisions;
            if (
                Array.isArray(revisions) &&
                revisions.length > 0 &&
                revisions.some((r: any) => typeof r.content === 'string' && r.content.length > 0)
            ) {
                completed++;
            }
        } catch {
            // Corrupted JSON — skip, don't count as completed
        }
    }

    return completed;
};

// Derive the final status from the raw plotpoint.json status + chapter completion.
// Logic:
//   - If plotpoint.json status is 'failed' → 'failed' (generation hit an error)
//   - If chapterCompleted >= chapterRequested and chapterRequested > 0 → 'completed'
//   - Otherwise → 'generating' (still in progress)
const deriveStatus = (
    rawStatus: string | undefined,
    chapterCompleted: number,
    chapterRequested: number
): 'generating' | 'completed' | 'failed' => {
    if (rawStatus === 'failed') return 'failed';
    if (chapterRequested > 0 && chapterCompleted >= chapterRequested) return 'completed';
    return 'generating';
};

// List all stories in the storyboard database directory
// Each entry includes the story metadata (chapterRequested, chapterCompleted, createdDate, status)
// from plotpoint.json if available, otherwise falls back to just the storyId
export const generationListStories = asHandlerMethod(async (_, parameters) => {
    const projectRoot = resolveProjectRoot();

    // Resolve the storyboard database directory
    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR);

    // Check if the storyboard directory exists
    if (!fs.existsSync(databaseDir)) {
        return {
            status: 200,
            response: { stories: [] }
        };
    }

    // Read all entries in the storyboard directory
    // Filter to only directories (each directory represents a story)
    const entries = fs.readdirSync(databaseDir, { withFileTypes: true });
    const stories: StoryMeta[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const storyDir = path.join(databaseDir, entry.name);
        const plotpointJsonPath = path.join(storyDir, 'plotpoint.json');

        if (fs.existsSync(plotpointJsonPath)) {
            try {
                const raw = fs.readFileSync(plotpointJsonPath, 'utf-8');
                const data = JSON.parse(raw);

                // Compute chapterCompleted by scanning the chapter/ subdirectory
                const chapterCompleted = countCompletedChapters(storyDir);
                const chapterRequested = data.chapterCount ?? 0;

                stories.push({
                    storyId: data.storyId ?? entry.name,
                    ...(data.storyName ? { storyName: data.storyName } : {}),
                    chapterRequested,
                    chapterCompleted,
                    // Rename createdAt → createdDate per the API spec
                    createdDate: data.createdAt ?? '',
                    // Derive status from raw plotpoint.json status + chapter completion
                    status: deriveStatus(data.status, chapterCompleted, chapterRequested)
                });
            } catch {
                // If plotpoint.json is corrupted or unreadable, fall back to minimal metadata
                stories.push({
                    storyId: entry.name,
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '',
                    status: 'generating'
                });
            }
        } else {
            // Legacy story without plotpoint.json — include with empty metadata
            stories.push({
                storyId: entry.name,
                chapterRequested: 0,
                chapterCompleted: 0,
                createdDate: '',
                status: 'generating'
            });
        }
    }

    // Return stories sorted by createdDate descending (newest first)
    stories.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    return {
        status: 200,
        response: { stories }
    };
});
