# Story Generator

AI-powered storyboard story generator. Creates multi-chapter stories via background LLM generation with progressive reveal — chapters appear one by one as they are expanded.

## Quick Start

```bash
npm install
npm run dev        # Vite dev server at http://localhost:8000
npm run test       # Run all tests
npm run build      # Production build to dist/
```

The UI connects to the storyboard API at `http://192.168.8.128:5000` by default (configurable via `StoryStoreProvider` `configOverrides`).

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  StoryGeneratorApp                                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  StoryStoreProvider (React context + state)   │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  BootstrapLayer (hidden, fetches list)  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │  ┌──────────┬──────────────┬───────────────┐  │  │
│  │  │ Sidebar  │   Content    │    Footer     │  │  │
│  │  │ (tabs)   │ (chapters)   │ (story input) │  │  │
│  │  └──────────┴──────────────┴───────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │ GET /generations       │ POST/GET/PATCH/DELETE
         ▼                        ▼
┌──────────────────┐   ┌──────────────────────────┐
│  Collection API  │   │   Story-specific API      │
│  GET /generations│   │   /generations/:storyId   │
└──────────────────┘   └──────────────────────────┘
```

### Two-Route API Design

The API is split into two routes:

| Route | Purpose | Methods |
|-------|---------|---------|
| `/v1/storyboard/generations` | Collection — list all stories | `GET` |
| `/v1/storyboard/generations/:storyId` | Story-specific operations | `POST`, `GET`, `PATCH`, `DELETE` |

This is a clean separation: the collection endpoint returns metadata only (for the sidebar), while story-specific endpoints handle creation, data retrieval, updates, and deletion.

---

## API Reference

OpenAPI spec: `src/server/endpoints/story-generator.yml`

### `GET /v1/storyboard/generations`

Returns all stories sorted by `createdDate` descending (newest first).

**Response:**
```json
{
  "stories": [
    {
      "storyId": "a1b2c3d4-...",
      "storyName": "My Sci-Fi Story",
      "chapterRequested": 5,
      "chapterCompleted": 3,
      "createdDate": "2026-07-01T10:00:00.000Z",
      "status": "generating"
    }
  ]
}
```

**Status values:** `generating` | `completed` | `failed`

Storyline is intentionally omitted from the list — it is free-form user text not needed by the sidebar.

### `POST /v1/storyboard/generations/:storyId`

Starts background story generation. Returns the `storyId` immediately while generation continues asynchronously.

**Direct create (the dashboard Generate button) is plotline-only:** the server generates and validates the plot outline, writes `plotpoint.json` with `status: "completed"`, and writes a skeleton `chapter-NNN.json` payload per chapter (stored LLM context, `revisions: []`). **Chapters are NOT auto-expanded** — the client expands them individually with `PATCH { expandChapterIndex }`, which consumes each skeleton's stored context.

**Request body:**
```json
{
  "storyline": "A sci-fi adventure about a crew discovering alien artifacts on Mars.",
  "chapterCount": 5
}
```

**Fork mode** (alternative to creating from scratch):
```json
{
  "forkFrom": {
    "sourceStoryId": "original-story-uuid",
    "chapterIndex": 2
  }
}
```

Unlike direct creates, fork mode re-expands chapters from `chapterIndex` onwards in the background (full plotline + expansion flow).

**Response:**
```json
{ "storyId": "a1b2c3d4-..." }
```

### `GET /v1/storyboard/generations/:storyId`

Returns the story's chapters with plotpoints and expansion status.

**Response:**
```json
{
  "chapters": [
    {
      "chapterNumber": "1",
      "chapterIndex": 0,
      "title": "The Arrival",
      "plotpoints": ["Crew lands on Mars", "Discovery of artifact"],
      "expanded": true,
      "canReExpand": true,
      "revisions": [
        {
          "content": "## The Arrival\n\nThe shuttle descended...",
          "wordCount": 5200,
          "generationTimeMs": 45230
        }
      ]
    }
  ],
  "meta": {
    "storyline": "A sci-fi adventure...",
    "chapterCount": 5,
    "createdAt": "2026-07-01T10:00:00.000Z"
  }
}
```

**Expanded vs pending chapters:**
- `expanded: true` — chapter has full content in `revisions[]`
- `expanded: false` — only plotpoints available, awaiting LLM expansion
- `canReExpand: true` — chapter-XXX.json payload exists (LLM context available for re-expansion)

### `PATCH /v1/storyboard/generations/:storyId`

Update story metadata, re-expand a chapter, or rewrite a chapter.

**Rename:**
```json
{ "storyName": "My Renamed Story" }
```

**Re-expand chapter at index 2** (chains to subsequent pending chapters):
```json
{ "expandChapterIndex": 2 }
```

**Rewrite chapter at index 2** with custom instructions (single chapter, no chain):
```json
{
  "rewriteChapter": 2,
  "rewriteContext": "Make the scene more dramatic and add tension"
}
```

`expandChapterIndex` and `rewriteChapter` are mutually exclusive.

### `DELETE /v1/storyboard/generations/:storyId`

Permanently deletes a story and all its data. Aborts any in-progress generation.

**Response:**
```json
{ "success": true, "storyId": "a1b2c3d4-..." }
```

---

## Server-Side

All server code lives in `src/server/endpoints/generations/`.

### Files

| File | Role |
|------|------|
| `service-route.ts` | Collection route (`GET /generations`) — delegates to `generationListStories` |
| `service-route-storyId.ts` | Story route (`/generations/:storyId`) — maps `POST/GET/PATCH/DELETE` to handlers |
| `generation-list-stories.ts` | Lists all stories with metadata from `plotpoint.json` |
| `generation-create-new-story.ts` | POST handler — validates body, writes placeholder `plotpoint.json`, kicks off background `generateStory()` (plotline-only for direct creates; fork mode expands) |
| `generation-get-story-data.ts` | GET handler — reads `plotpoint.json` + `chapter/*.json` files, builds unified chapter array |
| `generation-update-chapter.ts` | PATCH handler — updates metadata, re-expands chapters, or rewrites with user context |
| `generation-delete-story.ts` | DELETE handler — removes the entire story directory |
| `generation-fork-story.ts` | Fork logic — copies chapters from a source story, re-expands from the fork point |
| `generation-config.ts` | All tunable settings (model, prompts, timeouts, retry limits, paths) |
| `story-utils.ts` | Shared LLM helpers — `expandChapter()`, `writeChapterFiles()`, `callStructured()`, etc. |

### Data Flow

1. **POST** creates `temporary/database/storyboard/{storyId}/` with `plotpoint.json` (placeholder) and `chapter/` directory
2. **Background `generateStory()`** (direct creates, plotline-only) calls the LLM for the plot outline → writes `plotpoint.json` with `chapters` array + `status: "completed"` → writes a skeleton `chapter-XXX.json` payload per chapter (stored LLM context, `revisions: []`). Fork mode additionally expands chapters from the fork point: writes `chapter-XXX.md` + full `chapter-XXX.json` files
3. **GET** reads `plotpoint.json` (for metadata/plotpoints) + `chapter/*.json` (for expansion data) → returns unified chapter array
4. **PATCH** reads stored LLM context from `chapter-XXX.json` → expands (single chapter + chain to pending chapters) or rewrites via background task
5. **DELETE** removes the entire `temporary/database/storyboard/{storyId}/` directory

### Story Retry

When plotpoint generation fails (refusals, validation errors, stalls), the handler:
1. Marks the current story as `status: "failed"` in `plotpoint.json`
2. Spins up a new story entry with `-retry-N` suffix (up to `MAX_STORY_ATTEMPTS = 3`)

### Rolling Context Window

During chapter expansion, only the most recent `PREVIOUS_EXPANDED_CHAPTERS = 4` expanded chapters are kept in full in the LLM context. Older chapters are restored to their plotpoint summaries to keep context bounded.

---

## Frontend

### Components

| Component | File | Role |
|-----------|------|------|
| `StoryGeneratorApp` | `StoryGeneratorApp.tsx` | Root — composes layout, header controls (rename, delete, sidebar toggle) |
| `BootstrapLayer` | `BootstrapLayer.tsx` | Hidden — hydrates from localStorage, fetches collection from server, merges into store |
| `SectionStoryTabs` | `sections/SectionStoryTabs.tsx` | Sidebar — vertical story list with auto-refresh every 30s |
| `SectionStoryContent` | `sections/SectionStoryContent.tsx` | Content area — progressive chapter rendering with expand/collapse, re-expand, rewrite |
| `SectionStoryInput` | `sections/SectionStoryInput.tsx` | Footer — storyline textarea + chapter count input + Generate button |
| `Collapsible` | `Collapsible.tsx` | Generic expand/collapse wrapper for chapters and plotpoints |
| `MarkdownContent` | `MarkdownContent.tsx` | Renders markdown content from expanded chapters |

### Bootstrap Sequence

On mount, `BootstrapLayer`:
1. **Hydrates from localStorage** — instant dashboard appearance with cached stories and chapter content
2. **Fetches `GET /v1/storyboard/generations`** — gets fresh story list from server
3. **Merges** server entries into the store, preserving locally-cached chapter data for entries that already exist

### Polling

When a story is selected, `SectionStoryContent` starts a `pollStoryData()` loop:
- **With `chapterRequested`**: terminates when `chapters.length >= chapterRequested` and all are expanded
- **Without `chapterRequested`** (remote story): uses poll-stability — terminates after 2 consecutive identical responses
- **404**: treated as "not yet started", keeps polling
- **Cancellation**: unmounting or selecting a different story sets `shouldStop = true`

### State Management

`src/context/store.tsx` provides `StoryStoreProvider` with:
- **`records`**: array of `StoryEntry` objects (each with `storyId`, `storyline`, `data`, `isProcessing`, etc.)
- **`selected`**: currently active entry
- **`config`**: `baseUrl` + `pollIntervalMs`
- **`setStore`**: updater function for React state
- **`deleteStory`**: calls DELETE API then removes from store

Records auto-persist to localStorage via `requestIdleCallback` (non-blocking).

### API Client

`src/api/storyboard.ts` exports:
- `fetchStoryList(baseUrl)` — GET collection
- `createNewStory(baseUrl, storyId, body, forkFrom?)` — POST new story
- `fetchStoryData(baseUrl, storyId)` — GET story data (returns `PollResult`)
- `pollStoryData(params)` — polling loop with progressive `onData` callbacks
- `updateChapter(baseUrl, storyId, chapterIndex)` — PATCH re-expand
- `rewriteChapter(baseUrl, storyId, chapterIndex, context, revisionIndex?)` — PATCH rewrite
- `updateStoryMeta(baseUrl, storyId, body)` — PATCH metadata
- `deleteStory(baseUrl, storyId)` — DELETE

---

## File Structure

```
distribution/story-generator/
├── src/
│   ├── api/
│   │   ├── storyboard.ts           # API client functions
│   │   ├── storyboard.test.ts      # API client tests
│   │   └── index.ts                # Barrel export
│   ├── components/
│   │   ├── BootstrapLayer.tsx       # Server hydration on mount
│   │   ├── Collapsible.tsx          # Generic expand/collapse
│   │   ├── MarkdownContent.tsx      # Markdown renderer
│   │   ├── StoryGeneratorApp.tsx    # Root layout + header controls
│   │   ├── StoryGeneratorDashboard.tsx  # Two-column dashboard layout
│   │   └── sections/
│   │       ├── SectionStoryTabs.tsx     # Sidebar story list
│   │       ├── SectionStoryContent.tsx  # Chapter content display
│   │       └── SectionStoryInput.tsx    # Story input form
│   ├── context/
│   │   ├── store.tsx                # React context + state + localStorage persistence
│   │   └── index.ts
│   ├── server/
│   │   └── endpoints/
│   │       ├── story-generator.yml     # OpenAPI 3.0 spec
│   │       └── generations/
│   │           ├── service-route.ts            # GET /generations (listing)
│   │           ├── service-route-storyId.ts    # POST/GET/PATCH/DELETE /generations/:storyId
│   │           ├── generation-list-stories.ts  # List handler
│   │           ├── generation-create-new-story.ts  # POST handler + background generation
│   │           ├── generation-get-story-data.ts    # GET handler
│   │           ├── generation-update-chapter.ts    # PATCH handler
│   │           ├── generation-delete-story.ts      # DELETE handler
│   │           ├── generation-fork-story.ts        # Fork logic
│   │           ├── generation-config.ts            # All settings
│   │           └── story-utils.ts                  # Shared LLM helpers
│   ├── styles/                       # Theme + styled components
│   ├── App.tsx                       # Entry point
│   └── index.ts                      # Barrel export
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

---

## Configuration

### Server Config (`generation-config.ts`)

| Setting | Default | Description |
|---------|---------|-------------|
| `MIN_WORDS_PER_CHAPTER` | 3000 | Minimum words per expanded chapter |
| `TARGET_WORD_COUNT_PROMPT` | 15,000 words | Target word count in expansion prompt |
| `MIN_PLOTPOINTS_PER_CHAPTER` | 10 | Minimum plotpoints per chapter |
| `MAX_PLOT_ATTEMPTS` | 3 | Retries when plotpoint validation fails |
| `MAX_STALL_RETRIES` | 10 | Retries when LLM streaming stalls |
| `MAX_STORY_ATTEMPTS` | 3 | Maximum story entries (original + retries) |
| `PREVIOUS_EXPANDED_CHAPTERS` | 4 | Rolling context window size |
| `PLOTPOINT_STALL_TIMEOUT_MS` | 5 min | Stall detection timeout |
| `DATABASE_BASE_DIR` | `temporary/database/storyboard` | Story storage path |

### Frontend Config

Via `StoryStoreProvider` `configOverrides`:

| Setting | Default | Description |
|---------|---------|-------------|
| `baseUrl` | `http://192.168.8.128:5000/v1/storyboard/generations` | API base URL |
| `pollIntervalMs` | 10000 | Poll interval in ms |

---

## Testing

```bash
npm run test          # Run all tests
npm run test:watch    # Watch mode
npm run typecheck     # TypeScript type check
```

Tests use `vitest` with mocked `fetch`. Key test files:
- `src/api/storyboard.test.ts` — API client unit tests
- `src/server/endpoints/generations/generation-list-stories.test.ts` — List handler (node env)
- `src/server/endpoints/generations/generation-get-story-data.test.ts` — Get handler (node env)
- `src/App.test.tsx` — Full integration tests (jsdom env)
