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
    // factories hand back, and it is ALSO what every CLIENTS clone (the mocked
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
// telnyx' (TELNYX_CLIENT) imports once every CLIENTS entry — BASALT
// ('local/basalt') included — reduced to a
// .clone({ model, sampling }) of
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
        // 3235df7 "Upgraded Engines" rewrote the map (generation-config.ts:
        // 283-291): SAIL / MAKORA / KIMI are new sail- and Makora-gateway
        // entries, VULTR keeps its vultr/glm-5.3 model, DS4 and FLASH moved
        // onto the sail gateway, and the retired KIMIK3 / KIMIK26 / MIMO26 /
        // MERGE / PARTICLE / LIGHTNING / STRATA entries are gone. Earlier
        // history still explains the surviving keys: 4a8a3f6 "Updated Merge"
        // retired the MERGEK3 duplicate and renamed MERGEK26 to KIMIK26,
        // GLM53 became VULTR (gateway-style naming), the SONNET/OPUS Lightning
        // GPT entries were retired and SOL added — itself retired
        // (lightning/gpt-6-sol left the registry) with DS4 taking its slot —
        // and the retired Modal (GLM52), Makora, DeepSeek, Router (OpenRouter)
        // and standalone Nvidia/Telnyx deployments were dropped from CLIENTS.
        // Explicit literal, NOT Object.keys(CLIENTS): client ids are a server
        // deployment detail and this endpoint's whole contract is the exact id
        // set + order the UI dropdown renders, so deriving it from the subject
        // would make the assertion tautological.
        expect(result.response.clients).toEqual([
            'SAIL',
            'BASALT',
            'VULTR',
            'MAKORA',
            'KIMI',
            'DS4',
            'FLASH'
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
        // 7 selectable ids: SAIL, BASALT, VULTR, MAKORA, KIMI, DS4, FLASH
        // (the 3235df7 "Upgraded Engines" map — the retired KIMIK3, KIMIK26,
        // MIMO26, MERGE, PARTICLE, LIGHTNING and STRATA entries were dropped
        // from CLIENTS, as were MODAL after the modal/glm-5.3 client was
        // removed and the older Nvidia / Makora / DeepSeek / Telnyx / Router
        // deployments).
        expect(result.response.clients.length).toBe(7);
    });
});