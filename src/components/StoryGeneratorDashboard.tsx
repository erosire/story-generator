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

import React from 'react';
import { styled } from '../styles';

// Outer container — fills its parent (the dark-themed FullScreen wrapper).
export const DashboardShell = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    overflow: 'hidden'
});

// Header row — pinned at the top, minimal. Contains the sidebar toggle icon
// and an optional title. No story tabs here anymore.
export const DashboardHeader = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    flex: '0 0 auto',
    padding: '6px 12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
    gap: 8,
    minHeight: 40
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
const DashboardSidebarPanel = styled('div', {
    flex: '0 0 auto',
    borderRight: '1px solid rgba(255, 255, 255, 0.12)',
    overflow: 'hidden',
    transition: 'width 0.15s ease, min-width 0.15s ease, max-width 0.15s ease',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    boxSizing: 'border-box' as const
});

// Main content column — fills remaining width after sidebar.
export const DashboardContent = styled('div', {
    flex: '1 1 auto',
    overflowY: 'auto',
    overflowX: 'hidden'
});

// Footer row — pinned at the bottom. Used by SectionStoryInput.
export const DashboardFooter = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 0 auto',
    padding: 12,
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
    gap: 8
});

// Composed dashboard. Accepts slots for header controls, sidebar content,
// main content, and footer.
export type StoryGeneratorDashboardProps = {
    headerControls: React.ReactNode;
    sidebar: React.ReactNode;
    content: React.ReactNode;
    footer: React.ReactNode;
    sidebarOpen: boolean;
};

export const StoryGeneratorDashboard: React.FC<StoryGeneratorDashboardProps> = React.memo(
    ({ headerControls, sidebar, content, footer, sidebarOpen }) => (
        <DashboardShell>
            <DashboardHeader>
                {headerControls}
            </DashboardHeader>
            <DashboardBody>
                {/* Sidebar width is dynamic — controlled via inline style since
                    the vendored styled() helper doesn't support function values. */}
                <DashboardSidebarPanel
                    data-testid="sidebar-panel"
                    style={{
                        width: sidebarOpen ? 200 : 0,
                        minWidth: sidebarOpen ? 200 : 0,
                        maxWidth: sidebarOpen ? 200 : 0,
                        borderRight: sidebarOpen ? '1px solid rgba(255, 255, 255, 0.12)' : 'none'
                    }}
                >
                    {sidebar}
                </DashboardSidebarPanel>
                <DashboardContent>{content}</DashboardContent>
            </DashboardBody>
            <DashboardFooter>{footer}</DashboardFooter>
        </DashboardShell>
    )
);
