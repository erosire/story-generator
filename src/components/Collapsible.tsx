// Reusable collapsible section.
//
// Renders a clickable header (with a rotating arrow glyph) and conditionally
// renders its children. Used by SectionStoryContent to wrap the Plotlines block
// and each Chapter card so users can collapse/expand them individually.
//
// State:
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
//
// Visual: the chevron rotates 90deg → 270deg (pointing down when open) with a
// slow cubic-bezier for a tactile feel. The header gets a hover tint via the
// `sg-collapse-header` class hook (see src/styles/global.ts).

import React from 'react';
import { styled, theme } from '../styles';

// Header button — full width, left aligned. The arrow glyph sits to the left
// of the heading text and rotates when open via a CSS transform.
const HeaderButton = styled('button', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 8px',
    background: 'transparent',
    border: 'none',
    color: theme.text,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    borderRadius: theme.radiusSm,
    transition: `background-color ${theme.transition}`
});

// The arrow svg rendered inside the header. We rotate it conditionally based
// on the open state. Inline svg keeps the package icon-free (matches the
// dashboard convention of inline glyphs only). Uses a cubic-bezier curve to
// feel springy rather than mechanical.
const ArrowIcon: React.FC<{ open: boolean }> = ({ open }) => (
    <svg
        width={12}
        height={12}
        viewBox="0 0 10 10"
        aria-hidden="true"
        style={{
            // Closed (default): points right (0deg). Open: rotates to point
            // down (90deg). The two-step rotate keeps things simple and reads
            // intuitively as "expand downwards".
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: `transform ${theme.transitionSlow}`,
            flex: '0 0 12px',
            color: theme.textMuted
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
                className="sg-collapse-header"
            >
                <ArrowIcon open={open} />
                <span style={{ flex: '1 1 auto' }}>{title}</span>
                {headerExtra}
            </HeaderButton>
            {/* Body — conditionally rendered (not just visually hidden) so
                collapsed content contributes nothing to scroll height and
                screen readers skip it entirely. The fade-in animation gives a
                soft entrance when expanded. */}
            {open && (
                <div
                    role="region"
                    data-testid={testId ? `${testId}-body` : undefined}
                    className="sg-fade-in"
                >
                    {children}
                </div>
            )}
        </div>
    );
};
