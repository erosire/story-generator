import { asServiceHandler } from '@underload/service';
import { generationCreateNewStory } from './generation-create-new-story';
import { generationDeleteStory } from './generation-delete-story';
import { generationGetStoryData } from './generation-get-story-data';
import { generationUpdateChapter } from './generation-update-chapter';

export default {
    port: 5252,
    route: '/v1/storyboard/generations/:storyId',
    handler: asServiceHandler({
        POST: generationCreateNewStory,
        DELETE: generationDeleteStory,
        GET: generationGetStoryData,
        PATCH: generationUpdateChapter
    })
};
