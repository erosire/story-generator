// Content section: progressively fetches story data via the GET endpoint and
// renders chapters for the currently selected story.
//
// The API returns a unified chapters array where each chapter includes its
// plotpoints and expansion status. Chapters are displayed as individual
// collapsibles. Within each chapter, plotpoints are listed first, followed by
// the expanded content (or an informational message if not yet expanded).
//
// Polling lifecycle (driven by useEffect on selected.id):
//   1. When a story with chapterRequested > 0 is selected, start a pollStoryData
//      loop (see api/storyboard.ts). Mark entry.isProcessing = true.
//   2. Each onData callback updates the entry's data in the store — chapters
//      appear as soon as plotpoint.json is written, then expand one by one.
//   3. The loop terminates when chapters.length >= chapterRequested, a hard error
//      occurs, or the user selects a different story (cancellation).
//
// Edge cases:
//   - chapterRequested == 0 means the story was added locally but never submitted
//     (storyline form not yet sent). We render an empty-state hint in that case
//     instead of polling.
//   - GET returning 404 right after POST is expected; poll keeps going until the
//     server creates the dir (see generation-create-new-story.ts:236 fire-and-forget).
//   - On unmount or selection change, shouldStop becomes true so the loop exits
//     without dispatching further setState (avoids "state on unmounted component").
//
// Visual: empty/pending/in-progress + chapter cards share a consistent accent
// design language — see src/styles/theme.ts.

import React from 'react';
import { styled, theme } from '../../styles';
import { useStoryStore } from '../../context';
import { pollStoryData, updateChapter, rewriteChapter, fetchStoryData, createNewStory } from '../../api';
import { Collapsible } from '../Collapsible';
import { MarkdownContent } from '../MarkdownContent';
import { getExpandedChapters, setExpandedChapters } from '../../context/store';

// Empty-state placeholder shown when no story is selected. Modern: monospace
// "drawing" glyph + elevated typography for a calm centered hero state.
const EmptyState = styled('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    color: theme.textFaint,
    fontSize: theme.fontSize.xl,
    fontStyle: 'italic',
    letterSpacing: 0.3,
    paddingTop: 48
});

// Hint shown when a story is selected but its generation hasn't been triggered.
// Lives inside an elevated card so the user knows this is the active state.
const PendingSubmitHint = styled('div', {
    color: theme.textMuted,
    padding: 24,
    background: theme.surface1,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusLg,
    lineHeight: 1.6
});

// Section wrapper for the content column.
const ContentColumn = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 16px',
    gap: 18,
    height: '100%',
    boxSizing: 'border-box'
});

// Chapter card wrapper — always rendered as a border box containing plotpoints
// and content. Flat Design: solid surface block + crisp hairline border. No
// shadow — depth comes from the contrast between the card's solid surface2 and
// the inner-Content background.
const ChapterCard = styled('div', {
    background: theme.surface2,
    padding: 16,
    borderRadius: theme.radiusLg,
    border: `1px solid ${theme.border}`
});

// Plotpoints toggle button — right-aligned, button-like appearance.
const PlotpointsButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    padding: '4px 12px',
    fontSize: theme.fontSize.base,
    fontWeight: 500,
    color: theme.textMuted,
    background: theme.surface1,
    border: `1px solid ${theme.border}`,
    borderRadius: 999,
    cursor: 'pointer',
    marginBottom: 10,
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}`
});

// Plotpoints list — shown/hidden by the toggle button.
const PlotpointsList = styled('div', {
    marginBottom: 10
});

// Info message shown when a chapter has not been expanded yet.
const PendingExpansion = styled('div', {
    color: theme.textDim,
    fontSize: theme.fontSize.lg,
    fontStyle: 'italic',
    padding: '8px 0'
});

// Modal overlay for the rewrite dialogue.
const RewriteOverlay = styled('div', {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
});

// Modal dialogue box for rewrite context input.
const RewriteDialog = styled('div', {
    background: '#1e2330',
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusLg,
    padding: 24,
    width: '90%',
    maxWidth: 520,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)'
});

const RewriteDialogTitle = styled('h3', {
    margin: '0 0 12px 0',
    fontSize: theme.fontSize.lg,
    fontWeight: 600,
    color: theme.text
});

const RewriteTextarea = styled('textarea', {
    width: '100%',
    minHeight: 120,
    padding: '10px 12px',
    fontSize: theme.fontSize.base,
    color: theme.text,
    backgroundColor: theme.surface1,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusMd,
    resize: 'vertical' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    boxSizing: 'border-box' as const,
    '&:focus': {
        borderColor: theme.accent
    }
});

const RewriteDialogActions = styled('div', {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 16
});

// Chapter action icon button — compact square button for per-chapter actions
// (re-expand, fork). Uses a fixed-size square with centered icon glyph.
// Disabled state dims and blocks interaction.
const ChapterActionButton: React.FC<{
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
    title?: string;
    children: React.ReactNode;
}> = ({ disabled, onClick, children, ...rest }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        data-testid={rest['data-testid']}
        title={rest['title']}
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            color: disabled ? theme.textFaint : theme.textMuted,
            background: 'transparent',
            border: `1px solid ${disabled ? 'transparent' : theme.border}`,
            borderRadius: theme.radiusMd,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`
        }}
        onMouseEnter={(e) => {
            if (!disabled) {
                e.currentTarget.style.background = theme.surface3;
                e.currentTarget.style.color = theme.accent;
                e.currentTarget.style.borderColor = theme.accent;
            }
        }}
        onMouseLeave={(e) => {
            if (!disabled) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = theme.textMuted;
                e.currentTarget.style.borderColor = theme.border;
            }
        }}
    >
        {children}
    </button>
);

// Inline SVG refresh icon — circular arrow used for the re-expand action.
// Keeps the package icon-free (matches the dashboard convention of inline glyphs).
const RefreshIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        <path
            d="M13.5 8a5.5 5.5 0 0 1-9.88 3.07"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
        />
        <path
            d="M2.5 8a5.5 5.5 0 0 1 9.88-3.07"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
        />
        <path d="M13.5 4v3.5H10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

// Inline SVG fork icon — branch symbol used for the fork action.
// Keeps the package icon-free (matches the dashboard convention of inline glyphs).
const ForkIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        {/* Main stem from top to bottom */}
        <path d="M5 2v12" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        {/* Branch forking right and curving down */}
        <path d="M5 6c0-3 6-3 6 0v4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        {/* Dot at the branch tip */}
        <circle cx={11} cy={10} r={1.2} fill="currentColor" />
    </svg>
);

// Inline SVG extend icon — right-pointing arrow with lines, used for the
// Extend action button that copies plotpoints into the storyline input.
const ExtendIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        {/* Horizontal arrow pointing right */}
        <path d="M2 8h10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <path d="M9 5l3 3-3 3" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

// Inline SVG collapse-all icon — two inward-pointing chevrons, used for the
// collapse-all action button that closes every expanded chapter.
const CollapseAllIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        {/* Top chevron pointing up */}
        <path d="M4 6l4-3 4 3" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Bottom chevron pointing down */}
        <path d="M4 10l4 3 4-3" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

// Inline SVG plus icon — used for the rewrite chapter action button.
// A simple "+" glyph indicating "add / rewrite with custom input".
const RewriteIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        <path d="M8 3v10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <path d="M3 8h10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
);

// Chapters list container — flex column with gap between chapter collapsibles.
const ChapterListContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    paddingBottom: 80
});

// Floating action bar — pinned to the bottom-right of the content area.
// Positioned as a sticky overlay so it stays visible while scrolling chapters.
// Contains action buttons (Extend, etc.) that operate on the current story.
const ActionBar = styled('div', {
    position: 'sticky' as const,
    bottom: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 0',
    zIndex: 5,
    marginTop: -60,
    pointerEvents: 'none' as const
});

// Action button — flat outlined style consistent with the dashboard design
// language. Secondary surface + hairline border, accent fill on hover.
const ActionButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    fontSize: theme.fontSize.body,
    fontWeight: 600,
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface2,
    color: theme.text,
    cursor: 'pointer',
    pointerEvents: 'auto' as const,
    transition: `background-color ${theme.transition}, border-color ${theme.transition}, color ${theme.transition}`
});

// In-progress status banner — flat solid accent-tinted surface + accent border
// so the user notices generation is running without the connotation of red.
const ProgressBanner = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: theme.text,
    fontSize: theme.fontSize.base,
    fontWeight: 500,
    padding: '8px 12px',
    borderRadius: theme.radiusMd,
    backgroundColor: theme.accentSoft,
    border: `1px solid ${theme.accent}`,
    width: 'fit-content'
});

// Small component that manages the plotpoints toggle state.
const PlotpointsWrapper: React.FC<{
    plotpoints: string[];
    defaultOpen: boolean;
    testId: string;
}> = ({ plotpoints, defaultOpen, testId }) => {
    const [open, setOpen] = React.useState(defaultOpen);

    return (
        <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <PlotpointsButton
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid={`${testId}-toggle`}
                className="sg-plot-toggle"
            >
                {open ? 'Hide' : 'Show'} Plot Points
                <span style={{ fontSize: theme.fontSize.sm, color: theme.textFaint }}>({plotpoints.length})</span>
            </PlotpointsButton>
            {open && (
                <PlotpointsList data-testid={`${testId}-body`} className="sg-fade-in">
                    <ul
                        style={{
                            margin: 0,
                            paddingLeft: 22,
                            fontSize: theme.fontSize.body,
                            color: theme.textMuted,
                            lineHeight: 1.7
                        }}
                    >
                        {plotpoints.map((pp: string, j: number) => (
                            <li key={j}>{pp}</li>
                        ))}
                    </ul>
                </PlotpointsList>
            )}
        </div>
    );
};

// Revision count chip rendered in the chapter header. Shows the number of
// revision attempts for the chapter, replacing the previous word count + time display.
const ChapterMeta: React.FC<{ chapter: any }> = ({ chapter }) => (
    <span
        style={{
            fontSize: theme.fontSize.base,
            color: theme.textMuted,
            background: theme.surface3,
            padding: '3px 8px',
            borderRadius: 999,
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            fontWeight: 500,
            border: `1px solid ${theme.border}`
        }}
    >
        {chapter.expanded ? (
            <>
                <span>
                    {chapter.revisions?.length ?? 0} revision{(chapter.revisions?.length ?? 0) !== 1 ? 's' : ''}
                </span>
            </>
        ) : (
            <span style={{ color: theme.accent2 }}>Pending</span>
        )}
    </span>
);

// Sticky per-chapter bar: revision dropdown on the left + per-chapter action
// buttons (re-expand / fork) on the right. Pins to the top of the scroll
// container (DashboardContent) while reading within a chapter so both the
// revision selector and the actions stay reachable. position:sticky is bounded
// by the parent (ChapterCard) content box, so the bar scrolls away once the
// chapter is scrolled past — it never escapes the chapter's bounding box.
//
// The opaque background layers the translucent surface2 over the solid dashboard
// bg, reproducing the ChapterCard's effective surface2-over-bg appearance. This
// keeps the bar seamless against the card while staying fully opaque so content
// scrolling beneath the pinned bar stays hidden. paddingTop/paddingBottom (not
// margins) keep the gaps above + below the bar inside the opaque box, otherwise
// scrolling content would bleed through those gaps while pinned.
//
// The bar always renders (expanded or not): when the chapter isn't expanded
// yet, the left side is empty and the right side still carries the expand/fork
// actions so the user can trigger expansion. When expanded, a native <select>
// dropdown lists the revisions (word count + generation time per option).
const ChapterStickyBar: React.FC<{
    expanded: boolean;
    revisions: Array<{ content: string; wordCount: number; generationTimeMs: number }>;
    activeIndex: number;
    onSelect: (index: number) => void;
    actions: React.ReactNode;
    dropdownActions?: React.ReactNode;
    testId: string;
}> = ({ expanded, revisions, activeIndex, onSelect, actions, dropdownActions, testId }) => {
    // Format an option label: "W words · Ts" (time omitted when 0). No
    // "Revision N" prefix — the dropdown itself communicates "pick a revision".
    const formatOption = (rev: { wordCount: number; generationTimeMs: number }) => {
        const parts = [`${rev.wordCount} words`];
        if (rev.generationTimeMs > 0) {
            parts.push(
                rev.generationTimeMs >= 60000
                    ? `${(rev.generationTimeMs / 60000).toFixed(1)}m`
                    : `${(rev.generationTimeMs / 1000).toFixed(1)}s`
            );
        }
        return parts.join(' · ');
    };

    return (
        <div
            data-testid={`${testId}-bar`}
            style={{
                position: 'sticky' as const,
                top: 0,
                zIndex: 4,
                paddingTop: 8,
                paddingBottom: 12,
                background: `linear-gradient(${theme.surface2}, ${theme.surface2}), ${theme.bg}`
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: `1px solid ${theme.border}`,
                    paddingBottom: 8
                }}
            >
                {/* Left: revision dropdown (only when the chapter is expanded
                    and has revisions). Left-aligned via natural flex order. */}
                {expanded && revisions.length > 0 && (
                    <select
                        value={activeIndex}
                        onChange={(e) => onSelect(Number(e.target.value))}
                        data-testid={`${testId}-select`}
                        className="sg-input"
                        style={{
                            padding: '4px 10px',
                            fontSize: theme.fontSize.sm,
                            color: theme.text,
                            backgroundColor: theme.surface1,
                            border: `1px solid ${theme.border}`,
                            borderRadius: theme.radiusMd,
                            cursor: 'pointer',
                            maxWidth: 320,
                            outline: 'none'
                        }}
                    >
                        {revisions.map((rev, i) => (
                            <option key={i} value={i}>
                                {formatOption(rev)}
                            </option>
                        ))}
                    </select>
                )}
                {/* Dropdown actions: sits right next to the dropdown (e.g. rewrite +)
                    before the right-aligned chapter actions. */}
                {dropdownActions}
                {/* Right: per-chapter actions (re-expand / fork). marginLeft:auto
                    pushes them to the right edge of the bar. */}
                <div
                    style={{
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4
                    }}
                >
                    {actions}
                </div>
            </div>
        </div>
    );
};

export const SectionStoryContent: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { selected } = store;

    // Ref that holds the *currently polled* entry.id so the effect's cleanup
    // can flip shouldStop(). Using a ref avoids stale-closure problems across
    // re-renders.
    const activePollIdRef = React.useRef<number | null>(null);

    // ── Expanded chapter state ─────────────────────────────────────────
    // Tracks which chapter indices are currently expanded. Persisted to
    // localStorage per story so the user returns to the same expansion
    // state after navigating away or reloading.
    const [expandedChapters, setExpandedChaptersState] = React.useState<Set<number>>(new Set());

    // Per-story guard for the auto-expand-latest behaviour (below). Holds the
    // storyId once the user has interacted (toggled a chapter / collapsed all)
    // OR once we've loaded saved preferences from localStorage. While the
    // current story's id is NOT in this ref, the auto-expand effect is allowed
    // to keep the latest chapter open as chapters stream in from polling.
    const userInteractedRef = React.useRef<string | null>(null);

    // Track which revision tab is active for each chapter.
    // Keyed by chapter index, value is the revision index (0-based, 0 = oldest).
    const [activeRevisions, setActiveRevisions] = React.useState<Record<number, number>>({});

    // Load expanded chapters from localStorage when the selected story changes.
    // If the user had saved preferences, mark them as "interacted" so the
    // auto-expand effect doesn't override their choices.
    React.useEffect(() => {
        if (!selected?.storyId) {
            setExpandedChaptersState(new Set());
            userInteractedRef.current = null;
            return;
        }
        const saved = getExpandedChapters(selected.storyId);
        setExpandedChaptersState(new Set(saved));
        userInteractedRef.current = saved.length > 0 ? selected.storyId : null;
    }, [selected?.storyId]);

    // Auto-expand the latest chapter as chapters stream in from polling, until
    // the user interacts (toggles a chapter / collapses all). Restores the
    // pre-controlled `defaultOpen={i === chapters.length - 1}` behaviour: while
    // generation is in progress the newest chapter stays open so the user can
    // read along, and once they make a choice we stop overriding them.
    React.useEffect(() => {
        if (!selected?.storyId) return;
        if (userInteractedRef.current === selected.storyId) return;
        const chapters = selected?.data?.chapters;
        if (!chapters || chapters.length === 0) return;
        setExpandedChaptersState(new Set([chapters.length - 1]));
    }, [selected?.storyId, selected?.data?.chapters?.length]);

    // Persist expanded chapters to localStorage whenever they change.
    React.useEffect(() => {
        if (!selected?.storyId) return;
        setExpandedChapters(selected.storyId, Array.from(expandedChapters));
    }, [selected?.storyId, expandedChapters]);

    /** Toggle a chapter's expanded state and persist to localStorage. */
    const handleChapterToggle = React.useCallback((index: number, open: boolean) => {
        // Mark this story as interacted so auto-expand stops overriding.
        userInteractedRef.current = selected?.storyId ?? null;
        setExpandedChaptersState((prev) => {
            const next = new Set(prev);
            if (open) {
                next.add(index);
            } else {
                next.delete(index);
            }
            return next;
        });
    }, [selected?.storyId]);

    // Patch a single record's fields by id. We use functional updates so the
    // updater always targets the latest records array.
    const patchRecord = React.useCallback(
        (id: number, patch: (entry: { data: any; isProcessing: boolean; error: string }) => void) => {
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) => {
                    if (e.id !== id) return e;
                    const next = { ...e, data: e.data ? { ...e.data } : null, error: e.error };
                    patch(next as any);
                    return next;
                }),
                selected:
                    prev.selected?.id === id
                        ? (() => {
                              const updated = prev.records.map((e) => (e.id === id ? { ...e } : e));
                              const found = updated.find((e) => e.id === id);
                              return found ?? prev.selected;
                          })()
                        : prev.selected
            }));
        },
        [setStore]
    );

    // ── Re-expand chapter state ──────────────────────────────────────────
    // Tracks which chapter (by display index + previous revision count) is
    // currently being re-expanded. The polling effect below watches this and
    // polls GET until the chapter's revisions array grows, indicating the
    // server has finished background re-expansion.
    const [reExpandState, setReExpandState] = React.useState<{
        chapterIndex: number; // 0-based index of the chapter being re-expanded
        previousRevisionCount?: number; // snapshot before re-expand started
    } | null>(null);

    // Fire a re-expand PATCH and kick off the completion poller.
    const handleReExpand = React.useCallback(
        async (chapterIndex: number, previousRevisionCount?: number) => {
            if (!selected?.storyId) return;
            try {
                await updateChapter(store.config.baseUrl, selected.storyId, chapterIndex);
                // Mark as processing so the tab chip shows the badge.
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id ? { ...e, isProcessing: true, error: '' } : e
                    )
                }));
                setReExpandState({ chapterIndex, previousRevisionCount });
            } catch (err: any) {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id
                            ? { ...e, isProcessing: false, error: err.message || 'Re-expand failed' }
                            : e
                    )
                }));
            }
        },
        [selected, store.config.baseUrl, setStore]
    );

    // Poll for re-expand completion. Runs while reExpandState is set. On each
    // tick it fetches story data and checks whether the target chapter's
    // revisions array has grown (indicating the background job finished).
    React.useEffect(() => {
        if (!reExpandState || !selected?.storyId) return;

        const baseUrl = store.config.baseUrl;
        const storyId = selected.storyId;
        const entryId = selected.id;
        const targetIndex = reExpandState.chapterIndex;
        const prevCount = reExpandState.previousRevisionCount;
        const intervalMs = store.config.pollIntervalMs;

        let cancelled = false;

        const poll = async () => {
            while (!cancelled) {
                await new Promise((r) => setTimeout(r, intervalMs));
                if (cancelled) break;

                const result = await fetchStoryData(baseUrl, storyId);
                if (cancelled) break;

                if (result.status === 'data') {
                    const chapter = result.data.chapters[targetIndex];
                    // Consider it done when the chapter is expanded AND its
                    // revisions array has more entries than the pre-reexpand snapshot.
                    // Fall back to "done" if we somehow lost the snapshot.
                    const changed =
                        chapter &&
                        chapter.expanded &&
                        (prevCount === undefined || (chapter.revisions?.length ?? 0) > prevCount);

                    if (changed) {
                        setStore((prev) => ({
                            ...prev,
                            records: prev.records.map((e) =>
                                e.id === entryId
                                    ? { ...e, data: result.data, isProcessing: false }
                                    : e
                            ),
                            selected:
                                prev.selected?.id === entryId
                                    ? { ...prev.selected, data: result.data, isProcessing: false }
                                    : prev.selected
                        }));
                        setReExpandState(null);
                        break;
                    }
                }
                // If the chapter disappeared or isn't expanded yet, keep polling.
            }
        };

        poll();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reExpandState, selected?.storyId, store.config.baseUrl, store.config.pollIntervalMs]);

    // ── Fork story ──────────────────────────────────────────────────────────
    // Fork creates a new story by copying the source story's plotlines and
    // all chapters before the fork point, then re-expanding from the fork
    // chapter onwards. The new story is added to the store and selected.
    const handleFork = React.useCallback(
        async (chapterIndex: number) => {
            if (!selected?.storyId) return;

            const newStoryId = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const newTitle = `fork-${selected.storyName || selected.storyId.slice(0, 8)}`;

            try {
                const result = await createNewStory(
                    store.config.baseUrl,
                    newStoryId,
                    {} as any, // storyline/chapterCount not needed for fork
                    { sourceStoryId: selected.storyId, chapterIndex }
                );

                // Add the new forked story to the store and select it.
                setStore((prev) => {
                    const newEntry = {
                        id: Date.now(),
                        storyId: result.storyId,
                        storyName: selected.storyName,
                        title: newTitle,
                        storyline: selected.storyline,
                        chapterRequested: selected.chapterRequested,
                        chapterCompleted: 0,
                        createdDate: new Date().toISOString(),
                        status: 'generating' as const,
                        data: null,
                        isProcessing: true,
                        error: '',
                        isRemote: false
                    };
                    return {
                        ...prev,
                        records: [...prev.records, newEntry],
                        selected: newEntry
                    };
                });
            } catch (err: any) {
                setStore((prev) => ({
                    ...prev,
                    loadWarning: err.message || 'Fork failed'
                }));
            }
        },
        [selected, store.config.baseUrl, setStore]
    );

    // ── Rewrite chapter state ─────────────────────────────────────────────
    // Tracks whether the rewrite dialogue is open and which chapter is being
    // rewritten. When the user submits the dialogue, handleRewrite fires the
    // PATCH and starts the same polling flow as re-expand.
    const [rewriteState, setRewriteState] = React.useState<{
        isOpen: boolean;
        chapterIndex: number;
        previousRevisionCount?: number;
        rewriteRevisionIndex?: number;
    }>({ isOpen: false, chapterIndex: -1 });

    const [rewriteContextInput, setRewriteContextInput] = React.useState('');

    // Open the rewrite dialogue for a specific chapter.
    const openRewriteDialogue = React.useCallback(
        (chapterIndex: number, previousRevisionCount?: number, revisionIndex?: number) => {
            setRewriteContextInput('- The chapter must follow the events of the original chapter exactly from start to end!\n- Write from first person perspective of ');
            setRewriteState({ isOpen: true, chapterIndex, previousRevisionCount, rewriteRevisionIndex: revisionIndex });
        },
        []
    );

    // Close the rewrite dialogue without submitting.
    const closeRewriteDialogue = React.useCallback(() => {
        setRewriteState((prev) => ({ ...prev, isOpen: false }));
    }, []);

    // Submit the rewrite request.
    const handleRewrite = React.useCallback(
        async (chapterIndex: number, rewriteContext: string, previousRevisionCount?: number, rewriteRevisionIndex?: number) => {
            if (!selected?.storyId || !rewriteContext.trim()) return;
            try {
                await rewriteChapter(store.config.baseUrl, selected.storyId, chapterIndex, rewriteContext.trim(), rewriteRevisionIndex);
                // Mark as processing so the tab chip shows the badge.
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id ? { ...e, isProcessing: true, error: '' } : e
                    )
                }));
                // Re-use the reExpandState to trigger the polling effect.
                // The polling logic is generic — it watches for revision changes.
                setReExpandState({ chapterIndex, previousRevisionCount });
                setRewriteState({ isOpen: false, chapterIndex: -1 });
            } catch (err: any) {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id
                            ? { ...e, isProcessing: false, error: err.message || 'Rewrite failed' }
                            : e
                    )
                }));
                setRewriteState((prev) => ({ ...prev, isOpen: false }));
            }
        },
        [selected, store.config.baseUrl, setStore]
    );

    // Polling effect.
    React.useEffect(() => {
        if (!selected || !selected.storyId) {
            return;
        }

        const pollable = selected.isRemote || selected.chapterRequested > 0;
        if (!pollable) {
            return;
        }

        const entryId = selected.id;
        const { storyId, chapterRequested, isRemote } = selected;
        const baseUrl = store.config.baseUrl;
        const pollIntervalMs = store.config.pollIntervalMs;

        // Mark as processing so the tab chip shows the badge.
        setStore((prev) => ({
            ...prev,
            records: prev.records.map((e) =>
                e.id === entryId ? { ...e, isProcessing: true, error: '' } : e
            )
        }));

        activePollIdRef.current = entryId;

        const shouldStop = () => activePollIdRef.current !== entryId;

        // onData fires on every successful GET; updates the store entry in place.
        // Also propagates meta.storyline into entry.storyline and meta.storyName
        // into entry.storyName/title so the sidebar and header update with a
        // meaningful name once the server responds.
        const onData = (data: { chapters: any[]; meta: any }) => {
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.id === entryId
                        ? {
                              ...e,
                              data: { chapters: data.chapters, meta: data.meta },
                              storyline: data.meta?.storyline ?? e.storyline,
                              ...(data.meta?.storyName
                                  ? { storyName: data.meta.storyName, title: data.meta.storyName }
                                  : {})
                          }
                        : e
                );
                const selected =
                    prev.selected?.id === entryId
                        ? records.find((e) => e.id === entryId) ?? prev.selected
                        : prev.selected;
                return { ...prev, records, selected };
            });
        };

        pollStoryData({
            baseUrl,
            storyId,
            expectedChapterCount: chapterRequested > 0 ? chapterRequested : 0,
            pollIntervalMs,
            shouldStop,
            onData
        })
            .then((result) => {
                setStore((prev) => {
                    const records = prev.records.map((e) => {
                        if (e.id !== entryId) return e;
                        if (result.status === 'error') {
                            return { ...e, isProcessing: false, error: result.error };
                        }
                        return { ...e, isProcessing: false };
                    });
                    const selected =
                        prev.selected?.id === entryId
                            ? records.find((e) => e.id === entryId) ?? prev.selected
                            : prev.selected;
                    return { ...prev, records, selected };
                });
            })
            .catch((err: Error) => {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === entryId
                            ? { ...e, isProcessing: false, error: err.message }
                            : e
                    )
                }));
            })
            .finally(() => {
                if (activePollIdRef.current === entryId) {
                    activePollIdRef.current = null;
                }
            });

        return () => {
            if (activePollIdRef.current === entryId) {
                activePollIdRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        selected?.id,
        selected?.storyId,
        selected?.chapterRequested,
        selected?.isRemote,
        selected?.data?.chapters.length,
        store.config.baseUrl,
        store.config.pollIntervalMs
    ]);

    const data = selected?.data ?? { chapters: [], meta: null };

    // Build the complete plotpoints outline text from all chapters.
    // This is used by the "Extend" button to populate the storyline input
    // so the user can iterate on the full structure.
    // NOTE: hooks must be declared before any early returns to satisfy
    // React's Rules of Hooks (hooks cannot be called conditionally).
    const buildPlotpointsOutline = React.useCallback((): string => {
        const chapters = data?.chapters;
        if (!chapters || chapters.length === 0) return '';

        const storyTitle = selected?.storyName || selected?.title || 'Story';
        const lines: string[] = [];

        // Heading with story title
        lines.push(`# ${storyTitle} Extended`);
        lines.push('');

        chapters.forEach((ch: any, i: number) => {
            const title = ch.title || `Chapter ${i + 1}`;
            lines.push(`## ${title}`);
            if (ch.plotpoints && ch.plotpoints.length > 0) {
                ch.plotpoints.forEach((pp: string) => {
                    lines.push(`- ${pp}`);
                });
            } else {
                lines.push('- (no plot points)');
            }
            lines.push('');
        });

        // Closing prompt for the user to continue editing
        lines.push('');
        lines.push('> Extend the story with the following plotlines: ');
        lines.push('');
        lines.push('');

        return lines.join('\n');
    }, [data?.chapters, selected?.storyName, selected?.title]);

    const handleExtend = React.useCallback(() => {
        const outline = buildPlotpointsOutline();
        if (!outline) return;
        setStore((prev) => ({ ...prev, pendingStoryline: outline }));
    }, [buildPlotpointsOutline, setStore]);

    const handleCollapseAll = React.useCallback(() => {
        // Mark this story as interacted so auto-expand doesn't re-open the
        // latest chapter immediately after the user explicitly collapsed all.
        userInteractedRef.current = selected?.storyId ?? null;
        setExpandedChaptersState(new Set());
    }, [selected?.storyId]);

    // Whether the Extend button should be enabled: a story must be selected
    // and have at least one chapter with plotpoints.
    const hasPlotpoints = (data?.chapters ?? []).some(
        (ch: any) => ch.plotpoints && ch.plotpoints.length > 0
    );

    // Render hygiene: null-safety on each branch.
    if (!selected) {
        return (
            <EmptyState data-testid="content-empty">Select one</EmptyState>
        );
    }

    if (!selected.isRemote && selected.chapterRequested <= 0) {
        return (
            <PendingSubmitHint data-testid="content-pending-submit">
                Enter a storyline and chapter count in the field below, then click
                "Generate" to start generation for story{' '}
                <code style={{ color: theme.accent }}>{selected.storyName || selected.storyId}</code>.
                {selected.error && (
                    <div style={{ color: theme.danger, marginTop: 12 }}>
                        Last error: {selected.error}
                    </div>
                )}
            </PendingSubmitHint>
        );
    }

    return (
        <ContentColumn data-testid="content-story" className="sg-scroll">
            {/* In-progress banner: spinner chip + chapter progress count. */}
            {selected.isProcessing && (
                <ProgressBanner>
                    <span className="sg-spinner" />
                    <span>Generating {data.chapters.length}/{selected.chapterRequested} chapters…</span>
                </ProgressBanner>
            )}

            <ChapterListContainer data-testid="chapters-list">
                {data.chapters.length === 0 && (
                    <div style={{ color: theme.textFaint, fontStyle: 'italic', padding: '8px 0' }}>
                        {selected.isProcessing ? 'Waiting for the first chapter…' : 'No chapters yet.'}
                    </div>
                )}
                {data.chapters.map((ch, i) => (
                    <Collapsible
                        key={i}
                        defaultOpen={false}
                        open={expandedChapters.has(i)}
                        onToggle={(open) => handleChapterToggle(i, open)}
                        data-testid={`chapter-${i}`}
                        title={
                            <span style={{ fontSize: theme.fontSize.lg, color: theme.text, fontWeight: 500 }}>
                                Chapter {i + 1}{ch.title ? `: ${ch.title}` : ''}
                            </span>
                        }
                        headerExtra={<ChapterMeta chapter={ch} />}
                    >
                        <ChapterCard data-testid={`chapter-${i}-content`}>
                            {/* Plotpoints toggle button — right-aligned, collapsible */}
                            {ch.plotpoints && ch.plotpoints.length > 0 && (
                                <PlotpointsWrapper
                                    plotpoints={ch.plotpoints}
                                    defaultOpen={!ch.expanded}
                                    testId={`chapter-${i}-plotpoints`}
                                />
                            )}

                            {/* Sticky per-chapter bar: revision dropdown (left)
                                + re-expand / fork actions (right). Always shown
                                so the actions stay reachable; the dropdown only
                                appears once the chapter is expanded. */}
                            <ChapterStickyBar
                                expanded={!!ch.expanded}
                                revisions={ch.revisions ?? []}
                                activeIndex={activeRevisions[i] ?? (ch.revisions?.length ?? 1) - 1}
                                onSelect={(idx) => setActiveRevisions((prev) => ({ ...prev, [i]: idx }))}
                                dropdownActions={
                                    <ChapterActionButton
                                        onClick={() =>
                                            openRewriteDialogue(ch.chapterIndex, ch.revisions?.length, activeRevisions[i] ?? (ch.revisions?.length ?? 1) - 1)
                                        }
                                        title="Rewrite chapter with custom context"
                                        data-testid={`chapter-${i}-rewrite`}
                                    >
                                        <RewriteIcon />
                                    </ChapterActionButton>
                                }
                                actions={
                                    <>
                                        <ChapterActionButton
                                            onClick={() =>
                                                handleReExpand(ch.chapterIndex, ch.revisions?.length)
                                            }
                                            title={
                                                reExpandState?.chapterIndex === ch.chapterIndex
                                                    ? ch.expanded
                                                        ? 'Re-expanding…'
                                                        : 'Expanding…'
                                                    : ch.expanded
                                                        ? 'Re-expand Chapter'
                                                        : 'Expand Chapter'
                                            }
                                            data-testid={`chapter-${i}-reexpand`}
                                        >
                                            <RefreshIcon />
                                        </ChapterActionButton>
                                        <ChapterActionButton
                                            onClick={() => handleFork(ch.chapterIndex)}
                                            title="Fork from this chapter"
                                            data-testid={`chapter-${i}-fork`}
                                        >
                                            <ForkIcon />
                                        </ChapterActionButton>
                                    </>
                                }
                                testId={`chapter-${i}-revisions`}
                            />

                            {/* Chapter expansion content — active revision body,
                                or a pending hint when not yet expanded. */}
                            {ch.expanded ? (
                                <MarkdownContent>
                                    {ch.revisions?.[activeRevisions[i] ?? (ch.revisions?.length ?? 1) - 1]?.content ?? ''}
                                </MarkdownContent>
                            ) : (
                                <PendingExpansion data-testid={`chapter-${i}-pending`}>
                                    This chapter has not been expanded yet.
                                </PendingExpansion>
                            )}
                        </ChapterCard>
                    </Collapsible>
                ))}
            </ChapterListContainer>

            {selected.error && (
                <div
                    style={{
                        color: theme.danger,
                        fontSize: theme.fontSize.md,
                        padding: '8px 12px',
                        background: theme.dangerSoft,
                        border: `1px solid ${theme.dangerBorder}`,
                        borderRadius: theme.radiusMd
                    }}
                    data-testid="content-error"
                >
                    Error: {selected.error}
                </div>
            )}

            {/* Action bar — pinned bottom-right. Collapse-all closes every
                expanded chapter. Extend copies the full plotpoints outline
                into the storyline input for iteration. */}
            {hasPlotpoints && (
                <ActionBar data-testid="content-action-bar">
                    <ActionButton
                        onClick={handleCollapseAll}
                        data-testid="collapse-all-button"
                        title="Collapse all chapters"
                        className="sg-hover"
                    >
                        <CollapseAllIcon />
                    </ActionButton>
                    <ActionButton
                        onClick={handleExtend}
                        data-testid="extend-plotpoints-button"
                        title="Extend story with plotpoints outline"
                        className="sg-hover"
                    >
                        <ExtendIcon />
                    </ActionButton>
                </ActionBar>
            )}

            {/* Rewrite dialogue modal — shown when rewriteState.isOpen is true */}
            {rewriteState.isOpen && (
                <RewriteOverlay onClick={closeRewriteDialogue}>
                    <RewriteDialog onClick={(e) => e.stopPropagation()}>
                        <RewriteDialogTitle>
                            Rewrite Chapter {rewriteState.chapterIndex + 1}
                        </RewriteDialogTitle>
                        <p
                            style={{
                                margin: '0 0 12px 0',
                                fontSize: theme.fontSize.sm,
                                color: theme.textMuted,
                                lineHeight: 1.5
                            }}
                        >
                            Provide instructions for how this chapter should be rewritten.
                            The full story summary will be used as context.
                        </p>
                        <RewriteTextarea
                            value={rewriteContextInput}
                            onChange={(e) => setRewriteContextInput(e.target.value)}
                            placeholder="e.g. Make the scene more dramatic, add more tension, slow down the pacing..."
                            autoFocus
                            onFocus={(e) => {
                                const len = e.target.value.length;
                                e.target.setSelectionRange(len, len);
                            }}
                            data-testid="rewrite-context-input"
                        />
                        <RewriteDialogActions>
                            <ActionButton
                                onClick={closeRewriteDialogue}
                                data-testid="rewrite-cancel"
                                style={{ pointerEvents: 'auto' }}
                            >
                                Cancel
                            </ActionButton>
                            <ActionButton
                                onClick={() =>
                                    handleRewrite(
                                        rewriteState.chapterIndex,
                                        rewriteContextInput,
                                        rewriteState.previousRevisionCount,
                                        rewriteState.rewriteRevisionIndex
                                    )
                                }
                                disabled={!rewriteContextInput.trim()}
                                data-testid="rewrite-submit"
                                style={{
                                    pointerEvents: 'auto',
                                    backgroundColor: rewriteContextInput.trim() ? theme.accent : undefined,
                                    color: rewriteContextInput.trim() ? '#fff' : undefined,
                                    borderColor: rewriteContextInput.trim() ? theme.accent : undefined,
                                    opacity: rewriteContextInput.trim() ? 1 : 0.5
                                }}
                            >
                                Rewrite
                            </ActionButton>
                        </RewriteDialogActions>
                    </RewriteDialog>
                </RewriteOverlay>
            )}
        </ContentColumn>
    );
});
