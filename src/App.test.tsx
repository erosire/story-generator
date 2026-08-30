// Tests for the Story Generator dashboard.
//
// Covers the integrated UI behaviour:
//   - initial empty state ("Select one") with input area visible
//   - sidebar lists stories and can be toggled
//   - Generate creates a new story and POSTs to the server
//   - a 404 right after POST keeps polling until the first 200 with chapters
//   - auto-refresh picks up new stories from the server
//   - the [->] action opens the in-place append-chapters dialog (notes +
//     chapter count + Append) and POSTs the append envelope to the same
//     storyId; server 400s keep the dialog open with the error inline
//   - the ▶ resume action appears when a story's plotline sits below its
//     target (interrupted generation) and POSTs the resume envelope; server
//     400s surface inline via the content-error banner
//   - the per-chapter delete (trash) button opens a confirmation dialog; only
//     the confirm PATCHes { deleteChapterIndex, deleteChapterRevisionIndex }
//     for the dropdown-selected revision — deleting the last revision returns
//     the chapter to plotlines-only (expandable again); cancel sends nothing
//   - the "Delete Chapter" pill is revealed by SHOWING a chapter's plotpoints
//     (hidden while collapsed); confirming PATCHes { removeChapterIndex } and
//     the story shrinks to the renumbered chapter list; cancel sends nothing
//   - the story stats bar (total chapters / total words / estimated tokens)
//     renders before the chapter listing
//   - the Terminate control inside the processing banner PATCHes
//     { abortJob: true } to the story URL and retires the banner on success
//   - the sidebar sorts by the USER-ACTION timestamp (lastActionedAt): triggering
//     a data-mutating action (re-expand PATCH) moves that story to the top, while
//     read-only viewing (selection) NEVER reorders the list
//
// fetch is mocked globally. Poll interval is overridden via configOverrides to a
// tiny value so the loop advances quickly under real timers.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryGeneratorApp } from './components';
import { cancelPendingStorageWrites } from './context/store';
import { injectGlobalStyles } from './styles/global';

const BASE_URL = 'http://test.local/v1/storyboard/generations';
const POLL_INTERVAL_MS = 10;

const mockResponse = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as any;

describe('StoryGeneratorApp', () => {
    // Default fetch mock: GET / returns an empty story list. Individual
    // tests override specific calls as needed. Setting a sane default avoids
    // BootstrapLayer catch-paths and the act() warnings that come from
    // an unresolved promise firing setState after the test completes.
    beforeEach(() => {
        // Clear localStorage to prevent cross-test contamination from the
        // auto-persist useEffect (scheduleSaveRecordsToStorage) in the store.
        localStorage.clear();
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: any) => {
                if (!init || init.method === 'GET') {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(200, {}));
            })
        );
    });
    afterEach(() => {
        // Restore real timers defensively: the fake-timer tests
        // (auto-refresh, background-job animation) call vi.useRealTimers()
        // at the END of their body — a mid-body assertion failure would
        // otherwise leak fake timers into every subsequent test in this
        // file (timers control the sidebar refresh + poll loops).
        vi.useRealTimers();
        cancelPendingStorageWrites();
        localStorage.clear();
        vi.unstubAllGlobals();
    });

    it('renders the empty state and input area before any story is created', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Empty state — matches the hardcoded "Select one" in SectionStoryContent.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
        // Input area is always visible — user can type a storyline and click Generate.
        expect(screen.getByTestId('storyline-input')).toBeDefined();
        // Sidebar is present with the "Stories" label.
        expect(screen.getByTestId('sidebar')).toBeDefined();
        // The top-right LLM client dropdown is always rendered. Before the
        // server's client list arrives it offers only the default client id
        // (localStorage cleared in beforeEach → DEFAULT_CLIENT_ID 'Qwen27B').
        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        expect(clientSelect).toBeDefined();
        expect(clientSelect.value).toBe('Qwen27B');
        // Theming contract: the native select opts into the dark color scheme
        // (inline, so the UA paints the control + popup dark instead of the
        // default grey-on-white) and carries the sg-select/sg-input class
        // hooks. All COLORS for the dropdown (opaque dark surface + light
        // text + hover/focus states + the <option> popup entries) live in the
        // `.sg-select` class rules injected by styles/global.ts — inline style
        // would outrank every class rule and kill the hover/focus states.
        expect(clientSelect.className).toContain('sg-select');
        expect(clientSelect.className).toContain('sg-input');
        expect(clientSelect.style.colorScheme).toBe('dark');
        // The dropdown styling rules must be present in the injected global
        // stylesheet, with an OPAQUE dark surface (never translucent — a
        // translucent background composites over the browser's light UA
        // control base when color-scheme is ignored → white-on-grey bug).
        injectGlobalStyles();
        const sheet = document.querySelector('style[data-sg-styles]')?.textContent ?? '';
        // Base rule: opaque dialog surface + light text.
        expect(sheet).toContain('.sg-select {');
        expect(sheet).toMatch(/\.sg-select\s*{[^}]*background-color:\s*#151b29/);
        expect(sheet).toMatch(/\.sg-select\s*{[^}]*color:\s*#f0f2f5/);
        // Option popup entries: same opaque dark surface + light text (Firefox
        // and embedded webviews paint the popup from the <option> elements).
        expect(sheet).toMatch(/\.sg-select option\s*{[^}]*background-color:\s*#151b29/);
        expect(sheet).toMatch(/\.sg-select option\s*{[^}]*color:\s*#f0f2f5/);
    });

    it('offers the server-listed clients in the top-right dropdown and posts the chosen clientId on Generate', async () => {
        const fetchMock = globalThis.fetch as any;
        // The clients route is a sibling of the generations route with the
        // trailing segment swapped (see fetchClientOptions in src/api/storyboard.ts).
        const CLIENTS_URL = `${BASE_URL.replace(/\/generations$/, '/clients')}`;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            if (url === CLIENTS_URL) {
                // Server advertises its selectable CLIENTS keys (generation-config.ts).
                return Promise.resolve(mockResponse(200, { clients: ['Nvidia', 'KIMIK3', 'Qwen27B'] }));
            }
            return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        // Default selection is the package default client id.
        expect(clientSelect.value).toBe('Qwen27B');

        // The options fetch resolves and replaces the options list.
        await waitFor(() => {
            const options = Array.from(clientSelect.querySelectorAll('option')).map((o) => o.value);
            expect(options).toEqual(['Nvidia', 'KIMIK3', 'Qwen27B']);
        });

        // Pick a different LLM client.
        fireEvent.change(clientSelect, { target: { value: 'Nvidia' } });
        expect(clientSelect.value).toBe('Nvidia');

        // Focus the storyline input to reveal the controls, fill the form, generate.
        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
        });
        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'A test story for Nvidia' }
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '2' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        // The POST body carries the dropdown selection — the server validates
        // it and uses the matching client for this generation only.
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A test story for Nvidia',
                chapterCount: 2,
                clientId: 'Nvidia'
            });
        });
    });

    // Retries the /v1/storyboard/clients fetch against a STALE deployment:
    // the first response is a 404 (route not deployed yet), the retry after
    // CLIENTS_FETCH_RETRY_MS (10s, see StoryGeneratorApp.tsx) hits the
    // updated server and fills the dropdown with every CLIENTS key — no page
    // reload required. Fake timers advance the retry delay deterministically.
    it('recovers the full client list when the server first 404s (stale deployment) and recovers without a page reload', async () => {
        vi.useFakeTimers();
        const fetchMock = globalThis.fetch as any;
        const CLIENTS_URL = `${BASE_URL.replace(/\/generations$/, '/clients')}`;
        let clientsCalls = 0;
        // Full key set from the server's CLIENTS map (generation-config.ts).
        const ALL_CLIENTS = ['Nvidia', 'KIMIK3', 'Qwen27B', 'Makora', 'DeepSeek', 'Telnyx'];
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (url === CLIENTS_URL && (!init || init.method === 'GET')) {
                clientsCalls++;
                // Attempt 1: stale deployment predates the clients route → 404.
                if (clientsCalls === 1) {
                    return Promise.resolve(mockResponse(404, { error: 'Not Found' }));
                }
                // Attempt 2 (retry after the deployment restarts): full list.
                return Promise.resolve(mockResponse(200, { clients: ALL_CLIENTS }));
            }
            return Promise.resolve(mockResponse(200, init && init.method === 'POST' ? {} : { stories: [] }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        const readOptions = () => Array.from(clientSelect.querySelectorAll('option')).map((o) => o.value);

        // Flush microtasks (fake timers: a 0ms advance runs the pending promise
        // chain of the first, 404-ing fetch) — the dropdown still offers only
        // the default id: the exact stale-deployment symptom.
        await act(async () => {
            for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
        });
        expect(readOptions()).toEqual(['Qwen27B']);

        // Advance past CLIENTS_FETCH_RETRY_MS (10s) to fire the first retry.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 1000);
        });

        // The retry found the route and the dropdown now mirrors every client.
        expect(readOptions()).toEqual(ALL_CLIENTS);
        expect(clientsCalls).toBe(2);
        vi.useRealTimers();
    });

    // StrictMode regression (dev-only failure mode): React 18 StrictMode runs
    // mount effect → cleanup → re-mount effect. The clients-fetch effect must
    // NOT use a shared "did fetch" ref guard — the guard makes the StrictMode
    // re-run return early, orphaning the first run's in-flight fetch whose
    // closure was already disposed by its cleanup. The browser still completes
    // that request (307 → 200 in DevTools) but its response is dropped, and no
    // fetch is ever re-issued, so the dropdown stays pinned to the default
    // clientId forever. Render inside <StrictMode> (like main.tsx does) and
    // assert the full server list still lands in the dropdown.
    it('populates the client dropdown under React.StrictMode double-invocation (no orphaned disposed fetch)', async () => {
        const fetchMock = globalThis.fetch as any;
        const CLIENTS_URL = `${BASE_URL.replace(/\/generations$/, '/clients')}`;
        let clientsCalls = 0;
        // Full key set from the server's CLIENTS map (generation-config.ts).
        const ALL_CLIENTS = ['Nvidia', 'KIMIK3', 'Qwen27B', 'Makora', 'DeepSeek', 'Telnyx'];
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (url === CLIENTS_URL && (!init || init.method === 'GET')) {
                clientsCalls++;
                // Every attempt succeeds, exactly like the real deployment:
                // the drop can only come from the component ignoring the
                // response (disposed closure), not from the network.
                return Promise.resolve(mockResponse(200, { clients: ALL_CLIENTS }));
            }
            return Promise.resolve(mockResponse(200, { stories: [] }));
        });

        // main.tsx wraps <App /> in <React.StrictMode> — replicate it so the
        // double mount/cleanup/mount lifecycle is exercised.
        render(
            <StrictMode>
                <StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />
            </StrictMode>
        );

        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        // Before any fetch resolves the dropdown offers only the default id.
        expect(clientSelect.value).toBe('Qwen27B');

        // The StrictMode remount's own fetch must complete and populate the
        // dropdown with every client — not just the first (disposed) attempt,
        // which would leave the options pinned to Qwen27B.
        await waitFor(() => {
            const options = Array.from(clientSelect.querySelectorAll('option')).map((o) => o.value);
            expect(options).toEqual(ALL_CLIENTS);
        });
        // StrictMode issues the effect twice; both attempts must have hit the
        // endpoint (the first one's result is intentionally discarded).
        expect(clientsCalls).toBe(2);
    });

    // The user's last dropdown choice must survive a full reload: the store
    // persists config.clientId to localStorage (key 'storyGenerator:clientId')
    // and StoryStoreProvider restores it ahead of the DEFAULT_CLIENT_ID
    // fallback and ahead of the server's client list (localStorage > default).
    it('persists the selected clientId to localStorage and restores it on the next mount', async () => {
        const view = render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        expect(clientSelect.value).toBe('Qwen27B'); // no stored choice yet → default
        // Default fetch mock answers the clients URL with 200 { stories: [] } →
        // fetchClientOptions degrades to [] (no clients key), so the option
        // list stays pinned to the selected id and 'Nvidia' is not selectable.
        // Simulate the server advertising Nvidia to make the choice meaningful.
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (url === `${BASE_URL.replace(/\/generations$/, '/clients')}`) {
                return Promise.resolve(mockResponse(200, { clients: ['Qwen27B', 'Nvidia'] }));
            }
            return Promise.resolve(mockResponse(200, { stories: [] }));
        });
        // Re-mount triggers a fresh options fetch with the new mock.
        view.unmount();
        const view2 = render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);
        const select2 = screen.getByTestId('client-select') as HTMLSelectElement;
        await waitFor(() => {
            const options = Array.from(select2.querySelectorAll('option')).map((o) => o.value);
            expect(options).toEqual(['Qwen27B', 'Nvidia']);
        });

        // Choose Nvidia — the change handler persists it SYNCHRONOUSLY (the
        // write completes before the event dispatch returns). This is the real
        // durability contract: passive useEffect writes are deferred and can be
        // skipped when the page reloads/unloads before the flush, which lost
        // the user's selection in production. (jsdom fireEvent/act flushes
        // passive effects too, so this line cannot fail for an effect-based
        // write in isolation — the reload-restore round-trip below is the
        // regression guard; keep both.)
        fireEvent.change(select2, { target: { value: 'Nvidia' } });
        expect(localStorage.getItem('storyGenerator:clientId')).toBe('Nvidia');
        await waitFor(() => {
            expect(localStorage.getItem('storyGenerator:clientId')).toBe('Nvidia');
        });
        view2.unmount();

        // A brand-new mount (page reload) restores the persisted choice.
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);
        const select3 = screen.getByTestId('client-select') as HTMLSelectElement;
        // The provider reads localStorage before any options fetch resolves,
        // so the FIRST render already reflects the user's previous choice.
        expect(select3.value).toBe('Nvidia');
    });

    it('toggles the sidebar open and closed via the hamburger icon', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        const toggle = screen.getByTestId('sidebar-toggle');
        const panel = screen.getByTestId('sidebar-panel');

        // Sidebar starts open — panel has width 12.5rem.
        expect(panel).toBeDefined();
        expect(panel.style.width).toBe('12.5rem');

        // Click toggle to close.
        fireEvent.click(toggle);
        await waitFor(() => {
            expect(panel.style.width).toBe('0px');
        });

        // Click toggle to reopen.
        fireEvent.click(toggle);
        await waitFor(() => {
            expect(panel.style.width).toBe('12.5rem');
        });
    });

    it('opens a solid rename dialog with accessible controls for the selected story', async () => {
        // Seed one complete local entry so the title action is available without
        // depending on bootstrap timing or a server-provided story list.
        const story = {
            id: 1,
            storyId: 'rename-story-1',
            storyName: 'Original title',
            title: 'Original title',
            storyline: 'A story to rename.',
            // No chapters are needed for this header-only interaction, and a
            // zero request count keeps the content poller out of the test.
            chapterRequested: 0,
            chapterCompleted: 0,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'generating' as const,
            // Content is empty but initialized so SectionStoryContent can read
            // its chapter count while the rename interaction is under test.
            data: { chapters: [], meta: null },
            isProcessing: false,
            error: '',
            isRemote: false
        };

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Clicking the selected header title opens the focused rename surface.
        fireEvent.click(screen.getByTestId('story-title'));

        const dialog = screen.getByTestId('rename-dialog');
        const input = screen.getByTestId('rename-input') as HTMLInputElement;
        const confirm = screen.getByTestId('rename-confirm') as HTMLButtonElement;

        // The dialog exposes its modal relationship and starts with the selected
        // title, while the input and primary action use their dedicated styles.
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('rename-dialog-title');
        expect(input.value).toBe('Original title');
        expect(input.className).toBe('sg-dialog-input');
        expect(confirm.className).toBe('sg-dialog-confirm');
        expect(confirm.disabled).toBe(false);

        // Whitespace-only input is not a valid title and disables confirmation.
        fireEvent.change(input, { target: { value: '   ' } });
        expect(confirm.disabled).toBe(true);

        // A non-empty title restores the primary action, and cancel closes the
        // dialog without changing the title shown in the header.
        fireEvent.change(input, { target: { value: 'Renamed story' } });
        expect(confirm.disabled).toBe(false);
        fireEvent.click(screen.getByTestId('rename-cancel'));
        expect(screen.queryByTestId('rename-dialog')).toBeNull();
        expect(screen.getByTestId('story-title').textContent).toBe('Original title');
    });

    // Read the sidebar tile order (top-to-bottom) as an array of testids.
    // Tiles are <button data-testid="story-tab-<storyId>"> elements; DOM order
    // IS the sorted display order (see SectionStoryTabs' last-actioned sort).
    const readSidebarOrder = () =>
        screen
            .getAllByRole('button')
            .filter((b) => b.dataset.testid?.startsWith('story-tab-'))
            .map((b) => b.dataset.testid);

    it('does NOT reorder the sidebar when a story is selected (viewing is not an action)', async () => {
        // Viewing contract: lastActionedAt tracks data-MUTATING user actions
        // (POST/PATCH flows only). Selecting a tile is read-only (GET) and
        // must change the selection without touching the sort order —
        // otherwise the list would shuffle under the user's cursor just
        // because they clicked a story open.
        const dayMs = 86_400_000;
        // Most recently CREATED — stays on top (createdDate sort fallback).
        const storyRecent = {
            id: 1,
            storyId: 'recent-story',
            storyName: 'Recent Tale',
            title: 'Recent Tale',
            storyline: '',
            chapterRequested: 1,
            chapterCompleted: 0,
            createdDate: new Date(Date.now() - dayMs).toISOString(),
            // Data pre-seeded so the selection catch-up effect stays quiet —
            // this test isolates the SELECTION behaviour, not the fetch path.
            data: { chapters: [], meta: null },
            status: 'generating' as const,
            isProcessing: false,
            error: '',
            isRemote: true
        };
        // Older story — starts at the bottom.
        const storyOld = {
            id: 2,
            storyId: 'old-story',
            storyName: 'Old Tale',
            title: 'Old Tale',
            storyline: '',
            chapterRequested: 1,
            chapterCompleted: 0,
            createdDate: new Date(Date.now() - 2 * dayMs).toISOString(),
            data: { chapters: [], meta: null },
            status: 'generating' as const,
            isProcessing: false,
            error: '',
            isRemote: true
        };

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [storyRecent, storyOld] }}
            />
        );

        // Baseline: the newer-CREATED story is on top (createdDate is the
        // sorting fallback for never-actioned stories).
        expect(readSidebarOrder()).toEqual(['story-tab-recent-story', 'story-tab-old-story']);

        // Read-only action: select the older story's tile.
        fireEvent.click(screen.getByTestId('story-tab-old-story'));

        // The selection took effect...
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-old-story').getAttribute('aria-pressed')).toBe('true');
        });
        // ...but the ordering is UNCHANGED — viewing never bumps
        // lastActionedAt, so the older story stays where it was.
        expect(readSidebarOrder()).toEqual(['story-tab-recent-story', 'story-tab-old-story']);
    });

    it('moves the story to the top of the sidebar when a chapter action (re-expand) is triggered', async () => {
        const fetchMock = globalThis.fetch as any;
        const dayMs = 86_400_000;
        // Selected story: sits at the BOTTOM by createdDate and holds one
        // pending chapter that can be re-expanded.
        const storySelected = {
            id: 2,
            storyId: 'old-story',
            storyName: 'Old Tale',
            title: 'Old Tale',
            storyline: 'An old storyline',
            chapterRequested: 2,
            chapterCompleted: 0,
            createdDate: new Date(Date.now() - 2 * dayMs).toISOString(),
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Old Chapter',
                        plotpoints: ['beat one'],
                        expanded: false,
                        canReExpand: true
                    }
                ],
                meta: { storyline: 'An old storyline', chapterCount: 2, createdAt: new Date(Date.now() - 2 * dayMs).toISOString() }
            },
            status: 'generating' as const,
            isProcessing: false,
            error: '',
            isRemote: true
        };
        // Idle story: newer by createdDate, starts on top, never actioned.
        const storyIdle = {
            id: 1,
            storyId: 'recent-story',
            storyName: 'Recent Tale',
            title: 'Recent Tale',
            storyline: '',
            chapterRequested: 1,
            chapterCompleted: 0,
            createdDate: new Date(Date.now() - dayMs).toISOString(),
            data: { chapters: [], meta: null },
            status: 'generating' as const,
            isProcessing: false,
            error: '',
            isRemote: true
        };

        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'PATCH') {
                // Re-expand PATCH accepted — background job started.
                return Promise.resolve(
                    mockResponse(200, {
                        storyId: 'old-story',
                        expandChapterIndex: 0,
                        chapterNumber: '1',
                        title: 'Old Chapter',
                        message: 'ok'
                    })
                );
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // Collection endpoint: empty list (keeps the seeded records).
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                // Per-story GET: the chapter now expanded with one revision —
                // this is what the re-expand completion poller waits for.
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'Old Chapter',
                                plotpoints: ['beat one'],
                                expanded: true,
                                canReExpand: true,
                                revisions: [{ content: '## Old Chapter\n\nExpanded body', wordCount: 2, generationTimeMs: 100 }]
                            }
                        ],
                        meta: { storyline: 'An old storyline', chapterCount: 2, createdAt: storySelected.createdDate }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(
            <StoryGeneratorApp
                // activePollIntervalMs drives the re-expand completion poller —
                // 10ms keeps the test fast under real timers.
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS, activePollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [storyIdle, storySelected], selected: storySelected }}
            />
        );

        // Baseline: the idle (newer-created) story is on top — the selected
        // story has NOT been actioned yet.
        expect(readSidebarOrder()).toEqual(['story-tab-recent-story', 'story-tab-old-story']);

        // User action: re-expand chapter 1 of the SELECTED (bottom) story.
        // The auto-expand-latest effect opens chapter 0, which renders the
        // per-chapter action bar containing the re-expand button.
        const reexpandButton = await waitFor(() => {
            const button = screen.getByTestId('chapter-0-reexpand');
            expect(button).toBeDefined();
            return button;
        });
        await act(async () => {
            fireEvent.click(reexpandButton);
        });

        // The PATCH fired for the right story...
        await waitFor(() => {
            const patch = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
            expect(patch).toBeDefined();
            expect(patch![0]).toBe(`${BASE_URL}/old-story`);
            expect(JSON.parse(patch![1].body).expandChapterIndex).toBe(0);
        });

        // ...and the user action bumped old-story's lastActionedAt (= now),
        // moving it above the untouched story even though its createdDate is
        // a full day older. This is the "last actioned on top" contract for
        // generation-triggering actions (expand/rewrite/append/resume/fork).
        await waitFor(() => {
            expect(readSidebarOrder()).toEqual(['story-tab-old-story', 'story-tab-recent-story']);
        });
    });

    it('creates a new story when Generate is clicked with valid input', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Focus the textarea to reveal controls.
        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
            expect(screen.getByTestId('chapter-count-input')).toBeDefined();
        });

        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'A test story' }
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '3' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        // A new sidebar item should have been created and selected.
        await waitFor(() => {
            const tabs = screen.getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('story-tab-'));
            expect(tabs.length).toBe(1);
            expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
        });

        // The POST should have been made.
        //
        // The payload carries the top-right dropdown selection as clientId
        // (store.config.clientId, default 'Qwen27B' — localStorage is cleared
        // in beforeEach so the package default always applies in tests).
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A test story',
                chapterCount: 3,
                clientId: 'Qwen27B'
            });
        });
    });

    it('POSTs the storyline + chapterCount to the server on Generate and starts polling', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            const storyId = String(url.split('/').pop() ?? '');
            fetchMock.__counts = fetchMock.__counts ?? {};
            fetchMock.__counts[storyId] = (fetchMock.__counts[storyId] ?? 0) + 1;
            const c = fetchMock.__counts[storyId];
            const chapters = Array.from({ length: Math.min(c, 3) }, (_, i) => ({
                chapterNumber: String(i + 1),
                chapterIndex: i,
                title: `Chapter ${i + 1}`,
                plotpoints: [`Plot point ${i + 1}`],
                expanded: true,
                revisions: [
                    { content: `## Chapter ${i + 1}\n\nbody`, wordCount: 1, generationTimeMs: 1000 }
                ]
            }));
            return Promise.resolve(mockResponse(200, { chapters, meta: { storyline: 'test', chapterCount: 3, createdAt: '2026-07-01' } }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
            expect(screen.getByTestId('chapter-count-input')).toBeDefined();
        });

        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'A sci-fi adventure on Mars.' }
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '3' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        // Generate creates a new sidebar item — wait for it to appear.
        await waitFor(() => {
            const tabButton = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'));
            expect(tabButton).toBeDefined();
        });
        const tabButton = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'))!;
        const storyId = (tabButton.dataset.testid ?? '').replace('story-tab-', '');
        expect(storyId.length).toBeGreaterThan(0);

        // The POST should have been made.
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(postCall![0]).toBe(`${BASE_URL}/${storyId}`);
            // clientId is the store's default client id (localStorage cleared
            // in beforeEach → DEFAULT_CLIENT_ID = 'Qwen27B').
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A sci-fi adventure on Mars.',
                chapterCount: 3,
                clientId: 'Qwen27B'
            });
        });

        // After polling completes, three chapters should be rendered as individual collapsibles.
        await waitFor(() => {
            expect(screen.queryByTestId('chapter-0')).toBeDefined();
            expect(screen.queryByTestId('chapter-1')).toBeDefined();
            expect(screen.queryByTestId('chapter-2')).toBeDefined();
        });

        // The latest chapter (chapter 2) should be expanded by default
        expect(screen.getByTestId('chapter-2-toggle').getAttribute('aria-expanded')).toBe('true');
        // Expanded chapter shows content
        expect(screen.getByTestId('chapter-2-content')).toBeDefined();
        // Plotpoints Collapsible exists but is collapsed (since chapter is expanded)
        expect(screen.getByTestId('chapter-2-plotpoints')).toBeDefined();
        expect(screen.getByTestId('chapter-2-plotpoints-toggle').getAttribute('aria-expanded')).toBe('false');

        // Expand chapter 1 to verify its content is shown
        fireEvent.click(screen.getByTestId('chapter-1-toggle'));
        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-content')).toBeDefined();
        });
        // Chapter 1 is expanded, so its plotpoints Collapsible is collapsed by default
        expect(screen.getByTestId('chapter-1-plotpoints-toggle').getAttribute('aria-expanded')).toBe('false');

        // Toggle chapter 2 to collapse it
        fireEvent.click(screen.getByTestId('chapter-2-toggle'));
        expect(screen.queryByTestId('chapter-2-body')).toBeNull();
    });

    it('shows an inline validation error when storyline is empty on submit', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '1' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        expect(screen.getByTestId('input-error').textContent).toBe('storyline is required');
        const postCalls = (globalThis.fetch as any).mock.calls.filter(
            ([, init]: any[]) => init?.method === 'POST'
        );
        expect(postCalls).toEqual([]);
    });

    // Bootstrap: GET / returns existing story metadata on mount → seeded as sidebar items.
    it('loads existing stories from the collection endpoint on mount and selects the first', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'aaaa-1111', chapterRequested: 3, chapterCompleted: 0, createdDate: '2026-07-03T12:00:00Z', status: 'generating' },
                                { storyId: 'bbbb-2222', chapterRequested: 5, chapterCompleted: 0, createdDate: '2026-07-02T10:00:00Z', status: 'generating' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for both items to be seeded by BootstrapLayer.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-aaaa-1111')).toBeDefined();
            expect(screen.getByTestId('story-tab-bbbb-2222')).toBeDefined();
        });

        // The first loaded story is auto-selected — its content shows the
        // chapters list with "No chapters yet." since the mock returns empty chapters.
        await waitFor(() => {
            expect(screen.getByTestId('chapters-list').textContent).toContain('No chapters yet.');
        });
    });

    // Selecting a remote UUID triggers polling that hydrates its data.
    it('polls the selected remote story until chapters are stable', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'remote-uuid-1', chapterRequested: 1, chapterCompleted: 0, createdDate: '2026-07-03T12:00:00Z', status: 'generating' }
                            ]
                        })
                    );
                }
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'Ch1',
                                plotpoints: ['plot'],
                                expanded: true,
                                revisions: [
                                    { content: '## Ch1\n\nbody', wordCount: 5, generationTimeMs: 1000 }
                                ]
                            }
                        ],
                        meta: { storyline: 'Remote story', chapterCount: 1, createdAt: '2026-07-03T12:00:00Z' }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            expect(screen.getByTestId('story-tab-remote-uuid-1')).toBeDefined();
            expect(screen.getByTestId('chapter-0-content').textContent).toContain('Ch1');
            // Plotpoints Collapsible exists (chapter is expanded, so plotpoints are collapsed)
            expect(screen.getByTestId('chapter-0-plotpoints')).toBeDefined();
        });

        // After two stable polls, isProcessing flips false so the badge stops.
        await waitFor(() => {
            const tab = screen.getByTestId('story-tab-remote-uuid-1');
            expect(tab.textContent).not.toContain('⏳');
        });
    });

    // Auto-refresh picks up new stories that appear on the server after mount.
    it('auto-refreshes the sidebar to pick up new stories from the server', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let listResponse = { stories: [{ storyId: 'first-uuid', chapterRequested: 2, chapterCompleted: 0, createdDate: '2026-07-03T12:00:00Z', status: 'generating' }] };
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, listResponse));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for the initial bootstrap to load first-uuid.
        await waitFor(() => expect(screen.getByTestId('story-tab-first-uuid')).toBeDefined());

        // Simulate a new story appearing on the server.
        listResponse = {
            stories: [
                { storyId: 'first-uuid', chapterRequested: 2, chapterCompleted: 0, createdDate: '2026-07-03T12:00:00Z', status: 'generating' },
                { storyId: 'second-uuid', chapterRequested: 4, chapterCompleted: 0, createdDate: '2026-07-03T13:00:00Z', status: 'generating' }
            ]
        };

        // Trigger auto-refresh by advancing timers past REFRESH_INTERVAL_MS (30s).
        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });

        // After the refresh resolves, second-uuid should appear as a new sidebar item.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-first-uuid')).toBeDefined();
            expect(screen.getByTestId('story-tab-second-uuid')).toBeDefined();
        });

        // Selection is preserved on first-uuid.
        expect(screen.getByTestId('story-tab-first-uuid').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('story-tab-second-uuid').getAttribute('aria-pressed')).toBe('false');

        vi.useRealTimers();
    });

    // The sidebar tile animates while the SERVER's in-memory job registry
    // reports a live background thread for the story (StoryMeta.processing).
    // This covers jobs started by OTHER sessions/devices: the animating
    // session never set isProcessing itself — the flag arrives via the list
    // merge. When the job finishes (processing drops out of the list
    // response), the animation stops.
    //
    // chapterRequested stays 0 so SectionStoryContent's own poll loop runs in
    // stable-poll mode and terminates immediately (2 identical empty polls) —
    // isProcessing drops to false on its own, which isolates the animation
    // source under test to the server-side serverProcessing flag.
    it('animates the sidebar tile while the server reports a background job and stops when it finishes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let listResponse = {
            stories: [
                {
                    storyId: 'bg-job-uuid',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T12:00:00Z',
                    status: 'generating',
                    // Server job registry says: a background thread is live.
                    processing: true
                }
            ],
            jobs: [{ jobId: 'job-1', storyId: 'bg-job-uuid', kind: 'create', startedAt: '2026-07-03T12:00:01Z' }]
        };
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, listResponse));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for the entry's own poll loop to settle first (isProcessing
        // flips false after two stable polls) so the animation below comes
        // purely from the server's registry flag.
        await waitFor(() => {
            const tab = screen.getByTestId('story-tab-bg-job-uuid');
            expect(tab.textContent).toContain('⏳');
            expect(tab.querySelector('.sg-spinner')).not.toBeNull();
            expect(tab.className).toContain('sg-story-processing');
        });

        // The background job finished on the server — the registry is now
        // blank for this story (in-memory, blank slate semantics).
        listResponse = {
            stories: [
                {
                    storyId: 'bg-job-uuid',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T12:00:00Z',
                    status: 'generating',
                    processing: false
                }
            ],
            jobs: []
        };

        // Trigger the sidebar auto-refresh in bounded 5s stages (the ACTIVE
        // refresh cadence while the server reports the job). A single 31s
        // advance can flake under parallel-suite CPU load — the fake-timer
        // interval callback's async fetch chain must flush before the DOM
        // updates, and a one-shot advance leaves only waitFor's default 1s
        // real-time budget for that flush. Staged advances re-check the tile
        // after each round so the loop exits as soon as the cleared sync
        // lands (40 stages = 200s of virtual time, far beyond any realistic
        // flush latency).
        let animationStopped = false;
        for (let i = 0; i < 40 && !animationStopped; i++) {
            await act(async () => {
                vi.advanceTimersByTime(5_000);
            });
            // After the sync the tile's animation stops: badge, spinner
            // ring, and pulse class are all gone (the ⏳ absence keeps the
            // App.test.tsx:631 contract).
            const tab = screen.getByTestId('story-tab-bg-job-uuid');
            animationStopped =
                !tab.textContent!.includes('⏳') &&
                tab.querySelector('.sg-spinner') === null &&
                !tab.className.includes('sg-story-processing');
        }
        expect(animationStopped).toBe(true);

        vi.useRealTimers();
    });

    // The "Stories" header shows a live count of background threads: the
    // server registry snapshot (list response `jobs` array — one entry per
    // running thread, across ALL stories) drives the exact count.
    it('shows the server job count in the Stories header and clears it when the jobs finish', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // Two stories, one job each → the header chip must read exactly
        // "2 running" (2 threads in flight on the server).
        let listResponse = {
            stories: [
                {
                    storyId: 'job-count-a',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T12:00:00Z',
                    status: 'generating',
                    processing: true
                },
                {
                    storyId: 'job-count-b',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T11:00:00Z',
                    status: 'generating',
                    processing: true
                }
            ],
            jobs: [
                { jobId: 'job-1', storyId: 'job-count-a', kind: 'create', startedAt: '2026-07-03T12:00:01Z' },
                { jobId: 'job-2', storyId: 'job-count-b', kind: 'create', startedAt: '2026-07-03T11:00:01Z' }
            ]
        };
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, listResponse));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            expect(screen.getByTestId('sidebar-job-count').textContent).toBe('2 running');
        });

        // Both jobs finish on the server — the registry snapshot empties and
        // the per-story flags drop. After the next sync the chip disappears
        // entirely (idle server shows the bare "Stories" label).
        listResponse = {
            stories: [
                {
                    storyId: 'job-count-a',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T12:00:00Z',
                    status: 'generating',
                    processing: false
                },
                {
                    storyId: 'job-count-b',
                    chapterRequested: 0,
                    chapterCompleted: 0,
                    createdDate: '2026-07-03T11:00:00Z',
                    status: 'generating',
                    processing: false
                }
            ],
            jobs: []
        };

        // Trigger the sidebar auto-refresh in bounded stages. A single 31s
        // advance relies on the fake-timer interval callback's async fetch
        // chain flushing within the following waitFor window — under
        // parallel-suite CPU load that flush can slip past waitFor's default
        // 1s budget and the test flakes. Advancing 5s at a time (the ACTIVE
        // refresh cadence while jobs are live) and re-checking the DOM after
        // each stage makes the wait deterministic: the loop exits the moment
        // the cleared registry sync lands, and the 40-stage bound (200s of
        // virtual time) far exceeds any realistic flush latency.
        let chipCleared = false;
        for (let i = 0; i < 40 && !chipCleared; i++) {
            await act(async () => {
                vi.advanceTimersByTime(5_000);
            });
            // After the sync the chip disappears entirely (idle server shows
            // the bare "Stories" label) — the registry snapshot reports zero
            // live threads and both per-story flags are retired by the merge.
            chipCleared = screen.queryByTestId('sidebar-job-count') === null;
        }
        expect(chipCleared).toBe(true);

        vi.useRealTimers();
    });

    // The count must be INSTANT for jobs this session just started: Generate
    // sets isProcessing synchronously (SectionStoryInput), which must count
    // toward the header chip BEFORE any list sync reports the job — the idle
    // refresh cadence is 30s, so a snapshot-only count would lag badly here.
    it('counts a just-started local job in the Stories header before any list sync reports it', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // List syncs report NO jobs — the count below can only come
                    // from this session's local isProcessing flag.
                    return Promise.resolve(mockResponse(200, { stories: [], jobs: [] }));
                }
                // Story-data GET: chapterRequested=2 is never satisfied
                // (chapters stays empty), so the poll loop — and isProcessing —
                // stays alive for the assertion window.
                return Promise.resolve(
                    mockResponse(200, { chapters: [], meta: { storyline: '', chapterCount: 2, createdAt: '2026-07-03T12:00:00Z' } })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
        });
        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'Local job count story' }
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '2' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('sidebar-job-count').textContent).toBe('1 running');
        });
    });

    // POLLING CONTRACT — an idle story (no isProcessing, no serverProcessing)
    // must NOT be polled at all: its files only change while a background job
    // writes them, so a polling loop without a job is pure server load (the
    // old behavior re-armed the loop forever via the pollCycle timer).
    it('does not poll the selected story while no background job runs for it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fetchMock = globalThis.fetch as any;
        // Fully generated, fully cached story — nothing in flight anywhere.
        const story = {
            id: 1,
            storyId: 'seed-idle-1',
            storyline: 'Idle story',
            title: 'Idle story',
            chapterRequested: 3,
            chapterCompleted: 3,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'completed' as const,
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Ch1',
                        plotpoints: ['plot1'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Ch1\n\nbody', wordCount: 5, generationTimeMs: 1000 }]
                    }
                ],
                meta: { storyline: 'Idle story', chapterCount: 3, createdAt: '2026-08-01T12:00:00Z' }
            },
            isProcessing: false,
            error: '',
            isRemote: true
        };
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // Empty list → the seeded record stays (merge returns null).
                    return Promise.resolve(mockResponse(200, { stories: [], jobs: [] }));
                }
                // Any per-story GET would satisfy any target instantly — if a
                // loop were running, the count below would grow.
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS, activePollIntervalMs: 100 }}
                initialStore={{ records: [story] as any, selected: story as any }}
            />
        );

        // Cached content renders instantly (no fetch needed).
        await waitFor(() => {
            expect(screen.getByTestId('chapter-0-content').textContent).toContain('body');
        });

        const countStoryGets = () =>
            fetchMock.mock.calls.filter(([url]: any[]) => String(url) === `${BASE_URL}/seed-idle-1`).length;

        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });

        // EXACT: zero story GETs ever — not even the configured 100ms active
        // cadence leaks into the idle state.
        expect(countStoryGets()).toBe(0);
        // The sidebar list sync DID run (bootstrap + one 30s refresh), proving
        // the timers advanced while the story stayed unpollted.
        const listGets = fetchMock.mock.calls.filter(
            ([url, init]: any[]) => (url === BASE_URL || url === `${BASE_URL}/`) && (!init || init.method === 'GET')
        ).length;
        expect(listGets).toBe(2);

        vi.useRealTimers();
    });

    // POLLING CONTRACT — while the registry reports a live job for the story,
    // the loop polls at the FAST active cadence and stops polling entirely
    // once the registry no longer reports the story.
    it('polls the selected story at the fast active cadence while a job runs, then stops when it ends', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fetchMock = globalThis.fetch as any;
        let listResponse = {
            stories: [
                {
                    storyId: 'seed-active-1',
                    chapterRequested: 5,
                    chapterCompleted: 0,
                    createdDate: '2026-08-01T12:00:00.000Z',
                    status: 'generating',
                    processing: true
                }
            ],
            jobs: [{ jobId: 'job-1', storyId: 'seed-active-1', kind: 'create', startedAt: '2026-08-01T12:00:01Z' }]
        };
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, listResponse));
                }
                // 1 pending chapter of a 5-chapter target — the loop's target
                // condition is never met, so it keeps polling while the job
                // flag lives and any growth in the fetch count comes purely
                // from the polling cadence.
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: false, canReExpand: true }
                        ],
                        meta: { storyline: 'Active story', chapterCount: 5, createdAt: '2026-08-01T12:00:00Z' }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS, activePollIntervalMs: 1000 }}
            />
        );

        // Bootstrap seeds the story with processing=true → the job-gated loop
        // starts and polls at the 1s active cadence (vs the 10ms idle override
        // — which is irrelevant here since idle stories don't poll at all).
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-seed-active-1')).toBeDefined();
        });
        await act(async () => {
            vi.advanceTimersByTime(3_100);
        });
        const storyGetsDuringJob = fetchMock.mock.calls.filter(([url]: any[]) => String(url) === `${BASE_URL}/seed-active-1`).length;
        // Rounds at t=0 (loop start), t=1s, t=2s, t=3s → at least 4 rounds
        // within 3.1s proves the FAST cadence (the old 10s default would
        // yield at most 1).
        expect(storyGetsDuringJob).toBeGreaterThanOrEqual(4);

        // The job ends on the server — the registry stops reporting it.
        listResponse = {
            stories: [
                {
                    storyId: 'seed-active-1',
                    chapterRequested: 5,
                    chapterCompleted: 0,
                    createdDate: '2026-08-01T12:00:00.000Z',
                    status: 'generating',
                    processing: false
                }
            ],
            jobs: []
        };

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });

        // The tile animation follows the registry verdict down (both flags
        // retired by the merge — serverProcessing directly, isProcessing via
        // the registry-authoritative retirement).
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-seed-active-1').textContent).not.toContain('⏳');
        });

        // Allow any single in-flight round (started before the flag drop) to
        // settle, then snapshot.
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        const storyGetsAfterJob = fetchMock.mock.calls.filter(([url]: any[]) => String(url) === `${BASE_URL}/seed-active-1`).length;

        // Ten more seconds with NO job — the count must be EXACTLY unchanged:
        // no polling without a background thread.
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(fetchMock.mock.calls.filter(([url]: any[]) => String(url) === `${BASE_URL}/seed-active-1`).length).toBe(storyGetsAfterJob);

        vi.useRealTimers();
    });

    // BootstrapLayer failure (server down) sets a non-blocking loadWarning.
    it('shows a load warning when the collection endpoint fetch fails, but the dashboard is still usable', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(500, { error: 'server on fire' }));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            const warning = screen.getByTestId('load-warning');
            expect(warning.textContent).toContain('server on fire');
        });

        // The empty state is still shown — bootstrap failure does not crash.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
        // Input area is still available — user can create a new story via Generate.
        expect(screen.getByTestId('storyline-input')).toBeDefined();
    });

    // The "[->]" action button now opens a dialog (mirroring the footer
    // generation box) that extends the SELECTED story in place: notes
    // textarea + chapter count + Append button. Submitting POSTs
    // { append: { chapterCount, notes? }, clientId } to the SAME storyId.
    const seedAppendStory = (fetchMock: any, appendFetchImpl?: (url: string, init: any) => any) => {
        // Two pending-plotpoint chapters so the chapter list renders and the
        // story is pollable (chapterRequested > 0). meta.chapterCount (2) is
        // the base the dialog's "X + new = total" copy and the success-path
        // chapterRequested update derive from.
        const chapters = [
            {
                chapterNumber: '1',
                chapterIndex: 0,
                title: 'Ch1',
                plotpoints: ['plot1'],
                expanded: true,
                canReExpand: true,
                revisions: [{ content: '## Ch1\n\nbody', wordCount: 5, generationTimeMs: 1000 }]
            },
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'Ch2',
                plotpoints: ['plot2'],
                expanded: true,
                canReExpand: true,
                revisions: [{ content: '## Ch2\n\nbody', wordCount: 5, generationTimeMs: 1000 }]
            }
        ];
        const meta = { storyline: 'Seed story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z' };
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST' && appendFetchImpl) {
                return appendFetchImpl(url, init);
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(200, { chapters, meta }));
            }
            // Default POST: the storyId echoed from the URL tail (append ok).
            return Promise.resolve(mockResponse(200, { storyId: String(url.split('/').pop() ?? ''), appended: 0 }));
        });

        const story = {
            id: 1,
            storyId: 'append-story-1',
            storyline: 'Seed story',
            title: 'Seed story',
            chapterRequested: 2,
            chapterCompleted: 2,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'completed' as const,
            data: { chapters, meta },
            isProcessing: false,
            error: '',
            isRemote: true
        };
        return story;
    };

    it('opens the append dialog from the [->] action, POSTs the append envelope to the same storyId, and closes on success', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedAppendStory(fetchMock);

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // The [->] action (extend-plotpoints-button) appears when the story
        // has at least one chapter.
        await waitFor(() => {
            expect(screen.getByTestId('extend-plotpoints-button')).toBeDefined();
        });

        // Click the [->] action — the append dialog opens on demand.
        fireEvent.click(screen.getByTestId('extend-plotpoints-button'));
        await waitFor(() => {
            expect(screen.getByTestId('append-dialog')).toBeDefined();
        });

        // The dialog mirrors the footer box: notes textarea + chapters input +
        // a primary Append button, with the story's current size in the copy.
        const notes = screen.getByTestId('append-notes-input') as HTMLTextAreaElement;
        const count = screen.getByTestId('append-count-input') as HTMLInputElement;
        expect(notes).toBeDefined();
        expect(notes.value).toBe('');
        expect(count.value).toBe('3'); // default new-chapter count
        expect(screen.getByTestId('append-dialog').textContent).toContain('This story has 2 chapters.');

        // Enter guidance notes and pick 2 new chapters (2 existing + 2 = 4).
        fireEvent.change(notes, { target: { value: 'the arc turns dark' } });
        fireEvent.change(count, { target: { value: '2' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('append-button'));
        });

        // The append POST hits the SAME storyId with the append envelope +
        // the top-right dropdown's clientId (default 'Qwen27B' in tests).
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(postCall[0]).toBe(`${BASE_URL}/append-story-1`);
            expect(JSON.parse(postCall![1].body)).toEqual({
                append: { chapterCount: 2, notes: 'the arc turns dark' },
                clientId: 'Qwen27B'
            });
        });

        // Success: the dialog closes and resets to fresh defaults.
        await waitFor(() => {
            expect(screen.queryByTestId('append-dialog')).toBeNull();
        });

        // chapterRequested was bumped to the new total (2 existing + 2) so the
        // main poll loop restarts against the enlarged target while the new
        // plotline chapters stream in.
        await waitFor(() => {
            expect(screen.getByText('Generating 2/4 chapters…')).toBeDefined();
        });
    });

    it('keeps the append dialog open with the server message when the append request is rejected', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedAppendStory(fetchMock, (url: string, init: any) =>
            Promise.resolve(mockResponse(400, { error: "Story 'append-story-1' not found" }))
        );

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Open the dialog from the [->] action.
        fireEvent.click(screen.getByTestId('extend-plotpoints-button'));
        await waitFor(() => {
            expect(screen.getByTestId('append-dialog')).toBeDefined();
        });

        fireEvent.change(screen.getByTestId('append-count-input'), { target: { value: '3' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('append-button'));
        });

        // The 400's exact server message is surfaced inline; the dialog stays
        // open so the user can correct and retry.
        await waitFor(() => {
            expect(screen.getByTestId('append-error').textContent).toBe("Story 'append-story-1' not found");
        });
        expect(screen.getByTestId('append-dialog')).toBeDefined();
        // Inputs survive the failed submit for correction.
        expect((screen.getByTestId('append-count-input') as HTMLInputElement).value).toBe('3');
    });

    it('hides the append action when the selected story has no chapters yet', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                // Story dir exists but has no chapters yet.
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        const story = {
            id: 1,
            storyId: 'empty-story-1',
            storyline: 'Pending story',
            title: 'Pending story',
            chapterRequested: 3,
            chapterCompleted: 0,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'generating' as const,
            data: { chapters: [], meta: null },
            isProcessing: false,
            error: '',
            isRemote: true
        };

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Chapter list is visible but chapter-less — nothing to append to, so
        // the [->] action (and the entire action bar) is hidden.
        await waitFor(() => {
            expect(screen.getByTestId('chapters-list')).toBeDefined();
        });
        expect(screen.queryByTestId('extend-plotpoints-button')).toBeNull();
        expect(screen.queryByTestId('content-action-bar')).toBeNull();
    });

    // ── Story stats bar ───────────────────────────────────────────────────
    // A row of summary chips sits between the processing banner and the
    // chapter list: total chapters, total words of the currently-viewed
    // revisions, and the estimated token cost (~4 tokens per 3 words).
    it('shows the story stats (chapters / words / estimated tokens) before the chapter listing', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        // Two expanded chapters: 1200 + 1800 = 3000 words →
        // 3000 * 4 / 3 = 4000 estimated tokens (exact — no rounding drift).
        const chapters = [
            {
                chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'],
                expanded: true, canReExpand: true,
                revisions: [{ content: '## Ch1\n\nbody', wordCount: 1200, generationTimeMs: 1000 }]
            },
            {
                chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'],
                expanded: true, canReExpand: true,
                revisions: [{ content: '## Ch2\n\nbody', wordCount: 1800, generationTimeMs: 1000 }]
            }
        ];
        const meta = { storyline: 'Stats story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z' };
        const story = {
            id: 1,
            storyId: 'stats-story-1',
            storyline: 'Stats story',
            title: 'Stats story',
            chapterRequested: 2,
            chapterCompleted: 2,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'completed' as const,
            data: { chapters, meta },
            isProcessing: false,
            error: '',
            isRemote: true
        };

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        await waitFor(() => {
            expect(screen.getByTestId('story-stats')).toBeDefined();
        });

        // Exact values: 2 chapters, 3,000 words, ~4,000 estimated tokens
        // (en-US thousands separators, matching the component's formatting).
        expect(screen.getByTestId('stat-chapters').textContent).toBe('Chapters2');
        expect(screen.getByTestId('stat-words').textContent).toBe('Words3,000');
        expect(screen.getByTestId('stat-tokens').textContent).toBe('Tokens (est.)~4,000');

        // The stats bar sits BEFORE the chapter listing (document order).
        const content = screen.getByTestId('content-story');
        const statsEl = screen.getByTestId('story-stats');
        const listEl = screen.getByTestId('chapters-list');
        expect(content.contains(statsEl)).toBe(true);
        expect(content.contains(listEl)).toBe(true);
        expect(statsEl.compareDocumentPosition(listEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // ── Terminate job (the ■ action inside the processing banner) ─────────
    // While the story is processing, the banner carries a Terminate button.
    // Clicking it PATCHes { abortJob: true } to the story URL and retires the
    // local processing flags — the banner disappears immediately while the
    // server-side flow stops at its next checkpoint boundary.
    it('terminates the running job from the banner: PATCHes abortJob and clears the processing banner', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'PATCH') {
                return Promise.resolve(
                    mockResponse(200, {
                        storyId: String(url.split('/').pop() ?? ''),
                        abortJob: true,
                        aborted: 1,
                        message: 'Abort requested — 1 active job(s) will stop at their next checkpoint'
                    })
                );
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                // 2 of 5 chapters expanded → the poll loop keeps running while
                // isProcessing stays true (target not reached).
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: true, canReExpand: true, revisions: [{ content: '## Ch1', wordCount: 10, generationTimeMs: 1000 }] },
                            { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'], expanded: true, canReExpand: true, revisions: [{ content: '## Ch2', wordCount: 20, generationTimeMs: 1000 }] }
                        ],
                        meta: { storyline: 'Busy story', chapterCount: 5, createdAt: '2026-08-01T12:00:00Z', status: 'generating' }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        // isProcessing: true — this session started a job that is running.
        const story = {
            id: 1,
            storyId: 'busy-story-1',
            storyline: 'Busy story',
            title: 'Busy story',
            chapterRequested: 5,
            chapterCompleted: 2,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'generating' as const,
            data: {
                chapters: [
                    { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: true, canReExpand: true, revisions: [{ content: '## Ch1', wordCount: 10, generationTimeMs: 1000 }] },
                    { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'], expanded: true, canReExpand: true, revisions: [{ content: '## Ch2', wordCount: 20, generationTimeMs: 1000 }] }
                ],
                meta: { storyline: 'Busy story', chapterCount: 5, createdAt: '2026-08-01T12:00:00Z', status: 'generating' }
            },
            isProcessing: true,
            error: '',
            isRemote: true
        };

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // The processing banner with the Terminate control is visible.
        await waitFor(() => {
            expect(screen.getByTestId('terminate-job-button')).toBeDefined();
        });
        expect(screen.getByTestId('progress-banner').textContent).toContain('Generating 2/5 chapters…');

        await act(async () => {
            fireEvent.click(screen.getByTestId('terminate-job-button'));
        });

        // The PATCH carries the abort envelope (no clientId — no LLM work).
        await waitFor(() => {
            const patchCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
            expect(patchCall).toBeDefined();
            expect(patchCall![0]).toBe(`${BASE_URL}/busy-story-1`);
            expect(JSON.parse(patchCall![1].body)).toEqual({ abortJob: true });
        });

        // Success: the local processing flags retire → the banner (and its
        // Terminate control) disappears immediately. The generated chapters
        // stay listed.
        await waitFor(() => {
            expect(screen.queryByTestId('progress-banner')).toBeNull();
        });
        expect(screen.queryByTestId('terminate-job-button')).toBeNull();
        expect(screen.getByTestId('chapters-list').textContent).toContain('Chapter 1');
    });

    // ── Resume-generation action (the ▶ button) ───────────────────────────
    // Appears in the bottom action bar when the story's plotline sits below
    // its chapter target — the signature of an interrupted generation (server
    // restart, exhausted retries). Clicking POSTs { resume: { chapterCount } }
    // to the same storyId; the server keeps the complete chapter prefix and
    // regenerates the tail (generation-resume-story.ts).
    const seedResumeStory = (fetchMock: any, options?: {
        chapters?: any[];
        meta?: any;
        chapterRequested?: number;
        resumeFetchImpl?: (url: string, init: any) => any;
    }) => {
        // Default: an interrupted story — 2 of 5 chapters generated, frozen
        // at status 'generating' (the server's background job died).
        const chapters = options?.chapters ?? [
            { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: false, canReExpand: false },
            { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'], expanded: false, canReExpand: false }
        ];
        const meta = options?.meta ?? {
            storyline: 'Interrupted story',
            chapterCount: 5,
            createdAt: '2026-08-01T12:00:00Z',
            status: 'generating'
        };
        const chapterRequested = options?.chapterRequested ?? 5;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST' && options?.resumeFetchImpl) {
                return options.resumeFetchImpl(url, init);
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(200, { chapters, meta }));
            }
            // Default POST: resume accepted — 3 chapters to regenerate.
            return Promise.resolve(mockResponse(200, { storyId: String(url.split('/').pop() ?? ''), resumed: 3, chapterCount: 5 }));
        });
        return {
            id: 1,
            storyId: 'resume-story-1',
            storyline: 'Interrupted story',
            title: 'Interrupted story',
            chapterRequested,
            chapterCompleted: 0,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'generating' as const,
            data: { chapters, meta },
            isProcessing: false,
            error: '',
            isRemote: true
        };
    };

    it('shows the resume action for an interrupted story and POSTs the resume envelope on click', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedResumeStory(fetchMock);

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // 2 of 5 chapters present → resume generation is offered.
        await waitFor(() => {
            expect(screen.getByTestId('resume-generation-button')).toBeDefined();
        });
        expect(screen.getByTestId('resume-generation-button').getAttribute('title')).toBe(
            'Resume plotline generation (2/5 chapters)'
        );
        // Collapse-all + append stay available alongside it (chapters exist).
        expect(screen.getByTestId('collapse-all-button')).toBeDefined();
        expect(screen.getByTestId('extend-plotpoints-button')).toBeDefined();

        fireEvent.click(screen.getByTestId('resume-generation-button'));

        // POST hits the SAME storyId with the resume envelope: the target is
        // the larger of chapterRequested (5) and meta.chapterCount (5), plus
        // the top-right dropdown's clientId (default 'Qwen27B' in tests).
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(postCall[0]).toBe(`${BASE_URL}/resume-story-1`);
            expect(JSON.parse(postCall![1].body)).toEqual({
                resume: { chapterCount: 5 },
                clientId: 'Qwen27B'
            });
        });

        // Success: the processing banner comes back on with the server's target.
        await waitFor(() => {
            expect(screen.getByText('Generating 2/5 chapters…')).toBeDefined();
        });
    });

    it('hides the resume action when the plotline already reached its target', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedResumeStory(fetchMock, {
            chapters: [
                { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: false, canReExpand: true },
                { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'], expanded: false, canReExpand: true }
            ],
            meta: { storyline: 'Done story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z', status: 'completed' },
            chapterRequested: 2
        });

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // The bar still shows (collapse-all + append), but nothing needs resuming.
        await waitFor(() => {
            expect(screen.getByTestId('collapse-all-button')).toBeDefined();
        });
        expect(screen.getByTestId('extend-plotpoints-button')).toBeDefined();
        expect(screen.queryByTestId('resume-generation-button')).toBeNull();
    });

    it('shows ONLY the resume action when generation died before its first chapter', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedResumeStory(fetchMock, {
            chapters: [],
            meta: { storyline: 'Zero progress', chapterCount: 3, createdAt: '2026-08-01T12:00:00Z', status: 'generating' },
            chapterRequested: 3
        });

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Zero chapters: collapse-all + append are chapter-gated (hidden), but
        // resume MUST be reachable — this is the total-restart case. meta
        // arrives with the first poll, so the button appears on data.
        await waitFor(() => {
            expect(screen.getByTestId('resume-generation-button')).toBeDefined();
        });
        expect(screen.getByTestId('content-action-bar')).toBeDefined();
        expect(screen.queryByTestId('collapse-all-button')).toBeNull();
        expect(screen.queryByTestId('extend-plotpoints-button')).toBeNull();
    });

    it('shows the resume action for a failed story and surfaces server 400s in the error banner', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedResumeStory(fetchMock, {
            chapters: [
                { chapterNumber: '1', chapterIndex: 0, title: 'Ch1', plotpoints: ['plot1'], expanded: false, canReExpand: false },
                { chapterNumber: '2', chapterIndex: 1, title: 'Ch2', plotpoints: ['plot2'], expanded: false, canReExpand: false }
            ],
            meta: { storyline: 'Failed story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z', status: 'failed' },
            chapterRequested: 2,
            resumeFetchImpl: () =>
                Promise.resolve(mockResponse(400, { error: "Story 'resume-story-1' plotline generation is already complete (2/2 chapters)" }))
        });

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // meta.status 'failed' offers resume even though 2/2 chapter slots
        // exist (the failed tail fails the server's completeness check).
        await waitFor(() => {
            expect(screen.getByTestId('resume-generation-button')).toBeDefined();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId('resume-generation-button'));
        });

        // The 400's exact server message lands in the content-error banner.
        await waitFor(() => {
            expect(screen.getByTestId('content-error').textContent).toBe(
                "Error: Story 'resume-story-1' plotline generation is already complete (2/2 chapters)"
            );
        });
    });


    // Per-revision delete flow. The trash button sits next to the rewrite [+]
    // in the chapter sticky bar and only renders for expanded chapters. It
    // removes ONLY the revision selected in the chapter's revision dropdown —
    // the chapter reverts to plotlines-only solely when its LAST revision is
    // deleted. The click never deletes directly — a confirmation dialog opens
    // first. seedDeleteStory's mock `deleted` flag flips the GET chapter-2
    // payload to `chapter2After` once the confirm PATCH lands, emulating the
    // server's synchronous revision deletion.
    const seedDeleteStory = (fetchMock: any, chapter2Revisions: Array<{ content: string; wordCount: number; generationTimeMs: number }>, chapter2After: any) => {
        let deleted = false;
        const chapter1 = {
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Ch1',
            plotpoints: ['plot1'],
            expanded: true,
            canReExpand: true,
            revisions: [{ content: '## Ch1\n\nbody', wordCount: 5, generationTimeMs: 1000 }]
        };
        const chapter2Expanded = {
            chapterNumber: '2',
            chapterIndex: 1,
            title: 'Ch2',
            plotpoints: ['plot2'],
            expanded: true,
            canReExpand: true,
            revisions: chapter2Revisions
        };
        const meta = { storyline: 'Seed story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z' };
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'PATCH') {
                deleted = true;
                const patchBody = JSON.parse(init.body);
                return Promise.resolve(
                    mockResponse(200, {
                        storyId: 'delete-story-1',
                        deleteChapterIndex: 1,
                        deleteChapterRevisionIndex: patchBody.deleteChapterRevisionIndex,
                        chapterNumber: '2',
                        title: 'Ch2',
                        revisionsRemaining: chapter2After.expanded ? chapter2After.revisions.length : 0,
                        message: 'Chapter 1 revision deleted'
                    })
                );
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: deleted ? [chapter1, chapter2After] : [chapter1, chapter2Expanded],
                        meta
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        return {
            id: 1,
            storyId: 'delete-story-1',
            storyline: 'Seed story',
            title: 'Seed story',
            chapterRequested: 2,
            chapterCompleted: 2,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'completed' as const,
            data: { chapters: [chapter1, chapter2Expanded], meta },
            isProcessing: false,
            error: '',
            isRemote: true
        };
    };

    it('deletes only the selected revision after confirmation, keeping the chapter expanded', async () => {
        const fetchMock = globalThis.fetch as any;
        // Chapter 2 has two revisions; deleting the selected (oldest) one
        // leaves the latest — the chapter stays expanded.
        const story = seedDeleteStory(
            fetchMock,
            [
                { content: '## Ch2 rev1\n\nbody', wordCount: 5, generationTimeMs: 1000 },
                { content: '## Ch2 rev2\n\nbody', wordCount: 6, generationTimeMs: 900 }
            ],
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'Ch2',
                plotpoints: ['plot2'],
                expanded: true,
                canReExpand: true,
                revisions: [{ content: '## Ch2 rev2\n\nbody', wordCount: 6, generationTimeMs: 900 }]
            }
        );

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Auto-expand opens the latest chapter (index 1), so its sticky bar —
        // and the trash button next to rewrite — is visible.
        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-delete')).toBeDefined();
        });

        // Select the OLDEST revision in the dropdown — the delete button must
        // target the selection, not the latest.
        const revisionSelect = screen.getByTestId('chapter-1-revisions-select') as HTMLSelectElement;
        expect(revisionSelect.value).toBe('1'); // latest is the default
        fireEvent.change(revisionSelect, { target: { value: '0' } });
        expect(revisionSelect.value).toBe('0');

        // Clicking the trash button only opens the confirmation dialog — no
        // PATCH is sent yet (accidental click protection).
        fireEvent.click(screen.getByTestId('chapter-1-delete'));
        await waitFor(() => {
            expect(screen.getByTestId('delete-dialog')).toBeDefined();
        });
        const deleteDialog = screen.getByTestId('delete-dialog');
        expect(screen.getByTestId('delete-dialog-title').textContent).toBe('Delete Chapter 2 — Revision 1 of 2');
        expect(deleteDialog.textContent).toContain(
            "This removes revision 1 of 2 from Chapter 2. The chapter's other revisions are kept. This cannot be undone."
        );
        expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'PATCH')).toBe(false);

        // Confirm — the single PATCH targets the selected revision (index 0).
        await act(async () => {
            fireEvent.click(screen.getByTestId('delete-confirm'));
        });
        const patchCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(patchCall[0]).toBe(`${BASE_URL}/delete-story-1`);
        expect(JSON.parse(patchCall![1].body)).toEqual({ deleteChapterIndex: 1, deleteChapterRevisionIndex: 0 });

        // The dialog closes; the chapter stays expanded with the surviving
        // revision (one option left), and the trash button remains for it.
        await waitFor(() => {
            expect(screen.queryByTestId('delete-dialog')).toBeNull();
        });
        await waitFor(() => {
            const select = screen.getByTestId('chapter-1-revisions-select') as HTMLSelectElement;
            expect(select.options.length).toBe(1);
            expect(select.options[0].textContent).toBe('6 words · 0.9s');
            expect(select.value).toBe('0');
        });
        expect(screen.queryByTestId('chapter-1-pending')).toBeNull();
        expect(screen.getByTestId('chapter-1-delete')).toBeDefined();
    });

    it('returns the chapter to plotlines only (expandable again) when its last revision is deleted', async () => {
        const fetchMock = globalThis.fetch as any;
        // Chapter 2 has exactly one revision — deleting it empties revisions[]
        // and the chapter drops back to the plotpoints-only pending state.
        const story = seedDeleteStory(
            fetchMock,
            [{ content: '## Ch2\n\nbody', wordCount: 5, generationTimeMs: 1000 }],
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'Ch2',
                plotpoints: ['plot2'],
                expanded: false,
                canReExpand: true
            }
        );

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-delete')).toBeDefined();
        });

        fireEvent.click(screen.getByTestId('chapter-1-delete'));
        await waitFor(() => {
            expect(screen.getByTestId('delete-dialog')).toBeDefined();
        });
        const deleteDialog = screen.getByTestId('delete-dialog');
        expect(screen.getByTestId('delete-dialog-title').textContent).toBe('Delete Chapter 2 — Revision 1 of 1');
        expect(deleteDialog.textContent).toContain(
            "This removes the chapter's only revision — the chapter returns to plotlines only and can be expanded again. This cannot be undone."
        );

        await act(async () => {
            fireEvent.click(screen.getByTestId('delete-confirm'));
        });
        const patchCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(JSON.parse(patchCall![1].body)).toEqual({ deleteChapterIndex: 1, deleteChapterRevisionIndex: 0 });

        // The dialog closes and the chapter renders its plotlines-only state —
        // the expand action (RefreshIcon) remains available for re-expansion.
        await waitFor(() => {
            expect(screen.queryByTestId('delete-dialog')).toBeNull();
        });
        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-pending').textContent).toBe(
                'This chapter has not been expanded yet.'
            );
        });
        expect(screen.queryByTestId('chapter-1-delete')).toBeNull(); // nothing left to delete
        expect(screen.getByTestId('chapter-1-reexpand')).toBeDefined(); // allow expansion
        // The plotlines survive the deletion. The toggle mounted while the
        // chapter was expanded (defaultOpen=false at mount), so it still
        // reads "Show" — useState only seeds the initial value.
        expect(screen.getByTestId('chapter-1-plotpoints-toggle').textContent).toBe('Show Plot Points(1)');
    });

    // ── Remove-entire-chapter flow ─────────────────────────────────────────
    // The "Delete Chapter" pill lives INSIDE the plotpoints area and is only
    // revealed while the plotpoints are SHOWN (the Hide/Show toggle is the
    // reveal mechanism). Confirming PATCHes { removeChapterIndex } — the
    // whole chapter (plotpoints + every revision) disappears and the story
    // shrinks; cancel sends nothing.
    const seedRemoveStory = (fetchMock: any) => {
        let removed = false;
        const chapter1 = {
            chapterNumber: '1',
            chapterIndex: 0,
            title: 'Ch1',
            plotpoints: ['plot1'],
            expanded: true,
            canReExpand: true,
            revisions: [{ content: '## Ch1\n\nbody', wordCount: 5, generationTimeMs: 1000 }]
        };
        const chapter2 = {
            chapterNumber: '2',
            chapterIndex: 1,
            title: 'Ch2',
            plotpoints: ['plot2'],
            expanded: true,
            canReExpand: true,
            revisions: [{ content: '## Ch2\n\nbody', wordCount: 5, generationTimeMs: 900 }]
        };
        const meta = { storyline: 'Seed story', chapterCount: 2, createdAt: '2026-08-01T12:00:00Z' };
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'PATCH') {
                removed = true;
                return Promise.resolve(
                    mockResponse(200, {
                        storyId: 'remove-story-1',
                        removeChapterIndex: 1,
                        title: 'Ch2',
                        chaptersRemaining: 1,
                        message: 'Chapter 1 removed — 1 chapter(s) remain'
                    })
                );
            }
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: removed ? [chapter1] : [chapter1, chapter2],
                        meta: removed ? { ...meta, chapterCount: 1 } : meta
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        return {
            id: 1,
            storyId: 'remove-story-1',
            storyline: 'Seed story',
            title: 'Seed story',
            chapterRequested: 2,
            chapterCompleted: 2,
            createdDate: '2026-08-01T12:00:00.000Z',
            status: 'completed' as const,
            data: { chapters: [chapter1, chapter2], meta },
            isProcessing: false,
            error: '',
            isRemote: true
        };
    };

    it('reveals the delete-chapter control with shown plotpoints and removes the chapter after confirmation', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedRemoveStory(fetchMock);

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        // Chapter 2 auto-expands (latest chapter), so its plotpoints start
        // collapsed — the delete-chapter control must be HIDDEN while the
        // plotpoints are hidden.
        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-plotpoints-toggle')).toBeDefined();
        });
        expect(screen.queryByTestId('chapter-1-plotpoints-delete-chapter')).toBeNull();

        // Showing the plotpoints reveals the delete-chapter control.
        fireEvent.click(screen.getByTestId('chapter-1-plotpoints-toggle'));
        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-plotpoints-delete-chapter')).toBeDefined();
        });

        // Clicking it only opens the confirmation dialog — no PATCH yet
        // (accidental click protection, same as the delete-revision flow).
        fireEvent.click(screen.getByTestId('chapter-1-plotpoints-delete-chapter'));
        await waitFor(() => {
            expect(screen.getByTestId('remove-chapter-dialog')).toBeDefined();
        });
        expect(screen.getByTestId('remove-chapter-dialog-title').textContent).toBe('Remove Chapter 2: Ch2');
        expect(screen.getByTestId('remove-chapter-dialog').textContent).toContain(
            'This permanently removes the chapter — its plotpoints and every revision of its expanded content.'
        );
        expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'PATCH')).toBe(false);

        // Cancel aborts without a request.
        await act(async () => {
            fireEvent.click(screen.getByTestId('remove-chapter-cancel'));
        });
        expect(screen.queryByTestId('remove-chapter-dialog')).toBeNull();
        expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'PATCH')).toBe(false);

        // Reopen and confirm — the single PATCH removes the whole chapter.
        fireEvent.click(screen.getByTestId('chapter-1-plotpoints-delete-chapter'));
        await waitFor(() => {
            expect(screen.getByTestId('remove-chapter-dialog')).toBeDefined();
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('remove-chapter-confirm'));
        });
        const patchCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(patchCall![0]).toBe(`${BASE_URL}/remove-story-1`);
        expect(JSON.parse(patchCall![1].body)).toEqual({ removeChapterIndex: 1 });

        // The refreshed GET collapses the list to the single surviving
        // chapter (renumbered to Chapter 1); no resume button appears — the
        // entry's chapterRequested was pulled down with the story size.
        await waitFor(() => {
            expect(screen.queryByTestId('chapter-1')).toBeNull();
        });
        expect(screen.getByTestId('chapter-0').textContent).toContain('Chapter 1: Ch1');
        expect(screen.queryByTestId('resume-generation-button')).toBeNull();
        expect(screen.queryByTestId('remove-chapter-dialog')).toBeNull();
    });

    // ── Local cache (localStorage) behavior ────────────────────────────────
    // Cache-first contract:
    //   1. Page load renders from the cache INSTANTLY (server check happens
    //      after, in the background).
    //   2. Server sync updates the cache (metadata refresh, new stories) and
    //      RETAINS cache-only stories (missing from the server) in the sidebar.
    //   3. Deleting a cache-only story skips the DELETE call and purges the
    //      local cache completely; deleting a server-known story still sends
    //      the DELETE request.
    //   4. Story data fetched while a story is open is written into the cache.
    //
    // Seed helper: writes one PersistableStoryEntry into the records cache the
    // way scheduleSaveRecordsToStorage would (see src/context/store.tsx).
    const seedRecordsCache = (entries: unknown[]) => {
        localStorage.setItem('storyGenerator:records', JSON.stringify(entries));
    };

    it('hydrates the sidebar and content from the cache instantly, then checks the server', async () => {
        // One cached story with a fully-expanded chapter. The server knows
        // NOTHING about it (list is empty, per-story GET 404s) — the cache is
        // the only source of truth here.
        seedRecordsCache([
            {
                id: 42,
                storyId: 'cache-story-1',
                storyName: 'Cached Tale',
                title: 'Cached Tale',
                storyline: 'A cached storyline',
                chapterRequested: 1,
                chapterCompleted: 1,
                createdDate: '2026-08-10T09:00:00.000Z',
                status: 'completed',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Cached Chapter',
                            plotpoints: ['cached plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Cached Chapter\n\nCached body text', wordCount: 3, generationTimeMs: 500 }]
                        }
                    ],
                    meta: { storyline: 'A cached storyline', chapterCount: 1, createdAt: '2026-08-10T09:00:00Z' }
                },
                isRemote: false
            }
        ]);

        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                // Collection endpoint → empty; per-story GET → 404 (absent).
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(404, { error: 'Story not found' }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // INSTANT (synchronous post-render): the cached story and its chapter
        // content are already visible — no server round-trip happened yet.
        expect(screen.getByTestId('story-tab-cache-story-1').textContent).toContain('Cached Tale');
        expect(screen.getByTestId('chapter-0-content').textContent).toContain('Cached body text');
        expect(screen.queryByTestId('sidebar-empty')).toBeNull();

        // The server check follows the cache render: the collection endpoint
        // is requested in the background.
        await waitFor(() => {
            expect(
                fetchMock.mock.calls.some(
                    ([url, init]: any[]) => (url === BASE_URL || url === `${BASE_URL}/`) && (!init || init.method === 'GET')
                )
            ).toBe(true);
        });
    });

    it('keeps cache-only stories in the sidebar after the server list sync and polls them quietly', async () => {
        seedRecordsCache([
            {
                id: 7,
                storyId: 'local-only-1',
                storyName: 'Local Tale',
                title: 'Local Tale',
                storyline: 'cached storyline',
                chapterRequested: 1,
                chapterCompleted: 1,
                createdDate: '2026-08-09T09:00:00.000Z',
                status: 'completed',
                data: {
                    chapters: [
                        {
                            chapterNumber: '1',
                            chapterIndex: 0,
                            title: 'Cached Chapter',
                            plotpoints: ['cached plot'],
                            expanded: true,
                            canReExpand: true,
                            revisions: [{ content: '## Cached Chapter\n\nCached body text', wordCount: 3, generationTimeMs: 500 }]
                        }
                    ],
                    meta: { storyline: 'cached storyline', chapterCount: 1, createdAt: '2026-08-09T09:00:00Z' }
                },
                isRemote: false
            }
        ]);

        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // The server list does NOT contain local-only-1.
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'server-1', storyName: 'Server Tale', chapterRequested: 2, chapterCompleted: 2, createdDate: '2026-08-11T09:00:00Z', status: 'completed' }
                            ]
                        })
                    );
                }
                if (url === `${BASE_URL}/local-only-1`) {
                    // Cache-only story: absent on the server.
                    return Promise.resolve(mockResponse(404, { error: 'Story not found' }));
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Both the cache-only story and the server-known story are listed.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-local-only-1')).toBeDefined();
            expect(screen.getByTestId('story-tab-server-1')).toBeDefined();
        });
        expect(screen.getByTestId('story-tab-server-1').textContent).toContain('Server Tale');

        // The cached story stays selected (hydration picked it) and its cached
        // chapter content remains visible.
        expect(screen.getByTestId('story-tab-local-only-1').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('chapter-0-content').textContent).toContain('Cached body text');

        // Quiet polling: the cache-only story shows NO processing badge while
        // its (permanently 404-ing) server check repeats in the background.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-local-only-1').textContent).not.toContain('⏳');
        });
    });

    it('deleting a cache-only story purges it completely from the cache without calling the server', async () => {
        seedRecordsCache([
            {
                id: 7,
                storyId: 'local-only-1',
                storyName: 'Local Tale',
                title: 'Local Tale',
                storyline: 'cached storyline',
                chapterRequested: 1,
                chapterCompleted: 1,
                createdDate: '2026-08-09T09:00:00.000Z',
                status: 'completed',
                data: { chapters: [], meta: null },
                isRemote: false
            }
        ]);
        // Per-story expanded-chapters cache must be purged alongside the record.
        localStorage.setItem('storyGenerator:expanded:local-only-1', JSON.stringify([0]));

        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'server-1', storyName: 'Server Tale', chapterRequested: 2, chapterCompleted: 2, createdDate: '2026-08-11T09:00:00Z', status: 'completed' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(404, { error: 'Story not found' }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for the server sync so local-only-1 is confirmed cache-only.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-local-only-1')).toBeDefined();
            expect(screen.getByTestId('story-tab-server-1')).toBeDefined();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId('story-delete-local-only-1'));
        });

        // The tile is gone, the server-known story stays, and NO DELETE
        // request was issued (a cache-only story has no server counterpart).
        await waitFor(() => {
            expect(screen.queryByTestId('story-tab-local-only-1')).toBeNull();
        });
        expect(screen.getByTestId('story-tab-server-1')).toBeDefined();
        expect(fetchMock.mock.calls.filter(([, init]: any[]) => init?.method === 'DELETE')).toEqual([]);

        // The records cache no longer contains the story, the surviving story
        // is still cached, and the per-story expanded key is removed.
        await waitFor(() => {
            const raw = localStorage.getItem('storyGenerator:records') ?? '';
            expect(raw).not.toContain('local-only-1');
            expect(raw).toContain('server-1');
        });
        expect(localStorage.getItem('storyGenerator:expanded:local-only-1')).toBeNull();
    });

    it('deleting a cached story the server already lost (DELETE 404) still purges the cache', async () => {
        // Regression: the story is cached in localStorage but ALREADY GONE from
        // the server, and the client's missingFromServer flag is stale-false
        // (the story was deleted on the server after the last successful list
        // sync). Before the fix the DELETE answered 404 → deleteStory threw →
        // handleDelete only logged → the record survived in the store AND in
        // localStorage → the story resurrected after a page reload.
        seedRecordsCache([
            {
                id: 9,
                storyId: 'gone-server-1',
                storyName: 'Ghost Tale',
                title: 'Ghost Tale',
                storyline: 'cached storyline',
                chapterRequested: 1,
                chapterCompleted: 1,
                createdDate: '2026-08-09T09:00:00.000Z',
                status: 'completed',
                data: { chapters: [], meta: null },
                isRemote: false
            }
        ]);

        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // The list STILL contains the story (the deletion happened
                    // server-side after this sync) → missingFromServer stays
                    // false and the delete path takes the server-DELETE branch.
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'gone-server-1', storyName: 'Ghost Tale', chapterRequested: 1, chapterCompleted: 1, createdDate: '2026-08-09T09:00:00Z', status: 'completed' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            if (init?.method === 'DELETE') {
                // The story directory is already gone server-side.
                return Promise.resolve(mockResponse(404, { error: "Story 'gone-server-1' not found" }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            expect(screen.getByTestId('story-tab-gone-server-1')).toBeDefined();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId('story-delete-gone-server-1'));
        });

        // The DELETE was attempted exactly once (the flag was stale-false)…
        await waitFor(() => {
            const deleteCalls = fetchMock.mock.calls.filter(([, init]: any[]) => init?.method === 'DELETE');
            expect(deleteCalls.length).toBe(1);
            expect(deleteCalls[0][0]).toBe(`${BASE_URL}/gone-server-1`);
        });

        // …and despite the 404 the tile is removed from the sidebar and the
        // records cache no longer contains the story (no resurrection after
        // a reload).
        await waitFor(() => {
            expect(screen.queryByTestId('story-tab-gone-server-1')).toBeNull();
        });
        await waitFor(() => {
            const raw = localStorage.getItem('storyGenerator:records') ?? '';
            expect(raw).not.toContain('gone-server-1');
        });
    });

    it('deleting a server-known story still sends the DELETE request', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'server-1', storyName: 'Server Tale', chapterRequested: 2, chapterCompleted: 2, createdDate: '2026-08-11T09:00:00Z', status: 'completed' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            if (init?.method === 'DELETE') {
                return Promise.resolve(mockResponse(200, { success: true, storyId: 'server-1' }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            expect(screen.getByTestId('story-tab-server-1')).toBeDefined();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId('story-delete-server-1'));
        });

        // Exactly one DELETE, targeting the story's own URL.
        await waitFor(() => {
            const deleteCalls = fetchMock.mock.calls.filter(([, init]: any[]) => init?.method === 'DELETE');
            expect(deleteCalls.length).toBe(1);
            expect(deleteCalls[0][0]).toBe(`${BASE_URL}/server-1`);
        });

        // The tile is removed from the sidebar (and the cache via auto-persist).
        await waitFor(() => {
            expect(screen.queryByTestId('story-tab-server-1')).toBeNull();
        });
    });

    it('writes story data fetched while a story is open into the records cache', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'cache-data-1', chapterRequested: 1, chapterCompleted: 0, createdDate: '2026-08-11T09:00:00Z', status: 'generating' }
                            ]
                        })
                    );
                }
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'Fetched Chapter',
                                plotpoints: ['plot'],
                                expanded: true,
                                canReExpand: true,
                                revisions: [{ content: '## Fetched Chapter\n\nfetched body', wordCount: 2, generationTimeMs: 800 }]
                            }
                        ],
                        meta: { storyline: 'remote storyline', chapterCount: 1, createdAt: '2026-08-11T09:00:00Z' }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // The opened story renders the fetched chapter…
        await waitFor(() => {
            expect(screen.getByTestId('chapter-0-content').textContent).toContain('fetched body');
        });

        // …and the fetched data lands in the localStorage records cache (so the
        // next page load shows it instantly, before any server check).
        await waitFor(() => {
            const raw = localStorage.getItem('storyGenerator:records') ?? '';
            expect(raw).toContain('"storyId":"cache-data-1"');
            expect(raw).toContain('Fetched Chapter');
            expect(raw).toContain('fetched body');
        });
    });

    it('closes the delete confirmation dialog without deleting on cancel', async () => {
        const fetchMock = globalThis.fetch as any;
        const story = seedDeleteStory(
            fetchMock,
            [
                { content: '## Ch2 rev1\n\nbody', wordCount: 5, generationTimeMs: 1000 },
                { content: '## Ch2 rev2\n\nbody', wordCount: 6, generationTimeMs: 900 }
            ],
            {
                chapterNumber: '2',
                chapterIndex: 1,
                title: 'Ch2',
                plotpoints: ['plot2'],
                expanded: true,
                canReExpand: true,
                revisions: [{ content: '## Ch2 rev2\n\nbody', wordCount: 6, generationTimeMs: 900 }]
            }
        );

        render(
            <StoryGeneratorApp
                configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }}
                initialStore={{ records: [story], selected: story }}
            />
        );

        await waitFor(() => {
            expect(screen.getByTestId('chapter-1-delete')).toBeDefined();
        });

        fireEvent.click(screen.getByTestId('chapter-1-delete'));
        await waitFor(() => {
            expect(screen.getByTestId('delete-dialog')).toBeDefined();
        });

        fireEvent.click(screen.getByTestId('delete-cancel'));

        await waitFor(() => {
            expect(screen.queryByTestId('delete-dialog')).toBeNull();
        });
        // No PATCH was issued — both revisions survive and the trash button
        // remains for a future attempt.
        expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'PATCH')).toBe(false);
        expect(screen.getByTestId('chapter-1-delete')).toBeDefined();
        expect((screen.getByTestId('chapter-1-revisions-select') as HTMLSelectElement).options.length).toBe(2);
    });

    // ── Sidebar search (real-time filtering) ────────────────────────────
    // Contract: the sidebar renders a text input (data-testid "sidebar-search")
    // that filters the story tiles as the user types. Matching is
    // case-insensitive substring against the tile's title; the filter never
    // mutates the records (order, selection, cache are untouched), so
    // clearing the query restores the exact previous list.
    it('filters the sidebar story tiles in real time as the user types', async () => {
        const fetchMock = globalThis.fetch as any;
        const dayMs = 86_400_000;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'alpha-story', storyName: 'Space Opera', chapterRequested: 2, chapterCompleted: 0, createdDate: new Date(Date.now() - dayMs).toISOString(), status: 'generating' },
                                { storyId: 'beta-story', storyName: 'Deep Forest', chapterRequested: 2, chapterCompleted: 0, createdDate: new Date(Date.now() - 2 * dayMs).toISOString(), status: 'generating' },
                                { storyId: 'gamma-story', storyName: 'Ocean Deep', chapterRequested: 2, chapterCompleted: 0, createdDate: new Date(Date.now() - 3 * dayMs).toISOString(), status: 'generating' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // All three tiles are listed once the sync lands.
        await waitFor(() => {
            expect(readSidebarOrder()).toEqual(['story-tab-alpha-story', 'story-tab-beta-story', 'story-tab-gamma-story']);
        });

        // The search input exists and starts empty.
        const search = screen.getByTestId('sidebar-search') as HTMLInputElement;
        expect(search.value).toBe('');

        // Case-insensitive partial match: "deep" keeps Deep Forest AND Ocean
        // Deep (substring anywhere in the title) and hides Space Opera.
        fireEvent.change(search, { target: { value: 'DEEP' } });
        expect(readSidebarOrder()).toEqual(['story-tab-beta-story', 'story-tab-gamma-story']);

        // Narrow to one: "space".
        fireEvent.change(search, { target: { value: 'space' } });
        expect(readSidebarOrder()).toEqual(['story-tab-alpha-story']);

        // No match: zero tiles + the search-empty message (distinct from the
        // sidebar-empty state — records still exist).
        fireEvent.change(search, { target: { value: 'volcano' } });
        expect(readSidebarOrder()).toEqual([]);
        expect(screen.getByTestId('sidebar-search-empty')).toBeDefined();
        // The "No stories yet" message must NOT show — stories exist, they are
        // just filtered out.
        expect(screen.queryByTestId('sidebar-empty')).toBeNull();

        // Clearing the query restores the exact full list with its
        // lastActionedAt/createdDate ordering intact.
        fireEvent.change(search, { target: { value: '' } });
        expect(readSidebarOrder()).toEqual(['story-tab-alpha-story', 'story-tab-beta-story', 'story-tab-gamma-story']);
    });

    it('search keeps the selection working and leaves the records cache unfiltered', async () => {
        // The filter is presentation-only: selecting a filtered-in tile works,
        // and the persisted records cache still contains EVERY story (the
        // search never prunes `records`).
        const fetchMock = globalThis.fetch as any;
        const dayMs = 86_400_000;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'sel-a', storyName: 'Alpha Tale', chapterRequested: 1, chapterCompleted: 0, createdDate: new Date(Date.now() - dayMs).toISOString(), status: 'generating' },
                                { storyId: 'sel-b', storyName: 'Beta Tale', chapterRequested: 1, chapterCompleted: 0, createdDate: new Date(Date.now() - 2 * dayMs).toISOString(), status: 'generating' }
                            ]
                        })
                    );
                }
                return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        await waitFor(() => {
            expect(readSidebarOrder()).toEqual(['story-tab-sel-a', 'story-tab-sel-b']);
        });

        // Filter down to Beta Tale only, then select it.
        const search = screen.getByTestId('sidebar-search') as HTMLInputElement;
        fireEvent.change(search, { target: { value: 'beta' } });
        expect(readSidebarOrder()).toEqual(['story-tab-sel-b']);
        fireEvent.click(screen.getByTestId('story-tab-sel-b'));
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-sel-b').getAttribute('aria-pressed')).toBe('true');
        });

        // The records cache (auto-persisted) contains BOTH stories — the
        // filter never reached the store.
        await waitFor(() => {
            const raw = localStorage.getItem('storyGenerator:records') ?? '';
            expect(raw).toContain('"storyId":"sel-a"');
            expect(raw).toContain('"storyId":"sel-b"');
        });
    });

    // ── Static memory (localStorage) timestamp-delta refresh ─────────────
    // Contract: a story viewed once is cached in the browser's static memory.
    // On later loads the cached payload renders instantly; the cached record
    // carries the plotpoint.json mtime it was fetched at (lastUpdatedAt), and
    // the server's list reports the CURRENT mtime (lastUpdatedDate). When
    // they differ (another session rewrote the story), the dashboard
    // re-fetches and replaces the cached content; when they agree, the
    // cached copy is served without a per-story GET.
    it('re-fetches a cached story when the server timestamp moved past the cached fetch', async () => {
        // Seed the static memory the way a previous session left it: the story
        // was viewed at T1 (lastUpdatedAt) with an OLD chapter title.
        const staleStory = {
            id: 21,
            storyId: 'stale-story-1',
            storyName: 'Stale Tale',
            title: 'Stale Tale',
            storyline: 'a storyline',
            chapterRequested: 1,
            chapterCompleted: 1,
            createdDate: '2026-08-10T09:00:00.000Z',
            lastUpdatedAt: '2026-08-10T10:00:00.000Z',
            status: 'completed' as const,
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Old Chapter Title',
                        plotpoints: ['old plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Old Chapter Title\n\nold cached body', wordCount: 3, generationTimeMs: 500 }]
                    }
                ],
                meta: { storyline: 'a storyline', chapterCount: 1, createdAt: '2026-08-10T09:00:00Z', lastUpdatedAt: '2026-08-10T10:00:00.000Z' }
            },
            isRemote: false
        };
        seedRecordsCache([staleStory]);

        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // The server rewrote plotpoint.json at T2 — AFTER the
                    // cached fetch at T1. The cache is provably stale.
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'stale-story-1', storyName: 'Stale Tale', chapterRequested: 1, chapterCompleted: 1, createdDate: '2026-08-10T09:00:00.000Z', lastUpdatedDate: '2026-08-10T11:00:00.000Z', status: 'completed' }
                            ]
                        })
                    );
                }
                // The fresh per-story GET answers the REWRITTEN content.
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [
                            {
                                chapterNumber: '1',
                                chapterIndex: 0,
                                title: 'New Chapter Title',
                                plotpoints: ['new plot'],
                                expanded: true,
                                canReExpand: true,
                                revisions: [{ content: '## New Chapter Title\n\nfresh server body', wordCount: 3, generationTimeMs: 600 }]
                            }
                        ],
                        meta: { storyline: 'a storyline', chapterCount: 1, createdAt: '2026-08-10T09:00:00Z', lastUpdatedAt: '2026-08-10T11:00:00.000Z' }
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Cache-first: the OLD content renders instantly, before any refresh.
        expect(screen.getByTestId('chapter-0-content').textContent).toContain('old cached body');

        // The static memory sees the timestamp delta → one-shot re-fetch →
        // the fresh server content replaces the stale cache.
        await waitFor(() => {
            expect(screen.getByTestId('chapter-0-content').textContent).toContain('fresh server body');
        });

        // The refreshed payload (with its T2 timestamp) lands back in the
        // records cache — the next reload serves the fresh copy instantly.
        await waitFor(() => {
            const raw = localStorage.getItem('storyGenerator:records') ?? '';
            expect(raw).toContain('fresh server body');
            expect(raw).toContain('"lastUpdatedAt":"2026-08-10T11:00:00.000Z"');
            expect(raw).toContain('"dataStale":false');
        });
    });

    it('serves the cached copy without a per-story GET when the timestamps agree', async () => {
        // The mirrored case of the refresh test: the cached fetch timestamp
        // MATCHES the server's current mtime — the cached payload is provably
        // fresh, so no re-fetch happens (static memory is the whole point).
        const freshStory = {
            id: 22,
            storyId: 'fresh-story-1',
            storyName: 'Fresh Tale',
            title: 'Fresh Tale',
            storyline: 'a storyline',
            chapterRequested: 1,
            chapterCompleted: 1,
            createdDate: '2026-08-12T09:00:00.000Z',
            lastUpdatedAt: '2026-08-12T10:00:00.000Z',
            status: 'completed' as const,
            data: {
                chapters: [
                    {
                        chapterNumber: '1',
                        chapterIndex: 0,
                        title: 'Cached Chapter',
                        plotpoints: ['cached plot'],
                        expanded: true,
                        canReExpand: true,
                        revisions: [{ content: '## Cached Chapter\n\ncached body still fresh', wordCount: 4, generationTimeMs: 500 }]
                    }
                ],
                meta: { storyline: 'a storyline', chapterCount: 1, createdAt: '2026-08-12T09:00:00Z', lastUpdatedAt: '2026-08-12T10:00:00.000Z' }
            },
            isRemote: false
        };
        seedRecordsCache([freshStory]);

        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url === BASE_URL || url === `${BASE_URL}/`) {
                    // Timestamps AGREE with the cached record — nothing changed
                    // server-side since the cached fetch.
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'fresh-story-1', storyName: 'Fresh Tale', chapterRequested: 1, chapterCompleted: 1, createdDate: '2026-08-12T09:00:00.000Z', lastUpdatedDate: '2026-08-12T10:00:00.000Z', status: 'completed' }
                            ]
                        })
                    );
                }
                // Any per-story GET on this story would signal a broken
                // staleness check — return obviously-wrong content so the
                // content assertion below fails loudly if it happens.
                return Promise.resolve(
                    mockResponse(200, {
                        chapters: [],
                        meta: null
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // The cached content renders and STAYS — the cache is fresh.
        expect(screen.getByTestId('chapter-0-content').textContent).toContain('cached body still fresh');
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-fresh-story-1')).toBeDefined();
        });
        // Give any would-be refresh a beat to fire, then assert it never did.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(screen.getByTestId('chapter-0-content').textContent).toContain('cached body still fresh');
        const storyGets = fetchMock.mock.calls.filter(
            ([url, init]: any[]) => url === `${BASE_URL}/fresh-story-1` && (!init || init.method === 'GET')
        );
        expect(storyGets).toEqual([]);
    });
});
