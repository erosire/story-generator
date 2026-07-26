import { asServiceHandler, asHandlerMethod } from '@underload/service';
import { generationCreateNewStory } from './generation-create-new-story';
import { generationDeleteStory } from './generation-delete-story';
import { generationGetStoryData } from './generation-get-story-data';
import { generationListStories } from './generation-list-stories';
import { generationUpdateChapter } from './generation-update-chapter';

const combinedGetHandler = asHandlerMethod(async (c, parameters, variables) => {
    const { path } = parameters;

    if (path.storyId === 'list') {
        return await generationListStories(c, parameters, variables);
    }

    return await generationGetStoryData(c, parameters, variables);
});

export default {
    route: '/v1/storyboard/generations/:storyId',
    handler: asServiceHandler({
        POST: generationCreateNewStory,
        DELETE: generationDeleteStory,
        GET: combinedGetHandler,
        PATCH: generationUpdateChapter
    })
};
