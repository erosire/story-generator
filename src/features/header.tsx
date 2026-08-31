// Header FEATURE: the dashboard's top bar — sidebar toggle, clickable story
// title (opens the rename dialog), and the LLM client dropdown.
//
// Owns the header's business logic: client-options fetch-with-retry, clientId
// persistence, and the rename PATCH flow. Moved from the old
// src/components/StoryGeneratorApp HeaderControls.
//
// RENAME DIALOG REWORK: the rename flow now uses the modular standard-pattern
// <Dialog> (components/Dialog.tsx) — header/body/footer bands instead of the
// old ad hoc overlay/box/label composition. Test contract preserved by
// construction:
//   - frame: data-testid="rename-dialog", role="dialog", aria-modal,
//     aria-labelledby="rename-dialog-title" (App.test.tsx:395-397)
//   - input: data-testid="rename-input", className EXACTLY 'sg-dialog-input'
//     (:399 asserts toBe) — the stronger focus ring class hook
//   - confirm: data-testid="rename-confirm", className EXACTLY
//     'sg-dialog-confirm' (:400 asserts toBe)
//   - cancel: data-testid="rename-cancel" — closes without renaming
//
// LLM client dropdown (top-right): chooses which LLM client the server uses
// for generation. Stored in config.clientId (persisted to localStorage) and
// sent as `clientId` with every payload — never stored by the server with the
// story. Native <select> whose control + popup are dark-themed via
// colorScheme (inline) — the sg-select/sg-input class hooks add the flat
// hover/focus treatments. ALL colors for the dropdown live in the
// `.sg-select` class rules in styles/global.ts, NOT inline: the vendored
// styled() applies a static inline `style` attribute, and inline styles
// outrank every class rule (including :hover/:focus), which would leave the
// sg-select hooks dead and composite a translucent background over the
// browser's light UA control base (white-control bug). App.test.tsx:103-105
// asserts the class hooks + inline colorScheme.

import React from 'react';
import { styled, theme } from '../styles';
import { StoryStoreProvider, useStoryStore, setClientId, type StoryStore } from '../context';
import { updateStoryMeta, fetchClientOptions } from '../api';
import { Dialog, Input } from '../components';

// Toggle button — hamburger icon that opens/closes the sidebar.
// Flat Design: outlined square with solid surface + crisp hairline border.
// Hover swaps to surface2 + stronger border (sg-hover class). No shadow.
const ToggleButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flex: '0 0 auto',
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface1,
    color: theme.text,
    cursor: 'pointer',
    fontSize: theme.fontSize.xl,
    lineHeight: 1,
    padding: 0,
    transition: `background-color ${theme.transition}, border-color ${theme.transition}`
});

// App title text in the header. Slightly larger, brighter, and tracked out
// for a modern dashboard wordmark look.
const HeaderTitle = styled('span', {
    fontSize: theme.fontSize.lg,
    fontWeight: 600,
    color: theme.text,
    letterSpacing: 0.2,
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const
});

// Top-right LLM client dropdown. `marginLeft: 'auto'` pushes it to the right
// edge of the flex header row (toggle + title sit on the left).
// See the file header for why the colors live in .sg-select (global.ts) and
// why colorScheme:'dark' stays inline (App.test.tsx:94/105 asserts it).
const ClientSelect = styled('select', {
    marginLeft: 'auto',
    height: 34,
    padding: '0 10px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.md,
    fontWeight: 500,
    borderRadius: theme.radiusMd,
    cursor: 'pointer',
    outline: 'none',
    // Dark color scheme for the native select control + its options popup
    // (see the file header). 'dark' is a valid React.CSSProperties value.
    colorScheme: 'dark',
    transition: `background-color ${theme.transition}, border-color ${theme.transition}, box-shadow ${theme.transition}`
});

// Inner header controls that access the store (must be inside the provider).
export const HeaderControls: React.FC<{
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
}> = React.memo(({ sidebarOpen, onToggleSidebar }) => {
    const { store, setStore, touchStory } = useStoryStore();
    const { selected } = store;
    const [renaming, setRenaming] = React.useState(false);
    const [renameValue, setRenameValue] = React.useState('');

    // ── LLM client options ────────────────────────────────────────────────
    // Fetch the selectable client ids from GET /v1/storyboard/clients on
    // mount so the dropdown mirrors the deployment's CLIENTS map (see
    // generation-config.ts / generation-list-clients.ts).
    //
    // RETRIES on failure (every CLIENTS_FETCH_RETRY_MS, up to
    // CLIENTS_FETCH_MAX_ATTEMPTS): the most common failure is a STALE server
    // deployment that predates the /v1/storyboard/clients route (answers 404)
    // — without retries the dropdown would be stuck on the persisted/default
    // clientId forever (only DEFAULT_CLIENT_ID visible) even after the deployment is
    // updated, forcing a full page reload. Retry stops after the first success;
    // on every failure the option list is left as-is so the dropdown always
    // stays usable (the current clientId is always offered as an option).
    const CLIENTS_FETCH_RETRY_MS = 10000;
    const CLIENTS_FETCH_MAX_ATTEMPTS = 30; // ~5 minutes of retry budget
    React.useEffect(() => {
        const baseUrl = store.config.baseUrl;
        // Per-invocation disposal flag. CRITICAL: do NOT guard this effect
        // with a shared "did fetch" ref. React 18 StrictMode (main.tsx) runs
        // mount effect → cleanup → re-mount effect in dev; a ref guard makes
        // the re-run return early, orphaning the FIRST invocation's in-flight
        // fetch (already disposed by its cleanup). That fetch resolves fine in
        // the browser (307 → 200 visible in DevTools) but its `.then` sees
        // disposed===true and silently drops the response — the dropdown is
        // stuck on the default clientId with no further retry to recover.
        // Each effect run below owns its own flag + timer, so the StrictMode
        // remount starts a fresh fetch that is allowed to update the store.
        let disposed = false; // unmount guard — stop retrying and setState work
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const fetchClients = (attempt: number) => {
            fetchClientOptions(baseUrl)
                .then((clients) => {
                    if (disposed) return;
                    setStore((prev) => {
                        // Dedupe while keeping the server's order first; the
                        // currently-selected id is always included so a value
                        // persisted from localStorage (or a client that vanished
                        // server-side) still renders as the selected option.
                        const options = Array.from(new Set([...clients, prev.config.clientId]));
                        return { ...prev, clientOptions: options };
                    });
                })
                .catch((err) => {
                    if (disposed) return;
                    // Non-fatal while retries remain: dropdown falls back to the
                    // persisted/default id until the server serves the list.
                    console.warn(`[HeaderControls] Failed to fetch client options (attempt ${attempt}).`, err);
                    if (attempt < CLIENTS_FETCH_MAX_ATTEMPTS) {
                        // Cleanup (unmount / StrictMode re-mount) clears this
                        // timer so no orphaned retry outlives the effect run.
                        retryTimer = setTimeout(() => fetchClients(attempt + 1), CLIENTS_FETCH_RETRY_MS);
                    }
                });
        };
        fetchClients(1);

        return () => {
            disposed = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
        // Intentionally run once on mount (baseUrl is fixed per deployment).
        // No ref-based once-guard — see the disposed-flag comment above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The dropdown's option list always contains the current clientId, even
    // before the options fetch resolves (clientOptions starts as []) — the
    // select must never render with a value absent from its options.
    const clientOptions = store.clientOptions.includes(store.config.clientId)
        ? store.clientOptions
        : [...store.clientOptions, store.config.clientId];

    const handleClientChange = React.useCallback(
        (clientId: string) => {
            // Persist SYNCHRONOUSLY inside the event handler — do not rely on
            // the provider's passive useEffect backstop alone. React defers
            // passive effects until after paint and never guarantees they flush
            // before a page reload/navigation; a user who changed the dropdown
            // and reloaded immediately lost the write (reported: "model
            // selection does not remember on next page reload"). Event handlers
            // always run to completion, so the localStorage write here is
            // durable even if the page unloads before the next effect flush.
            setClientId(clientId);
            setStore((prev) => ({
                ...prev,
                config: { ...prev.config, clientId }
            }));
        },
        [setStore]
    );

    const openRename = React.useCallback(() => {
        if (!selected) return;
        setRenameValue(selected.storyName || selected.title || '');
        setRenaming(true);
    }, [selected]);

    const closeRename = React.useCallback(() => {
        setRenaming(false);
        setRenameValue('');
    }, []);

    const handleRename = React.useCallback(async () => {
        if (!selected || !renameValue.trim()) return;
        try {
            // Every payload carries the currently selected clientId so the
            // server's per-request client selection stays uniform across
            // operations (metadata-only PATCHes don't invoke the LLM, but the
            // payload shape stays consistent for the UI contract).
            await updateStoryMeta(store.config.baseUrl, selected.storyId, {
                storyName: renameValue.trim(),
                clientId: store.config.clientId
            });
            // Rename is a user action — bump the ordering timestamp so the
            // renamed story moves to the top of the sidebar.
            touchStory(selected.storyId);
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.storyId === selected.storyId
                        ? {
                              ...e,
                              storyName: renameValue.trim(),
                              title: renameValue.trim(),
                              // The PATCH rewrites plotpoint.json server-side, so
                              // our cached `data` (which still carries the OLD
                              // storyName in its meta) is now behind the server.
                              // Flag dataStale: the next view triggers a one-shot
                              // refresh that pulls the new name into meta and
                              // re-syncs lastUpdatedAt (mergeServerStoryList
                              // would otherwise flag it on the next list sync
                              // anyway — this avoids the 30s window).
                              dataStale: true
                          }
                        : e
                );
                const selectedEntry = records.find((e) => e.storyId === selected.storyId) ?? prev.selected;
                return { ...prev, records, selected: selectedEntry };
            });
            setRenaming(false);
        } catch (err) {
            console.error('Failed to rename story:', err);
        }
    }, [selected, renameValue, store.config.baseUrl, store.config.clientId, setStore, touchStory]);

    const handleRenameKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
                handleRename();
            } else if (e.key === 'Escape') {
                closeRename();
            }
        },
        [handleRename, closeRename]
    );

    return (
        <>
            <ToggleButton
                onClick={onToggleSidebar}
                aria-label="Toggle story sidebar"
                data-testid="sidebar-toggle"
                className="sg-hover"
            >
                ☰
            </ToggleButton>
            <HeaderTitle
                onClick={openRename}
                data-testid="story-title"
                className={selected ? 'sg-title-action' : undefined}
                title={selected ? 'Click to rename' : undefined}
            >
                {selected?.storyName || selected?.title || 'Story Generator'}
            </HeaderTitle>

            {/* Top-right client dropdown — see the file header comment. */}
            <ClientSelect
                value={store.config.clientId}
                onChange={(e) => handleClientChange(e.target.value)}
                data-testid="client-select"
                aria-label="LLM client"
                title="LLM client used for generation"
                className="sg-input sg-select"
            >
                {clientOptions.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </ClientSelect>

            {/* Rename dialog — the STANDARD PATTERN rework: Dialog.Header
                carries the title ("Rename story" → the aria-labelledby id
                "rename-dialog-title" is derived by <Dialog>), Dialog.Body the
                input, Dialog.Footer the cancel/confirm pair. Escape +
                overlay click close (Dialog handles both). */}
            <Dialog open={renaming} title="Rename story" onClose={closeRename} testId="rename-dialog">
                <Dialog.Body>
                    <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        placeholder="Enter story name"
                        data-testid="rename-input"
                        id="rename-input"
                        // EXACT class contract (App.test.tsx:399 asserts
                        // toBe 'sg-dialog-input') — the stronger focus ring.
                        className="sg-dialog-input"
                    />
                </Dialog.Body>
                <Dialog.Footer>
                    <Dialog.CancelButton onClick={closeRename} data-testid="rename-cancel">
                        Cancel
                    </Dialog.CancelButton>
                    <Dialog.ConfirmButton onClick={handleRename} disabled={!renameValue.trim()} data-testid="rename-confirm">
                        Rename
                    </Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>
        </>
    );
});
