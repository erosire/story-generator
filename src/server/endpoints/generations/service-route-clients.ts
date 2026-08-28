import { asServiceHandler } from '@underload/service';
import { generationListClients } from './generation-list-clients';
import { LOCAL_AREA_NETWORK_STORYBOARD_PORT } from '@config/environment';

// Clients route — serves the selectable LLM client ids to the frontend.
// Same service/port as the story-specific route so one deployment exposes
// the full storyboard API surface (list stories, create/fork/get/patch/delete
// a story, and list clients).
export default {
    port: LOCAL_AREA_NETWORK_STORYBOARD_PORT,
    route: '/v1/storyboard/clients',
    handler: asServiceHandler({
        GET: generationListClients
    })
};
