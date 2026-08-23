/**
 * Monitoring tests — Metrics, Tracing, AlertManager, AuditLogger, HealthChecker
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  Summary,
  MetricsRegistry,
} from '../../monitoring/metrics.js';
import { Tracer } from '../../monitoring/tracing.js';
import { AlertManager } from '../../monitoring/alerts.js';
import type { AlertRule } from '../../monitoring/alerts.js';
import { AuditLogger, InMemoryAuditStorage } from '../../monitoring/audit-log.js';
import { HealthChecker } from '../../monitoring/health-checker.js';

// ─────────────────────────────────────────────────────────────────────────────
// MetricsRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    MetricsRegistry.resetInstance();
    registry = MetricsRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
    MetricsRegistry.resetInstance();
  });

  it('creates a counter', () => {
    const c = registry.counter('test_counter', 'A test counter');
    expect(c.type).toBe('counter');
    c.inc();
    expect(c.get()).toBe(1);
  });

  it('creates a gauge', () => {
    const g = registry.gauge('test_gauge', 'A test gauge');
    g.set(42);
    expect(g.get()).toBe(42);
  });

  it('creates a histogram', () => {
    const h = registry.histogram('test_hist', 'A test histogram', [0.1, 0.5, 1]);
    h.observe(0.3);
    const snap = h.get();
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(1);
    expect(snap!.sum).toBeCloseTo(0.3);
  });

  it('creates a summary', () => {
    const s = registry.summary('test_summary', 'A test summary', [0.5, 0.99]);
    s.observe(100);
    s.observe(200);
    const snap = s.get();
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(2);
  });

  it('returns same metric on duplicate registration', () => {
    const c1 = registry.counter('dup', 'help');
    const c2 = registry.counter('dup', 'help');
    expect(c1).toBe(c2);
  });

  it('throws on type mismatch', () => {
    registry.counter('mismatch', 'help');
    expect(() => registry.gauge('mismatch', 'help')).toThrow();
  });

  it('lists metric names', () => {
    registry.counter('a', 'h');
    registry.gauge('b', 'h');
    const names = registry.getMetricNames();
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('unregisters a metric', () => {
    registry.counter('rm', 'h');
    expect(registry.unregister('rm')).toBe(true);
    expect(registry.getMetric('rm')).toBeUndefined();
  });

  it('resetAll clears values but keeps registrations', () => {
    const c = registry.counter('x', 'h');
    c.inc({}, 5);
    registry.resetAll();
    expect(c.get()).toBe(0);
    expect(registry.getMetric('x')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Counter
// ─────────────────────────────────────────────────────────────────────────────

describe('Counter', () => {
  it('increments by 1 by default', () => {
    const c = new Counter('c', 'h');
    c.inc();
    expect(c.get()).toBe(1);
  });

  it('increments by custom delta', () => {
    const c = new Counter('c', 'h');
    c.inc({}, 5);
    expect(c.get()).toBe(5);
  });

  it('throws on negative delta', () => {
    const c = new Counter('c', 'h');
    expect(() => c.inc({}, -1)).toThrow();
  });

  it('handles labels correctly', () => {
    const c = new Counter('c', 'h', ['method']);
    c.inc({ method: 'GET' }, 3);
    c.inc({ method: 'POST' }, 2);
    expect(c.get({ method: 'GET' })).toBe(3);
    expect(c.get({ method: 'POST' })).toBe(2);
    expect(c.get({})).toBe(0); // no label
  });

  it('renders Prometheus format', () => {
    const c = new Counter('my_counter', 'My counter');
    c.inc({}, 5);
    const lines = c.render();
    expect(lines).toContain('# HELP my_counter My counter');
    expect(lines).toContain('# TYPE my_counter counter');
    expect(lines.some(l => l.includes('5'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gauge
// ─────────────────────────────────────────────────────────────────────────────

describe('Gauge', () => {
  it('sets and gets value', () => {
    const g = new Gauge('g', 'h');
    g.set(10);
    expect(g.get()).toBe(10);
  });

  it('increments and decrements', () => {
    const g = new Gauge('g', 'h');
    g.inc();
    g.inc({}, 4);
    expect(g.get()).toBe(5);
    g.dec();
    expect(g.get()).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Histogram
// ─────────────────────────────────────────────────────────────────────────────

describe('Histogram', () => {
  it('counts observations into buckets', () => {
    const h = new Histogram('h', 'help', [1, 5, 10]);
    h.observe(0.5);
    h.observe(3);
    h.observe(7);
    h.observe(15);
    const snap = h.get();
    expect(snap!.count).toBe(4);
    expect(snap!.buckets.get(1)).toBe(1);   // 0.5 <= 1
    expect(snap!.buckets.get(5)).toBe(2);   // 0.5 and 3 <= 5
    expect(snap!.buckets.get(10)).toBe(3);  // 0.5, 3, 7 <= 10
  });

  it('renders Prometheus format with _bucket, _sum, _count', () => {
    const h = new Histogram('req_dur', 'Duration', [0.1, 1]);
    h.observe(0.05);
    const lines = h.render();
    expect(lines.some(l => l.includes('req_dur_bucket'))).toBe(true);
    expect(lines.some(l => l.includes('req_dur_sum'))).toBe(true);
    expect(lines.some(l => l.includes('req_dur_count'))).toBe(true);
    expect(lines.some(l => l.includes('+Inf'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

describe('Summary', () => {
  it('computes quantiles', () => {
    const s = new Summary('s', 'h', [0.5, 0.99]);
    for (let i = 1; i <= 100; i++) s.observe(i);
    const snap = s.get();
    expect(snap).not.toBeNull();
    expect(snap!.quantiles.get(0.5)).toBeGreaterThanOrEqual(49);
    expect(snap!.quantiles.get(0.5)).toBeLessThanOrEqual(51);
    expect(snap!.quantiles.get(0.99)).toBeGreaterThanOrEqual(98);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus text output
// ─────────────────────────────────────────────────────────────────────────────

describe('Prometheus text output', () => {
  it('generates valid exposition format', () => {
    MetricsRegistry.resetInstance();
    const reg = MetricsRegistry.getInstance();
    reg.counter('test_total', 'Test counter').inc();
    reg.gauge('test_gauge', 'Test gauge').set(42);
    const text = reg.toPrometheusText();
    expect(text).toContain('# HELP test_total');
    expect(text).toContain('# TYPE test_total counter');
    expect(text).toContain('# TYPE test_gauge gauge');
    expect(text).toContain('42');
    reg.clear();
    MetricsRegistry.resetInstance();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tracer
// ─────────────────────────────────────────────────────────────────────────────

describe('Tracer', () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer();
  });

  it('creates a span with trace and span IDs', () => {
    const span = tracer.startSpan('test-op');
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.parentSpanId).toBeNull();
    expect(span.name).toBe('test-op');
  });

  it('ends a span', () => {
    const span = tracer.startSpan('test');
    expect(span.endTime).toBeNull();
    tracer.endSpan(span);
    expect(span.endTime).not.toBeNull();
    expect(span.status).toBe('ok');
  });

  it('creates nested spans with parent link', () => {
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child', parent);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
  });

  it('withSpan wraps async function', async () => {
    const result = await tracer.withSpan('op', async () => 42);
    expect(result).toBe(42);
    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.status).toBe('ok');
  });

  it('withSpan sets error status on throw', async () => {
    await expect(
      tracer.withSpan('fail', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    const completed = tracer.getCompletedSpans();
    expect(completed[0]!.status).toBe('error');
  });

  it('async context propagation via withSpan', async () => {
    const completed: any[] = [];
    tracer.addExporter((span) => completed.push(span));
    await tracer.withSpan('outer', async () => {
      await tracer.withSpan('inner', async () => {
        // just execute
      });
    });
    expect(completed).toHaveLength(2);
    // inner span completed first, outer second
    const innerSpan = completed.find((s: any) => s.name === 'inner');
    const outerSpan = completed.find((s: any) => s.name === 'outer');
    expect(innerSpan).toBeDefined();
    expect(outerSpan).toBeDefined();
    // Inner should share same traceId as outer
    expect(innerSpan.traceId).toBe(outerSpan.traceId);
  });

  it('addEvent adds events to span', () => {
    const span = tracer.startSpan('test');
    tracer.addEvent(span, 'checkpoint', { count: 1 });
    expect(span.events).toHaveLength(1);
    expect(span.events[0]!.name).toBe('checkpoint');
  });

  it('setAttribute sets attribute', () => {
    const span = tracer.startSpan('test');
    tracer.setAttribute(span, 'key', 'value');
    expect(span.attributes['key']).toBe('value');
  });

  it('exporter receives completed spans', () => {
    const exported: any[] = [];
    tracer.addExporter((span) => exported.push(span));
    const span = tracer.startSpan('test');
    tracer.endSpan(span);
    expect(exported).toHaveLength(1);
  });

  it('exporter errors do not crash', () => {
    tracer.addExporter(() => { throw new Error('exporter crash'); });
    const span = tracer.startSpan('test');
    expect(() => tracer.endSpan(span)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertManager
// ─────────────────────────────────────────────────────────────────────────────

describe('AlertManager', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  const makeRule = (name: string, value: number, threshold: number): AlertRule => ({
    name,
    evaluate: () => value,
    condition: (v, t) => v > t,
    threshold,
    windowMs: 60_000,
    severity: 'warning',
    message: `Value is {value} (threshold: ${threshold})`,
    cooldownMs: 0,
  });

  it('adds a rule', () => {
    manager.addRule(makeRule('test', 10, 5));
    expect(manager.getRules()).toHaveLength(1);
  });

  it('silently skips duplicate rule name', () => {
    manager.addRule(makeRule('dup', 10, 5));
    manager.addRule(makeRule('dup', 10, 5)); // should not throw
    expect(manager.getRules()).toHaveLength(1);
  });

  it('removes a rule', () => {
    manager.addRule(makeRule('rm', 10, 5));
    expect(manager.removeRule('rm')).toBe(true);
    expect(manager.getRules()).toHaveLength(0);
  });

  it('evaluates and fires alerts when condition met', async () => {
    manager.addRule(makeRule('high', 10, 5));
    const fired = await manager.evaluate();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.ruleName).toBe('high');
    expect(fired[0]!.state).toBe('firing');
  });

  it('does not fire when condition not met', async () => {
    manager.addRule(makeRule('low', 1, 5));
    const fired = await manager.evaluate();
    expect(fired).toHaveLength(0);
  });

  it('respects cooldown period', async () => {
    const rule = makeRule('cool', 10, 5);
    rule.cooldownMs = 60_000; // 1 minute
    manager.addRule(rule);

    const first = await manager.evaluate();
    expect(first).toHaveLength(1);

    const second = await manager.evaluate();
    expect(second).toHaveLength(0); // in cooldown
  });

  it('stores alerts in history', async () => {
    manager.addRule(makeRule('hist', 10, 5));
    await manager.evaluate();
    expect(manager.getHistory()).toHaveLength(1);
  });

  it('clears history', async () => {
    manager.addRule(makeRule('hist', 10, 5));
    await manager.evaluate();
    manager.clearHistory();
    expect(manager.getHistory()).toHaveLength(0);
  });

  it('tracks rule state', async () => {
    manager.addRule(makeRule('state', 10, 5));
    await manager.evaluate();
    expect(manager.getRuleState('state')).toBe('firing');
  });

  it('dispatches to channels', async () => {
    const sent: any[] = [];
    manager.addChannel({ name: 'test', send: async (alert) => { sent.push(alert); } });
    manager.addRule(makeRule('ch', 10, 5));
    await manager.evaluate();
    // Channel send is fire-and-forget; give it a tick
    await new Promise(r => setTimeout(r, 10));
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AuditLogger
// ─────────────────────────────────────────────────────────────────────────────

describe('AuditLogger', () => {
  let auditLog: AuditLogger;
  let storage: InMemoryAuditStorage;

  beforeEach(() => {
    storage = new InMemoryAuditStorage();
    auditLog = new AuditLogger(storage);
  });

  it('logs an audit event', async () => {
    const event = await auditLog.log({
      timestamp: new Date().toISOString(),
      tenantId: 't1',
      action: 'tenant.created',
      resource: 'tenant',
      details: { name: 'Acme' },
    });
    expect(event.id).toBeTruthy();
    expect(event.outcome).toBe('success');
  });

  it('queries events by tenantId', async () => {
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'tenant.created', resource: 'tenant', details: {} });
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't2', action: 'tenant.created', resource: 'tenant', details: {} });
    const { items } = await auditLog.query({ tenantId: 't1' });
    expect(items).toHaveLength(1);
  });

  it('queries events by action', async () => {
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'tenant.created', resource: 'tenant', details: {} });
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'apikey.generated', resource: 'apikey', details: {} });
    const { items } = await auditLog.query({ action: 'tenant.created' });
    expect(items).toHaveLength(1);
  });

  it('queries with wildcard action', async () => {
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'tenant.created', resource: 'tenant', details: {} });
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'tenant.updated', resource: 'tenant', details: {} });
    await auditLog.log({ timestamp: new Date().toISOString(), tenantId: 't1', action: 'apikey.generated', resource: 'apikey', details: {} });
    const { items } = await auditLog.query({ action: 'tenant.*' });
    expect(items).toHaveLength(2);
  });

  it('convenience method logTenantEvent', async () => {
    const ev = await auditLog.logTenantEvent('tenant.created', 't1', { name: 'Acme' });
    expect(ev.action).toBe('tenant.created');
    expect(ev.resource).toBe('tenant');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HealthChecker
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthChecker', () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker({ version: '1.0.0-test' });
  });

  it('runs all checks and returns a report', async () => {
    const report = await checker.runAllChecks();
    expect(report.status).toBeTruthy();
    expect(report.version).toBe('1.0.0-test');
    expect(report.components.length).toBeGreaterThan(0);
    expect(report.timestamp).toBeTruthy();
  });

  it('reports degraded for unregistered external checkers', async () => {
    const result = await checker.checkGoogleSlidesApi();
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('not registered');
  });

  it('runs registered checker successfully', async () => {
    checker.setChecker('google_slides_api', async () => ({
      status: 'healthy',
      message: 'API responsive',
    }));
    const result = await checker.checkGoogleSlidesApi();
    expect(result.status).toBe('healthy');
  });

  it('reports unhealthy when checker throws', async () => {
    checker.setChecker('database', async () => { throw new Error('Connection refused'); });
    const result = await checker.checkDatabase();
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('Connection refused');
  });

  it('overall status is worst of all components', async () => {
    checker.setChecker('google_slides_api', async () => ({ status: 'healthy', message: 'ok' }));
    checker.setChecker('database', async () => ({ status: 'unhealthy', message: 'down' }));
    const report = await checker.runAllChecks();
    expect(report.status).toBe('unhealthy');
  });

  it('memory check returns valid result', async () => {
    const result = await checker.checkMemory();
    expect(result.component).toBe('memory');
    expect(result.details.usedMb).toBeGreaterThan(0);
    expect(result.details.totalMb).toBeGreaterThan(0);
  });

  it('removes a checker', () => {
    checker.setChecker('test', async () => ({ status: 'healthy', message: 'ok' }));
    expect(checker.removeChecker('test')).toBe(true);
  });
});
