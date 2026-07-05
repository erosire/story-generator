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

import React from 'react';
import { styled } from '../../styles';
import { useStoryStore } from '../../context';
import { pollStoryData } from '../../api';
import { Collapsible } from '../Collapsible';
import { MarkdownContent } from '../MarkdownContent';

// Empty-state placeholder shown when no story is selected.
const EmptyState = styled('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    color: '#6b6b6b',
    fontSize: 18,
    fontStyle: 'italic',
    paddingTop: 48
});

// Hint shown when a story is selected but its generation hasn't been triggered.
const PendingSubmitHint = styled('div', {
    color: '#a0a0a0',
    padding: 24
});

// Section wrapper for the content column.
const ContentColumn = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    padding: 24,
    gap: 24,
    height: '100%',
    boxSizing: 'border-box'
});

// Chapter card wrapper — renders expanded chapter content via MarkdownContent.
const ChapterCard = styled('div', {
    background: 'rgba(255, 255, 255, 0.03)',
    padding: 16,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.08)'
});

// Plotpoints list wrapper — renders the bullet list of plotpoints for a chapter.
const PlotpointsBlock = styled('div', {
    background: 'rgba(255, 255, 255, 0.03)',
    padding: 12,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    marginBottom: 8
});

// Info message shown when a chapter has not been expanded yet.
const PendingExpansion = styled('div', {
    color: '#a0a0a0',
    fontSize: 13,
    fontStyle: 'italic',
    padding: '8px 0'
});

// Chapters list container — flex column with gap between chapter collapsibles.
const ChapterListContainer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    paddingBottom: 80
});

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
                <code>{selected.storyId}</code>.
                {selected.error && (
                    <div style={{ color: '#ff6b6b', marginTop: 12 }}>
                        Last error: {selected.error}
                    </div>
                )}
            </PendingSubmitHint>
        );
    }

    const data = selected.data ?? { chapters: [], meta: null };

    return (
        <ContentColumn data-testid="content-story">
            <div>
                {selected.isProcessing && (
                    <div style={{ color: '#a0a0a0', fontSize: 12, marginBottom: 8 }}>
                        Generating… {data.chapters.length}/{selected.chapterCount} chapters
                    </div>
                )}
            </div>

            <ChapterListContainer data-testid="chapters-list">
                {data.chapters.length === 0 && (
                    <div style={{ color: '#6b6b6b', fontStyle: 'italic', padding: '8px 0' }}>
                        {selected.isProcessing ? 'Waiting for the first chapter…' : 'No chapters yet.'}
                    </div>
                )}
                {data.chapters.map((ch, i) => (
                    <Collapsible
                        key={i}
                        defaultOpen={i === data.chapters.length - 1}
                        data-testid={`chapter-${i}`}
                        title={
                            <span style={{ fontSize: 13, color: '#e0e0e0' }}>
                                Chapter {i + 1}{ch.title ? `: ${ch.title}` : ''}
                            </span>
                        }
                        headerExtra={
                            <span
                                style={{
                                    fontSize: 11,
                                    color: '#a0a0a0',
                                    background: 'rgba(255,255,255,0.05)',
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    display: 'inline-flex',
                                    gap: 6,
                                    alignItems: 'center'
                                }}
                            >
                                {ch.expanded ? (
                                    <>
                                        <span>{ch.length} words</span>
                                        {typeof ch.generationTimeMs === 'number' && ch.generationTimeMs > 0 && (
                                            <span style={{ color: '#7a9ec2' }}>
                                                {ch.generationTimeMs >= 60000
                                                    ? `${(ch.generationTimeMs / 60000).toFixed(1)}m`
                                                    : `${(ch.generationTimeMs / 1000).toFixed(1)}s`}
                                            </span>
                                        )}
                                    </>
                                ) : (
                                    <span style={{ color: '#7a9ec2' }}>Pending</span>
                                )}
                            </span>
                        }
                    >
                        {/* Plotpoints — always shown for every chapter */}
                        {ch.plotpoints && ch.plotpoints.length > 0 && (
                            <PlotpointsBlock data-testid={`chapter-${i}-plotpoints`}>
                                <div style={{ fontSize: 11, color: '#a0a0a0', marginBottom: 6, fontWeight: 600 }}>
                                    Plot Points
                                </div>
                                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#c0c0c0', lineHeight: 1.6 }}>
                                    {ch.plotpoints.map((pp: string, j: number) => (
                                        <li key={j}>{pp}</li>
                                    ))}
                                </ul>
                            </PlotpointsBlock>
                        )}

                        {/* Chapter expansion content — or pending message */}
                        {ch.expanded ? (
                            <ChapterCard data-testid={`chapter-${i}-content`}>
                                <MarkdownContent>{ch.content ?? ''}</MarkdownContent>
                            </ChapterCard>
                        ) : (
                            <PendingExpansion data-testid={`chapter-${i}-pending`}>
                                This chapter has not been expanded yet.
                            </PendingExpansion>
                        )}
                    </Collapsible>
                ))}
            </ChapterListContainer>

            {selected.error && (
                <div style={{ color: '#ff6b6b', fontSize: 13 }} data-testid="content-error">
                    Error: {selected.error}
                </div>
            )}
        </ContentColumn>
    );
});
