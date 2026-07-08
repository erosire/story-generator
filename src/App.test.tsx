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
    // Default fetch mock: GET /list returns an empty story list. Individual
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
        await waitFor(() => {
            const postCall = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
            expect(postCall).toBeDefined();
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A test story',
                chapterCount: 3
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
                content: `## Chapter ${i + 1}\n\nbody`,
                length: 1,
                generationTimeMs: 1000
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
            expect(JSON.parse(postCall![1].body)).toEqual({
                storyline: 'A sci-fi adventure on Mars.',
                chapterCount: 3
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

    // Bootstrap: GET /list returns existing story metadata on mount → seeded as sidebar items.
    it('loads existing stories from the /list endpoint on mount and selects the first', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'aaaa-1111', chapterCount: 3, createdAt: '2026-07-03T12:00:00Z' },
                                { storyId: 'bbbb-2222', chapterCount: 5, createdAt: '2026-07-02T10:00:00Z' }
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
                if (url.endsWith('/list')) {
                    return Promise.resolve(
                        mockResponse(200, {
                            stories: [
                                { storyId: 'remote-uuid-1', chapterCount: 1, createdAt: '2026-07-03T12:00:00Z' }
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
                                content: '## Ch1\n\nbody',
                                length: 5,
                                generationTimeMs: 1000
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
        let listResponse = { stories: [{ storyId: 'first-uuid', chapterCount: 2, createdAt: '2026-07-03T12:00:00Z' }] };
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
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
                { storyId: 'first-uuid', chapterCount: 2, createdAt: '2026-07-03T12:00:00Z' },
                { storyId: 'second-uuid', chapterCount: 4, createdAt: '2026-07-03T13:00:00Z' }
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
    it('shows a load warning when the initial /list fetch fails, but the dashboard is still usable', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
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
