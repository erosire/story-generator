/**
 * @vitest-environment node
 * story-utils imports @runtime/secret/private (via generation-config) which
 * transitively imports OpenAI SDK — that SDK throws in jsdom environments.
 *
 * Tests for expandChapter's RETRY BUDGET (the infinite-retry bug fix).
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

    it('stops after 1 initial attempt + MAX_EXPAND_ATTEMPTS retries when content stays below minWords, keeping best-effort content', async () => {
        // Every attempt returns 51 words (below the 100-word minimum) — the
        // pre-fix loop would retry forever. The budget must stop it.
        const shortContent = 'word '.repeat(50);
        const { client, format } = createClient(() =>
            Promise.resolve({ response: { title: 'Short Chapter', content: shortContent } })
        );
        const chapterDir = newChapterDir();

        const result = await expandChapter({ ...baseOpts(chapterDir, 100), client });

        // 1 initial + 10 retries = exactly 11 calls, then the loop stops.
        expect(MAX_EXPAND_ATTEMPTS).toBe(10);
        expect(format).toHaveBeenCalledTimes(11);

        // The best-effort (sub-minimum) content is KEPT, not discarded — the
        // chapter stays expanded with the last attempt's output.
        expect(result).toEqual({ title: 'Short Chapter', content: shortContent });

        // The last attempt was persisted to the chapter markdown file.
        const written = fs.readFileSync(path.join(chapterDir, 'chapter-001.md'), 'utf-8');
        expect(written).toBe(`## Short Chapter\n\n${shortContent}`);
    });

    it('stops after the budget when every attempt rejects, and throws instead of returning empty content', async () => {
        const { client, format } = createClient(() => Promise.reject(new Error('LLM exploded')));
        const chapterDir = newChapterDir();

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
