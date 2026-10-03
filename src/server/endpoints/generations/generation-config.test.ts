// Tests for generation-config.ts sampling defaults.
//
// The runtime clients are mocked because this test verifies only the
// distribution-owned configuration contract: every selectable story client
// receives the GLM-5.2-compatible defaults when it is cloned, and the LOCAL
// standard gateway client (STANDARD_CLIENT, which replaced the
// '@runtime/secret/private/telnyx' import) mirrors the runtime telnyx.ts
// construction.
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
        // simpleClient is called exactly once by generation-config.ts (the
        // local copy); simpleConfig mirrors the real factory's shape (the
        // raw configuration is stored under `.config`).
        simpleClient: vi.fn(() => STANDARD_CLIENT),
        simpleConfig: vi.fn((configuration: Record<string, unknown>) => ({
            config: configuration
        })),
        // No-op pause so the copy's 429 rate-limit handler can be invoked in
        // tests without a real 10-second sleep.
        scriptPause: vi.fn(async () => undefined)
    };
});

// Mock the import paths used by generation-config.ts so no API keys or
// provider initialization are evaluated while the configuration is tested.
// The mock surface mirrors the CURRENT named imports of generation-config.ts:
// simpleClient/simpleConfig from '@agentic/harness' — they build the file's
// LOCAL standard gateway copy (STANDARD_CLIENT), which replaced the retired
// '@runtime/secret/private' (QWEN3_8_CLIENT) and
// '@runtime/secret/private/telnyx' (TELNYX_CLIENT) imports once every
// CLIENTS entry — including Qwen27B ('local/qwen3.8-27b') — reduced to a
// .clone({ model, sampling }) of the standard copy. A missing name surfaces
// as "No ... export is defined on the mock" at import time. No
// '@runtime/secret/private*' mock remains because generation-config.ts no
// longer imports that barrel at all.
vi.mock('@agentic/harness', () => ({
    simpleClient: mocks.simpleClient,
    simpleConfig: mocks.simpleConfig
}));
// scriptPause is no-op'd (kept with the real module's other exports) so the
// local copy's 429 rate-limit retry handler runs instantly under test.
vi.mock('@presource/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@presource/core')>();
    return { ...actual, scriptPause: mocks.scriptPause };
});

import { CLIENT, CLIENTS, DEFAULT_SAMPLING_PARAMS, QWEN3_8_SAMPLING_PARAMS, parseClientId, resolveClient } from './generation-config';
// The distribution's own standalone replacement for @config/environment —
// the value baked into the local standard copy's localhost endpoint.
import { LOCAL_AREA_NETWORK_PROVIDER_PORT } from '../../../config';

describe('generation sampling defaults', () => {
    it('defines the exact SGLang-compatible defaults', () => {
        // top_k: -1 is the SGLang/vLLM sentinel for "top-k filtering disabled"
        // (full vocabulary considered); it is intentionally negative, not an error.
        // max_tokens: 32768 is the explicit completion limit every story client
        // inherits (long-form expansion would otherwise hit backend default
        // caps and silently truncate mid-chapter).
        expect(DEFAULT_SAMPLING_PARAMS).toEqual({
            temperature: 1.0,
            top_p: 0.95,
            top_k: -1,
            max_tokens: 32768,
            min_p: 0.0,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repetition_penalty: 1.0
        });
    });

    it('derives the Qwen3_8 defaults with a nonnegative top_k', () => {
        // The ninfer backend behind the Qwen27B entry rejects top_k: -1 (HTTP 400
        // "top_k must be nonnegative"); top_k: 0 is the vLLM-style sentinel for
        // "consider all tokens" — same behavior as -1, compliant encoding.
        // max_tokens: 32768 is inherited from DEFAULT_SAMPLING_PARAMS via the
        // spread, so the ninfer client gets the same completion limit.
        expect(QWEN3_8_SAMPLING_PARAMS).toEqual({
            temperature: 1.0,
            top_p: 0.95,
            top_k: 0,
            max_tokens: 32768,
            min_p: 0.0,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repetition_penalty: 1.0
        });
    });

    it('attaches the defaults to every selectable story-generation client', () => {
        // KIMIK3 / KIMIK26 / MIMO26 / SONNET / OPUS / MERGE / VULTR / FLASH /
        // PARTICLE / LIGHTNING / MODAL / Qwen27B all clone the STANDARD_CLIENT
        // copy with their own model override (the merge/lightning/vultr/modal
        // gateways serve every Kimi/GLM/MiMo deployment; Qwen27B pins the
        // local ninfer model). 4a8a3f6 "Updated Merge" retired the MERGEK3
        // duplicate (KIMIK3 was retargeted to merge/kimi-k3), renamed MERGEK26
        // to KIMIK26, and dropped the GLMFLASH plain-default clone. Qwen27B
        // uses the nonnegative top_k sampling variant.
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'merge/kimi-k3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'merge/kimi-k2-6',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            // MIMO26 routes MiMo-2.6 through the merge gateway
            // ('merge/mimo-2-6' — the canonical ${provider}/mimo-2-6 id).
            model: 'merge/mimo-2-6',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'lightning/sonnet-5',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'lightning/opus-5',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            // VULTR is the renamed GLM53 entry — the key now names the
            // gateway instead of the model. The model routes through the
            // Vultr gateway; the deployment has been retargeted repeatedly
            // ('telnyx/glm-5.3' → 'merge/glm-5.3' → 'token-router/glm-5.3' →
            // 'vultr/glm-5.3', the value committed in bc075ea "Fixed Story
            // Generator"). This expectation pins the CURRENT
            // generation-config.ts value; retarget again => update here.
            model: 'vultr/glm-5.3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            // FLASH is the plain-default flash model on the Vultr gateway
            // (the sibling of the VULTR entry above).
            model: 'vultr/glm-5.3-flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'merge/glm-5.3-flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            // LIGHTNING routes MiMo-2.6 through the lightning gateway
            // ('lightning/mimo-2-6' — the canonical ${provider}/mimo-2-6 id).
            model: 'lightning/mimo-2-6',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            model: 'modal/glm-5.3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledWith({
            // Qwen27B re-pins the local qwen3.8-27b model (the model the
            // retired runtime QWEN3_8_CLIENT carried) onto the standard
            // copy's localhost endpoint, with the ninfer-compliant sampling.
            model: 'local/qwen3.8-27b',
            sampling: QWEN3_8_SAMPLING_PARAMS
        });
        expect(Object.keys(CLIENTS)).toEqual([
            'KIMIK3',
            'KIMIK26',
            'MIMO26',
            'SONNET',
            'OPUS',
            'Qwen27B',
            'MERGE',
            'VULTR',
            'FLASH',
            'PARTICLE',
            'LIGHTNING',
            'MODAL'
        ]);
    });

    it('resolves each known clientId to its own (mocked) client instance', () => {
        // Every selectable entry shares the same mock instance (the mocked
        // clone returns itself), so these identity assertions prove the
        // lookup is KEY-accurate — a broken map that dropped an id or added
        // a misspelled one would fail exactly the affected assertion.
        expect(resolveClient('KIMIK3')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('KIMIK26')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('MIMO26')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('SONNET')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('OPUS')).toBe(mocks.STANDARD_CLIENT);
        // Qwen27B is the renamed Qwen3_8 entry — same STANDARD_CLIENT mock.
        expect(resolveClient('Qwen27B')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('MERGE')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('VULTR')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('FLASH')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('PARTICLE')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('LIGHTNING')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('MODAL')).toBe(mocks.STANDARD_CLIENT);
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

describe('local STANDARD_CLIENT copy', () => {
    // STANDARD_CLIENT is module-private in generation-config.ts (the local
    // copy of the shared Telnyx gateway client), so the copy's construction
    // is pinned through the mocked simpleClient/simpleConfig factories: the
    // single simpleClient call's arguments captured here.
    const configuration = () =>
        mocks.simpleClient.mock.calls[0][0] as {
            model: string;
            config: unknown;
            status: Record<number, () => Promise<boolean>>;
        };

    it('is built locally with the runtime telnyx.ts construction', () => {
        // Exactly ONE simpleClient call in this test graph: the local copy.
        // Every CLIENTS entry (including Qwen27B) derives from it via the
        // mocked clone, which never re-enters the factory.
        expect(mocks.simpleClient).toHaveBeenCalledTimes(1);
        expect(mocks.simpleConfig).toHaveBeenCalledTimes(1);
        // Endpoint mirrors runtime/secret/private/telnyx.ts: machine-local
        // localhost + the provider port from the distribution's own
        // src/config.ts (standalone replacement for @config/environment;
        // both pin port 5500).
        expect(mocks.simpleConfig.mock.calls[0][0]).toEqual({
            endpoints: {
                Standard: `http://localhost:${LOCAL_AREA_NETWORK_PROVIDER_PORT}/providers/private/v1`
            }
        });
        // The simpleConfig return value is passed through as the client
        // config — identity proves the wiring (the real simpleConfig stores
        // the raw configuration under `.config`).
        expect(configuration().config).toBe(mocks.simpleConfig.mock.results[0].value);
        expect(configuration().model).toBe('telnyx/glm-5.3-flash');
        expect(configuration().status).toEqual({ 429: expect.any(Function) });
    });

    it('retries 429 rate limits after a 10-second pause', async () => {
        // Handler contract copied from runtime/secret/private/telnyx.ts:
        // wait 10 seconds, then return true (retry the request). scriptPause
        // is mocked, so the wait is a no-op under test.
        await expect(configuration().status[429]()).resolves.toBe(true);
        expect(mocks.scriptPause).toHaveBeenCalledWith(10000);
    });
});

describe('parseClientId', () => {
    it('treats an absent value as the legal default-client signal', () => {
        expect(parseClientId(undefined)).toEqual({});
        expect(parseClientId(null)).toEqual({});
    });

    it('accepts every selectable client id, echoing the key verbatim', () => {
        expect(parseClientId('KIMIK3')).toEqual({ clientId: 'KIMIK3' });
        expect(parseClientId('KIMIK26')).toEqual({ clientId: 'KIMIK26' });
        expect(parseClientId('MIMO26')).toEqual({ clientId: 'MIMO26' });
        expect(parseClientId('SONNET')).toEqual({ clientId: 'SONNET' });
        expect(parseClientId('OPUS')).toEqual({ clientId: 'OPUS' });
        expect(parseClientId('Qwen27B')).toEqual({ clientId: 'Qwen27B' });
        expect(parseClientId('MERGE')).toEqual({ clientId: 'MERGE' });
        expect(parseClientId('VULTR')).toEqual({ clientId: 'VULTR' });
        expect(parseClientId('FLASH')).toEqual({ clientId: 'FLASH' });
        expect(parseClientId('PARTICLE')).toEqual({ clientId: 'PARTICLE' });
        expect(parseClientId('LIGHTNING')).toEqual({ clientId: 'LIGHTNING' });
        expect(parseClientId('MODAL')).toEqual({ clientId: 'MODAL' });
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
        const AVAILABLE =
            'KIMIK3, KIMIK26, MIMO26, SONNET, OPUS, Qwen27B, MERGE, VULTR, FLASH, PARTICLE, LIGHTNING, MODAL';
        expect(parseClientId('Nope')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Nope'. Available clients: ${AVAILABLE}`
        });
        // Retired ids from the old CLIENTS map are rejected the same way — a
        // stale id persisted in the UI's localStorage (e.g. the pre-rename
        // default 'Qwen3_8', the 4a8a3f6-retired 'MERGEK3'/'MERGEK26'/
        // 'GLMFLASH' entries, the since-retired 'Nvidia' / 'Makora' /
        // 'DeepSeek' / 'Telnyx' entries, or 'GLM53' — renamed to 'VULTR' when
        // the key switched to gateway naming) surfaces this message on the
        // next generation, which is why the UI default moved in lockstep with
        // the map changes.
        expect(parseClientId('Qwen3_8')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Qwen3_8'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('MERGEK3')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'MERGEK3'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('MERGEK26')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'MERGEK26'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('GLMFLASH')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'GLMFLASH'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('GLM53')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'GLM53'. Available clients: ${AVAILABLE}`
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
