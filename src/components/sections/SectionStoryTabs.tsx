// Header section: horizontal scrollable list of story tabs (one per created story)
// plus an "Add" button to create a new (empty) story entry.
//
// Mirrors library/workflow/lightning-agent/components/SectionScrollableTab.tsx:
//   - reads records from the reactive store
//   - each tab is a chip: label = story title (derived from storyId), with an
//     isProcessing indicator if the story is still being generated
//   - clicking a tab selects it (store.selected = entry)
//   - each tab has a remove (x) button that drops it from records
//
// Unlike lightning-agent, we don't create the network resource on "Add" — the
// empty entry is created locally and only POSTed to the server when the user
// submits a storyline from SectionStoryInput. This separates "intend to create
// a story" from "trigger generation", matching the storyboard POST API which
// requires the storyline + chapterCount body to start generating.

import React from 'react';
import { styled } from '../../styles';
import { useStoryStore } from '../../context';

// Tab chip. Shows the storyId-derived title; flags in-progress generation with
// a small spinner glyph and a word-count badge once data arrives.
const TabChip = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 16,
    fontSize: 13,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: '#e0e0e0',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flex: '0 0 auto'
});

// Selected variant — visually distinct from unselected chips.
// Uses a permissive prop type so arbitrary `data-*` attrs (e.g. test ids) pass.
type TabChipSelectedProps = { children?: React.ReactNode } & {
    [key: string]: unknown;
} & React.HTMLAttributes<HTMLButtonElement>;
const TabChipSelected: React.FC<TabChipSelectedProps> = (props) => (
        // The override is applied after the base style via the spread (lower in
        // the cascade wins in plain objects), giving the selected chip a solid bg.
        <TabChip {...props} style={{ ...props.style, backgroundColor: '#3a6ea5', borderColor: '#5a9fe0' }}>
            {props.children}
        </TabChip>
    );

// Remove (x) glyph — uses plain text since this package has no icon set.
const RemoveGlyph: React.FC<{ onClick: (e: React.MouseEvent) => void }> = ({ onClick }) => (
    // Stop propagation so the click doesn't also reselect the tab.
    <span
        role="button"
        aria-label="Remove story tab"
        onClick={(e) => {
            e.stopPropagation();
            onClick(e);
        }}
        style={{ opacity: 0.6, fontWeight: 'bold', padding: '0 2px' }}
    >
        ✕
    </span>
);

// "Add" button — a square icon-like button appended after the chip row.
const AddButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    flex: '0 0 auto',
    borderRadius: 16,
    border: '1px dashed rgba(255, 255, 255, 0.25)',
    backgroundColor: 'transparent',
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: 18
});

export const SectionStoryTabs: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { records, selected } = store;

    // Remove a story from records (and clear selection if it was the active one).
    const removeStory = (id: number) => {
        setStore((prev) => {
            const filtered = prev.records.filter((e) => e.id !== id);
            // If the removed entry was selected, fall back to the last remaining
            // entry (or null if none left) — mirrors SectionScrollableTab.tsx:40-46.
            const nextSelected =
                prev.selected?.id === id
                    ? filtered.length > 0
                        ? filtered[filtered.length - 1]
                        : null
                    : prev.selected;
            return { ...prev, records: filtered, selected: nextSelected };
        });
    };

    // Add a new *empty* entry. storyId is generated client-side as a UUID-like
    // string (crypto.randomUUID when available, falling back to a timestamp+random
    // blob). The actual POST to the server happens later, in SectionStoryInput,
    // when the user supplies the storyline + chapterCount.
    const addStory = () => {
        const id = Date.now();
        // crypto.randomUUID is available in modern browsers and jsdom (node 19+).
        // Fall back to a deterministic-ish id for older test runners.
        const storyId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `story-${id}-${Math.random().toString(36).slice(2, 10)}`;

        const entry = {
            id,
            storyId,
            // Title holds a placeholder until generation produces plotlines; once
            // data arrives SectionStoryContent/SectionStoryTabs can re-derive it.
            title: storyId.slice(0, 8),
            storyline: '',
            chapterCount: 0,
            data: null,
            isProcessing: false,
            error: ''
        };

        setStore((prev) => ({
            ...prev,
            records: [...prev.records, entry],
            selected: entry
        }));
    };

    return (
        <>
            {records.map((entry) => {
                const isSelected = selected?.id === entry.id;
                // Chip label: title + (chapter count badge once data exists).
                const chapterBadge = entry.data && entry.data.chapters.length > 0
                    ? ` · ${entry.data.chapters.length}ch`
                    : '';
                const processingBadge = entry.isProcessing ? ' ⏳' : '';

                // chipProps loose-typed so kebab-case data-* / aria-* attrs pass TS.
                const chipProps: { onClick: () => void; 'data-testid': string; 'aria-pressed': boolean } = {
                    onClick: () =>
                        setStore((prev) => ({ ...prev, selected: entry })),
                    'data-testid': `story-tab-${entry.storyId}`,
                    'aria-pressed': isSelected
                };

                return (
                    // key by entry.id (stable across store updates) — storyId is
                    // generated at creation so it's also stable, but id (timestamp)
                    // is enough.
                    <React.Fragment key={entry.id}>
                        {isSelected ? (
                            <TabChipSelected {...chipProps}>
                                <span>{entry.title}{chapterBadge}{processingBadge}</span>
                                <RemoveGlyph onClick={() => removeStory(entry.id)} />
                            </TabChipSelected>
                        ) : (
                            <TabChip {...chipProps}>
                                <span>{entry.title}{chapterBadge}{processingBadge}</span>
                                <RemoveGlyph onClick={() => removeStory(entry.id)} />
                            </TabChip>
                        )}
                    </React.Fragment>
                );
            })}
            <AddButton onClick={addStory} aria-label="Add new story" data-testid="add-story-button">
                +
            </AddButton>
        </>
    );
});
