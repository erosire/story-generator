// Content section: progressively fetches story data via the GET endpoint and
// renders plotlines + chapters for the currently selected story.
//
// Mirrors library/workflow/lightning-agent/components/SectionContentDisplay.tsx
// in shape (reads `selected` from the store, renders messages into Markdown) but
// the data source is the storyboard GET endpoint (poll-based) rather than an
// in-memory agent conversation.
//
// Polling lifecycle (driven by useEffect on selected.id):
//   1. When a story with chapterCount > 0 is selected, start a pollStoryData
//      loop (see api/storyboard.ts). Mark entry.isProcessing = true.
//   2. Each onData callback updates the entry's data in the store — the plotlines
//      appear as soon as plotpoint.md is written (fast), chapters fill in one by one.
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
    // Matches the slight top offset used by lightning-agent EmptyState
    // (library/workflow/lightning-agent/components/SectionContentDisplay.tsx:26).
    paddingTop: 48
});

// Hint shown when a story is selected but its generation hasn't been triggered
// (i.e. the user hasn't submitted a storyline via the Generate button yet).
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

// Plotlines block wrapper — now delegates markdown rendering to MarkdownContent.
// Retains the container styling (background, border, padding) for visual
// consistency while the content inside is rendered as rich markdown.
const PlotBlock = styled('div', {
    background: 'rgba(255, 255, 255, 0.03)',
    padding: 12,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.08)'
});

// Chapter card wrapper — now delegates markdown rendering to MarkdownContent.
// The server returns chapter content as markdown (## Title\n\nbody), so we
// render it through react-markdown for proper formatting.
const ChapterCard = styled('div', {
    background: 'rgba(255, 255, 255, 0.03)',
    padding: 16,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.08)'
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
                // If the patched entry is the selected one, refresh the reference too
                // (mirrors the lightning-agent `store.selected = entry` pattern).
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

    // Polling effect. Runs whenever the selected entry's id, storyId,
    // chapterCount, current chapter count, isRemote, or config changes.
    //
    // Two ways to start polling:
    //   1. chapterCount > 0 (fresh POST — known target count). Terminate when
    //      chapters.length reaches chapterCount.
    //   2. isRemote === true (entry came from GET /list — unknown target). Pass
    //      expectedChapterCount=0 so the loop terminates via poll-stability
    //      (two consecutive identical polls — see api/storyboard.ts).
    React.useEffect(() => {
        if (!selected || !selected.storyId) {
            return;
        }

        // Poll only when the entry is in a pollable state:
        //   - remote (always pollable on selection), OR
        //   - has a target chapterCount > 0 (fresh POST).
        const pollable = selected.isRemote || selected.chapterCount > 0;
        if (!pollable) {
            return;
        }

        // If we already have all requested chapters and the target is known,
        // no need to start polling. (Remote mode has no fixed target — we always
        // re-poll on selection to refresh, since the story could have new chapters
        // since the last fetch. The poll loop self-terminates via stability.)
        if (selected.chapterCount > 0 && selected.data && selected.data.chapters.length >= selected.chapterCount) {
            return;
        }

        const entryId = selected.id;
        const { storyId, chapterCount, isRemote } = selected;
        const baseUrl = store.config.baseUrl;
        const pollIntervalMs = store.config.pollIntervalMs;

        // Mark as processing so the tab chip shows the ⏳ badge.
        setStore((prev) => ({
            ...prev,
            records: prev.records.map((e) =>
                e.id === entryId ? { ...e, isProcessing: true, error: '' } : e
            )
        }));

        activePollIdRef.current = entryId;

        // Capture the entryId locally for shouldStop — we cancel the loop on
        // unmount or when the user selects a different story.
        const shouldStop = () => activePollIdRef.current !== entryId;

        // onData fires on every successful GET; updates the store entry in place
        // so the UI progressively reveals plotlines then chapters.
        const onData = (data: { plotlines: string; chapters: { length: number; content: string }[] }) => {
            // Use the functional form so we don't depend on the closure's stale
            // store snapshot.
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.id === entryId
                        ? { ...e, data: { plotlines: data.plotlines, chapters: data.chapters } }
                        : e
                );
                // Keep `selected` pointing at the updated record if relevant.
                const selected =
                    prev.selected?.id === entryId
                        ? records.find((e) => e.id === entryId) ?? prev.selected
                        : prev.selected;
                return { ...prev, records, selected };
            });
        };

        // Fire-and-forget poll loop. We don't await here because the loop
        // self-terminates via shouldStop; awaiting would block the effect forever
        // and React would warn about long-running effects.
        pollStoryData({
            baseUrl,
            storyId,
            // Pass the known target only when chapterCount > 0. For remote
            // entries pass 0 → loop terminates via poll-stability instead.
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
                        // 'data' or 'stopped' — terminal. Clear isProcessing.
                        // 'stopped' (cancelled) leaves the last-known data intact.
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
                // Network/parse error from the loop itself (shouldn't normally
                // happen because fetchStoryData catches and returns 'error').
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
                // Only clear the active poll ref if we're still the active one —
                // otherwise we'd reset a poll that has already been replaced.
                if (activePollIdRef.current === entryId) {
                    activePollIdRef.current = null;
                }
            });

        // Cleanup: signal cancellation. We DON'T clear isProcessing here
        // because the .then chain above is responsible for that; we only clear
        // the ref so shouldStop() returns true on the next iteration.
        return () => {
            if (activePollIdRef.current === entryId) {
                activePollIdRef.current = null;
            }
        };
        // Intentionally depend on selected.id, storyId, chapterCount, current
        // chapter count, isRemote, and config. We rebuild the effect only when
        // these destabilize so the loop's shouldStop closure reflects the
        // right entry.
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

    // Pending-submit hint only applies to locally-added entries that have NOT
    // been POSTed yet (chapterCount === 0 && !isRemote). Remote entries from
    // the /list endpoint poll on selection regardless of chapterCount, so they
    // never show this hint — they fall through to the content render below.
    if (!selected.isRemote && selected.chapterCount <= 0) {
        return (
            <PendingSubmitHint data-testid="content-pending-submit">
                Enter a storyline and chapter count in the field below, then click
                “Generate” to start generation for story{' '}
                <code>{selected.storyId}</code>.
                {selected.error && (
                    <div style={{ color: '#ff6b6b', marginTop: 12 }}>
                        Last error: {selected.error}
                    </div>
                )}
            </PendingSubmitHint>
        );
    }

    const data = selected.data ?? { plotlines: '', chapters: [] };

    return (
        <ContentColumn data-testid="content-story">
            <div>
                {selected.isProcessing && (
                    <div style={{ color: '#a0a0a0', fontSize: 12, marginBottom: 8 }}>
                        Generating… {data.chapters.length}/{selected.chapterCount} chapters
                    </div>
                )}
                {/* Plotlines: collapsible. Starts open so the user sees the
                    generated outline immediately; can collapse to focus on
                    chapters below. */}
                <Collapsible
                    title="Plotlines"
                    defaultOpen={true}
                    data-testid="plotlines-collapsible"
                >
                    {data.plotlines ? (
                        <PlotBlock data-testid="plotlines">
                            <MarkdownContent>{data.plotlines}</MarkdownContent>
                        </PlotBlock>
                    ) : (
                        <PlotBlock style={{ color: '#6b6b6b', fontStyle: 'italic' }}>
                            {selected.isProcessing ? 'Waiting for plotpoint.md…' : 'No plotlines yet.'}
                        </PlotBlock>
                    )}
                </Collapsible>
            </div>

            <div>
                {/* Chapters: collapsible. Starts open. Collapsing the section
                    hides all chapter cards but keeps the section heading /
                    count summary accessible. */}
                <Collapsible
                    title="Chapters"
                    defaultOpen={true}
                    data-testid="chapters-collapsible"
                    headerExtra={
                        data.chapters.length > 0 ? (
                            <span
                                style={{
                                    fontSize: 11,
                                    color: '#a0a0a0',
                                    background: 'rgba(255,255,255,0.05)',
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    marginLeft: 'auto'
                                }}
                            >
                                {data.chapters.length} chapter{data.chapters.length === 1 ? '' : 's'}
                            </span>
                        ) : null
                    }
                >
                    {data.chapters.length === 0 && (
                        <div style={{ color: '#6b6b6b', fontStyle: 'italic', padding: '8px 0' }}>
                            {selected.isProcessing ? 'Waiting for the first chapter…' : 'No chapters yet.'}
                        </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {data.chapters.map((ch, i) => (
                            // Each chapter is itself collapsible so the user can
                            // fold away long expanded chapters to skim the list.
                            // Collapsed by default for chapters AFTER the latest one
                            // (matches the lightning-agent "auto-collapse older
                            // messages" pattern in SectionContentDisplay.tsx:92),
                            // keeping the freshly-generated chapter open for reading.
                            <Collapsible
                                key={i}
                                defaultOpen={i === data.chapters.length - 1}
                                data-testid={`chapter-${i}`}
                                title={
                                    <span style={{ fontSize: 13, color: '#e0e0e0' }}>
                                        Chapter {i + 1}
                                    </span>
                                }
                                headerExtra={
                                    <span
                                        style={{
                                            fontSize: 11,
                                            color: '#a0a0a0',
                                            background: 'rgba(255,255,255,0.05)',
                                            padding: '2px 6px',
                                            borderRadius: 4
                                        }}
                                    >
                                        {ch.length} words
                                    </span>
                                }
                            >
                                <ChapterCard data-testid={`chapter-${i}-content`}>
                                    <MarkdownContent>{ch.content}</MarkdownContent>
                                </ChapterCard>
                            </Collapsible>
                        ))}
                    </div>
                </Collapsible>
            </div>

            {selected.error && (
                <div style={{ color: '#ff6b6b', fontSize: 13 }} data-testid="content-error">
                    Error: {selected.error}
                </div>
            )}
        </ContentColumn>
    );
});
