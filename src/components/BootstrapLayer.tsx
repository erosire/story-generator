// Bootstrap layer: fetches the list of all existing stories on mount and seeds
// the store with one entry per story ID.
//
// Mirrors library/workflow/lightning-agent/components/PersistenceLayer.tsx
// (a hidden component mounted inside <ContextProvider> whose sole job is to
// load existing state into the store on mount — renders nothing).
//
// Behavior:
//   - On mount, calls fetchStoryList(config.baseUrl) once.
//   - If the list is non-empty, hydrates store.records with one StoryEntry per
//     story ID and selects the first one (so the user immediately sees the
//     latest story's content via SectionStoryContent's polling effect, which
//     kicks in once chapterCount > 0 — but for a *remote* story we don't know
//     chapterCount up-front; see note below on chapterCount seeding).
//   - On error, sets a loadWarning on store.config (read by the dashboard
//     header so the user can see the backend is unreachable).
//   - Renders null — purely a side-effect component.
//
// NOTE on chapterCount for remotely-listed stories:
//   The "list" endpoint returns only story IDs (see storyboard-generations.yml
//   StoryListResponse) — no chapter count. For a remote story we don't have a
//   target chapter count to compare against, so we seed each entry with
//   chapterCount = 0 and rely on the SectionStoryInput form to allow re-typing
//   / re-triggering generation. The SectionStoryContent polling effect requires
//   chapterCount > 0 before it starts polling (see SectionStoryContent.tsx).
//
//   To give the user visibility into the remote story's chapters on first load
//   WITHOUT a chapter target, we also seed the entry with chapterCount = -1 as
//   a sentinel meaning "remote — poll once to hydrate then stop". SectionStoryContent
//   special-cases this sentinel (see its effect guard) so it does a single fetch
//   cycle, storing whatever chapters/plotlines the server currently has, without
//   looping on a count target.
//
//   -> Decision: keep it simple. Seed chapterCount = 0 (matches the
//   SectionStoryContent "pending submit" empty state). The sidebar auto-refreshes
//   periodically to pick up new stories, so there's no need for a manual Refresh
//   button or a sentinel-based single-fetch mechanism.

import React from 'react';
import { useStoryStore } from '../context';
import { fetchStoryList } from '../api';

// Build a StoryEntry from a bare storyId. We give each seeded entry a unique
// client-side `id` (descending negative timestamps so they never collide with
// the Date.now() positive ids used by freshly-added empty stories).
const makeEntryFromStoryId = (storyId: string, index: number) => ({
    id: -(Date.now() + index + 1),
    storyId,
    // Title = first 8 chars of the storyId (matches AddNewButton's convention
    // in SectionStoryTabs.tsx but trimmed to 8 chars for the chip width).
    title: storyId.slice(0, 8),
    storyline: '',
    chapterCount: 0,
    data: null,
    isProcessing: false,
    error: '',
    // Marked remote so SectionStoryContent polls to hydrate on selection
    // despite chapterCount being unknown from the /list response.
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

                // Sort stories newest-first? The server's list branch sorts
                // ascending; for a typical user expectation we reverse to show
                // the most-recently-created story first in the tab strip, then
                // select it. (We reverse here since server returns names sort()d
                // ascending — UUIDs sort lexically, which roughly correlates with
                // creation order, so reversal gives "newest first".)
                const ordered = [...stories];
                const entries = ordered.map((sid, i) => makeEntryFromStoryId(sid, i));

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
