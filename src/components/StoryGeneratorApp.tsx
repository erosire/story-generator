// Main dashboard component for the story generator.
//
// Composes the two-column layout:
//   <ContextProvider>
//     <BootstrapLayer />
//     <FullScreen><DarkThemeWrapper>
//       <Dashboard
//         headerControls={toggle icon + title}
//         sidebar={<SectionStoryTabs />}
//         content={<SectionStoryContent />}
//         footer={<SectionStoryInput />}
//       />
//     </DarkThemeWrapper></FullScreen>
//   </ContextProvider>
//
// The sidebar is toggled via a hamburger icon (☰) in the header. Default open.

import React from 'react';
import { styled } from '../styles';
import { StoryStoreProvider } from '../context';
import { StoryGeneratorDashboard } from './StoryGeneratorDashboard';
import { BootstrapLayer } from './BootstrapLayer';
import { SectionStoryTabs, SectionStoryContent, SectionStoryInput } from './sections';

// Full-bleed container that forces the dashboard to fill the viewport.
const FullScreen = styled('div', {
    position: 'fixed',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'hidden'
});

// Dark theme wrapper.
const DarkThemeWrapper = styled('div', {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#121212',
    color: '#e0e0e0',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif'
});

// Toggle button — hamburger icon that opens/closes the sidebar.
const ToggleButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    flex: '0 0 auto',
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.15)',
    backgroundColor: 'transparent',
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: 0
});

// App title text in the header.
const HeaderTitle = styled('span', {
    fontSize: 14,
    fontWeight: 600,
    color: '#c0c0c0',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const
});

// Composed dashboard. Accepts optional store overrides (used by tests and by
// future callers that want to point at a different storyboard base URL).
export type StoryGeneratorAppProps = {
    configOverrides?: { baseUrl?: string; pollIntervalMs?: number };
    initialStore?: React.ComponentProps<typeof StoryStoreProvider>['initialStore'];
};

export const StoryGeneratorApp: React.FC<StoryGeneratorAppProps> = React.memo(
    ({ configOverrides, initialStore }) => {
        // Sidebar open/close state. Default open so the user sees the story list.
        const [sidebarOpen, setSidebarOpen] = React.useState(true);

        return (
            <StoryStoreProvider configOverrides={configOverrides} initialStore={initialStore}>
                <BootstrapLayer />
                <FullScreen>
                    <DarkThemeWrapper>
                        <StoryGeneratorDashboard
                            sidebarOpen={sidebarOpen}
                            headerControls={
                                <>
                                    <ToggleButton
                                        onClick={() => setSidebarOpen((prev) => !prev)}
                                        aria-label="Toggle story sidebar"
                                        data-testid="sidebar-toggle"
                                    >
                                        ☰
                                    </ToggleButton>
                                    <HeaderTitle>Story Generator</HeaderTitle>
                                </>
                            }
                            sidebar={<SectionStoryTabs />}
                            content={<SectionStoryContent />}
                            footer={<SectionStoryInput />}
                        />
                    </DarkThemeWrapper>
                </FullScreen>
            </StoryStoreProvider>
        );
    }
);
