// Barrel export for the story generator distribution.
// Re-exports the public App component and the building-block modules so
// consumers can compose their own dashboards if needed.

export { App } from './App';
export { StoryGeneratorApp } from './components/StoryGeneratorApp';
export { StoryStoreProvider, useStoryStore } from './context';
export { createNewStory, fetchStoryData, pollStoryData } from './api';
export type { StoryData, Chapter, StoryEntry, StoryStore } from './context';
