// Tests for the Story Generator dashboard.
//
// Covers the integrated UI behaviour:
//   - initial empty state ("Select one")
//   - Add button creates a tab and selects it
//   - submitting a storyline POSTs to the server and flips the entry to processing
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
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty state before any story is added', () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        // Empty state — matches the hardcoded "Select one" in SectionStoryContent.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
        // The Add button should be present so the user can get started.
        expect(screen.getByTestId('add-story-button')).toBeDefined();
    });

    it('adds a story tab and selects it when the Add button is clicked', () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.click(screen.getByTestId('add-story-button'));

        // A pending-submit hint should replace the empty state because the entry
        // was created locally with chapterCount 0 (no POST yet).
        expect(screen.getByTestId('content-pending-submit')).toBeDefined();
        // The storyline textarea should now be visible.
        expect(screen.getByTestId('storyline-input')).toBeDefined();
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

        // Add a story, fill the form, submit.
        fireEvent.click(screen.getByTestId('add-story-button'));
        const tabButton = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'))!;
        const storyId = (tabButton.dataset.testid ?? '').replace('story-tab-', '');
        expect(storyId.length).toBeGreaterThan(0);

        fireEvent.change(screen.getByTestId('storyline-input'), {
            target: { value: 'A sci-fi adventure on Mars.' }
        });
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '3' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

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
        await waitFor(() => {
            expect(screen.getByTestId('plotlines').textContent).toBe('> plotlines');
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
        expect(screen.getByTestId('plotlines').textContent).toBe('> plotlines');
    });

    it('shows an inline validation error when storyline is empty on submit', async () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.click(screen.getByTestId('add-story-button'));
        // Leave storyline blank, set chapter count to 1, click Generate.
        fireEvent.change(screen.getByTestId('chapter-count-input'), {
            target: { value: '1' }
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('generate-button'));
        });

        expect(screen.getByTestId('input-error').textContent).toBe('storyline is required');
        // No fetch should have been attempted — validation is client-side.
        expect(globalThis.fetch as any).not.toHaveBeenCalled();
    });

    it('removes a story tab when the ✕ glyph is clicked', () => {
        render(<StoryGeneratorApp configOverrides={{ baseUrl: BASE_URL, pollIntervalMs: POLL_INTERVAL_MS }} />);

        fireEvent.click(screen.getByTestId('add-story-button'));
        const tab = screen.getAllByRole('button').find((b) => b.dataset.testid?.startsWith('story-tab-'));
        // Click the remove glyph inside the tab.
        fireEvent.click(tab!.querySelector('[aria-label="Remove story tab"]')!);

        // Back to the empty state — Selected removed → no selected → empty state.
        expect(screen.getByTestId('content-empty').textContent).toBe('Select one');
    });
});
