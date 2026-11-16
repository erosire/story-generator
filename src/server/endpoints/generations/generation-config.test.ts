// Tests for generation-config.ts sampling defaults.
//
// The runtime clients are mocked because this test verifies only the
// distribution-owned configuration contract: every selectable story client
// receives the GLM-5.3-compatible defaults when it is cloned, and the LOCAL
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
    // factories hand back, and it is ALSO what every CLIENTS clone (the mocked
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
// CLIENTS entry — BASALT ('local/basalt') included — reduced to a
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

import {
    CLIENT,
    CLIENTS,
    DEFAULT_SAMPLING_PARAMS,
    QWEN3_8_SAMPLING_PARAMS,
    SOL_SAMPLING_PARAMS,
    parseClientId,
    resolveClient
} from './generation-config';
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
        // The ninfer backend behind the BASALT entry rejects top_k: -1 (HTTP 400
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

    it('drops top_p for the Sol Responses model', () => {
        // Lightning's gpt-6.1-sol (the SOL entry) rejects top_p outright:
        // "Unsupported parameter: 'top_p' is not supported with this model."
        // top_p is removed as a KEY (not set to undefined) — simple-client
        // spreads sampling verbatim into request bodies, and the Lightning
        // Responses translation only skips keys absent from the body.
        expect(SOL_SAMPLING_PARAMS).toEqual({
            temperature: 1.0,
            top_k: -1,
            max_tokens: 32768,
            min_p: 0.0,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repetition_penalty: 1.0
        });
        // toEqual treats undefined-valued keys as equal to absent keys, so the
        // own-property check is what pins true key absence on the wire.
        expect(Object.prototype.hasOwnProperty.call(SOL_SAMPLING_PARAMS, 'top_p')).toBe(false);
        // Every other default survives unchanged.
        expect(Object.keys(SOL_SAMPLING_PARAMS)).toEqual([
            'temperature',
            'top_k',
            'max_tokens',
            'min_p',
            'presence_penalty',
            'frequency_penalty',
            'repetition_penalty'
        ]);
    });

    it('attaches the defaults to every selectable story-generation client', () => {
        // 3235df7 "Upgraded Engines" replaced the CLIENTS map wholesale: the
        // retired KIMIK3 / KIMIK26 / MIMO26 / MERGE / PARTICLE / LIGHTNING /
        // STRATA entries are gone and the registry is the 7 gateway-routed
        // entries asserted below (generation-config.ts:283-291). Clone order
        // is the CLIENTS object-literal insertion order, so these nth-call
        // assertions pin BOTH the model string and the map position — a
        // dropped, renamed or reordered entry fails exactly the affected
        // assertion instead of silently matching another call. Retarget a
        // model => update here (that is this test's whole purpose).
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenCalledTimes(7);
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(1, {
            // SAIL routes GLM-5 through the sail gateway.
            model: 'sail/glm5',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(2, {
            // BASALT pins the local basalt model onto the standard copy's
            // localhost endpoint with the ninfer-compliant (top_k: 0) sampling
            // variant — the ONLY entry that does not clone with the plain
            // defaults, and the entry CLIENT (the server default) points at.
            model: 'local/basalt',
            sampling: QWEN3_8_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(3, {
            // VULTR is the gateway-named GLM-5.3 entry (renamed from GLM53 in
            // 4a8a3f6 "Updated Merge"). Its model string was retargeted
            // repeatedly ('telnyx/glm-5.3' → 'merge/glm-5.3' →
            // 'token-router/glm-5.3' → 'vultr/glm-5.3', the value committed in
            // bc075ea "Fixed Story Generator") and survived the 3235df7
            // rewrite unchanged.
            model: 'vultr/glm-5.3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(4, {
            // MAKORA is the new Makora-gateway glm5 flash sibling (written
            // double-quoted in the source — irrelevant to the assertion, which
            // compares the resolved string).
            model: 'makora/glm5-flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(5, {
            // KIMI is the sail-gateway Kimi entry that replaced the retired
            // merge-gateway KIMIK3 / KIMIK26 pair.
            model: 'sail/kimi3',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(6, {
            // DS4 moved off 'merge/ds4-flash' onto the sail gateway.
            model: 'sail/ds4-flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        expect(mocks.STANDARD_CLIENT.clone).toHaveBeenNthCalledWith(7, {
            // FLASH moved off 'vultr/glm-5.3-flash' onto the sail gateway (the
            // plain-default flash sibling of SAIL / VULTR).
            model: 'sail/glm5-flash',
            sampling: DEFAULT_SAMPLING_PARAMS
        });
        // Explicit literal, NOT Object.keys(CLIENTS): this key set is the
        // wire contract of GET /v1/storyboard/clients (generation-list-clients
        // .ts), so it is pinned as written — deriving it from the subject
        // would make the assertion tautological.
        expect(Object.keys(CLIENTS)).toEqual([
            'SAIL',
            'BASALT',
            'VULTR',
            'MAKORA',
            'KIMI',
            'DS4',
            'FLASH'
        ]);
    });

    it('resolves each known clientId to its own (mocked) client instance', () => {
        // Every selectable entry shares the same mock instance (the mocked
        // clone returns itself), so identity alone cannot tell two entries
        // apart — what makes these assertions bite is that each id below is a
        // key the CURRENT CLIENTS map actually has (pinned as a literal in the
        // Object.keys assertion above), while every id outside that map takes
        // the `?? CLIENT` branch instead (see the retired-id block below and
        // the parseClientId suite).
        expect(resolveClient('SAIL')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('BASALT')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('VULTR')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('MAKORA')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('KIMI')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('DS4')).toBe(mocks.STANDARD_CLIENT);
        expect(resolveClient('FLASH')).toBe(mocks.STANDARD_CLIENT);
    });

    it('falls back to the default client (CLIENT = CLIENTS.BASALT) for absent or unknown ids', () => {
        // The server-side default must be the same BASALT the UI defaults to
        // (store.tsx DEFAULT_CLIENT_ID), so a payload without clientId and a
        // UI-driven payload for the default id hit the same client.
        expect(CLIENT).toBe(CLIENTS.BASALT);
        expect(resolveClient()).toBe(CLIENT);
        expect(resolveClient(null)).toBe(CLIENT);
        expect(resolveClient('')).toBe(CLIENT);
        expect(resolveClient('no-such-client')).toBe(CLIENT);
        // 3235df7-retired ids must land on the default client, never on a
        // stale entry: 'STRATA' ('local/strata', dropped from CLIENTS) is the
        // regression guard for the DEFAULT_CLIENT_ID drift bug.
        expect(resolveClient('STRATA')).toBe(CLIENT);
        expect(resolveClient('KIMIK3')).toBe(CLIENT);
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
        // Every CLIENTS entry (BASALT included) derives from it via the
        // mocked clone, which never re-enters the factory.
        expect(mocks.simpleClient).toHaveBeenCalledTimes(1);
        expect(mocks.simpleConfig).toHaveBeenCalledTimes(1);
        // Endpoint mirrors runtime/secret/private/telnyx.ts: machine-local
        // localhost + the provider port from the distribution's own
        // src/config.ts (standalone replacement for @config/environment;
        // both pin port 6660).
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
        expect(parseClientId('SAIL')).toEqual({ clientId: 'SAIL' });
        expect(parseClientId('BASALT')).toEqual({ clientId: 'BASALT' });
        expect(parseClientId('VULTR')).toEqual({ clientId: 'VULTR' });
        expect(parseClientId('MAKORA')).toEqual({ clientId: 'MAKORA' });
        expect(parseClientId('KIMI')).toEqual({ clientId: 'KIMI' });
        expect(parseClientId('DS4')).toEqual({ clientId: 'DS4' });
        expect(parseClientId('FLASH')).toEqual({ clientId: 'FLASH' });
    });

    it('rejects non-string clientId values with the type error', () => {
        expect(parseClientId(7).error).toBe('clientId must be a non-empty string');
        expect(parseClientId('').error).toBe('clientId must be a non-empty string');
        expect(parseClientId({}).error).toBe('clientId must be a non-empty string');
        expect(parseClientId([]).error).toBe('clientId must be a non-empty string');
        expect(parseClientId(true).error).toBe('clientId must be a non-empty string');
    });

    it('rejects unknown clientId values, listing every available client', () => {
        // The available-client list is Object.keys(CLIENTS) in insertion order
        // (generation-config.ts:283-291) — pinned as an explicit literal, the
        // same contract GET /v1/storyboard/clients returns.
        const AVAILABLE = 'SAIL, BASALT, VULTR, MAKORA, KIMI, DS4, FLASH';
        expect(parseClientId('Nope')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'Nope'. Available clients: ${AVAILABLE}`
        });
        // Retired ids from the old CLIENTS map are rejected the same way — a
        // stale id persisted in the UI's localStorage (e.g. the pre-rename
        // default 'Qwen3_8', the 4a8a3f6-retired 'MERGEK3'/'MERGEK26'/
        // 'GLMFLASH' entries, the since-retired 'Nvidia' / 'Makora' /
        // 'DeepSeek' / 'Telnyx' entries, 'GLM53' — renamed to 'VULTR' when
        // the key switched to gateway naming — or the retired Lightning
        // 'SONNET' / 'OPUS' GPT entries) surfaces this message on the
        // next generation, which is why the UI default moved in lockstep with
        // the map changes. 'MODAL' was retired when the modal/glm-5.3 provider
        // client was removed from the registry.
        //
        // The four ids below are the 3235df7 "Upgraded Engines" casualties
        // ('local/strata' dropped; the merge-gateway KIMIK3 / KIMIK26 / MIMO26
        // trio replaced by the sail-gateway entries). They are kept here
        // BECAUSE they are now invalid: 'STRATA' in particular is the id the
        // UI's DEFAULT_CLIENT_ID was left pointing at after that commit, and
        // these assertions are the regression guard for a stale default
        // shipping a payload that 400s with exactly this message.
        expect(parseClientId('STRATA')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'STRATA'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('KIMIK3')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'KIMIK3'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('KIMIK26')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'KIMIK26'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('MIMO26')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'MIMO26'. Available clients: ${AVAILABLE}`
        });
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
        expect(parseClientId('SONNET')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'SONNET'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('OPUS')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'OPUS'. Available clients: ${AVAILABLE}`
        });
        expect(parseClientId('SOL')).toEqual({
            clientId: undefined,
            error: `Unknown clientId 'SOL'. Available clients: ${AVAILABLE}`
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
