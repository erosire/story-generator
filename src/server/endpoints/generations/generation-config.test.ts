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
        GLM52_CLIENT: createClient(),
        MAKORA_CLIENT: createClient(),
        KIMI3_CLIENT: createClient(),
        NVIDIA_CLIENT: createClient(),
        OPENROUTER_CLIENT: createClient(),
        QWEN3_8_CLIENT: createClient(),
        TELNYX_CLIENT: createClient()
    };
});

// Mock the three import paths used by generation-config.ts so no API keys or
// provider initialization are evaluated while the configuration is tested.
vi.mock('@runtime/secret/private/makora', () => ({ MAKORA_CLIENT: mocks.MAKORA_CLIENT }));
vi.mock('@runtime/secret/private', () => ({
    GLM52_CLIENT: mocks.GLM52_CLIENT,
    KIMI3_CLIENT: mocks.KIMI3_CLIENT,
    NVIDIA_CLIENT: mocks.NVIDIA_CLIENT,
    OPENROUTER_CLIENT: mocks.OPENROUTER_CLIENT,
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
        expect(mocks.NVIDIA_CLIENT.clone).toHaveBeenCalledWith({
            model: 'moonshotai/kimi-k3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        // GLM52 (Modal) and OPENROUTER (Router) are deliberately disabled in
        // the CLIENTS map (commented out — the deployments are retired), so
        // their clone must never be invoked.
        expect(mocks.GLM52_CLIENT.clone).not.toHaveBeenCalled();
        expect(mocks.KIMI3_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.QWEN3_8_CLIENT.clone).toHaveBeenCalledWith({
            sampling: QWEN3_8_SAMPLING_PARAMS
        });
        // MAKORA backs two selectable ids (Makora + DeepSeek) — same instance,
        // different model overrides, so clone is invoked once per entry.
        expect(mocks.MAKORA_CLIENT.clone).toHaveBeenCalledWith({
            model: 'zai-org/GLM-5.2-NVFP4',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.MAKORA_CLIENT.clone).toHaveBeenCalledWith({
            model: 'deepseek-ai/DeepSeek-V4-Flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.OPENROUTER_CLIENT.clone).not.toHaveBeenCalled();
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(Object.keys(CLIENTS)).toEqual([
            'Nvidia',
            'KIMIK3',
            'Qwen27B',
            'Makora',
            'DeepSeek',
            'Telnyx'
        ]);
    });

    it('resolves each known clientId to its own (mocked) client instance', () => {
        // Each CLIENTS entry is a distinct mock (clone returns itself), so
        // identity assertions prove the lookup is key-accurate — a broken
        // map (e.g. one client returned for every id) would fail exactly one
        // of these per key.
        expect(resolveClient('Nvidia')).toBe(mocks.NVIDIA_CLIENT);
        expect(resolveClient('KIMIK3')).toBe(mocks.KIMI3_CLIENT);
        // Qwen27B is the renamed Qwen3_8 entry — same QWEN3_8_CLIENT instance.
        expect(resolveClient('Qwen27B')).toBe(mocks.QWEN3_8_CLIENT);
        // Makora and DeepSeek both clone the MAKORA instance with different
        // model overrides, so both ids resolve to the same underlying mock.
        expect(resolveClient('Makora')).toBe(mocks.MAKORA_CLIENT);
        expect(resolveClient('DeepSeek')).toBe(mocks.MAKORA_CLIENT);
        expect(resolveClient('Telnyx')).toBe(mocks.TELNYX_CLIENT);
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
        expect(parseClientId('Nvidia')).toEqual({ clientId: 'Nvidia' });
        expect(parseClientId('KIMIK3')).toEqual({ clientId: 'KIMIK3' });
        expect(parseClientId('Qwen27B')).toEqual({ clientId: 'Qwen27B' });
        expect(parseClientId('Makora')).toEqual({ clientId: 'Makora' });
        expect(parseClientId('DeepSeek')).toEqual({ clientId: 'DeepSeek' });
        expect(parseClientId('Telnyx')).toEqual({ clientId: 'Telnyx' });
    });

    it('rejects non-string clientId values with the type error', () => {
        expect(parseClientId(7).error).toBe('clientId must be a non-empty string');
        expect(parseClientId('').error).toBe('clientId must be a non-empty string');
        expect(parseClientId({}).error).toBe('clientId must be a non-empty string');
        expect(parseClientId([]).error).toBe('clientId must be a non-empty string');
        expect(parseClientId(true).error).toBe('clientId must be a non-empty string');
    });

    it('rejects unknown clientId values, listing every available client', () => {
        expect(parseClientId('Nope')).toEqual({
            clientId: undefined,
            error: 'Unknown clientId \'Nope\'. Available clients: Nvidia, KIMIK3, Qwen27B, Makora, DeepSeek, Telnyx'
        });
        // Retired ids from the old CLIENTS map are rejected the same way — a
        // stale id persisted in the UI's localStorage (e.g. the pre-rename
        // default 'Qwen3_8') surfaces this message on the next generation,
        // which is why the UI default moved in lockstep with the rename.
        expect(parseClientId('Qwen3_8')).toEqual({
            clientId: undefined,
            error: 'Unknown clientId \'Qwen3_8\'. Available clients: Nvidia, KIMIK3, Qwen27B, Makora, DeepSeek, Telnyx'
        });
        expect(parseClientId('Modal')).toEqual({
            clientId: undefined,
            error: 'Unknown clientId \'Modal\'. Available clients: Nvidia, KIMIK3, Qwen27B, Makora, DeepSeek, Telnyx'
        });
        // Inherited prototype names are rejected even though plain-object
        // indexing would "find" them — hasOwnProperty is the guard.
        expect(parseClientId('toString')).toEqual({
            clientId: undefined,
            error: 'Unknown clientId \'toString\'. Available clients: Nvidia, KIMIK3, Qwen27B, Makora, DeepSeek, Telnyx'
        });
    });
});
