/**
 * @vitest-environment node
 * This test needs the Node environment because the handler imports @runtime/secret/private
 * which transitively imports OpenAI SDK — that SDK throws in jsdom browser-like environments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the config module — single source of truth for all generation settings.
vi.mock('./generation-config', () => {
    const createMockClient = (): any => {
        const client: any = {
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockImplementation(() => createMockClient()),
            format: vi.fn().mockResolvedValue({
                response: {
                    title: 'Re-Expanded Chapter',
                    content: 'This is the re-expanded content of the chapter. ' + 'word '.repeat(3500)
                }
            }),
            structure: vi.fn().mockResolvedValue({ response: { chapters: [], title: '', content: '' } }),
            messages: []
        };
        return client;
    };

    // Shared instance so CLIENT / CLIENTS / resolveClient all resolve to the
    // same mock — story-utils createStoryClient() now drives client selection
    // through resolveClient(clientId), while the handler validates the payload
    // via parseClientId (contract mirrored below).
    const mockClient = createMockClient();

    // Test-only selectable client set: only 'Qwen3_8' exists, so any other
    // id in a PATCH body must be rejected with the production error shape.
    const clients: Record<string, any> = { Qwen3_8: mockClient };

    return {
        useApiMethod: 'format',
        MODEL: 'z-ai/glm-5.2',
        ENDPOINT: 'https://integrate.api.nvidia.com/v1',
        API_KEY: 'test-api-key',
        OPENING_USER_MESSAGE: 'Hey ENI',
        STORY_REQUEST_MESSAGE: 'You know the story I like',
        MAX_PLOT_ATTEMPTS: 3,
        EXPAND_TIMEOUT_MS: 10 * 60 * 1000,
        MIN_WORDS_PER_CHAPTER: 3000,
        TARGET_WORD_COUNT_PROMPT: '15,000 words',
        MIN_PLOTPOINTS_PER_CHAPTER: 10,
        REFUSAL_PATTERNS: ['I cannot fulfill', 'I will not'],
        DATABASE_BASE_DIR: 'storyboard',
        CLIENT: mockClient,
        CLIENTS: clients,
        // Faithful re-implementation of the production parseClientId contract
        // (generation-config.ts) against the test-only CLIENTS set, exercised
        // end-to-end by the handler even though the real config module (with
        // its private provider clients) is mocked out.
        parseClientId: (raw: unknown): { clientId?: string; error?: string } => {
            if (raw === undefined || raw === null) return {};
            if (typeof raw !== 'string' || raw.length === 0) {
                return { error: 'clientId must be a non-empty string' };
            }
            if (!Object.prototype.hasOwnProperty.call(clients, raw)) {
                return {
                    error: `Unknown clientId '${raw}'. Available clients: ${Object.keys(clients).join(', ')}`
                };
            }
            return { clientId: raw };
        },
        resolveClient: (_clientId?: string | null) => mockClient
    };
});

// Mock the prompts
vi.mock('@runtime/data/prompts', () => ({
    KIMIK2_INSTRUCTIONS: 'test instructions',
    KIMIK2_OPENING: 'test opening'
}));

// Import handler AFTER mocks are set up
import { CLIENT, EXPAND_TIMEOUT_MS } from './generation-config';
import { generationUpdateChapter } from './generation-update-chapter';
import { DATABASE_BASE_DIR } from './generation-config';

// Use an isolated temp directory as the project root so tests never pollute the
// source tree. The service normally passes temporary/database via variables.root.
const projectRoot = path.join(os.tmpdir(), `story-gen-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Helper to resolve the storyboard directory for a given storyId
const getStoryboardDir = (storyId: string) => path.join(projectRoot, DATABASE_BASE_DIR, storyId);

// Mock context object (not used by the handler but required by the type)
const mockContext = {} as any;

// Mock parameters factory
const createMockParameters = (storyId: string, body: Record<string, any> = {}) => ({
    path: { storyId },
    query: {},
    body
});

describe('generationUpdateChapter', () => {
    // Track created test directories for cleanup
    const createdStoryIds: string[] = [];

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
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
        // Remove the entire isolated temp root so no residual dirs leak
        if (fs.existsSync(projectRoot)) {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
        vi.restoreAllMocks();
    });

    it('should return 400 when storyId is missing', async () => {
        const parameters = {
            path: {},
            query: {},
            body: { expandChapterIndex: 0 }
        };

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('storyId');
    });

    it('should return 400 when neither storyName nor expandChapterIndex is provided', async () => {
        const storyId = `test-update-no-fields-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({ storyId, storyline: 'Test.', chapterCount: 1, chapters: [], createdAt: new Date().toISOString() }),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, {});

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('No valid update fields');
    });

    it('should return 400 when expandChapterIndex is negative', async () => {
        const storyId = `test-update-neg-index-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({ storyId, storyline: 'Test.', chapterCount: 1, chapters: [], createdAt: new Date().toISOString() }),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, { expandChapterIndex: -1 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('expandChapterIndex must be a non-negative integer');
    });

    it('should return 404 when story does not exist', async () => {
        const storyId = `test-update-no-story-${Date.now()}`;
        createdStoryIds.push(storyId);

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(404);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain(storyId);
    });

    it('should return 404 when story has no plotpoint.json', async () => {
        const storyId = `test-update-no-meta-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(404);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('plotpoint.json');
    });

    it('should return 404 when chapter does not exist', async () => {
        const storyId = `test-update-no-chapter-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });

        // Write plotpoint.json but no chapter files
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A test story.',
                chapterCount: 2,
                chapters: [
                    { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
                    { number: '2', title: 'Chapter Two', plotpoints: ['Plot B'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(404);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('Chapter 0');
    });

    it('should return 500 when chapter payload is missing context', async () => {
        const storyId = `test-update-no-context-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        // Write plotpoint.json
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A test story.',
                chapterCount: 1,
                chapters: [
                    { number: '1', title: 'Chapter One', plotpoints: ['Plot point A'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        // Write chapter-001.json WITHOUT context
        fs.writeFileSync(
            path.join(chapterDir, 'chapter-001.json'),
            JSON.stringify({
                storyId,
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'Chapter One',
                plotpoints: ['Plot point A']
                // Missing context!
            }),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(500);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('context.appending');
    });

    it('should accept a valid request and return 200 with chapter info', async () => {
        const storyId = `test-update-valid-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        // Write plotpoint.json
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A sci-fi adventure.',
                chapterCount: 2,
                chapters: [
                    { number: '1', title: 'The Beginning', plotpoints: ['Opening scene', 'Character introduction'] },
                    { number: '2', title: 'The Middle', plotpoints: ['Conflict', 'Rising action'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        // Write chapter-001.json with full context
        const chapterPayload = {
            storyId,
            storyline: 'A sci-fi adventure.',
            chapterCount: 2,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'The Beginning',
            plotpoints: ['Opening scene', 'Character introduction'],
            context: {
                appending: ['> 1: The Beginning\n\n- Opening scene\n- Character introduction'],
                request: '> Expand the chapter "1: The Beginning"'
            },
            config: {
                model: 'z-ai/glm-5.2',
                endpoint: 'https://integrate.api.nvidia.com/v1',
                systemInstructions: 'test',
                openingMessage: 'test'
            },
            result: { title: 'The Beginning', content: 'Original content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.json'), JSON.stringify(chapterPayload), 'utf-8');

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        // Should return 200 immediately (background re-expansion)
        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('storyId');
        expect(result.response.storyId).toBe(storyId);
        expect(result.response).toHaveProperty('expandChapterIndex');
        expect(result.response.expandChapterIndex).toBe(0);
        expect(result.response).toHaveProperty('chapterNumber');
        expect(result.response.chapterNumber).toBe('1');
        expect(result.response).toHaveProperty('title');
        expect(result.response.title).toBe('The Beginning');
        expect(result.response).toHaveProperty('message');
        expect(result.response.message).toContain('re-expansion started');

        // Wait for the background re-expansion to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify chapter files were updated
        const mdContent = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(mdContent).toContain('Re-Expanded Chapter');

        // Verify the chapter JSON payload was updated
        const updatedPayload = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8')
        );
        expect(updatedPayload.title).toBe('Re-Expanded Chapter');
        // Content now lives exclusively in revisions[]
        expect(Array.isArray(updatedPayload.revisions)).toBe(true);
        expect(updatedPayload.revisions.length).toBeGreaterThan(0);
        const latestRevision = updatedPayload.revisions[updatedPayload.revisions.length - 1];
        expect(latestRevision.content).toContain('re-expanded content');
        expect(latestRevision.generationTimeMs).toBeGreaterThan(0);
    });

    it('should work with expandChapterIndex 0 for a story with multiple chapters', async () => {
        const storyId = `test-update-multi-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        // Write plotpoint.json
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A fantasy quest.',
                chapterCount: 3,
                chapters: [
                    { number: '1', title: 'The Quest Begins', plotpoints: ['Hero receives quest', 'Sets off on journey'] },
                    { number: '2', title: 'The Journey', plotpoints: ['Character development', 'Rising action'] },
                    { number: '3', title: 'The Climax', plotpoints: ['Final battle', 'Resolution'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        // Write chapter-001.json (the one we'll re-expand)
        const chapter1Payload = {
            storyId,
            storyline: 'A fantasy quest.',
            chapterCount: 3,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'The Quest Begins',
            plotpoints: ['Hero receives quest', 'Sets off on journey'],
            context: {
                appending: [
                    '> 1: The Quest Begins\n\n- Hero receives quest\n- Sets off on journey',
                    '> 2: The Journey\n\n- Character development\n- Rising action',
                    '> 3: The Climax\n\n- Final battle\n- Resolution'
                ],
                request: '> Expand the chapter "1: The Quest Begins"'
            },
            config: {
                model: 'z-ai/glm-5.2',
                endpoint: 'https://integrate.api.nvidia.com/v1',
                systemInstructions: 'test',
                openingMessage: 'test'
            },
            result: { title: 'The Quest Begins', content: 'Original chapter 1 content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.json'), JSON.stringify(chapter1Payload), 'utf-8');

        // Write chapter-002.json with chapter 1's expanded content in its context
        const chapter2Payload = {
            storyId,
            storyline: 'A fantasy quest.',
            chapterCount: 3,
            chapterNumber: '2',
            chapterIndex: 1,
            title: 'The Journey',
            plotpoints: ['Character development', 'Rising action'],
            context: {
                appending: [
                    '## The Quest Begins\n\nOriginal chapter 1 content...',
                    '> 2: The Journey\n\n- Character development\n- Rising action',
                    '> 3: The Climax\n\n- Final battle\n- Resolution'
                ],
                request: '> Expand the chapter "2: The Journey"'
            },
            config: {
                model: 'z-ai/glm-5.2',
                endpoint: 'https://integrate.api.nvidia.com/v1',
                systemInstructions: 'test',
                openingMessage: 'test'
            },
            result: { title: 'The Journey', content: 'Chapter 2 content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-002.json'), JSON.stringify(chapter2Payload), 'utf-8');

        // Write chapter-003.json (last chapter — should NOT be updated since chapter 1
        // only propagates to the next chapter, not two chapters ahead)
        const chapter3Payload = {
            storyId,
            storyline: 'A fantasy quest.',
            chapterCount: 3,
            chapterNumber: '3',
            chapterIndex: 2,
            title: 'The Climax',
            plotpoints: ['Final battle', 'Resolution'],
            context: {
                appending: [
                    '> 1: The Quest Begins\n\n- Hero receives quest',
                    '## The Journey\n\nChapter 2 content...',
                    '> 3: The Climax\n\n- Final battle\n- Resolution'
                ],
                request: '> Expand the chapter "3: The Climax"'
            },
            config: {
                model: 'z-ai/glm-5.2',
                endpoint: 'https://integrate.api.nvidia.com/v1',
                systemInstructions: 'test',
                openingMessage: 'test'
            },
            result: { title: 'The Climax', content: 'Chapter 3 content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-003.json'), JSON.stringify(chapter3Payload), 'utf-8');

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response.expandChapterIndex).toBe(0);
        expect(result.response.chapterNumber).toBe('1');
        expect(result.response.title).toBe('The Quest Begins');

        // Wait for background re-expansion
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify chapter-001 was updated
        const updatedPayload = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8')
        );
        expect(updatedPayload.title).toBe('Re-Expanded Chapter');
        expect(updatedPayload.revisions.length).toBeGreaterThan(0);

        // Verify chapter-002's context.appending was updated with the new chapter 1 content
        const chapter2Updated = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-002.json'), 'utf-8')
        );
        // The first element (index 0 = chapter 1) should now contain the re-expanded content
        expect(chapter2Updated.context.appending[0]).toContain('Re-Expanded Chapter');
        expect(chapter2Updated.context.appending[0]).toContain('re-expanded content');
        // The rest of the appending should remain unchanged
        expect(chapter2Updated.context.appending[1]).toContain('Character development');

        // Verify chapter-003's context.appending was NOT updated (only next chapter gets it)
        const chapter3Updated = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-003.json'), 'utf-8')
        );
        expect(chapter3Updated.context.appending[0]).toBe('> 1: The Quest Begins\n\n- Hero receives quest');
    });

    it('should return 400 when expandChapterIndex is not a number', async () => {
        const storyId = `test-update-string-index-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });

        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A test story.',
                chapterCount: 1,
                chapters: [
                    { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, { expandChapterIndex: 'not-a-number' });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('No valid update fields');
    });

    it('should update storyName in plotpoint.json when storyName is provided', async () => {
        const storyId = `test-update-storyname-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        fs.mkdirSync(storyboardDir, { recursive: true });

        const plotpointData = {
            storyId,
            storyName: 'Original Name',
            storyline: 'A test story.',
            chapterCount: 1,
            chapters: [{ number: '1', title: 'Chapter One', plotpoints: ['Plot A'] }],
            createdAt: '2026-07-01T10:00:00.000Z'
        };
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify(plotpointData),
            'utf-8'
        );

        const parameters = createMockParameters(storyId, { storyName: 'Updated Story Name' });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('storyId');
        expect(result.response.storyId).toBe(storyId);
        expect(result.response).toHaveProperty('storyName');
        expect(result.response.storyName).toBe('Updated Story Name');
        expect(result.response).toHaveProperty('message');
        expect(result.response.message).toContain('metadata updated');

        // Verify plotpoint.json was updated on disk
        const updated = JSON.parse(fs.readFileSync(path.join(storyboardDir, 'plotpoint.json'), 'utf-8'));
        expect(updated.storyName).toBe('Updated Story Name');
    });

    it('should update storyName AND start chapter re-expansion when both are provided', async () => {
        const storyId = `test-update-both-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        const plotpointData = {
            storyId,
            storyName: 'Original',
            storyline: 'A test story.',
            chapterCount: 2,
            chapters: [{ number: '1', title: 'Chapter One', plotpoints: ['Plot A'] }],
            createdAt: '2026-07-01T10:00:00.000Z'
        };
        fs.writeFileSync(path.join(storyboardDir, 'plotpoint.json'), JSON.stringify(plotpointData), 'utf-8');

        const chapterPayload = {
            storyId,
            storyline: 'A test story.',
            chapterCount: 2,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Chapter One',
            plotpoints: ['Plot A'],
            context: {
                appending: ['> 1: Chapter One\n\n- Plot A'],
                request: '> Expand the chapter "1: Chapter One"'
            },
            config: { model: 'test', endpoint: 'test', systemInstructions: 'test', openingMessage: 'test' },
            result: { title: 'Chapter One', content: 'Original content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.json'), JSON.stringify(chapterPayload), 'utf-8');

        const parameters = createMockParameters(storyId, { storyName: 'Renamed Story', expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response.storyId).toBe(storyId);
        expect(result.response.storyName).toBe('Renamed Story');
        expect(result.response.expandChapterIndex).toBe(0);
        expect(result.response.message).toContain('re-expansion started');

        // Verify plotpoint.json was updated
        const updated = JSON.parse(fs.readFileSync(path.join(storyboardDir, 'plotpoint.json'), 'utf-8'));
        expect(updated.storyName).toBe('Renamed Story');
    });

    it('should chain-expand pending chapters after re-expanding the requested one', async () => {
        const storyId = `test-update-missing-next-${Date.now()}`;
        createdStoryIds.push(storyId);

        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        // Write plotpoint.json with 3 chapters
        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A sci-fi adventure.',
                chapterCount: 3,
                chapters: [
                    { number: '1', title: 'The Beginning', plotpoints: ['Opening scene', 'Character intro'] },
                    { number: '2', title: 'The Middle', plotpoints: ['Conflict rises', 'Allies gather'] },
                    { number: '3', title: 'The End', plotpoints: ['Final battle', 'Resolution'] }
                ],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );

        // Write ONLY chapter-001.json (chapter 2 and 3 are "missing" — simulates interrupted generation)
        const chapter1Payload = {
            storyId,
            storyline: 'A sci-fi adventure.',
            chapterCount: 3,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'The Beginning',
            plotpoints: ['Opening scene', 'Character intro'],
            context: {
                appending: [
                    '> 1: The Beginning\n\n- Opening scene\n- Character intro',
                    '> 2: The Middle\n\n- Conflict rises\n- Allies gather',
                    '> 3: The End\n\n- Final battle\n- Resolution'
                ],
                request: '> Expand the chapter "1: The Beginning"'
            },
            config: {
                model: 'z-ai/glm-5.2',
                endpoint: 'https://integrate.api.nvidia.com/v1',
                systemInstructions: 'test',
                openingMessage: 'test'
            },
            result: { title: 'The Beginning', content: 'Original content...' }
        };
        fs.writeFileSync(path.join(chapterDir, 'chapter-001.json'), JSON.stringify(chapter1Payload), 'utf-8');

        // chapter-002.json does NOT exist — simulates interrupted generation
        expect(fs.existsSync(path.join(chapterDir, 'chapter-002.json'))).toBe(false);

        const parameters = createMockParameters(storyId, { expandChapterIndex: 0 });

        const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Wait for background re-expansion (chain expansion of chapter 1 + chapter 2)
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // chapter-001 should be updated with re-expanded content
        const updatedPayload = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8')
        );
        expect(updatedPayload.title).toBe('Re-Expanded Chapter');
        expect(updatedPayload.revisions.length).toBeGreaterThan(0);

        // chapter-002.json should now exist and be expanded (chain-expanded because
        // it was pending after the skeleton was created during propagation)
        expect(fs.existsSync(path.join(chapterDir, 'chapter-002.json'))).toBe(true);

        const chapter2Payload = JSON.parse(
            fs.readFileSync(path.join(chapterDir, 'chapter-002.json'), 'utf-8')
        );
        expect(chapter2Payload.chapterNumber).toBe('2');
        expect(chapter2Payload.chapterIndex).toBe(1);
        expect(chapter2Payload.context).toBeDefined();
        expect(Array.isArray(chapter2Payload.context.appending)).toBe(true);
        // Position 0 should have the re-expanded chapter 1 content
        expect(chapter2Payload.context.appending[0]).toContain('Re-Expanded Chapter');
        expect(chapter2Payload.context.appending[0]).toContain('re-expanded content');
        // Chapter 2 should now be expanded (revisions has content)
        expect(Array.isArray(chapter2Payload.revisions)).toBe(true);
        expect(chapter2Payload.revisions.length).toBeGreaterThan(0);
        const ch2LatestRev = chapter2Payload.revisions[chapter2Payload.revisions.length - 1];
        expect(ch2LatestRev.content).not.toBe('');
        expect(chapter2Payload.title).toBe('Re-Expanded Chapter');
    });

    // ── Expansion error-retry regressions (moved here from the POST tests) ──
    // Since the plotline-only API change, POST /generations/:storyId (the Generate
    // button) never triggers chapter expansion — it stops after the plotline.
    // Chapter expansion is only reachable through this PATCH endpoint (or forks),
    // so expandChapter's error-retry behaviour is regression-tested here.

    // Seeds a single-chapter story whose chapter-001.json carries the LLM
    // context required by reExpandChapter (plotpoint.json + chapter payload).
    const seedExpandableStory = (storyId: string) => {
        createdStoryIds.push(storyId);
        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });

        fs.writeFileSync(
            path.join(storyboardDir, 'plotpoint.json'),
            JSON.stringify({
                storyId,
                storyline: 'A sci-fi adventure.',
                chapterCount: 1,
                chapterCompleted: 0,
                chapters: [{ number: '1', title: 'The Beginning', plotpoints: ['Opening scene'] }],
                createdAt: '2026-07-01T10:00:00.000Z'
            }),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(chapterDir, 'chapter-001.json'),
            JSON.stringify({
                storyId,
                storyline: 'A sci-fi adventure.',
                chapterCount: 1,
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'The Beginning',
                plotpoints: ['Opening scene'],
                context: {
                    appending: ['> 1: The Beginning\n\n- Opening scene'],
                    request: '> Expand the chapter "1: The Beginning"'
                },
                config: { systemInstructions: 'test', openingMessage: 'test' },
                revisions: []
            }),
            'utf-8'
        );
    };

    it('should retry chapter re-expansion after a startup timeout stall and log the timeout error', async () => {
        vi.useFakeTimers();

        const storyId = `test-update-timeout-${Date.now()}`;
        seedExpandableStory(storyId);
        const chapterDir = path.join(getStoryboardDir(storyId), 'chapter');

        let expandCalls = 0;
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => {
                expandCalls++;
                if (expandCalls === 1) {
                    // First expansion attempt — hangs forever with zero
                    // streaming writes, so the two-phase stall detector's
                    // phase 1 (startup timeout) fires after EXPAND_TIMEOUT_MS.
                    return new Promise(() => {});
                }
                // Retry expansion — succeed immediately (word count above
                // MIN_WORDS_PER_CHAPTER so the do-while terminates).
                return Promise.resolve({
                    response: {
                        title: 'Expanded Chapter',
                        content: 'This is expanded content after timeout retry. ' + 'word '.repeat(3500)
                    }
                });
            })
        } as any);

        const result = await generationUpdateChapter(
            mockContext,
            createMockParameters(storyId, { expandChapterIndex: 0 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        // Let microtasks settle so the background re-expansion reaches its
        // Promise.race and registers the (fake-timer) stall interval.
        await vi.advanceTimersByTimeAsync(0);

        // Advance past the startup timeout to trigger phase-1 termination.
        await vi.advanceTimersByTimeAsync(EXPAND_TIMEOUT_MS + 1);

        // Let the retry complete (microtasks for format call + file writes).
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Restore real timers for cleanup
        vi.useRealTimers();

        // Wait for all background operations to fully complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify timeout error was logged
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[TIMEOUT]'));
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('timed out'));
        // Exactly one attempt + one retry — no further loops.
        expect(expandCalls).toBe(2);

        // Verify the chapter file was eventually written by the successful retry
        const content = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(content).toContain('Expanded Chapter');
        expect(content).toContain('This is expanded content after timeout retry');
    }, 30000);

    it('should log error details when re-expansion fails with a non-timeout error and recover on retry', async () => {
        const storyId = `test-update-error-${Date.now()}`;
        seedExpandableStory(storyId);
        const chapterDir = path.join(getStoryboardDir(storyId), 'chapter');

        let expandCalls = 0;
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => {
                expandCalls++;
                if (expandCalls === 1) {
                    // First expansion — throw a non-timeout error
                    return Promise.reject(new Error('Network connection reset'));
                }
                // Retry — succeed immediately
                return Promise.resolve({
                    response: {
                        title: 'Expanded Chapter',
                        content: 'Recovered after error. ' + 'word '.repeat(3500)
                    }
                });
            })
        } as any);

        const result = await generationUpdateChapter(
            mockContext,
            createMockParameters(storyId, { expandChapterIndex: 0 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        // Wait for background re-expansion to complete (fail → retry → write)
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Verify error was logged with [ERROR] tag (not [TIMEOUT])
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Network connection reset'));

        // Verify the [TIMEOUT] tag was NOT logged (it was a non-timeout error)
        const errorCalls = (console.error as any).mock.calls.map((call: any[]) => call.join(' '));
        const hasTimeoutLog = errorCalls.some((msg: string) => msg.includes('[TIMEOUT]'));
        expect(hasTimeoutLog).toBe(false);

        // Verify the chapter was written successfully after retry
        const content = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(content).toContain('Recovered after error');
    }, 30000);

    // ── Per-request clientId selection ──────────────────────────────────
    // The clientId travels with each PATCH payload (expand/rewrite) and is
    // never persisted (no plotpoint.json field) — see generation-config.ts
    // parseClientId/resolveClient, which the mocked config above mirrors.
    describe('clientId selection', () => {
        const seedStory = (storyId: string, withChapterPayload: boolean) => {
            createdStoryIds.push(storyId);
            const storyboardDir = getStoryboardDir(storyId);
            const chapterDir = path.join(storyboardDir, 'chapter');
            fs.mkdirSync(chapterDir, { recursive: true });

            fs.writeFileSync(
                path.join(storyboardDir, 'plotpoint.json'),
                JSON.stringify({
                    storyId,
                    storyline: 'A sci-fi adventure.',
                    chapterCount: 1,
                    chapters: [{ number: '1', title: 'The Beginning', plotpoints: ['Opening scene'] }],
                    createdAt: '2026-07-01T10:00:00.000Z'
                }),
                'utf-8'
            );

            if (withChapterPayload) {
                // Minimal chapter payload carrying the context append/rewrite paths require.
                fs.writeFileSync(
                    path.join(chapterDir, 'chapter-001.json'),
                    JSON.stringify({
                        storyId,
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'The Beginning',
                        plotpoints: ['Opening scene'],
                        context: {
                            appending: ['> 1: The Beginning\n\n- Opening scene'],
                            request: '> Expand the chapter "1: The Beginning"'
                        },
                        config: { systemInstructions: 'test', openingMessage: 'test' }
                    }),
                    'utf-8'
                );
            }
        };

        it('should return 400 when clientId is not a string (validation precedes story checks)', async () => {
            // No story fixture needed: parseClientId runs right after the
            // storyId check, before story-existence validation.
            const parameters = createMockParameters('test-client-nonstring', {
                storyName: 'Anything',
                clientId: 42
            });

            const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

            expect(result.status).toBe(400);
            expect(result.response).toHaveProperty('error');
            expect(result.response.error).toBe('clientId must be a non-empty string');
        });

        it('should return 400 when clientId is unknown, listing the available clients', async () => {
            const storyId = `test-client-unknown-${Date.now()}`;
            seedStory(storyId, false);

            const parameters = createMockParameters(storyId, { expandChapterIndex: 0, clientId: 'unknown-client' });

            const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

            expect(result.status).toBe(400);
            expect(result.response).toHaveProperty('error');
            expect(result.response.error).toContain('Unknown clientId');
            expect(result.response.error).toContain('unknown-client');
            // Error lists selectable ids so the UI can self-correct.
            expect(result.response.error).toContain('Qwen3_8');
        });

        it('should accept a valid clientId for chapter re-expansion and never persist it', async () => {
            const storyId = `test-client-expand-${Date.now()}`;
            seedStory(storyId, true);

            const parameters = createMockParameters(storyId, {
                expandChapterIndex: 0,
                clientId: 'Qwen3_8'
            });

            const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

            expect(result.status).toBe(200);
            expect(result.response.storyId).toBe(storyId);
            expect(result.response.message).toContain('re-expansion started');

            // Let the mock re-expansion settle, then assert the persistence
            // contract: plotpoint.json gains no clientId property.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const updated = JSON.parse(
                fs.readFileSync(path.join(getStoryboardDir(storyId), 'plotpoint.json'), 'utf-8')
            );
            expect(updated).not.toHaveProperty('clientId');
        });

        it('should accept a valid clientId for a chapter rewrite', async () => {
            const storyId = `test-client-rewrite-${Date.now()}`;
            seedStory(storyId, true);

            const parameters = createMockParameters(storyId, {
                rewriteChapter: 0,
                rewriteContext: 'Make the scene more dramatic',
                clientId: 'Qwen3_8'
            });

            const result = await generationUpdateChapter(mockContext, parameters, { root: projectRoot });

            expect(result.status).toBe(200);
            expect(result.response.storyId).toBe(storyId);
            expect(result.response.rewriteChapter).toBe(0);
            expect(result.response.message).toContain('rewrite started');
        });
    });
});
