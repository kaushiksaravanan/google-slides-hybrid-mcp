/**
 * @module resilience/fallback
 * @description Fallback strategy chains for graceful degradation.
 *
 * Provides `FallbackChain<T>` — a composable chain of strategies that are
 * tried in order until one succeeds.  This enables the server to degrade
 * gracefully when a primary service is unavailable (e.g. return cached
 * data, use a rule-based heuristic instead of AI vision, or fall back
 * from browser automation to the REST API).
 *
 * Pre-built chains are provided for common MCP server scenarios.
 */

import { createLogger } from '../shared/logger.js';
import { Cache } from './cache.js';

const log = createLogger('resilience.fallback');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A named fallback strategy. */
export interface FallbackStrategy<T> {
  /** Human-readable name for logging. */
  name: string;
  /** The async function to attempt. */
  fn: () => Promise<T>;
}

/** Result of executing a fallback chain. */
export interface FallbackResult<T> {
  /** The value returned by the successful strategy. */
  value: T;
  /** Name of the strategy that produced the result. */
  strategy: string;
  /** Whether a fallback was used (i.e. not the primary strategy). */
  isFallback: boolean;
  /** Names of strategies that were attempted (in order). */
  attempted: string[];
  /** Errors from failed strategies, keyed by strategy name. */
  errors: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// FallbackChain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A composable chain of fallback strategies.
 *
 * Strategies are tried in the order they were added.  The first strategy
 * to succeed short-circuits the chain.  If all strategies fail, the last
 * error is thrown.
 *
 * Usage:
 * ```ts
 * const chain = new FallbackChain<Presentation>('get-presentation')
 *   .addFallback('api', () => slidesApi.get(id))
 *   .addFallback('cache', () => cache.get(id))
 *   .addFallback('default', async () => defaultPresentation);
 *
 * const result = await chain.execute();
 * console.log(`Result from: ${result.strategy}`);
 * ```
 */
export class FallbackChain<T> {
  private readonly strategies: FallbackStrategy<T>[] = [];
  private readonly chainName: string;

  constructor(chainName: string) {
    this.chainName = chainName;
  }

  /**
   * Add a fallback strategy to the end of the chain.
   * @returns `this` for fluent chaining.
   */
  addFallback(name: string, fn: () => Promise<T>): this {
    this.strategies.push({ name, fn });
    return this;
  }

  /**
   * Execute the chain: try each strategy in order until one succeeds.
   *
   * @returns A `FallbackResult<T>` describing which strategy succeeded
   *          and which were attempted.
   * @throws The last error if all strategies fail.
   */
  async execute(): Promise<FallbackResult<T>> {
    if (this.strategies.length === 0) {
      throw new Error(`FallbackChain "${this.chainName}" has no strategies`);
    }

    const attempted: string[] = [];
    const errors: Record<string, string> = {};
    let lastError: unknown;

    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i]!;
      attempted.push(strategy.name);

      try {
        log.debug('Trying fallback strategy', {
          chain: this.chainName,
          strategy: strategy.name,
          index: i,
        });

        const value = await strategy.fn();

        const isFallback = i > 0;
        if (isFallback) {
          log.info('Fallback strategy succeeded', {
            chain: this.chainName,
            strategy: strategy.name,
            attemptedCount: attempted.length,
          });
        }

        return {
          value,
          strategy: strategy.name,
          isFallback,
          attempted,
          errors,
        };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        errors[strategy.name] = message;

        log.warn('Fallback strategy failed', {
          chain: this.chainName,
          strategy: strategy.name,
          error: message,
          remainingStrategies: this.strategies.length - i - 1,
        });
      }
    }

    // All strategies exhausted
    log.error('All fallback strategies exhausted', {
      chain: this.chainName,
      attempted,
      errors,
    });
    throw lastError;
  }

  /** Get the number of strategies in the chain. */
  get length(): number {
    return this.strategies.length;
  }

  /** Get the names of all strategies in order. */
  getStrategyNames(): string[] {
    return this.strategies.map((s) => s.name);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built Fallback Chains
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fallback chain that wraps an API call with a cached-result
 * fallback.  If the API call fails, the chain returns the last known
 * good result from the cache.  If no cached result exists, a default
 * value is returned.
 *
 * @param name - Chain name for logging.
 * @param apiFn - The primary API function to call.
 * @param cache - The cache instance to use.
 * @param cacheKey - The key under which results are cached.
 * @param defaultValue - A last-resort default value.
 */
export function apiWithCacheFallback<T>(
  name: string,
  apiFn: () => Promise<T>,
  cache: Cache<T>,
  cacheKey: string,
  defaultValue: T,
): FallbackChain<T> {
  return new FallbackChain<T>(name)
    .addFallback('api-call', async () => {
      const result = await apiFn();
      // Cache the successful result for future fallbacks
      cache.set(cacheKey, result);
      return result;
    })
    .addFallback('cache', async () => {
      const cached = cache.get(cacheKey);
      if (cached === undefined) {
        throw new Error('No cached result available');
      }
      return cached;
    })
    .addFallback('default', async () => defaultValue);
}

/**
 * Create a fallback chain for vision analysis that falls back to a
 * rule-based structural analysis when the AI vision layer is unavailable.
 *
 * @param name - Chain name for logging.
 * @param visionFn - The primary AI-powered vision analysis function.
 * @param structuralFn - A rule-based fallback function that analyzes
 *                       structure without AI (e.g. alignment checks,
 *                       font consistency, colour contrast ratios).
 * @param defaultResult - A last-resort default analysis result.
 */
export function visionWithStructuralFallback<T>(
  name: string,
  visionFn: () => Promise<T>,
  structuralFn: () => Promise<T>,
  defaultResult: T,
): FallbackChain<T> {
  return new FallbackChain<T>(name)
    .addFallback('ai-vision', visionFn)
    .addFallback('structural-rules', structuralFn)
    .addFallback('default', async () => defaultResult);
}

/**
 * Create a fallback chain that tries a browser-based action first, then
 * falls back to the Google Slides REST API if the browser is unavailable.
 *
 * @param name - Chain name for logging.
 * @param browserFn - The primary browser automation function.
 * @param apiFn - The REST API fallback function.
 */
export function browserWithApiFallback<T>(
  name: string,
  browserFn: () => Promise<T>,
  apiFn: () => Promise<T>,
): FallbackChain<T> {
  return new FallbackChain<T>(name)
    .addFallback('browser', browserFn)
    .addFallback('api', apiFn);
}
