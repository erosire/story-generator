// Content FEATURE: progressively fetches story data via the GET endpoint and
// renders chapters for the currently selected story.
//
// The API returns a unified chapters array where each chapter includes its
// plotpoints and expansion status. Chapters are displayed as individual
// collapsibles. Within each chapter, plotpoints are listed first, followed by
// the expanded content (or an informational message if not yet expanded).
//
// Polling lifecycle (driven by useEffect on selected.id):
//   1. When a story with chapterRequested > 0 is selected, start a pollStoryData
//      loop (see api/storyboard.ts). Mark entry.isProcessing = true on the
//      FIRST poll of an entry; cache-only (missingFromServer) stories poll
//      quietly in the background so the cached content stays undisturbed.
//   2. Each onData callback updates the entry's data in the store (auto-
//      persisted to the localStorage records cache) — chapters appear as soon
//      as plotpoint.json is written, then expand one by one.
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
// DIALOG REWORK: all four content-area dialogs (rewrite context, append
// chapters, delete-revision confirm, remove-chapter confirm) now compose the
// modular standard-pattern <Dialog> (components/Dialog.tsx): header/body/
// footer bands, hairline dividers, right-aligned actions. The five previous
// ad hoc overlay/box implementations (RewriteOverlay/RewriteDialog,
// AppendOverlay/AppendDialog, DeleteDialog + shared RewriteDialogTitle) are
// gone. Test contract preserved by construction:
//   - rewrite: rewrite-context-input / rewrite-cancel / rewrite-submit
//   - append:  append-dialog (frame), append-notes-input, append-count-input,
//              append-button, append-error, copy "This story has N chapters."
//   - delete:  delete-dialog + delete-dialog-title ("Delete Chapter N —
//              Revision R of M"), delete-cancel, delete-confirm, delete-error
//   - remove:  remove-chapter-dialog + remove-chapter-dialog-title
//              ("Remove Chapter N: Title"), remove-chapter-cancel,
//              remove-chapter-confirm, remove-chapter-error
//
// BADGE REWORK: StatChip / ChapterMeta / PlotpointsButton /
// RemoveChapterButton / TerminateButton are FLAT now — square radiusSm
// corners (no 999px pills). Stat chips + revision-meta chips use the modular
// <Badge>; the two danger controls keep their danger-tinted frames with
// square corners via the modular <Button variant="danger">.
//
// Moved from the old src/components/sections/SectionStoryContent.tsx — this
// feature owns all chapter-action business logic (poll loops, re-expand,
// fork, rewrite, delete, remove, append, resume, terminate).

import React from 'react';
import { objectEach } from '@presource/core';
import { styled, theme } from '../styles';
import { useStoryStore } from '../context';
import { pollStoryData, updateChapter, rewriteChapter, fetchStoryData, createNewStory, appendStoryPlotpoints, resumeStoryPlotpoints, deleteChapter, removeChapter, abortStoryJob } from '../api';
import { Badge, Button, Collapsible, Dialog, IconButton, Input, NumberInput, Textarea, MarkdownContent } from '../components';
import { getExpandedChapters, setExpandedChapters } from '../context/store';

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

// Plotpoints list — shown/hidden by the toggle button.
const PlotpointsList = styled('div', {
    marginBottom: 10
});

// Row hosting the delete-chapter control. Right-aligned to line up with the
// plotpoints toggle above it; only rendered while the plotpoints list is open
// (the destructive control lives inside the revealed "details" area so it
// never clutters the collapsed chapter header).
const RemoveChapterRow = styled('div', {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: 2,
    marginBottom: 10
});

// Info message shown when a chapter has not been expanded yet.
const PendingExpansion = styled('div', {
    color: theme.textDim,
    fontSize: theme.fontSize.lg,
    fontStyle: 'italic',
    padding: '8px 0'
});

// Inline error line inside dialogs (append/delete/remove) — the server's
// exact message, kept visible while the dialog stays open.
const DialogErrorLine = styled('div', {
    color: theme.danger,
    fontSize: theme.fontSize.md,
    padding: '8px 12px',
    background: theme.dangerSoft,
    border: `1px solid ${theme.dangerBorder}`,
    borderRadius: theme.radiusMd
});

// Standard dialog body copy (append/rewrite explanation, delete warnings).
const DialogCopy = styled('p', {
    margin: 0,
    fontSize: theme.fontSize.sm,
    color: theme.textMuted,
    lineHeight: 1.5
});

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

// Inline SVG extend icon — right-pointing arrow ([->]), used for the
// Append-chapters action button that opens the in-place append dialog
// (previously: copied plotpoints into the footer storyline input).
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

// Inline SVG resume icon — play triangle, used for the resume-generation
// action button that continues an interrupted plotline generation (server
// restarted mid-generation, retry budget exhausted, etc.).
const ResumeIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        {/* Play triangle pointing right */}
        <path d="M5 3l8 5-8 5V3z" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" fill="currentColor" />
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

// Inline SVG trash-can icon — used for the delete chapter action button
// (clears the chapter's expanded content). Sits next to the rewrite [+]
// button as its destructive counterpart: "+" adds context, the trash can
// removes generated content. Keeps the package icon-free (matches the
// dashboard convention of inline glyphs).
const TrashIcon: React.FC = () => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        {/* Lid bar + lid handle */}
        <path d="M2.5 4h11" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <path d="M6 4V2.8A.8.8 0 0 1 6.8 2h2.4a.8.8 0 0 1 .8.8V4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Can body */}
        <path d="M4 4l.7 8.9a1 1 0 0 0 1 .86h4.6a1 1 0 0 0 1-.86L12 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

// Inline SVG stop icon — filled square, the universal "terminate" glyph.
// Used for the Terminate button inside the processing banner (kills the
// story's active background job via PATCH abortJob).
const StopIcon: React.FC = () => (
    <svg
        width={12}
        height={12}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ display: 'block' }}
    >
        <rect x={3} y={3} width={10} height={10} rx={1.5} fill="currentColor" />
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

// In-progress status banner — flat solid accent-tinted surface + accent border
// so the user notices generation is running without the connotation of red.
// Hosts the chapter progress count AND the Terminate control (terminateDisabled
// while the abort PATCH is in flight) so stopping a job is one click away from
// the very place that announces it.
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

// ── Story stats bar ─────────────────────────────────────────────────────
// Rendered between the processing banner and the chapter list: a compact row
// of summary chips for the story as a whole — total chapters, total word
// count of the currently-viewed revisions, and the estimated LLM token cost
// of those words (~1.33 tokens per word — the usual English prose heuristic,
// good enough for a budget gauge; NOT an exact tokenizer count).
const StatsBar = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8
});

// Small component that manages the plotpoints toggle state.
// When the plotpoints are SHOWN (open), the delete-chapter control is revealed
// underneath the list (see onDeleteChapter) — the requirement is that the
// hide/show plotpoints toggle is what reveals the chapter removal function.
const PlotpointsWrapper: React.FC<{
    plotpoints: string[];
    defaultOpen: boolean;
    testId: string;
    // Provided only when the chapter can be removed; renders the danger
    // "Delete Chapter" control under the plotpoints list while open.
    onDeleteChapter?: () => void;
    // Disables the delete control while a removal request is in flight.
    deleteDisabled?: boolean;
}> = ({ plotpoints, defaultOpen, testId, onDeleteChapter, deleteDisabled }) => {
    const [open, setOpen] = React.useState(defaultOpen);

    return (
        <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {/* FLAT REWORK: square outline Button (radiusSm via the modular
                Button's base frame) — was the 999px PlotpointsButton pill.
                The sg-plot-toggle class hook keeps its hover treatment. */}
            <Button
                variant="outline"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid={`${testId}-toggle`}
                className="sg-plot-toggle"
                style={{ marginBottom: 10, fontSize: theme.fontSize.base, fontWeight: 500 }}
            >
                {open ? 'Hide' : 'Show'} Plot Points
                <span style={{ fontSize: theme.fontSize.sm, color: theme.textFaint }}>({plotpoints.length})</span>
            </Button>
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
            {/* Delete-chapter control — revealed together with the plotpoints
                list. Clicking opens the confirmation dialog (removeState);
                the PATCH fires only on explicit confirm. FLAT: modular danger
                Button (square corners). */}
            {open && onDeleteChapter && (
                <RemoveChapterRow>
                    <Button
                        variant="danger"
                        onClick={onDeleteChapter}
                        disabled={deleteDisabled}
                        data-testid={`${testId}-delete-chapter`}
                        title="Remove this chapter, its plotpoints, and all its revisions (later chapters renumber)"
                    >
                        <TrashIcon />
                        Delete Chapter
                    </Button>
                </RemoveChapterRow>
            )}
        </div>
    );
};

// FLAT REWORK: revision-count chip in the chapter header — now the modular
// <Badge> (square chip + rail). Was the 999px ChapterMeta pill.
const ChapterMeta: React.FC<{ chapter: any }> = ({ chapter }) => (
    <Badge variant="neutral">
        {chapter.expanded ? (
            <span>
                {chapter.revisions?.length ?? 0} revision{(chapter.revisions?.length ?? 0) !== 1 ? 's' : ''}
            </span>
        ) : (
            <span style={{ color: theme.accent2 }}>Pending</span>
        )}
    </Badge>
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
                {/* Dropdown actions: sits right next to the dropdown (rewrite +
                    and the destructive delete-content button) before the
                    right-aligned chapter actions. */}
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

export const StoryContent: React.FC = React.memo(() => {
    const { store, setStore, touchStory } = useStoryStore();
    const { selected } = store;

    // Ref that holds the *currently polled* entry.id so the effect's cleanup
    // can flip shouldStop(). Using a ref avoids stale-closure problems across
    // re-renders. Nulled ONLY by the effect cleanup (deselect/unmount) — after
    // a poll loop resolves, the ref stays set so the terminal handler can
    // verify it's still serving the selected story.
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
                // clientId from the top-right header dropdown selects the LLM
                // client for the background re-expansion chain (per-request only).
                await updateChapter(store.config.baseUrl, selected.storyId, chapterIndex, store.config.clientId);
                // Re-expand is a user action — bump the ordering timestamp so
                // the story moves to the top of the sidebar.
                touchStory(selected.storyId);
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
        [selected, store.config.baseUrl, store.config.clientId, setStore, touchStory]
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
        // Fast cadence: this poller only runs while a background chapter job
        // (re-expand / rewrite / the server-side chain it may trigger) is in
        // flight, so it polls at activePollIntervalMs — the idle
        // pollIntervalMs is reserved for non-job cadences.
        const intervalMs = store.config.activePollIntervalMs;

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
                                    ? {
                                          ...e,
                                          data: result.data,
                                          isProcessing: false,
                                          // Fresh payload landed — sync static-memory
                                          // timestamp + clear stale flag (mirrors
                                          // the main onData merge).
                                          ...(result.data.meta?.lastUpdatedAt
                                              ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                              : {}),
                                          dataStale: false
                                      }
                                    : e
                            ),
                            selected:
                                prev.selected?.id === entryId
                                    ? {
                                          ...prev.selected,
                                          data: result.data,
                                          isProcessing: false,
                                          ...(result.data.meta?.lastUpdatedAt
                                              ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                              : {}),
                                          dataStale: false
                                      }
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
    }, [reExpandState, selected?.storyId, store.config.baseUrl, store.config.activePollIntervalMs]);

    // ── Fork story ──────────────────────────────────────────────────────────
    // Fork creates a new story by copying the source story's plotlines and
    // all chapters before the fork point, then re-expanding from the fork
    // chapter onwards. The new story is added to the store and selected.
    // Re-expansion of the forked chapters uses the top-right dropdown's
    // clientId (per-request, never stored).
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
                    { sourceStoryId: selected.storyId, chapterIndex },
                    store.config.clientId
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
                        // Fork is a user action — stamp the NEW story so it
                        // sorts by the last-actioned key (same moment as its
                        // createdDate; the source story is untouched).
                        lastActionedAt: new Date().toISOString(),
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
        [selected, store.config.baseUrl, store.config.clientId, setStore]
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
                // clientId selects the LLM client for the single-chapter rewrite
                // (top-right header dropdown, per-request only).
                await rewriteChapter(store.config.baseUrl, selected.storyId, chapterIndex, rewriteContext.trim(), rewriteRevisionIndex, store.config.clientId);
                // Rewrite is a user action — bump the ordering timestamp.
                touchStory(selected.storyId);
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
        [selected, store.config.baseUrl, store.config.clientId, setStore, touchStory]
    );

    // ── Delete chapter revision state ────────────────────────────────────
    // The delete button (trash can, next to the rewrite [+]) removes ONLY the
    // revision currently selected in the chapter's revision dropdown — the
    // remaining revisions keep the chapter expanded. Deleting the LAST
    // revision returns the chapter to plotlines-only (expandable again).
    // Guarded by a confirmation dialog because the action is destructive and
    // the buttons sit close enough together for accidental clicks.
    // Confirming sends PATCH { deleteChapterIndex, deleteChapterRevisionIndex }
    // — the server deletes synchronously, so no background polling is needed:
    // a single GET refresh afterwards reflects the new revisions[].
    const [deleteState, setDeleteState] = React.useState<{
        isOpen: boolean;
        chapterIndex: number;
        // The dropdown-selected revision to remove + how many exist (drives
        // the dialog copy: "revision N of M" vs the plotlines-only warning).
        revisionIndex: number;
        revisionCount: number;
        isDeleting: boolean;
        error: string;
    }>({ isOpen: false, chapterIndex: -1, revisionIndex: -1, revisionCount: 0, isDeleting: false, error: '' });

    // Open the confirmation dialog for a specific chapter revision.
    const openDeleteDialogue = React.useCallback((chapterIndex: number, revisionIndex: number, revisionCount: number) => {
        setDeleteState({ isOpen: true, chapterIndex, revisionIndex, revisionCount, isDeleting: false, error: '' });
    }, []);

    // Close the confirmation dialog without deleting (button or overlay click).
    const closeDeleteDialogue = React.useCallback(() => {
        // Ignore closes mid-flight so the dialog cannot vanish while its PATCH
        // is still outstanding (the confirm would race the cleanup).
        setDeleteState((prev) => (prev.isOpen && !prev.isDeleting ? { ...prev, isOpen: false } : prev));
    }, []);

    // Confirm: PATCH the deletion, then refresh the story data once and merge
    // it into the store (same merge shape as the re-expand completion poll).
    const handleDeleteChapter = React.useCallback(async () => {
        if (!selected?.storyId) return;
        const { chapterIndex, revisionIndex } = deleteState;
        setDeleteState((prev) => ({ ...prev, isDeleting: true, error: '' }));
        try {
            await deleteChapter(store.config.baseUrl, selected.storyId, chapterIndex, revisionIndex);
            // Deleting a revision is a user action — bump the ordering timestamp.
            touchStory(selected.storyId);
            const result = await fetchStoryData(store.config.baseUrl, selected.storyId);
            if (result.status === 'data') {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id
                            ? {
                                  ...e,
                                  data: result.data,
                                  error: '',
                                  // Fresh payload just landed — sync the static-memory
                                  // timestamp and clear any stale flag a concurrent
                                  // list sync raised.
                                  ...(result.data.meta?.lastUpdatedAt
                                      ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                      : {}),
                                  dataStale: false
                              }
                            : e
                    ),
                    selected:
                        prev.selected?.id === selected.id
                            ? {
                                  ...prev.selected,
                                  data: result.data,
                                  error: '',
                                  ...(result.data.meta?.lastUpdatedAt
                                      ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                      : {}),
                                  dataStale: false
                              }
                            : prev.selected
                }));
                // Repair the revision-tab selection: indices after the deleted
                // one shift down by one, so the entry that now occupies the
                // deleted slot (or the new latest, when the tail was deleted)
                // becomes active. When no revisions remain (last revision
                // deleted → plotlines-only), drop the selection entirely.
                const remaining = result.data.chapters?.[chapterIndex]?.revisions?.length ?? 0;
                setActiveRevisions((prev) => {
                    const next = { ...prev };
                    if (remaining > 0) {
                        next[chapterIndex] = Math.min(revisionIndex, remaining - 1);
                    } else {
                        delete next[chapterIndex];
                    }
                    return next;
                });
            }
            setDeleteState({ isOpen: false, chapterIndex: -1, revisionIndex: -1, revisionCount: 0, isDeleting: false, error: '' });
        } catch (err: any) {
            // Server validation/lookup failure — keep the dialog open with the
            // exact server message (mirrors the append dialog's error flow).
            setDeleteState((prev) => ({
                ...prev,
                isDeleting: false,
                error: err?.message || 'Failed to delete chapter revision'
            }));
        }
    }, [selected, store.config.baseUrl, deleteState.chapterIndex, deleteState.revisionIndex, setStore, touchStory]);

    // ── Remove entire chapter state ──────────────────────────────────────
    // The "Delete Chapter" control lives INSIDE the plotpoints area (revealed by
    // the Hide/Show Plot Points toggle — see PlotpointsWrapper) and removes
    // the chapter OUTRIGHT: plotpoints, every revision, and the chapter slot
    // itself. The server renumbers the chapters after it, so all chapter
    // indices above the removed one shift down by one — this handler repairs
    // every index-keyed local state (expandedChapters, activeRevisions) and
    // decrements chapterRequested so the resume button / poll target don't
    // start chasing a chapter that no longer exists.
    // Guarded by a confirmation dialog because the action is destructive and
    // irreversible (unlike delete-revision, there is no expandable chapter
    // left behind).
    const [removeState, setRemoveState] = React.useState<{
        isOpen: boolean;
        chapterIndex: number;
        title: string;
        isRemoving: boolean;
        error: string;
    }>({ isOpen: false, chapterIndex: -1, title: '', isRemoving: false, error: '' });

    // Open the confirmation dialog for a specific chapter.
    const openRemoveDialogue = React.useCallback((chapterIndex: number, title: string) => {
        setRemoveState({ isOpen: true, chapterIndex, title, isRemoving: false, error: '' });
    }, []);

    // Close the confirmation dialog without removing (button or overlay click).
    const closeRemoveDialogue = React.useCallback(() => {
        // Ignore closes mid-flight so the dialog cannot vanish while its PATCH
        // is still outstanding (mirrors closeDeleteDialogue).
        setRemoveState((prev) => (prev.isOpen && !prev.isRemoving ? { ...prev, isOpen: false } : prev));
    }, []);

    // Confirm: PATCH the removal, then refresh the story data once and merge
    // it into the store (same merge shape as the revision delete above), plus
    // the index-shift repairs for the locally keyed chapter states.
    const handleRemoveChapter = React.useCallback(async () => {
        if (!selected?.storyId) return;
        const { chapterIndex } = removeState;
        setRemoveState((prev) => ({ ...prev, isRemoving: true, error: '' }));
        try {
            await removeChapter(store.config.baseUrl, selected.storyId, chapterIndex);
            // Removing a chapter is a user action — bump the ordering timestamp.
            touchStory(selected.storyId);
            const result = await fetchStoryData(store.config.baseUrl, selected.storyId);
            if (result.status === 'data') {
                setStore((prev) => ({
                    ...prev,
                    records: prev.records.map((e) =>
                        e.id === selected.id
                            ? {
                                  ...e,
                                  data: result.data,
                                  error: '',
                                  // The story shrank by one chapter — pull the
                                  // poll target down with it, otherwise the
                                  // resume button (chapters < target) and the
                                  // "Generating X/Y" banner would chase a
                                  // phantom chapter. Floor at 0 for stories
                                  // that were never counted.
                                  chapterRequested: Math.max(0, (e.chapterRequested ?? 0) - 1),
                                  // Fresh payload just landed — sync the static-memory
                                  // timestamp and clear any stale flag (mirrors
                                  // the revision-delete merge above).
                                  ...(result.data.meta?.lastUpdatedAt
                                      ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                      : {}),
                                  dataStale: false
                              }
                            : e
                    ),
                    selected:
                        prev.selected?.id === selected.id
                            ? {
                                  ...prev.selected,
                                  data: result.data,
                                  error: '',
                                  chapterRequested: Math.max(0, (prev.selected.chapterRequested ?? 0) - 1),
                                  ...(result.data.meta?.lastUpdatedAt
                                      ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                      : {}),
                                  dataStale: false
                              }
                            : prev.selected
                }));
            }
            // Repair index-keyed state: the removed chapter's index vanishes
            // and every index above it shifts down by one (mirrors the
            // server-side renumbering). expandedChapters persists via the
            // existing persistence effect; activeRevisions keys are display
            // indices and follow the same shift.
            setExpandedChaptersState((prev) => {
                const next = new Set<number>();
                prev.forEach((idx) => {
                    if (idx === chapterIndex) return;
                    next.add(idx > chapterIndex ? idx - 1 : idx);
                });
                return next;
            });
            setActiveRevisions((prev) => {
                const next: Record<number, number> = {};
                objectEach(prev, ({ key, value }) => {
                    const idx = Number(key);
                    if (idx === chapterIndex) return;
                    next[idx > chapterIndex ? idx - 1 : idx] = value as number;
                });
                return next;
            });
            setRemoveState({ isOpen: false, chapterIndex: -1, title: '', isRemoving: false, error: '' });
        } catch (err: any) {
            // Server validation/lookup failure — keep the dialog open with the
            // exact server message (mirrors the revision-delete error flow).
            setRemoveState((prev) => ({
                ...prev,
                isRemoving: false,
                error: err?.message || 'Failed to remove chapter'
            }));
        }
    }, [selected, store.config.baseUrl, removeState.chapterIndex, setStore, touchStory]);

    // Selection catch-up — the ONE-SHOT leg of the cache-first cycle:
    //   load cached data (already on the entry from hydration/merge, rendered
    //   immediately below) → check the server ONCE → update the store
    //   (auto-persisted to the cache) → STOP.
    //
    // Fires in TWO cases:
    //   1. No data yet (fresh remote entry, never-polled cache entry) or its
    //      cache-only state just resolved (the story reappeared on the server).
    //   2. STATIC-MEMORY STALENESS (browser cache feature): the entry is
    //      flagged dataStale — a list sync saw the server's lastUpdatedDate
    //      (plotpoint.json mtime) move past the timestamp recorded when the
    //      cached `data` was fetched, meaning the cached chapters/storyline
    //      predate a server write (another session expanded/renamed/rewrote
    //      the story). The cached payload is REPLACED by a fresh one-shot GET
    //      instead of shown as-is; lastUpdatedAt/dataStale sync below.
    //
    // An idle story is NEVER polled in a loop — its files only change while a
    // background job writes them, and job activity is handled by the
    // job-gated loop below. Errors and 404s are silent here: the cached copy
    // stays the displayed truth (mirrors the old quiet cache-only policy) and
    // the sidebar's loadWarning covers server unreachability.
    React.useEffect(() => {
        if (!selected?.storyId) return;
        // Content already available AND not stale — nothing to catch up on.
        if (selected.data && !selected.dataStale) return;

        const entryId = selected.id;
        const { storyId } = selected;
        const baseUrl = store.config.baseUrl;

        let cancelled = false;

        fetchStoryData(baseUrl, storyId)
            .then((result) => {
                if (cancelled || result.status !== 'data') return;
                setStore((prev) => {
                    const records = prev.records.map((e) =>
                        e.id === entryId
                            ? {
                                  ...e,
                                  data: { chapters: result.data.chapters, meta: result.data.meta },
                                  storyline: result.data.meta?.storyline ?? e.storyline,
                                  missingFromServer: false,
                                  // Static-memory sync: adopt the server's
                                  // fetch-time stamp (meta.lastUpdatedAt = the
                                  // plotpoint.json mtime this payload reflects)
                                  // and clear the stale flag — the cached copy
                                  // has been replaced by this fresh payload.
                                  // Legacy servers omit meta.lastUpdatedAt →
                                  // keep the previous stamp (never regress).
                                  ...(result.data.meta?.lastUpdatedAt
                                      ? { lastUpdatedAt: result.data.meta.lastUpdatedAt }
                                      : {}),
                                  dataStale: false,
                                  ...(result.data.meta?.storyName
                                      ? { storyName: result.data.meta.storyName, title: result.data.meta.storyName }
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
            })
            .catch(() => {
                // Silent — the cached/empty view stands until a job (or the
                // next selection) triggers a fresh check. dataStale stays set
                // so the NEXT selection of this story retries the refresh.
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        selected?.id,
        selected?.storyId,
        selected?.data === null,
        selected?.dataStale,
        selected?.missingFromServer,
        store.config.baseUrl
    ]);

    // Job-gated polling effect — the background-work leg of the cache-first
    // cycle. The loop EXISTS only while a background thread is running for
    // the selected story:
    //
    //   - isProcessing: a flow THIS session started (Generate, append,
    //     resume, re-expand, rewrite) set the flag synchronously.
    //   - serverProcessing: the server's job registry reports a thread for
    //     this storyId (arrives via the sidebar's list sync — covers jobs
    //     started by OTHER sessions/devices, including the server-side
    //     expansion chain that follows a re-expand).
    //
    // With NEITHER flag set the story's data cannot change (only jobs write
    // its files), so polling stops entirely — the old behavior re-armed this
    // loop forever (pollCycle timer), hammering GET even for untouched,
    // fully-generated stories. When a job runs, the loop polls at the FAST
    // activePollIntervalMs cadence so chapters stream in near-live; the
    // merge (mergeServerStoryList) retires both flags from the registry's
    // verdict the moment the job list no longer reports the story, which
    // cancels the loop — no timer-driven re-arm exists anymore.
    React.useEffect(() => {
        if (!selected || !selected.storyId) {
            return;
        }

        const pollable = selected.isRemote || selected.chapterRequested > 0;
        if (!pollable) {
            return;
        }

        // Background-work signal for THIS story. No flag → no polling.
        const storyHasJob = selected.isProcessing || selected.serverProcessing === true;
        if (!storyHasJob) {
            return;
        }

        const entryId = selected.id;
        const { storyId, chapterRequested, isRemote } = selected;
        const baseUrl = store.config.baseUrl;
        // FAST cadence: the loop only exists while a job runs, so it always
        // polls at the active interval (the idle pollIntervalMs now only
        // drives the per-chapter completion pollers).
        const pollIntervalMs = store.config.activePollIntervalMs;
        const cacheOnly = Boolean(selected.missingFromServer);

        // Processing-flag policy at loop start:
        //   - cache-only story → force OFF (the cached copy is the truth; the
        //     server check is silent).
        //   - otherwise ensure ON without churning the record when the flag
        //     is already set (local flows set it synchronously; the flip only
        //     happens for registry-driven jobs from other sessions).
        setStore((prev) => {
            const records = prev.records.map((e) => {
                if (e.id !== entryId) return e;
                if (cacheOnly) return e.isProcessing || e.error ? { ...e, isProcessing: false, error: '' } : e;
                if (!e.isProcessing || e.error) return { ...e, isProcessing: true, error: '' };
                return e;
            });
            const selected =
                prev.selected?.id === entryId
                    ? records.find((e) => e.id === entryId) ?? prev.selected
                    : prev.selected;
            return { ...prev, records, selected };
        });

        activePollIdRef.current = entryId;

        const shouldStop = () => activePollIdRef.current !== entryId;

        // onData fires on every successful GET; updates the store entry in place.
        // Also propagates meta.storyline into entry.storyline and meta.storyName
        // into entry.storyName/title so the sidebar and header update with a
        // meaningful name once the server responds. A data answer also clears
        // missingFromServer — the story provably exists on the server again —
        // and syncs the static-memory timestamps: lastUpdatedAt adopts
        // meta.lastUpdatedAt (the plotpoint.json mtime this payload reflects)
        // and dataStale clears (a concurrent list sync may have flagged the
        // entry mid-poll; the payload just landed is at least as fresh).
        const onData = (data: { chapters: any[]; meta: any }) => {
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.id === entryId
                        ? {
                              ...e,
                              data: { chapters: data.chapters, meta: data.meta },
                              storyline: data.meta?.storyline ?? e.storyline,
                              missingFromServer: false,
                              ...(data.meta?.lastUpdatedAt ? { lastUpdatedAt: data.meta.lastUpdatedAt } : {}),
                              dataStale: false,
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
                // 'stopped' means a newer effect run (or unmount) owns this
                // entry — leave the store alone so the replacement run's flag
                // isn't raced back off.
                if (result.status === 'stopped') return;
                if (activePollIdRef.current === entryId) {
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
                }
                // NO re-arm timer. Whether polling continues is decided by the
                // job flags alone: this resolution flipped isProcessing off,
                // which re-runs this effect — if the registry still reports a
                // thread (serverProcessing, e.g. the server-side expansion
                // chain), the re-run starts the next loop; if not, polling
                // stays stopped until new work actually exists.
            })
            .catch((err: Error) => {
                if (activePollIdRef.current === entryId) {
                    setStore((prev) => ({
                        ...prev,
                        records: prev.records.map((e) =>
                            e.id === entryId
                                ? { ...e, isProcessing: false, error: err.message }
                                : e
                        )
                    }));
                }
                // NO blind retry timer either — a hard fetch failure stops the
                // loop. The next sidebar list sync re-flags the story while a
                // job genuinely runs, and the flag-driven re-run restarts
                // polling from there.
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
        selected?.missingFromServer,
        selected?.data?.chapters.length,
        selected?.isProcessing,
        selected?.serverProcessing,
        store.config.baseUrl,
        store.config.activePollIntervalMs
    ]);

    const data = selected?.data ?? { chapters: [], meta: null };

    // ── Append chapters (the "[->]" action) ───────────────────────────────
    // The append dialog extends the SELECTED story in place: it sends an
    // `append` POST (appendStoryPlotpoints) with the user's optional notes +
    // how many new chapters to generate. The server appends plotpoints-only
    // chapters after the current chapter list (10 existing + 3 appended = 13)
    // and writes skeleton payloads for them — NO chapter expansion happens,
    // each new chapter is expanded later via its own per-chapter action.
    //
    // On success we bump this entry's chapterRequested to the new total so
    // the main polling effect (below) restarts with the enlarged target and
    // the new pending chapters stream into the list as plotline files land.
    const [appendState, setAppendState] = React.useState<{
        isOpen: boolean;
        isSubmitting: boolean;
        notes: string;
        chapterCount: number;
        error: string;
    }>({ isOpen: false, isSubmitting: false, notes: '', chapterCount: 3, error: '' });

    // Open the append dialog with fresh defaults (3 new chapters, no notes).
    const openAppendDialogue = React.useCallback(() => {
        setAppendState({ isOpen: true, isSubmitting: false, notes: '', chapterCount: 3, error: '' });
    }, []);

    const closeAppendDialogue = React.useCallback(() => {
        setAppendState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    }, []);

    // Submit the append request. On failure the dialog stays open with the
    // server's message so the user can correct and retry.
    const handleAppend = React.useCallback(async () => {
        if (!selected?.storyId) return;
        const { notes, chapterCount } = appendState;
        setAppendState((prev) => ({ ...prev, isSubmitting: true, error: '' }));
        try {
            // clientId from the top-right header dropdown selects the LLM
            // client for the plotline call (per-request only, never stored).
            await appendStoryPlotpoints(
                store.config.baseUrl,
                selected.storyId,
                { chapterCount, notes: notes.trim() || undefined },
                store.config.clientId
            );

            // New total chapter target = current story size + appended count.
            // Prefer the server's meta.chapterCount (source of truth), fall
            // back to the locally polled chapter list, then the entry's
            // chapterRequested (remote entries seeded from the list endpoint).
            const currentChapterCount =
                selected.data?.meta?.chapterCount ?? selected.data?.chapters?.length ?? selected.chapterRequested;
            const nextChapterRequested = Math.max(currentChapterCount, 0) + chapterCount;

            // Bump chapterRequested (restarts the main poll loop with the new
            // target) and mark processing so the tab chip/banner reflect that
            // new plotlines are being generated. The new chapters arrive
            // plotpoints-only and stay pending until individually expanded.
            // Append is a user action — bump the ordering timestamp too.
            touchStory(selected.storyId);
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === selected.id
                        ? { ...e, chapterRequested: nextChapterRequested, isProcessing: true, status: 'generating' as const, error: '' }
                        : e
                ),
                selected:
                    prev.selected?.id === selected.id
                        ? {
                              ...prev.selected,
                              chapterRequested: nextChapterRequested,
                              isProcessing: true,
                              status: 'generating' as const,
                              error: ''
                          }
                        : prev.selected
            }));

            // Success: close the dialog with fresh defaults for the next use.
            setAppendState({ isOpen: false, isSubmitting: false, notes: '', chapterCount: 3, error: '' });
        } catch (err: any) {
            // Server validation/append failure — keep the dialog open so the
            // user can fix the inputs and retry.
            setAppendState((prev) => ({ ...prev, isSubmitting: false, error: err?.message || 'Failed to append chapters' }));
        }
    }, [selected, store.config.baseUrl, store.config.clientId, appendState.notes, appendState.chapterCount, setStore, touchStory]);

    const handleCollapseAll = React.useCallback(() => {
        // Mark this story as interacted so auto-expand doesn't re-open the
        // latest chapter immediately after the user explicitly collapsed all.
        userInteractedRef.current = selected?.storyId ?? null;
        setExpandedChaptersState(new Set());
    }, [selected?.storyId]);

    // ── Resume generation (the ▶ action) ─────────────────────────────────
    // Continues an INTERRUPTED plotline generation for the selected story:
    // the server's background job died (restart/crash) leaving plotpoint.json
    // frozen with fewer chapters than requested, or a chapter exhausted its
    // retry budget (markStoryFailed). POSTs { resume: { chapterCount } } to
    // the same storyId (generation-create-new-story.ts resume branch →
    // generation-resume-story.ts); the server keeps the complete chapter
    // prefix and regenerates the tail, so nothing already accepted is lost.
    const [resumeState, setResumeState] = React.useState<{ isSubmitting: boolean }>({ isSubmitting: false });

    const handleResume = React.useCallback(async () => {
        if (!selected?.storyId) return;
        setResumeState({ isSubmitting: true });
        try {
            // Total chapter target: the larger of what the client asked for
            // (chapterRequested may still remember an interrupted append's
            // bumped total) and what the server recorded (interrupted create).
            const resumeTarget = Math.max(selected.chapterRequested, data?.meta?.chapterCount ?? 0);
            // clientId from the top-right header dropdown selects the LLM
            // client for the resumed calls (per-request only).
            const result = await resumeStoryPlotpoints(
                store.config.baseUrl,
                selected.storyId,
                { chapterCount: resumeTarget > 0 ? resumeTarget : undefined },
                store.config.clientId
            );

            // Align the entry with the server's target and switch the
            // processing indicators back on. The already-running poll loop
            // streams the regenerated chapters in as plotpoint.json is
            // rewritten chapter by chapter.
            // Resume is a user action — bump the ordering timestamp.
            touchStory(selected.storyId);
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === selected.id
                        ? { ...e, chapterRequested: result.chapterCount, isProcessing: true, status: 'generating' as const, error: '' }
                        : e
                ),
                selected:
                    prev.selected?.id === selected.id
                        ? { ...prev.selected, chapterRequested: result.chapterCount, isProcessing: true, status: 'generating' as const, error: '' }
                        : prev.selected
            }));
        } catch (err: any) {
            // Surface the server's exact reason in the content-error banner
            // (unknown story, nothing left to resume, or a generation job
            // already in flight on the server).
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === selected.id ? { ...e, error: err?.message || 'Failed to resume generation' } : e
                ),
                selected:
                    prev.selected?.id === selected.id
                        ? { ...prev.selected, error: err?.message || 'Failed to resume generation' }
                        : prev.selected
            }));
        } finally {
            setResumeState({ isSubmitting: false });
        }
    }, [selected, store.config.baseUrl, store.config.clientId, data?.meta?.chapterCount, setStore, touchStory]);

    // ── Terminate job (the ■ action inside the progress banner) ──────────
    // Kills every active background job for the selected story while it is
    // processing: PATCH { abortJob: true } (abortStoryJob) marks the story
    // aborted in the server's job registry; the background flow(s) throw at
    // their next checkpoint boundary and retire through releaseStoryJob.
    // All generated content is kept — an interrupted plotline stays resumable
    // via the resume button. Locally we also tear down this session's poll
    // loops immediately (the job-gated loop's shouldStop flips true; the
    // per-chapter completion poller is cleared) and retire the processing
    // flags so the banner and the sidebar tile animation stop at once. The
    // server registry itself is corrected by the next sidebar list sync.
    const [terminateState, setTerminateState] = React.useState<{ isSubmitting: boolean }>({
        isSubmitting: false
    });

    const handleTerminateJob = React.useCallback(async () => {
        if (!selected?.storyId) return;
        setTerminateState({ isSubmitting: true });
        try {
            await abortStoryJob(store.config.baseUrl, selected.storyId);
            // Terminate is a user action — bump the ordering timestamp.
            touchStory(selected.storyId);

            // Cancel THIS session's poll loops immediately — the entry-scoped
            // shouldStop (activePollIdRef !== entryId) makes the job-gated
            // loop return 'stopped' on its next wake-up without touching the
            // store, and the re-expand/rewrite completion poller is dropped
            // entirely (its effect cleanup cancels the in-flight loop).
            activePollIdRef.current = null;
            setReExpandState(null);

            // Retire the processing flags so the banner + tab chip stop
            // animating right away (the server-side job exits asynchronously;
            // the next list sync re-establishes serverProcessing from the
            // registry once the flow has unwound).
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === selected.id
                        ? { ...e, isProcessing: false, serverProcessing: false, error: '' }
                        : e
                ),
                selected:
                    prev.selected?.id === selected.id
                        ? { ...prev.selected, isProcessing: false, serverProcessing: false, error: '' }
                        : prev.selected
            }));
        } catch (err: any) {
            // Abort PATCH failed (network / stale server) — surface the exact
            // reason in the content-error banner; the processing flags stay
            // as they were so the user can retry the termination.
            setStore((prev) => ({
                ...prev,
                records: prev.records.map((e) =>
                    e.id === selected.id ? { ...e, error: err?.message || 'Failed to terminate job' } : e
                ),
                selected:
                    prev.selected?.id === selected.id
                        ? { ...prev.selected, error: err?.message || 'Failed to terminate job' }
                        : prev.selected
            }));
        } finally {
            setTerminateState({ isSubmitting: false });
        }
    }, [selected, store.config.baseUrl, setStore, touchStory]);

    // Whether the action bar should be enabled: append requires at least one
    // existing chapter (the server rejects appends to chapter-less stories),
    // so the bar appears as soon as any chapter is present.
    const hasChapters = (data?.chapters ?? []).length > 0;

    // Whether the plotline looks stopped before reaching its target — the
    // resume button's visibility gate. The comparison target is the LARGER of
    // the server's meta.chapterCount (interrupted create: chapters frozen
    // below it) and the entry's chapterRequested (interrupted append: merged
    // list data eventually rolls the bump back, but until then the client
    // remembers the larger intent). meta.status 'failed' covers the edge
    // where every chapter slot exists but the tail failed validation — the
    // server's resume completeness check regenerates it.
    // Requires meta (a real server story); a never-submitted local entry has
    // nothing to resume.
    const resumeTarget = Math.max(data?.meta?.chapterCount ?? 0, selected?.chapterRequested ?? 0);
    const canResume =
        Boolean(data?.meta) && (data.chapters.length < resumeTarget || data?.meta?.status === 'failed');

    // Current story size for the append dialog copy: server meta first, then
    // the polled chapter list, then the entry's requested count.
    const appendBaseCount =
        data?.meta?.chapterCount ?? data?.chapters?.length ?? selected?.chapterRequested ?? 0;

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

    // ── Story stats (chips above the chapter list) ────────────────────────
    // Total words = the ACTIVE revision per chapter (the dropdown selection,
    // falling back to the latest). Out-of-range selections (e.g. right after
    // a revision delete) clamp to the latest so the sum can never read a
    // missing revision as 0.
    const statChapters = data.chapters.length;
    const statWords = data.chapters.reduce((sum: number, ch: any, i: number) => {
        const revisions: Array<{ wordCount?: number }> = Array.isArray(ch.revisions) ? ch.revisions : [];
        if (revisions.length === 0) return sum;
        const idx = Math.min(activeRevisions[i] ?? revisions.length - 1, revisions.length - 1);
        return sum + (revisions[idx]?.wordCount ?? 0);
    }, 0);
    // Estimated LLM tokens: ~4 tokens per 3 words (≈1.33 tokens/word) — the
    // usual English-prose heuristic. A budget gauge, not an exact tokenizer
    // count (the real number depends on the model's tokenizer).
    const statTokens = Math.round((statWords * 4) / 3);

    return (
        <ContentColumn data-testid="content-story" className="sg-scroll">
            {/* In-progress banner: spinner chip + chapter progress count +
                the Terminate control (also shown for jobs this session did
                NOT start — serverProcessing from the server's registry).
                FLAT REWORK: Terminate is the modular danger Button (square
                corners, was the 999px TerminateButton pill). */}
            {(selected.isProcessing || selected.serverProcessing) && (
                <ProgressBanner data-testid="progress-banner">
                    <span className="sg-spinner" />
                    {selected.isProcessing ? (
                        <span>Generating {data.chapters.length}/{selected.chapterRequested} chapters…</span>
                    ) : (
                        <span>Background job running…</span>
                    )}
                    <Button
                        variant="danger"
                        onClick={handleTerminateJob}
                        disabled={terminateState.isSubmitting}
                        data-testid="terminate-job-button"
                        title={
                            terminateState.isSubmitting
                                ? 'Terminating…'
                                : 'Terminate the background job for this story (generated content is kept)'
                        }
                        style={{ fontSize: theme.fontSize.sm, fontWeight: 600, padding: '3px 10px' }}
                    >
                        <StopIcon />
                        {terminateState.isSubmitting ? 'Terminating…' : 'Terminate'}
                    </Button>
                </ProgressBanner>
            )}

            {/* Story stats — total chapters, total words of the currently-viewed
                revisions, and the estimated token cost of those words. Shown
                only once chapters exist (an empty story has nothing to sum).
                FLAT REWORK: the modular <Badge> chips (square + rail) replace
                the 999px StatChip pills; the label/value pair stays inside. */}
            {statChapters > 0 && (
                <StatsBar data-testid="story-stats">
                    <span data-testid="stat-chapters">
                        <Badge variant="neutral" style={{ fontSize: theme.fontSize.base, fontWeight: 500, padding: '4px 12px', gap: 8 }}>
                            <span style={{ color: theme.textMuted, fontWeight: 500 }}>Chapters</span>
                            <span>{statChapters}</span>
                        </Badge>
                    </span>
                    <span data-testid="stat-words">
                        <Badge variant="neutral" style={{ fontSize: theme.fontSize.base, fontWeight: 500, padding: '4px 12px', gap: 8 }}>
                            <span style={{ color: theme.textMuted, fontWeight: 500 }}>Words</span>
                            <span>{statWords.toLocaleString('en-US')}</span>
                        </Badge>
                    </span>
                    <span data-testid="stat-tokens">
                        <Badge variant="neutral" style={{ fontSize: theme.fontSize.base, fontWeight: 500, padding: '4px 12px', gap: 8 }}>
                            <span style={{ color: theme.textMuted, fontWeight: 500 }}>Tokens (est.)</span>
                            <span>~{statTokens.toLocaleString('en-US')}</span>
                        </Badge>
                    </span>
                </StatsBar>
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
                            {/* Plotpoints toggle button — right-aligned, collapsible.
                                The revealed plotpoints area carries the delete-chapter
                                control (deleteDisabled only while this chapter's own
                                removal PATCH is in flight). */}
                            {ch.plotpoints && ch.plotpoints.length > 0 && (
                                <PlotpointsWrapper
                                    plotpoints={ch.plotpoints}
                                    defaultOpen={!ch.expanded}
                                    testId={`chapter-${i}-plotpoints`}
                                    onDeleteChapter={() => openRemoveDialogue(ch.chapterIndex, ch.title)}
                                    deleteDisabled={removeState.isRemoving && removeState.chapterIndex === ch.chapterIndex}
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
                                    <>
                                        <IconButton
                                            onClick={() =>
                                                openRewriteDialogue(ch.chapterIndex, ch.revisions?.length, activeRevisions[i] ?? (ch.revisions?.length ?? 1) - 1)
                                            }
                                            title="Rewrite chapter with custom context"
                                            data-testid={`chapter-${i}-rewrite`}
                                        >
                                            <RewriteIcon />
                                        </IconButton>
                                        {/* Delete revision button — sits next to the rewrite [+].
                                            Only rendered for expanded chapters (a pending chapter
                                            has no revisions to delete). Targets the revision
                                            currently selected in the dropdown; deleting the last
                                            remaining revision returns the chapter to plotlines
                                            only. Opens the confirmation dialog first — the action
                                            is destructive and easy to hit accidentally next to
                                            the other chapter icons. */}
                                        {!!ch.expanded && (
                                            <IconButton
                                                onClick={() =>
                                                    openDeleteDialogue(
                                                        ch.chapterIndex,
                                                        activeRevisions[i] ?? (ch.revisions?.length ?? 1) - 1,
                                                        ch.revisions?.length ?? 0
                                                    )
                                                }
                                                title="Delete the selected revision of this chapter"
                                                data-testid={`chapter-${i}-delete`}
                                            >
                                                <TrashIcon />
                                            </IconButton>
                                        )}
                                    </>
                                }
                                actions={
                                    <>
                                        <IconButton
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
                                        </IconButton>
                                        <IconButton
                                            onClick={() => handleFork(ch.chapterIndex)}
                                            title="Fork from this chapter"
                                            data-testid={`chapter-${i}-fork`}
                                        >
                                            <ForkIcon />
                                        </IconButton>
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
                expanded chapter. The ▶ resume button continues an interrupted
                plotline generation (server restart, exhausted retries) — it
                renders whenever the chapter list sits below its target (or the
                server marked the story failed), even with zero chapters, since
                a generation that died before its first chapter is exactly the
                case resume exists for. The [->] button opens the in-place
                append-chapters dialog; appending needs at least one existing
                chapter (the server rejects chapter-less stories). */}
            {(hasChapters || canResume) && (
                <ActionBar data-testid="content-action-bar">
                    {hasChapters && (
                        <Button
                            variant="outline"
                            onClick={handleCollapseAll}
                            data-testid="collapse-all-button"
                            title="Collapse all chapters"
                        >
                            <CollapseAllIcon />
                        </Button>
                    )}
                    {canResume && (
                        <Button
                            variant="outline"
                            onClick={handleResume}
                            disabled={resumeState.isSubmitting}
                            data-testid="resume-generation-button"
                            title={
                                resumeState.isSubmitting
                                    ? 'Resuming generation…'
                                    : `Resume plotline generation (${data.chapters.length}/${resumeTarget} chapters)`
                            }
                        >
                            <ResumeIcon />
                        </Button>
                    )}
                    {hasChapters && (
                        <Button
                            variant="outline"
                            onClick={openAppendDialogue}
                            data-testid="extend-plotpoints-button"
                            title={`Append ${appendState.chapterCount} new chapters to this story`}
                        >
                            <ExtendIcon />
                        </Button>
                    )}
                </ActionBar>
            )}

            {/* ── Rewrite dialog — STANDARD PATTERN ─────────────────────────
                <Dialog> header/body/footer. The textarea keeps its autofocus
                + caret-to-end behaviour (restores the prefill edit UX). */}
            <Dialog
                open={rewriteState.isOpen}
                title={`Rewrite Chapter ${rewriteState.chapterIndex + 1}`}
                onClose={closeRewriteDialogue}
                testId="rewrite-dialog"
            >
                <Dialog.Body>
                    <DialogCopy>
                        Provide instructions for how this chapter should be rewritten.
                        The full story summary will be used as context.
                    </DialogCopy>
                    <Textarea
                        value={rewriteContextInput}
                        onChange={(e) => setRewriteContextInput(e.target.value)}
                        placeholder="e.g. Make the scene more dramatic, add more tension, slow down the pacing..."
                        autoFocus
                        onFocus={(e) => {
                            const len = e.target.value.length;
                            e.target.setSelectionRange(len, len);
                        }}
                        data-testid="rewrite-context-input"
                        style={{ minHeight: 120, fontSize: theme.fontSize.base }}
                    />
                </Dialog.Body>
                <Dialog.Footer>
                    <Dialog.CancelButton onClick={closeRewriteDialogue} data-testid="rewrite-cancel">
                        Cancel
                    </Dialog.CancelButton>
                    <Dialog.ConfirmButton
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
                    >
                        Rewrite
                    </Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>

            {/* ── Append-chapters dialog — STANDARD PATTERN ──────────────────
                Mirrors the footer generation box: a notes textarea (optional
                plotline guidance for the appended chapters) + chapter count +
                a primary action. Submitting POSTs { append: { chapterCount,
                notes? } } to this SAME storyId (appendStoryPlotpoints) — the
                server appends plotpoints-only chapters after the current
                list and the new chapters appear via the restarted poll loop.
                dismissable=false while submitting (Dialog prop) reproduces
                the old mid-flight close guard. */}
            <Dialog
                open={appendState.isOpen}
                title={`Append Chapters to ${selected.storyName || selected.storyId}`}
                dismissable={!appendState.isSubmitting}
                onClose={closeAppendDialogue}
                testId="append-dialog"
            >
                <Dialog.Body>
                    <DialogCopy>
                        This story has {appendBaseCount} chapter{appendBaseCount === 1 ? '' : 's'}. Appending
                        adds new plotpoint chapters after the current list ({appendBaseCount} + new = total) — chapters are not auto-expanded.
                    </DialogCopy>
                    <Textarea
                        rows={5}
                        value={appendState.notes}
                        onChange={(e) =>
                            setAppendState((prev) => (prev.isSubmitting ? prev : { ...prev, notes: e.target.value, error: '' }))
                        }
                        placeholder="Optional — plotpoints or guidance for the new chapters, e.g. 'the crew splits into two groups, each chasing a different lead…'"
                        disabled={appendState.isSubmitting}
                        data-testid="append-notes-input"
                        style={{ maxHeight: 200 }}
                    />
                    {/* No Cancel button in this dialog — the user is here to
                        append chapters; closing the dialog (overlay click)
                        is sufficient to abort. The control row lives in the
                        footer: chapters label + count + the primary Append. */}
                    {/* Inline error INSIDE the primary body (above the footer)
                        — matches the delete/remove dialogs' placement. Was a
                        second <Dialog.Body> AFTER <Dialog.Footer>, which the
                        Dialog frame renders fine but is a pattern smell. */}
                    {appendState.error && (
                        <DialogErrorLine data-testid="append-error">{appendState.error}</DialogErrorLine>
                    )}
                </Dialog.Body>
                <Dialog.Footer>
                    <label
                        htmlFor="append-count"
                        style={{ color: theme.textMuted, fontSize: theme.fontSize.md, fontWeight: 500, marginRight: 'auto' }}
                    >
                        Chapters
                    </label>
                    <NumberInput
                        id="append-count"
                        min={1}
                        max={99}
                        value={appendState.chapterCount}
                        onChange={(e) =>
                            setAppendState((prev) =>
                                prev.isSubmitting ? prev : { ...prev, chapterCount: Number(e.target.value), error: '' }
                            )
                        }
                        disabled={appendState.isSubmitting}
                        data-testid="append-count-input"
                    />
                    {/* Append — the footer's Generate analogue: submits the
                        append POST for this story in place. className must
                        stay EXACTLY 'sg-primary' (Button variant supplies it;
                        App.test asserts via behavior, the class hook drives
                        the hover fill). */}
                    <Button
                        variant="primary"
                        onClick={handleAppend}
                        disabled={appendState.isSubmitting}
                        data-testid="append-button"
                    >
                        {appendState.isSubmitting ? 'Appending…' : 'Append'}
                    </Button>
                </Dialog.Footer>
            </Dialog>

            {/* ── Delete-revision confirmation — STANDARD PATTERN ───────────
                Shown when deleteState.isOpen. Guards the destructive action
                behind an explicit confirm: clicking the trash can only opens
                this; the PATCH fires on Delete. Overlay click / Cancel abort
                (no request sent). Title text is the exact test contract
                ("Delete Chapter N — Revision R of M"). */}
            <Dialog
                open={deleteState.isOpen}
                title={`Delete Chapter ${deleteState.chapterIndex + 1} — Revision ${deleteState.revisionIndex + 1} of ${deleteState.revisionCount}`}
                dismissable={!deleteState.isDeleting}
                onClose={closeDeleteDialogue}
                testId="delete-dialog"
            >
                <Dialog.Body>
                    <DialogCopy>
                        {/* Only the selected revision is removed; the chapter's
                            other revisions survive. Deleting the last revision is
                            what returns the chapter to plotlines only. */}
                        {deleteState.revisionCount > 1
                            ? `This removes revision ${deleteState.revisionIndex + 1} of ${deleteState.revisionCount} from Chapter ${deleteState.chapterIndex + 1}. The chapter's other revisions are kept. This cannot be undone.`
                            : `This removes the chapter's only revision — the chapter returns to plotlines only and can be expanded again. This cannot be undone.`}
                    </DialogCopy>
                    {deleteState.error && (
                        <DialogErrorLine data-testid="delete-error">{deleteState.error}</DialogErrorLine>
                    )}
                </Dialog.Body>
                <Dialog.Footer>
                    <Dialog.CancelButton onClick={closeDeleteDialogue} disabled={deleteState.isDeleting} data-testid="delete-cancel">
                        Cancel
                    </Dialog.CancelButton>
                    <Dialog.ConfirmButton
                        tone="danger"
                        onClick={handleDeleteChapter}
                        disabled={deleteState.isDeleting}
                        data-testid="delete-confirm"
                    >
                        {deleteState.isDeleting ? 'Deleting…' : 'Delete'}
                    </Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>

            {/* ── Remove-entire-chapter confirmation — STANDARD PATTERN ──────
                Opened by the "Delete Chapter" control inside the plotpoints
                area. Unlike the delete-revision dialog above (which keeps the
                chapter), this removes the chapter outright: plotpoints, every
                revision, and the slot itself; later chapters renumber. Overlay
                click / Cancel abort (no request sent). */}
            <Dialog
                open={removeState.isOpen}
                title={`Remove Chapter ${removeState.chapterIndex + 1}${removeState.title ? `: ${removeState.title}` : ''}`}
                dismissable={!removeState.isRemoving}
                onClose={closeRemoveDialogue}
                testId="remove-chapter-dialog"
            >
                <Dialog.Body>
                    <DialogCopy>
                        This permanently removes the chapter — its plotpoints and every revision of its expanded
                        content. Chapters after it are renumbered to fill the gap. This cannot be undone.
                    </DialogCopy>
                    {removeState.error && (
                        <DialogErrorLine data-testid="remove-chapter-error">{removeState.error}</DialogErrorLine>
                    )}
                </Dialog.Body>
                <Dialog.Footer>
                    <Dialog.CancelButton onClick={closeRemoveDialogue} disabled={removeState.isRemoving} data-testid="remove-chapter-cancel">
                        Cancel
                    </Dialog.CancelButton>
                    <Dialog.ConfirmButton
                        tone="danger"
                        onClick={handleRemoveChapter}
                        disabled={removeState.isRemoving}
                        data-testid="remove-chapter-confirm"
                    >
                        {removeState.isRemoving ? 'Removing…' : 'Remove Chapter'}
                    </Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>
        </ContentColumn>
    );
});
