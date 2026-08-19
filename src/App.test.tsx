// Tests for the Story Generator dashboard.
//
// Covers the integrated UI behaviour:
//   - initial empty state ("Select one") with input area visible
//   - sidebar lists stories and can be toggled
//   - Generate creates a new story and POSTs to the server
//   - a 404 right after POST keeps polling until the first 200 with chapters
//   - auto-refresh picks up new stories from the server
//
// fetch is mocked globally. Poll interval is overridden via configOverrides to a
// tiny value so the loop advances quickly under real timers.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryGeneratorApp } from './components';
import { cancelPendingStorageWrites } from './context/store';

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
        // (localStorage cleared in beforeEach → DEFAULT_CLIENT_ID 'Qwen3_8').
        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        expect(clientSelect).toBeDefined();
        expect(clientSelect.value).toBe('Qwen3_8');
        // Theming contract: the native select opts into the dark color scheme
        // (inline, so the UA paints the control + popup dark instead of the
        // default grey-on-white) and carries the sg-select/sg-input class
        // hooks that drive the flat hover/focus treatment (styles/global.ts).
        expect(clientSelect.className).toContain('sg-select');
        expect(clientSelect.className).toContain('sg-input');
        expect(clientSelect.style.colorScheme).toBe('dark');
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
                return Promise.resolve(mockResponse(200, { clients: ['Nvidia', 'Modal', 'Qwen3_8'] }));
            }
            return Promise.resolve(mockResponse(200, { chapters: [], meta: null }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        const clientSelect = screen.getByTestId('client-select') as HTMLSelectElement;
        // Default selection is the package default client id.
        expect(clientSelect.value).toBe('Qwen3_8');

        // The options fetch resolves and replaces the options list.
        await waitFor(() => {
            const options = Array.from(clientSelect.querySelectorAll('option')).map((o) => o.value);
            expect(options).toEqual(['Nvidia', 'Modal', 'Qwen3_8']);
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
        const ALL_CLIENTS = ['Nvidia', 'Modal', 'KIMIK3', 'Qwen3_8', 'Makora', 'Router', 'Telnyx'];
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
        expect(readOptions()).toEqual(['Qwen3_8']);

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
        const ALL_CLIENTS = ['Nvidia', 'Modal', 'KIMIK3', 'Qwen3_8', 'Makora', 'Router', 'Telnyx'];
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
        expect(clientSelect.value).toBe('Qwen3_8');

        // The StrictMode remount's own fetch must complete and populate the
        // dropdown with every client — not just the first (disposed) attempt,
        // which would leave the options pinned to Qwen3_8.
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
        expect(clientSelect.value).toBe('Qwen3_8'); // no stored choice yet → default
        // Default fetch mock answers the clients URL with 200 { stories: [] } →
        // fetchClientOptions degrades to [] (no clients key), so the option
        // list stays pinned to the selected id and 'Modal' is not selectable.
        // Simulate the server advertising Modal to make the choice meaningful.
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (url === `${BASE_URL.replace(/\/generations$/, '/clients')}`) {
                return Promise.resolve(mockResponse(200, { clients: ['Qwen3_8', 'Modal'] }));
            }
            return Promise.resolve(mockResponse(200, { stories: [] }));
        });
        // Re-mount triggers a fresh options fetch with the new mock.
        view.unmount();
        const view2 = render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);
        const select2 = screen.getByTestId('client-select') as HTMLSelectElement;
        await waitFor(() => {
            const options = Array.from(select2.querySelectorAll('option')).map((o) => o.value);
            expect(options).toEqual(['Qwen3_8', 'Modal']);
        });

        // Choose Modal — the store's effect persists it to localStorage.
        fireEvent.change(select2, { target: { value: 'Modal' } });
        await waitFor(() => {
            expect(localStorage.getItem('storyGenerator:clientId')).toBe('Modal');
        });
        view2.unmount();

        // A brand-new mount (page reload) restores the persisted choice.
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);
        const select3 = screen.getByTestId('client-select') as HTMLSelectElement;
        // The provider reads localStorage before any options fetch resolves,
        // so the FIRST render already reflects the user's previous choice.
        expect(select3.value).toBe('Modal');
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
        // (store.config.clientId, default 'Qwen3_8' — localStorage is cleared
        // in beforeEach so the package default always applies in tests).
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A test story',
                chapterCount: 3,
                clientId: 'Qwen3_8'
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
            // in beforeEach → DEFAULT_CLIENT_ID = 'Qwen3_8').
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A sci-fi adventure on Mars.',
                chapterCount: 3,
                clientId: 'Qwen3_8'
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
});
