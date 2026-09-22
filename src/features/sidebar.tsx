// Sidebar FEATURE: vertical list of all stories in order.
//
// Replaces the previous horizontal tab bar. Each tile is a two-row card:
// row 1 = the story title (the "x" delete control pinned to the tile's
// top-right corner, unchanged), row 2 = the cached-locally icon followed by
// the status badges (chapter count, processing indicator):
//
//     [Story title]              [x]
//     [Icon] [Chapters] [⏳]
//
// Clicking the tile body selects it (store.selected = entry) so the content
// area displays that story; clicking the "x" permanently deletes that story
// (identified DELETE).
//
// CACHED-LOCALLY INDICATOR (three states, data-testid "story-cached-<storyId>"
// in every state, leading the tile's meta row): each tile carries a small
// glyph showing the story's LOCAL-SAVE state:
//   - disk icon (title "Cached locally") — entry.data non-null: the story's
//     chapters are stored in this browser (hydrated from the localStorage /
//     IndexedDB cache or fetched into it this session) and viewable offline.
//   - cloud-off icon (title "Not saved locally — open once while connected")
//     — entry.data null: only server metadata is known; the chapters have
//     never been fetched here, so offline it renders metadata-only.
//   - warning save-off icon — this story HAS cached content but its latest
//     localStorage quick-cache copy failed. The IndexedDB mirror may still
//     have accepted the full durable copy asynchronously.
// The icon is informational only — no click behavior, it is rendered inside
// the tile's select button like the badges.
//
// CACHE-HEALTH CHIP (data-testid "cache-warning"): below the load warning, a
// chip appears when the local cache is degraded — one or more localStorage
// quick-cache copies failed, the boot write-probe found storage unavailable
// (store.storageUnavailableAtBoot) or the origin's quota FULL
// (store.storageFullAtBoot), or a boot recovery/upgrade restored records
// from the IndexedDB mirror (informational). TIER-AWARE: when the durable
// mirror sync ALSO failed (store.cacheMirrorWriteFailed), the copy escalates
// to "stories cannot be saved on this device" instead of the hedged "may
// still be available" line. See store.cacheWriteFailed /
// store.storageUnavailableAtBoot / store.storageFullAtBoot /
// store.cacheMirrorWriteFailed in src/context/store.tsx.
//
// The "Stories" header carries a live job-count chip (data-testid
    // "sidebar-job-count", text "<n>") showing how many background
// threads are currently in flight on the server — see inProgressCount below
// for how the server registry snapshot (store.activeJobs) combines with this
// session's local processing flags.
//
// Real-time SEARCH: below the header sits a text input (data-testid
// "sidebar-search") that filters the story tiles as the user types. Matching
// is case-insensitive substring against the tile's visible title text
// (entry.title — storyName or storyId prefix). The filter is CLIENT-ONLY and
// purely presentational: it never mutates `records`, so the lastActionedAt
// ordering, the selection, the records cache, and the auto-refresh merge are
// all untouched — clearing the query restores the exact list that was there
// before. Empty/whitespace query shows every story.
//
// VERSION SUFFIX: the "Stories" label carries the package version
// ("Stories v1.0.2") so the user can see which release they are running.
// The value comes from the compile-time __APP_VERSION__ constant injected by
// vite.config.ts `define` (reads package.json; declared ambient in
// src/vite-env.d.ts; mirrored in vitest.config.ts for tests). Same pattern
// as distribution/ScriptingSpaceFormatter's footer version.
//
// No manual refresh button — the sidebar auto-refreshes periodically by polling
// GET /v1/storyboard/generations to pick up stories created by other
// sessions/devices and the server's live background-job flags.
//
// Auto-refresh behavior:
//   - On mount, fetches the collection once (via the bootstrap feature) to
//     seed the store.
//   - A useEffect runs every REFRESH_INTERVAL_MS (30s) — or ACTIVE_REFRESH_INTERVAL_MS
//     (5s) while any story is processing — to re-fetch the collection and merge
//     new entries while preserving the current selection, any locally-cached
//     chapter data, and any cache-only stories that are missing from the server
//     response (they stay visible — deleting them purges the local cache without
//     a server call). See mergeServerStoryList.
//   - Errors surface as a non-blocking loadWarning (same as the bootstrap).
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
// BADGE REWORK (flat redesign): the tile status chips + the header job-count
// chip now use the modular <Badge> component — flat SQUARE chips (radiusSm)
// with a 2px status rail on the left edge replacing the old 999px pill
// (components/Badge.tsx). Neutral chips mark counts; accent chips mark
// activity (processing / job count) so the "active" family still reads
// brighter on the selected tile. The processing badge text is still the
//   literal ⏳ so the test that asserts `not.toContain('⏳')` after polling
//   completes keeps working (App.test.tsx:625).
//
// Moved from the old src/components/sections/SectionStoryTabs.tsx — this is a
// feature (owns the sort/filter/refresh business logic + store access).

import React from 'react';
// Material UI close glyph, icon button, button base + text field — the tile
// delete control, story tiles, and the real-time search field.
import CloseIcon from '@mui/icons-material/Close';
// Material UI save/disk glyph — the cached-locally indicator on a story tile
// (see the CACHED-LOCALLY ICON note in the file header).
import SaveAltIcon from '@mui/icons-material/SaveAlt';
// Material UI sync-disabled glyph — the "NOT saved locally" warning variant of
// the cached icon (rendered when the cache write failed; see NotSavedIcon
// below). (SaveOff does not exist in @mui/icons-material v9 — SyncDisabled is
// the equivalent "saving unavailable" glyph.)
import SyncDisabledIcon from '@mui/icons-material/SyncDisabled';
// Material UI cloud-off glyph — the "not cached at all" variant: the story's
// content has never been fetched into this browser, so it is viewable only
// while the server is reachable.
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import { TextField, IconButton, ButtonBase } from '@mui/material';
import { styled, theme } from '../styles';
import { useStoryStore } from '../context';
import { fetchStoryList } from '../api';
import { mergeServerStoryList } from '../context/store';
import { Badge } from '../components';

// How often to auto-refresh the story list from the server when the dashboard
// looks idle (30 seconds).
const REFRESH_INTERVAL_MS = 30_000;

// Cache-write-failure copy (data-testid "cache-warning" chip). Shown when
// store.cacheWriteFailed is set when one or more synchronous localStorage
// copies fail. IndexedDB persistence is asynchronous, so do not claim that all
// local persistence was lost.
const CACHE_WRITE_FAILED_MESSAGE =
    'Browser cache copy failed for some stories — durable local app storage may still be available';

// BOTH-TIERS-DEAD copy: the localStorage quick-cache failed AND the durable
// IndexedDB mirror sync failed (didLastMirrorWriteFail surfaced via
// store.cacheMirrorWriteFailed). On mobile the mirror is the survivor tier,
// so this state means NOTHING durable accepted the payload — private mode /
// storage-dead WebViews — and the hedged copy above would overpromise.
const CACHE_ALL_TIERS_FAILED_MESSAGE =
    'Stories cannot be saved on this device and will be lost when the page closes — browser storage and the durable local cache are both unavailable';

// BOOT-PROBE copy: BootstrapLayer's write-probe found localStorage unable to
// accept writes while records worth saving exist (store.storageUnavailableAtBoot
// — private/incognito mode or storage disabled). Takes precedence over the
// hedged copy because the probe names the CAUSE; the mirror may still hold a
// durable copy, but this session can never persist anything.
const STORAGE_UNAVAILABLE_MESSAGE =
    'Browser storage is unavailable — private/incognito mode or storage is disabled; stories will only last for this visit';

// QUOTA-FULL copy (store.storageFullAtBoot): the boot write-probe threw
// QuotaExceededError — storage is ENABLED but the origin's budget is
// exhausted (the reported mobile shape: ~5MB of old cached stories). The
// private/incognito copy above would misname the cause; the accurate story is
// that new writes cannot fit while the durable IndexedDB mirror (which never
// sheds and has orders-of-magnitude more quota) keeps every cached story
// available. Takes precedence over the hedged cacheWriteFailed copy for the
// same reason — the probe names the cause.
const STORAGE_FULL_MESSAGE =
    'Browser storage is full — new stories cannot be saved to the browser cache; cached stories are kept in the durable local app database and remain available';

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
// chip sits inline after the "Stories" text.
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

// Real-time search field below the "Stories" header. Filters the tile list
// as the user types (see the SEARCH note in the file header: the filter never
// mutates `records`). Built on the Material UI TextField with the flat field
// frame; two class hooks carry the pseudo-selector styling on the native
// input element (see src/styles/styled.tsx):
//   - "sg-input"  — flat focus treatment (accent border swap, no glow)
//   - "sg-search" — placeholder color (styles/global.ts)
const SearchField: React.FC<React.ComponentProps<typeof TextField>> = ({ sx, ...rest }) => (
    <TextField
        variant="outlined"
        fullWidth
        sx={{
            // Inset the field between the sidebar's edges.
            margin: '0 10px 8px',
            width: 'calc(100% - 20px)',
            display: 'block',
            // Zero MUI's multiline/outlined root padding — the input rule
            // below owns the inset (otherwise they stack: 16.5px + 6px).
            '& .MuiOutlinedInput-root': {
                padding: '0',
                backgroundColor: theme.surface1,
                color: theme.text,
                borderRadius: `${theme.radiusSm}px`,
                fontFamily: 'inherit',
                fontSize: theme.fontSize.sm
            },
            '& .MuiOutlinedInput-notchedOutline': {
                borderColor: theme.border
            },
            '& .MuiInputBase-input': {
                padding: '6px 10px',
                lineHeight: 1.5
            },
            ...sx
        }}
        {...rest}
    />
);

// Message shown when the search query matches nothing (distinct from the
// "No stories yet" empty state, which only renders when records are empty).
const SearchEmptyMessage = styled('div', {
    padding: '14px 14px',
    color: theme.textFaint,
    fontSize: theme.fontSize.sm,
    fontStyle: 'italic',
    lineHeight: 1.5
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
// Built on the Material UI ButtonBase (the MUI primitive for custom toggles)
// with the flat card frame in sx. The element stays a <button> (with
// data-testid/aria-pressed) — that is part of the public test contract
// (App.test.tsx finds tabs via getByRole('button')). Only the presentation is
// tiled. NOTE: the sx base colors deliberately MATCH the .sg-story-* class
// rules (global.ts) — the hooks carry the hover/pulse/rail treatments at
// higher specificity, and matching base values make the cascade deterministic
// regardless of Emotion insertion order.
const TileButton: React.FC<React.ComponentProps<typeof ButtonBase>> = ({ sx, ...rest }) => (
    <ButtonBase
        type="button"
        disableRipple
        {...rest}
        sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            gap: '7px',
            width: '100%',
            textAlign: 'left',
            cursor: 'pointer',
            lineHeight: 1.35,
            boxSizing: 'border-box',
            transition: `background-color ${theme.transition}, border-color ${theme.transition}, color ${theme.transition}`,
            ...sx
        }}
    />
);

// Unselected tile frame — surface2 card + hairline border.
const StoryItem: React.FC<React.ComponentProps<typeof ButtonBase>> = ({ sx, ...rest }) => (
    <TileButton
        {...rest}
        sx={{
            // Deep right padding keeps the title/badges from sliding under the
            // "x" delete control overlaid in the tile's top-right corner.
            padding: '11px 30px 11px 12px',
            border: `1px solid ${theme.border}`,
            borderRadius: `${theme.radiusLg}px`,
            backgroundColor: theme.surface2,
            color: theme.text,
            fontSize: theme.fontSize.md,
            fontWeight: 500,
            ...sx
        }}
    />
);

// Selected variant — modern "active card" treatment. Instead of the old solid
// accent FILL, the selected tile is an accent-tinted translucent surface with
// a crisp accent border plus a brighter accent rail applied via the
// `sg-story-selected` class hook (global.ts ::before). Flat: no gradient, no
// glow, no shadow — the card reads as the current pick purely through tint +
// border + rail.
const StoryItemSelected: React.FC<React.ComponentProps<typeof ButtonBase>> = ({ sx, ...rest }) => (
    <TileButton
        {...rest}
        sx={{
            // Deep right padding so title/badges never slide under the
            // overlaid "x" delete control; slightly deeper left padding leaves
            // room for the accent rail drawn inside the left border by
            // .sg-story-selected::before.
            padding: '11px 30px 11px 16px',
            border: `1px solid ${theme.accent}`,
            borderRadius: `${theme.radiusLg}px`,
            // The .sg-story-selected class sets the same surface/border/color;
            // both agree (see the TileButton cascade note).
            backgroundColor: theme.accentSoft,
            borderColor: theme.accent,
            color: theme.highlight,
            position: 'relative',
            overflow: 'hidden',
            fontSize: theme.fontSize.md,
            fontWeight: 600,
            ...sx
        }}
    />
);

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
// story without triggering its selection. Built on the Material UI IconButton
// (22×22 square, muted by default), reusing the `sg-danger` class hook
// (global.ts, specificity above the sx base) for destructive hover + disabled
// dimming.
const StoryDeleteButton: React.FC<React.ComponentProps<typeof IconButton>> = ({ sx, ...rest }) => (
    <IconButton
        disableRipple
        {...rest}
        sx={{
            position: 'absolute',
            top: '9px',
            right: '9px',
            width: 22,
            height: 22,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            borderRadius: `${theme.radiusSm}px`,
            backgroundColor: 'transparent',
            color: theme.textMuted,
            fontSize: '14px',
            lineHeight: 1,
            transition: `background-color ${theme.transition}, color ${theme.transition}, opacity ${theme.transition}`,
            ...sx
        }}
    />
);

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

// Cached-locally icon — small disk glyph rendered at the START of the tile's
// meta row (the second row, before the chapter-count badge) when the story's
// content is cached in this browser (entry.data non-null — hydrated from
// localStorage or fetched this session; see the CACHED-LOCALLY ICON note in
// the file header). Sized to the badge line box (fontSize.sm, ~11px). Purely
// informational: rendered inside the tile's select button (like the badges),
// no click behavior.
const CachedIcon = styled('span', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    color: theme.textMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 1
});

// NOT-SAVED variant of the cached icon — same meta-row slot, warning tint +
// glyph. Rendered instead of the disk when the story HAS cached content but
// its latest localStorage quick-cache write failed. The IndexedDB mirror may
// still hold the full durable copy.
const NotSavedIcon = styled('span', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    color: theme.warning,
    fontSize: theme.fontSize.sm,
    lineHeight: 1
});

// Cached-locally state resolution — THREE states per tile:
//   'saved'        — entry.data is non-null: the story's content (chapters)
//                    is stored in this browser (hydrated from the cache or
//                    fetched this session; the records-persist effect keeps
//                    it durable). Disk icon.
//   'not-cached'   — entry.data is null (freshly synced remote entry, never
//                    fetched): NOTHING of its chapters is stored locally, so
//                    offline it would show as metadata-only. Cloud-off icon.
//   'write-failed' — the story has cached content BUT its localStorage copy
//                    failed. IndexedDB may still hold the durable mirror.
const resolveCacheState = (entry: { data: unknown }, cacheWriteFailed: boolean): 'saved' | 'not-cached' | 'write-failed' => {
    if (entry.data !== null && entry.data !== undefined) {
        return cacheWriteFailed ? 'write-failed' : 'saved';
    }
    return 'not-cached';
};

// Tier-aware cache-warning copy resolution (the cache-health chip):
//   1. BOTH tiers dead (localStorage save failed AND the durable mirror sync
//      failed) → the strongest condition: nothing durable accepted the
//      payload, so stories will be lost when the page closes. The hedged
//      copy would overpromise in private mode / storage-dead WebViews.
//   2. Boot-probe storage failure (storageUnavailableAtBoot, records worth
//      saving exist) → name the private/incognito / storage-disabled cause.
//   3. Boot-probe QUOTA failure (storageFullAtBoot) → the origin's budget is
//      exhausted; name "storage is full" and that the durable mirror keeps
//      cached stories available (the private-mode copy would misname it).
//   4. localStorage save failed but the mirror may have landed → the hedged
//      copy (previous fix semantics, unchanged).
//   5. Otherwise the informational cacheWarning (boot recovery/upgrade copy).
const resolveCacheWarningMessage = (store: {
    cacheWriteFailed?: boolean;
    cacheMirrorWriteFailed?: boolean;
    storageUnavailableAtBoot?: boolean;
    storageFullAtBoot?: boolean;
    cacheWarning?: string;
}): string => {
    if (store.cacheWriteFailed && store.cacheMirrorWriteFailed) return CACHE_ALL_TIERS_FAILED_MESSAGE;
    if (store.storageUnavailableAtBoot) return STORAGE_UNAVAILABLE_MESSAGE;
    if (store.storageFullAtBoot) return STORAGE_FULL_MESSAGE;
    if (store.cacheWriteFailed) return CACHE_WRITE_FAILED_MESSAGE;
    return store.cacheWarning ?? '';
};

// Empty-state message when no stories exist.
const EmptyMessage = styled('div', {
    padding: '20px 14px',
    color: theme.textFaint,
    fontSize: theme.fontSize.md,
    fontStyle: 'italic',
    lineHeight: 1.5
});

// Version suffix inside the "Stories" header — dimmed + lighter weight so it
// reads as metadata next to the label, not as part of the section title.
// data-testid "sidebar-version" is the test contract (App.test.tsx asserts
// the exact "v<version>" text against the __APP_VERSION__ compile constant).
const VersionSuffix = styled('span', {
    marginLeft: 6,
    fontSize: theme.fontSize.xs,
    fontWeight: 500,
    color: theme.textFaint,
    letterSpacing: 0.4,
    whiteSpace: 'nowrap' as const
});

// Load-warning chip — shown if the bootstrap or auto-refresh failed (and by
// the cache-health chip below, same component). Flat warning-tinted surface.
//
// WRAPS instead of truncating: this chip carries the long diagnostic copies
// (long raw fetch errors, the tier-aware cache-health lines) and the
// old `white-space: nowrap; text-overflow: ellipsis` treatment clipped them
// to roughly "⚠ Failed to fetch — the storyboard API at http://…" on a
// narrow phone — the exact shape of the mobile report, where the ACTIONABLE
// part of the message (the cause the warning names) was the part cut
// off. The chip now wraps (with break-word so long URLs in the copy can
// never push the layout wide) and shows the full text on every width.
// Unrelated one-line surfaces (e.g. StoryTitle's title truncation) are
// untouched — only the warning/error chip variant wraps.
const LoadWarning = styled('div', {
    fontSize: theme.fontSize.sm,
    color: theme.warning,
    background: theme.warningSoft,
    border: `1px solid ${theme.warningBorder}`,
    padding: '6px 10px',
    margin: '10px 10px 0',
    borderRadius: theme.radiusSm,
    whiteSpace: 'normal' as const,
    wordBreak: 'break-word' as const,
    lineHeight: 1.5
});

export const StorySidebar: React.FC = React.memo(() => {
    const { store, setStore, deleteStory } = useStoryStore();
    const { records, selected } = store;

    // Single in-flight delete guard, mirroring the chat-assistant sidebar:
    // while any delete request is outstanding, every tile's "x" is disabled so
    // a second delete cannot race the active identified DELETE request.
    const [deleting, setDeleting] = React.useState(false);

    // Real-time search query. Local component state ONLY — the filter is
    // applied to the rendered list below and never written to the store, so
    // the records cache, the lastActionedAt ordering, and the selection all
    // survive a search/clear cycle untouched.
    const [search, setSearch] = React.useState('');

    // Lowercased trimmed query for matching; empty string matches everything,
    // which is how a cleared input restores the full list.
    const searchQuery = search.trim().toLowerCase();

    // The visible tile list: lastActionedAt-ordered (same comparator as
    // before the search feature), then filtered by the query against the
    // tile's visible title text. Case-insensitive substring match — the
    // cheapest useful semantics for a title list (prefix/word-boundary
    // matching would hide "Space Opera" from an "opera" search's siblings
    // like "Operatic Mutation" for no benefit). Computed on every render;
    // records arrays here are small (tens of entries), so no memoization is
    // needed.
    const visibleRecords = [...records]
        .sort((a, b) => (b.lastActionedAt || b.createdDate).localeCompare(a.lastActionedAt || a.createdDate))
        .filter((entry) => {
            // Empty query (or whitespace-only input) shows everything.
            if (!searchQuery) return true;
            // Match against the title the tile RENDERS (StoryTitle text).
            // entry.title falls back to storyName or the storyId prefix by
            // construction (mergeServerStoryList / the input feature), so it
            // is always a non-empty string.
            return entry.title.toLowerCase().includes(searchQuery);
        });

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
            {/* Header label + package version + live background-thread count.
                The version suffix ("Stories v1.0.2") comes from the compile-time
                __APP_VERSION__ constant (vite.config.ts define reads
                package.json). The job-count chip renders only while
                inProgressCount > 0 — an idle server shows the bare label.
                data-testid="sidebar-job-count" is the test contract; textContent
                is exactly "<n>" (the spinner ring contributes no text).
                FLAT REWORK: modular accent-rail Badge instead of the pill. */}
            <SectionLabel>
                Stories
                <VersionSuffix data-testid="sidebar-version">v{__APP_VERSION__}</VersionSuffix>
                {inProgressCount > 0 && (
                    <span data-testid="sidebar-job-count">
                        <Badge
                            variant="accent"
                            title={`${inProgressCount} background job${inProgressCount === 1 ? '' : 's'} in progress`}
                            style={{ marginLeft: 8 }}
                        >
                            <span className="sg-spinner" aria-hidden="true" />
                            {inProgressCount}
                        </Badge>
                    </span>
                )}
            </SectionLabel>
            {/* Real-time search — filters the tiles below as the user types.
                Controlled field: value mirrors the local `search` state and
                onChange lowercases nothing (matching is case-insensitive at
                compare time via searchQuery). type="search" gives the native
                clear affordance in some browsers; aria-label keeps it usable
                for screen readers since the field carries no visible label.
                data-testid lands on the NATIVE input via slotProps.htmlInput
                (the tests read/change it directly). */}
            <SearchField
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search stories…"
                aria-label="Search stories by title"
                slotProps={{ htmlInput: { 'data-testid': 'sidebar-search', className: 'sg-input sg-search' } }}
            />
            {records.length === 0 && (
                <EmptyMessage data-testid="sidebar-empty">
                    No stories yet. Create one below.
                </EmptyMessage>
            )}
            {/* No matches for the CURRENT query — distinct from the empty
                sidebar state above (records exist but the filter hides them
                all). data-testid is the test contract for the filtered-list
                assertions. */}
            {records.length > 0 && searchQuery && visibleRecords.length === 0 && (
                <SearchEmptyMessage data-testid="sidebar-search-empty">
                    No stories match “{search.trim()}”.
                </SearchEmptyMessage>
            )}
            {/* Sort so the LAST ACTIONED story is on top. The sort key is the
                user-action timestamp (entry.lastActionedAt, bumped ONLY by
                explicit user actions via touchStory) falling back to
                createdDate for stories never actioned in this browser
                (legacy cache entries, freshly synced server stories). Within
                each group ISO 8601 strings sort correctly as strings in
                descending order. Background work (generation writes, poll
                refreshes, list syncs) never changes the key — only the user
                does. The SEARCH filter is applied AFTER the sort so the
                visible subset keeps the exact same lastActionedAt ordering
                the unfiltered list has (filter → re-sort would be equivalent
                here, but sort-then-filter keeps this a pure presentation
                concern: nothing about `records` is touched). */}
            {visibleRecords.map((entry) => {
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
                // Cached-locally state — THREE states (see resolveCacheState
                // above the component): 'saved' (disk icon), 'not-cached'
                // (cloud-off icon), 'write-failed' (warning save-off icon).
                const cacheState = resolveCacheState(
                    entry,
                    store.cacheWriteFailedStoryIds?.includes(entry.storyId) === true
                );
                // Mirror-tier outcome for the write-failed title: when the
                // durable IndexedDB sync ALSO failed, the hedged "may still be
                // available" copy overpromises — this story has NO durable
                // copy anywhere and dies with the page.
                const mirrorWriteFailed = store.cacheMirrorWriteFailed === true;

                // Cached-state icon per tile — the three-state resolution
                // above drives WHICH glyph renders in the title row (testid
                // stays "story-cached-<storyId>" in every state so tests and
                // users find the indicator at the same place):
                //   saved        → disk glyph, "Cached locally"
                //   not-cached   → cloud-off glyph, "Not saved locally — open
                //                  once while connected to cache it"
                //   write-failed → warning save-off glyph scoped to THIS
                //                  story's browser quick-cache copy, hedged
                //                  on the mirror tier unless it also failed
                const cachedIndicator =
                    cacheState === 'saved' ? (
                        <CachedIcon
                            data-testid={`story-cached-${entry.storyId}`}
                            title="Cached locally"
                            aria-label="Cached locally"
                        >
                            <SaveAltIcon style={{ fontSize: 13, display: 'block' }} />
                        </CachedIcon>
                    ) : cacheState === 'write-failed' ? (
                        <NotSavedIcon
                            data-testid={`story-cached-${entry.storyId}`}
                            title={
                                mirrorWriteFailed
                                    ? 'Browser cache copy write failed for this story (no durable local storage is available — it will be lost when the page closes)'
                                    : 'Browser cache copy write failed for this story (durable local app storage may still be available)'
                            }
                            aria-label="Browser cache copy write failed for this story"
                        >
                            <SyncDisabledIcon style={{ fontSize: 13, display: 'block' }} />
                        </NotSavedIcon>
                    ) : (
                        <NotSavedIcon
                            data-testid={`story-cached-${entry.storyId}`}
                            title="Not saved locally — open this story once while the server is reachable to cache it"
                            aria-label="Not saved locally"
                        >
                            <CloudOffOutlinedIcon style={{ fontSize: 13, display: 'block' }} />
                        </NotSavedIcon>
                    );

                const itemProps = {
                    // Click = selection + a click-time server re-check. Two
                    // things happen, in ONE setStore (batched → single
                    // re-render):
                    //   1. `selected` = entry — the content area displays this
                    //      story.
                    //   2. `selectionNonce` increments — the click signal the
                    //      StoryContent catch-up effect watches to force a
                    //      one-shot GET of this story's data, so a finished,
                    //      previously cached story is re-validated (and
                    //      recached) against the server on EVERY click, even
                    //      when it is not generating and its cached payload
                    //      is not flagged dataStale. Re-clicking the
                    //      already-selected story also bumps the nonce, so
                    //      every click re-checks.
                    // Viewing is still read-only in the ORDERING sense: it
                    // must NOT bump lastActionedAt, which tracks
                    // data-mutating user actions (POST/PATCH: generate, fork,
                    // expand, rewrite, append, resume, terminate, deletes,
                    // rename). Bumping on view would reorder the list under
                    // the user's cursor without any data actually changing.
                    onClick: () =>
                        setStore((prev) => ({
                            ...prev,
                            selected: entry,
                            selectionNonce: prev.selectionNonce + 1
                        })),
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
                //
                // FLAT REWORK: the modular <Badge> chips — square corners +
                // 2px status rail (components/Badge.tsx) — replace the old
                // Badge/BadgeActive pills. Neutral rail for counts; accent
                // rail for activity so the selected tile's chips still read
                // brighter against its accent surface.
                return (
                    <StoryEntry key={entry.id}>
                        {isSelected ? (
                            <StoryItemSelected {...itemProps} className={`sg-story-selected${processingClass}`}>
                                {/* Row 1: the title alone (the "x" delete control
                                    is absolutely pinned to the tile's top-right
                                    corner, unchanged). */}
                                <StoryTitle>{entry.title}</StoryTitle>
                                {/* Row 2: cached-state indicator FIRST, then the
                                    status badges — "[Icon] [Chapters]" (the
                                    three-state glyph: saved / not-cached /
                                    write-failed; see cachedIndicator above).
                                    testid stays "story-cached-<storyId>". */}
                                <StoryTileMeta>
                                    {cachedIndicator}
                                    {chapterBadge && (
                                        <Badge variant="accent" elevated>
                                            {chapterBadge}
                                        </Badge>
                                    )}
                                    {processingBadge && (
                                        <Badge variant="accent" elevated>
                                            {isProcessing && <span className="sg-spinner" aria-hidden="true" />}
                                            {processingBadge}
                                        </Badge>
                                    )}
                                </StoryTileMeta>
                            </StoryItemSelected>
                        ) : (
                            <StoryItem {...itemProps} className={`sg-story-item${processingClass}`}>
                                {/* Same two-row layout on the unselected
                                    variant: title row, then icon + badges. */}
                                <StoryTitle>{entry.title}</StoryTitle>
                                <StoryTileMeta>
                                    {cachedIndicator}
                                    {chapterBadge && <Badge variant="neutral">{chapterBadge}</Badge>}
                                    {processingBadge && (
                                        <Badge variant="neutral">
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
                        <CloseIcon style={{ fontSize: 14, display: 'block' }} />
                    </StoryDeleteButton>
                    </StoryEntry>
                );
            })}
            {/* Load warning — shown if the bootstrap or auto-refresh failed. */}
            {store.loadWarning && (
                <LoadWarning
                    data-testid="load-warning"
                    title={store.loadWarning}
                >
                    ⚠ {store.loadWarning}
                </LoadWarning>
            )}
            {/* Cache-health chip — shown when the LOCAL cache is degraded:
                one or more localStorage quick-cache copies failed, the boot
                write-probe found storage unavailable (private/incognito) or
                FULL (quota exhausted) with records worth saving, or a boot
                recovery/upgrade pass restored records from the IndexedDB
                mirror (informational). TIER-AWARE COPY: when the localStorage
                tier failed AND the durable mirror sync also failed
                (store.cacheMirrorWriteFailed — private mode / storage-dead
                WebViews), the chip presents the stronger "cannot be saved on
                this device" condition instead of the hedged copy; a boot-probe
                storage failure names the private/incognito cause, and a
                boot-probe QUOTA failure names the "storage is full" cause.
                Independent of loadWarning (server reachability). */}
            {(store.cacheWriteFailed || store.cacheWarning || store.storageUnavailableAtBoot || store.storageFullAtBoot) && (
                <LoadWarning
                    data-testid="cache-warning"
                    title={resolveCacheWarningMessage(store)}
                >
                    {store.cacheWriteFailed || store.storageUnavailableAtBoot || store.storageFullAtBoot
                        ? `⚠ ${resolveCacheWarningMessage(store)}`
                        : `ⓘ ${resolveCacheWarningMessage(store)}`}
                </LoadWarning>
            )}
        </SidebarContainer>
    );
});
