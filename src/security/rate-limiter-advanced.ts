/**
 * @module security/rate-limiter-advanced
 * @description Advanced rate limiting beyond the basic per-tenant token bucket.
 *
 * Provides:
 * - **SlidingWindowRateLimiter** — sliding window log algorithm for precise limiting.
 * - **AdaptiveRateLimiter** — dynamically adjusts limits based on error rates.
 * - **DDoSProtector** — IP-based limiting, slowloris detection, connection caps, auto-blocking.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security.rate-limiter-advanced');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of a rate limit check. */
export interface RateLimitCheckResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Maximum requests per window. */
  limit: number;
  /** Seconds until the window resets (for Retry-After header). */
  retryAfterSeconds: number;
}

/** Configuration for the sliding window rate limiter. */
export interface SlidingWindowConfig {
  /** Maximum requests per window. */
  maxRequests: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

/** Configuration for the adaptive rate limiter. */
export interface AdaptiveRateLimiterConfig {
  /** Starting (baseline) max requests per window. */
  baseMaxRequests: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Error rate threshold (0-1) above which limits tighten. */
  errorRateThreshold: number;
  /** Minimum multiplier for limit reduction (e.g. 0.25 = 25% of base). */
  minMultiplier: number;
  /** Maximum multiplier for limit increase (e.g. 1.5 = 150% of base). */
  maxMultiplier: number;
  /** How quickly to adjust (0-1). Higher = faster adaptation. */
  adaptationRate: number;
  /** How often to recalculate adaptive limits (ms). */
  recalculateIntervalMs: number;
}

/** Configuration for the DDoS protector. */
export interface DDoSProtectorConfig {
  /** Max requests per IP per window. */
  maxRequestsPerIp: number;
  /** Window for per-IP rate limiting (ms). */
  ipWindowMs: number;
  /** Maximum request body size in bytes. */
  maxRequestSizeBytes: number;
  /** Maximum concurrent connections per IP. */
  maxConcurrentPerIp: number;
  /** Minimum request body receive rate (bytes/sec). Slower = slowloris. */
  minBodyReceiveRate: number;
  /** Number of violations before auto-blocking an IP. */
  blockThreshold: number;
  /** How long a blocked IP stays blocked (ms). */
  blockDurationMs: number;
  /** How often to clean up expired entries (ms). */
  cleanupIntervalMs: number;
}

/** Tracked state for a single IP in the DDoS protector. */
interface IpState {
  /** Timestamps of recent requests (sliding window). */
  requestTimestamps: number[];
  /** Number of currently in-flight connections. */
  concurrentConnections: number;
  /** Cumulative violation count. */
  violations: number;
  /** If blocked, when the block expires (epoch ms). */
  blockedUntil: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SlidingWindowRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Precise rate limiter using the sliding window log algorithm.
 *
 * Unlike token bucket, this counts exact request timestamps within a
 * continuously sliding window, giving accurate per-second / per-minute limits
 * without burst-allowance distortions.
 *
 * @example
 * ```ts
 * const limiter = new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 });
 * const result = limiter.check('tenant-123');
 * if (!result.allowed) {
 *   res.status(429).set('Retry-After', String(result.retryAfterSeconds)).end();
 * }
 * ```
 */
export class SlidingWindowRateLimiter {
  private readonly windows: Map<string, number[]> = new Map();
  private readonly config: SlidingWindowConfig;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: SlidingWindowConfig) {
    this.config = config;

    // Periodically purge expired entries
    this.cleanupTimer = setInterval(() => this.cleanup(), config.windowMs * 2);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check whether a request from the given key is allowed.
   *
   * @param key - The identifier (tenant ID, user ID, IP, etc.).
   * @returns A {@link RateLimitCheckResult}.
   */
  public check(key: string): RateLimitCheckResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune timestamps outside the window
    const firstValidIndex = this.binarySearchFirstValid(timestamps, windowStart);
    if (firstValidIndex > 0) {
      timestamps.splice(0, firstValidIndex);
    }

    const currentCount = timestamps.length;
    const remaining = Math.max(0, this.config.maxRequests - currentCount);

    if (currentCount >= this.config.maxRequests) {
      // Calculate when the oldest request in the window will expire
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow !== undefined
        ? (oldestInWindow + this.config.windowMs) - now
        : this.config.windowMs;

      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequests,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    // Record this request
    timestamps.push(now);

    return {
      allowed: true,
      remaining: remaining - 1, // -1 for the request we just recorded
      limit: this.config.maxRequests,
      retryAfterSeconds: 0,
    };
  }

  /**
   * Get current request count for a key without consuming.
   */
  public getCurrentCount(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps) return 0;

    const windowStart = Date.now() - this.config.windowMs;
    const firstValid = this.binarySearchFirstValid(timestamps, windowStart);
    return timestamps.length - firstValid;
  }

  /**
   * Reset a specific key's window.
   */
  public reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Dispose the limiter and stop cleanup timers.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    this.windows.clear();
  }

  /** Binary search for the first timestamp >= windowStart. */
  private binarySearchFirstValid(timestamps: number[], windowStart: number): number {
    let lo = 0;
    let hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((timestamps[mid] as number) < windowStart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Remove keys with no recent activity. */
  private cleanup(): void {
    const windowStart = Date.now() - this.config.windowMs;
    let removed = 0;

    for (const [key, timestamps] of this.windows.entries()) {
      const lastTimestamp = timestamps[timestamps.length - 1];
      if (lastTimestamp === undefined || lastTimestamp < windowStart) {
        this.windows.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug('Sliding window cleanup', { removed, remaining: this.windows.size });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AdaptiveRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rate limiter that dynamically adjusts limits based on observed error rates.
 *
 * When the error rate exceeds the configured threshold, the effective limit
 * is reduced. When errors subside, the limit gradually recovers toward (or
 * above) baseline.
 *
 * @example
 * ```ts
 * const limiter = new AdaptiveRateLimiter({
 *   baseMaxRequests: 100,
 *   windowMs: 60_000,
 *   errorRateThreshold: 0.1,
 *   minMultiplier: 0.25,
 *   maxMultiplier: 1.5,
 *   adaptationRate: 0.1,
 *   recalculateIntervalMs: 10_000,
 * });
 *
 * // On each request outcome:
 * limiter.recordSuccess('tenant-1');
 * limiter.recordError('tenant-1');
 *
 * const result = limiter.check('tenant-1');
 * ```
 */
export class AdaptiveRateLimiter {
  private readonly config: AdaptiveRateLimiterConfig;
  private readonly inner: SlidingWindowRateLimiter;

  /** Per-key tracking of success/error counts and current multiplier. */
  private readonly stats: Map<string, {
    successes: number;
    errors: number;
    multiplier: number;
    lastRecalculated: number;
  }> = new Map();

  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: AdaptiveRateLimiterConfig) {
    this.config = config;

    // The inner limiter uses the maximum possible limit; we gate externally.
    this.inner = new SlidingWindowRateLimiter({
      maxRequests: Math.ceil(config.baseMaxRequests * config.maxMultiplier),
      windowMs: config.windowMs,
    });

    this.cleanupTimer = setInterval(() => this.cleanupStats(), config.windowMs * 2);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check whether a request is allowed under the current adaptive limit.
   */
  public check(key: string): RateLimitCheckResult {
    const stats = this.getOrCreateStats(key);
    this.maybeRecalculate(key, stats);

    const effectiveLimit = Math.max(
      1,
      Math.floor(this.config.baseMaxRequests * stats.multiplier),
    );

    const innerResult = this.inner.check(key);
    const currentCount = this.inner.getCurrentCount(key);

    if (currentCount > effectiveLimit) {
      return {
        allowed: false,
        remaining: 0,
        limit: effectiveLimit,
        retryAfterSeconds: innerResult.retryAfterSeconds || 1,
      };
    }

    return {
      allowed: innerResult.allowed,
      remaining: Math.max(0, effectiveLimit - currentCount),
      limit: effectiveLimit,
      retryAfterSeconds: innerResult.retryAfterSeconds,
    };
  }

  /**
   * Record a successful request outcome.
   */
  public recordSuccess(key: string): void {
    const stats = this.getOrCreateStats(key);
    stats.successes++;
  }

  /**
   * Record an error request outcome.
   */
  public recordError(key: string): void {
    const stats = this.getOrCreateStats(key);
    stats.errors++;
  }

  /**
   * Get the current effective limit for a key.
   */
  public getEffectiveLimit(key: string): number {
    const stats = this.stats.get(key);
    const multiplier = stats?.multiplier ?? 1.0;
    return Math.max(1, Math.floor(this.config.baseMaxRequests * multiplier));
  }

  /**
   * Get the current error rate for a key.
   */
  public getErrorRate(key: string): number {
    const stats = this.stats.get(key);
    if (!stats) return 0;
    const total = stats.successes + stats.errors;
    if (total === 0) return 0;
    return stats.errors / total;
  }

  /**
   * Reset a specific key.
   */
  public reset(key: string): void {
    this.stats.delete(key);
    this.inner.reset(key);
  }

  /**
   * Dispose the limiter and stop all timers.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    this.stats.clear();
    this.inner.dispose();
  }

  private getOrCreateStats(key: string) {
    let stats = this.stats.get(key);
    if (!stats) {
      stats = {
        successes: 0,
        errors: 0,
        multiplier: 1.0,
        lastRecalculated: Date.now(),
      };
      this.stats.set(key, stats);
    }
    return stats;
  }

  private maybeRecalculate(
    key: string,
    stats: { successes: number; errors: number; multiplier: number; lastRecalculated: number },
  ): void {
    const now = Date.now();
    if (now - stats.lastRecalculated < this.config.recalculateIntervalMs) {
      return;
    }

    const total = stats.successes + stats.errors;
    if (total === 0) {
      stats.lastRecalculated = now;
      return;
    }

    const errorRate = stats.errors / total;
    let targetMultiplier: number;

    if (errorRate > this.config.errorRateThreshold) {
      // Tighten: reduce proportionally to how far above threshold we are
      const severity = Math.min(1, (errorRate - this.config.errorRateThreshold) / (1 - this.config.errorRateThreshold));
      targetMultiplier = 1.0 - severity * (1.0 - this.config.minMultiplier);
    } else {
      // Loosen: allow gradual recovery toward maxMultiplier
      const headroom = this.config.errorRateThreshold > 0
        ? (this.config.errorRateThreshold - errorRate) / this.config.errorRateThreshold
        : 1;
      targetMultiplier = 1.0 + headroom * (this.config.maxMultiplier - 1.0);
    }

    // Smooth adaptation using exponential moving average
    stats.multiplier = stats.multiplier + this.config.adaptationRate * (targetMultiplier - stats.multiplier);

    // Clamp to bounds
    stats.multiplier = Math.max(this.config.minMultiplier, Math.min(this.config.maxMultiplier, stats.multiplier));

    // Reset counters for next interval
    stats.successes = 0;
    stats.errors = 0;
    stats.lastRecalculated = now;

    log.debug('Adaptive rate limit recalculated', {
      key,
      errorRate: errorRate.toFixed(3),
      multiplier: stats.multiplier.toFixed(3),
      effectiveLimit: Math.floor(this.config.baseMaxRequests * stats.multiplier),
    });
  }

  private cleanupStats(): void {
    const now = Date.now();
    const maxIdle = this.config.windowMs * 3;

    for (const [key, stats] of this.stats.entries()) {
      if (now - stats.lastRecalculated > maxIdle) {
        this.stats.delete(key);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DDoSProtector
// ─────────────────────────────────────────────────────────────────────────────

/** Default DDoS protection configuration. */
export const DEFAULT_DDOS_CONFIG: DDoSProtectorConfig = {
  maxRequestsPerIp: 100,
  ipWindowMs: 60_000,
  maxRequestSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxConcurrentPerIp: 50,
  minBodyReceiveRate: 500, // bytes/sec (below this = slowloris suspect)
  blockThreshold: 10,
  blockDurationMs: 15 * 60_000, // 15 minutes
  cleanupIntervalMs: 60_000,
};

/**
 * DDoS protection layer providing IP-based rate limiting, slowloris detection,
 * request size limits, concurrent connection caps, and automatic IP blocking.
 *
 * @example
 * ```ts
 * const ddos = new DDoSProtector();
 *
 * // On each incoming request:
 * const result = ddos.checkRequest('1.2.3.4', req.headers['content-length']);
 * if (!result.allowed) {
 *   res.status(429).end();
 *   return;
 * }
 *
 * ddos.trackConnectionStart('1.2.3.4');
 * // ... handle request ...
 * ddos.trackConnectionEnd('1.2.3.4');
 * ```
 */
export class DDoSProtector {
  private readonly config: DDoSProtectorConfig;
  private readonly ipStates: Map<string, IpState> = new Map();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  /** Permanently whitelisted IPs (e.g. health-check probes). */
  private readonly whitelist: Set<string> = new Set();

  constructor(config: Partial<DDoSProtectorConfig> = {}) {
    this.config = { ...DEFAULT_DDOS_CONFIG, ...config };

    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    log.info('DDoS protector initialised', {
      maxRequestsPerIp: this.config.maxRequestsPerIp,
      maxConcurrentPerIp: this.config.maxConcurrentPerIp,
      blockThreshold: this.config.blockThreshold,
      blockDurationMs: this.config.blockDurationMs,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Request Checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether an incoming request from the given IP is allowed.
   *
   * @param ip              - The client IP address.
   * @param contentLength   - The Content-Length header value (if present).
   * @returns A {@link RateLimitCheckResult}.
   */
  public checkRequest(ip: string, contentLength?: number): RateLimitCheckResult {
    // Whitelisted IPs always pass
    if (this.whitelist.has(ip)) {
      return { allowed: true, remaining: this.config.maxRequestsPerIp, limit: this.config.maxRequestsPerIp, retryAfterSeconds: 0 };
    }

    const state = this.getOrCreateIpState(ip);
    const now = Date.now();

    // Check if IP is currently blocked
    if (state.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((state.blockedUntil - now) / 1000);
      log.warn('Blocked IP attempted request', { ip, retryAfterSeconds });
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequestsPerIp,
        retryAfterSeconds,
      };
    }

    // Check request size
    if (contentLength !== undefined && contentLength > this.config.maxRequestSizeBytes) {
      this.recordViolation(ip, state, 'oversized_request');
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequestsPerIp,
        retryAfterSeconds: 1,
      };
    }

    // Check concurrent connections
    if (state.concurrentConnections >= this.config.maxConcurrentPerIp) {
      this.recordViolation(ip, state, 'concurrent_limit');
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequestsPerIp,
        retryAfterSeconds: 1,
      };
    }

    // Sliding window rate check
    const windowStart = now - this.config.ipWindowMs;
    const firstValid = this.binarySearchFirstValid(state.requestTimestamps, windowStart);
    if (firstValid > 0) {
      state.requestTimestamps.splice(0, firstValid);
    }

    if (state.requestTimestamps.length >= this.config.maxRequestsPerIp) {
      this.recordViolation(ip, state, 'rate_limit');
      const oldest = state.requestTimestamps[0];
      const retryAfterMs = oldest !== undefined
        ? (oldest + this.config.ipWindowMs) - now
        : this.config.ipWindowMs;

      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequestsPerIp,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    // Record request
    state.requestTimestamps.push(now);

    const remaining = this.config.maxRequestsPerIp - state.requestTimestamps.length;
    return {
      allowed: true,
      remaining,
      limit: this.config.maxRequestsPerIp,
      retryAfterSeconds: 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Slowloris Detection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether a request body is being received too slowly (slowloris attack).
   *
   * @param ip            - The client IP.
   * @param bytesReceived - Total bytes received so far.
   * @param elapsedMs     - Time elapsed since request started (ms).
   * @returns `true` if the transfer rate is suspiciously slow.
   */
  public isSlowloris(ip: string, bytesReceived: number, elapsedMs: number): boolean {
    if (this.whitelist.has(ip)) return false;
    if (elapsedMs < 1000) return false; // Give at least 1 second before judging

    const rate = (bytesReceived / elapsedMs) * 1000; // bytes/sec
    if (rate < this.config.minBodyReceiveRate) {
      const state = this.getOrCreateIpState(ip);
      this.recordViolation(ip, state, 'slowloris');
      log.warn('Slowloris detected', { ip, rate: Math.round(rate), threshold: this.config.minBodyReceiveRate });
      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection Tracking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Track a new connection starting from an IP.
   */
  public trackConnectionStart(ip: string): void {
    const state = this.getOrCreateIpState(ip);
    state.concurrentConnections++;
  }

  /**
   * Track a connection ending from an IP.
   */
  public trackConnectionEnd(ip: string): void {
    const state = this.ipStates.get(ip);
    if (state && state.concurrentConnections > 0) {
      state.concurrentConnections--;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IP Blocking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Manually block an IP address.
   *
   * @param ip         - The IP to block.
   * @param durationMs - Block duration in ms (default: config.blockDurationMs).
   */
  public blockIp(ip: string, durationMs?: number): void {
    const state = this.getOrCreateIpState(ip);
    state.blockedUntil = Date.now() + (durationMs ?? this.config.blockDurationMs);
    log.warn('IP manually blocked', { ip, durationMs: durationMs ?? this.config.blockDurationMs });
  }

  /**
   * Unblock an IP address.
   */
  public unblockIp(ip: string): void {
    const state = this.ipStates.get(ip);
    if (state) {
      state.blockedUntil = 0;
      state.violations = 0;
      log.info('IP unblocked', { ip });
    }
  }

  /**
   * Check whether an IP is currently blocked.
   */
  public isBlocked(ip: string): boolean {
    const state = this.ipStates.get(ip);
    if (!state) return false;
    return state.blockedUntil > Date.now();
  }

  /**
   * Get all currently blocked IPs with their block expiry times.
   */
  public getBlockedIps(): Array<{ ip: string; blockedUntil: number }> {
    const now = Date.now();
    const blocked: Array<{ ip: string; blockedUntil: number }> = [];

    for (const [ip, state] of this.ipStates.entries()) {
      if (state.blockedUntil > now) {
        blocked.push({ ip, blockedUntil: state.blockedUntil });
      }
    }

    return blocked;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Whitelist Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add an IP to the permanent whitelist.
   */
  public addToWhitelist(ip: string): void {
    this.whitelist.add(ip);
    log.info('IP added to whitelist', { ip });
  }

  /**
   * Remove an IP from the whitelist.
   */
  public removeFromWhitelist(ip: string): void {
    this.whitelist.delete(ip);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get current metrics snapshot.
   */
  public getMetrics(): {
    trackedIps: number;
    blockedIps: number;
    whitelistedIps: number;
  } {
    const now = Date.now();
    let blockedCount = 0;
    for (const state of this.ipStates.values()) {
      if (state.blockedUntil > now) blockedCount++;
    }

    return {
      trackedIps: this.ipStates.size,
      blockedIps: blockedCount,
      whitelistedIps: this.whitelist.size,
    };
  }

  /**
   * Dispose the protector and stop all timers.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    this.ipStates.clear();
    this.whitelist.clear();
    log.info('DDoS protector disposed');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  private getOrCreateIpState(ip: string): IpState {
    let state = this.ipStates.get(ip);
    if (!state) {
      state = {
        requestTimestamps: [],
        concurrentConnections: 0,
        violations: 0,
        blockedUntil: 0,
      };
      this.ipStates.set(ip, state);
    }
    return state;
  }

  private recordViolation(ip: string, state: IpState, reason: string): void {
    state.violations++;
    log.warn('DDoS violation recorded', { ip, reason, violations: state.violations, threshold: this.config.blockThreshold });

    if (state.violations >= this.config.blockThreshold) {
      state.blockedUntil = Date.now() + this.config.blockDurationMs;
      log.warn('IP auto-blocked due to repeated violations', {
        ip,
        violations: state.violations,
        blockDurationMs: this.config.blockDurationMs,
      });
    }
  }

  private binarySearchFirstValid(timestamps: number[], windowStart: number): number {
    let lo = 0;
    let hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((timestamps[mid] as number) < windowStart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.ipWindowMs;
    let removed = 0;

    for (const [ip, state] of this.ipStates.entries()) {
      // Don't clean up blocked IPs until their block expires
      if (state.blockedUntil > now) continue;

      // Remove if no recent requests and no active connections
      const lastRequest = state.requestTimestamps[state.requestTimestamps.length - 1];
      if (
        state.concurrentConnections === 0 &&
        (lastRequest === undefined || lastRequest < windowStart)
      ) {
        this.ipStates.delete(ip);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug('DDoS protector cleanup', { removed, remaining: this.ipStates.size });
    }
  }
}
