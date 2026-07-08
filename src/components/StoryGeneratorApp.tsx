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

// Dialog overlay — semi-transparent backdrop for the rename modal.
const DialogOverlay = styled('div', {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
});

// Dialog box — floating card for the rename input.
const DialogBox = styled('div', {
    background: theme.surface2,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusLg,
    padding: 24,
    minWidth: 320,
    display: 'flex',
    flexDirection: 'column',
    gap: 14
});

const DialogLabel = styled('label', {
    fontSize: theme.fontSize.md,
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5
});

const DialogActions = styled('div', {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4
});

const DialogButton = styled('button', {
    padding: '8px 16px',
    fontSize: theme.fontSize.md,
    fontWeight: 600,
    borderRadius: theme.radiusMd,
    cursor: 'pointer',
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface1,
    color: theme.textMuted,
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}`
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

// Delete button — appears in the header top right when a story is selected.
// Modern destructive button: translucent danger surface, danger border, hover
// lifts to a stronger red-filled state.
const DeleteButton = styled('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
    padding: '0 12px',
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.dangerBorder}`,
    backgroundColor: theme.dangerSoft,
    color: theme.danger,
    cursor: 'pointer',
    fontSize: theme.fontSize.base,
    fontWeight: 600,
    lineHeight: 1,
    marginLeft: 'auto',
    transition: `background-color ${theme.transition}, border-color ${theme.transition}`
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
    const { store, setStore, deleteStory } = useStoryStore();
    const { selected } = store;
    const [deleting, setDeleting] = React.useState(false);
    const [renaming, setRenaming] = React.useState(false);
    const [renameValue, setRenameValue] = React.useState('');

    const handleDelete = React.useCallback(async () => {
        if (!selected || deleting) return;
        if (!window.confirm(`Delete story "${selected.title}"? This cannot be undone.`)) return;
        setDeleting(true);
        try {
            await deleteStory(selected.storyId);
        } catch (err) {
            console.error('Failed to delete story:', err);
        } finally {
            setDeleting(false);
        }
    }, [selected, deleting, deleteStory]);

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
                style={{ cursor: selected ? 'pointer' : 'default' }}
                title={selected ? 'Click to rename' : undefined}
            >
                {selected?.storyName || selected?.title || 'Story Generator'}
            </HeaderTitle>
            {selected && (
                <DeleteButton
                    onClick={handleDelete}
                    disabled={deleting}
                    data-testid="delete-story-button"
                    className="sg-danger"
                >
                    {deleting ? 'Deleting...' : 'Delete'}
                </DeleteButton>
            )}

            {/* Rename dialog */}
            {renaming && (
                <DialogOverlay onClick={closeRename} data-testid="rename-overlay">
                    <DialogBox onClick={(e) => e.stopPropagation()} data-testid="rename-dialog">
                        <DialogLabel>Story Name</DialogLabel>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            placeholder="Enter story name"
                            data-testid="rename-input"
                            style={{
                                padding: '10px 14px',
                                fontSize: theme.fontSize.body,
                                borderRadius: theme.radiusMd,
                                border: `1px solid ${theme.border}`,
                                backgroundColor: theme.surface1,
                                color: theme.text,
                                outline: 'none'
                            }}
                            onFocus={(e) => { e.currentTarget.style.borderColor = theme.accent; }}
                            onBlur={(e) => { e.currentTarget.style.borderColor = theme.border; }}
                        />
                        <DialogActions>
                            <DialogButton onClick={closeRename} data-testid="rename-cancel">
                                Cancel
                            </DialogButton>
                            <button
                                onClick={handleRename}
                                disabled={!renameValue.trim()}
                                data-testid="rename-confirm"
                                style={{
                                    padding: '8px 16px',
                                    fontSize: theme.fontSize.md,
                                    fontWeight: 600,
                                    borderRadius: theme.radiusMd,
                                    cursor: !renameValue.trim() ? 'not-allowed' : 'pointer',
                                    border: `1px solid ${theme.accent}`,
                                    backgroundColor: theme.accent,
                                    color: '#ffffff',
                                    opacity: !renameValue.trim() ? 0.5 : 1,
                                    transition: `background-color ${theme.transition}`
                                }}
                                onMouseEnter={(e) => {
                                    if (renameValue.trim()) e.currentTarget.style.backgroundColor = theme.accentHover;
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = theme.accent;
                                }}
                            >
                                Rename
                            </button>
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
