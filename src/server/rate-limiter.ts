/**
 * @module server/rate-limiter
 * @description Per-tenant rate limiting using the token bucket algorithm.
 *
 * Each tenant has an independent bucket sized by their subscription plan.
 * Tokens refill continuously at a steady rate. The limiter returns headers
 * compatible with the IETF RateLimit header draft.
 */

import { createLogger } from '../shared/logger.js';
import type { Plan } from '../auth/types.js';

const log = createLogger('server.rate-limiter');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of a rate limit consumption attempt. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining tokens in the bucket. */
  remaining: number;
  /** Maximum tokens for this tenant's plan. */
  limit: number;
  /** Unix timestamp (seconds) when the bucket fully refills. */
  resetAt: number;
  /** Seconds until the next token is available (0 if allowed). */
  retryAfter: number;
}

/** Rate limit headers to include in HTTP responses. */
export interface RateLimitHeaders {
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
  'X-RateLimit-Reset': string;
  'Retry-After'?: string;
}

/** Per-plan rate limit configuration. */
export interface PlanRateLimitConfig {
  /** Maximum tokens (requests) per window. */
  maxTokens: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Internal token bucket state for a single tenant. */
interface TokenBucket {
  /** Current number of tokens available. */
  tokens: number;
  /** Maximum tokens (bucket capacity). */
  maxTokens: number;
  /** Timestamp (ms) of the last token refill calculation. */
  lastRefillAt: number;
  /** Rate of token refill: tokens per millisecond. */
  refillRate: number;
  /** Window duration in ms (for reset time calculation). */
  windowMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Plan Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Default rate limits per subscription plan. */
export const DEFAULT_PLAN_RATE_LIMITS: Record<Plan, PlanRateLimitConfig> = {
  free: {
    maxTokens: 20,
    windowMs: 60_000, // 1 minute
  },
  pro: {
    maxTokens: 100,
    windowMs: 60_000,
  },
  enterprise: {
    maxTokens: 500,
    windowMs: 60_000,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RateLimiter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-tenant rate limiter using the token bucket algorithm.
 *
 * Tokens refill continuously. When a request arrives, the bucket is
 * refilled based on elapsed time, then the requested tokens are consumed.
 * If insufficient tokens remain, the request is rejected.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter();
 * const result = limiter.consume('tenant-123', 'pro');
 * if (!result.allowed) {
 *   res.status(429).set(limiter.getHeaders(result)).json({ error: 'Rate limit exceeded' });
 * }
 * ```
 */
export class RateLimiter {
  /** Token buckets keyed by tenant ID. */
  private readonly buckets: Map<string, TokenBucket> = new Map();

  /** Plan rate limit configurations. */
  private readonly planLimits: Record<Plan, PlanRateLimitConfig>;

  /** Timer for periodic cleanup of stale buckets. */
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  /** Maximum age (ms) for an idle bucket before it's cleaned up. */
  private readonly maxBucketAge: number;

  constructor(
    planLimits?: Partial<Record<Plan, PlanRateLimitConfig>>,
    cleanupIntervalMs: number = 5 * 60_000,
    maxBucketAgeMs: number = 30 * 60_000,
  ) {
    this.planLimits = {
      ...DEFAULT_PLAN_RATE_LIMITS,
      ...planLimits,
    };
    this.maxBucketAge = maxBucketAgeMs;

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleBuckets();
    }, cleanupIntervalMs);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    log.info('Rate limiter initialized', {
      plans: Object.entries(this.planLimits).map(([plan, cfg]) => ({
        plan,
        maxTokens: cfg.maxTokens,
        windowMs: cfg.windowMs,
      })),
    });
  }

  /**
   * Attempt to consume tokens from a tenant's bucket.
   *
   * @param tenantId - The tenant identifier.
   * @param plan - The tenant's subscription plan (determines bucket size).
   * @param tokens - Number of tokens to consume (default 1).
   * @returns A {@link RateLimitResult} indicating whether the request is allowed.
   */
  public consume(tenantId: string, plan: Plan, tokens: number = 1): RateLimitResult {
    const config = this.planLimits[plan];
    const bucket = this.getOrCreateBucket(tenantId, config);
    const now = Date.now();

    // Refill tokens based on elapsed time
    this.refill(bucket, now);

    // Calculate reset time (when bucket would be full from now)
    const tokensNeededForFull = bucket.maxTokens - bucket.tokens;
    const msToFull = tokensNeededForFull > 0 ? tokensNeededForFull / bucket.refillRate : 0;
    const resetAt = Math.ceil((now + msToFull) / 1000);

    if (bucket.tokens >= tokens) {
      // Consume tokens
      bucket.tokens -= tokens;

      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: bucket.maxTokens,
        resetAt,
        retryAfter: 0,
      };
    }

    // Not enough tokens — calculate when enough will be available
    const deficit = tokens - bucket.tokens;
    const msUntilAvailable = deficit / bucket.refillRate;
    const retryAfter = Math.ceil(msUntilAvailable / 1000);

    log.debug('Rate limit exceeded', {
      tenantId,
      plan,
      tokensRequested: tokens,
      tokensAvailable: Math.floor(bucket.tokens),
      retryAfterSeconds: retryAfter,
    });

    return {
      allowed: false,
      remaining: 0,
      limit: bucket.maxTokens,
      resetAt,
      retryAfter,
    };
  }

  /**
   * Get remaining tokens for a tenant without consuming.
   *
   * @param tenantId - The tenant identifier.
   * @param plan - The tenant's plan.
   * @returns Number of remaining tokens.
   */
  public getRemainingTokens(tenantId: string, plan: Plan): number {
    const config = this.planLimits[plan];
    const bucket = this.getOrCreateBucket(tenantId, config);
    this.refill(bucket, Date.now());
    return Math.floor(bucket.tokens);
  }

  /**
   * Build rate limit headers from a consumption result.
   *
   * @param result - The rate limit result.
   * @returns An object of header name/value pairs.
   */
  public getHeaders(result: RateLimitResult): RateLimitHeaders {
    const headers: RateLimitHeaders = {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(result.resetAt),
    };

    if (!result.allowed) {
      headers['Retry-After'] = String(result.retryAfter);
    }

    return headers;
  }

  /**
   * Reset a tenant's bucket (e.g. after plan upgrade).
   *
   * @param tenantId - The tenant identifier.
   */
  public reset(tenantId: string): void {
    this.buckets.delete(tenantId);
  }

  /**
   * Get current bucket count (for metrics).
   */
  public get bucketCount(): number {
    return this.buckets.size;
  }

  /**
   * Dispose the rate limiter and stop cleanup timers.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
    log.info('Rate limiter disposed');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internal
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Get or create a token bucket for a tenant.
   */
  private getOrCreateBucket(tenantId: string, config: PlanRateLimitConfig): TokenBucket {
    let bucket = this.buckets.get(tenantId);

    if (!bucket) {
      bucket = {
        tokens: config.maxTokens,
        maxTokens: config.maxTokens,
        lastRefillAt: Date.now(),
        refillRate: config.maxTokens / config.windowMs,
        windowMs: config.windowMs,
      };
      this.buckets.set(tenantId, bucket);
    }

    // If plan changed (different maxTokens), update the bucket
    if (bucket.maxTokens !== config.maxTokens) {
      bucket.maxTokens = config.maxTokens;
      bucket.refillRate = config.maxTokens / config.windowMs;
      bucket.windowMs = config.windowMs;
      // Don't reset current tokens — allow graceful transition
    }

    return bucket;
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refill(bucket: TokenBucket, now: number): void {
    const elapsed = now - bucket.lastRefillAt;
    if (elapsed <= 0) return;

    const tokensToAdd = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;
  }

  /**
   * Remove buckets that haven't been touched recently.
   */
  private cleanupStaleBuckets(): void {
    const now = Date.now();
    let removed = 0;

    for (const [tenantId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefillAt > this.maxBucketAge) {
        this.buckets.delete(tenantId);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug('Cleaned up stale rate limit buckets', {
        removed,
        remaining: this.buckets.size,
      });
    }
  }
}
