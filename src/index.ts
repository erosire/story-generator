// Barrel export for the story generator distribution.
// Re-exports the public App component and the building-block modules so
// consumers can compose their own dashboards if needed.
//
// StoryGeneratorApp is hoisted to src/App.tsx (the app-level composition);
// the modular components live in src/components and the UI features in
// src/features.

export { StoryGeneratorApp } from './App';
export type { AppProps } from './App';
export { StoryStoreProvider, useStoryStore } from './context';
export { createNewStory, fetchStoryData, fetchStoryList, pollStoryData } from './api';
export type { StoryData, Chapter, StoryEntry, StoryStore } from './context';
export type { StoryMeta } from './api';
