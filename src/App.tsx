// Main App component — renders the Story Generator dashboard.
//
// This replaces the distribution-template counter demo. The dashboard is a
// one-column layout (header / scrollable content / footer) backed by a
// story-store context that talks to the storyboard generations endpoints
// (POST /new, GET /data) via polling.
//
// See src/components/StoryGeneratorApp.tsx for the composition and
// src/api/storyboard.ts for the wire protocol.

import { StoryGeneratorApp } from './components';

export function App() {
    return <StoryGeneratorApp />;
}
