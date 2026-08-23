/**
 * Resilience tests — CircuitBreaker, Bulkhead, FallbackChain, Cache, ShutdownManager, HealthMonitor
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from '../../resilience/circuit-breaker.js';
import {
  Bulkhead,
  BulkheadFullError,
} from '../../resilience/bulkhead.js';
import { FallbackChain } from '../../resilience/fallback.js';
import { Cache, PresentationCache } from '../../resilience/cache.js';
import { ShutdownManager } from '../../resilience/graceful-shutdown.js';
import { HealthMonitor } from '../../resilience/health-monitor.js';

// ─────────────────────────────────────────────────────────────────────────────
// CircuitBreaker
// ─────────────────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 100,
      monitorWindowMs: 60_000,
    });
  });

  it('starts in CLOSED state', () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('executes successfully in CLOSED state', async () => {
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
  });

  it('opens after reaching failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('rejects requests when OPEN', async () => {
    cb.forceState(CircuitState.OPEN);
    await expect(cb.execute(async () => 1)).rejects.toThrow(CircuitOpenError);
  });

  it('transitions to HALF_OPEN after timeout', async () => {
    cb.forceState(CircuitState.OPEN);
    await new Promise(r => setTimeout(r, 150));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it('closes on successful recovery in HALF_OPEN', async () => {
    cb.forceState(CircuitState.HALF_OPEN);
    await cb.execute(async () => 'ok');
    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('reopens on failure in HALF_OPEN', async () => {
    cb.forceState(CircuitState.HALF_OPEN);
    await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('tracks stats', async () => {
    await cb.execute(async () => 1);
    await cb.execute(async () => { throw new Error('f'); }).catch(() => {});
    const stats = cb.getStats();
    expect(stats.totalSuccesses).toBe(1);
    expect(stats.totalFailures).toBe(1);
  });

  it('emits stateChange events', async () => {
    const changes: any[] = [];
    cb.on('stateChange', (data) => changes.push(data));
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].to).toBe(CircuitState.OPEN);
  });

  it('reset clears state', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    cb.reset();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.getStats().totalFailures).toBe(0);
  });

  it('sliding window expiry: old failures do not count', async () => {
    const shortWindow = new CircuitBreaker({
      name: 'short-window',
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 100,
      monitorWindowMs: 50, // 50ms window
    });
    // Record 2 failures
    await shortWindow.execute(async () => { throw new Error('f'); }).catch(() => {});
    await shortWindow.execute(async () => { throw new Error('f'); }).catch(() => {});
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 80));
    // One more failure shouldn't open (old failures expired)
    await shortWindow.execute(async () => { throw new Error('f'); }).catch(() => {});
    expect(shortWindow.getState()).toBe(CircuitState.CLOSED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulkhead
// ─────────────────────────────────────────────────────────────────────────────

describe('Bulkhead', () => {
  it('executes under concurrency limit', async () => {
    const bh = new Bulkhead({ name: 'test', maxConcurrent: 2, maxQueue: 2, queueTimeoutMs: 1000 });
    const result = await bh.execute(async () => 42);
    expect(result).toBe(42);
  });

  it('queues when over concurrency limit', async () => {
    const bh = new Bulkhead({ name: 'test', maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    const results: number[] = [];

    const p1 = bh.execute(async () => {
      await new Promise(r => setTimeout(r, 50));
      results.push(1);
      return 1;
    });
    const p2 = bh.execute(async () => {
      results.push(2);
      return 2;
    });

    await Promise.all([p1, p2]);
    expect(results).toHaveLength(2);
  });

  it('rejects when both concurrency and queue are full', async () => {
    const bh = new Bulkhead({ name: 'test', maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 1000 });

    // Fill the one execution slot
    const p1 = bh.execute(async () => {
      await new Promise(r => setTimeout(r, 500));
      return 1;
    });

    // This should be rejected because maxConcurrent=1, maxQueue=0
    await expect(bh.execute(async () => 2)).rejects.toThrow(BulkheadFullError);

    await p1;
  });

  it('tracks stats', async () => {
    const bh = new Bulkhead({ name: 'test', maxConcurrent: 5, maxQueue: 5, queueTimeoutMs: 1000 });
    await bh.execute(async () => 1);
    await bh.execute(async () => { throw new Error('fail'); }).catch(() => {});
    const stats = bh.getStats();
    expect(stats.totalSuccesses).toBe(1);
    expect(stats.totalFailures).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FallbackChain
// ─────────────────────────────────────────────────────────────────────────────

describe('FallbackChain', () => {
  it('returns primary result on success', async () => {
    const chain = new FallbackChain<string>('test')
      .addFallback('primary', async () => 'primary-value')
      .addFallback('fallback', async () => 'fallback-value');

    const result = await chain.execute();
    expect(result.value).toBe('primary-value');
    expect(result.strategy).toBe('primary');
    expect(result.isFallback).toBe(false);
  });

  it('falls back when primary fails', async () => {
    const chain = new FallbackChain<string>('test')
      .addFallback('primary', async () => { throw new Error('fail'); })
      .addFallback('fallback', async () => 'fallback-value');

    const result = await chain.execute();
    expect(result.value).toBe('fallback-value');
    expect(result.strategy).toBe('fallback');
    expect(result.isFallback).toBe(true);
    expect(result.errors['primary']).toBeDefined();
  });

  it('throws when all strategies fail', async () => {
    const chain = new FallbackChain<string>('test')
      .addFallback('a', async () => { throw new Error('a-fail'); })
      .addFallback('b', async () => { throw new Error('b-fail'); });

    await expect(chain.execute()).rejects.toThrow('b-fail');
  });

  it('throws for empty chain', async () => {
    const chain = new FallbackChain<string>('test');
    await expect(chain.execute()).rejects.toThrow('no strategies');
  });

  it('tracks all attempted strategies', async () => {
    const chain = new FallbackChain<string>('test')
      .addFallback('a', async () => { throw new Error('a'); })
      .addFallback('b', async () => { throw new Error('b'); })
      .addFallback('c', async () => 'ok');

    const result = await chain.execute();
    expect(result.attempted).toEqual(['a', 'b', 'c']);
  });

  it('getStrategyNames returns names', () => {
    const chain = new FallbackChain<string>('test')
      .addFallback('x', async () => 'x')
      .addFallback('y', async () => 'y');
    expect(chain.getStrategyNames()).toEqual(['x', 'y']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache', () => {
  let cache: Cache<string>;

  beforeEach(() => {
    cache = new Cache<string>({ maxSize: 3, defaultTtlMs: 60_000 });
  });

  it('set and get', () => {
    cache.set('a', 'value-a');
    expect(cache.get('a')).toBe('value-a');
  });

  it('returns undefined for missing key', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('has returns true for existing, false for missing', () => {
    cache.set('x', 'y');
    expect(cache.has('x')).toBe(true);
    expect(cache.has('z')).toBe(false);
  });

  it('TTL expiry', () => {
    cache = new Cache<string>({ maxSize: 10, defaultTtlMs: 1 });
    cache.set('exp', 'value');
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(cache.get('exp')).toBeUndefined();
  });

  it('LRU eviction when at capacity', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Access 'a' to make it MRU
    cache.get('a');
    // Add a 4th item; should evict 'b' (LRU)
    cache.set('d', '4');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('d')).toBe('4');
  });

  it('getOrSet fetches on miss', async () => {
    const val = await cache.getOrSet('k', async () => 'computed');
    expect(val).toBe('computed');
    // Second call should return cached
    const val2 = await cache.getOrSet('k', async () => 'different');
    expect(val2).toBe('computed');
  });

  it('delete removes a key', () => {
    cache.set('del', 'x');
    expect(cache.delete('del')).toBe(true);
    expect(cache.get('del')).toBeUndefined();
  });

  it('clear removes everything', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });

  it('getStats returns correct stats', () => {
    cache.set('a', '1');
    cache.get('a'); // hit
    cache.get('b'); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PresentationCache
// ─────────────────────────────────────────────────────────────────────────────

describe('PresentationCache', () => {
  let pc: PresentationCache;

  beforeEach(() => {
    pc = new PresentationCache();
  });

  it('caches and retrieves metadata', () => {
    pc.setMetadata('p1', { title: 'Test' });
    expect(pc.getMetadata('p1')).toEqual({ title: 'Test' });
  });

  it('invalidates a presentation', () => {
    pc.setMetadata('p1', { title: 'Test' });
    pc.setThumbnail('p1', 's1', 'thumb-data');
    pc.invalidatePresentation('p1');
    expect(pc.getMetadata('p1')).toBeUndefined();
    expect(pc.getThumbnail('p1', 's1')).toBeUndefined();
  });

  it('clear removes all caches', () => {
    pc.setMetadata('p1', { x: 1 });
    pc.setThumbnail('p1', 's1', 'data');
    pc.clear();
    expect(pc.getMetadata('p1')).toBeUndefined();
  });

  it('getStats returns stats for all sub-caches', () => {
    const stats = pc.getStats();
    expect(stats).toHaveProperty('metadata');
    expect(stats).toHaveProperty('thumbnails');
    expect(stats).toHaveProperty('textExtractions');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ShutdownManager
// ─────────────────────────────────────────────────────────────────────────────

describe('ShutdownManager', () => {
  beforeEach(() => {
    ShutdownManager.resetInstance();
  });

  afterEach(() => {
    ShutdownManager.resetInstance();
  });

  it('registers handlers', () => {
    const sm = ShutdownManager.getInstance({ forceExitOnTimeout: false });
    sm.register('test-handler', async () => {});
    expect(sm.getHandlerNames()).toContain('test-handler');
  });

  it('unregisters handlers', () => {
    const sm = ShutdownManager.getInstance({ forceExitOnTimeout: false });
    sm.register('rm', async () => {});
    expect(sm.unregister('rm')).toBe(true);
    expect(sm.getHandlerNames()).not.toContain('rm');
  });

  it('executes handlers in priority order', async () => {
    const sm = ShutdownManager.getInstance({ forceExitOnTimeout: false });
    const order: string[] = [];
    sm.register('low', async () => { order.push('low'); }, 10);
    sm.register('high', async () => { order.push('high'); }, 100);
    sm.register('mid', async () => { order.push('mid'); }, 50);
    await sm.shutdown('test');
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('continues after handler failure', async () => {
    const sm = ShutdownManager.getInstance({ forceExitOnTimeout: false });
    const order: string[] = [];
    sm.register('fail', async () => { throw new Error('crash'); }, 100);
    sm.register('ok', async () => { order.push('ok'); }, 50);
    await sm.shutdown('test');
    expect(order).toContain('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HealthMonitor
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({ defaultIntervalMs: 999_999 }); // long interval, we test manually
  });

  afterEach(() => {
    monitor.stop();
  });

  it('registers a service', () => {
    monitor.registerService('svc', async () => ({ status: 'healthy', latencyMs: 1 }));
    expect(monitor.getServiceNames()).toContain('svc');
  });

  it('detects status transition', async () => {
    let status: 'healthy' | 'unhealthy' = 'healthy';
    monitor.registerService('flip', async () => ({ status, latencyMs: 1 }));
    const changes: any[] = [];
    monitor.onHealthChange((svc, old, nw) => changes.push({ svc, old, nw }));

    await monitor.checkServiceNow('flip');
    status = 'unhealthy';
    await monitor.checkServiceNow('flip');

    expect(changes).toHaveLength(1);
    expect(changes[0].old).toBe('healthy');
    expect(changes[0].nw).toBe('unhealthy');
  });

  it('tracks health history', async () => {
    monitor.registerService('hist', async () => ({ status: 'healthy', latencyMs: 5 }));
    await monitor.checkServiceNow('hist');
    await monitor.checkServiceNow('hist');
    const health = monitor.getServiceHealth('hist');
    expect(health).toBeDefined();
    expect(health!.history).toHaveLength(2);
  });

  it('getAllServiceHealth returns all services', () => {
    monitor.registerService('a', async () => ({ status: 'healthy', latencyMs: 1 }));
    monitor.registerService('b', async () => ({ status: 'healthy', latencyMs: 1 }));
    const all = monitor.getAllServiceHealth();
    expect(all).toHaveLength(2);
  });

  it('getStatusSummary returns status map', async () => {
    monitor.registerService('x', async () => ({ status: 'degraded', latencyMs: 1 }));
    await monitor.checkServiceNow('x');
    const summary = monitor.getStatusSummary();
    expect(summary['x']).toBe('degraded');
  });

  it('unregisterService removes service', () => {
    monitor.registerService('rm', async () => ({ status: 'healthy', latencyMs: 1 }));
    monitor.unregisterService('rm');
    expect(monitor.getServiceNames()).not.toContain('rm');
  });
});
