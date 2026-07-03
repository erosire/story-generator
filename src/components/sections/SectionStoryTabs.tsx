// Sidebar section: vertical list of all stories in order.
//
// Replaces the previous horizontal tab bar. Each item shows the story title,
// a chapter-count badge, and a processing indicator. Clicking an item selects
// it (store.selected = entry) so the content area displays that story.
//
// No remove button — the list is read-only. No manual refresh button — the
// sidebar auto-refreshes periodically by polling GET /list to pick up stories
// created by other sessions/devices.
//
// Auto-refresh behavior:
//   - On mount, fetches /list once (via BootstrapLayer) to seed the store.
//   - A useEffect runs every REFRESH_INTERVAL_MS (30s) to re-fetch /list
//     and merge new entries while preserving the current selection and any
//     locally-cached chapter data.
//   - Errors surface as a non-blocking loadWarning (same as BootstrapLayer).

import React from 'react';
import { styled } from '../../styles';
import { useStoryStore } from '../../context';
import { fetchStoryList } from '../../api';

// How often to auto-refresh the story list from the server (30 seconds).
// Short enough to pick up new stories quickly, long enough to avoid hammering.
const REFRESH_INTERVAL_MS = 30_000;

// Sidebar container — fills its parent's height, scrollable if stories overflow.
const SidebarContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '8px 0',
    boxSizing: 'border-box'
});

// Section label at the top of the sidebar.
const SectionLabel = styled('div', {
    padding: '4px 12px',
    fontSize: 11,
    fontWeight: 600,
    color: '#808080',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5
});

// Individual story item in the list.
const StoryItem = styled('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    backgroundColor: 'transparent',
    color: '#e0e0e0',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: 13,
    lineHeight: 1.4,
    boxSizing: 'border-box' as const,
    transition: 'background-color 0.1s ease'
});

// Selected variant — highlighted background.
type StoryItemSelectedProps = { children?: React.ReactNode } & {
    [key: string]: unknown;
} & React.HTMLAttributes<HTMLButtonElement>;
const StoryItemSelected: React.FC<StoryItemSelectedProps> = (props) => (
    <StoryItem
        {...props}
        style={{
            ...props.style,
            backgroundColor: 'rgba(58, 110, 165, 0.35)',
            color: '#ffffff'
        }}
    >
        {props.children}
    </StoryItem>
);

// Title text — truncated if too long.
const StoryTitle = styled('span', {
    flex: '1 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const
});

// Badge for chapter count or processing status.
const Badge = styled('span', {
    flex: '0 0 auto',
    fontSize: 11,
    color: '#a0a0a0',
    background: 'rgba(255, 255, 255, 0.06)',
    padding: '1px 5px',
    borderRadius: 3
});

// Empty-state message when no stories exist.
const EmptyMessage = styled('div', {
    padding: '16px 12px',
    color: '#6b6b6b',
    fontSize: 13,
    fontStyle: 'italic'
});

export const SectionStoryTabs: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { records, selected } = store;

    // Auto-refresh: periodically fetch /list to pick up new stories.
    // Uses the same merge logic as the old manual Refresh button — preserve
    // the current selection by storyId and keep any locally-cached chapter data.
    React.useEffect(() => {
        const baseUrl = store.config.baseUrl;

        const refresh = async () => {
            try {
                const { stories } = await fetchStoryList(baseUrl);
                if (!stories || stories.length === 0) return;

                // Build entries from the server list, same shape as BootstrapLayer.
                const entries = stories.map((sid, i) => ({
                    id: -(Date.now() + i + 1),
                    storyId: sid,
                    title: sid.slice(0, 8),
                    storyline: '',
                    chapterCount: 0,
                    data: null,
                    isProcessing: false,
                    error: '',
                    isRemote: true
                }));

                setStore((prev) => {
                    // Merge: keep cached data for stories we already know about.
                    const prevByStoryId = new Map(prev.records.map((r) => [r.storyId, r]));
                    const merged = entries.map((e) => prevByStoryId.get(e.storyId) ?? e);

                    // Preserve current selection by storyId.
                    let selected = prev.selected;
                    if (prev.selected) {
                        selected = merged.find((m) => m.storyId === prev.selected!.storyId) ?? (merged.length > 0 ? merged[0] : null);
                    } else if (merged.length > 0) {
                        selected = merged[0];
                    }
                    return { ...prev, records: merged, selected, loadWarning: undefined };
                });
            } catch {
                // Silently ignore refresh errors — the UI already shows whatever
                // records were last loaded. Only the initial bootstrap sets
                // loadWarning since that's the user's first impression.
            }
        };

        // Set up the interval. Run once immediately (the BootstrapLayer handles
        // the initial mount fetch, so we skip the immediate call here to avoid
        // a double-fetch — the interval fires after REFRESH_INTERVAL_MS).
        const intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
        return () => clearInterval(intervalId);
        // Re-subscribe if the baseUrl changes (unlikely in practice, but correct).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store.config.baseUrl, setStore]);

    return (
        <SidebarContainer data-testid="sidebar">
            <SectionLabel>Stories</SectionLabel>
            {records.length === 0 && (
                <EmptyMessage data-testid="sidebar-empty">
                    No stories yet. Create one below.
                </EmptyMessage>
            )}
            {records.map((entry) => {
                const isSelected = selected?.id === entry.id;
                const chapterBadge = entry.data && entry.data.chapters.length > 0
                    ? `${entry.data.chapters.length}ch`
                    : '';
                const processingBadge = entry.isProcessing ? '⏳' : '';

                const itemProps = {
                    onClick: () => setStore((prev) => ({ ...prev, selected: entry })),
                    'data-testid': `story-tab-${entry.storyId}`,
                    'aria-pressed': isSelected
                };

                return (
                    <React.Fragment key={entry.id}>
                        {isSelected ? (
                            <StoryItemSelected {...itemProps}>
                                <StoryTitle>{entry.title}</StoryTitle>
                                {chapterBadge && <Badge>{chapterBadge}</Badge>}
                                {processingBadge && <Badge>{processingBadge}</Badge>}
                            </StoryItemSelected>
                        ) : (
                            <StoryItem {...itemProps}>
                                <StoryTitle>{entry.title}</StoryTitle>
                                {chapterBadge && <Badge>{chapterBadge}</Badge>}
                                {processingBadge && <Badge>{processingBadge}</Badge>}
                            </StoryItem>
                        )}
                    </React.Fragment>
                );
            })}
            {/* Load warning — shown if BootstrapLayer or auto-refresh failed. */}
            {store.loadWarning && (
                <div
                    data-testid="load-warning"
                    title={store.loadWarning}
                    style={{
                        fontSize: 11,
                        color: '#ff9b6b',
                        background: 'rgba(255, 107, 107, 0.08)',
                        padding: '4px 8px',
                        margin: '8px 8px 0',
                        borderRadius: 4,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }}
                >
                    ⚠ {store.loadWarning}
                </div>
            )}
        </SidebarContainer>
    );
});
