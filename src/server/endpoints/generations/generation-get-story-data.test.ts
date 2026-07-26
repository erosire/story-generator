/**
 * @vitest-environment node
 * This test imports from story-utils which transitively imports @runtime/secret/private
 * — that module creates an OpenAI client that throws in jsdom browser-like environments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generationGetStoryData } from './generation-get-story-data';
import { resolveStoryboardDir } from './story-utils';
import { DATABASE_BASE_DIR } from './generation-config';

// Use process.cwd() as the project root (service will pass this via variables)
const projectRoot = process.cwd();

// Helper to resolve the storyboard directory for a given storyId
const getStoryboardDir = (storyId: string) => path.join(projectRoot, DATABASE_BASE_DIR, storyId);

// Mock context object (not used by the handler but required by the type)
const mockContext = {} as any;

// Mock parameters factory
const createMockParameters = (storyId: string) => ({
    path: { storyId },
    query: {},
    body: {}
});

describe('generationGetStoryData', () => {
    // Track created test directories for cleanup
    const createdStoryIds: string[] = [];

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        // Clean up all test story directories
        for (const storyId of createdStoryIds) {
            const dir = getStoryboardDir(storyId);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
        createdStoryIds.length = 0;
        vi.restoreAllMocks();
    });

    it('should return 400 when storyId is missing', async () => {
        const parameters = { path: {}, query: {}, body: {} };

        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('storyId');
    });

    it('should return 404 for a non-existent story', async () => {
        const nonexistentStoryId = `nonexistent-${Date.now()}`;
        createdStoryIds.push(nonexistentStoryId);

        const parameters = createMockParameters(nonexistentStoryId);
        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(404);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain(nonexistentStoryId);
    });

    it('should return unified chapters and meta for an existing story', async () => {
        const storyId = `test-get-story-${Date.now()}`;
        createdStoryIds.push(storyId);
        const storyboardDir = getStoryboardDir(storyId);

        // Create the storyboard directory with fixture data
        fs.mkdirSync(storyboardDir, { recursive: true });

        // Write plotpoint.json with structured chapter data (single source of truth)
        const plotpointData = {
            storyId,
            storyline: 'A sci-fi adventure about discovering alien artifacts.',
            chapterCount: 2,
            chapters: [
                { number: '1', title: 'The Beginning', plotpoints: ['Opening scene', 'Introduction of protagonist'] },
                { number: '2', title: 'The Journey', plotpoints: ['Character development', 'Rising action'] }
            ],
            createdAt: '2026-07-01T10:00:00.000Z'
        };
        fs.writeFileSync(path.join(storyboardDir, 'plotpoint.json'), JSON.stringify(plotpointData, null, 2), 'utf-8');

        // Write chapter files into chapter/ subfolder
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        const chapter1 = '## The Beginning\n\nIt was a dark and stormy night...';
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.md'), chapter1, 'utf-8');

        const chapter2 = '## The Journey\n\nThe next morning, they set out...';
        fs.writeFileSync(path.join(chapterDir, 'chapter-002.md'), chapter2, 'utf-8');

        // Write chapter payload JSON files alongside the .md files
        const chapterPayload1 = {
            storyId,
            storyline: 'A sci-fi adventure about discovering alien artifacts.',
            chapterCount: 2,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'The Beginning',
            plotpoints: ['Opening scene', 'Introduction of protagonist'],
            context: { appending: [], request: '> Expand the chapter...' },
            config: { model: 'z-ai/glm-5.2', endpoint: 'https://integrate.api.nvidia.com/v1', systemInstructions: 'test', openingMessage: 'test' },
            revisions: [{ content: 'It was a dark and stormy night...', wordCount: 4500, generationTimeMs: 12345 }]
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.json'), JSON.stringify(chapterPayload1), 'utf-8');

        const chapterPayload2 = {
            storyId,
            storyline: 'A sci-fi adventure about discovering alien artifacts.',
            chapterCount: 2,
            chapterNumber: '2',
            chapterIndex: 1,
            title: 'The Journey',
            plotpoints: ['Character development', 'Rising action'],
            context: { appending: [], request: '> Expand the chapter...' },
            config: { model: 'z-ai/glm-5.2', endpoint: 'https://integrate.api.nvidia.com/v1', systemInstructions: 'test', openingMessage: 'test' },
            revisions: [{ content: 'The next morning, they set out...', wordCount: 3800, generationTimeMs: 23456 }]
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-002.json'), JSON.stringify(chapterPayload2), 'utf-8');

        // Call the handler directly
        const parameters = createMockParameters(storyId);
        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);

        // Should have chapters and meta properties (no more plotlines or payloads)
        expect(result.response).toHaveProperty('chapters');
        expect(result.response).toHaveProperty('meta');
        expect(result.response).not.toHaveProperty('plotlines');
        expect(result.response).not.toHaveProperty('payloads');

        // chapters should be a unified array
        expect(Array.isArray(result.response.chapters)).toBe(true);
        expect(result.response.chapters.length).toBe(2);

        // Each chapter should have the unified structure
        const ch1 = result.response.chapters[0];
        expect(ch1.chapterNumber).toBe('1');
        expect(ch1.chapterIndex).toBe(0);
        expect(ch1.title).toBe('The Beginning');
        expect(ch1.plotpoints).toEqual(['Opening scene', 'Introduction of protagonist']);
        expect(ch1.expanded).toBe(true);
        expect(ch1.canReExpand).toBe(true); // chapter-001.json exists
        expect(ch1.revisions).toEqual([
            { content: 'It was a dark and stormy night...', wordCount: 4500, generationTimeMs: 12345 }
        ]);

        const ch2 = result.response.chapters[1];
        expect(ch2.chapterNumber).toBe('2');
        expect(ch2.chapterIndex).toBe(1);
        expect(ch2.title).toBe('The Journey');
        expect(ch2.plotpoints).toEqual(['Character development', 'Rising action']);
        expect(ch2.expanded).toBe(true);
        expect(ch2.canReExpand).toBe(true); // chapter-002.json exists
        expect(ch2.revisions).toEqual([
            { content: 'The next morning, they set out...', wordCount: 3800, generationTimeMs: 23456 }
        ]);

        // meta should contain the story metadata from plotpoint.json
        expect(result.response.meta).not.toBeNull();
        expect(result.response.meta.storyline).toBe('A sci-fi adventure about discovering alien artifacts.');
        expect(result.response.meta.chapterCount).toBe(2);
        expect(result.response.meta.createdAt).toBe('2026-07-01T10:00:00.000Z');
    });

    it('should return chapters with expanded=false when chapter files do not exist yet', async () => {
        const storyId = `test-pending-chapters-${Date.now()}`;
        createdStoryIds.push(storyId);
        const storyboardDir = getStoryboardDir(storyId);

        fs.mkdirSync(storyboardDir, { recursive: true });

        // Write plotpoint.json with chapter outlines but NO chapter-XXX.md files
        const plotpointData = {
            storyId,
            storyline: 'A test story.',
            chapterCount: 2,
            chapters: [
                { number: '1', title: 'Chapter One', plotpoints: ['Point A', 'Point B'] },
                { number: '2', title: 'Chapter Two', plotpoints: ['Point C'] }
            ],
            createdAt: '2026-07-01T10:00:00.000Z'
        };
        fs.writeFileSync(path.join(storyboardDir, 'plotpoint.json'), JSON.stringify(plotpointData, null, 2), 'utf-8');

        // Do NOT create chapter/ directory or any .md/.json files

        const parameters = createMockParameters(storyId);
        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response.chapters.length).toBe(2);

        // Both chapters should have expanded=false
        for (const ch of result.response.chapters) {
            expect(ch.expanded).toBe(false);
            expect(ch.revisions).toBeUndefined();
        }

        // Plotpoints should still be present
        expect(result.response.chapters[0].plotpoints).toEqual(['Point A', 'Point B']);
        expect(result.response.chapters[1].plotpoints).toEqual(['Point C']);
    });

    it('should return empty chapters for an empty story directory', async () => {
        const emptyStoryId = `test-empty-story-${Date.now()}`;
        createdStoryIds.push(emptyStoryId);
        const emptyDir = getStoryboardDir(emptyStoryId);

        // Create empty directory (no files)
        fs.mkdirSync(emptyDir, { recursive: true });

        const parameters = createMockParameters(emptyStoryId);
        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);

        // chapters should be an empty array (no plotpoint.json)
        expect(Array.isArray(result.response.chapters)).toBe(true);
        expect(result.response.chapters.length).toBe(0);

        // meta should be null when no story.json exists
        expect(result.response.meta).toBeNull();
    });

    it('should return all story IDs when storyId is "list"', async () => {
        // Create a couple of test story directories
        const storyA = `test-list-a-${Date.now()}`;
        const storyB = `test-list-b-${Date.now()}`;
        createdStoryIds.push(storyA, storyB);

        const dirA = getStoryboardDir(storyA);
        const dirB = getStoryboardDir(storyB);
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });

        const parameters = createMockParameters('list');
        const result = await generationGetStoryData(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('stories');
        expect(Array.isArray(result.response.stories)).toBe(true);
        expect(result.response.stories).toContain(storyA);
        expect(result.response.stories).toContain(storyB);
    });
});
