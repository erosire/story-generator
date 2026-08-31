// Input FEATURE: the footer storyline + chapterRequested form.
//
// On submit it creates a new story entry locally (generating a fresh storyId),
// adds it to the store, selects it, and POSTs to /v1/storyboard/generations/:storyId
// with the entered storyline + chapterCount (matching the server's POST body —
// see generation-create-new-story.ts:219).
//
// After a successful POST the form is cleared and collapsed so the user can
// immediately start the next story. The new story tab appears in the sidebar
// and the content feature starts polling for generation progress.
//
// The input area is always visible (no selected story required) — the user types
// a storyline, optionally adjusts the chapter count, and clicks Generate to create
// a story. This replaces the previous "Add button → fill form → Generate" flow.
//
// Moved from the old src/components/sections/SectionStoryInput — the feature
// owns the form's submit/PATCH business logic. The form fields are Material UI:
// the storyline is a MUI TextField (multiline) and the count field uses the
// modular NumberInput (components/Input.tsx, MUI TextField-backed); Generate is
// the modular primary Button (components/Button.tsx, MUI Button-backed).

import React from 'react';
import { TextField } from '@mui/material';
import { styled, theme } from '../styles';
import { useStoryStore } from '../context';
import { createNewStory } from '../api';
import { Button, NumberInput } from '../components';

// Footer wrapper — always rendered, shrinks when unfocused.
const FooterColumn = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    width: '100%'
});

// Multi-line MUI TextField for the storyline.
// The wrapper div (in the render below) controls the focus-driven collapse:
// when unfocused the field is a single-line bar (minHeight 36, one row);
// when focused it expands to the full multi-line editing area (minHeight 200).
// The flat field frame mirrors the modular fields in components/Input.tsx.
// NOTE: sx numbers are SPACING-MAPPED in MUI (10 → 80px!) — every padding/
// margin/gap here is an explicit px string to keep the flat frame exact.
const STORYLINE_FIELD_SX = {
    width: '100%',
    '& .MuiOutlinedInput-root': {
        // Zero the MUI multiline root padding — the field's inset is owned by
        // the input rule below (MUI's multiline root adds 16.5px 14px ON TOP
        // of the input padding, which doubled the visual padding).
        padding: '0',
        backgroundColor: theme.surface1,
        color: theme.text,
        borderRadius: `${theme.radiusMd}px`,
        fontFamily: theme.fontSans,
        fontSize: theme.fontSize.body
    },
    '& .MuiOutlinedInput-notchedOutline': {
        borderColor: theme.borderStrong
    },
    // No `resize` — MUI multiline fields size themselves via `rows`, and the
    // browser's resize grip renders as a light square that breaks the theme.
    '& .MuiInputBase-input': {
        padding: '10px 12px',
        lineHeight: 1.5
    }
};

// Horizontal control row: chapter-count input on the left, Generate button on right.
// Hidden when the input area is not focused to reduce visual clutter.
const ControlRow = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap'
});

// The "Chapters" label for the chapter-count field.
const ChaptersLabel = styled('label', {
    color: theme.textMuted,
    fontSize: theme.fontSize.md,
    fontWeight: 500
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

export const StoryInput: React.FC = React.memo(() => {
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

    // NOTE: the previous pendingStoryline hand-off (content "[->] Extend"
    // button → footer input) was replaced by the in-place append dialog in
    // the content feature (appendStoryPlotpoints) — extending a story no
    // longer creates a new story through this footer form.

    // Populate the form with the selected story's storyline and chapterRequested
    // so the user can hit "Generate" to create a new story with the same prompt.
    // Falls back to empty storyline / default 3 chapters when nothing is selected.
    // For remote stories, storyline comes from the per-story GET endpoint's
    // meta.storyline (populated by polling in the content feature). The
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
                // Generate is a user action — stamp it so the new story sorts
                // by the last-actioned key (same moment as createdDate here).
                lastActionedAt: now.toISOString(),
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

            // POST to the server. clientId is the top-right dropdown selection
            // (persisted in store.config.clientId, default 'Qwen27B') — the
            // server validates it against its CLIENTS map and applies it to
            // this generation only; it is never stored with the story.
            await createNewStory(
                store.config.baseUrl,
                storyId,
                {
                    storyline: storyline.trim(),
                    chapterCount
                },
                undefined,
                store.config.clientId
            );

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
                {/* Wrapper div controls the focus-driven minHeight (a genuinely
                    dynamic value). When focused, minHeight = 10 rows (~200px). */}
                <div style={{ minHeight: isFocused ? 200 : 36, transition: `min-height ${theme.transition}` }}>
                    {/* MUI multiline TextField — data-testid lands on the native
                        textarea via slotProps.htmlInput so the tests can focus/
                        change it directly (getByTestId('storyline-input')).

                        COLLAPSED = EMPTY: the collapsed single-line bar renders
                        NOTHING but the placeholder — the selected story's
                        storyline (auto-populated into `storyline` for the
                        Generate prefills) is noise in a 1-row strip that can't
                        show it. The value fills in the moment the field
                        expands (focus flips isFocused), and any in-progress
                        draft survives the collapse/expand cycle because only
                        the DISPLAY is gated, never the state. */}
                    <TextField
                        variant="outlined"
                        fullWidth
                        multiline
                        sx={STORYLINE_FIELD_SX}
                        rows={isFocused ? 10 : 1}
                        placeholder="Storyline — e.g. A sci-fi adventure about a crew discovering an ancient alien artifact on Mars."
                        value={isFocused ? storyline : ''}
                        onChange={(e) => setStoryline(e.target.value)}
                        disabled={isSubmitting}
                        slotProps={{ htmlInput: { 'data-testid': 'storyline-input', className: 'sg-input' } }}
                    />
                </div>
                {/* Controls only visible when the input area is in focus:
                    chapter-count on the LEFT, Generate pinned to the FAR
                    RIGHT (marginLeft: auto), any validation error inline
                    after the count field. */}
                {isFocused && (
                    <ControlRow>
                        <ChaptersLabel htmlFor="chapter-count">Chapters</ChaptersLabel>
                        <NumberInput
                            id="chapter-count"
                            min={1}
                            value={chapterCount}
                            onChange={(e) => setChapterCount(Number(e.target.value))}
                            disabled={isSubmitting}
                            data-testid="chapter-count-input"
                        />
                        {error && <ErrorLine data-testid="input-error">{error}</ErrorLine>}
                        {/* Generate — the modular MUI-backed primary Button
                            (solid accent fill; the sg-primary hook drives the
                            hover swap). marginLeft auto pushes it to the row's
                            right edge. */}
                        <Button
                            variant="primary"
                            onClick={onSubmit}
                            disabled={isSubmitting}
                            data-testid="generate-button"
                            style={{ marginLeft: 'auto' }}
                        >
                            {isSubmitting ? 'Generating…' : 'Generate'}
                        </Button>
                    </ControlRow>
                )}
            </div>
        </FooterColumn>
    );
});
