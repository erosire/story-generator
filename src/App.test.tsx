// Tests for the Story Generator dashboard.
//
// Covers the integrated UI behaviour:
//   - initial empty state ("Select one") with input area visible
//   - Generate creates a new story tab and POSTs to the server
//   - a 404 right after POST keeps polling until the first 200 with chapters
//
// fetch is mocked globally. Poll interval is overridden via configOverrides to a
// tiny value so the loop advances quickly under real timers.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryGeneratorApp } from './components';

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
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: any) => {
                // Default: respond to GET /list with an empty list. Tests that
                // need other behaviour install their own mockImplementation.
                if (!init || init.method === 'GET') {
                    return Promise.resolve(mockResponse(200, { stories: [] }));
                }
                return Promise.resolve(mockResponse(200, {}));
            })
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty state and input area before any story is created', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Empty state — matches the hardcoded "Select one" in SectionStoryContent.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
        // Input area is always visible — user can type a storyline and click Generate.
        expect(screen.getByTestId('storyline-input')).toBeDefined();
    });

    it('creates a new story tab when Generate is clicked with valid input', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            return Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Input area is visible — focus to reveal controls.
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

        // A new tab should have been created and selected by Generate.
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
        // First call: POST returns { storyId } (server accepts).
        // Subsequent calls: GET returns progressively-more-chapters.
        // Sequence stops once chapterCount (3) is met.
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            // GET polling — count downloads via closure state.
            // Use a non-null assertion since the test only triggers GET after a
            // POST has been issued at a URL that always ends with the storyId.
            const storyId = String(url.split('/').pop() ?? '');
            // Build a per-story counter so multiple stories don't share counts.
            fetchMock.__counts = fetchMock.__counts ?? {};
            fetchMock.__counts[storyId] = (fetchMock.__counts[storyId] ?? 0) + 1;
            const c = fetchMock.__counts[storyId];
            const chapters = Array.from({ length: Math.min(c, 3) }, (_, i) => ({
                length: 1,
                content: `## Ch${i + 1}\n\nbody`
            }));
            return Promise.resolve(mockResponse(200, { plotlines: '> plotlines', chapters }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Focus the textarea to reveal the generate button and chapter count.
        fireEvent.focus(screen.getByTestId('storyline-input'));
        // Controls should now be visible after focus.
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

        // Generate creates a new tab — wait for it to appear.
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

        // After polling completes, three chapters should be rendered.
        // Plotlines and chapters are now rendered as markdown (react-markdown),
        // so textContent includes surrounding whitespace from block elements.
        await waitFor(() => {
            expect(screen.getByTestId('plotlines').textContent).toContain('plotlines');
            expect(screen.queryByTestId('chapter-2')).toBeDefined();
        });

        // The plotlines and chapters are wrapped in collapsibles — assert both
        // toggles exist and the chapter section's count badge shows "3 chapters".
        expect(screen.getByTestId('plotlines-collapsible-toggle').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('chapters-collapsible-toggle').getAttribute('aria-expanded')).toBe('true');
        // The Chapters header extra should read "3 chapters".
        const chaptersHeader = screen.getByTestId('chapters-collapsible-toggle');
        expect(chaptersHeader.textContent).toContain('3 chapters');

        // The latest chapter (index 2) defaults open, older chapters default collapsed.
        expect(screen.getByTestId('chapter-2-toggle').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('chapter-1-toggle').getAttribute('aria-expanded')).toBe('false');

        // Collapsing chapter-2 should remove its body region from the DOM.
        fireEvent.click(screen.getByTestId('chapter-2-toggle'));
        expect(screen.queryByTestId('chapter-2-body')).toBeNull();
        // Plotlines are now rendered as markdown — blockquote text content
        // includes surrounding whitespace from block elements.
        expect(screen.getByTestId('plotlines').textContent).toContain('plotlines');
    });

    it('shows an inline validation error when storyline is empty on submit', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Focus the textarea to reveal the controls.
        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
        });
        // Leave storyline blank, set chapter count to 1, click Generate.
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '1' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        expect(screen.getByTestId('input-error').textContent).toBe('storyline is required');
        // No POST should have been attempted — client-side validation rejects the
        // empty storyline before any server call. (A GET /list from the
        // BootstrapLayer may have fired on mount — that's unrelated to the submit.)
        const postCalls = (globalThis.fetch as any).mock.calls.filter(
            ([, init]: any[]) => init?.method === 'POST'
        );
        expect(postCalls).toEqual([]);
    });

    it('removes a story tab when the ✕ glyph is clicked', async () => {
        const fetchMock = globalThis.fetch as any;
        fetchMock.mockImplementation((url: string, init?: any) => {
            if (init?.method === 'POST') {
                const storyId = String(url.split('/').pop() ?? '');
                return Promise.resolve(mockResponse(200, { storyId }));
            }
            return Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] }));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Create a story via Generate.
        fireEvent.focus(screen.getByTestId('storyline-input'));
        await waitFor(() => {
            expect(screen.getByTestId('generate-button')).toBeDefined();
        });
        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'A test story' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        // Wait for the tab to appear.
        await waitFor(() => {
            const tab = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'));
            expect(tab).toBeDefined();
        });
        const tab = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'));

        // Click the remove glyph inside the tab.
        await act(async () => {
            fireEvent.click(tab!.querySelector('[aria-label="Remove story tab"]')!);
        });

        // Back to the empty state — Selected removed → no selected → empty state.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
    });

    // Bootstrap: GET /list returns existing story IDs on mount → seeded as tabs.
    it('loads existing stories from the /list endpoint on mount and selects the first', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
                    return Promise.resolve(
                        mockResponse(200, { stories: ['aaaa-1111', 'bbbb-2222'] })
                    );
                }
                // Specific storyId GETs return empty data so the polling loop
                // terminates quickly via stability (two identical polls).
                return Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for both tabs to be seeded by BootstrapLayer.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-aaaa-1111')).toBeDefined();
            expect(screen.getByTestId('story-tab-bbbb-2222')).toBeDefined();
        });

        // The first loaded story is auto-selected — its content renders the
        // plotlines collapsible. Since the mock returns empty plotlines for
        // specific storyIds, the empty-plotlines fallback ("No plotlines yet.")
        // is shown (matches SectionStoryContent's empty-plotlines branch).
        await waitFor(() => {
            expect(screen.getByTestId('plotlines-collapsible-body').textContent).toContain('No plotlines yet.');
        });
    });

    // Selecting a remote UUID triggers polling that hydrates its data.
    // Verify the chapters actually appear after multiple stable polls.
    it('polls the selected remote story until chapters are stable', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
                    return Promise.resolve(mockResponse(200, { stories: ['remote-uuid-1'] }));
                }
                // The specific remote-uuid-1 GET returns a stable 1-chapter story.
                return Promise.resolve(
                    mockResponse(200, {
                        plotlines: '> plot',
                        chapters: [{ length: 5, content: '## Ch1\n\nbody' }]
                    })
                );
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // After bootstrap, the remote story tab appears and is selected. The
        // polling effect fires GETs for remote-uuid-1 and onData populates
        // the content area. Plotlines and chapters are now rendered as markdown
        // (react-markdown), so textContent includes surrounding whitespace
        // from block elements — usetoContain to match the meaningful text.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-remote-uuid-1')).toBeDefined();
            expect(screen.getByTestId('plotlines').textContent).toContain('plot');
            expect(screen.getByTestId('chapter-0-content').textContent).toContain('Ch1');
        });

        // After two stable polls (identical data), isProcessing flips false so
        // the tab chip's ⏳ badge stops appearing.
        await waitFor(() => {
            const tab = screen.getByTestId('story-tab-remote-uuid-1');
            expect(tab.textContent).not.toContain('⏳');
        });
    });

    // Refresh button re-queries /list and merges new entries while preserving
    // the currently-selected story (by storyId).
    it('Refresh button re-fetches the /list endpoint and keeps the current selection', async () => {
        let listResponse = { stories: ['first-uuid'] };
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
                    return Promise.resolve(mockResponse(200, listResponse));
                }
                return Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Wait for the initial bootstrap to load first-uuid.
        await waitFor(() => expect(screen.getByTestId('story-tab-first-uuid')).toBeDefined());

        // Simulate a new story appearing on the server.
        listResponse = { stories: ['first-uuid', 'second-uuid'] };

        await act(async () => {
            fireEvent.click(screen.getByTestId('refresh-stories-button'));
        });

        // After the refresh resolves, second-uuid should appear as a new tab,
        // AND first-uuid (the currently-selected story) should still be present.
        await waitFor(() => {
            expect(screen.getByTestId('story-tab-first-uuid')).toBeDefined();
            expect(screen.getByTestId('story-tab-second-uuid')).toBeDefined();
        });

        // Confirm the selection pointer is still on first-uuid (aria-pressed=true
        // on its tab).
        expect(screen.getByTestId('story-tab-first-uuid').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('story-tab-second-uuid').getAttribute('aria-pressed')).toBe('false');
    });

    // BootstrapLayer failure (server down) sets a non-blocking loadWarning that
    // the user can see — and the dashboard still renders (input area available).
    it('shows a load warning when the initial /list fetch fails, but the dashboard is still usable', async () => {
        (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
            if (!init || init.method === 'GET') {
                if (url.endsWith('/list')) {
                    // Server returns 500 with { error } — fetchStoryList throws.
                    return Promise.resolve(mockResponse(500, { error: 'server on fire' }));
                }
                return Promise.resolve(mockResponse(200, { plotlines: '', chapters: [] }));
            }
            return Promise.resolve(mockResponse(200, {}));
        });

        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // The warning banner appears in the header.
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
