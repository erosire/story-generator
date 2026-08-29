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

    return {
        GLM53FLASH_CLIENT: createClient(),
        MAKORA_CLIENT: createClient(),
        KIMI3_CLIENT: createClient(),
        NVIDIA_CLIENT: createClient(),
        QWEN3_8_CLIENT: createClient(),
        TELNYX_CLIENT: createClient()
    };
});

// Mock surface mirrors the CURRENT named imports of generation-config.ts
// (GLM53FLASH_CLIENT / KIMI3_CLIENT / NVIDIA_CLIENT / QWEN3_8_CLIENT) — a
// missing name (e.g. the retired GLM52_CLIENT id this file used to mock)
// surfaces as "No ... export is defined on the mock" at import time.
vi.mock('@runtime/secret/private/makora', () => ({ MAKORA_CLIENT: mocks.MAKORA_CLIENT }));
vi.mock('@runtime/secret/private', () => ({
    GLM53FLASH_CLIENT: mocks.GLM53FLASH_CLIENT,
    KIMI3_CLIENT: mocks.KIMI3_CLIENT,
    NVIDIA_CLIENT: mocks.NVIDIA_CLIENT,
    QWEN3_8_CLIENT: mocks.QWEN3_8_CLIENT
}));
vi.mock('@runtime/secret/private/telnyx', () => ({ TELNYX_CLIENT: mocks.TELNYX_CLIENT }));

import { generationListClients } from './generation-list-clients';

describe('generationListClients', () => {
    it('returns 200 with the exact selectable client id set from CLIENTS', async () => {
        const result = await generationListClients({} as any, { path: {}, query: {}, body: {} } as any, {} as any);

        expect(result.status).toBe(200);
        // Order is the object insertion order of CLIENTS — the UI preserves it.
        // 'Qwen27B' is the renamed 'Qwen3_8' entry; the retired Modal (GLM52)
        // and Router (OpenRouter) deployments stay commented out of CLIENTS.
        expect(result.response.clients).toEqual([
            'Nvidia',
            'KIMIK3',
            'GLMFLASH',
            'Qwen27B',
            'Makora',
            'DeepSeek',
            'Telnyx'
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
        // 7 selectable ids: Nvidia, KIMIK3, GLMFLASH, Qwen27B, Makora, DeepSeek,
        // Telnyx (Modal/Router commented out of the CLIENTS map).
        expect(result.response.clients.length).toBe(7);
    });
});