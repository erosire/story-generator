// Barrel export for the FEATURE set.
//
// Per the folder contract: src/features = UI features (sidebar, header,
// content area, input form, dashboard layout, bootstrap) that assemble the
// modular components from src/components and own the business logic (store
// access, polling, PATCH/POST flows). The app entry that composes them all
// lives in src/App.tsx.

export { BootstrapLayer } from './bootstrap';
export { Dashboard } from './dashboard';
export type { DashboardProps } from './dashboard';
export { HeaderControls } from './header';
export { StorySidebar } from './sidebar';
export { StoryInput } from './input';
export { StoryContent } from './content';
