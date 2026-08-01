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
import {
    GLM52_CLIENT,
    KIMI3_CLIENT,
    LIGHTNING_CLIENT,
    NVIDIA_CLIENT,
    OPENCODE_CLIENT,
    OPENROUTER_CLIENT
} from '@runtime/secret/private';

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
// File System Paths (relative to project root)
// ---------------------------------------------------------------------------

/** Root directory where generated story data is persisted. */
export const DATABASE_BASE_DIR = 'temporary/database/storyboard';

// ---------------------------------------------------------------------------
// Pre-configured LLM Client
// ---------------------------------------------------------------------------

/**
 * Which client method to use for structured output.
 *   - "structure" — tool-calling (works with all providers)
 *   - "format"    — native structured output / response_format (stricter, fewer retries)
 */
export const useApiMethod: 'structure' | 'format' = 'format';

// List of possible clients
export const CLIENTS = {
    Nvidia: NVIDIA_CLIENT.clone({ model: 'z-ai/glm-5.2' }),
    OpenCode: OPENCODE_CLIENT.clone({ model: 'deepseek-v4-flash' }),
    Lightning: LIGHTNING_CLIENT.clone({ model: 'anthropic/claude-opus-4-7' }),
    GLM52: GLM52_CLIENT,
    KIMIK3: KIMI3_CLIENT,
    Makora: MAKORA_CLIENT.clone({ model: 'zai-org/GLM-5.2-NVFP4' }),
    Router: OPENROUTER_CLIENT.clone({ model: 'deepseek/deepseek-v4-flash-0731' })
};

export const CLIENT = CLIENTS.Nvidia;
