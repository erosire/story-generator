// Content section: progressively fetches story data via the GET endpoint and
// renders chapters for the currently selected story.
//
// The API returns a unified chapters array where each chapter includes its
// plotpoints and expansion status. Chapters are displayed as individual
// collapsibles. Within each chapter, plotpoints are listed first, followed by
// the expanded content (or an informational message if not yet expanded).
//
// Polling lifecycle (driven by useEffect on selected.id):
//   1. When a story with chapterCount > 0 is selected, start a pollStoryData
//      loop (see api/storyboard.ts). Mark entry.isProcessing = true.
//   2. Each onData callback updates the entry's data in the store — chapters
//      appear as soon as plotpoint.json is written, then expand one by one.
//   3. The loop terminates when chapters.length >= chapterCount, a hard error
//      occurs, or the user selects a different story (cancellation).
//
// Edge cases:
//   - chapterCount == 0 means the story was added locally but never submitted
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
import { pollStoryData } from '../../api';
import { Collapsible } from '../Collapsible';
import { MarkdownContent } from '../MarkdownContent';

// Empty-state placeholder shown when no story is selected. Modern: monospace
// "drawing" glyph + elevated typography for a calm centered hero state.
const EmptyState = styled('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    color: theme.textFaint,
    fontSize: 16,
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
// and content. Modern: elevated translucent surface with hover-lift on the
// card itself + a hairline accent left-bar to read as a chapter panel.
const ChapterCard = styled('div', {
    background: theme.surface2,
    padding: 16,
    borderRadius: theme.radiusLg,
    border: `1px solid ${theme.border}`,
    boxShadow: theme.shadowSm
});

// Plotpoints toggle button — right-aligned, button-like appearance.
const PlotpointsButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    padding: '4px 12px',
    fontSize: 12,
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
    fontSize: 15,
    fontStyle: 'italic',
    padding: '8px 0'
});

// Chapters list container — flex column with gap between chapter collapsibles.
const ChapterListContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    paddingBottom: 80
});

// In-progress status banner — uses accent-tinted surface so the user notices
// generation is running without the warning connotation of red/yellow.
const ProgressBanner = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: theme.textMuted,
    fontSize: 12,
    padding: '8px 12px',
    borderRadius: theme.radiusMd,
    background: theme.accentSoft,
    border: `1px solid rgba(99, 102, 241, 0.25)`,
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
                <span style={{ fontSize: 11, color: theme.textFaint }}>({plotpoints.length})</span>
            </PlotpointsButton>
            {open && (
                <PlotpointsList data-testid={`${testId}-body`} className="sg-fade-in">
                    <ul
                        style={{
                            margin: 0,
                            paddingLeft: 22,
                            fontSize: 14,
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

// Word-count + timing chip rendered in the chapter header. Encapsulated so the
// styling stays consistent and the JSX below stays declarative.
const ChapterMeta: React.FC<{ chapter: any }> = ({ chapter }) => (
    <span
        style={{
            fontSize: 12,
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
                <span>{chapter.length} words</span>
                {typeof chapter.generationTimeMs === 'number' && chapter.generationTimeMs > 0 && (
                    <span style={{ color: theme.accent2 }}>
                        {chapter.generationTimeMs >= 60000
                            ? `${(chapter.generationTimeMs / 60000).toFixed(1)}m`
                            : `${(chapter.generationTimeMs / 1000).toFixed(1)}s`}
                    </span>
                )}
            </>
        ) : (
            <span style={{ color: theme.accent2 }}>Pending</span>
        )}
    </span>
);

export const SectionStoryContent: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();
    const { selected } = store;

    // Ref that holds the *currently polled* entry.id so the effect's cleanup
    // can flip shouldStop(). Using a ref avoids stale-closure problems across
    // re-renders.
    const activePollIdRef = React.useRef<number | null>(null);

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

    // Polling effect.
    React.useEffect(() => {
        if (!selected || !selected.storyId) {
            return;
        }

        const pollable = selected.isRemote || selected.chapterCount > 0;
        if (!pollable) {
            return;
        }

        if (selected.chapterCount > 0 && selected.data && selected.data.chapters.length >= selected.chapterCount) {
            return;
        }

        const entryId = selected.id;
        const { storyId, chapterCount, isRemote } = selected;
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
        const onData = (data: { chapters: any[]; meta: any }) => {
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.id === entryId
                        ? { ...e, data: { chapters: data.chapters, meta: data.meta } }
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
            expectedChapterCount: chapterCount > 0 ? chapterCount : 0,
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
        selected?.chapterCount,
        selected?.isRemote,
        selected?.data?.chapters.length,
        store.config.baseUrl,
        store.config.pollIntervalMs
    ]);

    // Render hygiene: null-safety on each branch.
    if (!selected) {
        return (
            <EmptyState data-testid="content-empty">Select one</EmptyState>
        );
    }

    if (!selected.isRemote && selected.chapterCount <= 0) {
        return (
            <PendingSubmitHint data-testid="content-pending-submit">
                Enter a storyline and chapter count in the field below, then click
                "Generate" to start generation for story{' '}
                <code style={{ color: theme.accent }}>{selected.storyId}</code>.
                {selected.error && (
                    <div style={{ color: theme.danger, marginTop: 12 }}>
                        Last error: {selected.error}
                    </div>
                )}
            </PendingSubmitHint>
        );
    }

    const data = selected.data ?? { chapters: [], meta: null };

    return (
        <ContentColumn data-testid="content-story" className="sg-scroll">
            {/* In-progress banner: spinner chip + chapter progress count. */}
            {selected.isProcessing && (
                <ProgressBanner>
                    <span className="sg-spinner" />
                    <span>Generating {data.chapters.length}/{selected.chapterCount} chapters…</span>
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
                        defaultOpen={i === data.chapters.length - 1}
                        data-testid={`chapter-${i}`}
                        title={
                            <span style={{ fontSize: 15, color: theme.text, fontWeight: 500 }}>
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

                            {/* Chapter expansion content — or pending message */}
                            {ch.expanded ? (
                                <MarkdownContent>{ch.content ?? ''}</MarkdownContent>
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
                        fontSize: 13,
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
        </ContentColumn>
    );
});
