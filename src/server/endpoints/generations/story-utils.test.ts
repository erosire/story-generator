/**
 * @vitest-environment node
 * story-utils imports @runtime/secret/private (via generation-config) which
 * transitively imports OpenAI SDK — that SDK throws in jsdom environments.
 *
 * Tests for expandChapter's RETRY BUDGET (the infinite-retry bug fix) and
 * its TERMINATION + ROLLBACK contract (the chain-of-broken-chapters fix).
 *
 * expandChapter (src/server/endpoints/generations/story-utils.ts) is the
 * shared server-side workhorse behind EVERY chapter expansion variation:
 * create/append/resume chains, fork re-expansion, PATCH expandChapterIndex
 * (re-expand), and PATCH rewriteChapter. Its do/while loop previously
 * retried INFINITELY while the content stayed below minWords (or every
 * attempt errored) — burning tokens forever. The fix caps it at
 * MAX_EXPAND_ATTEMPTS (generation-config.ts): 1 initial attempt + up to
 * 10 retries = at most 11 LLM calls per chapter.
 *
 * Termination contract: when the budget is exhausted WITHOUT meeting the
 * quality gate (minWords), expandChapter THROWS instead of keeping
 * best-effort content. A kept short chapter would be finalized by the
 * caller and feed its content into the NEXT chapter's context, producing
 * a chain of broken chapters. Before throwing, expandChapter rolls back
 * the progressive streaming state (rollbackFailedChapterExpansion):
 * trailing `generationTimeMs === 0` streaming revisions are stripped from
 * chapter-XXX.json, the previous finalized revision (if any) is kept, and
 * chapter-XXX.md is restored from it — or removed entirely when the
 * chapter is back to plotlines-only.
 *
 * The generation-config module is mocked (same pattern as
 * generation-update-chapter.test.ts) so no real LLM client is built.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./generation-config', () => ({
    useApiMethod: 'format',
    OPENING_USER_MESSAGE: 'Hey ENI',
    STORY_REQUEST_MESSAGE: 'You know the story I like',
    MAX_PLOT_ATTEMPTS: 3,
    // Mirror the production value — the retry budget under test.
    MAX_EXPAND_ATTEMPTS: 10,
    MAX_STALL_RETRIES: 10,
    PLOTPOINT_STALL_TIMEOUT_MS: 5 * 60 * 1000,
    EXPAND_TIMEOUT_MS: 10 * 60 * 1000,
    MIN_WORDS_PER_CHAPTER: 3000,
    TARGET_WORD_COUNT_PROMPT: '4,000 words',
    MIN_PLOTPOINTS_PER_CHAPTER: 10,
    REFUSAL_PATTERNS: ['I cannot fulfill'],
    DATABASE_BASE_DIR: 'storyboard',
    CLIENT: {},
    CLIENTS: {},
    parseClientId: () => ({}),
    resolveClient: () => ({})
}));

vi.mock('@runtime/data/prompts', () => ({
    KIMIK2_INSTRUCTIONS: 'test instructions',
    KIMIK2_OPENING: 'test opening'
}));

import { expandChapter } from './story-utils';
import { MAX_EXPAND_ATTEMPTS } from './generation-config';

// Isolated temp dir per test — expandChapter writes chapter-XXX.md per attempt.
let tempRoot: string;

const newChapterDir = (): string => {
    const dir = path.join(tempRoot, `chapter-test-${Math.random().toString(36).slice(2)}`, 'chapter');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

// Mock LLM client: `format` resolves (or rejects) per the per-test behavior.
// expandChapter clones the client and calls .assistant() on the clone — the
// clone must carry the same format mock.
const createClient = (formatImpl: (config: any) => Promise<any>) => {
    const format = vi.fn(formatImpl);
    const client: any = {
        assistant: vi.fn(),
        clone: vi.fn().mockImplementation(() => ({ assistant: vi.fn(), format }))
    };
    return { client, format };
};

const baseOpts = (chapterDir: string, minWords: number) => ({
    appending: ['> 1: Chapter One', '\n\n', '- plot one'],
    chapterDir,
    assertStoryExists: () => {},
    chapterNumber: '1',
    chapterIndex: 0,
    request: '> Expand the chapter "1: Chapter One"',
    minWords
});

// Seeds a skeleton chapter-XXX.json (as writeChapterPayload does at plotline
// time) so rollbackFailedChapterExpansion has a payload to clean up.
const seedChapterJson = (chapterDir: string, revisions: any[], title = 'The Beginning'): void => {
    fs.writeFileSync(
        path.join(chapterDir, 'chapter-001.json'),
        JSON.stringify({
            storyId: 'test',
            chapterNumber: '1',
            chapterIndex: 0,
            title,
            plotpoints: ['Opening scene'],
            context: { appending: ['> 1: The Beginning\n\n- Opening scene'], request: '> Expand the chapter "1: The Beginning"' },
            config: { systemInstructions: 'test', openingMessage: 'test' },
            revisions
        }),
        'utf-8'
    );
};

const readChapterJson = (chapterDir: string): any =>
    JSON.parse(fs.readFileSync(path.join(chapterDir, 'chapter-001.json'), 'utf-8'));

describe('expandChapter retry budget (MAX_EXPAND_ATTEMPTS)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-utils-expand-test-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('stops after 1 initial attempt + MAX_EXPAND_ATTEMPTS retries when content stays below minWords, then THROWS (no best-effort keep)', async () => {
        // Every attempt returns 51 words (below the 100-word minimum) — the
        // pre-fix loop would retry forever. The budget must stop it, and the
        // quality-gate failure must TERMINATE (throw) rather than keep the
        // short chapter — a kept short chapter would poison the next
        // chapter's context in every chaining caller.
        const shortContent = 'word '.repeat(50);
        const { client, format } = createClient(() =>
            Promise.resolve({ response: { title: 'Short Chapter', content: shortContent } })
        );
        const chapterDir = newChapterDir();
        seedChapterJson(chapterDir, []);

        await expect(expandChapter({ ...baseOpts(chapterDir, 100), client })).rejects.toThrow(
            'Chapter 1 expansion produced only 51 words (minimum: 100) after 11 attempt(s) ' +
                '(retry budget MAX_EXPAND_ATTEMPTS=10 exhausted)'
        );

        // 1 initial + 10 retries = exactly 11 calls, then the loop stops.
        expect(MAX_EXPAND_ATTEMPTS).toBe(10);
        expect(format).toHaveBeenCalledTimes(11);

        // ROLLBACK: the chapter returns to plotlines-only. The per-attempt
        // .md write persisted the short content, so rollback must REMOVE it.
        expect(fs.existsSync(path.join(chapterDir, 'chapter-001.md'))).toBe(false);
        // The skeleton revisions[] stays empty — no finalized revision exists.
        expect(readChapterJson(chapterDir).revisions).toEqual([]);
    });

    it('rolls back a streaming partial revision on failure while KEEPING the previous finalized revision', async () => {
        // Simulates a failed RE-EXPAND: the chapter already has one finalized
        // revision (generationTimeMs > 0), and the failed expansion left a
        // streaming partial (generationTimeMs === 0) on top. Rollback must
        // strip the streaming entry and restore the .md from the previous
        // revision — the chapter stays expanded with its old content.
        const previousRevision = {
            content: 'Previous good revision content.',
            wordCount: 4,
            generationTimeMs: 4321
        };
        const streamingPartial = {
            content: 'truncated partial output from the failed attempt',
            wordCount: 8,
            generationTimeMs: 0
        };
        const shortContent = 'word '.repeat(50);
        const { client, format } = createClient(() =>
            Promise.resolve({ response: { title: 'Short Chapter', content: shortContent } })
        );
        const chapterDir = newChapterDir();
        seedChapterJson(chapterDir, [previousRevision, streamingPartial]);

        await expect(expandChapter({ ...baseOpts(chapterDir, 100), client })).rejects.toThrow(
            'Chapter 1 expansion produced only 51 words (minimum: 100) after 11 attempt(s) ' +
                '(retry budget MAX_EXPAND_ATTEMPTS=10 exhausted)'
        );
        expect(format).toHaveBeenCalledTimes(11);

        // Streaming entry stripped, previous finalized revision intact.
        expect(readChapterJson(chapterDir).revisions).toEqual([previousRevision]);

        // .md restored from the surviving revision (with the payload title).
        const written = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(written).toBe(`## The Beginning\n\nPrevious good revision content.`);
    });

    it('stops after the budget when every attempt rejects, and throws instead of returning empty content', async () => {
        const { client, format } = createClient(() => Promise.reject(new Error('LLM exploded')));
        const chapterDir = newChapterDir();
        seedChapterJson(chapterDir, []);

        await expect(expandChapter({ ...baseOpts(chapterDir, 100), client })).rejects.toThrow(
            'Chapter 1 expansion failed after 11 attempt(s) (retry budget MAX_EXPAND_ATTEMPTS=10 exhausted)'
        );

        // Exactly 11 calls — the pre-fix loop never terminated on this path.
        expect(format).toHaveBeenCalledTimes(11);
    });

    it('calls the LLM exactly once when the first attempt meets minWords (no budget consumed)', async () => {
        const longContent = 'word '.repeat(150);
        const { client, format } = createClient(() =>
            Promise.resolve({ response: { title: 'Long Chapter', content: longContent } })
        );
        const chapterDir = newChapterDir();

        const result = await expandChapter({ ...baseOpts(chapterDir, 100), client });

        expect(format).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ title: 'Long Chapter', content: longContent });
    });
});
