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
// The sidebar is toggled via a hamburger icon (☰) in the header.
// Default open on desktop (≥768px), default closed on mobile (<768px).

import React from 'react';
import { styled, theme } from '../styles';
import { StoryStoreProvider, useStoryStore } from '../context';
import { updateStoryMeta } from '../api';
import { StoryGeneratorDashboard } from './StoryGeneratorDashboard';
import { BootstrapLayer } from './BootstrapLayer';
import { SectionStoryTabs, SectionStoryContent, SectionStoryInput } from './sections';

// Full-bleed container that forces the dashboard to fill the viewport.
// Flat Design: a single solid near-black surface — no vignette, gradient, or
// glow. Depth is created by solid surface blocks + crisp borders downstream.
const FullScreen = styled('div', {
    position: 'fixed',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: theme.bg
});

// Outer theme wrapper — sets the font + text color for the whole dashboard.
// Background is transparent so the vignette from FullScreen shows through.
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

// Toggle button — hamburger icon that opens/closes the sidebar.
// Flat Design: outlined square with solid surface + crisp hairline border.
// Hover swaps to surface2 + stronger border (sg-hover class). No shadow.
const ToggleButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flex: '0 0 auto',
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface1,
    color: theme.text,
    cursor: 'pointer',
    fontSize: theme.fontSize.xl,
    lineHeight: 1,
    padding: 0,
    transition: `background-color ${theme.transition}, border-color ${theme.transition}`
});

// Dialog overlay — opaque enough to isolate the rename task from the dashboard
// while preserving the surrounding page as context. The padding prevents the
// fixed dialog from touching narrow viewport edges.
const DialogOverlay = styled('div', {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.74)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box' as const,
    zIndex: 1000,
    animation: 'sg-dialog-fade-in 140ms ease both'
});

// Dialog box — an opaque, elevated surface with a stronger border than normal
// dashboard panels so the edit state reads as a deliberate focused task.
const DialogBox = styled('div', {
    width: '100%',
    maxWidth: 400,
    boxSizing: 'border-box' as const,
    backgroundColor: theme.surfaceDialog,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusLg,
    padding: 26,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.48)'
});

// Dialog label — provides a high-contrast task heading above the editable field.
const DialogLabel = styled('label', {
    fontSize: theme.fontSize.lg,
    fontWeight: 700,
    lineHeight: 1.3,
    color: theme.text,
    letterSpacing: 0.1
});

// Dialog input — keeps the editor visually substantial and uses a class-based
// focus ring so interaction feedback does not rely on inline event styling.
const DialogInput = styled('input', {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '12px 14px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.body,
    lineHeight: 1.4,
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.borderStrong}`,
    backgroundColor: theme.bg,
    color: theme.text,
    outline: 'none',
    transition: `border-color ${theme.transition}, box-shadow ${theme.transition}, background-color ${theme.transition}`
});

// Dialog actions — aligns the low-emphasis cancel action and high-emphasis
// rename action without allowing the buttons to collapse on small screens.
const DialogActions = styled('div', {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 2
});

// Shared dialog button base — both actions use the same dimensions for a stable
// footer even when the primary action becomes disabled.
const DialogButton = styled('button', {
    minHeight: 36,
    padding: '8px 16px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.md,
    fontWeight: 700,
    borderRadius: theme.radiusMd,
    cursor: 'pointer',
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface1,
    color: theme.textMuted,
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}`
});

// Primary dialog button — uses the accent as a solid action surface so the
// confirm affordance remains visible against the opaque dialog panel.
const DialogConfirmButton = styled('button', {
    minHeight: 36,
    padding: '8px 16px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.md,
    fontWeight: 700,
    borderRadius: theme.radiusMd,
    cursor: 'pointer',
    border: `1px solid ${theme.accent}`,
    backgroundColor: theme.accent,
    color: '#ffffff',
    transition: `background-color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`
});

// App title text in the header. Slightly larger, brighter, and tracked out
// for a modern dashboard wordmark look.
const HeaderTitle = styled('span', {
    fontSize: theme.fontSize.lg,
    fontWeight: 600,
    color: theme.text,
    letterSpacing: 0.2,
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const
});

// Composed dashboard. Accepts optional store overrides (used by tests and by
// future callers that want to point at a different storyboard base URL).
export type StoryGeneratorAppProps = {
    configOverrides?: { baseUrl?: string; pollIntervalMs?: number };
    initialStore?: React.ComponentProps<typeof StoryStoreProvider>['initialStore'];
};

// Inner header controls that access the store (must be inside StoryStoreProvider).
const HeaderControls: React.FC<{
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
}> = React.memo(({ sidebarOpen, onToggleSidebar }) => {
    const { store, setStore } = useStoryStore();
    const { selected } = store;
    const [renaming, setRenaming] = React.useState(false);
    const [renameValue, setRenameValue] = React.useState('');

    const openRename = React.useCallback(() => {
        if (!selected) return;
        setRenameValue(selected.storyName || selected.title || '');
        setRenaming(true);
    }, [selected]);

    const closeRename = React.useCallback(() => {
        setRenaming(false);
        setRenameValue('');
    }, []);

    const handleRename = React.useCallback(async () => {
        if (!selected || !renameValue.trim()) return;
        try {
            await updateStoryMeta(store.config.baseUrl, selected.storyId, { storyName: renameValue.trim() });
            setStore((prev) => {
                const records = prev.records.map((e) =>
                    e.storyId === selected.storyId
                        ? { ...e, storyName: renameValue.trim(), title: renameValue.trim() }
                        : e
                );
                const selectedEntry = records.find((e) => e.storyId === selected.storyId) ?? prev.selected;
                return { ...prev, records, selected: selectedEntry };
            });
            setRenaming(false);
        } catch (err) {
            console.error('Failed to rename story:', err);
        }
    }, [selected, renameValue, store.config.baseUrl, setStore]);

    const handleRenameKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
                handleRename();
            } else if (e.key === 'Escape') {
                closeRename();
            }
        },
        [handleRename, closeRename]
    );

    return (
        <>
            <ToggleButton
                onClick={onToggleSidebar}
                aria-label="Toggle story sidebar"
                data-testid="sidebar-toggle"
                className="sg-hover"
            >
                ☰
            </ToggleButton>
            <HeaderTitle
                onClick={openRename}
                data-testid="story-title"
                className={selected ? 'sg-title-action' : undefined}
                title={selected ? 'Click to rename' : undefined}
            >
                {selected?.storyName || selected?.title || 'Story Generator'}
            </HeaderTitle>

            {/* Rename dialog */}
            {renaming && (
                <DialogOverlay
                    onClick={closeRename}
                    data-testid="rename-overlay"
                    role="presentation"
                >
                    <DialogBox
                        onClick={(e) => e.stopPropagation()}
                        data-testid="rename-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="rename-dialog-title"
                    >
                        <DialogLabel
                            id="rename-dialog-title"
                            htmlFor="rename-input"
                        >
                            Rename story
                        </DialogLabel>
                        <DialogInput
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            placeholder="Enter story name"
                            data-testid="rename-input"
                            id="rename-input"
                            className="sg-dialog-input"
                        />
                        <DialogActions>
                            <DialogButton
                                type="button"
                                onClick={closeRename}
                                data-testid="rename-cancel"
                                className="sg-hover"
                            >
                                Cancel
                            </DialogButton>
                            <DialogConfirmButton
                                type="button"
                                onClick={handleRename}
                                disabled={!renameValue.trim()}
                                data-testid="rename-confirm"
                                className="sg-dialog-confirm"
                            >
                                Rename
                            </DialogConfirmButton>
                        </DialogActions>
                    </DialogBox>
                </DialogOverlay>
            )}
        </>
    );
});

export const StoryGeneratorApp: React.FC<StoryGeneratorAppProps> = React.memo(
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
            <StoryStoreProvider configOverrides={configOverrides} initialStore={initialStore}>
                <BootstrapLayer />
                <FullScreen>
                    <DarkThemeWrapper>
                        <StoryGeneratorDashboard
                            sidebarOpen={sidebarOpen}
                            onOverlayClick={toggleSidebar}
                            headerControls={
                                <HeaderControls
                                    sidebarOpen={sidebarOpen}
                                    onToggleSidebar={toggleSidebar}
                                />
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
