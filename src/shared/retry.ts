/**
 * @module shared/retry
 * @description Retry utilities with exponential backoff and jitter.
 * Provides generic retry wrappers as well as Google-Slides-API-aware
 * retry logic that respects 429 / 5xx responses.
 */

import type { RetryConfig, RateLimitConfig } from './types.js';
import {
  SlidesApiError,
  RateLimitError,
  isRetryableError,
} from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('shared.retry');

// ─────────────────────────────────────────────────────────────────────────────
// Default Configurations
// ─────────────────────────────────────────────────────────────────────────────

/** Sensible defaults for the generic retry wrapper. */
export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  backoffFactor: 2,
};

/** Retry config tuned for the Google Slides API (stricter limits). */
export const GOOGLE_API_RETRY_CONFIG: Readonly<RetryConfig> = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 60_000,
  backoffFactor: 2,
};

/** Default rate-limit configuration aligned with Google Slides API quotas. */
export const DEFAULT_RATE_LIMIT_CONFIG: Readonly<RateLimitConfig> = {
  maxRequests: 60,
  intervalMs: 60_000,
  maxConcurrent: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the delay for attempt `n` using exponential back-off with
 * full jitter (see AWS Architecture Blog recommendation).
 *
 * delay = min(maxDelay, random_between(0, baseDelay * backoffFactor^attempt))
 */
export function computeBackoffDelay(
  attempt: number,
  config: RetryConfig,
): number {
  const exponential =
    config.baseDelay * Math.pow(config.backoffFactor, attempt);
  const capped = Math.min(exponential, config.maxDelay);
  // Full jitter: uniform random in [0, capped], with a minimum floor of 100ms
  // to avoid zero-delay retries that would hammer the API.
  return Math.max(100, Math.floor(Math.random() * capped));
}

/**
 * Sleep for a given number of milliseconds.
 * Returns a promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a retry-after hint (in ms) from an error, if present.
 * Handles our custom {@link RateLimitError} as well as raw Google API
 * error responses that include a `Retry-After` header.
 */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof RateLimitError) {
    return error.retryAfterMs;
  }

  // Google API errors sometimes expose headers.
  const err = error as Record<string, unknown> | undefined;
  const headers = (err?.response as Record<string, unknown>)?.headers as
    | Record<string, string>
    | undefined;
  const retryAfterHeader = headers?.['retry-after'];
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }
  }

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Retry Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `fn` with automatic retries on transient failures.
 *
 * @typeParam T - The resolved type of `fn`.
 * @param fn - An async function to execute (and potentially retry).
 * @param config - Retry behaviour configuration.
 * @param shouldRetry - Optional predicate to override the default
 *   retryability check. Return `true` to retry, `false` to bail.
 * @returns The resolved value of `fn`.
 * @throws The last error encountered if all retries are exhausted.
 *
 * @example
 * ```ts
 * const data = await withRetry(
 *   () => fetchPresentation(id),
 *   { maxRetries: 3, baseDelay: 500, maxDelay: 10_000, backoffFactor: 2 },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  shouldRetry?: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check retryability.
      const retryable = shouldRetry
        ? shouldRetry(error)
        : isRetryableError(error);

      if (!retryable || attempt === config.maxRetries) {
        log.warn('Non-retryable or final attempt reached', {
          attempt,
          maxRetries: config.maxRetries,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Prefer an explicit retry-after from the server; fall back to backoff.
      const serverDelay = extractRetryAfterMs(error);
      const backoffDelay = computeBackoffDelay(attempt, config);
      const delay = serverDelay ?? backoffDelay;

      log.info('Retrying after transient failure', {
        attempt: attempt + 1,
        maxRetries: config.maxRetries,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(delay);
    }
  }

  // Should be unreachable, but satisfies the type checker.
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-Limit-Aware Retry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `fn` with retry logic that is specifically aware of HTTP 429
 * rate-limit responses.  When a 429 is received the wrapper will
 * honour the `Retry-After` header (or fall back to exponential backoff).
 *
 * @typeParam T - The resolved type of `fn`.
 * @param fn - An async function to execute.
 * @param retryConfig - Retry behaviour configuration.
 * @returns The resolved value of `fn`.
 */
export async function withRateLimit<T>(
  fn: () => Promise<T>,
  retryConfig: RetryConfig = GOOGLE_API_RETRY_CONFIG,
): Promise<T> {
  return withRetry(fn, retryConfig, (error) => {
    // Always retry on explicit rate-limit errors.
    if (error instanceof RateLimitError) {
      return true;
    }

    // Retry on Google API 429.
    if (error instanceof SlidesApiError && error.statusCode === 429) {
      return true;
    }

    // Fall back to generic retryability check for 5xx etc.
    return isRetryableError(error);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Slides API Retry
// ─────────────────────────────────────────────────────────────────────────────

/** HTTP status codes that the Google Slides API considers retryable. */
const GOOGLE_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
]);

/**
 * Retry wrapper specifically tuned for Google Slides API calls.
 *
 * - Retries on 429, 500, 502, 503.
 * - Respects `Retry-After` headers on 429 responses.
 * - Uses a more aggressive retry config (up to 5 retries, 60 s max delay).
 *
 * @typeParam T - The resolved type of `fn`.
 * @param fn - An async function making a Google Slides API call.
 * @returns The resolved value of `fn`.
 */
export async function withGoogleApiRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return withRetry(fn, GOOGLE_API_RETRY_CONFIG, (error) => {
    if (error instanceof SlidesApiError) {
      return GOOGLE_RETRYABLE_STATUS_CODES.has(error.statusCode);
    }

    // Raw googleapis errors may expose `code` or `response.status`.
    const err = error as Record<string, unknown> | undefined;
    const status =
      (err?.code as number) ??
      ((err?.response as Record<string, unknown>)?.status as number);
    if (typeof status === 'number') {
      return GOOGLE_RETRYABLE_STATUS_CODES.has(status);
    }

    return false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeout Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an async function with a hard timeout.
 *
 * An internal `AbortController` is created so that the caller's function
 * can optionally check `signal.aborted` to cooperatively cancel work
 * when the timeout fires.  Pass `signal` through to any fetch or
 * long-running operation inside `fn` that supports `AbortSignal`.
 *
 * @param fn - The function to execute. Receives an `AbortSignal` that is
 *   aborted when the timeout fires.
 * @param timeoutMs - Maximum time to wait, in milliseconds.
 * @param label - An optional label used in the timeout error message.
 * @returns The resolved value of `fn`.
 * @throws Error if the timeout is exceeded.
 */
export async function withTimeout<T>(
  fn: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>),
  timeoutMs: number,
  label = 'Operation',
): Promise<T> {
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn(controller.signal)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error as Error);
      });
  });
}
