// Unit tests for the action bar Copy helpers (features/clipboard.ts):
//
//   - collectStoryPlotpoints: structures the polled chapters into the copy
//     format — optional "[Story title]" header, then one "Chapter N:" block
//     per chapter with a dash list of its plotpoints, blank-line separated.
//     PLOTPOINTS ONLY (no revision prose): chapters without plotpoints and
//     blank plotpoint strings contribute nothing.
//
//   - copyTextToClipboard: Clipboard API first (secure contexts), legacy
//     hidden-textarea + execCommand fallback for plain-HTTP hosting and for
//     permission denials; resolves boolean success and never throws.
//
// jsdom ships NEITHER navigator.clipboard NOR document.execCommand, so every
// clipboard test installs its own stubs on the live navigator/document
// objects and restores them in afterEach.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectStoryPlotpoints, copyTextToClipboard } from './clipboard';
import type { PlotpointsChapter } from './clipboard';

// Clipboard/execCommand stub bookkeeping — jsdom has neither API, so the
// "original" is captured as absent (undefined) and deletion restores it.
const originalClipboard = (navigator as any).clipboard;
const originalExecCommand = (document as any).execCommand;

afterEach(() => {
    if (originalClipboard === undefined) {
        delete (navigator as any).clipboard;
    } else {
        (navigator as any).clipboard = originalClipboard;
    }
    if (originalExecCommand === undefined) {
        delete (document as any).execCommand;
    } else {
        (document as any).execCommand = originalExecCommand;
    }
});

describe('collectStoryPlotpoints', () => {
    it('produces the [title] header and one "Chapter N:" dash-list block per chapter', () => {
        const chapters: PlotpointsChapter[] = [
            { plotpoints: ['The crew wakes from cryo', 'Station drifts off course'] },
            { plotpoints: ['Mutiny in the lower decks'] }
        ];
        expect(collectStoryPlotpoints(chapters, 'Ice Station')).toBe(
            '[Ice Station]\n\nChapter 1:\n- The crew wakes from cryo\n- Station drifts off course\n\nChapter 2:\n- Mutiny in the lower decks'
        );
    });

    it('omits the bracket header when no title is given but keeps the chapter blocks', () => {
        const chapters: PlotpointsChapter[] = [{ plotpoints: ['kept'] }];
        expect(collectStoryPlotpoints(chapters)).toBe('Chapter 1:\n- kept');
        expect(collectStoryPlotpoints(chapters, undefined)).toBe('Chapter 1:\n- kept');
        // Blank/whitespace titles are dropped too (trimmed before the guard).
        expect(collectStoryPlotpoints(chapters, '')).toBe('Chapter 1:\n- kept');
        expect(collectStoryPlotpoints(chapters, '   ')).toBe('Chapter 1:\n- kept');
    });

    it('returns an empty string for null, undefined, and chapter-less inputs', () => {
        expect(collectStoryPlotpoints(null, 'Ice Station')).toBe('');
        expect(collectStoryPlotpoints(undefined)).toBe('');
        expect(collectStoryPlotpoints([], 'Ice Station')).toBe('');
        expect(collectStoryPlotpoints([{}, { plotpoints: [] }], 'Ice Station')).toBe('');
    });

    it('skips chapters without plotpoints and blank plotpoint strings, keeping display numbering', () => {
        const chapters: PlotpointsChapter[] = [
            { plotpoints: ['kept'] },
            {}, // no plotpoints field (pending chapter)
            { plotpoints: ['', '   ', 'kept after blanks'] },
            { plotpoints: undefined }
        ];
        // Numbering follows the DISPLAY index (i + 1), so chapter 3 keeps
        // its number even though chapter 2 contributed no block.
        expect(collectStoryPlotpoints(chapters, 'Ice Station')).toBe(
            '[Ice Station]\n\nChapter 1:\n- kept\n\nChapter 3:\n- kept after blanks'
        );
    });

    it('trims the bracketed title', () => {
        const chapters: PlotpointsChapter[] = [{ plotpoints: ['kept'] }];
        expect(collectStoryPlotpoints(chapters, '  Ice Station  ')).toBe('[Ice Station]\n\nChapter 1:\n- kept');
    });
});

describe('copyTextToClipboard', () => {
    it('writes through the Clipboard API when available and resolves true', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        (navigator as any).clipboard = { writeText };

        await expect(copyTextToClipboard('line one\nline two')).resolves.toBe(true);
        expect(writeText.mock.calls).toEqual([['line one\nline two']]);
    });

    it('falls back to execCommand when the Clipboard API write rejects', async () => {
        const writeText = vi.fn(() => Promise.reject(new Error('denied')));
        const execCommand = vi.fn(() => true);
        (navigator as any).clipboard = { writeText };
        (document as any).execCommand = execCommand;

        await expect(copyTextToClipboard('fallback text')).resolves.toBe(true);
        expect(writeText.mock.calls).toEqual([['fallback text']]);
        expect(execCommand.mock.calls).toEqual([['copy']]);
    });

    it('falls back to execCommand when navigator.clipboard does not exist (plain HTTP)', async () => {
        const execCommand = vi.fn(() => true);
        delete (navigator as any).clipboard;
        (document as any).execCommand = execCommand;

        await expect(copyTextToClipboard('legacy path')).resolves.toBe(true);
        expect(execCommand.mock.calls).toEqual([['copy']]);
        // The helper textarea was cleaned up after the copy.
        expect(document.querySelectorAll('textarea').length).toBe(0);
    });

    it('resolves false when both the Clipboard API and the fallback fail', async () => {
        const writeText = vi.fn(() => Promise.reject(new Error('denied')));
        (navigator as any).clipboard = { writeText };
        // jsdom's execCommand is undefined by default — calling it throws and
        // the helper resolves false instead of throwing.
        delete (document as any).execCommand;

        await expect(copyTextToClipboard('doomed')).resolves.toBe(false);
    });
});
