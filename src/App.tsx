// App-level composition for the story generator dashboard.
//
// HOISTED here from the old src/components/StoryGeneratorApp — the main
// component belongs at App level, composing the FEATURES from src/features:
//
//   <StoryStoreProvider>
//     <BootstrapLayer />
//     <FullScreen><DarkThemeWrapper>
//       <Dashboard
//         headerControls={toggle icon + title + client dropdown + rename}
//         sidebar={<StorySidebar />}
//         content={<StoryContent />}
//         footer={<StoryInput />}
//       />
//     </DarkThemeWrapper></FullScreen>
//   </StoryStoreProvider>
//
// The sidebar is toggled via a hamburger icon (☰) in the header.
// Default open on desktop (≥768px), default closed on mobile (<768px).

import React from 'react';
// FullScreen — the @react/headless viewport-locked layout primitive
// (packages/react/headless/components/layout/screen.tsx): position:absolute,
// 100%×100% pinned to top/left 0. The dashboard's own surface treatment
// (background, overflow clipping) is merged on top via the style prop.
import { FullScreen } from '@react/headless';
// Material UI theming — every MUI component (buttons, text fields, dialogs)
// resolves its internal styling (focus rings, disabled states, dialog paper)
// against this token-mapped dark theme.
import { ThemeProvider } from '@mui/material';
import { muiTheme, styled, theme } from './styles';
import { StoryStoreProvider, type StoryStore } from './context';
import { BootstrapLayer, Dashboard, HeaderControls, StorySidebar, StoryContent, StoryInput } from './features';

// Outer theme wrapper — sets the font + text color for the whole dashboard.
// Background is transparent so the FullScreen surface shows through.
const DarkThemeWrapper = styled('div', {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'transparent',
    color: theme.text,
    overflow: 'hidden',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.body,
    // Smoother font rendering on the dark surface.
    WebkitFontSmoothing: 'antialiased' as const,
    textRendering: 'optimizeLegibility' as const
});

// App props: optional store overrides (used by tests and by future callers
// that want to point at a different storyboard base URL or tune the poll
// cadences).
export type AppProps = {
    configOverrides?: Partial<StoryStore['config']>;
    initialStore?: React.ComponentProps<typeof StoryStoreProvider>['initialStore'];
};

// The story generator app — provider + bootstrap + dashboard layout. Kept as
// the named export `StoryGeneratorApp` (the public/test contract:
// App.test.tsx imports it) alongside the default `App`.
export const StoryGeneratorApp: React.FC<AppProps> = React.memo(
    ({ configOverrides, initialStore }) => {
        // Sidebar open/close state. Default open on desktop (≥768px),
        // default closed on mobile (<768px). Uses matchMedia for an accurate
        // initial check without layout shift — the 768px breakpoint matches
        // common tablet/mobile boundaries.
        const [sidebarOpen, setSidebarOpen] = React.useState(() => {
            if (typeof window !== 'undefined' && window.matchMedia) {
                return window.matchMedia('(min-width: 768px)').matches;
            }
            // SSR / test fallback: assume desktop.
            return true;
        });

        const toggleSidebar = React.useCallback(() => setSidebarOpen((prev) => !prev), []);

        return (
            // MUI theme provider — wraps the whole dashboard so every Material
            // component renders against the flat dark palette.
            <ThemeProvider theme={muiTheme}>
                <StoryStoreProvider configOverrides={configOverrides} initialStore={initialStore}>
                    <BootstrapLayer />
                    {/* @react/headless FullScreen + the dashboard's flat surface
                        treatment merged on top (solid near-black, no scroll). */}
                    <FullScreen style={{ backgroundColor: theme.bg, overflow: 'hidden' }}>
                        <DarkThemeWrapper>
                            <Dashboard
                                sidebarOpen={sidebarOpen}
                                onOverlayClick={toggleSidebar}
                                headerControls={
                                    <HeaderControls
                                        sidebarOpen={sidebarOpen}
                                        onToggleSidebar={toggleSidebar}
                                    />
                                }
                                sidebar={<StorySidebar />}
                                content={<StoryContent />}
                                footer={<StoryInput />}
                            />
                        </DarkThemeWrapper>
                    </FullScreen>
                </StoryStoreProvider>
            </ThemeProvider>
        );
    }
);

// Default export — what main.tsx renders.
const App: React.FC = () => <StoryGeneratorApp />;
export default App;
