// Two-column dashboard layout for the story generator.
//
// Layout:
//   ┌──────────────────────────────────────┐
//   │ [☰] Story Generator                  │  ← header (minimal: toggle + title)
//   ├──────────┬───────────────────────────┤
//   │ Stories  │                           │
//   │ ──────── │     Content area          │
//   │ Story 1  │     (plotlines, chapters) │
//   │ Story 2  │                           │
//   │          │                           │
//   ├──────────┴───────────────────────────┤
//   │ [Storyline input...] [Generate]      │  ← footer
//   └──────────────────────────────────────┘
//
// The sidebar (left column) is collapsible — toggled by a button in the header.
// When collapsed, the main content area fills the full width.
//
// The visual treatment is a modern deep-dark dashboard: a glassy header bar
// with a hairline border + subtle gradient under-glow, an elevated footer with
// soft shadow above, and a translucent sidebar that floats over the background.

import React from 'react';
import { styled, theme } from '../styles';

// Outer container — fills its parent (the dark-themed FullScreen wrapper).
export const DashboardShell = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    overflow: 'hidden'
});

// Header row — pinned at the top, minimal. Contains the sidebar toggle icon
// and an optional title. Flat Design: a solid surface block separated from the
// body by a crisp hairline border (no gradient, blur, or shadow).
export const DashboardHeader = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    flex: '0 0 auto',
    padding: '8px 14px',
    borderBottom: `1px solid ${theme.border}`,
    gap: 10,
    minHeight: 48,
    // Flat solid surface — slightly raised from the dashboard bg via a solid
    // block rather than a gradient. No backdrop blur, no shadow.
    backgroundColor: theme.surface1
});

// Middle row: sidebar + main content, side by side.
export const DashboardBody = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    flex: '1 1 auto',
    overflow: 'hidden'
});

// Sidebar panel — fixed width when open, zero when collapsed.
// CSS transition on width gives a smooth slide animation.
// Width is controlled via inline style (the vendored styled() helper doesn't
// support function values — see src/styles/styled.tsx:15).
//
// Flat Design: a solid surface block + 1px right hairline. No shadow.
const DashboardSidebarPanel = styled('div', {
    flex: '0 0 auto',
    overflow: 'hidden',
    transition: `width ${theme.transitionSlow}, min-width ${theme.transitionSlow}, max-width ${theme.transitionSlow}, border-color ${theme.transitionSlow}`,
    backgroundColor: theme.surface1,
    boxSizing: 'border-box' as const
});

// Main content column — fills remaining width after sidebar.
// Uses position:relative so the overlay can be positioned absolutely over it.
export const DashboardContent = styled('div', {
    flex: '1 1 auto',
    overflowY: 'auto',
    overflowX: 'hidden',
    position: 'relative' as const
});

// Semi-transparent overlay that covers the content area when the sidebar is open.
// Clicking it collapses the sidebar — standard mobile drawer pattern.
// Only visible when the sidebar is open; sits inside DashboardContent via
// absolute positioning so it doesn't affect the flex layout.
//
// Flat: a solid translucent black — no blur (blur reads as glass, not flat).
const SidebarOverlay = styled('div', {
    position: 'absolute' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    zIndex: 10,
    cursor: 'pointer',
    animation: 'sg-fade-in 160ms ease both'
});

// Footer row — pinned at the bottom. Used by SectionStoryInput.
// Flat Design: solid surface block + top hairline border separates it from the
// content above. No gradient, no blur, no upward shadow.
export const DashboardFooter = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 0 auto',
    padding: 14,
    borderTop: `1px solid ${theme.border}`,
    gap: 8,
    backgroundColor: theme.surface1
});

// Composed dashboard. Accepts slots for header controls, sidebar content,
// main content, and footer.
export type StoryGeneratorDashboardProps = {
    headerControls: React.ReactNode;
    sidebar: React.ReactNode;
    content: React.ReactNode;
    footer: React.ReactNode;
    sidebarOpen: boolean;
    onOverlayClick?: () => void;
};

export const StoryGeneratorDashboard: React.FC<StoryGeneratorDashboardProps> = React.memo(
    ({ headerControls, sidebar, content, footer, sidebarOpen, onOverlayClick }) => {
        // Track whether the viewport is mobile (<768px). The overlay only appears
        // on mobile where the sidebar overlaps content — on desktop the sidebar
        // takes fixed space and the user closes it via the toggle button.
        const [isMobile, setIsMobile] = React.useState(() => {
            if (typeof window !== 'undefined' && window.matchMedia) {
                return window.matchMedia('(max-width: 767px)').matches;
            }
            return false;
        });

        React.useEffect(() => {
            if (typeof window === 'undefined' || !window.matchMedia) return;
            const mql = window.matchMedia('(max-width: 767px)');
            const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
            mql.addEventListener('change', handler);
            return () => mql.removeEventListener('change', handler);
        }, []);

        return (
            <DashboardShell>
                <DashboardHeader>
                    {headerControls}
                </DashboardHeader>
                <DashboardBody>
                    {/* Sidebar width is dynamic — controlled via inline style since
                        the vendored styled() helper doesn't support function values.
                        Width 200 when open / 0 when closed is part of the public test
                        contract (App.test.tsx:64). */}
                    <DashboardSidebarPanel
                        data-testid="sidebar-panel"
                        className="sg-scroll"
                        style={{
                            width: sidebarOpen ? 200 : 0,
                            minWidth: sidebarOpen ? 200 : 0,
                            maxWidth: sidebarOpen ? 200 : 0,
                            borderRight: sidebarOpen ? `1px solid ${theme.border}` : 'none'
                        }}
                    >
                        {sidebar}
                    </DashboardSidebarPanel>
                    <DashboardContent>
                        {/* Overlay covers the content area when the sidebar is open
                            on mobile — clicking it collapses the sidebar (standard
                            drawer pattern). On desktop the sidebar takes fixed space
                            and no overlay is needed. */}
                        {sidebarOpen && isMobile && onOverlayClick && (
                            <SidebarOverlay
                                data-testid="sidebar-overlay"
                                onClick={onOverlayClick}
                            />
                        )}
                        {content}
                    </DashboardContent>
                </DashboardBody>
                <DashboardFooter>{footer}</DashboardFooter>
            </DashboardShell>
        );
    }
);
