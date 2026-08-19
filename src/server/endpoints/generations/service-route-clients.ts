import { asServiceHandler } from '@underload/service';
import { generationListClients } from './generation-list-clients';

// Clients route — serves the selectable LLM client ids to the frontend.
// Same service/port as the story-specific route so one deployment exposes
// the full storyboard API surface (list stories, create/fork/get/patch/delete
// a story, and list clients).
export default {
    port: 5252,
    route: '/v1/storyboard/clients',
    handler: asServiceHandler({
        GET: generationListClients
    })
};