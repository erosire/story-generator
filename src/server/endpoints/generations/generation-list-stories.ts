import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { DATABASE_BASE_DIR } from './generation-config';
import { getActiveStoryJobs, isStoryJobActive, type StoryJob } from './generation-job-registry';

// Story metadata shape returned by the collection endpoint.
// Field names differ from what is stored in plotpoint.json:
//   - plotpoint.json stores `createdAt` and `chapterCount` (written by generation-create-new-story)
//   - The API response renames them to `createdDate` and `chapterRequested` per the spec
//   - `chapterCompleted` is denormalized in plotpoint.json by writeChapterFiles (story-utils.ts)
//     and read directly here instead of scanning every chapter JSON file.
//   - `status` is derived from the plotpoint.json `status` field ('generating',
//     'completed' — plotline-only stories, 'failed') combined with chapter
//     completion (all chapters expanded → 'completed')
//   - `processing` is the LIVE background-thread flag from the job registry
//     (generation-job-registry.ts) — true while any background job (create,
//     fork, append, resume, expand, rewrite) is running for this storyId in
//     THIS server process. Unlike `status`, it dies with a server restart
//     (blank slate), so a stuck 'generating' story without a live job is NOT
//     reported as processing. This is what the sidebar animates on.
//   - `lastUpdatedDate` is the mtime of plotpoint.json (fs.statSync), emitted
//     as an ISO string. Every write to plotpoint.json (plotline generation,
//     chapterCompleted denormalization, rename, chapter add/remove) bumps the
//     mtime, so the dashboard's static memory (localStorage cache) uses this
//     as the staleness key: a cached record whose lastUpdatedDate differs from
//     the server's value must be re-fetched.
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
    lastUpdatedDate: string;
    status: 'generating' | 'completed' | 'failed';
    processing: boolean;
};

// Derive the final status from the raw plotpoint.json status + chapter completion.
// Logic:
//   - If plotpoint.json status is 'failed' → 'failed' (generation hit an error)
//   - If plotpoint.json status is 'completed' → 'completed' (plotline-only story:
//     the Generate-button flow writes this terminal status once plotlines are
//     generated even though chapterCompleted stays 0 — see plotOnly in
//     generation-create-new-story.ts; full-generation stories never write this
//     status, only 'generating'/'failed')
//   - If chapterCompleted >= chapterRequested and chapterRequested > 0 → 'completed'
//   - Otherwise → 'generating' (still in progress)
const deriveStatus = (
    rawStatus: string | undefined,
    chapterCompleted: number,
    chapterRequested: number
): 'generating' | 'completed' | 'failed' => {
    if (rawStatus === 'failed') return 'failed';
    // Explicit terminal status from the plotline-only completion path.
    if (rawStatus === 'completed') return 'completed';
    if (chapterRequested > 0 && chapterCompleted >= chapterRequested) return 'completed';
    return 'generating';
};

// Read the mtime of plotpoint.json as the story's last-updated timestamp,
// normalized to an ISO string. Every server-side write path (plotline
// generation, writeChapterFiles denormalizing chapterCompleted, rename,
// chapter add/remove) rewrites plotpoint.json, so mtime moves on any change.
// Returns '' when stat fails (file vanished mid-list, Windows race) so the
// client treats missing timestamp as "unknown" rather than crashing.
const readLastUpdatedDate = (plotpointJsonPath: string): string => {
    try {
        return fs.statSync(plotpointJsonPath).mtime.toISOString();
    } catch {
        return '';
    }
};

// List all stories in the storyboard directory below the shared database root.
// Each entry includes the story metadata (chapterRequested, chapterCompleted, createdDate, status)
// from plotpoint.json if available, otherwise falls back to just the storyId.
// The response also carries the LIVE background-job registry snapshot: the
// per-story `processing` flag and the top-level `jobs` array — the in-memory
// view of every background thread currently running on this server process
// (blank after a restart, see generation-job-registry.ts).
export const generationListStories = asHandlerMethod(async (_, parameters, variables) => {
    const projectRoot = variables.root;

    // Resolve the storyboard database directory
    const databaseDir = path.join(projectRoot, DATABASE_BASE_DIR);

    // Check if the storyboard directory exists
    if (!fs.existsSync(databaseDir)) {
        return {
            status: 200,
            response: { stories: [], jobs: getActiveStoryJobs() }
        };
    }

    // Read all entries in the storyboard directory
    // Filter to only directories (each directory represents a story)
    const entries = fs.readdirSync(databaseDir, { withFileTypes: true });
    const stories: StoryMeta[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Live background-thread flag for this storyId — read from the
        // process-local job registry (blank after a server restart).
        const processing = isStoryJobActive(entry.name);

        const storyDir = path.join(databaseDir, entry.name);
        const plotpointJsonPath = path.join(storyDir, 'plotpoint.json');

        if (fs.existsSync(plotpointJsonPath)) {
            try {
                const raw = fs.readFileSync(plotpointJsonPath, 'utf-8');
                const data = JSON.parse(raw);

                // Read chapterCompleted directly from plotpoint.json (denormalized field)
                // instead of scanning every chapter JSON file. This field is maintained
                // by writeChapterFiles() in story-utils.ts whenever a chapter is first expanded.
                const chapterCompleted = typeof data.chapterCompleted === 'number' ? data.chapterCompleted : 0;
                const chapterRequested = data.chapterCount ?? 0;

                stories.push({
                    storyId: data.storyId ?? entry.name,
                    ...(data.storyName ? { storyName: data.storyName } : {}),
                    chapterRequested,
                    chapterCompleted,
                    // Rename createdAt → createdDate per the API spec
                    createdDate: data.createdAt ?? '',
                    // mtime of plotpoint.json — staleness key for the dashboard's static memory
                    lastUpdatedDate: readLastUpdatedDate(plotpointJsonPath),
                    // Derive status from raw plotpoint.json status + chapter completion
                    status: deriveStatus(data.status, chapterCompleted, chapterRequested),
                    processing
                });
            } catch {
                // If plotpoint.json is corrupted or unreadable, fall back to minimal metadata
                // (mtime still readable even when JSON.parse fails)
                stories.push({
                    storyId: entry.name,
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '',
                    lastUpdatedDate: readLastUpdatedDate(plotpointJsonPath),
                    status: 'generating',
                    processing
                });
            }
        } else {
            // Legacy story without plotpoint.json — include with empty metadata
            // (no plotpoint.json → no mtime → empty lastUpdatedDate)
            stories.push({
                storyId: entry.name,
                chapterRequested: 0,
                chapterCompleted: 0,
                createdDate: '',
                lastUpdatedDate: '',
                status: 'generating',
                processing
            });
        }
    }

    // Return stories sorted by createdDate descending (newest first)
    stories.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    // jobs: the full in-memory registry snapshot — every background thread
    // (create/fork/append/resume/expand/rewrite) currently running, with its
    // storyId, kind, and start time. In-memory only: a restart returns [].
    const jobs: StoryJob[] = getActiveStoryJobs();

    return {
        status: 200,
        response: { stories, jobs }
    };
});
