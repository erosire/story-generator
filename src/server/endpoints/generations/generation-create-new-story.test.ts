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
                // Progressive plotline generation (generation-create-new-story.ts):
                // ONE chapter per structured call. The request names the chapter
                // as "(chapter N of M)" — resolve N to a deterministic fixture so
                // retries of the same chapter re-serve identical data. The
                // schema no longer asks the model for a chapter number — the
                // server assigns it by position — so fixtures omit `number`.
                // Every fixture carries exactly the mocked
                // MIN_PLOTPOINTS_PER_CHAPTER (10) plotpoints via the hoisted
                // plotpointsFor() helper — fewer would trip the per-chapter
                // minimum-count validation and exhaust the retry budget instead
                // of completing.
                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
                const chapterFixtures = [
                    { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
                    { title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') },
                    { title: 'Chapter Three', plotpoints: plotpointsFor('Plot point C') }
                ];
                return Promise.resolve({ response: chapterFixtures[chapterIndex] ?? chapterFixtures[0] });
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
        MAX_EXPAND_ATTEMPTS: 10,
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

// Generate `count` deterministic plotpoints sharing one label. The mocked
// MIN_PLOTPOINTS_PER_CHAPTER is 10 (mirrors production generation-config.ts:58),
// so every plotline fixture must carry >= 10 plotpoints to pass the
// per-chapter minimum-count validation (generation-create-new-story.ts) on its
// first attempt — fewer is retried as an invalid response.
// Declared as a function (fully hoisted) so the vi.mock factory above can call it.
function plotpointsFor(label: string, count = 10): string[] {
    return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
}

// Exact bullet rendering used by the production summary/context writer
// (generation-create-new-story.ts): plotpoints.map((plot) => `- ${plot}`).join('\n').
// Declared as a function for the same hoisting reason as plotpointsFor.
function bulletList(points: string[]): string {
    return points.map((point) => `- ${point}`).join('\n');
}

// Exact per-chapter plotline request text (mirrors the request builder in
// generation-create-new-story.ts; the mocked MIN_PLOTPOINTS_PER_CHAPTER = 10).
// Every retry of a chapter re-issues this byte-identical payload — no
// escalation instructions are ever added to it.
const basePlotRequest = (label: number, count: number) =>
    [
        `> Submit me the detailed plotpoints of the next chapter (chapter ${label} of ${count})`,
        '> The plotpoint must includes all the important dialogues happens in the chapter',
        '> There must be at least 10 plotpoints for the chapter',
        '> Must clearly outlines how the chapter starts, and how the chapter ends with the first and last plotpoints only',
        '> Do not include plotpoints or events that belong to any other chapter'
    ].join('\n');

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
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') },
            { number: '3', title: 'Chapter Three', plotpoints: plotpointsFor('Plot point C') }
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
            plotpoints: plotpointsFor('Plot point A'),
            context: {
                // All-plotline summaries — exactly what the first expansion of
                // chapter 1 will see in context (no expanded prose exists yet).
                appending: [
                    '> 1: Chapter One' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point A')),
                    '> 2: Chapter Two' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point B')),
                    '> 3: Chapter Three' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point C'))
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
    //
    // The plotline itself is generated PROGRESSIVELY: one structured call per
    // chapter with each accepted chapter kept in the conversation as a tool
    // call (generation-create-new-story.ts, "Progressive per-chapter plotpoint
    // generation").
    it('should generate the plotline only: one LLM call per chapter, skeleton payloads, no expansion', async () => {
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
                // Progressive plotline: exactly ONE chapter per call — the
                // request names it as "(chapter N of M)". Serve a valid
                // chapter for each — 2 chapters matches chapterCount below.
                // No `number` in the response: the server assigns it.
                const idx = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1');
                return Promise.resolve({
                    response:
                        idx === 2
                            ? { title: 'Chapter Two', plotpoints: plotpointsFor('Plot B') }
                            : { title: 'Chapter One', plotpoints: plotpointsFor('Plot A') }
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

        // Exactly TWO LLM calls — one progressive plotline request per chapter
        // (exact prompt text asserted). No chapter expansion request
        // (buildExpandRequest prompts) may have been attempted by this request.
        expect(seenRequests).toEqual([basePlotRequest(1, 2), basePlotRequest(2, 2)]);

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
            plotpoints: plotpointsFor('Plot B'),
            context: {
                appending: [
                    '> 1: Chapter One' + SUMMARY_SEP + bulletList(plotpointsFor('Plot A')),
                    '> 2: Chapter Two' + SUMMARY_SEP + bulletList(plotpointsFor('Plot B'))
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
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot B') }
        ]);
    });

    // ── Agentic plotline chain ────────────────────────────────────────────
    // The progressive plotline generation must not only call the LLM once per
    // chapter — it must also keep every accepted chapter in the conversation
    // as a sequential tool call, so the request for chapter N sees the tool
    // calls that produced chapters 1..N-1 (generation-create-new-story.ts,
    // "Agentic chain step"). This test records every user/assistant message
    // pushed to the client and asserts the FULL exact exchange sequence.
    it('should chain chapter plotpoints as sequential tool calls in the conversation history (agentic)', async () => {
        const storyId = `test-story-agentic-${Date.now()}`;
        createdStoryIds.push(storyId);

        const chapterFixtures = [
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') },
            { number: '3', title: 'Chapter Three', plotpoints: plotpointsFor('Plot point C') }
        ];

        const exchanges: Array<[string, string]> = [];
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn((content: string) => {
                exchanges.push(['user', content]);
            }),
            assistant: vi.fn((content: string) => {
                exchanges.push(['assistant', content]);
            }),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                const idx = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
                // The schema no longer asks the model for a chapter number —
                // respond with only title/plotpoints; the server assigns the
                // number by position (which lands in the tool-call message).
                const { title, plotpoints } = chapterFixtures[idx] ?? chapterFixtures[0];
                return Promise.resolve({ response: { title, plotpoints } });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 3 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Exact tool-call message committed after each accepted chapter —
        // mirrors the 'respond' tool convention (simple-client.ts:1025).
        const toolCallMessage = (label: number, chapter: (typeof chapterFixtures)[number]) =>
            JSON.stringify({
                tool_calls: [
                    {
                        id: `call_plotpoint_chapter_${label}`,
                        type: 'function',
                        function: { name: 'respond', arguments: JSON.stringify(chapter) }
                    }
                ]
            });

        // Full exact exchange sequence: client priming (createStoryClient +
        // STORY_REQUEST_MESSAGE/storyline), then per chapter the committed
        // request followed by the chapter's tool call.
        expect(exchanges).toEqual([
            ['user', 'Hey ENI'],
            ['assistant', 'test opening'],
            ['user', 'You know the story I like'],
            ['assistant', TEST_STORYLINE],
            ['user', basePlotRequest(1, 3)],
            ['assistant', toolCallMessage(1, chapterFixtures[0])],
            ['user', basePlotRequest(2, 3)],
            ['assistant', toolCallMessage(2, chapterFixtures[1])],
            ['user', basePlotRequest(3, 3)],
            ['assistant', toolCallMessage(3, chapterFixtures[2])]
        ]);
    }, 30000);

    it('should fail in place with byte-identical retries when the chapter call keeps rejecting', async () => {
        // Exception-path retry: EVERY attempt of the failing chapter re-issues
        // the identical payload (no escalation, no "you were wrong" hints),
        // and NO [retry N] story entry is ever created — that chain only
        // existed for the removed one-shot outline flow.
        const storyId = `test-story-failinplace-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

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
                // A plotline-only story must NEVER send an expansion request.
                expect(request.includes('Expand the chapter')).toBe(false);
                return Promise.reject(new Error('plot exploded'));
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 1 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('failed');
            },
            { timeout: 5000, interval: 10 }
        );

        // The failing chapter was retried in place: 1 initial +
        // MAX_PLOT_ATTEMPTS(3) — EVERY attempt issued the byte-identical
        // request (no strict/CRITICAL escalation lines ever appear).
        expect(seenRequests).toEqual([
            basePlotRequest(1, 1),
            basePlotRequest(1, 1),
            basePlotRequest(1, 1),
            basePlotRequest(1, 1)
        ]);

        // The failure is recorded with the plot error.
        expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'))).toMatchObject({
            storyId,
            status: 'failed',
            validation: { valid: false, reason: 'plot exploded' }
        });

        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should retry a failing chapter with the byte-identical payload and complete once it succeeds', async () => {
        // The core of the in-place retry: chapter 2 fails validation twice
        // (empty plotpoints), then succeeds on the third attempt. All three
        // chapter-2 requests must be byte-identical — the model gets another
        // attempt without the server telling it that it was wrong.
        const storyId = `test-story-chapter-retry-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

        const seenRequests: string[] = [];
        let chapter2Calls = 0;
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                seenRequests.push(request);

                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
                if (chapterIndex === 1) {
                    chapter2Calls++;
                    // Attempts 1-2: usable structure but no plotpoints — 0 is
                    // below the mocked 10-plotpoint minimum, so the count
                    // validation rejects them.
                    if (chapter2Calls <= 2) {
                        return Promise.resolve({ response: { title: 'Chapter Two', plotpoints: [] } });
                    }
                    // Attempt 3: valid chapter — the story completes.
                    return Promise.resolve({ response: { title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') } });
                }
                return Promise.resolve({ response: { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') } });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Chapter 2's three attempts are byte-identical re-issues of the same
        // payload — no escalation lines, no "your previous answer was wrong".
        expect(seenRequests).toEqual([
            basePlotRequest(1, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2)
        ]);

        // The story completes once the chapter succeeds; the validation record
        // counts the 2 in-place retries chapter 2 consumed.
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.validation).toEqual({ valid: true, reason: 'plotline complete', attempt: 2 });
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') }
        ]);

        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should retry a chapter below MIN_PLOTPOINTS_PER_CHAPTER and accept one with more than the minimum', async () => {
        // The minimum-count validation (generation-create-new-story.ts): a
        // NON-EMPTY chapter with fewer than the mocked minimum (10) plotpoints
        // fails validation and retries the byte-identical payload — while a
        // chapter with MORE than the minimum is accepted.
        const storyId = `test-story-min-plotpoints-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

        const seenRequests: string[] = [];
        let chapter2Calls = 0;
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                seenRequests.push(request);

                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
                if (chapterIndex === 1) {
                    chapter2Calls++;
                    // Attempts 1-2: non-empty but BELOW the 10-plotpoint
                    // minimum — each consumes an in-place retry.
                    if (chapter2Calls <= 2) {
                        return Promise.resolve({ response: { title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B', 4) } });
                    }
                    // Attempt 3: MORE than the minimum (12 > 10) — accepted.
                    return Promise.resolve({ response: { title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B', 12) } });
                }
                return Promise.resolve({ response: { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') } });
            })
        } as any);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);

        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Chapter 2's three attempts are byte-identical re-issues of the same
        // payload — the below-minimum signal never enters the request text.
        expect(seenRequests).toEqual([
            basePlotRequest(1, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2)
        ]);

        // The accepted chapter keeps ALL 12 plotpoints — more than the minimum
        // is fine; the two below-minimum attempts count as retries.
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.validation).toEqual({ valid: true, reason: 'plotline complete', attempt: 2 });
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B', 12) }
        ]);

        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should mark current story as failed in place (no retry entry) when a chapter keeps failing validation', async () => {
        const storyId = `test-story-validation-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

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

                // Chapter expansion calls — always succeed
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Expanded Chapter',
                            content: 'This is the expanded content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                // Progressive plotline calls: ONE chapter per call, named by
                // "(chapter N of M)" in the request.
                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;

                // Chapter 1 succeeds on its first call; chapter 2 answers EVERY
                // attempt with a refusal plotpoint — 1 initial +
                // MAX_PLOT_ATTEMPTS(3) retries = 4 calls of the identical
                // payload, then the story fails in place. Refusals are checked
                // BEFORE the minimum-count validation, so this 1-item refusing
                // response still reports the refusal reason (not a count
                // failure).
                // (No `number` in responses — the server assigns it.)
                if (chapterIndex === 1) {
                    return Promise.resolve({
                        response: { title: 'Chapter Two', plotpoints: ['I cannot fulfill this request.'] }
                    });
                }
                return Promise.resolve({
                    response: { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') }
                });
            })
        } as any);

        const parameters = createMockParameters(storyId, {
            storyline: TEST_STORYLINE,
            chapterCount: 3
        });

        const result = await generationCreateNewStory(mockContext, parameters, { root: projectRoot });
        expect(result.status).toBe(200);

        // Deterministic failure signal: markStoryFailed writes 'failed'.
        const plotpointJsonPath = path.join(getStoryboardDir(storyId), 'plotpoint.json');
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('failed');
            },
            { timeout: 5000, interval: 10 }
        );

        // 5 calls total: 1 accepted (chapter 1) + 4 identical chapter-2
        // attempts — every retry re-issued the byte-identical payload.
        expect(seenRequests).toEqual([
            basePlotRequest(1, 3),
            basePlotRequest(2, 3),
            basePlotRequest(2, 3),
            basePlotRequest(2, 3),
            basePlotRequest(2, 3)
        ]);

        // Verify the story was marked as failed with the refusal reason
        const originalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(originalMeta.status).toBe('failed');
        expect(originalMeta.validation.valid).toBe(false);
        expect(originalMeta.validation.reason).toContain('refusal phrase');
        // 3 retry attempts were consumed by chapter 2 before giving up.
        expect(originalMeta.validation.attempt).toBe(3);

        // The accepted chapter and the broken chapter are both preserved.
        expect(originalMeta.chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: ['I cannot fulfill this request.'] }
        ]);

        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should never create retry entries, even across consecutive failing stories', async () => {
        // Two independent stories both fail (every chapter refuses). Neither
        // may spawn a -retry-N entry — the storyboard directory must contain
        // exactly the two requested story entries.
        const storyA = `test-story-chain-a-${Date.now()}`;
        const storyB = `test-story-chain-b-${Date.now()}`;
        createdStoryIds.push(storyA, storyB);

        vi.mocked(CLIENT.clone).mockImplementation((): any => ({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                const request = typeof config?.request === 'string' ? config.request : '';
                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Expanded Chapter',
                            content: 'This is expanded content. ' + 'word '.repeat(3500)
                        }
                    });
                }
                // Every plotpoint call refuses — chapter 1 of both stories
                // exhausts its per-chapter retry budget (4 calls each).
                return Promise.resolve({
                    response: { title: 'Chapter One', plotpoints: ['I cannot fulfill this request.'] }
                });
            })
        }));

        for (const storyId of [storyA, storyB]) {
            const result = await generationCreateNewStory(
                mockContext,
                createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 3 }),
                { root: projectRoot }
            );
            expect(result.status).toBe(200);
        }

        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(path.join(getStoryboardDir(storyA), 'plotpoint.json'), 'utf-8')).status).toBe('failed');
                expect(JSON.parse(fs.readFileSync(path.join(getStoryboardDir(storyB), 'plotpoint.json'), 'utf-8')).status).toBe('failed');
            },
            { timeout: 5000, interval: 10 }
        );

        // The storyboard directory contains exactly the two story entries —
        // failure never spawns -retry-N directories.
        const entries = fs
            .readdirSync(path.join(projectRoot, DATABASE_BASE_DIR))
            .filter((id) => id.includes('-retry-'));
        expect(entries).toEqual([]);
    }, 30000);

    it('should fail in place preserving chapters when a chapter never supplies plotpoints', async () => {
        const storyId = `test-story-outline-failure-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

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

                if (request.includes('Expand the chapter')) {
                    return Promise.resolve({
                        response: {
                            title: 'Recovered Chapter',
                            content: 'Recovered chapter content. ' + 'word '.repeat(3500)
                        }
                    });
                }

                // Progressive plotline calls: ONE chapter per call, named by
                // "(chapter N of M)" in the request.
                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;

                // Chapter 1 succeeds; chapter 2 never supplies plotpoints —
                // 0 is below the mocked 10-plotpoint minimum, so the count
                // validation retries its identical payload until the budget
                // exhausts.
                if (chapterIndex === 1) {
                    return Promise.resolve({
                        response: { title: 'Chapter Two', plotpoints: [] }
                    });
                }
                return Promise.resolve({
                    response: { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') }
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
            },
            { timeout: 5000, interval: 10 }
        );

        // 1 accepted chapter-1 call + 4 identical chapter-2 attempts.
        expect(seenRequests).toEqual([
            basePlotRequest(1, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2),
            basePlotRequest(2, 2)
        ]);

        // The accepted chapter and the broken chapter are both preserved.
        expect(JSON.parse(fs.readFileSync(originalPlotpointPath, 'utf-8')).chapters).toEqual([
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: [] }
        ]);

        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should keep a failed story immutable when a late plot stream callback arrives', async () => {
        const storyId = `test-story-late-failure-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

        let formatCalls = 0;
        let latePlotUpdate: ((update: string) => Promise<void>) | undefined;

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation((config: any) => {
                formatCalls++;

                if (formatCalls === 1) {
                    // Capture the wrapped callback and reject the initial plot
                    // request. Calling it after failure simulates a late SSE
                    // update from a request that could not be cancelled.
                    latePlotUpdate = config?.onUpdate;
                }
                // Every attempt of the single chapter rejects — the story
                // fails in place after the retry budget is exhausted.
                return Promise.reject(new Error('Initial plot request failed'));
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
        // status="generating" and partial chapters after failure was committed.
        // Progressive plotpoint streaming sends ONE chapter object per call.
        await latePlotUpdate!(JSON.stringify({ number: '1', title: 'Late', plotpoints: ['Late'] }));

        expect(fs.readFileSync(originalPlotpointPath, 'utf-8')).toBe(failedSnapshot);
        // No [retry N] story entry may have been spawned.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
    }, 30000);

    it('should keep the failed story unchanged when the same story request is submitted again', async () => {
        const storyId = `test-story-duplicate-request-${Date.now()}`;
        createdStoryIds.push(storyId, `${storyId}-retry-1`); // retry dir must NOT appear

        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => {
                // Every attempt of the single chapter rejects — the story
                // fails in place after its retry budget is exhausted.
                return Promise.reject(new Error('Initial plot request failed'));
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
        // Neither the failure nor the duplicate may spawn a [retry N] entry.
        expect(fs.existsSync(getStoryboardDir(`${storyId}-retry-1`))).toBe(false);
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
                // Initial plotline generation: progressive, ONE chapter per
                // call — the request names it as "(chapter N of M)".
                // (No `number` in responses — the server assigns it.)
                const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
                const initial = [
                    { title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
                    { title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') },
                    { title: 'Chapter Three', plotpoints: plotpointsFor('Plot point C') }
                ];
                return Promise.resolve({ response: initial[chapterIndex] ?? initial[0] });
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
            { number: '1', title: 'Chapter One', plotpoints: plotpointsFor('Plot point A') },
            { number: '2', title: 'Chapter Two', plotpoints: plotpointsFor('Plot point B') },
            { number: '3', title: 'Chapter Three', plotpoints: plotpointsFor('Plot point C') },
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
                    '> 1: Chapter One' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point A')),
                    '> 2: Chapter Two' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point B')),
                    '> 3: Chapter Three' + SUMMARY_SEP + bulletList(plotpointsFor('Plot point C')),
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

    // ── Resume request (the dashboard's ▶ resume action) ──────────────────
    // POST { resume: { chapterCount? } } against an EXISTING storyId continues
    // an interrupted plotline generation: the complete prefix of chapters is
    // kept, everything from the first incomplete chapter onward (a partially
    // streamed / failed tail) is regenerated per-chapter up to the target,
    // and skeleton chapter payloads are written only for chapters missing
    // one. See generation-resume-story.ts.

    // Seed a storyboard/<storyId>/plotpoint.json in the interrupted state
    // (partial chapters, status 'generating' or 'failed', createdAt kept).
    const seedInterruptedStory = (
        id: string,
        meta: Record<string, unknown>,
        chapterPayloads: Record<number, Record<string, unknown>> = {}
    ) => {
        createdStoryIds.push(id);
        const dir = getStoryboardDir(id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'plotpoint.json'),
            JSON.stringify(
                {
                    storyline: TEST_STORYLINE,
                    chapterCount: 3,
                    createdAt: '2026-08-01T00:00:00Z',
                    chapters: [],
                    status: 'generating',
                    ...meta
                },
                null,
                2
            ),
            'utf-8'
        );
        const chapterDir = path.join(dir, 'chapter');
        fs.mkdirSync(chapterDir, { recursive: true });
        for (const [index, payload] of Object.entries(chapterPayloads)) {
            const padded = String(Number(index) + 1).padStart(3, '0');
            fs.writeFileSync(path.join(chapterDir, `chapter-${padded}.json`), JSON.stringify(payload, null, 2), 'utf-8');
        }
        return { dir, plotpointJsonPath: path.join(dir, 'plotpoint.json'), chapterDir };
    };

    // Pin every clone to ONE instance whose format() answers per-chapter
    // resume requests: the request names the chapter as "(chapter N of M)"
    // and fixtures map N to deterministic titles/plotpoints (10 each so the
    // minimum-count validation passes on the first attempt).
    const pinResumeClient = (overrides: Record<number, { title: string; plotpoints: string[] }> = {}) => {
        const seenRequests: string[] = [];
        const assistantMessages: string[] = [];
        const format = vi.fn().mockImplementation((config: any) => {
            const request = typeof config?.request === 'string' ? config.request : '';
            seenRequests.push(request);
            const chapterIndex = Number(request.match(/chapter (\d+) of \d+/)?.[1] ?? '1') - 1;
            const fixture = overrides[chapterIndex] ?? {
                title: `Resumed Chapter ${chapterIndex + 1}`,
                plotpoints: plotpointsFor(`Resumed plot ${chapterIndex + 1}`)
            };
            return Promise.resolve({ response: fixture });
        });
        const assistant = vi.fn().mockImplementation((message: string) => {
            assistantMessages.push(String(message));
        });
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant,
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format,
            structure: vi.fn().mockResolvedValue({ response: {} })
        } as any);
        return { seenRequests, assistantMessages, format };
    };

    it('should return 400 when resume.chapterCount is not a positive number', async () => {
        const storyId = `test-resume-bad-count-${Date.now()}`;
        createdStoryIds.push(storyId);

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { resume: { chapterCount: 0 } }),
            { root: projectRoot }
        );

        expect(result.status).toBe(400);
        expect(result.response.error).toBe('resume.chapterCount must be a positive number');
        // Validation fails before any background job — no story dir may exist.
        expect(fs.existsSync(getStoryboardDir(storyId))).toBe(false);
    });

    it('should return 400 when the story to resume does not exist', async () => {
        const storyId = `test-resume-unknown-${Date.now()}`;
        createdStoryIds.push(storyId);

        const result = await generationCreateNewStory(mockContext, createMockParameters(storyId, { resume: {} }), {
            root: projectRoot
        });

        expect(result.status).toBe(400);
        expect(result.response.error).toBe(`Story '${storyId}' not found`);
    });

    it('should return 400 with the exact reason when the story violates resume preconditions', async () => {
        // Case 1: story without a storyline to resume from.
        const noLine = `test-resume-noline-${Date.now()}`;
        createdStoryIds.push(noLine);
        fs.mkdirSync(getStoryboardDir(noLine), { recursive: true });
        fs.writeFileSync(
            path.join(getStoryboardDir(noLine), 'plotpoint.json'),
            JSON.stringify({ storyline: '', chapterCount: 3, chapters: [], createdAt: '2026-08-01T00:00:00Z' }, null, 2),
            'utf-8'
        );
        const r1 = await generationCreateNewStory(mockContext, createMockParameters(noLine, { resume: {} }), {
            root: projectRoot
        });
        expect(r1.status).toBe(400);
        expect(r1.response.error).toBe(`Story '${noLine}' has no storyline to resume from`);

        // Case 2: plotline already complete — nothing to resume.
        const complete = `test-resume-complete-${Date.now()}`;
        createdStoryIds.push(complete);
        fs.mkdirSync(getStoryboardDir(complete), { recursive: true });
        fs.writeFileSync(
            path.join(getStoryboardDir(complete), 'plotpoint.json'),
            JSON.stringify(
                {
                    storyline: 'Seed',
                    chapterCount: 1,
                    createdAt: '2026-08-01T00:00:00Z',
                    chapters: [{ number: '1', title: 'Done', plotpoints: plotpointsFor('Done plot') }],
                    status: 'completed'
                },
                null,
                2
            ),
            'utf-8'
        );
        const r2 = await generationCreateNewStory(mockContext, createMockParameters(complete, { resume: {} }), {
            root: projectRoot
        });
        expect(r2.status).toBe(400);
        expect(r2.response.error).toBe(`Story '${complete}' plotline generation is already complete (1/1 chapters)`);

        // Both 400s mean NO background resume ran — plotpoint.json bytes must
        // be exactly what was seeded in each story.
        const seededNoLine = JSON.parse(fs.readFileSync(path.join(getStoryboardDir(noLine), 'plotpoint.json'), 'utf-8'));
        expect(seededNoLine.chapters).toEqual([]);
        const seededComplete = JSON.parse(fs.readFileSync(path.join(getStoryboardDir(complete), 'plotpoint.json'), 'utf-8'));
        expect(seededComplete.status).toBe('completed');
    });

    it('should resume an interrupted story: keep the complete prefix, regenerate the tail per-chapter, write skeletons', async () => {
        const storyId = `test-resume-success-${Date.now()}`;
        // Interrupted create: chapter 1 complete (10 plotpoints), chapter 2
        // partially streamed (4 plotpoints — below the mocked minimum of 10),
        // chapter 3 never reached. status 'generating' is frozen by the dead
        // background job. NO chapter payloads exist (plotOnly writes them only
        // at full completion).
        const originalChapter1 = { number: '1', title: 'Original Opening', plotpoints: plotpointsFor('Original A') };
        const partialChapter2 = { number: '2', title: 'Half-Streamed', plotpoints: plotpointsFor('Partial B', 4) };
        const { plotpointJsonPath, chapterDir } = seedInterruptedStory(storyId, {
            storyId,
            storyName: 'Resumed Tale',
            chapterCount: 3,
            status: 'generating',
            chapters: [originalChapter1, partialChapter2]
        });

        const { seenRequests, format } = pinResumeClient();

        const result = await generationCreateNewStory(mockContext, createMockParameters(storyId, { resume: {} }), {
            root: projectRoot
        });
        // Chapter 1 is complete; chapters 2+3 are regenerated → 2 remaining.
        expect(result.status).toBe(200);
        expect(result.response).toEqual({ storyId, resumed: 2, chapterCount: 3 });

        // Wait for the background resume to reach its terminal write.
        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Exactly two per-chapter calls: chapter 2 and chapter 3 — chapter 1
        // was complete and must NOT be regenerated.
        expect(format).toHaveBeenCalledTimes(2);
        expect(seenRequests).toEqual([basePlotRequest(2, 3), basePlotRequest(3, 3)]);

        // Final outline: the original chapter 1 verbatim + regenerated 2/3.
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.storyId).toBe(storyId);
        expect(finalMeta.storyName).toBe('Resumed Tale');
        expect(finalMeta.storyline).toBe(TEST_STORYLINE);
        expect(finalMeta.createdAt).toBe('2026-08-01T00:00:00Z');
        expect(finalMeta.chapterCount).toBe(3);
        expect(finalMeta.status).toBe('completed');
        expect(finalMeta.validation).toEqual({ valid: true, reason: 'plotline complete (resumed)', attempt: 0 });
        expect(finalMeta.chapters).toEqual([
            originalChapter1,
            { number: '2', title: 'Resumed Chapter 2', plotpoints: plotpointsFor('Resumed plot 2') },
            { number: '3', title: 'Resumed Chapter 3', plotpoints: plotpointsFor('Resumed plot 3') }
        ]);

        // Skeleton payloads for ALL three chapters (the interrupted create had
        // none) — each expandable via PATCH expandChapterIndex afterwards.
        expect(fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort()).toEqual([
            'chapter-001.json',
            'chapter-002.json',
            'chapter-003.json'
        ]);
        const skeleton = JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8'));
        expect(skeleton).toEqual({
            storyId,
            storyline: TEST_STORYLINE,
            chapterCount: 3,
            chapterNumber: '1',
            chapterIndex: 0,
            // writeChapterPayload writes the generic placeholder title (the LLM
            // title lives only in the expand request — same contract as create).
            title: 'Chapter 1',
            plotpoints: originalChapter1.plotpoints,
            context: {
                appending: [
                    '> 1: Original Opening' + SUMMARY_SEP + bulletList(plotpointsFor('Original A')),
                    '> 2: Resumed Chapter 2' + SUMMARY_SEP + bulletList(plotpointsFor('Resumed plot 2')),
                    '> 3: Resumed Chapter 3' + SUMMARY_SEP + bulletList(plotpointsFor('Resumed plot 3'))
                ],
                request: buildExpandRequest('1', 'Original Opening')
            },
            config: {
                systemInstructions: 'test instructions',
                openingMessage: 'test opening'
            },
            revisions: []
        });
    }, 30000);

    it('should resume a failed story: the refusal-marked tail chapter fails completeness and is regenerated', async () => {
        const storyId = `test-resume-failed-${Date.now()}`;
        // markStoryFailed state: chapter 1 accepted; chapter 2 broke its retry
        // budget with a REFUSAL — 10 plotpoints passes the count check alone,
        // so only the refusal screen keeps it incomplete (create-parity).
        const refusalChapter = {
            number: '2',
            title: 'Refused Chapter',
            plotpoints: [...plotpointsFor('Refusal B', 9), 'I cannot fulfill this request']
        };
        const { plotpointJsonPath } = seedInterruptedStory(storyId, {
            storyId,
            chapterCount: 2,
            status: 'failed',
            validation: { valid: false, reason: 'chapter 2 contains refusal phrase', attempt: 3 },
            chapters: [{ number: '1', title: 'Kept Opening', plotpoints: plotpointsFor('Kept A') }, refusalChapter]
        });

        const { seenRequests } = pinResumeClient();

        const result = await generationCreateNewStory(mockContext, createMockParameters(storyId, { resume: {} }), {
            root: projectRoot
        });
        // Only the refused tail chapter is regenerated.
        expect(result.status).toBe(200);
        expect(result.response).toEqual({ storyId, resumed: 1, chapterCount: 2 });

        await vi.waitFor(
            () => {
                expect(JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8')).status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // One per-chapter call (chapter 2 only), and the failure state is gone.
        expect(seenRequests).toEqual([basePlotRequest(2, 2)]);
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.status).toBe('completed');
        expect(finalMeta.validation).toEqual({ valid: true, reason: 'plotline complete (resumed)', attempt: 0 });
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Kept Opening', plotpoints: plotpointsFor('Kept A') },
            { number: '2', title: 'Resumed Chapter 2', plotpoints: plotpointsFor('Resumed plot 2') }
        ]);
    }, 30000);

    it('should honor a raised resume.chapterCount (interrupted-append case) and never overwrite existing chapter payloads', async () => {
        const storyId = `test-resume-extend-${Date.now()}`;
        // A COMPLETED 2-chapter story (status 'completed') — normally nothing
        // to resume. The client still remembers an interrupted append target
        // of 4, so it POSTs resume.chapterCount = 4. Chapter 1 already has an
        // EXPANDED payload whose revisions must survive the resume.
        const expandedPayload = {
            storyId,
            storyline: TEST_STORYLINE,
            chapterCount: 2,
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Chapter 1',
            plotpoints: plotpointsFor('Kept A'),
            context: { appending: ['> 1: Kept Opening'], request: buildExpandRequest('1', 'Kept Opening') },
            config: { systemInstructions: 'x', openingMessage: 'y' },
            revisions: [{ content: 'Expanded prose body', wordCount: 4000, generationTimeMs: 5000 }]
        };
        const { plotpointJsonPath, chapterDir } = seedInterruptedStory(
            storyId,
            {
                storyId,
                chapterCount: 2,
                status: 'completed',
                chapterCompleted: 1,
                chapters: [
                    { number: '1', title: 'Kept Opening', plotpoints: plotpointsFor('Kept A') },
                    { number: '2', title: 'Kept Middle', plotpoints: plotpointsFor('Kept B') }
                ]
            },
            { 0: expandedPayload }
        );

        const { seenRequests, assistantMessages } = pinResumeClient();

        const result = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { resume: { chapterCount: 4 } }),
            { root: projectRoot }
        );
        expect(result.status).toBe(200);
        expect(result.response).toEqual({ storyId, resumed: 2, chapterCount: 4 });

        await vi.waitFor(
            () => {
                const meta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
                expect(meta.chapterCount).toBe(4);
                expect(meta.status).toBe('completed');
            },
            { timeout: 5000, interval: 10 }
        );

        // Chapters 3+4 generated as "(chapter 3 of 4)" / "(chapter 4 of 4)".
        expect(seenRequests).toEqual([basePlotRequest(3, 4), basePlotRequest(4, 4)]);

        // The priming pass saw chapter 1's EXPANDED PROSE (its latest revision
        // replaces the plotpoint summary in the committed assistant context).
        expect(assistantMessages.some((m) => m.includes('Expanded prose body'))).toBe(true);

        // Final state: 4 chapters, count raised, chapterCompleted preserved.
        const finalMeta = JSON.parse(fs.readFileSync(plotpointJsonPath, 'utf-8'));
        expect(finalMeta.chapterCount).toBe(4);
        expect(finalMeta.chapterCompleted).toBe(1);
        expect(finalMeta.chapters).toEqual([
            { number: '1', title: 'Kept Opening', plotpoints: plotpointsFor('Kept A') },
            { number: '2', title: 'Kept Middle', plotpoints: plotpointsFor('Kept B') },
            { number: '3', title: 'Resumed Chapter 3', plotpoints: plotpointsFor('Resumed plot 3') },
            { number: '4', title: 'Resumed Chapter 4', plotpoints: plotpointsFor('Resumed plot 4') }
        ]);

        // Chapter 1's expanded payload is byte-identical — skeleton writes are
        // create-if-missing so expanded revisions[] survive a resume.
        const preserved = JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8'));
        expect(preserved).toEqual(expandedPayload);

        // Chapters 2-4 gained skeleton payloads (2-4 had none).
        expect(fs.readdirSync(chapterDir).filter((f) => f.endsWith('.json')).sort()).toEqual([
            'chapter-001.json',
            'chapter-002.json',
            'chapter-003.json',
            'chapter-004.json'
        ]);
    }, 30000);

    it('should reject resume with 400 while another generation job is in flight for the same story', async () => {
        const storyId = `test-resume-locked-${Date.now()}`;
        createdStoryIds.push(storyId);

        // A create whose LLM call never resolves — the job stays in flight
        // (the registry slot stays taken) for the whole test.
        vi.mocked(CLIENT.clone).mockReturnValue({
            system: vi.fn(),
            user: vi.fn(),
            assistant: vi.fn(),
            clone: vi.fn().mockReturnThis(),
            messages: [],
            format: vi.fn().mockImplementation(() => new Promise(() => {})),
            structure: vi.fn().mockImplementation(() => new Promise(() => {}))
        } as any);

        const createResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(createResult.status).toBe(200);

        // The dir + placeholder exist synchronously (generateStory runs to its
        // first await), so resume validation passes — the 400 must come from
        // the job registry, not from story validation.
        const resumeResult = await generationCreateNewStory(mockContext, createMockParameters(storyId, { resume: {} }), {
            root: projectRoot
        });
        expect(resumeResult.status).toBe(400);
        expect(resumeResult.response.error).toBe(`Story '${storyId}' already has a generation job in progress`);

        // A duplicate create for the same in-flight storyId is rejected the
        // same way (previously it crashed in the background at mkdir).
        const duplicateResult = await generationCreateNewStory(
            mockContext,
            createMockParameters(storyId, { storyline: TEST_STORYLINE, chapterCount: 2 }),
            { root: projectRoot }
        );
        expect(duplicateResult.status).toBe(400);
        expect(duplicateResult.response.error).toBe(`Story '${storyId}' already has a generation job in progress`);

        // The in-flight placeholder was never disturbed by the rejected calls.
        const placeholder = JSON.parse(fs.readFileSync(path.join(getStoryboardDir(storyId), 'plotpoint.json'), 'utf-8'));
        expect(placeholder.status).toBe('generating');
        expect(placeholder.chapters).toEqual([]);
    }, 30000);
});
