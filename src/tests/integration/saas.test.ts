/**
 * SaaS integration tests — end-to-end flows combining multiple modules
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TenantManager,
  SessionManager,
  AuthMiddleware,
} from '../../auth/index.js';
import type { AuthRequest } from '../../auth/middleware.js';
import { RateLimiter } from '../../server/rate-limiter.js';
import { EventBus } from '../../events/event-bus.js';
import type { SystemEvent, EventType } from '../../events/types.js';
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from '../../resilience/circuit-breaker.js';
import { Cache } from '../../resilience/cache.js';
import { InMemoryStorageAdapter } from '../../storage/index.js';
import { Counter, MetricsRegistry } from '../../monitoring/metrics.js';
import { AuditLogger, InMemoryAuditStorage } from '../../monitoring/audit-log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Full tenant lifecycle flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Tenant lifecycle integration', () => {
  let tm: TenantManager;
  let sm: SessionManager;
  let auth: AuthMiddleware;

  beforeEach(() => {
    tm = new TenantManager();
    sm = new SessionManager(60_000, 999_999_999);
    auth = new AuthMiddleware(tm, sm);
  });

  afterEach(() => {
    sm.dispose();
  });

  it('create tenant -> generate API key -> authenticate -> verify', () => {
    // Step 1: Create tenant
    const tenant = tm.createTenant('Integration Corp', 'int@corp.com', 'pro');
    expect(tenant.id).toBeTruthy();

    // Step 2: Generate API key
    const apiKey = tm.generateApiKey(tenant.id, 'CI Key', ['slides:read', 'slides:write']);
    expect(apiKey.key).toMatch(/^gshm_/);

    // Step 3: Authenticate with API key
    const req: AuthRequest = { headers: { 'x-api-key': apiKey.key } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(true);
    expect(result.tenant?.id).toBe(tenant.id);
    expect(result.method).toBe('api_key');
  });

  it('create tenant -> create session -> authenticate via Bearer', () => {
    const tenant = tm.createTenant('Session Corp', 'session@corp.com', 'enterprise');
    const session = sm.createSession(tenant.id, '10.0.0.1', 'TestClient/1.0');

    const req: AuthRequest = { headers: { authorization: `Bearer ${session.token}` } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(true);
    expect(result.session?.id).toBe(session.id);
  });

  it('plan upgrade updates settings', () => {
    const tenant = tm.createTenant('Upgrade Corp', 'up@corp.com', 'free');
    expect(tenant.settings.visionEnabled).toBe(false);
    expect(tenant.settings.maxPresentationsPerDay).toBe(5);

    const updated = tm.updateTenant(tenant.id, { plan: 'enterprise' });
    expect(updated.settings.visionEnabled).toBe(true);
    expect(updated.settings.maxPresentationsPerDay).toBe(500);
    expect(updated.settings.webhooksEnabled).toBe(true);
  });

  it('deleting tenant invalidates API key auth', () => {
    const tenant = tm.createTenant('Delete Corp', 'del@corp.com');
    const key = tm.generateApiKey(tenant.id, 'k', ['*']);
    tm.deleteTenant(tenant.id);

    const req: AuthRequest = { headers: { 'x-api-key': key.key } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting across multiple requests
// ─────────────────────────────────────────────────────────────────────────────

describe('Rate limiting integration', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.dispose();
  });

  it('enforces per-plan rate limits', () => {
    // Free plan: 20 requests/minute
    for (let i = 0; i < 20; i++) {
      expect(limiter.consume('free-tenant', 'free').allowed).toBe(true);
    }
    expect(limiter.consume('free-tenant', 'free').allowed).toBe(false);

    // Enterprise: still has plenty of room
    expect(limiter.consume('enterprise-tenant', 'enterprise').allowed).toBe(true);
  });

  it('rate limit headers contain correct data', () => {
    const result = limiter.consume('header-test', 'pro');
    const headers = limiter.getHeaders(result);
    expect(Number(headers['X-RateLimit-Limit'])).toBe(100);
    expect(Number(headers['X-RateLimit-Remaining'])).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event emission on operations
// ─────────────────────────────────────────────────────────────────────────────

describe('Event emission integration', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.clear();
  });

  it('emits events on presentation creation simulation', async () => {
    const received: SystemEvent[] = [];
    bus.on('presentation.created', (evt) => received.push(evt));

    // Simulate presentation creation
    bus.emit(EventBus.createEvent('presentation.created', {
      presentationId: 'pres-123',
      title: 'Test Presentation',
    }, { tenantId: 't1', source: 'api' }));

    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.data.presentationId).toBe('pres-123');
  });

  it('multiple event types flow through the bus', async () => {
    const allEvents: SystemEvent[] = [];
    bus.on('*', (evt) => allEvents.push(evt));

    bus.emit(EventBus.createEvent('tenant.created', { name: 'Acme' }));
    bus.emit(EventBus.createEvent('presentation.created', { id: 'p1' }));
    bus.emit(EventBus.createEvent('slide.created', { slideIndex: 0 }));

    await new Promise(r => setTimeout(r, 10));
    expect(allEvents).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Circuit breaker integration', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      name: 'integration-test',
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 50,
      monitorWindowMs: 60_000,
    });
  });

  it('circuit opens and recovers', async () => {
    // Cause failures
    await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise(r => setTimeout(r, 80));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // Successful call closes circuit
    await cb.execute(async () => 'recovered');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('circuit breaker wraps API call simulation', async () => {
    let apiCallCount = 0;
    const apiCall = async () => {
      apiCallCount++;
      if (apiCallCount <= 2) throw new Error('API error');
      return { slides: [] };
    };

    // First two calls fail
    await cb.execute(apiCall).catch(() => {});
    await cb.execute(apiCall).catch(() => {});

    // Circuit is now open, should reject
    await expect(cb.execute(apiCall)).rejects.toThrow(CircuitOpenError);

    // Wait and retry
    await new Promise(r => setTimeout(r, 80));
    const result = await cb.execute(apiCall);
    expect(result).toEqual({ slides: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Storage + audit integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Storage and audit integration', () => {
  let store: InMemoryStorageAdapter;
  let auditLog: AuditLogger;

  beforeEach(async () => {
    store = new InMemoryStorageAdapter();
    await store.initialize();
    auditLog = new AuditLogger(new InMemoryAuditStorage());
  });

  it('records presentation action and audit event', async () => {
    // Record in storage
    await store.recordPresentationAction({
      id: 'act-1',
      tenantId: 't1',
      presentationId: 'p1',
      action: 'create',
      metadata: JSON.stringify({ title: 'Test' }),
      createdAt: new Date().toISOString(),
    });

    // Record in audit log
    await auditLog.logPresentationEvent('presentation.created', 't1', 'p1', { title: 'Test' });

    // Verify storage
    const { items } = await store.getHistory('t1', 10, 0);
    expect(items).toHaveLength(1);

    // Verify audit
    const { items: auditItems } = await auditLog.query({ tenantId: 't1' });
    expect(auditItems).toHaveLength(1);
    expect(auditItems[0]!.action).toBe('presentation.created');
  });

  it('usage tracking across multiple operations', async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await store.recordUsage({
        id: `u-${i}`,
        tenantId: 't1',
        tool: 'create_presentation',
        layer: 'api',
        duration: 100 + i * 50,
        success: i < 4,
        createdAt: now.toISOString(),
      });
    }

    const summary = await store.getUsageSummary('t1', 'day');
    expect(summary.totalRequests).toBe(5);
    expect(summary.successRate).toBe(0.8);
    expect(summary.avgDuration).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache integration', () => {
  it('caches API results for reuse', async () => {
    const cache = new Cache<any>({ maxSize: 100, defaultTtlMs: 60_000 });
    let apiCalls = 0;

    const fetchPresentation = async (id: string) => {
      return cache.getOrSet(id, async () => {
        apiCalls++;
        return { id, title: 'Cached Presentation', slides: 10 };
      });
    };

    const result1 = await fetchPresentation('p1');
    const result2 = await fetchPresentation('p1');

    expect(result1).toEqual(result2);
    expect(apiCalls).toBe(1); // Only one actual API call
  });
});
