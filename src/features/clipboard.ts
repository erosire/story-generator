// Clipboard helpers for the story content area (features/content.tsx).
//
// Two responsibilities, split out of the component so both are unit-testable:
//
//   1. collectStoryPlotpoints — structures the polled chapters' plotpoints
//      into the copy format requested for the action bar's Copy control:
//
//        [Story title]
//
//        Chapter 1:
//        - Plot 1 of Chapter 1
//        - Plot 2 of Chapter 1
//
//        Chapter 2:
//        - Plot 1 of Chapter 2
//
//      PLOTPOINTS ONLY: revision prose / chapter titles are never included —
//      the chapter heading ("Chapter N:") is layout, not content. Chapters
//      without plotpoints (pending/empty) contribute nothing, and blank
//      plotpoint strings are skipped so no empty list items are produced.
//      A blank/unavailable title drops the bracket header but keeps the
//      chapter blocks.
//
//   2. copyTextToClipboard — writes text to the system clipboard. Primary
//      path is the async Clipboard API (secure contexts: https / localhost —
//      the deployed GitHub Pages shape). Falls back to the classic hidden-
//      textarea + document.execCommand('copy') trick for plain-HTTP hosting
//      where navigator.clipboard does not exist (the API is secure-context
//      only), and treats a permission denial as fallthrough to the same
//      fallback. Returns boolean success so the UI only shows its "Copied"
//      feedback when the write actually happened.

import { arrayEach, arrayEnsures, isString, isEmpty, isFunction } from '@presource/core';

// Minimal chapter shape the collector needs — the polled payload chapters
// carry more fields (revisions, chapterIndex, ...) that are irrelevant here.
export type PlotpointsChapter = {
    plotpoints?: string[];
};

// Structure every chapter's plotpoints into the copy format: optional
// "[title]" header, then one "Chapter N:" block per chapter (dash list of
// its plotpoints), separated by blank lines. Order follows the chapters
// array; the chapter number is the display index (i + 1 — the same number
// the chapter headers render, features/content.tsx `Chapter {i + 1}`).
// Accepts null/undefined so call sites can pass `data.chapters` unguarded.
export const collectStoryPlotpoints = (chapters?: PlotpointsChapter[] | null, title?: string): string => {
    // One "Chapter N:" block per plotpoint-bearing chapter; arrayEach is the
    // @presource array iterator (short-circuits on truthy returns — every
    // return in the callbacks below is a plain `return`, i.e. undefined).
    const blocks: string[] = [];
    arrayEach(arrayEnsures(chapters), ({ index, value: chapter }) => {
        const items: string[] = [];
        arrayEach(arrayEnsures(chapter?.plotpoints), ({ value: plotpoint }) => {
            // isString + isEmpty: only real, non-blank plotpoint text becomes
            // a dash list item (isEmpty treats whitespace-only strings as
            // empty too).
            if (isString(plotpoint) && !isEmpty(plotpoint)) {
                items.push(`- ${plotpoint}`);
            }
        });
        // A chapter with no usable plotpoints (pending / empty) contributes
        // no block — an empty "Chapter N:" heading would be noise.
        if (items.length === 0) return;
        blocks.push(`Chapter ${index + 1}:\n${items.join('\n')}`);
    });
    const body = blocks.join('\n\n');
    // Bracketed story-title header, only when a real (non-blank) title is
    // given — otherwise the chapters block stands alone.
    const header = isString(title) && !isEmpty(title) ? `[${title.trim()}]` : '';
    return header && body ? `${header}\n\n${body}` : body;
};

// Write text to the clipboard. Resolves to true only when a write actually
// succeeded (used by the UI to decide whether to show the transient
// "Copied" feedback). Never throws — every failure path resolves false.
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
    // Primary: the async Clipboard API. Available in secure contexts only;
    // can also reject on permission denial / document-not-focused.
    if (typeof navigator !== 'undefined' && navigator.clipboard && isFunction(navigator.clipboard.writeText)) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Denied or failed — fall through to the legacy path below.
        }
    }

    // Legacy fallback (plain-HTTP hosting): off-screen readonly textarea +
    // the deprecated execCommand('copy'). The textarea is positioned outside
    // the viewport so appending/selecting it never scrolls the page or
    // flashes an input, and readonly keeps mobile keyboards shut.
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok === true;
    } catch {
        return false;
    }
};
