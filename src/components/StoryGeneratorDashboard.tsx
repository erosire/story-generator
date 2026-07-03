// One-column dashboard layout for the story generator.
//
// Mirrors packages/react/headless/components/dashboard/OneColumnDashboard.tsx
// (header / scrollable content / footer stacked vertically into a 100vh column).
//
// We don't use the upstream `oneColumnDashboard` prototypeComponent because the
// distribution package doesn't depend on @presource/react — see src/styles/styled.tsx.
//
// Layout:
//   - full-height flex column
//   - header: natural height (story tabs row)
//   - content: flex 1, scrollable (plotlines + chapters)
//   - footer: natural height (storyline input form)

import React from 'react';
import { styled } from '../styles';

// Outer container — fills its parent (which is the dark-themed FullScreen wrapper).
export const DashboardShell = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    overflow: 'hidden'
});

// Header row — pinned at the top, no scroll. Used by SectionStoryTabs.
export const DashboardHeader = styled('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    flex: '0 0 auto',
    padding: '8px 12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
    gap: 8,
    overflowX: 'auto',
    overflowY: 'hidden',
    minHeight: 48
});

// Scrollable content region between header and footer.
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

// Composed dashboard. Accepts the three ReactNode slots.
export type StoryGeneratorDashboardProps = {
    header: React.ReactNode;
    content: React.ReactNode;
    footer: React.ReactNode;
};

export const StoryGeneratorDashboard: React.FC<StoryGeneratorDashboardProps> = React.memo(
    ({ header, content, footer }) => (
        <DashboardShell>
            <DashboardHeader>{header}</DashboardHeader>
            <DashboardContent>{content}</DashboardContent>
            <DashboardFooter>{footer}</DashboardFooter>
        </DashboardShell>
    )
);
