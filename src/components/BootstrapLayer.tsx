// Bootstrap layer: fetches the list of all existing stories on mount and seeds
// the store with one entry per story.
//
// Mirrors library/workflow/lightning-agent/components/PersistenceLayer.tsx
// (a hidden component mounted inside <ContextProvider> whose sole job is to
// load existing state into the store on mount — renders nothing).
//
// Behavior:
//   - On mount, calls fetchStoryList(config.baseUrl) once.
//   - If the list is non-empty, hydrates store.records with one StoryEntry per
//     story using the full StoryMeta from the server (storyId, storyline,
//     chapterCount, createdAt). Selects the first entry so the user immediately
//     sees the latest story's content.
//   - On error, sets a loadWarning on store.config (read by the dashboard
//     header so the user can see the backend is unreachable).
//   - Renders null — purely a side-effect component.

import React from 'react';
import { useStoryStore } from '../context';
import { fetchStoryList, type StoryMeta } from '../api';

// Build a StoryEntry from a StoryMeta object returned by GET /list.
// The list endpoint now returns full metadata (storyId, storyline, chapterCount,
// createdAt) so we can seed the entry with the server's values. We give each
// seeded entry a unique client-side `id` (descending negative timestamps so they
// never collide with the Date.now() positive ids used by freshly-added empty stories).
const makeEntryFromStoryMeta = (meta: StoryMeta, index: number) => ({
    id: -(Date.now() + index + 1),
    storyId: meta.storyId,
    // Title = first 8 chars of the storyId (matches AddNewButton's convention
    // in SectionStoryTabs.tsx but trimmed to 8 chars for the chip width).
    title: meta.storyId.slice(0, 8),
    storyline: '',
    chapterCount: meta.chapterCount,
    data: null,
    isProcessing: false,
    error: '',
    // Marked remote so SectionStoryContent polls to hydrate on selection.
    // Now that the list returns chapterCount, the polling uses the known target
    // instead of stability-based termination.
    isRemote: true
});

// Hidden bootstrap layer. Renders nothing; only effects.
export const BootstrapLayer: React.FC = React.memo(() => {
    const { store, setStore } = useStoryStore();

    // Ref to prevent double-fetch in React StrictMode dev double-mount.
    const didFetchRef = React.useRef(false);

    React.useEffect(() => {
        if (didFetchRef.current) return;
        didFetchRef.current = true;

        // Capture the baseUrl at mount — store.config is captured here, so if
        // the consumer swaps it later the bootstrap only fires once.
        const baseUrl = store.config.baseUrl;

        fetchStoryList(baseUrl)
            .then(({ stories }) => {
                // No stories → leave store.records empty (the user can still
                // type a storyline and click Generate to create one locally).
                if (!stories || stories.length === 0) {
                    return;
                }

                // Server returns stories sorted by createdAt descending (newest
                // first). Build one StoryEntry per StoryMeta using the full
                // metadata (storyline, chapterCount, etc.).
                const entries = stories.map((meta, i) => makeEntryFromStoryMeta(meta, i));

                setStore((prev) => {
                    // Avoid clobbering any records that were pre-seeded via
                    // initialStore prop (eg. by tests). Merge remote entries on top,
                    // de-duplicating by storyId so a test fixture doesn't double.
                    const existingIds = new Set(prev.records.map((r) => r.storyId));
                    const merged = [
                        ...prev.records,
                        ...entries.filter((e) => !existingIds.has(e.storyId))
                    ];
                    // If no entry is currently selected, default-select the first
                    // remote entry (most recent if we reversed). Wrap in try/catch
                    // semantics: selecting null is fine when the list is empty.
                    const selected = prev.selected ?? (merged.length > 0 ? merged[0] : null);
                    return { ...prev, records: merged, selected };
                });
            })
            .catch((err: Error) => {
                // Surface a non-blocking warning rather than crashing the dashboard —
                // the user can still Add a story locally and POST (the bootstrap
                // failure shouldn't block the whole UI).
                setStore((prev) => ({ ...prev, loadWarning: err.message }));
                console.warn('[BootstrapLayer] Failed to list existing stories.', err);
            });
        // Intentionally run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
});
