// Tests for the Collapsible component (src/components/Collapsible.tsx).
//
// Covers:
//   - defaultOpen renders children (or not) appropriately
//   - clicking the toggle button flips open/closed state
//   - aria-expanded reflects current state
//   - data-testid is propagated to root, toggle, and body

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Collapsible } from './Collapsible';

describe('Collapsible', () => {
    it('renders children when defaultOpen is true', () => {
        render(
            <Collapsible title="Plotlines" defaultOpen={true} data-testid="plot">
                <p>body content</p>
            </Collapsible>
        );

        // Body present, aria-expanded is true on the toggle button.
        expect(screen.getByText('body content')).toBeDefined();
        expect(screen.getByTestId('plot-body')).toBeDefined();
        expect(screen.getByTestId('plot-toggle').getAttribute('aria-expanded')).toBe('true');
    });

    it('does not render children when defaultOpen is false', () => {
        render(
            <Collapsible title="Chapter 1" defaultOpen={false} data-testid="ch0">
                <p>hidden body</p>
            </Collapsible>
        );

        // When collapsed, the body region is not rendered at all.
        expect(screen.queryByTestId('ch0-body')).toBeNull();
        expect(screen.queryByText('hidden body')).toBeNull();
        // Toggle button still rendered and reports expanded=false.
        expect(screen.getByTestId('ch0-toggle').getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles open -> closed -> open on successive clicks', () => {
        render(
            <Collapsible title="Chapters" defaultOpen={true} data-testid="chapters">
                <p>three little chapters</p>
            </Collapsible>
        );

        const toggle = screen.getByTestId('chapters-toggle');

        // Initially open.
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('chapters-body')).toBeDefined();

        // Click 1: close.
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('chapters-body')).toBeNull();

        // Click 2: reopen.
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('chapters-body')).toBeDefined();
    });

    it('renders headerExtra in the header (visible even when body collapsed)', () => {
        render(
            <Collapsible
                title="Chapters"
                defaultOpen={false}
                data-testid="chapters"
                headerExtra={<span data-testid="count-badge">3 chapters</span>}
            >
                <p>body</p>
            </Collapsible>
        );

        // Badge lives in the header, so it's visible regardless of collapsed state.
        expect(screen.getByTestId('count-badge').textContent).toBe('3 chapters');
        // And body remains collapsed.
        expect(screen.queryByTestId('chapters-body')).toBeNull();
    });
});
