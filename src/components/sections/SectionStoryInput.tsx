// Footer section: storyline + chapterCount input form.
//
// On submit it creates a new story entry locally (generating a fresh storyId),
// adds it to the store, selects it, and POSTs to /v1/storyboard/generations/:storyId
// with the entered storyline + chapterCount (matching the server's expected body —
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
import { styled } from '../../styles';
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
const StorylineTextarea = styled('textarea', {
    width: '100%',
    resize: 'vertical',
    padding: 8,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#e0e0e0',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxSizing: 'border-box',
    transition: 'min-height 0.15s ease'
});

// Horizontal control row: chapter-count input on the left, Generate button on right.
// Hidden when the input area is not focused to reduce visual clutter.
const ControlRow = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap'
});

// Small numeric input for chapter count. width:80px gives room for 3-4 digits
// without crowding the action button.
const ChapterCountInput = styled('input', {
    width: 80,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#e0e0e0',
    fontSize: 14,
    boxSizing: 'border-box'
});

// Primary action button.
const GenerateButton = styled('button', {
    padding: '8px 18px',
    borderRadius: 6,
    border: 'none',
    backgroundColor: '#3a6ea5',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    flex: '0 0 auto'
});

// Error message line under the form.
const ErrorLine = styled('div', {
    color: '#ff6b6b',
    fontSize: 13
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
    // We use a container ref to detect focus anywhere inside the footer.
    const [isFocused, setIsFocused] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    // Reset the form whenever the user selects a different story so they don't
    // accidentally submit a previous story's storyline to a new storyId.
    React.useEffect(() => {
        setStoryline('');
        setChapterCount(3);
        setError('');
    }, [selected?.id]);

    // Focus/blur handlers on the container. Using focusin/focusout (bubbling)
    // so we catch focus moving to any child (textarea, chapter input, button).
    // This keeps the controls visible while the user is interacting with them.
    const handleFocusIn = React.useCallback(() => setIsFocused(true), []);
    const handleFocusOut = React.useCallback((e: React.FocusEvent) => {
        // Only collapse when focus leaves the entire container — not when it
        // moves between children inside the footer (e.g. textarea → chapter input).
        if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
            setIsFocused(false);
        }
    }, []);

    // Validation: storyline must be non-empty; chapterCount must be a positive int.
    // Matches server-side validation in generation-create-new-story.ts:222-233.
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
        // Capture entryId for error handling — if POST fails, we mark the
        // entry as not processing so the tab doesn't show a stuck spinner.
        let entryId: number | null = null;
        try {
            // Generate a storyId in DateTime format: YYYYMMDD-HHMMSS
            // e.g. "20260703-162233" → 03 July 2026, 4:22:33pm
            entryId = Date.now();
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const storyId =
                `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
                `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

            // Create the entry with processing state and add to store.
            // The entry is created before the POST so the tab appears immediately.
            const entry = {
                id: entryId,
                storyId,
                // Title shows a human-readable version of the DateTime storyId.
                // e.g. "20260703 4:22pm"
                title: `${storyId.slice(0, 8)} ${now.getHours()}:${pad(now.getMinutes())}${now.getHours() >= 12 ? 'pm' : 'am'}`,
                storyline: storyline.trim(),
                chapterCount,
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

            // POST to the server. The server validates and returns { storyId }.
            await createNewStory(store.config.baseUrl, storyId, {
                storyline: storyline.trim(),
                chapterCount
            });

            // Clear the form on success so the user can immediately start
            // the next story (chapterCount is preserved as a convenience).
            setStoryline('');
            setChapterCount(3);
            // Collapse back to minimal footprint after successful submit.
            setIsFocused(false);
        } catch (err: any) {
            // Surface the server's error message (createNewStory already parses it).
            setError(err?.message ?? 'Failed to create story');
            // Mark the entry as not processing on failure so the tab doesn't
            // show a stuck spinner. The entry remains in the store so the user
            // can see it and potentially retry.
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
        <FooterColumn
            data-testid="story-input"
        >
        <div
            ref={containerRef}
            onFocus={handleFocusIn}
            onBlur={handleFocusOut}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
        >
            {/* Wrapper div controls minHeight to avoid passing `style` to the
                styled StorylineTextarea — the vendored styled() helper applies
                styles via React.createElement(Tag, { style, ...rest }) so a
                consumer `style` prop overwrites the static styles entirely,
                stripping background/color/border and falling back to browser
                defaults (black on white).
                When focused, minHeight = 10 rows (~200px with 14px font + padding). */}
            <div style={{ minHeight: isFocused ? 200 : 36 }}>
                <StorylineTextarea
                    data-testid="storyline-input"
                    rows={isFocused ? 10 : 1}
                    placeholder="Storyline — e.g. A sci-fi adventure about a crew discovering an ancient alien artifact on Mars."
                    value={storyline}
                    onChange={(e) => setStoryline(e.target.value)}
                    disabled={isSubmitting}
                />
            </div>
            {/* Controls only visible when the input area is in focus. */}
            {isFocused && (
                <>
                    <ControlRow>
                        <label htmlFor="chapter-count" style={{ color: '#a0a0a0', fontSize: 13 }}>
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
                        />
                        <GenerateButton
                            onClick={onSubmit}
                            disabled={isSubmitting}
                            data-testid="generate-button"
                        >
                            {isSubmitting ? 'Generating…' : 'Generate'}
                        </GenerateButton>
                    </ControlRow>
                    {error && <ErrorLine data-testid="input-error">{error}</ErrorLine>}
                </>
            )}
        </div>
        </FooterColumn>
    );
});
