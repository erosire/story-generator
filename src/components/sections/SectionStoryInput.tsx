// Footer section: storyline + chapterCount input form.
//
// On submit it POSTs to /v1/storyboard/generations/:storyId with the entered
// storyline + chapterCount (matching the server's expected body — see
// generation-create-new-story.ts:219). The storyId comes from the currently
// selected entry (created locally by SectionStoryTabs → Add button).
//
// After a successful POST we:
//   1. Persist the storyline + chapterCount on the selected entry so the
//      content section starts polling.
//   2. Mark isProcessing = true so the tab chip shows the spinner.
//
// Server behavior note: POST returns the storyId immediately and kicks off the
// background generation fire-and-forget (generation-create-new-story.ts:236).
// So a 200 here means "request accepted", not "generation complete" — the
// polling loop in SectionStoryContent picks up from there.

import React from 'react';
import { styled } from '../../styles';
import { useStoryStore } from '../../context';
import { createNewStory } from '../../api';

// Footer wrapper.
const FooterColumn = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%'
});

// Multi-line textarea for the storyline. Rows attribute sets a sensible default
// height; users can drag-resize in browsers that support it.
const StorylineTextarea = styled('textarea', {
    width: '100%',
    minHeight: 60,
    resize: 'vertical',
    padding: 8,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#e0e0e0',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxSizing: 'border-box'
});

// Horizontal control row: chapter-count input on the left, Generate button on right.
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

    // Reset the form whenever the user selects a different story so they don't
    // accidentally submit a previous story's storyline to a new storyId.
    React.useEffect(() => {
        setStoryline('');
        setChapterCount(3);
        setError('');
    }, [selected?.id]);

    // No selected story → render nothing (the header will show the Add button).
    // Mirrors SectionUserInput.tsx:14 (`if (!store.selected.hasOwnProperty('memory')) return null;`).
    if (!selected) return null;

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
        try {
            // POST to the server. The server validates and returns { storyId }.
            await createNewStory(store.config.baseUrl, selected.storyId, {
                storyline: storyline.trim(),
                chapterCount
            });

            // On success, persist storyline + chapterCount on the selected entry
            // so SectionStoryContent's effect picks up the change (chapterCount
            // becoming > 0 is the trigger that starts the polling loop).
            const entryId = selected.id;
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === entryId
                        ? {
                              ...e,
                              storyline: storyline.trim(),
                              chapterCount,
                              isProcessing: true,
                              error: ''
                          }
                        : e
                ),
                selected:
                    prev.selected?.id === entryId
                        ? (prev.records
                              .map((e) =>
                                  e.id === entryId
                                      ? {
                                            ...e,
                                            storyline: storyline.trim(),
                                            chapterCount,
                                            isProcessing: true,
                                            error: ''
                                        }
                                      : e
                              )
                              .find((e) => e.id === entryId) ?? prev.selected)
                        : prev.selected
            }));

            // Clear the storyline textarea post-submit so the user can immediately
            // start the next one (chapterCount is preserved as a convenience).
            setStoryline('');
        } catch (err: any) {
            // Surface the server's error message (createNewStory already parses it).
            setError(err?.message ?? 'Failed to create story');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <FooterColumn data-testid="story-input">
            <StorylineTextarea
                data-testid="storyline-input"
                placeholder="Storyline — e.g. A sci-fi adventure about a crew discovering an ancient alien artifact on Mars."
                value={storyline}
                onChange={(e) => setStoryline(e.target.value)}
                disabled={isSubmitting}
            />
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
                    disabled={isSubmitting || selected.isProcessing}
                    data-testid="generate-button"
                >
                    {selected.isProcessing || isSubmitting ? 'Generating…' : 'Generate'}
                </GenerateButton>
            </ControlRow>
            {error && <ErrorLine data-testid="input-error">{error}</ErrorLine>}
        </FooterColumn>
    );
});
