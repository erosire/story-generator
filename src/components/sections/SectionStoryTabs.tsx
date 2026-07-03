// Header section: horizontal scrollable list of story tabs (one per created story).
//
// Mirrors library/workflow/lightning-agent/components/SectionScrollableTab.tsx:
//   - reads records from the reactive store
//   - each tab is a chip: label = story title (derived from storyId), with an
//     isProcessing indicator if the story is still being generated
//   - clicking a tab selects it (store.selected = entry)
//   - each tab has a remove (x) button that drops it from records
//
// Stories are created via the Generate button in SectionStoryInput, which
// generates a new storyId locally and POSTs to the server. There is no
// separate "Add" button — clicking Generate both creates the story entry
// and triggers generation.

import React from 'react';
import { styled } from '../../styles';
import { useStoryStore } from '../../context';
import { fetchStoryList } from '../../api';

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

    // Refresh the record list from the server's /list endpoint. Used by the
    // Refresh button to pick up stories that other sessions/devices created in
    // this dashboard's absence, or to recover after a BootstrapLayer failure.
    // We preserve selected by storyId so the active story stays active after
    // the reload; entries that no longer exist on the server are removed.
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const refreshStories = async () => {
        setIsRefreshing(true);
        try {
            const { stories } = await fetchStoryList(store.config.baseUrl);
            // Preserve ordering/styling of BootstrapLayer: derivatives are
            // negative ids so they don't collide with new Date.now() ids.
            const entries = stories.map((sid, i) => ({
                id: -(Date.now() + i + 1),
                storyId: sid,
                title: sid.slice(0, 8),
                storyline: '',
                chapterCount: 0,
                data: null,
                isProcessing: false,
                error: '',
                // Refresh entries come from the server's /list endpoint — same
                // as BootstrapLayer, mark them remote so the polling effect
                // hydrates their data on selection.
                isRemote: true
            }));
            setStore((prev) => {
                // Build a lookup by storyId for previously-loaded data. We want
                // to preserve any cached chapter data / isProcessing flags the
                // user picked up by selecting entries during this session.
                const prevByStoryId = new Map(prev.records.map((r) => [r.storyId, r]));
                const merged = entries.map((e) => {
                    const cached = prevByStoryId.get(e.storyId);
                    return cached ?? e;
                });
                // Re-select the previously-selected entry by storyId; if it's now
                // gone from the server list, fall back to the first entry (or null).
                let selected = prev.selected;
                if (prev.selected) {
                    selected = merged.find((m) => m.storyId === prev.selected!.storyId) ?? (merged.length > 0 ? merged[0] : null);
                } else if (merged.length > 0) {
                    selected = merged[0];
                }
                return { ...prev, records: merged, selected, loadWarning: undefined };
            });
        } catch (err: any) {
            setStore((prev) => ({ ...prev, loadWarning: err?.message ?? 'Failed to refresh story list' }));
        } finally {
            setIsRefreshing(false);
        }
    };

    return (
        <>
            {/* A small inline warning if BootstrapLayer failed to load —
                shown before the tab row so the user knows the backend is
                unreachable but can still use the dashboard. */}
            {store.loadWarning && (
                <span
                    data-testid="load-warning"
                    title={store.loadWarning}
                    style={{
                        fontSize: 11,
                        color: '#ff9b6b',
                        background: 'rgba(255, 107, 107, 0.08)',
                        padding: '2px 6px',
                        borderRadius: 4,
                        whiteSpace: 'nowrap',
                        flex: '0 0 auto'
                    }}
                >
                    ⚠ {store.loadWarning}
                </span>
            )}
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
            {/* Refresh icon button re-fetches the /list endpoint. Visible whether
                or not records exist so the user can recover from a BootstrapLayer
                load failure without reloading the page. */}
            <AddButton
                onClick={refreshStories}
                aria-label="Refresh story list"
                data-testid="refresh-stories-button"
                disabled={isRefreshing}
                style={{ borderStyle: 'solid' }}
            >
                {isRefreshing ? '…' : '⟳'}
            </AddButton>
        </>
    );
});
