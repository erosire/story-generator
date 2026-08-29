import { asServiceHandler } from '@underload/service';
import { generationCreateNewStory } from './generation-create-new-story';
import { generationDeleteStory } from './generation-delete-story';
import { generationGetStoryData } from './generation-get-story-data';
import { generationUpdateChapter } from './generation-update-chapter';
// Shared storyboard service port — previously this route hardcoded 5252
// literally while service-route.ts omitted `port` (→ gateway default 5000),
// splitting the API across two ports. Resolve from @config/environment so all
// storyboard routes track a single source of truth (config/environment/src/port.ts).
import { LOCAL_AREA_NETWORK_STORYBOARD_PORT } from '@config/environment';

export default {
    port: LOCAL_AREA_NETWORK_STORYBOARD_PORT,
    route: '/v1/storyboard/generations/:storyId',
    handler: asServiceHandler({
        POST: generationCreateNewStory,
        DELETE: generationDeleteStory,
        GET: generationGetStoryData,
        PATCH: generationUpdateChapter
    })
};
