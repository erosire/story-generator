// Reusable collapsible section.
//
// Renders a clickable header (with a rotating arrow glyph) and conditionally
// renders its children. Used by SectionStoryContent to wrap the Plotlines block
// and each Chapter card so users can collapse/expand them individually.
//
//State:
//   - `defaultOpen` controls the initial open state (uncontrolled). We use
//     uncontrolled state so re-renders of the parent (e.g. on every poll that
//     updates the chapter list) don't reset the user's collapse choices.
//   - The header is a <button> for keyboard accessibility (Enter/Space toggles).
//
// Accessibility:
//   - The header button has `aria-expanded` reflecting the current state.
//   - The region below uses `role="region"` and `aria-labelledby` is omitted in
//     favour of the heading text being inside the button (screen readers read
//     the button label, then announce the region presence).

import React from 'react';
import { styled } from '../styles';

// Header button — full width, left aligned. The arrow glyph sits to the right
// of the heading text and rotates 90deg when open via a CSS transform.
const HeaderButton = styled('button', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 4px',
    background: 'transparent',
    border: 'none',
    color: '#e0e0e0',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    borderRadius: 4
});

// The arrow svg rendered inside the header. We rotate it conditionally based
// on the open state. Inline svg keeps the package icon-free (matches the
// lightning-agent dashboard convention of inline glyphs only).
const ArrowIcon: React.FC<{ open: boolean }> = ({ open }) => (
    <svg
        width={10}
        height={10}
        viewBox="0 0 10 10"
        aria-hidden="true"
        style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease',
            flex: '0 0 10px'
        }}
    >
        {/* Right-pointing triangle that rotates to point down when open. */}
        <path d="M2 1 L8 5 L2 9 Z" fill="currentColor" />
    </svg>
);

export type CollapsibleProps = {
    // The heading label (rendered inside the toggle button).
    title: React.ReactNode;
    // The body to expand/collapse.
    children: React.ReactNode;
    // Initial open state — uncontrolled. Defaults to true so freshly-arrived
    // chapters are visible by default (matches lightning-agent OutputMarkdown's
    // "last message expanded" behaviour in SectionContentDisplay.tsx:92).
    defaultOpen?: boolean;
    // Optional extra content rendered on the right side of the header (e.g. the
    // word-count badge on chapter cards). Hidden when collapsed is fine because
    // it's part of the header, not the body.
    headerExtra?: React.ReactNode;
    // Optional className/-testid pass-throughs for testing.
    'data-testid'?: string;
};

export const Collapsible: React.FC<CollapsibleProps> = ({
    title,
    children,
    defaultOpen = true,
    headerExtra,
    ...rest
}) => {
    // Uncontrolled open state — survives parent re-renders without resetting.
    const [open, setOpen] = React.useState(defaultOpen);
    const testId = rest['data-testid'];

    return (
        <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column' }}>
            <HeaderButton
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                data-testid={testId ? `${testId}-toggle` : undefined}
            >
                <ArrowIcon open={open} />
                <span style={{ flex: '1 1 auto' }}>{title}</span>
                {headerExtra}
            </HeaderButton>
            {/* Body — conditionally rendered (not just visually hidden) so
                collapsed content contributes nothing to scroll height and
                screen readers skip it entirely. */}
            {open && (
                <div role="region" data-testid={testId ? `${testId}-body` : undefined}>
                    {children}
                </div>
            )}
        </div>
    );
};
