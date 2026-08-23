/**
 * Server tests — RateLimiter, Health endpoints, Metrics, REST API routes
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter, DEFAULT_PLAN_RATE_LIMITS } from '../../server/rate-limiter.js';
import { MetricsCollector, createHealthRouter } from '../../server/health.js';

// ─────────────────────────────────────────────────────────────────────────────
// RateLimiter (Token Bucket)
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.dispose();
  });

  it('allows request within limit', () => {
    const result = limiter.consume('t1', 'free');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
    expect(result.limit).toBe(DEFAULT_PLAN_RATE_LIMITS.free.maxTokens);
  });

  it('free plan has lower limit than pro', () => {
    expect(DEFAULT_PLAN_RATE_LIMITS.free.maxTokens).toBeLessThan(DEFAULT_PLAN_RATE_LIMITS.pro.maxTokens);
  });

  it('pro plan has lower limit than enterprise', () => {
    expect(DEFAULT_PLAN_RATE_LIMITS.pro.maxTokens).toBeLessThan(DEFAULT_PLAN_RATE_LIMITS.enterprise.maxTokens);
  });

  it('rejects after consuming all tokens', () => {
    const plan = 'free';
    const max = DEFAULT_PLAN_RATE_LIMITS[plan].maxTokens;
    for (let i = 0; i < max; i++) {
      limiter.consume('exhaust', plan);
    }
    const result = limiter.consume('exhaust', plan);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('consume with custom token count', () => {
    const result = limiter.consume('t2', 'enterprise', 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DEFAULT_PLAN_RATE_LIMITS.enterprise.maxTokens - 5);
  });

  it('getRemainingTokens returns correct value', () => {
    limiter.consume('t3', 'pro');
    const remaining = limiter.getRemainingTokens('t3', 'pro');
    expect(remaining).toBe(DEFAULT_PLAN_RATE_LIMITS.pro.maxTokens - 1);
  });

  it('getHeaders returns correct format', () => {
    const result = limiter.consume('t4', 'free');
    const headers = limiter.getHeaders(result);
    expect(headers['X-RateLimit-Limit']).toBeDefined();
    expect(headers['X-RateLimit-Remaining']).toBeDefined();
    expect(headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('getHeaders includes Retry-After when rejected', () => {
    const max = DEFAULT_PLAN_RATE_LIMITS.free.maxTokens;
    for (let i = 0; i < max; i++) limiter.consume('retry', 'free');
    const result = limiter.consume('retry', 'free');
    const headers = limiter.getHeaders(result);
    expect(headers['Retry-After']).toBeDefined();
  });

  it('reset clears a tenant bucket', () => {
    limiter.consume('reset-test', 'free');
    limiter.reset('reset-test');
    const remaining = limiter.getRemainingTokens('reset-test', 'free');
    expect(remaining).toBe(DEFAULT_PLAN_RATE_LIMITS.free.maxTokens);
  });

  it('tracks bucket count', () => {
    limiter.consume('a', 'free');
    limiter.consume('b', 'pro');
    expect(limiter.bucketCount).toBe(2);
  });

  it('different tenants are independent', () => {
    const max = DEFAULT_PLAN_RATE_LIMITS.free.maxTokens;
    for (let i = 0; i < max; i++) limiter.consume('full', 'free');
    expect(limiter.consume('full', 'free').allowed).toBe(false);
    expect(limiter.consume('other', 'free').allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MetricsCollector
// ─────────────────────────────────────────────────────────────────────────────

describe('MetricsCollector', () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = new MetricsCollector();
  });

  it('renders Prometheus format', () => {
    mc.incRequestsTotal('GET', 200);
    mc.incPresentationsCreated();
    const text = mc.render();
    expect(text).toContain('# HELP gslides_requests_total');
    expect(text).toContain('# TYPE gslides_requests_total counter');
    expect(text).toContain('gslides_presentations_created_total 1');
  });

  it('tracks active sessions gauge', () => {
    mc.activeSessions = 5;
    expect(mc.activeSessions).toBe(5);
    expect(mc.render()).toContain('gslides_active_sessions 5');
  });

  it('tracks request duration histogram', () => {
    mc.observeRequestDuration('GET', 0.05);
    mc.observeRequestDuration('GET', 0.5);
    const text = mc.render();
    expect(text).toContain('gslides_request_duration_seconds_bucket');
    expect(text).toContain('gslides_request_duration_seconds_sum');
    expect(text).toContain('gslides_request_duration_seconds_count');
  });

  it('tracks API errors by type', () => {
    mc.incApiErrors('auth');
    mc.incApiErrors('auth');
    mc.incApiErrors('validation');
    const text = mc.render();
    expect(text).toContain('gslides_api_errors_total{type="auth"} 2');
    expect(text).toContain('gslides_api_errors_total{type="validation"} 1');
  });

  it('includes uptime gauge', () => {
    const text = mc.render();
    expect(text).toContain('gslides_uptime_seconds');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health Router
// ─────────────────────────────────────────────────────────────────────────────

describe('Health Router', () => {
  it('creates a router with health, ready, and metrics routes', () => {
    const router = createHealthRouter();
    expect(router).toBeDefined();
    // Express Router has a stack of layer objects
    const routes = (router as any).stack?.map((layer: any) => layer.route?.path).filter(Boolean);
    expect(routes).toContain('/health');
    expect(routes).toContain('/ready');
    expect(routes).toContain('/metrics');
  });
});
