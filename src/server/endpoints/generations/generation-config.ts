// ---------------------------------------------------------------------------
// Generation Config — single source of truth for all story generation settings.
//
// Every tunable value used by generation-create-new-story.ts lives here.
// To change model, prompts, timeouts, retries, or path layout, modify
// this file only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation Priming
// ---------------------------------------------------------------------------

import { MAKORA_CLIENT } from '@runtime/secret/private/makora';
import { GLM52_CLIENT, KIMI3_CLIENT, NVIDIA_CLIENT, OPENROUTER_CLIENT, QWEN3_8_CLIENT } from '@runtime/secret/private';
import { TELNYX_CLIENT } from '@runtime/secret/private/telnyx';
// Type-only import: every selectable client is a SimpleClient instance
// (simpleClient() in @agentic/harness), used to widen CLIENTS for the
// request-driven string indexing in resolveClient().
import type { SimpleClient } from '@agentic/harness';

/** First user message seeded into the conversation history. */
export const OPENING_USER_MESSAGE = 'Hey ENI';

/** Second user message seeded into the conversation history. */
export const STORY_REQUEST_MESSAGE = 'You know the story I like';

// ---------------------------------------------------------------------------
// Retry & Timeout
// ---------------------------------------------------------------------------

/** Maximum number of attempts when plotpoint validation fails. */
export const MAX_PLOT_ATTEMPTS = 3;

/**
 * Timeout (in milliseconds) for each expand-chapter LLM call.
 * If the LLM does not respond within this window the request is
 * terminated and retried.
 */
export const EXPAND_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Content Requirements
// ---------------------------------------------------------------------------

/** Minimum word count for each expanded chapter. */
export const MIN_WORDS_PER_CHAPTER = 3000;

/** Target word count stated in the expansion prompt to the LLM. */
export const TARGET_WORD_COUNT_PROMPT = '15,000 words';

/** Minimum plotpoints per chapter requested in the plot outline prompt. */
export const MIN_PLOTPOINTS_PER_CHAPTER = 10;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Phrases that indicate the LLM refused to write the story.
 * Used during plotpoint validation — if any plotpoint contains one of
 * these patterns the response is rejected and retried.
 */
export const REFUSAL_PATTERNS: string[] = ['I cannot fulfill'];

// ---------------------------------------------------------------------------
// Rolling Context Window
// ---------------------------------------------------------------------------

/**
 * Number of immediately previous *expanded* chapters to keep in the context
 * when expanding the next chapter. Set to 1 (the default) to include only
 * the most recent expanded chapter. Higher values give the LLM more
 * continuous prose to work with but increase token usage.
 */
export const PREVIOUS_EXPANDED_CHAPTERS = 4;

// ---------------------------------------------------------------------------
// Stall Detection
// ---------------------------------------------------------------------------

/** Maximum number of retries when progressive plotpoint streaming stalls. */
export const MAX_STALL_RETRIES = 10;

/**
 * Duration (ms) after the last progressive write beyond which streaming is
 * considered stalled. If no new data is received for this long, the LLM call
 * is terminated and retried (up to MAX_STALL_RETRIES times).
 */
export const PLOTPOINT_STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Story Retry on Failure
// ---------------------------------------------------------------------------

/**
 * Maximum number of story entries to create (original + retries) when
 * plotpoint generation keeps failing. Each failure marks the current story
 * as "complete" (without chapter expansion) and spins up a new story entry.
 */
export const MAX_STORY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// File System Paths (relative to the injected temporary/database root)
// ---------------------------------------------------------------------------

/** Distribution-owned directory where generated story data is persisted. */
export const DATABASE_BASE_DIR = 'storyboard';

// ---------------------------------------------------------------------------
// Pre-configured LLM Client
// ---------------------------------------------------------------------------

// SGLang-compatible defaults for the GLM-5.2 API. These values are attached to
// every story-generation client so plotpoint, validation, chapter expansion,
// retry, fork, and rewrite requests all use the same sampling behavior.
// `max_tokens` is intentionally omitted because the deployment leaves the
// completion limit unset unless a caller supplies one explicitly.
export const DEFAULT_SAMPLING_PARAMS = {
    temperature: 1.0,
    top_p: 0.95,
    // -1 is NOT a bug / not a truncation to 1 token. In SGLang (and older
    // vLLM) sampling semantics, top_k = -1 is the sentinel for "top-k
    // filtering disabled" — the full vocabulary is considered, leaving nucleus
    // sampling (top_p = 0.95 above) as the only truncation mechanism. A
    // positive value (e.g. 20, as used in deployment/kaggle/modal scripts)
    // would restrict sampling to the k most likely tokens instead.
    // WARNING: some backends reject -1 (they require top_k >= 0 and use 0 as
    // the "disabled" sentinel) — see QWEN3_8_SAMPLING_PARAMS below for that
    // variant. The value is passed through verbatim into the chat request body
    // by simple-client.ts (SimpleClientSamplingParams, line 80); passthrough
    // asserted at simple-client.test.ts:1348 / :1398.
    top_k: -1,
    min_p: 0.0,
    presence_penalty: 0.0,
    frequency_penalty: 0.0,
    repetition_penalty: 1.0
} as const;

// Qwen3_8 runs on a ninfer backend whose OpenAI-compatible endpoint validates
// top_k >= 0 and rejects the -1 sentinel with HTTP 400 ("top_k must be
// nonnegative"). Use 0 instead — vLLM semantics define top_k = 0 as "consider
// all tokens" ("Set to 0 (or -1) to consider all tokens" in vllm/
// sampling_params.py), so generation behavior is identical to the SGLang
// default above; only the wire encoding differs.
export const QWEN3_8_SAMPLING_PARAMS = {
    ...DEFAULT_SAMPLING_PARAMS,
    top_k: 0
};

/**
 * Which client method to use for structured output.
 *   - "structure" — tool-calling (works with all providers)
 *   - "format"    — native structured output / response_format (stricter, fewer retries)
 *
 * Backend constraint (Qwen3_8 / ninfer deployment): 'format' is NOT usable —
 * the ninfer engine hard-rejects any response_format other than {type:"text"}
 * with HTTP 400 response_format_not_supported (no constrained decoding exists
 * upstream), which surfaces as "400 only response_format {type:text} is
 * supported". Tool-call STREAMING on that backend is restored by a proxy
 * polyfill (deployment/qwen3_8/modal_qwen3_8_rtx6000_ninfer.py,
 * _rewrite_body_for_tool_streaming): the engine itself buffers tool calls
 * post-generation, so the proxy strips tools upstream, streams the model's
 * <tool_call> content immediately, and re-emits it as incremental OpenAI
 * delta.tool_calls[].function.arguments chunks — keeping progressive
 * onUpdate (plotpoint writes + stall detection) functional with
 * useApiMethod = 'structure'.
 */
export const useApiMethod: 'structure' | 'format' = 'structure';

// List of possible clients
export const CLIENTS = {
    Nvidia: NVIDIA_CLIENT.clone({ model: 'z-ai/glm-5.2', sampling: DEFAULT_SAMPLING_PARAMS }),
    Modal: GLM52_CLIENT.clone({ sampling: DEFAULT_SAMPLING_PARAMS }),
    KIMIK3: KIMI3_CLIENT.clone({ sampling: DEFAULT_SAMPLING_PARAMS }),
    // Uses QWEN3_8_SAMPLING_PARAMS (top_k: 0) because the ninfer backend
    // rejects the SGLang-style top_k: -1 sentinel; all other values unchanged.
    Qwen3_8: QWEN3_8_CLIENT.clone({ sampling: QWEN3_8_SAMPLING_PARAMS }),
    Makora: MAKORA_CLIENT.clone({ model: 'zai-org/GLM-5.2-NVFP4', sampling: DEFAULT_SAMPLING_PARAMS }),
    // Makora: MAKORA_CLIENT.clone({ model: 'deepseek-ai/DeepSeek-V4-Flash', sampling: DEFAULT_SAMPLING_PARAMS }),
    Router: OPENROUTER_CLIENT.clone({ model: 'deepseek/deepseek-v4-flash-0731', sampling: DEFAULT_SAMPLING_PARAMS }),
    Telnyx: TELNYX_CLIENT.clone({ sampling: DEFAULT_SAMPLING_PARAMS })
};

/**
 * The default story-generation client, used when a request does not specify a
 * clientId. Kept for backward compatibility with code/tests that import CLIENT
 * directly — treat resolveClient() as the canonical selector.
 */
export const CLIENT = CLIENTS.Qwen3_8;

// ---------------------------------------------------------------------------
// Client Selection (per-request clientId)
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM client for a request-supplied clientId.
 *
 * The clientId is intentionally NOT persisted anywhere (no plotpoint.json
 * field, no DB row) — it changes per request and travels with every payload
 * (story creation, expansion, rewrite, fork). It is resolved against CLIENTS
 * here, the single source of truth for selectable story clients.
 *
 * Fallback behaviour: an absent, empty, or unknown clientId resolves to the
 * default client (CLIENT = CLIENTS.Qwen3_8) so a missing value can never
 * crash a generation. Request payloads that carry an EXPLICIT unknown id are
 * rejected earlier by parseClientId() — this fallback only covers calls that
 * never set a clientId at all.
 */
export const resolveClient = (clientId?: string | null) => {
    if (!clientId) return CLIENT;
    // hasOwnProperty guard: CLIENTS is a plain object, so unguarded indexing
    // would resolve inherited names ('toString', 'constructor', ...) to
    // prototype methods. The requestId is a runtime string, not the literal
    // keys of CLIENTS, hence the Record widening (every client is a
    // SimpleClient from simpleClient() in
    // packages/agentic/harness/simple/modules/simple-client.ts:550).
    // Explicit malformed payloads are rejected upstream by parseClientId;
    // the ?? CLIENT fallback covers ids absent from this deployment.
    const selected: SimpleClient | undefined = Object.prototype.hasOwnProperty.call(CLIENTS, clientId)
        ? (CLIENTS as Record<string, SimpleClient>)[clientId]
        : undefined;
    return selected ?? CLIENT;
};

/**
 * Validate a raw clientId value from a request payload (POST/PATCH body).
 *
 * Returns:
 *   - { clientId }           when absent (undefined/null) or a known key of
 *                            CLIENTS (the key string is echoed back).
 *   - { error }              when the value is present but invalid:
 *                            non-string/empty → 'clientId must be a non-empty string'
 *                            unknown id       → 'Unknown clientId …' listing every
 *                            available key so the UI/caller can self-correct.
 *
 * Used by generation-create-new-story.ts (POST, incl. the fork branch) and
 * generation-update-chapter.ts (PATCH) so both endpoints share one validation
 * contract.
 */
export const parseClientId = (raw: unknown): { clientId?: string; error?: string } => {
    // Absent values are legal — generation falls back to the default client.
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'string' || raw.length === 0) {
        return { error: 'clientId must be a non-empty string' };
    }
    // hasOwnProperty guards against 'toString', 'constructor', etc. being
    // passed as a clientId when CLIENTS (a plain object) is indexed.
    if (!Object.prototype.hasOwnProperty.call(CLIENTS, raw)) {
        return {
            error: `Unknown clientId '${raw}'. Available clients: ${Object.keys(CLIENTS).join(', ')}`
        };
    }
    return { clientId: raw };
};
