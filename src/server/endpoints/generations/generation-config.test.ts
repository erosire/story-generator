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

import { CLIENTS, DEFAULT_SAMPLING_PARAMS, QWEN3_8_SAMPLING_PARAMS } from './generation-config';

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
            model: 'z-ai/glm-5.2',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.GLM52_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.KIMI3_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.QWEN3_8_CLIENT.clone).toHaveBeenCalledWith({
            sampling: QWEN3_8_SAMPLING_PARAMS
        });
        expect(mocks.MAKORA_CLIENT.clone).toHaveBeenCalledWith({
            model: 'zai-org/GLM-5.2-NVFP4',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.OPENROUTER_CLIENT.clone).toHaveBeenCalledWith({
            model: 'deepseek/deepseek-v4-flash-0731',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.TELNYX_CLIENT.clone).toHaveBeenCalledWith({
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(Object.keys(CLIENTS)).toEqual([
            'Nvidia',
            'Modal',
            'KIMIK3',
            'Qwen3_8',
            'Makora',
            'Router',
            'Telnyx'
        ]);
    });
});
