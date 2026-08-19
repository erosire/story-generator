import { asHandlerMethod } from '@underload/service';
import { CLIENTS } from './generation-config';

/**
 * GET /v1/storyboard/clients
 *
 * Returns the ids of every selectable story-generation LLM client
 * (Object.keys of CLIENTS from generation-config.ts).
 *
 * The story-generator UI renders these ids as the top-right client dropdown
 * and sends the user's choice back as `clientId` in every generation payload
 * (POST create/fork, PATCH expand/rewrite). Client ids are intentionally NOT
 * stored in the database — this endpoint is the only way a client discovers
 * the currently available set, keeping the UI in sync whenever CLIENTS gains
 * or loses entries on the deployment side.
 *
 * Response: { clients: string[] } — e.g. { clients: ['Nvidia', 'Modal', ...] }.
 */
export const generationListClients = asHandlerMethod(async () => {
    return {
        status: 200,
        response: { clients: Object.keys(CLIENTS) }
    };
});