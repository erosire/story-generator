// Tests for generation-config.ts sampling defaults.
//
// The runtime clients are mocked because this test verifies only the
// distribution-owned configuration contract: every selectable story client
// receives the GLM-5.2-compatible defaults when it is cloned.
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
        QWEN3_8_CLIENT: createClient(),
        TELNYX_CLIENT: createClient()
    };
});

// Mock the import paths used by generation-config.ts so no API keys or
// provider initialization are evaluated while the configuration is tested.
// The mock surface mirrors the CURRENT named imports of generation-config.ts
// (QWEN3_8_CLIENT from '@runtime/secret/private' and TELNYX_CLIENT from
// '@runtime/secret/private/telnyx') — a missing name surfaces as
// "No ... export is defined on the mock" at import time. The makora module is
// still mocked defensively because vi.mock intercepts the FULL module graph
// pulled in by '@runtime/secret/private' (its barrel re-exports
// runtime/secret/private/modal, whose index imports the makora-backed clients);
// the retired NVIDIA_CLIENT / GLM53FLASH_CLIENT / KIMI3_CLIENT mock entries
// were removed along with the CLIENTS entries they backed.
vi.mock('@runtime/secret/private/makora', () => ({ MAKORA_CLIENT: mocks.TELNYX_CLIENT }));
vi.mock('@runtime/secret/private', () => ({
    QWEN3_8_CLIENT: mocks.QWEN3_8_CLIENT
}));
vi.mock('@runtime/secret/private/telnyx', () => ({ TELNYX_CLIENT: mocks.TELNYX_CLIENT }));

import { CLIENT, CLIENTS, DEFAULT_SAMPLING_PARAMS, QWEN3_8_SAMPLING_PARAMS, parseClientId, resolveClient } from './generation-config';

describe('generation sampling defaults', () => {
    it('defines the exact SGLang-compatible defaults', () => {
        // top_k: -1 is the SGLang/vLLM sentinel for "top-k filtering disabled"
        // (full vocabulary considered); it is intentionally negative, not an error.
        expect(DEFAULT_SAMPLING_PARAMS).toEqual({
            temperature: 1.0,
            top_p: 0.95,
            top_k: -1,
            min_p: 0.0,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repetition_penalty: 1.0
        });
    });

    it('derives the Qwen3_8 defaults with a nonnegative top_k', () => {
        // The ninfer backend behind QWEN3_8_CLIENT rejects top_k: -1 (HTTP 400
        // "top_k must be nonnegative"); top_k: 0 is the vLLM-style sentinel for
        // "consider all tokens" — same behavior as -1, compliant encoding.
        expect(QWEN3_8_SAMPLING_PARAMS).toEqual({
            temperature: 1.0,
            top_p: 0.95,
            top_k: 0,
            min_p: 0.0,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repetition_penalty: 1.0
        });
    });

    it('attaches the defaults to every selectable story-generation client', () => {
        // KIMIK3 / MERGEK3 / MERGEK26 / GLM53 all clone the TELNYX instance
        // with their own model override (the Telnyx gateway serves every
        // Kimi/GLM deployment), while GLMFLASH clones it with the plain
        // SGLang defaults (no model override — the deployment's default model
        // is used as-is). Qwen27B clones QWEN3_8_CLIENT with the nonnegative
        // top_k variant.
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            model: 'telnyx/kimi-k3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            model: 'merge/kimi-k3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            model: 'merge/kimi-k2-6',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            model: 'telnyx/glm-5.3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.QWEN3_8_CLIENT.clone).toHaveBeenCalledWith({
            sampling: QWEN3_8_SAMPLING_PARAMS
        });
        expect(Object.keys(CLIENTS)).toEqual([
            'KIMIK3',
            'MERGEK3',
            'MERGEK26',
            'Qwen27B',
            'GLM53',
            'GLMFLASH'
        ]);
    });

    it('resolves each known clientId to its own (mocked) client instance', () => {
        // Each CLIENTS entry is a distinct mock (clone returns itself), so
        // identity assertions prove the lookup is key-accurate — a broken
        // map (e.g. one client returned for every id) would fail exactly one
        // of these per key.
        expect(resolveClient('KIMIK3')).toBe(mocks.TELNYX_CLIENT);
        expect(resolveClient('MERGEK3')).toBe(mocks.TELNYX_CLIENT);
        expect(resolveClient('MERGEK26')).toBe(mocks.TELNYX_CLIENT);
        // Qwen27B is the renamed Qwen3_8 entry — same QWEN3_8_CLIENT instance.
        expect(resolveClient('Qwen27B')).toBe(mocks.QWEN3_8_CLIENT);
        expect(resolveClient('GLM53')).toBe(mocks.TELNYX_CLIENT);
        expect(resolveClient('GLMFLASH')).toBe(mocks.TELNYX_CLIENT);
    });

    it('falls back to the default client (CLIENT = CLIENTS.Qwen27B) for absent or unknown ids', () => {
        // The server-side default must be the same Qwen27B the UI defaults to
        // (store.tsx DEFAULT_CLIENT_ID), so a payload without clientId and a
        // UI-driven payload for the default id hit the same client.
        expect(CLIENT).toBe(CLIENTS.Qwen27B);
        expect(resolveClient()).toBe(CLIENT);
        expect(resolveClient(null)).toBe(CLIENT);
        expect(resolveClient('')).toBe(CLIENT);
        expect(resolveClient('no-such-client')).toBe(CLIENT);
        // Inherited-prototype names must NOT resolve to prototype methods
        // (CLIENTS is a plain object) — the hasOwnProperty guard in
        // resolveClient covers this; without it resolveClient('toString')
        // would return Object.prototype.toString.
        expect(resolveClient('toString')).toBe(CLIENT);
        expect(resolveClient('constructor')).toBe(CLIENT);
    });
});

describe('parseClientId', () => {
    it('treats an absent value as the legal default-client signal', () => {
        expect(parseClientId(undefined)).toEqual({});
        expect(parseClientId(null)).toEqual({});
    });

    it('accepts every selectable client id, echoing the key verbatim', () => {
        expect(parseClientId('KIMIK3')).toEqual({ clientId: 'KIMIK3' });
        expect(parseClientId('MERGEK3')).toEqual({ clientId: 'MERGEK3' });
        expect(parseClientId('MERGEK26')).toEqual({ clientId: 'MERGEK26' });
        expect(parseClientId('Qwen27B')).toEqual({ clientId: 'Qwen27B' });
        expect(parseClientId('GLM53')).toEqual({ clientId: 'GLM53' });
        expect(parseClientId('GLMFLASH')).toEqual({ clientId: 'GLMFLASH' });
    });

    it('rejects non-string clientId values with the type error', () => {
        expect(parseClientId(7).error).toBe('clientId must be a non-empty string');
        expect(parseClientId('').error).toBe('clientId must be a non-empty string');
        expect(parseClientId({}).error).toBe('clientId must be a non-empty string');
        expect(parseClientId([]).error).toBe('clientId must be a non-empty string');
        expect(parseClientId(true).error).toBe('clientId must be a non-empty string');
    });

    it('rejects unknown clientId values, listing every available client', () => {
        // The available-client list is Object.keys(CLIENTS) in insertion order.
        const AVAILABLE = 'KIMIK3, MERGEK3, MERGEK26, Qwen27B, GLM53, GLMFLASH';
        expect(parseClientId('Nope')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Nope'. Available clients: ${AVAILABLE}`
        });
        // Retired ids from the old CLIENTS map are rejected the same way — a
        // stale id persisted in the UI's localStorage (e.g. the pre-rename
        // default 'Qwen3_8', or the since-retired 'Nvidia' / 'Makora' /
        // 'DeepSeek' / 'Telnyx' entries) surfaces this message on the next
        // generation, which is why the UI default moved in lockstep with the
        // map changes.
        expect(parseClientId('Qwen3_8')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Qwen3_8'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('Nvidia')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Nvidia'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('Telnyx')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Telnyx'. Available clients: ${AVAILABLE}`
        });
        // Inherited prototype names are rejected even though plain-object
        // indexing would "find" them — hasOwnProperty is the guard.
        expect(parseClientId('toString')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'toString'. Available clients: ${AVAILABLE}`
        });
    });
});
