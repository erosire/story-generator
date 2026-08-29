/**
 * @vitest-environment node
 * The service-route modules transitively import the generation handlers, which
 * pull in story-utils → @runtime/secret/private — that chain creates OpenAI
 * clients that throw in jsdom browser-like environments (same reason
 * generation-list-stories.test.ts declares the node environment).
 */
import { describe, it, expect } from 'vitest';
import generationsRoute from './service-route';
import storyRoute from './service-route-storyId';
import clientsRoute from './service-route-clients';
import { LOCAL_AREA_NETWORK_STORYBOARD_PORT } from '@config/environment';

/**
 * PORT CONTRACT — every storyboard endpoint of this service MUST declare
 * `port: LOCAL_AREA_NETWORK_STORYBOARD_PORT` (5252) in its default export.
 *
 * Why this test exists: the underload gateway (packages/underload/service/src/server/start.ts:166)
 * defaults to port 5000, and an endpoint module that omits `port` is silently
 * served IN PLACE on the gateway instead of the dedicated storyboard worker
 * port. That is exactly how the collection route (service-route.ts) ended up
 * on 5000 while the story + clients routes lived on 5252 — the API was split
 * across two ports. This suite pins all three routes to the shared constant so
 * a new service-route cannot reintroduce the split (a missing `port` fails
 * here instead of silently binding 5000).
 */
describe('storyboard service-route port contract', () => {
    it('config constant is the agreed storyboard port 5252', () => {
        expect(LOCAL_AREA_NETWORK_STORYBOARD_PORT).toBe(5252);
    });

    it('every storyboard route declares port 5252 (LOCAL_AREA_NETWORK_STORYBOARD_PORT)', () => {
        // All routes in src/server/endpoints/generations/ — add any new
        // service-route*.ts of this service to this list.
        const routes = [generationsRoute, storyRoute, clientsRoute];
        for (const route of routes) {
            expect(route.port).toBe(5252);
            expect(route.port).toBe(LOCAL_AREA_NETWORK_STORYBOARD_PORT);
        }
    });

    it('collection route (service-route.ts) is fully wired', () => {
        expect(generationsRoute).toEqual({
            port: 5252,
            route: '/v1/storyboard/generations',
            handler: expect.anything()
        });
    });

    it('story route (service-route-storyId.ts) is fully wired', () => {
        expect(storyRoute).toEqual({
            port: 5252,
            route: '/v1/storyboard/generations/:storyId',
            handler: expect.anything()
        });
    });

    it('clients route (service-route-clients.ts) is fully wired', () => {
        expect(clientsRoute).toEqual({
            port: 5252,
            route: '/v1/storyboard/clients',
            handler: expect.anything()
        });
    });
});
