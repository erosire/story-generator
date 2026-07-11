// Footer section: storyline + chapterRequested input form.
//
// On submit it creates a new story entry locally (generating a fresh storyId),
// adds it to the store, selects it, and POSTs to /v1/storyboard/generations/:storyId
// with the entered storyline + chapterCount (matching the server's POST body —
// see generation-create-new-story.ts:219).
//
// After a successful POST the form is cleared and collapsed so the user can
// immediately start the next story. The new story tab appears in SectionStoryTabs
// and the content section starts polling for generation progress.
//
// The input area is always visible (no selected story required) — the user types
// a storyline, optionally adjusts the chapter count, and clicks Generate to create
// a story. This replaces the previous "Add button → fill form → Generate" flow.

import React from 'react';
import { styled, theme } from '../../styles';
import { useStoryStore } from '../../context';
import { createNewStory } from '../../api';

// Footer wrapper — always rendered, shrinks when unfocused.
const FooterColumn = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    width: '100%'
});

// Multi-line textarea for the storyline.
// When unfocused, collapses to a single-line bar (minHeight:36, one row).
// When focused, expands to full multi-line editing area (minHeight:60).
// transition provides a smooth visual cue for the size change.
// Modern: focus ring (sg-input) + accent-tinted background, slightly larger
// radius so the field reads as a primary input surface.
const StorylineTextarea = styled('textarea', {
    width: '100%',
    resize: 'vertical',
    padding: 10,
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.borderStrong}`,
    backgroundColor: theme.surface1,
    color: theme.text,
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.body,
    lineHeight: 1.5,
    boxSizing: 'border-box',
    transition: `min-height ${theme.transition}, border-color ${theme.transition}, background-color ${theme.transition}`
});

// Horizontal control row: chapter-count input on the left, Generate button on right.
// Hidden when the input area is not focused to reduce visual clutter.
const ControlRow = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap'
});

// Small numeric input for chapter count. width:80px gives room for 3-4 digits
// without crowding the action button.
const ChapterCountInput = styled('input', {
    width: 80,
    padding: '7px 10px',
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.borderStrong}`,
    backgroundColor: theme.surface1,
    color: theme.text,
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.body,
    boxSizing: 'border-box',
    transition: `border-color ${theme.transition}, background-color ${theme.transition}`
});

// Primary action button — flat solid accent fill. Hover swaps to a brighter
// solid via the `sg-primary` class hook (global.ts). Flat: no gradient, no
// shadow, no translate-on-hover.
const GenerateButton = styled('button', {
    padding: '9px 20px',
    borderRadius: theme.radiusMd,
    border: 'none',
    backgroundColor: theme.accent,
    color: '#ffffff',
    fontSize: theme.fontSize.body,
    fontWeight: 600,
    cursor: 'pointer',
    flex: '0 0 auto',
    transition: `background-color ${theme.transition}`
});

// Error message line under the form.
const ErrorLine = styled('div', {
    color: theme.danger,
    fontSize: theme.fontSize.md,
    padding: '8px 12px',
    background: theme.dangerSoft,
    border: `1px solid ${theme.dangerBorder}`,
    borderRadius: theme.radiusMd
});

export const SectionStoryInput: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { selected } = store;

    // Local form state for the storyline textarea + chapter count.
    // We keep these local (not in the global store) because they're transient
    // until the user submits; storing them globally would trigger re-renders of
    // every consumer on every keystroke.
    const [storyline, setStoryline] = React.useState('');
    const [chapterCount, setChapterCount] = React.useState(3);
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [error, setError] = React.useState('');

    // Focus tracking: the expanded controls (chapter count + generate button)
    // are only visible when the input area is focused. `isFocused` is true
    // when either the textarea or the chapter-count input has focus.
    const [isFocused, setIsFocused] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    // Populate the form with the selected story's storyline and chapterRequested
    // so the user can hit "Generate" to create a new story with the same prompt.
    // Falls back to empty storyline / default 3 chapters when nothing is selected.
    // For remote stories, storyline comes from the per-story GET endpoint's
    // meta.storyline (populated by polling in SectionStoryContent). The
    // dependency on data?.meta?.storyline ensures the input updates when
    // polling first resolves the storyline — subsequent polls with the same
    // string won't re-trigger, so user edits are preserved.
    React.useEffect(() => {
        const resolvedStoryline = selected?.data?.meta?.storyline || selected?.storyline || '';
        setStoryline(resolvedStoryline);
        setChapterCount(selected?.data?.meta?.chapterCount ?? selected?.chapterRequested ?? 3);
        setError('');
    }, [selected?.id, selected?.data?.meta?.storyline]);

    // Focus/blur handlers on the container.
    const handleFocusIn = React.useCallback(() => setIsFocused(true), []);
    const handleFocusOut = React.useCallback((e: React.FocusEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
            setIsFocused(false);
        }
    }, []);

    // Validation: storyline must be non-empty; chapterCount must be a positive int.
    const onSubmit = async () => {
        setError('');

        if (!storyline.trim()) {
            setError('storyline is required');
            return;
        }
        if (!Number.isFinite(chapterCount) || chapterCount < 1) {
            setError('chapterCount must be a positive number');
            return;
        }

        setIsSubmitting(true);
        let entryId: number | null = null;
        try {
            // Generate a storyId in DateTime format: YYYYMMDD-HHMMSS
            entryId = Date.now();
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const storyId =
                `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
                `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

            // Derive storyName from the storyline: first line, truncated to 120 chars
            const trimmedStoryline = storyline.trim();
            const storyName = trimmedStoryline.split('\n')[0].trim().slice(0, 120) || trimmedStoryline.slice(0, 120);

            const entry = {
                id: entryId,
                storyId,
                storyName,
                title: storyName || `${storyId.slice(0, 8)} ${now.getHours()}:${pad(now.getMinutes())}${now.getHours() >= 12 ? 'pm' : 'am'}`,
                storyline: trimmedStoryline,
                chapterRequested: chapterCount,
                chapterCompleted: 0,
                createdDate: now.toISOString(),
                status: 'generating' as const,
                data: null,
                isProcessing: true,
                error: '',
                isRemote: false
            };

            setStore((prev) => ({
                ...prev,
                records: [...prev.records, entry],
                selected: entry
            }));

            // POST to the server.
            await createNewStory(store.config.baseUrl, storyId, {
                storyline: storyline.trim(),
                chapterCount
            });

            setIsFocused(false);
        } catch (err: any) {
            setError(err?.message ?? 'Failed to create story');
            if (entryId !== null) {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === entryId
                            ? { ...e, isProcessing: false, error: err?.message ?? 'Failed to create story' }
                            : e
                    ),
                    selected:
                        prev.selected?.id === entryId
                            ? { ...prev.selected, isProcessing: false, error: err?.message ?? 'Failed to create story' }
                            : prev.selected
                }));
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <FooterColumn data-testid="story-input">
            <div
                ref={containerRef}
                onFocus={handleFocusIn}
                onBlur={handleFocusOut}
                style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}
            >
                {/* Wrapper div controls minHeight to avoid passing `style` to the
                    styled StorylineTextarea — the vendored styled() helper applies
                    styles via React.createElement(Tag, { style, ...rest }) so a
                    consumer `style` prop overwrites the static styles entirely.
                    When focused, minHeight = 10 rows (~200px). */}
                <div style={{ minHeight: isFocused ? 200 : 36, transition: `min-height ${theme.transition}` }}>
                    <StorylineTextarea
                        data-testid="storyline-input"
                        className="sg-input"
                        rows={isFocused ? 10 : 1}
                        placeholder="Storyline — e.g. A sci-fi adventure about a crew discovering an ancient alien artifact on Mars."
                        value={storyline}
                        onChange={(e) => setStoryline(e.target.value)}
                        disabled={isSubmitting}
                    />
                </div>
                {/* Controls only visible when the input area is in focus. */}
                {isFocused && (
                    <ControlRow>
                        <label htmlFor="chapter-count" style={{ color: theme.textMuted, fontSize: theme.fontSize.md, fontWeight: 500 }}>
                            Chapters
                        </label>
                        <ChapterCountInput
                            id="chapter-count"
                            type="number"
                            min={1}
                            value={chapterCount}
                            onChange={(e) => setChapterCount(Number(e.target.value))}
                            disabled={isSubmitting}
                            data-testid="chapter-count-input"
                            className="sg-input"
                        />
                        <GenerateButton
                            onClick={onSubmit}
                            disabled={isSubmitting}
                            data-testid="generate-button"
                            className="sg-primary"
                        >
                            {isSubmitting ? 'Generating…' : 'Generate'}
                        </GenerateButton>
                        {error && <ErrorLine data-testid="input-error">{error}</ErrorLine>}
                    </ControlRow>
                )}
            </div>
        </FooterColumn>
    );
});
