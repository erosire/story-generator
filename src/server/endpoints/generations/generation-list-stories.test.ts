/**
 * @vitest-environment node
 * This test imports from story-utils which transitively imports @runtime/secret/private
 * — that module creates an OpenAI client that throws in jsdom browser-like environments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { generationListStories } from './generation-list-stories';
import { DATABASE_BASE_DIR } from './generation-config';

// Use an isolated temp directory as the project root so tests never pollute the
// source tree. The service normally passes temporary/database via variables.root.
const projectRoot = path.join(os.tmpdir(), `story-gen-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const getStoryboardDir = (storyId: string) => path.join(projectRoot, DATABASE_BASE_DIR, storyId);

// Mock context object (not used by the handler but required by the type)
const mockContext = {} as any;

// Mock parameters object
const createMockParameters = () => ({
    path: {},
    query: {},
    body: {}
});

// Helper to write a chapter-XXX.json payload with optional expanded content.
// chapterNumber is 1-based, padded to 3 digits (matches story-utils.ts convention).
const writeChapterPayload = (storyDir: string, chapterNumber: number, expanded: boolean) => {
    const chapterDir = path.join(storyDir, 'chapter');
    fs.mkdirSync(chapterDir, { recursive: true });
    const padded = String(chapterNumber).padStart(3, '0');
    const payload: Record<string, any> = {
        storyId: path.basename(storyDir),
        chapterIndex: chapterNumber - 1,
        chapterNumber: String(chapterNumber),
        title: `Chapter ${chapterNumber}`,
        revisions: expanded
            ? [{ content: `## Chapter ${chapterNumber}\n\nExpanded content here.`, wordCount: 100, generationTimeMs: 45000 }]
            : []
    };
    fs.writeFileSync(path.join(chapterDir, `chapter-${padded}.json`), JSON.stringify(payload, null, 2), 'utf-8');
};

// Helper to update chapterCompleted in a story's plotpoint.json.
// This simulates what writeChapterFiles() does in production.
const updatePlotpointChapterCompleted = (storyDir: string, chapterCompleted: number) => {
    const plotpointJsonPath = path.join(storyDir, 'plotpoint.json');
    const data = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
    data.chapterCompleted = chapterCompleted;
    fs.writeFileSync(plotpointJsonPath, JSON.stringify(data, null, 2), 'utf-8');
};

describe('generationListStories', { timeout: 30_000 }, () => {
    // Track created test directories for cleanup
    const createdStoryIds: string[] = [];

    afterAll(() => {
        // Clean up all test story directories
        for (const storyId of createdStoryIds) {
            const dir = getStoryboardDir(storyId);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
        // Remove the entire isolated temp root so no residual dirs leak
        if (fs.existsSync(projectRoot)) {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('should return stories with renamed metadata fields', async () => {
        // Create test story directories with plotpoint.json metadata
        const story1 = `test-list-meta-1-${Date.now()}`;
        const story2 = `test-list-meta-2-${Date.now()}`;

        createdStoryIds.push(story1, story2);

        // Create story 1 with full metadata in plotpoint.json
        const dir1 = getStoryboardDir(story1);
        fs.mkdirSync(dir1, { recursive: true });
        fs.writeFileSync(path.join(dir1, 'plotpoint.md'), '> Chapter 1\n\n- Plot A', 'utf-8');
        fs.writeFileSync(
            path.join(dir1, 'plotpoint.json'),
            JSON.stringify({
                storyId: story1,
                storyName: 'A Space Opera',
                storyline: 'A space opera about aliens.',
                chapterCount: 5,
                chapterCompleted: 0,
                chapters: [],
                createdAt: '2026-01-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        // Create story 2 with full metadata in plotpoint.json
        const dir2 = getStoryboardDir(story2);
        fs.mkdirSync(dir2, { recursive: true });
        fs.writeFileSync(
            path.join(dir2, 'plotpoint.json'),
            JSON.stringify({
                storyId: story2,
                storyline: 'A fantasy quest.',
                chapterCount: 3,
                chapterCompleted: 0,
                chapters: [],
                createdAt: '2026-02-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('stories');
        expect(Array.isArray(result.response.stories)).toBe(true);

        // Should contain both stories
        const storyIds = result.response.stories.map((s: any) => s.storyId);
        expect(storyIds).toContain(story1);
        expect(storyIds).toContain(story2);

        // Each story should have renamed fields: createdDate (not createdAt),
        // chapterRequested (not chapterCount), plus new chapterCompleted and status
        const found1 = result.response.stories.find((s: any) => s.storyId === story1);
        expect(found1.storyline).toBeUndefined();
        expect(found1.storyName).toBe('A Space Opera');
        // Renamed: chapterCount → chapterRequested
        expect(found1.chapterRequested).toBe(5);
        // Renamed: createdAt → createdDate
        expect(found1.createdDate).toBe('2026-01-01T00:00:00.000Z');
        // Old field names should NOT be present
        expect(found1.chapterCount).toBeUndefined();
        expect(found1.createdAt).toBeUndefined();
        // New fields
        expect(found1.chapterCompleted).toBe(0);
        expect(found1.status).toBe('generating');

        const found2 = result.response.stories.find((s: any) => s.storyId === story2);
        expect(found2.storyline).toBeUndefined();
        expect(found2.storyName).toBeUndefined();
        expect(found2.chapterRequested).toBe(3);
        expect(found2.createdDate).toBe('2026-02-01T00:00:00.000Z');
        expect(found2.chapterCompleted).toBe(0);
        expect(found2.status).toBe('generating');

        console.log('Listed stories with metadata:', result.response.stories);
    });

    it('should return empty metadata for stories without plotpoint.json', async () => {
        // Create a legacy story directory without plotpoint.json
        const storyId = `test-list-legacy-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'plotpoint.md'), '> Legacy chapter\n\n- Legacy plotpoint', 'utf-8');

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.storyline).toBeUndefined();
        expect(found.chapterRequested).toBe(0);
        expect(found.chapterCompleted).toBe(0);
        expect(found.createdDate).toBe('');
        expect(found.status).toBe('generating');

        console.log('Legacy story entry:', found);
    });

    it('should return an empty list when no stories exist', async () => {
        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('stories');
        expect(Array.isArray(result.response.stories)).toBe(true);

        console.log('Stories list length:', result.response.stories.length);
    });

    it('should only return directory names as storyId, not file names', async () => {
        // Create a test story with actual files
        const storyId = `test-list-files-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        const chapterDir = path.join(dir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        // Create files in the story directory
        fs.writeFileSync(path.join(dir, 'plotpoint.md'), '> Test chapter\n\n- Test plotpoint', 'utf-8');
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.md'), '## Chapter 1\n\nContent', 'utf-8');

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('stories');

        // Should contain the story directory name as storyId
        const storyIds = result.response.stories.map((s: any) => s.storyId);
        expect(storyIds).toContain(storyId);

        // Should NOT contain file names or subdirectory names as storyId
        expect(storyIds).not.toContain('plotpoint.md');
        expect(storyIds).not.toContain('chapter');
        expect(storyIds).not.toContain('chapter-001.md');

        console.log('Stories (directories only):', result.response.stories);
    });

    it('should sort stories by createdDate descending (newest first)', async () => {
        const storyOld = `test-sort-old-${Date.now()}`;
        const storyNew = `test-sort-new-${Date.now()}`;
        createdStoryIds.push(storyOld, storyNew);

        const dirOld = getStoryboardDir(storyOld);
        fs.mkdirSync(dirOld, { recursive: true });
        fs.writeFileSync(
            path.join(dirOld, 'plotpoint.json'),
            JSON.stringify({
                storyId: storyOld,
                storyline: 'Old story',
                chapterCount: 1,
                chapterCompleted: 0,
                chapters: [],
                createdAt: '2020-01-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const dirNew = getStoryboardDir(storyNew);
        fs.mkdirSync(dirNew, { recursive: true });
        fs.writeFileSync(
            path.join(dirNew, 'plotpoint.json'),
            JSON.stringify({
                storyId: storyNew,
                storyline: 'New story',
                chapterCount: 2,
                chapterCompleted: 0,
                chapters: [],
                createdAt: '2026-07-03T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const storyIds = result.response.stories.map((s: any) => s.storyId);
        const oldIdx = storyIds.indexOf(storyOld);
        const newIdx = storyIds.indexOf(storyNew);

        // New story should appear before old story
        expect(newIdx).toBeLessThan(oldIdx);

        console.log('Sort order:', storyIds);
    });

    it('should handle the storyboard directory not existing', async () => {
        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('stories');
        expect(Array.isArray(result.response.stories)).toBe(true);

        console.log('Handler handles missing directory gracefully');
    });

    // ── chapterCompleted / status tests ────────────────────────────────

    it('should read chapterCompleted from plotpoint.json', async () => {
        const storyId = `test-list-completed-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        // 3 chapters requested, 2 completed (denormalized in plotpoint.json)
        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyName: 'Partial Story',
                storyline: 'A story with partial chapters.',
                chapterCount: 3,
                chapterCompleted: 2,
                chapters: [
                    { number: '1', title: 'Ch 1', plotpoints: ['a'] },
                    { number: '2', title: 'Ch 2', plotpoints: ['b'] },
                    { number: '3', title: 'Ch 3', plotpoints: ['c'] }
                ],
                createdAt: '2026-03-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.chapterRequested).toBe(3);
        expect(found.chapterCompleted).toBe(2);
        expect(found.status).toBe('generating');

        console.log('Partial completion:', { chapterRequested: found.chapterRequested, chapterCompleted: found.chapterCompleted, status: found.status });
    });

    it('should report status "completed" when all chapters are expanded', async () => {
        const storyId = `test-list-all-done-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyName: 'Done Story',
                storyline: 'A fully generated story.',
                chapterCount: 2,
                chapterCompleted: 2,
                chapters: [
                    { number: '1', title: 'Ch 1', plotpoints: ['a'] },
                    { number: '2', title: 'Ch 2', plotpoints: ['b'] }
                ],
                createdAt: '2026-04-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.chapterRequested).toBe(2);
        expect(found.chapterCompleted).toBe(2);
        expect(found.status).toBe('completed');

        console.log('All done:', { chapterRequested: found.chapterRequested, chapterCompleted: found.chapterCompleted, status: found.status });
    });

    it('should report status "failed" when plotpoint.json status is "failed"', async () => {
        const storyId = `test-list-failed-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyName: 'Failed Story',
                storyline: 'A story that failed.',
                chapterCount: 5,
                chapterCompleted: 0,
                chapters: [],
                status: 'failed',
                validation: { valid: false, reason: 'refusal detected' },
                createdAt: '2026-05-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.chapterRequested).toBe(5);
        expect(found.chapterCompleted).toBe(0);
        expect(found.status).toBe('failed');

        console.log('Failed story:', { status: found.status });
    });

    it('should report status "completed" for plotline-only stories even with zero expanded chapters', async () => {
        const storyId = `test-list-plotonly-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        // The dashboard Generate button triggers plotline-only generation (the
        // plotOnly branch in generation-create-new-story.ts): once the plotline
        // is written, the terminal state is status 'completed' with
        // chapterCompleted still 0 (chapters are expanded individually later
        // via PATCH). deriveStatus must honor that explicit terminal status —
        // otherwise the sidebar reports such stories as 'generating' forever.
        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyName: 'Plotline-Only Story',
                storyline: 'A story generated as plotlines only.',
                chapterCount: 3,
                chapterCompleted: 0,
                chapters: [
                    { number: '1', title: 'Ch 1', plotpoints: ['a'] },
                    { number: '2', title: 'Ch 2', plotpoints: ['b'] },
                    { number: '3', title: 'Ch 3', plotpoints: ['c'] }
                ],
                validation: { valid: true, reason: 'plotline complete', attempt: 0 },
                status: 'completed',
                createdAt: '2026-08-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.storyName).toBe('Plotline-Only Story');
        expect(found.chapterRequested).toBe(3);
        expect(found.chapterCompleted).toBe(0);
        expect(found.status).toBe('completed');

        console.log('Plotline-only story:', { chapterRequested: found.chapterRequested, chapterCompleted: found.chapterCompleted, status: found.status });
    });

    it('should report status "generating" when chapters are partially expanded and not failed', async () => {
        const storyId = `test-list-gen-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyName: 'Generating Story',
                storyline: 'A story being generated.',
                chapterCount: 4,
                chapterCompleted: 1,
                chapters: [
                    { number: '1', title: 'Ch 1', plotpoints: ['a'] },
                    { number: '2', title: 'Ch 2', plotpoints: ['b'] },
                    { number: '3', title: 'Ch 3', plotpoints: ['c'] },
                    { number: '4', title: 'Ch 4', plotpoints: ['d'] }
                ],
                status: 'generating',
                createdAt: '2026-06-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.chapterRequested).toBe(4);
        expect(found.chapterCompleted).toBe(1);
        expect(found.status).toBe('generating');

        console.log('Generating story:', { chapterRequested: found.chapterRequested, chapterCompleted: found.chapterCompleted, status: found.status });
    });

    it('should default chapterCompleted to 0 for plotpoint.json without the field', async () => {
        // Legacy plotpoint.json that doesn't have chapterCompleted (backward compat)
        const storyId = `test-list-nofield-${Date.now()}`;
        createdStoryIds.push(storyId);

        const dir = getStoryboardDir(storyId);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'Legacy story without chapterCompleted field.',
                chapterCount: 3,
                chapters: [],
                createdAt: '2026-07-01T00:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters();
        const result = await generationListStories(mockContext, parameters, { root: projectRoot });

        const found = result.response.stories.find((s: any) => s.storyId === storyId);
        expect(found).toBeDefined();
        expect(found.chapterRequested).toBe(3);
        expect(found.chapterCompleted).toBe(0);
        expect(found.status).toBe('generating');

        console.log('Legacy plotpoint.json without chapterCompleted:', found);
    });
});
