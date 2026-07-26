import { asServiceHandler } from '@underload/service';
import { generationListStories } from './generation-list-stories';

export default {
    route: '/v1/storyboard/generations',
    handler: asServiceHandler({
        GET: generationListStories
    })
};
