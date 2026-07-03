// Main dashboard component for the story generator.
//
// Mirrors library/workflow/lightning-agent/LightningAgentDashboard.tsx:
//   <ContextProvider>
//     <FullScreen><DarkThemeWrapper><Dashboard/></DarkThemeWrapper></FullScreen>
//   </ContextProvider>
//
// We don't reuse the lightning-agent FullScreen (depends on @react/headless) —
// we vendor a minimal full-screen + dark-theme wrapper here because the
// distribution package only declares react/react-dom as deps (see package.json).

import React from 'react';
import { styled } from '../styles';
import { StoryStoreProvider } from '../context';
import { StoryGeneratorDashboard } from './StoryGeneratorDashboard';
import { SectionStoryTabs, SectionStoryContent, SectionStoryInput } from './sections';

// Full-bleed container that forces the dashboard to fill the viewport.
const FullScreen = styled('div', {
    position: 'fixed',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'hidden'
});

// Dark theme wrapper. Adds CSS custom properties consumed by descendant
// styled elements (none of the lightning-agent's MUI overrides apply here
// since this dashboard doesn't use MUI — see the styled helper in styles/styled.tsx).
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

// Composed dashboard. Accepts optional store overrides (used by tests and by
// future callers that want to point at a different storyboard base URL).
export type StoryGeneratorAppProps = {
    configOverrides?: { baseUrl?: string; pollIntervalMs?: number };
    initialStore?: React.ComponentProps<typeof StoryStoreProvider>['initialStore'];
};

export const StoryGeneratorApp: React.FC<StoryGeneratorAppProps> = React.memo(
    ({ configOverrides, initialStore }) => {
        return (
            <StoryStoreProvider configOverrides={configOverrides} initialStore={initialStore}>
                <FullScreen>
                    <DarkThemeWrapper>
                        <StoryGeneratorDashboard
                            header={<SectionStoryTabs />}
                            content={<SectionStoryContent />}
                            footer={<SectionStoryInput />}
                        />
                    </DarkThemeWrapper>
                </FullScreen>
            </StoryStoreProvider>
        );
    }
);
