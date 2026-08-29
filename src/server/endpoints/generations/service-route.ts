import { asServiceHandler } from '@underload/service';
import { generationListStories } from './generation-list-stories';
// Shared storyboard service port (5252). Every route of this service MUST
// declare it: a module without `port` is served in place by the underload
// gateway, whose default is 5000 (packages/underload/service/src/server/start.ts:166
// — `port = 5000`) — which is exactly how this collection route ended up on a
// DIFFERENT port than the story + clients routes. One constant keeps the whole
// storyboard API surface (list stories, story CRUD, clients) on a single port.
import { LOCAL_AREA_NETWORK_STORYBOARD_PORT } from '@config/environment';

export default {
    port: LOCAL_AREA_NETWORK_STORYBOARD_PORT,
    route: '/v1/storyboard/generations',
    handler: asServiceHandler({
        GET: generationListStories
    })
};
