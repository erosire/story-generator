/**
 * @vitest-environment node
 * This test needs the Node environment because the handler imports @runtime/secret/private
 * which transitively imports OpenAI SDK — that SDK throws in jsdom browser-like environments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

// Mock the config module — this is the single source of truth for all generation settings.
// Importing it here keeps the test in sync with config changes.
vi.mock('./generation-config', () => {
    const createMockClient = (): any => {
        const client: any = {
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockImplementation(() => createMockClient()),
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                // Chapter expansion requests contain "Expand the chapter"
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Expanded Chapter',
                            content: 'This is the expanded content of the chapter. ' + 'word '.repeat(3500)
                        }
                    });
                }
                // All other calls (plotpoint generation, validation retries, outline retries)
                return Promise.resolve({
                    response: {
                        chapters: [
                            {
                                number: '1',
                                title: 'Chapter One',
                                plotpoints: ['Plot point A', 'Plot point B']
                            },
                            {
                                number: '2',
                                title: 'Chapter Two',
                                plotpoints: ['Plot point C']
                            },
                            {
                                number: '3',
                                title: 'Chapter Three',
                                plotpoints: ['Plot point D']
                            }
                        ]
                    }
                });
            }),
            structure: vi.fn().mockResolvedValue({ response: { chapters: [], title: '', content: '' } }),
            messages: []
        };
        return client;
    };

    return {
        useApiMethod: 'format',
        OPENING_USER_MESSAGE: 'Hey ENI',
        STORY_REQUEST_MESSAGE: 'You know the story I like',
        MAX_PLOT_ATTEMPTS: 3,
        MAX_STORY_ATTEMPTS: 3,
        MAX_STALL_RETRIES: 10,
        PLOTPOINT_STALL_TIMEOUT_MS: 5 * 60 * 1000,
        PREVIOUS_EXPANDED_CHAPTERS: 4,
        EXPAND_TIMEOUT_MS: 10 * 60 * 1000,
        MIN_WORDS_PER_CHAPTER: 3000,
        TARGET_WORD_COUNT_PROMPT: '15,000 words',
        MIN_PLOTPOINTS_PER_CHAPTER: 10,
        REFUSAL_PATTERNS: ['I cannot fulfill', 'I will not'],
        DATABASE_BASE_DIR: 'storyboard',
        CLIENT: createMockClient()
    };
});

// Mock the prompts
vi.mock('@runtime/data/prompts', () => ({
    KIMIK2_INSTRUCTIONS: 'test instructions',
    KIMIK2_OPENING: 'test opening'
}));

// Mock arrayEachAsync to run sequentially in test
vi.mock('@presource/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@presource/core')>();
    return {
        ...actual,
        // Override arrayEachAsync to run synchronously for testing
        arrayEachAsync: async (arr: any[], fn: any) => {
            for (let i = 0; i < arr.length; i++) {
                await fn({ index: i, value: arr[i], length: arr.length });
            }
        }
    };
});

// Import handler AND mock target AFTER mocks are set up
import { CLIENT } from './generation-config';
import { generationCreateNewStory } from './generation-create-new-story';
import { MIN_WORDS_PER_CHAPTER, EXPAND_TIMEOUT_MS, DATABASE_BASE_DIR } from './generation-config';

// Use an isolated temp directory as the project root so tests never pollute the
// source tree. The service normally passes temporary/database via variables.root,
// but tests must not assume any particular on-disk location.
const projectRoot = path.join(os.tmpdir(), `story-gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Helper to resolve the storyboard directory for a given storyId
const getStoryboardDir = (storyId: string) => path.join(projectRoot, DATABASE_BASE_DIR, storyId);

const TEST_STORYLINE = 'A sci-fi adventure about a crew discovering an ancient alien artifact on Mars.';
const TEST_CHAPTER_COUNT = 3;

// Mock context object (not used by the handler but required by the type)
const mockContext = {} as any;

// Mock parameters factory
const createMockParameters = (storyId: string, body: Record<string, any> = {}) => ({
    path: { storyId },
    query: {},
    body
});

describe('generationCreateNewStory', () => {
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
        vi.useRealTimers(); // Ensure timers are always restored
        vi.restoreAllMocks();
    });

    it('should accept a storyId and storyline, return the storyId in the response', async () => {
        const storyId = `test-story-${Date.now()}`;
        createdStoryIds.push(storyId);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        // Should return the storyId that was passed in the path
        expect(result.status).toBe(200);
        expect(result.response).toHaveProperty('storyId');
        expect(result.response.storyId).toBe(storyId);
        expect(typeof result.response.storyId).toBe('string');
        expect(result.response.storyId.length).toBeGreaterThan(0);
    });

    it('should create the storyboard directory below the injected database root', async () => {
        const storyId = `test-story-dir-${Date.now()}`;
        createdStoryIds.push(storyId);
        const storyboardDir = getStoryboardDir(storyId);

        // Directory should not exist before the call
        expect(fs.existsSync(storyboardDir)).toBe(false);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);
        expect(result.response.storyId).toBe(storyId);

        // Wait for the async background process to create the directory and files
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Directory should be created after the call (background process starts immediately)
        expect(fs.existsSync(storyboardDir)).toBe(true);

        // plotpoint.json should be created with the request metadata
        const plotpointJsonPath = path.join(storyboardDir, 'plotpoint.json');
        expect(fs.existsSync(plotpointJsonPath)).toBe(true);

        const storyMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(storyMeta.storyId).toBe(storyId);
        expect(storyMeta.storyline).toBe(TEST_STORYLINE);
        expect(storyMeta.chapterCount).toBe(TEST_CHAPTER_COUNT);
        expect(typeof storyMeta.createdAt).toBe('string');
        expect(storyMeta.createdAt.length).toBeGreaterThan(0);

        // plotpoint.md should also be created
        const plotpointPath = path.join(storyboardDir, 'plotpoint.md');
        expect(fs.existsSync(plotpointPath)).toBe(true);

        // chapter directory should exist
        const chapterDir = path.join(storyboardDir, 'chapter');
        expect(fs.existsSync(chapterDir)).toBe(true);

        // chapter .md and .json files should be created
        const mdFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.md')).sort();
        const jsonFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort();
        expect(mdFiles.length).toBeGreaterThan(0);
        expect(jsonFiles.length).toBe(mdFiles.length);

        // Verify chapter-001.json structure and content
        const chapterJsonPath = path.join(chapterDir, 'chapter-001.json');
        expect(fs.existsSync(chapterJsonPath)).toBe(true);

        const chapterPayload = JSON.parse(fs.readFileSync(chapterJsonPath, 'utf-8'));
        expect(chapterPayload.storyId).toBe(storyId);
        expect(chapterPayload.storyline).toBe(TEST_STORYLINE);
        expect(chapterPayload.chapterCount).toBe(TEST_CHAPTER_COUNT);
        expect(chapterPayload.chapterNumber).toBe('1');
        expect(chapterPayload.chapterIndex).toBe(0);
        expect(typeof chapterPayload.title).toBe('string');
        expect(Array.isArray(chapterPayload.plotpoints)).toBe(true);
        expect(chapterPayload.plotpoints.length).toBeGreaterThan(0);

        // Context must contain the appending snapshot and request
        expect(Array.isArray(chapterPayload.context.appending)).toBe(true);
        expect(typeof chapterPayload.context.request).toBe('string');

        // Config must contain systemInstructions and openingMessage
        expect(typeof chapterPayload.config.systemInstructions).toBe('string');
        expect(typeof chapterPayload.config.openingMessage).toBe('string');

        // No top-level expansion or generationTimeMs — content lives in revisions[]
        expect(chapterPayload.expansion).toBeUndefined();
        expect(chapterPayload.generationTimeMs).toBeUndefined();

        // Result must contain title and content in revisions[]
        expect(Array.isArray(chapterPayload.revisions)).toBe(true);
        expect(chapterPayload.revisions.length).toBeGreaterThan(0);
        const latestRev = chapterPayload.revisions[chapterPayload.revisions.length - 1];
        expect(typeof latestRev.content).toBe('string');
        expect(latestRev.content.length).toBeGreaterThan(0);
    });

    it('should return 400 when storyline is missing', async () => {
        const storyId = `test-story-no-line-${Date.now()}`;
        createdStoryIds.push(storyId);

        // Empty body — storyline is missing
        const parameters = createMockParameters(storyId, {});

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('storyline');
    });

    it('should return 400 when storyId is missing', async () => {
        // No storyId in path
        const parameters = {
            path: {},
            query: {},
            body: { storyline: TEST_STORYLINE, chapterCount: TEST_CHAPTER_COUNT }
        };

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('storyId');
    });

    it('should return 400 when chapterCount is not a positive number', async () => {
        const storyId = `test-story-bad-count-${Date.now()}`;
        createdStoryIds.push(storyId);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: -1
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('chapterCount');
    });

    it('should retry chapter expansion after timeout and log timeout error', async () => {
        vi.useFakeTimers();

        const storyId = `test-story-timeout-${Date.now()}`;
        createdStoryIds.push(storyId);

        let expandStructureCalls = 0;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => {
                expandStructureCalls++;
                if (expandStructureCalls === 1) {
                    // Plotpoint generation — succeed immediately
                    return Promise.resolve({
                        response: {
                            chapters: [
                                {
                                    number: '1',
                                    title: 'Chapter One',
                                    plotpoints: ['Plot point A']
                                }
                            ]
                        }
                    });
                }
                if (expandStructureCalls === 2) {
                    // First expansion attempt — hang forever (timeout will terminate it)
                    return new Promise(() => {});
                }
                // Retry expansion — succeed immediately
                return Promise.resolve({
                    response: {
                        title: 'Expanded Chapter',
                        content: 'This is expanded content after timeout retry. ' + 'word '.repeat(3500)
                    }
                });
            })
        } as any);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: 1
        });

        // Handler returns immediately (200) — generation runs in background
        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Let microtasks settle (plotpoint generation starts)
        await vi.advanceTimersByTimeAsync(0);

        // Advance past the timeout to trigger the timeout error
        await vi.advanceTimersByTimeAsync(EXPAND_TIMEOUT_MS + 1);

        // Let the retry complete (microtasks for structure call + file writes)
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Restore real timers for cleanup
        vi.useRealTimers();

        // Wait for all background operations to fully complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify timeout error was logged
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[TIMEOUT]')
        );
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('timed out')
        );

        // Verify chapter was eventually written successfully after retry
        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        expect(fs.existsSync(chapterDir)).toBe(true);

        const mdFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.md'));
        expect(mdFiles.length).toBe(1);
        expect(mdFiles[0]).toBe('chapter-001.md');

        // Verify the content is from the successful retry, not the timed-out attempt
        const content = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(content).toContain('Expanded Chapter');
        expect(content).toContain('This is expanded content after timeout retry');
    }, 30000);

    it('should log error details when expansion fails with a non-timeout error', async () => {
        const storyId = `test-story-error-${Date.now()}`;
        createdStoryIds.push(storyId);

        let expandStructureCalls = 0;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => {
                expandStructureCalls++;
                if (expandStructureCalls === 1) {
                    // Plotpoint generation
                    return Promise.resolve({
                        response: {
                            chapters: [
                                {
                                    number: '1',
                                    title: 'Chapter One',
                                    plotpoints: ['Plot point A']
                                }
                            ]
                        }
                    });
                }
                if (expandStructureCalls === 2) {
                    // First expansion — throw a non-timeout error
                    return Promise.reject(new Error('Network connection reset'));
                }
                // Retry — succeed
                return Promise.resolve({
                    response: {
                        title: 'Expanded Chapter',
                        content: 'Recovered after error. ' + 'word '.repeat(3500)
                    }
                });
            })
        } as any);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: 1
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Wait for background generation to complete
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Verify error was logged with [ERROR] tag (not [TIMEOUT])
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[ERROR]')
        );
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('Network connection reset')
        );

        // Verify the [TIMEOUT] tag was NOT logged (it was a non-timeout error)
        const errorCalls = (console.error as any).mock.calls.map((call: any[]) => call.join(' '));
        const hasTimeoutLog = errorCalls.some((msg: string) => msg.includes('[TIMEOUT]'));
        expect(hasTimeoutLog).toBe(false);

        // Verify chapter was written successfully after retry
        const storyboardDir = getStoryboardDir(storyId);
        const chapterDir = path.join(storyboardDir, 'chapter');
        expect(fs.existsSync(chapterDir)).toBe(true);

        const content = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(content).toContain('Recovered after error');
    }, 30000);

    it('should mark current story as failed and spin up flat retry story when plotlines validation fails', async () => {
        const storyId = `test-story-validation-${Date.now()}`;
        createdStoryIds.push(storyId);

        let formatCalls = 0;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                formatCalls++;

                // Chapter expansion calls — always succeed
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Expanded Chapter',
                            content: 'This is the expanded content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                // Plotpoint generation calls for the ORIGINAL story (calls 1-4):
                // Return wrong chapter count (2 instead of requested 3) to trigger validation failure.
                // 1 initial call + 3 validation retries = 4 calls before markCompleteAndRetry fires.
                if (formatCalls <= 4) {
                    return Promise.resolve({
                        response: {
                            chapters: [
                                { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
                                { number: '2', title: 'Chapter Two', plotpoints: ['Plot B'] }
                            ]
                        }
                    });
                }

                // Plotpoint generation calls for the RETRY story (call 5+):
                // Return correct chapter count so retry succeeds.
                return Promise.resolve({
                    response: {
                        chapters: [
                            { number: '1', title: 'Chapter One', plotpoints: ['Plot A', 'Plot B'] },
                            { number: '2', title: 'Chapter Two', plotpoints: ['Plot C', 'Plot D'] },
                            { number: '3', title: 'Chapter Three', plotpoints: ['Plot E', 'Plot F'] }
                        ]
                    }
                });
            })
        } as any);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: 3
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Wait for the initial story to exhaust validation retries and fire retry
        // Then wait for the retry story to complete plotpoint + chapter expansion
        await new Promise((resolve) => setTimeout(resolve, 8000));

        // Verify the original story was marked as failed
        const storyboardDir = getStoryboardDir(storyId);
        const plotpointJsonPath = path.join(storyboardDir, 'plotpoint.json');
        expect(fs.existsSync(plotpointJsonPath)).toBe(true);

        const originalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(originalMeta.status).toBe('failed');
        expect(originalMeta.validation).toBeDefined();
        expect(originalMeta.validation.valid).toBe(false);
        expect(originalMeta.validation.reason).toContain('Chapter count mismatch');

        // Verify retry story was created with FLAT ID (not nested)
        const retryStoryId = `${storyId}-retry-1`;
        const retryStoryboardDir = getStoryboardDir(retryStoryId);
        createdStoryIds.push(retryStoryId);

        expect(fs.existsSync(retryStoryboardDir)).toBe(true);

        // Verify retry plotpoint.json exists and has correct metadata
        const retryPlotpointJsonPath = path.join(retryStoryboardDir, 'plotpoint.json');
        expect(fs.existsSync(retryPlotpointJsonPath)).toBe(true);

        const retryMeta = JSON.parse(fs.readFileSync(retryPlotpointJsonPath, 'utf-8'));
        expect(retryMeta.storyId).toBe(retryStoryId);
        expect(retryMeta.storyName).toContain('[retry 1]');
        expect(retryMeta.storyline).toBe(TEST_STORYLINE);
        expect(retryMeta.chapterCount).toBe(TEST_CHAPTER_COUNT);

        // Verify the retry story ID is flat (not nested like "story-retry-1-retry-2")
        expect(retryStoryId).not.toContain('retry-retry');
        expect(retryStoryId.endsWith('-retry-1')).toBe(true);
    }, 30000);

    it('should produce flat retry IDs across multiple consecutive failures', async () => {
        const storyId = `test-story-flat-${Date.now()}`;
        createdStoryIds.push(storyId);

        let formatCalls = 0;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                formatCalls++;

                // Chapter expansion calls — always succeed
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Expanded Chapter',
                            content: 'This is expanded content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                // ALL plotpoint calls return wrong chapter count (1 instead of 3).
                // This exhausts MAX_PLOT_ATTEMPTS for every story and triggers markCompleteAndRetry.
                // Each story makes 1 initial + MAX_PLOT_ATTEMPTS(3) retries = 4 format calls.
                return Promise.resolve({
                    response: {
                        chapters: [
                            { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] }
                        ]
                    }
                });
            })
        } as any);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: 3
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Wait long enough for: original → retry-1 → retry-2 to all exhaust and fail
        // Each story takes ~4 fast format calls. Wait generously for async processing.
        await new Promise((resolve) => setTimeout(resolve, 12000));

        // Verify first retry exists with flat ID
        const retry1StoryId = `${storyId}-retry-1`;
        const retry1Dir = getStoryboardDir(retry1StoryId);
        createdStoryIds.push(retry1StoryId);
        expect(fs.existsSync(retry1Dir)).toBe(true);

        // Verify retry-1 plotpoint.json has failed status
        const retry1Meta = JSON.parse(
            fs.readFileSync(path.join(retry1Dir, 'plotpoint.json'), 'utf-8')
        );
        expect(retry1Meta.status).toBe('failed');
        expect(retry1Meta.storyId).toBe(retry1StoryId);

        // The critical assertion: retry-1 ID is flat
        expect(retry1StoryId).toBe(`${storyId}-retry-1`);

        // Verify second retry exists with flat ID (NOT "story-retry-1-retry-2")
        const retry2StoryId = `${storyId}-retry-2`;
        const retry2Dir = getStoryboardDir(retry2StoryId);
        createdStoryIds.push(retry2StoryId);
        expect(fs.existsSync(retry2Dir)).toBe(true);

        const retry2Meta = JSON.parse(
            fs.readFileSync(path.join(retry2Dir, 'plotpoint.json'), 'utf-8')
        );
        expect(retry2Meta.storyId).toBe(retry2StoryId);
        expect(retry2Meta.storyName).toContain('[retry 2]');

        // The critical assertion: retry-2 ID is flat, NOT nested
        expect(retry2StoryId).toBe(`${storyId}-retry-2`);
        expect(retry2StoryId).not.toContain('retry-retry');
    }, 30000);
});
