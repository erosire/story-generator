// Handler Configuration
import { asServiceHandler, asHandlerMethod } from '@underload/service';
import { generationCreateNewStory } from './generation-create-new-story';
import { generationDeleteStory } from './generation-delete-story';
import { generationGetStoryData } from './generation-get-story-data';
import { generationListStories } from './generation-list-stories';
import { generationUpdateChapter } from './generation-update-chapter';

// Combined GET handler that dispatches based on the storyId value
// - If storyId is "list": returns list of all story IDs
// - If storyId is any other value (e.g. UUID): returns detailed story data for that story
const combinedGetHandler = asHandlerMethod(async (c, parameters, variables) => {
    const { path } = parameters;

    // Check if storyId is the special "list" sentinel value
    if (path.storyId === 'list') {
        // Return list of all stories
        return await generationListStories(c, parameters, variables);
    }

    // Any other storyId value → delegate to get-story-data handler
    return await generationGetStoryData(c, parameters, variables);
});

// The Handler Configuration
export const handler = asServiceHandler({
    // For Posting a New Story
    POST: generationCreateNewStory,
    // For Deleting a Story
    DELETE: generationDeleteStory,
    // For Getting a Story or Listing All Stories
    GET: combinedGetHandler,
    // For Updating Story Data (metadata or re-expanding a Chapter)
    PATCH: generationUpdateChapter
});
