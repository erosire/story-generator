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

    // Shared instance so CLIENT and the CLIENTS map resolve to the same mock —
    // story-utils createStoryClient() now calls resolveClient(clientId), which
    // the handler paths under test drive via parseClientId below.
    const mockClient = createMockClient();

    // Test-only CLIENTS surface: 'Qwen3_8' is the only selectable id, mirroring
    // the production default while keeping the fake parseClientId contract
    // deterministic (unknown id → 400 with the exact production error shape).
    const clients: Record<string, any> = { Qwen3_8: mockClient };

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
        CLIENT: mockClient,
        CLIENTS: clients,
        // Faithful re-implementation of the production parseClientId contract
        // (generation-config.ts) against the test-only CLIENTS set, so the
        // endpoint validation is exercised end-to-end even though the real
        // config module (with its private provider clients) is mocked out.
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
        // story-utils createStoryClient() resolves the per-request clientId
        // through this — the handler already validated via parseClientId, so
        // the mock pins every id back to the shared client.
        resolveClient: (_clientId?: string | null) => mockClient
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
// buildExpandRequest is the real (non-mocked, prompt-only) helper from
// story-utils — used to build exact expected context.request values in the
// plotline-only tests so the assertions stay in lockstep with the prompt.
import { buildExpandRequest } from './story-utils';
import { DATABASE_BASE_DIR } from './generation-config';

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

// Exact plotline-summary format as written to chapter context by the production
// code (generation-create-new-story.ts plotline pass / story-utils
// buildAppendingFromChapters): entries are built as
// [heading, '\n\n', bullets].join('\n\n') — the join separator on BOTH sides of
// the '\n\n' element plus the element itself yields SIX newlines (5 blank
// lines) between the heading and the bullet list. The literals below hardcode
// that exact value (verified against the on-disk chapter-XXX.json context).
const SUMMARY_SEP = '\n\n\n\n\n\n';

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

        // Plotline-only contract (Generate button → plotOnly API): once the
        // plotline is generated the story is terminal ('completed') even though
        // chapterCompleted stays 0. The default mocked LLM response yields the
        // 3 plotline chapters asserted below — see the vi.mock factory above.
        expect(storyMeta.status).toBe('completed');
        expect(storyMeta.validation).toEqual({ valid: true, reason: 'plotline complete', attempt: 0 });
        expect(storyMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: ['Plot point A', 'Plot point B'] },
            { number: '2', title: 'Chapter Two', plotpoints: ['Plot point C'] },
            { number: '3', title: 'Chapter Three', plotpoints: ['Plot point D'] }
        ]);

        // plotpoint.md should also be created
        const plotpointPath = path.join(storyboardDir, 'plotpoint.md');
        expect(fs.existsSync(plotpointPath)).toBe(true);

        // chapter directory should exist
        const chapterDir = path.join(storyboardDir, 'chapter');
        expect(fs.existsSync(chapterDir)).toBe(true);

        // Plotline-only: chapters are NOT auto-expanded, so no chapter-XXX.md
        // files exist (the .md file is only written by the expansion pass).
        // Exactly three skeleton chapter-XXX.json payloads — one per plotline
        // chapter — are written instead.
        const mdFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.md')).sort();
        const jsonFiles = fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort();
        expect(mdFiles).toEqual([]);
        expect(jsonFiles).toEqual(['chapter-001.json', 'chapter-002.json', 'chapter-003.json']);

        // Verify chapter-001.json is a full skeleton: stored LLM context for a
        // later per-chapter expansion (via PATCH) with EMPTY revisions[].
        const chapterJsonPath = path.join(chapterDir, 'chapter-001.json');
        expect(fs.existsSync(chapterJsonPath)).toBe(true);

        const chapterPayload = JSON.parse(fs.readFileSync(chapterJsonPath, 'utf-8'));
        expect(chapterPayload).toEqual({
            storyId,
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Chapter 1',
            plotpoints: ['Plot point A', 'Plot point B'],
            context: {
                // All-plotline summaries — exactly what the first expansion of
                // chapter 1 will see in context (no expanded prose exists yet).
                appending: [
                    '> 1: Chapter One' + SUMMARY_SEP + '- Plot point A\n- Plot point B',
                    '> 2: Chapter Two' + SUMMARY_SEP + '- Plot point C',
                    '> 3: Chapter Three' + SUMMARY_SEP + '- Plot point D'
                ],
                request: buildExpandRequest('1', 'Chapter One')
            },
            config: {
                systemInstructions: 'test instructions',
                openingMessage: 'test opening'
            },
            revisions: []
        });

        // The last chapter's skeleton carries the same all-summary context —
        // proving no chapter was expanded along the way (an expansion pass
        // would have replaced earlier entries with expanded content).
        const lastPayload = JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-003.json'), 'utf-8'));
        expect(lastPayload.chapterIndex).toBe(2);
        expect(lastPayload.revisions).toEqual([]);
        expect(lastPayload.context.appending).toEqual(chapterPayload.context.appending);
        expect(lastPayload.context.request).toBe(buildExpandRequest('3', 'Chapter Three'));
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

    // ── Per-request clientId selection ────────────────────────────────────
    // The clientId travels with each payload (never stored — see the
    // generation-config.ts parseClientId/resolveClient contract) and selects
    // which LLM client the background generation uses.
    it('should return 400 when clientId is present but not a string', async () => {
        const storyId = `test-story-bad-client-type-${Date.now()}`;
        createdStoryIds.push(storyId);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT,
            clientId: 42
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toBe('clientId must be a non-empty string');
        // Validation happens before generation starts — no story dir may exist.
        expect(fs.existsSync(getStoryboardDir(storyId))).toBe(false);
    });

    it('should return 400 when clientId is unknown, listing the available clients', async () => {
        const storyId = `test-story-unknown-client-${Date.now()}`;
        createdStoryIds.push(storyId);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT,
            clientId: 'unknown-client'
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(400);
        expect(result.response).toHaveProperty('error');
        expect(result.response.error).toContain('Unknown clientId');
        expect(result.response.error).toContain('unknown-client');
        // The error message lists every selectable id so the caller self-corrects.
        expect(result.response.error).toContain('Qwen3_8');
        expect(fs.existsSync(getStoryboardDir(storyId))).toBe(false);
    });

    it('should accept a valid clientId, run generation, and never persist it', async () => {
        const storyId = `test-story-with-client-${Date.now()}`;
        createdStoryIds.push(storyId);
        const storyboardDir = getStoryboardDir(storyId);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: TEST_CHAPTER_COUNT,
            clientId: 'Qwen3_8'
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });

        expect(result.status).toBe(200);
        expect(result.response.storyId).toBe(storyId);

        // Wait for the fire-and-forget background generation to write the
        // placeholder plotpoint.json (same pattern as the directory test above).
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(fs.existsSync(path.join(storyboardDir, 'plotpoint.json'))).toBe(true);

        // Contract: clientId is per-request only — plotpoint.json must NOT
        // gain a clientId field (the story dir is the story's persistent state).
        const storyMeta = JSON.parse(fs.readFileSync(path.join(storyboardDir, 'plotpoint.json'), 'utf-8'));
        expect(storyMeta).not.toHaveProperty('clientId');
        expect(storyMeta.storyId).toBe(storyId);
        expect(storyMeta.storyline).toBe(TEST_STORYLINE);
    });

    // ── Plotline-only (dashboard Generate button) ─────────────────────────────
    // The Generate button's POST now always triggers plotline-only
    // generation (plotOnly: true in generation-create-new-story.ts): the LLM
    // is called for the plot outline only, chapters end as skeleton
    // chapter-XXX.json payloads (stored LLM context, empty revisions[]), and
    // no expansion request ("Expand the chapter ...") ever reaches the LLM.
    // Chapters are expanded afterwards, one at a time, via the PATCH
    // { expandChapterIndex } endpoint (generation-update-chapter.test.ts).
    it('should generate the plotline only: one LLM call, skeleton payloads, no expansion', async () => {
        const storyId = `test-story-plotonly-${Date.now()}`;
        createdStoryIds.push(storyId);
        const chapterDir = path.join(getStoryboardDir(storyId), 'chapter');

        // Pin every client clone to ONE instance so all LLM calls accumulate
        // on a single spy; record every request the server sent to the LLM so
        // the test can prove which categories (plot vs expand) were attempted.
        const seenRequests: string[] = [];
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                seenRequests.push(request);
                // A valid 2-chapter plotline — exactly matches chapterCount below.
                return Promise.resolve({
                    response: {
                        chapters: [
                            { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
                            { number: '2', title: 'Chapter Two', plotpoints: ['Plot B', 'Plot C'] }
                        ]
                    }
                });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);
        expect(result.response.storyId).toBe(storyId);

        // Deterministic completion signal: the terminal 'completed' status in
        // plotpoint.json is written by the plotline-only completion path.
        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Exactly ONE LLM call — the plotline request. No chapter expansion
        // (buildExpandRequest prompts) may have been attempted by this request.
        expect(seenRequests.length).toBe(1);
        const expandRequests = seenRequests.filter((r) => r.includes('Expand the chapter'));
        expect(expandRequests).toEqual([]);

        // No expanded .md files (the .md is only written during expansion).
        expect(fs.readdirSync(chapterDir).filter((f) => f.endsWith('.md'))).toEqual([]);

        // Skeleton payload: full LLM context for a later PATCH expansion,
        // but ZERO revisions — the chapter content was never generated.
        const skeleton = JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-002.json'), 'utf-8'));
        expect(skeleton).toEqual({
            storyId,
            storyline: TEST_STORYLINE,
            chapterCount: 2,
            chapterNumber: '2',
            chapterIndex: 1,
            title: 'Chapter 2',
            plotpoints: ['Plot B', 'Plot C'],
            context: {
                appending: [
                    '> 1: Chapter One' + SUMMARY_SEP + '- Plot A',
                    '> 2: Chapter Two' + SUMMARY_SEP + '- Plot B\n- Plot C'
                ],
                request: buildExpandRequest('2', 'Chapter Two')
            },
            config: {
                systemInstructions: 'test instructions',
                openingMessage: 'test opening'
            },
            revisions: []
        });

        // Terminal metadata: plotline complete, validation passed on the first
        // attempt, chapterCompleted stays 0 (advances only when the user
        // expands a chapter via PATCH — see incrementPlotpointChapterCompleted).
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.status).toBe('completed');
        expect(finalMeta.validation).toEqual({ valid: true, reason: 'plotline complete', attempt: 0 });
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
            { number: '2', title: 'Chapter Two', plotpoints: ['Plot B', 'Plot C'] }
        ]);
    });

    it('should keep retries plotline-only: a retried story completes as a plotline without expansion', async () => {
        // NOTE: the storyId must NOT end in `-retry-<digits>` — generateStory
        // parses that suffix via /-retry-(\d+)$/ to seed retryIndex, so a
        // literal `-retry-` in a fresh (non-retry) storyId would corrupt the
        // retry-ID derivation (the new retry story would get a bogus id).
        const storyId = `test-story-plotonlychain-${Date.now()}`;
        const retryStoryId = `${storyId}-retry-1`;
        const noRetryStoryId = `${storyId}-retry-2`;
        createdStoryIds.push(storyId, retryStoryId, noRetryStoryId);

        const seenRequests: string[] = [];
        let plotCalls = 0;
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                seenRequests.push(request);
                // A plotline-only story must NEVER send an expansion request —
                // if one appears, the plotOnly flag failed to carry over.
                expect(request.includes('Expand the chapter')).toBe(false);

                plotCalls++;
                // Attempt 1 (original story): the plot request fails → the
                // story is marked failed and a retry story is spun up.
                if (plotCalls === 1) {
                    return Promise.reject(new Error('plot exploded'));
                }
                // Attempt 2 (retry story): a valid 1-chapter plotline.
                return Promise.resolve({
                    response: {
                        chapters: [{ number: '1', title: 'Recovered Plot', plotpoints: ['Recovered plot point'] }]
                    }
                });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const originalPlotpointPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        const retryPlotpointPath = path.join(getStoryboardDir(retryStoryId), 'plotpoint.json');
        // The original fails; the retry must complete AS PLOTLINE-ONLY.
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).status).toBe('failed');
                expect(JSON.parse(fs.readFileSync(retryPlotpointPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // The original failure is recorded with the plot error.
        expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8'))).toMatchObject({
            storyId,
            status: 'failed',
            validation: { valid: false, reason: 'plot exploded' }
        });

        // The retry story is plotline-complete: its chapter is a SKELETON
        // (empty revisions, no .md file), not an expanded chapter.
        const retryChapterDir = path.join(getStoryboardDir(retryStoryId), 'chapter');
        expect(fs.readdirSync(retryChapterDir).filter((f) => f.endsWith('.md'))).toEqual([]);
        const retrySkeleton = JSON.parse(fs.readFileSync(path.join(retryChapterDir, 'chapter-001.json'), 'utf-8'));
        expect(retrySkeleton).toEqual({
            storyId: retryStoryId,
            storyline: TEST_STORYLINE,
            chapterCount: 1,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Chapter 1',
            plotpoints: ['Recovered plot point'],
            context: {
                appending: ['> 1: Recovered Plot' + SUMMARY_SEP + '- Recovered plot point'],
                request: buildExpandRequest('1', 'Recovered Plot')
            },
            config: {
                systemInstructions: 'test instructions',
                openingMessage: 'test opening'
            },
            revisions: []
        });

        // The retry succeeded, so no third story (retry-2) may be spawned.
        expect(fs.existsSync(getStoryboardDir(noRetryStoryId))).toBe(false);
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

    it('should create a separate retry when outline retries exhaust with missing plotpoints', async () => {
        const storyId = `test-story-outline-failure-${Date.now()}`;
        const retryStoryId = `${storyId}-retry-1`;
        createdStoryIds.push(storyId, retryStoryId);

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

                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Recovered Chapter',
                            content: 'Recovered chapter content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                // The original story returns the correct chapter count but never
                // supplies plotpoints for chapter two, exhausting outline retries.
                if (formatCalls <= 4) {
                    return Promise.resolve({
                        response: {
                            chapters: [
                                { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
                                { number: '2', title: 'Chapter Two', plotpoints: [] }
                            ]
                        }
                    });
                }

                // The separate retry receives a complete outline and can expand.
                return Promise.resolve({
                    response: {
                        chapters: [
                            { number: '1', title: 'Chapter One', plotpoints: ['Retry Plot A'] },
                            { number: '2', title: 'Chapter Two', plotpoints: ['Retry Plot B'] }
                        ]
                    }
                });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const originalPlotpointPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(fs.existsSync(originalPlotpointPath)).toBe(true);
                expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).status).toBe('failed');
                expect(fs.existsSync(getStoryboardDir(retryStoryId))).toBe(true);
            },
            { timeout: 5000, interval: 10 }
        );

        expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: ['Plot A'] },
            { number: '2', title: 'Chapter Two', plotpoints: [] }
        ]);
    }, 30000);

    it('should keep a failed story immutable when a late plot stream callback arrives', async () => {
        const storyId = `test-story-late-failure-${Date.now()}`;
        const retryStoryId = `${storyId}-retry-1`;
        createdStoryIds.push(storyId, retryStoryId);

        let formatCalls = 0;
        let latePlotUpdate: ((update: string) => Promise<void>) | undefined;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                formatCalls++;

                // The retry story must finish its chapter so the test covers
                // the real fire-and-forget retry path, not only directory setup.
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Recovered Chapter',
                            content: 'Recovered chapter content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                if (formatCalls === 1) {
                    // Capture the wrapped callback and reject the initial plot
                    // request. Calling it after failure simulates a late SSE
                    // update from a request that could not be cancelled.
                    latePlotUpdate = config.onUpdate;
                    return Promise.reject(new Error('Initial plot request failed'));
                }

                return Promise.resolve({
                    response: {
                        chapters: [{ number: '1', title: 'Recovered Plot', plotpoints: ['Recovered plot point'] }]
                    }
                });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const originalPlotpointPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(fs.existsSync(originalPlotpointPath)).toBe(true);
                expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).status).toBe('failed');
            },
            { timeout: 5000, interval: 10 }
        );

        expect(latePlotUpdate).toBeDefined();
        const failedSnapshot = fs.readFileSync(originalPlotpointPath, 'utf-8');

        // This callback would previously rewrite the failed plotpoint.json with
        // status="generating" and partial chapters after the retry started.
        await latePlotUpdate!(JSON.stringify({ chapters: [{ number: '1', title: 'Late', plotpoints: ['Late'] }] }));

        expect(fs.readFileSync(originalPlotpointPath, 'utf-8')).toBe(failedSnapshot);
        expect(fs.existsSync(getStoryboardDir(retryStoryId))).toBe(true);
    }, 30000);

    it('should skip an existing retry directory instead of overwriting its failed output', async () => {
        const storyId = `test-story-retry-collision-${Date.now()}`;
        const existingRetryId = `${storyId}-retry-1`;
        const nextRetryId = `${storyId}-retry-2`;
        createdStoryIds.push(storyId, existingRetryId, nextRetryId);

        // Simulate a failed retry from an earlier generation chain. Its exact
        // bytes are asserted after the new chain selects the next free ID.
        const existingRetryDir = getStoryboardDir(existingRetryId);
        fs.mkdirSync(existingRetryDir, { recursive: true });
        const existingRetryData = {
            storyId: existingRetryId,
            status: 'failed',
            validation: { valid: false, reason: 'preserve this retry' },
            chapters: [{ number: '1', title: 'Old failure', plotpoints: ['Old plot'] }]
        };
        const existingRetryPath = path.join(existingRetryDir, 'plotpoint.json');
        fs.writeFileSync(existingRetryPath, JSON.stringify(existingRetryData, null, 2), 'utf-8');

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

                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Recovered Chapter',
                            content: 'Recovered chapter content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                if (formatCalls === 1) {
                    return Promise.reject(new Error('Initial plot request failed'));
                }

                return Promise.resolve({
                    response: {
                        chapters: [{ number: '1', title: 'Recovered Plot', plotpoints: ['Recovered plot point'] }]
                    }
                });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const originalPlotpointPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(fs.existsSync(originalPlotpointPath)).toBe(true);
                expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).status).toBe('failed');
                expect(fs.existsSync(getStoryboardDir(nextRetryId))).toBe(true);
            },
            { timeout: 5000, interval: 10 }
        );

        expect(JSON.parse(fs.readFileSync(existingRetryPath, 'utf-8'))).toEqual(existingRetryData);
        expect(fs.existsSync(getStoryboardDir(existingRetryId))).toBe(true);
        expect(fs.existsSync(getStoryboardDir(nextRetryId))).toBe(true);
    }, 30000);

    it('should keep the failed story unchanged when the same story request is submitted again', async () => {
        const storyId = `test-story-duplicate-request-${Date.now()}`;
        const retryStoryId = `${storyId}-retry-1`;
        createdStoryIds.push(storyId, retryStoryId);

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

                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Recovered Chapter',
                            content: 'Recovered chapter content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                if (formatCalls === 1) {
                    return Promise.reject(new Error('Initial plot request failed'));
                }

                return Promise.resolve({
                    response: {
                        chapters: [{ number: '1', title: 'Recovered Plot', plotpoints: ['Recovered plot point'] }]
                    }
                });
            })
        } as any);

        const firstResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(firstResult.status).toBe(200);

        const originalPlotpointPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(fs.existsSync(originalPlotpointPath)).toBe(true);
                expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).status).toBe('failed');
            },
            { timeout: 5000, interval: 10 }
        );

        const failedSnapshot = fs.readFileSync(originalPlotpointPath, 'utf-8');

        // A repeated POST for the same ID must not restart generation in the
        // failed directory. The handler remains idempotent at the HTTP boundary,
        // while the reserved directory protects the persisted failure.
        const duplicateResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(duplicateResult.status).toBe(200);

        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(fs.readFileSync(originalPlotpointPath, 'utf-8')).toBe(failedSnapshot);
        expect(fs.existsSync(getStoryboardDir(retryStoryId))).toBe(true);
    }, 30000);

    // ── Append request (the dashboard's "[->]" append dialog) ─────────────
    // POST { append: { chapterCount, notes? } } against an EXISTING storyId
    // extends that story in place: the LLM generates plotlines for
    // chapterCount NEW chapters which are stored AFTER the current chapter
    // list (10 existing + 3 appended = 13), with skeleton chapter payloads
    // so the new chapters can be expanded later. No expansion happens here.
    // See generation-append-story.ts.

    it('should return 400 when append.chapterCount is not a positive number', async () => {
        const storyId = `test-append-bad-count-${Date.now()}`;
        createdStoryIds.push(storyId);
        createdStoryIds.push(`${storyId}-retry-1`); // in case a retry dir would appear — validation must NOT create one

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { append: { chapterCount: 0 } }),
            { root: projectRoot }
        );

        expect(result.status).toBe(400);
        expect(result.response.error).toBe('append.chapterCount must be a positive number');
        // Validation fails before any background job — no story dir may exist.
        expect(fs.existsSync(getStoryboardDir(storyId))).toBe(false);
    });

    it('should return 400 when append.notes is an empty string', async () => {
        const storyId = `test-append-bad-notes-${Date.now()}`;
        createdStoryIds.push(storyId);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { append: { chapterCount: 2, notes: '   ' } }),
            { root: projectRoot }
        );

        expect(result.status).toBe(400);
        expect(result.response.error).toBe('append.notes must be a non-empty string');
        expect(fs.existsSync(getStoryboardDir(storyId))).toBe(false);
    });

    it('should return 400 when the story to append to does not exist', async () => {
        const storyId = `test-append-unknown-${Date.now()}`;
        createdStoryIds.push(storyId);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { append: { chapterCount: 3 } }),
            { root: projectRoot }
        );

        expect(result.status).toBe(400);
        expect(result.response.error).toBe(`Story '${storyId}' not found`);
    });

    it('should return 400 with the exact reason when the story violates append preconditions', async () => {
        // Pre-seed storyboard/<storyId>/plotpoint.json in the temp root so the
        // handler's synchronous validation can be exercised WITHOUT triggering
        // any LLM call (each case must 400 before the background job starts).
        const seed = (id: string, meta: Record<string, unknown>) => {
            createdStoryIds.push(id);
            const dir = getStoryboardDir(id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'plotpoint.json'),
                JSON.stringify({ storyline: 'Seed', chapterCount: 3, createdAt: '2026-08-01T00:00:00Z', ...meta }, null, 2),
                'utf-8'
            );
        };

        const storyboardDir = (id: string) => getStoryboardDir(id);

        // Case 1: story without a continuation storyline.
        const noLine = `test-append-noline-${Date.now()}`;
        seed(noLine, { storyline: '', chapters: [{ number: '1', title: 'T', plotpoints: ['P'] }] });
        const r1 = await generationCreateNewStory(
            mockContext,
            createMockParameters(noLine, { append: { chapterCount: 1 } }),
            { root: projectRoot }
        );
        expect(r1.status).toBe(400);
        expect(r1.response.error).toBe(`Story '${noLine}' has no storyline to continue from`);

        // Case 2: story with no chapters to append after.
        const noChapters = `test-append-noch-${Date.now()}`;
        seed(noChapters, { chapters: [] });
        const r2 = await generationCreateNewStory(
            mockContext,
            createMockParameters(noChapters, { append: { chapterCount: 1 } }),
            { root: projectRoot }
        );
        expect(r2.status).toBe(400);
        expect(r2.response.error).toBe(`Story '${noChapters}' has no chapters to append to`);

        // Case 3: a chapter without plotpoints breaks the appending[] context.
        const noPlot = `test-append-noplot-${Date.now()}`;
        seed(noPlot, { chapters: [{ number: '1', title: 'T', plotpoints: [] }] });
        const r3 = await generationCreateNewStory(
            mockContext,
            createMockParameters(noPlot, { append: { chapterCount: 1 } }),
            { root: projectRoot }
        );
        expect(r3.status).toBe(400);
        expect(r3.response.error).toBe(`Story '${noPlot}' has a chapter without plotpoints`);

        // A 400 means NO background append ran — plotpoint.json bytes must be
        // exactly what was seeded (no rewrite with partial appends).
        for (const id of [noLine, noChapters, noPlot]) {
            const seeded = JSON.parse(fs.readFileSync(path.join(storyboardDir(id), 'plotpoint.json'), 'utf-8'));
            expect(seeded.chapterCount).toBe(3);
        }
    });

    it('should append plotline chapters after the current list, renumber, and keep the story metadata (plotpoints only)', async () => {
        const storyId = `test-append-success-${Date.now()}`;
        createdStoryIds.push(storyId);
        const chapterDir = path.join(getStoryboardDir(storyId), 'chapter');

        // Pin every clone to ONE instance so all LLM calls accumulate on a
        // single spy. The create step (initial 3-chapter plotline) and the
        // append step ('Continue the story' prompt) get distinct responses.
        const seenRequests: string[] = [];
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                seenRequests.push(request);
                // Chapter expansion is NEVER part of append/create (plotOnly) —
                // if one appears, the flow started expanding chapters.
                expect(request.includes('Expand the chapter')).toBe(false);
                // Append step: exactly chapterCount (3) NEW chapters.
                if (request.includes('Continue the story')) {
                    return Promise.resolve({
                        response: {
                            chapters: [
                                { number: '4', title: 'New Arc Begins', plotpoints: ['Plot E', 'Plot F'] },
                                { number: '5', title: 'The Split', plotpoints: ['Plot G'] },
                                { number: '6', title: 'Final Stand', plotpoints: ['Plot H', 'Plot I'] }
                            ]
                        }
                    });
                }
                // Initial plotline generation: the standard 3 chapters.
                return Promise.resolve({
                    response: {
                        chapters: [
                            { number: '1', title: 'Chapter One', plotpoints: ['Plot point A', 'Plot point B'] },
                            { number: '2', title: 'Chapter Two', plotpoints: ['Plot point C'] },
                            { number: '3', title: 'Chapter Three', plotpoints: ['Plot point D'] }
                        ]
                    }
                });
            })
        } as any);

        // Step 1: create the story (plotline-only, 3 chapters) and wait for completion.
        const createResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 3 }),
            { root: projectRoot }
        );
        expect(createResult.status).toBe(200);
        expect(createResult.response).toEqual({ storyId });

        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Step 2: append 3 chapters via the SAME storyId, with author notes.
        seenRequests.length = 0;
        const appendResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { append: { chapterCount: 3, notes: 'steer toward the final battle' } }),
            { root: projectRoot }
        );
        expect(appendResult.status).toBe(200);
        expect(appendResult.response).toEqual({ storyId, appended: 3 });

        // Step 3: wait for the background append to rewrite plotpoint.json
        // with the enlarged chapter list (3 existing + 3 appended = 6).
        await vi.waitFor(
            () => {
                const meta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
                expect(meta.chapterCount).toBe(6);
                expect(meta.chapters.length).toBe(6);
            },
            { timeout: 5000, interval: 10 }
        );

        // The append LLM call saw the continue-prompt AND the dialog's notes.
        const appendRequests = seenRequests.filter((r) => r.includes('Continue the story'));
        expect(appendRequests.length).toBe(1);
        expect(appendRequests[0]).toContain('steer toward the final battle');
        expect(appendRequests[0]).toContain('NEXT 3 new chapters');
        expect(appendRequests[0]).toContain('chapters 4 to 6');

        // Final plotpoint.json: the new chapters are stored AFTER the current
        // list, renumbered 4-6, and the story's metadata (storyline,
        // storyName, createdAt, completed status) survives the append.
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.storyId).toBe(storyId);
        expect(finalMeta.storyline).toBe(TEST_STORYLINE);
        expect(finalMeta.storyName).toBe(TEST_STORYLINE);
        expect(finalMeta.chapterCount).toBe(6);
        expect(finalMeta.status).toBe('completed');
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: ['Plot point A', 'Plot point B'] },
            { number: '2', title: 'Chapter Two', plotpoints: ['Plot point C'] },
            { number: '3', title: 'Chapter Three', plotpoints: ['Plot point D'] },
            { number: '4', title: 'New Arc Begins', plotpoints: ['Plot E', 'Plot F'] },
            { number: '5', title: 'The Split', plotpoints: ['Plot G'] },
            { number: '6', title: 'Final Stand', plotpoints: ['Plot H', 'Plot I'] }
        ]);

        // Append is PLOTPOINTS ONLY: six skeleton payloads, zero expanded .md
        // files (the create step was plotOnly and the append never expands).
        expect(fs.readdirSync(chapterDir).filter((f) => f.endsWith('.md'))).toEqual([]);
        expect(fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort()).toEqual([
            'chapter-001.json',
            'chapter-002.json',
            'chapter-003.json',
            'chapter-004.json',
            'chapter-005.json',
            'chapter-006.json'
        ]);

        // A NEW appended chapter's skeleton carries the full all-plotline
        // context (all 6 chapters) + its expand request — ready for an
        // individual PATCH expandChapterIndex later, with empty revisions.
        const newSkeleton = JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-004.json'), 'utf-8'));
        expect(newSkeleton).toEqual({
            storyId,
            storyline: TEST_STORYLINE,
            chapterCount: 6,
            chapterNumber: '4',
            chapterIndex: 3,
            // writeChapterPayload writes the generic `Chapter N` placeholder as
            // the skeleton title (same contract as the create flow — the LLM
            // title only lands in revisions after expansion); the stored
            // expand request does carry the real title.
            title: 'Chapter 4',
            plotpoints: ['Plot E', 'Plot F'],
            context: {
                appending: [
                    '> 1: Chapter One' + SUMMARY_SEP + '- Plot point A\n- Plot point B',
                    '> 2: Chapter Two' + SUMMARY_SEP + '- Plot point C',
                    '> 3: Chapter Three' + SUMMARY_SEP + '- Plot point D',
                    '> 4: New Arc Begins' + SUMMARY_SEP + '- Plot E\n- Plot F',
                    '> 5: The Split' + SUMMARY_SEP + '- Plot G',
                    '> 6: Final Stand' + SUMMARY_SEP + '- Plot H\n- Plot I'
                ],
                request: buildExpandRequest('4', 'New Arc Begins')
            },
            config: {
                systemInstructions: 'test instructions',
                openingMessage: 'test opening'
            },
            revisions: []
        });

        // plotpoint.md grows by the appended entries (markdown debugging file).
        const md = fs.readFileSync(path.join(getStoryboardDir(storyId), 'plotpoint.md'), 'utf-8');
        expect(md).toContain('> 4: New Arc Begins');
        expect(md).toContain('- Plot H');
    }, 30000);
});
