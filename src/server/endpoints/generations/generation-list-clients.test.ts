// Tests for the /v1/storyboard/clients endpoint (generation-list-clients.ts).
//
// The endpoint must expose exactly the selectable LLM client ids that
// generation-config.ts defines (Object.keys(CLIENTS)) — the story-generator
// UI renders these verbatim as the top-right client dropdown and submits the
// user's choice as `clientId` in every generation payload.
//
// The runtime clients are mocked (same pattern as generation-config.test.ts)
// so no API keys or provider initialization are evaluated. The handler itself
// is trivial but its CONTRACT (returning the live CLIENTS key set, status 200,
// no body/path requirements) is the part under test.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const createClient = () => {
        const client: { clone: ReturnType<typeof vi.fn> } = {
            clone: vi.fn()
        };
        client.clone.mockReturnValue(client);
        return client;
    };

    // The LOCAL standard gateway copy inside generation-config.ts is built by
    // simpleClient(simpleConfig(...)) — this mock instance is what those
    // factories hand back, and it is ALSO what the Qwen27B clone (the mocked
    // clone returns itself) hands back. Every selectable CLIENTS entry
    // therefore shares this single mock instance.
    const STANDARD_CLIENT = createClient();

    return {
        STANDARD_CLIENT,
        simpleClient: vi.fn(() => STANDARD_CLIENT),
        simpleConfig: vi.fn((configuration: Record<string, unknown>) => ({
            config: configuration
        }))
    };
});

// Mock surface mirrors the CURRENT named imports of generation-config.ts:
// simpleClient/simpleConfig from '@agentic/harness' — they build the file's
// LOCAL standard gateway copy (STANDARD_CLIENT), which replaced the retired
// '@runtime/secret/private' (QWEN3_8_CLIENT) and '@runtime/secret/private/
// telnyx' (TELNYX_CLIENT) imports once every CLIENTS entry — including
// Qwen27B ('local/qwen3.8-27b') — reduced to a .clone({ model, sampling }) of
// the standard copy. A missing name surfaces as "No ... export is defined on
// the mock" at import time. No '@runtime/secret/private*' mock remains
// because generation-config.ts no longer imports that barrel at all.
vi.mock('@agentic/harness', () => ({
    simpleClient: mocks.simpleClient,
    simpleConfig: mocks.simpleConfig
}));

import { generationListClients } from './generation-list-clients';

describe('generationListClients', () => {
    it('returns 200 with the exact selectable client id set from CLIENTS', async () => {
        const result = await generationListClients({} as any, { path: {}, query: {}, body: {} } as any, {} as any);

        expect(result.status).toBe(200);
        // Order is the object insertion order of CLIENTS — the UI preserves it.
        // KIMIK3 / KIMIK26 / SONNET / OPUS / VULTR / GLM53Flash / PARTICLE /
        // LIGHTNING / MODAL are all served by the merge/lightning/vultr/modal
        // gateways; Qwen27B is the renamed 'Qwen3_8' entry. 4a8a3f6 "Updated
        // Merge" retired the MERGEK3 duplicate, renamed MERGEK26 to KIMIK26,
        // and dropped GLMFLASH; GLM53 was renamed to VULTR (gateway-style
        // naming) and the retired Modal (GLM52), Makora, DeepSeek, Router
        // (OpenRouter) and standalone Nvidia/Telnyx deployments stay
        // commented out of CLIENTS.
        expect(result.response.clients).toEqual([
            'KIMIK3',
            'KIMIK26',
            'SONNET',
            'OPUS',
            'Qwen27B',
            'VULTR',
            'GLM53Flash',
            'PARTICLE',
            'LIGHTNING',
            'MODAL'
        ]);
    });

    it('returns a plain string array with no extra properties', async () => {
        const result = await generationListClients({} as any, { path: {}, query: {}, body: {} } as any, {} as any);

        expect(result.response).toEqual({ clients: expect.any(Array) });
        for (const clientId of result.response.clients) {
            expect(typeof clientId).toBe('string');
            expect(clientId.length).toBeGreaterThan(0);
        }
    });

    it('requires no path parameters or body (client ids are a server deployment detail)', async () => {
        // Missing path/body must not affect the response — the route is a
        // simple collection listing with no routing variables.
        const result = await generationListClients({} as any, {} as any, {} as any);

        expect(result.status).toBe(200);
        expect(Array.isArray(result.response.clients)).toBe(true);
        // 10 selectable ids: KIMIK3, KIMIK26, SONNET, OPUS, Qwen27B, VULTR,
        // GLM53Flash, PARTICLE, LIGHTNING, MODAL (retired entries commented
        // out of CLIENTS).
        expect(result.response.clients.length).toBe(10);
    });
});