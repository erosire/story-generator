// Reusable collapsible section — built on the Material UI ButtonBase.
//
// Renders a clickable header (with a rotating Material chevron) and
// conditionally renders its children. Used by SectionStoryContent to wrap the
// Plotlines block and each Chapter card so users can collapse/expand them
// individually.
//
// State:
//   - `defaultOpen` controls the initial open state (uncontrolled). We use
//     uncontrolled state so re-renders of the parent (e.g. on every poll that
//     updates the chapter list) don't reset the user's collapse choices.
//   - The header is a MUI ButtonBase for keyboard accessibility (Enter/Space
//     toggles) and consistent focus/press semantics.
//
// Accessibility:
//   - The header button has `aria-expanded` reflecting the current state.
//   - The region below uses `role="region"` and `aria-labelledby` is omitted in
//     favour of the heading text being inside the button (screen readers read
//     the button label, then announce the region presence).
//
// Body rendering: the body is UNMOUNTED when collapsed (not just visually
// hidden) — collapsed content contributes nothing to scroll height and screen
// readers skip it entirely. This is also the test contract (collapsed →
// queryByTestId(body) is null SYNCHRONOUSLY, which an MUI <Collapse> exit
// transition cannot satisfy), so the entrance animation stays the CSS
// .sg-fade-in keyframe (styles/global.ts) instead of MUI's Collapse.
//
// Visual: the chevron rotates -90deg (pointing right, closed) → 0deg (pointing
// down, open). The header gets a hover tint via the `sg-collapse-header`
// class hook (see src/styles/global.ts).

import React from 'react';
import { ButtonBase } from '@mui/material';
// Material UI chevron — the collapse affordance glyph.
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { theme } from '../styles';

// Header button — full width, left aligned. The chevron glyph sits to the
// left of the heading text and rotates when open. ButtonBase's default
// centering is overridden to flex-start so the label hugs the left edge.
const HeaderButton: React.FC<React.ComponentProps<typeof ButtonBase>> = ({ sx, ...rest }) => (
    <ButtonBase
        type="button"
        {...rest}
        sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '10px',
            width: '100%',
            padding: '8px 8px',
            background: 'transparent',
            border: 'none',
            color: theme.text,
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            borderRadius: `${theme.radiusSm}px`,
            transition: `background-color ${theme.transition}`,
            ...sx
        }}
    />
);

// The Material chevron rendered inside the header. We rotate it conditionally
// based on the open state. ExpandMoreIcon points DOWN by default, so the
// closed state rotates it -90deg to point RIGHT; open keeps the natural
// downward orientation.
const ArrowIcon: React.FC<{ open: boolean }> = ({ open }) => (
    <ExpandMoreIcon
        aria-hidden="true"
        style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: `transform ${theme.transitionSlow}`,
            flex: '0 0 12px',
            fontSize: 12,
            color: theme.textMuted,
            display: 'block'
        }}
    />
);

export type CollapsibleProps = {
    // The heading label (rendered inside the toggle button).
    title: React.ReactNode;
    // The body to expand/collapse.
    children: React.ReactNode;
    // Initial open state — uncontrolled. Defaults to false so chapters start
    // collapsed when a story is selected. Survives parent re-renders without
    // resetting.
    defaultOpen?: boolean;
    // Controlled open state. When provided, the parent owns the toggle state.
    open?: boolean;
    // Callback fired when the toggle is clicked. Receives the new open value.
    // Required when `open` is provided (controlled mode).
    onToggle?: (open: boolean) => void;
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
    defaultOpen = false,
    open: controlledOpen,
    onToggle,
    headerExtra,
    ...rest
}) => {
    // Internal state for uncontrolled mode. When `controlledOpen` is provided,
    // this is ignored and the parent owns the open state.
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
    const testId = rest['data-testid'];

    const handleToggle = () => {
        const next = !isOpen;
        if (controlledOpen === undefined) {
            setInternalOpen(next);
        }
        onToggle?.(next);
    };

    return (
        <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column' }}>
            <HeaderButton
                aria-expanded={isOpen}
                onClick={handleToggle}
                data-testid={testId ? `${testId}-toggle` : undefined}
                className="sg-collapse-header"
            >
                <ArrowIcon open={isOpen} />
                <span style={{ flex: '1 1 auto' }}>{title}</span>
                {headerExtra}
            </HeaderButton>
            {/* Body — unmounted when collapsed (see the header note for why
                this must be synchronous, not a transition). The fade-in
                animation gives a soft entrance when expanded. */}
            {isOpen && (
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
