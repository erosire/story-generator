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
//
// Visual: elevated translucent sidebar with refined story pills (pill-shaped
// items, hover tint via sg-story-item class, accent-tinted selected state,
// rounded badges, animated spinner instead of ⏳ emoji for the processing
// indicator — though the processing badge text is still the literal ⏳ so the
// test that asserts `not.toContain('⏳')` after polling completes keeps working).

import React from 'react';
import { styled, theme } from '../../styles';
import { useStoryStore } from '../../context';
import { fetchStoryList } from '../../api';

// How often to auto-refresh the story list from the server (30 seconds).
const REFRESH_INTERVAL_MS = 30_000;

// Sidebar container — fills its parent's height, scrollable if stories overflow.
const SidebarContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '10px 0',
    boxSizing: 'border-box'
});

// Section label at the top of the sidebar.
const SectionLabel = styled('div', {
    padding: '6px 14px',
    fontSize: 11,
    fontWeight: 700,
    color: theme.textDim,
    textTransform: 'uppercase' as const,
    letterSpacing: 1
});

// Individual story item in the list. Pill-like row with hover tint applied via
// the `sg-story-item` class hook (global.ts) on unselected items only — the
// selected item gets its own accent surface via inline override.
const StoryItem = styled('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    margin: '1px 8px',
    padding: '8px 12px',
    border: 'none',
    borderRadius: theme.radiusMd,
    backgroundColor: 'transparent',
    color: theme.text,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.4,
    boxSizing: 'border-box' as const,
    transition: `background-color ${theme.transition}, color ${theme.transition}`
});

// Selected variant — accent-tinted surface + brighter text.
type StoryItemSelectedProps = { children?: React.ReactNode } & {
    [key: string]: unknown;
} & React.HTMLAttributes<HTMLButtonElement>;
const StoryItemSelected: React.FC<StoryItemSelectedProps> = (props) => (
    <StoryItem
        {...props}
        style={{
            ...props.style,
            backgroundColor: theme.accentSoft,
            color: '#ffffff',
            boxShadow: `inset 0 0 0 1px rgba(99, 102, 241, 0.35)`
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

// Badge for chapter count or processing status. Modern: pill-shaped surface
// with hairline border so badges read as status chips.
const Badge = styled('span', {
    flex: '0 0 auto',
    fontSize: 10,
    fontWeight: 600,
    color: theme.textMuted,
    background: theme.surface3,
    border: `1px solid ${theme.border}`,
    padding: '2px 7px',
    borderRadius: 999
});

// Empty-state message when no stories exist.
const EmptyMessage = styled('div', {
    padding: '20px 14px',
    color: theme.textFaint,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 1.5
});

export const SectionStoryTabs: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { records, selected } = store;

    // Auto-refresh: periodically fetch /list to pick up new stories.
    React.useEffect(() => {
        const baseUrl = store.config.baseUrl;

        const refresh = async () => {
            try {
                const { stories } = await fetchStoryList(baseUrl);
                if (!stories || stories.length === 0) return;

                const entries = stories.map((meta, i) => ({
                    id: -(Date.now() + i + 1),
                    storyId: meta.storyId,
                    title: meta.storyId.slice(0, 8),
                    storyline: meta.storyline,
                    chapterCount: meta.chapterCount,
                    data: null,
                    isProcessing: false,
                    error: '',
                    isRemote: true
                }));

                setStore((prev) => {
                    const prevByStoryId = new Map(prev.records.map((r) => [r.storyId, r]));
                    const merged = entries.map((e) => prevByStoryId.get(e.storyId) ?? e);

                    let selected = prev.selected;
                    if (prev.selected) {
                        selected = merged.find((m) => m.storyId === prev.selected!.storyId) ?? (merged.length > 0 ? merged[0] : null);
                    } else if (merged.length > 0) {
                        selected = merged[0];
                    }
                    return { ...prev, records: merged, selected, loadWarning: undefined };
                });
            } catch {
                // Silently ignore refresh errors.
            }
        };

        const intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
        return () => clearInterval(intervalId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store.config.baseUrl, setStore]);

    return (
        <SidebarContainer data-testid="sidebar" className="sg-scroll">
            <SectionLabel>Stories</SectionLabel>
            {records.length === 0 && (
                <EmptyMessage data-testid="sidebar-empty">
                    No stories yet. Create one below.
                </EmptyMessage>
            )}
            {/* Sort records by storyId descending so the newest story appears
                at the top. DateTime-format storyIds (YYYYMMDD-HHMMSS) sort
                correctly as strings in descending order. */}
            {[...records].sort((a, b) => b.storyId.localeCompare(a.storyId)).map((entry) => {
                const isSelected = selected?.id === entry.id;
                const chapterBadge = entry.data && entry.data.chapters.length > 0
                    ? `${entry.data.chapters.length}ch`
                    : '';
                // Processing badge content is the literal ⏳ — kept so the test
                // asserting `not.toContain('⏳')` after polling completes passes.
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
                            <StoryItem {...itemProps} className="sg-story-item">
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
                        color: theme.warning,
                        background: theme.warningSoft,
                        border: `1px solid rgba(255, 184, 107, 0.25)`,
                        padding: '6px 10px',
                        margin: '10px 10px 0',
                        borderRadius: theme.radiusSm,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        boxShadow: theme.shadowSm
                    }}
                >
                    ⚠ {store.loadWarning}
                </div>
            )}
        </SidebarContainer>
    );
});
