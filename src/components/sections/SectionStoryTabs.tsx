// Sidebar section: vertical list of all stories in order.
//
// Replaces the previous horizontal tab bar. Each tile shows the story title,
// a chapter-count badge, a processing indicator, and an "x" delete control
// pinned to the tile's top-right corner. Clicking the tile body selects it
// (store.selected = entry) so the content area displays that story; clicking
// the "x" permanently deletes that story (identified DELETE).
//
// The "Stories" header carries a live job-count chip (data-testid
// "sidebar-job-count", text "<n> running") showing how many background
// threads are currently in flight on the server — see inProgressCount below
// for how the server registry snapshot (store.activeJobs) combines with this
// session's local processing flags.
//
// No manual refresh button — the sidebar auto-refreshes periodically by polling
// GET /v1/storyboard/generations to pick up stories created by other
// sessions/devices and the server's live background-job flags.
//
// Auto-refresh behavior:
//   - On mount, fetches the collection once (via BootstrapLayer) to seed the store.
//   - A useEffect runs every REFRESH_INTERVAL_MS (30s) — or ACTIVE_REFRESH_INTERVAL_MS
//     (5s) while any story is processing — to re-fetch the collection and merge
//     new entries while preserving the current selection, any locally-cached
//     chapter data, and any cache-only stories that are missing from the server
//     response (they stay visible — deleting them purges the local cache without
//     a server call). See mergeServerStoryList.
//   - Errors surface as a non-blocking loadWarning (same as BootstrapLayer).
//
// Background-processing animation:
//   A tile animates while its story has a background thread in flight. Two
//   sources feed it: entry.isProcessing (this session's poll loops) and
//   entry.serverProcessing (the server job registry's per-story flag from the
//   list response — covers jobs started by OTHER sessions/devices, including
//   chapter expansions/rewrites which never set isProcessing). The animation
//   itself is two flat-design pieces: an .sg-spinner ring inside the ⏳ badge
//   chip, and a .sg-story-processing surface pulse on the tile (styles/global.ts).
//
// Visual: elevated translucent sidebar with modern story TILES. Each tile is
// a card-like button (elevated solid surface, hairline border, radius-lg
// corners) with the story title on the first row and status badges on a
// second row. Hover swaps to a brighter surface + crisper border via the
// sg-story-item class hook; the selected tile reads as an elevated "active
// card" (accent-tinted translucent surface, crisp accent border, brighter
// accent rail) via the sg-story-selected class hook. Badges are rounded
// status chips; the processing badge text is still the literal ⏳ so the
// test that asserts `not.toContain('⏳')` after polling completes keeps
// working (App.test.tsx:625).

import React from 'react';
import { styled, theme } from '../../styles';
import { useStoryStore } from '../../context';
import { fetchStoryList } from '../../api';
import { mergeServerStoryList } from '../../context/store';

// How often to auto-refresh the story list from the server when the dashboard
// looks idle (30 seconds).
const REFRESH_INTERVAL_MS = 30_000;

// How often to auto-refresh while any story is being processed in the
// background. The list response carries the server's live job-registry flags
// (StoryMeta.processing), so this faster cadence is what makes the sidebar's
// processing animation appear/disappear near-live — including for background
// jobs started by OTHER sessions/devices. 5s keeps the animation responsive
// without hammering the server.
const ACTIVE_REFRESH_INTERVAL_MS = 5_000;

// Sidebar container — fills its parent's height, scrollable if stories overflow.
const SidebarContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '12px 0',
    boxSizing: 'border-box'
});

// Section label at the top of the sidebar. Flex row so the live job-count
// chip (JobCountBadge) sits inline after the "Stories" text.
const SectionLabel = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '6px 16px 8px',
    fontSize: theme.fontSize.sm,
    fontWeight: 700,
    color: theme.textDim,
    textTransform: 'uppercase' as const,
    letterSpacing: 1.2
});

// Live background-thread count chip inside the "Stories" header — rendered
// only while jobs are in flight. Same pill treatment as the tile status
// badges (Badge/BadgeActive family: pill radius, hairline border, accent
// tint) so the header chip and tile chips read as one visual family. Resets
// the label's uppercase/letter-spacing so the count text stays legible.
const JobCountBadge = styled('span', {
    flex: '0 0 auto',
    display: 'inline-flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 18,
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
    marginLeft: 8,
    padding: '0 7px',
    borderRadius: 999,
    fontSize: theme.fontSize.xs,
    lineHeight: 1,
    fontWeight: 600,
    color: '#e0e1ff',
    background: 'rgba(129, 140, 248, 0.35)',
    border: '1px solid rgba(199, 205, 252, 0.45)',
    textTransform: 'none' as const,
    letterSpacing: 0
});

// Positioning context for each story tile. Holds the select button (fills the
// tile) and the "x" delete control (absolutely pinned to the tile's top-right
// corner) as SIBLINGS — the x is not nested in the select button (nested
// interactive elements are invalid HTML, and clicks would bubble into a story
// selection). Mirrors the chat-assistant sidebar's ChatEntry +
// ConversationDeleteButton pattern.
const StoryEntry = styled('div', {
    position: 'relative',
    // Generous vertical rhythm so the card-like tiles read as separate cards
    // instead of a single striped list.
    margin: '5px 10px'
});

// Individual story item — a modern TILE rather than a bare button row. Card
// treatment: elevated solid surface2 over the sidebar's surface1, a crisp
// hairline border, and radius-lg corners. The column layout stacks the title
// (first row) over a meta row of status badges (second row), which reads as a
// card and gives long titles a full row to render on before truncating.
// Hover surface/border swap is applied via the `sg-story-item` class hook
// (global.ts) on unselected tiles only — the selected tile uses its own
// accent treatment below.
//
// The element stays a <button> (with data-testid/aria-pressed) — that is part
// of the public test contract (App.test.tsx:410-412 finds tabs via
// getByRole('button')). Only the presentation is tiled.
const StoryItem = styled('button', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 7,
    width: '100%',
    // Deep right padding keeps the title/badges from sliding under the "x"
    // delete control overlaid in the tile's top-right corner.
    padding: '11px 30px 11px 12px',
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.surface2,
    color: theme.text,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: theme.fontSize.md,
    fontWeight: 500,
    lineHeight: 1.35,
    boxSizing: 'border-box' as const,
    transition: `background-color ${theme.transition}, border-color ${theme.transition}, color ${theme.transition}`
});

// Selected variant — modern "active card" treatment. Instead of the old solid
// accent FILL, the selected tile is an accent-tinted translucent surface with
// a crisp accent border plus a brighter accent rail applied via the
// `sg-story-selected` class hook (global.ts ::before). Flat: no gradient, no
// glow, no shadow — the card reads as the current pick purely through tint +
// border + rail.
//
// Using a dedicated styled button (not StoryItem + inline override) keeps the
// selected tile's typography, padding, and weight consistent with itself.
const StoryItemSelected = styled('button', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 7,
    width: '100%',
    // Deep right padding so title/badges never slide under the overlaid "x"
    // delete control; slightly deeper left padding leaves room for the accent
    // rail drawn inside the left border by .sg-story-selected::before.
    padding: '11px 30px 11px 16px',
    border: `1px solid ${theme.accent}`,
    borderRadius: theme.radiusLg,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: theme.fontSize.md,
    fontWeight: 600,
    lineHeight: 1.35,
    boxSizing: 'border-box' as const,
    // Inline background is set to the accent-tinted surface so the tile
    // renders correctly even if the global stylesheet hasn't been injected
    // yet (eg. during SSR). The .sg-story-selected class sets the same
    // background; both agree.
    backgroundColor: theme.accentSoft,
    color: '#ffffff',
    // Flat: no shadow. The accent border + rail supply the visual emphasis.
    transition: `background-color ${theme.transition}, border-color ${theme.transition}, color ${theme.transition}`
});

// Second row inside a tile — holds the status badges (chapter count,
// processing indicator) as a horizontal chip cluster under the title.
// ALWAYS rendered (even when it carries no badges) so every tile has the
// same two-row structure and a constant height: row 1 = title (+ the
// absolutely-pinned "x"), row 2 = details. The fixed 20px height reserves
// the chip space on badgeless tiles instead of collapsing the row, which
// would otherwise make tile heights jitter as badges come and go.
const StoryTileMeta = styled('span', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    maxWidth: '100%',
    height: 20,
    boxSizing: 'border-box' as const
});

// The "x" delete control: absolutely pinned to the top-right corner of a story
// tile (StoryEntry is its positioning context). It is a SIBLING of the select
// button inside the entry — not nested in it — so clicking the x deletes the
// story without triggering its selection. Muted by default, reusing the
// `sg-danger` class hook (global.ts) for destructive hover + disabled dimming.
const StoryDeleteButton = styled('button', {
    position: 'absolute',
    top: 9,
    right: 9,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 22,
    minHeight: 22,
    padding: 0,
    border: 'none',
    borderRadius: theme.radiusSm,
    backgroundColor: 'transparent',
    color: theme.textMuted,
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: 1,
    transition: `background-color ${theme.transition}, color ${theme.transition}, opacity ${theme.transition}`
});

// Title text — first row of the tile. Spans the tile's full (padded) width
// and truncates with an ellipsis if too long.
const StoryTitle = styled('span', {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const
});

// Badge for chapter count or processing status. Modern: pill-shaped surface
// with hairline border so badges read as status chips on the unselected tile.
// The chip height is pinned to exactly 20px (matching the StoryTileMeta row)
// via display:inline-flex + fixed height: the ⏳ processing glyph renders in
// a system emoji font whose intrinsic size is larger than the 10px chip font
// and would otherwise stretch the chip (and the tile) taller — odd one out.
const Badge = styled('span', {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // gap spaces the animated spinner ring from the ⏳ glyph inside the
    // processing chip (single-child chips are unaffected).
    gap: 4,
    height: 20,
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
    fontSize: theme.fontSize.xs,
    lineHeight: 1,
    fontWeight: 600,
    color: theme.textMuted,
    background: theme.surface3,
    border: `1px solid ${theme.border}`,
    padding: '0 7px',
    borderRadius: 999
});

// Selected-tile badge — accent-tinted chip that stays legible on the
// accent-tinted "active card" surface instead of blending into it like the
// default Badge. Same pinned 20px chip height as Badge (see above).
const BadgeActive = styled('span', {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // gap spaces the animated spinner ring from the ⏳ glyph inside the
    // processing chip (single-child chips are unaffected).
    gap: 4,
    height: 20,
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
    fontSize: theme.fontSize.xs,
    lineHeight: 1,
    fontWeight: 700,
    color: '#e0e1ff',
    background: 'rgba(129, 140, 248, 0.35)',
    border: '1px solid rgba(199, 205, 252, 0.45)',
    padding: '0 7px',
    borderRadius: 999
});

// Empty-state message when no stories exist.
const EmptyMessage = styled('div', {
    padding: '20px 14px',
    color: theme.textFaint,
    fontSize: theme.fontSize.md,
    fontStyle: 'italic',
    lineHeight: 1.5
});

export const SectionStoryTabs: React.FC = React.memo(() => {
    const { store, setStore, deleteStory } = useStoryStore();
    const { records, selected } = store;

    // Single in-flight delete guard, mirroring the chat-assistant sidebar:
    // while any delete request is outstanding, every tile's "x" is disabled so
    // a second delete cannot race the active identified DELETE request.
    const [deleting, setDeleting] = React.useState(false);

    const handleDelete = React.useCallback(
        async (storyId: string) => {
            if (deleting) return;
            setDeleting(true);
            try {
                await deleteStory(storyId);
            } catch (err) {
                console.error('Failed to delete story:', err);
            } finally {
                setDeleting(false);
            }
        },
        [deleting, deleteStory]
    );

    // True when ANY story has background work in flight — either a job this
    // session started (isProcessing, set by the poll loops) or a job the
    // server's registry reports (serverProcessing, from StoryMeta.processing,
    // which also covers jobs started by other sessions/devices). Drives the
    // adaptive refresh cadence below.
    const anyProcessing = records.some((r) => r.isProcessing || r.serverProcessing === true);

    // Background-thread count for the "Stories" header badge. Two sources,
    // combined with max() so the count is BOTH exact and instant:
    //   - store.activeJobs — the server registry snapshot from the last list
    //     sync. This is the exact thread count (a single story can run several
    //     jobs concurrently, e.g. a create plus chapter expansions) but it is
    //     only as fresh as the last fetch.
    //   - locally-flagged processing stories — every entry with isProcessing
    //     (this session's flows set it the moment Generate/expand fires, BEFORE
    //     any list sync lands) or serverProcessing (arrived in the SAME response
    //     as the snapshot) holds at least one live thread. One per story, so
    //     this is a lower bound that covers the sync gap right after this
    //     session starts a job while the cadence is still the slow 30s one.
    // max() also degrades gracefully: if isProcessing lingers after a server
    // restart killed the job, the badge keeps showing that minimum until the
    // poll loop terminates — the same contract the tile animation follows.
    const serverJobCount = store.activeJobs.length;
    const localProcessingCount = records.filter((r) => r.isProcessing || r.serverProcessing === true).length;
    const inProgressCount = Math.max(serverJobCount, localProcessingCount);

    // Auto-refresh: periodically fetch collection to pick up new stories AND
    // the server's live background-job flags. Uses the same cache↔server
    // merge as the initial bootstrap (see mergeServerStoryList in
    // src/context/store.tsx): server metadata refreshes cached entries
    // (including serverProcessing), new server stories are added, and
    // cache-only stories stay visible (flagged missingFromServer). The merged
    // records are written back to localStorage by the store's auto-persist
    // effect — this is the "repeat at interval" leg of the cache-first cycle.
    //
    // Adaptive cadence: 30s while idle, 5s while anyProcessing so the
    // processing animation on the tiles tracks the server's job registry
    // closely instead of lagging a full idle interval behind the job's
    // start/finish. Re-subscribing the interval when anyProcessing flips is
    // safe — the refresh closure itself is unchanged.
    React.useEffect(() => {
        const baseUrl = store.config.baseUrl;

        const refresh = async () => {
            try {
                const { stories, jobs } = await fetchStoryList(baseUrl);
                setStore((prev) => {
                    // activeJobs updates in BOTH branches — the `jobs` array is
                    // authoritative on its own (an empty registry is a real
                    // answer: the in-memory registry blanks on restart), unlike
                    // an empty story list which is "no information" for records.
                    // Empty server list → null: keep the cached records as-is
                    // (the cache may hold stories the server lost; only a
                    // non-empty response is a trustworthy sync signal).
                    const merged = mergeServerStoryList(prev, stories ?? []);
                    if (!merged) return { ...prev, activeJobs: jobs ?? [] };
                    return { ...prev, records: merged.records, selected: merged.selected, activeJobs: jobs ?? [], loadWarning: undefined };
                });
            } catch {
                // Silently ignore refresh errors — cached records remain the
                // displayed source of truth while the server is unreachable.
            }
        };

        const intervalId = setInterval(refresh, anyProcessing ? ACTIVE_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS);
        return () => clearInterval(intervalId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store.config.baseUrl, setStore, anyProcessing]);

    return (
        <SidebarContainer data-testid="sidebar" className="sg-scroll">
            {/* Header label + live background-thread count. The chip renders only
                while inProgressCount > 0 — an idle server shows the bare label.
                data-testid="sidebar-job-count" is the test contract; textContent
                is exactly "<n> running" (the spinner ring contributes no text). */}
            <SectionLabel>
                Stories
                {inProgressCount > 0 && (
                    <JobCountBadge
                        data-testid="sidebar-job-count"
                        title={`${inProgressCount} background job${inProgressCount === 1 ? '' : 's'} in progress`}
                    >
                        <span className="sg-spinner" aria-hidden="true" />
                        {inProgressCount} running
                    </JobCountBadge>
                )}
            </SectionLabel>
            {records.length === 0 && (
                <EmptyMessage data-testid="sidebar-empty">
                    No stories yet. Create one below.
                </EmptyMessage>
            )}
            {/* Sort records by createdDate descending so the newest story appears
                at the top. ISO 8601 timestamps sort correctly as strings in
                descending order. */}
            {[...records].sort((a, b) => b.createdDate.localeCompare(a.createdDate)).map((entry) => {
                const isSelected = selected?.id === entry.id;
                const chapterBadge = entry.data?.chapters && entry.data.chapters.length > 0
                    ? `${entry.data.chapters.length}ch`
                    : '';
                // Processing state combines BOTH sources of live background
                // work: isProcessing (this session's poll loops) and
                // serverProcessing (the server's job-registry flag, which
                // also covers jobs started by other sessions/devices).
                const isProcessing = entry.isProcessing || entry.serverProcessing === true;
                // Processing badge content is the literal ⏳ — kept so the test
                // asserting `not.toContain('⏳')` after polling completes passes.
                // The animated sg-spinner ring sits inside the same chip and
                // contributes no text content.
                const processingBadge = isProcessing ? '⏳' : '';

                const itemProps = {
                    onClick: () => setStore((prev) => ({ ...prev, selected: entry })),
                    'data-testid': `story-tab-${entry.storyId}`,
                    'aria-pressed': isSelected
                };

                // Animated tile treatment while the story has a live
                // background thread: the .sg-story-processing class hook
                // (styles/global.ts) pulses the tile's surface so the whole
                // card reads as "working". Applied on both variants; the
                // stylesheet scopes the pulse colors per variant.
                const processingClass = isProcessing ? ' sg-story-processing' : '';

                // The details row (StoryTileMeta) is rendered UNCONDITIONALLY
                // — an empty row keeps every tile at the same two-row height,
                // so toggling badges (processing start/stop, chapters loading)
                // never resizes a tile mid-list.
                return (
                    <StoryEntry key={entry.id}>
                        {isSelected ? (
                            <StoryItemSelected {...itemProps} className={`sg-story-selected${processingClass}`}>
                                <StoryTitle>{entry.title}</StoryTitle>
                                <StoryTileMeta>
                                    {chapterBadge && <BadgeActive>{chapterBadge}</BadgeActive>}
                                    {processingBadge && (
                                        <BadgeActive>
                                            {isProcessing && <span className="sg-spinner" aria-hidden="true" />}
                                            {processingBadge}
                                        </BadgeActive>
                                    )}
                                </StoryTileMeta>
                            </StoryItemSelected>
                        ) : (
                            <StoryItem {...itemProps} className={`sg-story-item${processingClass}`}>
                                <StoryTitle>{entry.title}</StoryTitle>
                                <StoryTileMeta>
                                    {chapterBadge && <Badge>{chapterBadge}</Badge>}
                                    {processingBadge && (
                                        <Badge>
                                            {isProcessing && <span className="sg-spinner" aria-hidden="true" />}
                                            {processingBadge}
                                        </Badge>
                                    )}
                                </StoryTileMeta>
                            </StoryItem>
                        )}
                        {/* "x" delete — absolutely pinned to the tile's top-right
                            corner as a SIBLING of the select button above. */}
                        <StoryDeleteButton
                            onClick={() => void handleDelete(entry.storyId)}
                            disabled={deleting}
                            className="sg-danger"
                            aria-label={`Delete story ${entry.title}`}
                            title={`Delete story ${entry.title}`}
                            data-testid={`story-delete-${entry.storyId}`}
                        >
                            ×
                        </StoryDeleteButton>
                    </StoryEntry>
                );
            })}
            {/* Load warning — shown if BootstrapLayer or auto-refresh failed. */}
            {store.loadWarning && (
                <div
                    data-testid="load-warning"
                    title={store.loadWarning}
                    style={{
                        fontSize: theme.fontSize.sm,
                        color: theme.warning,
                        background: theme.warningSoft,
                        border: `1px solid rgba(251, 191, 36, 0.25)`,
                        padding: '6px 10px',
                        margin: '10px 10px 0',
                        borderRadius: theme.radiusSm,
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
