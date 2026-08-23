/**
 * @module resilience/health-monitor
 * @description Continuous health monitoring with history tracking.
 *
 * Periodically probes each registered service and maintains a rolling
 * health history.  Integrates with the circuit breaker system (auto-opens
 * circuits when a service becomes unhealthy) and the metrics system
 * (reports health gauge values).
 *
 * This is distinct from the one-shot `HealthChecker` in `monitoring/` —
 * the HealthMonitor runs *continuously* and tracks state transitions
 * over time rather than producing a single point-in-time report.
 */

import { createLogger } from '../shared/logger.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitState } from './circuit-breaker.js';

const log = createLogger('resilience.health-monitor');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Health status for a monitored service. */
export type ServiceHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** A single health check result stored in history. */
export interface HealthCheckRecord {
  /** ISO-8601 timestamp of the check. */
  timestamp: string;
  /** Status observed at this check. */
  status: ServiceHealthStatus;
  /** Round-trip latency of the check in ms. */
  latencyMs: number;
  /** Optional message or error from the check. */
  message?: string;
}

/** Full health state for a service including history. */
export interface ServiceHealth {
  /** Service identifier. */
  service: string;
  /** Current health status. */
  status: ServiceHealthStatus;
  /** When the current status was first observed. */
  since: string;
  /** Number of consecutive checks at the current status. */
  consecutiveCount: number;
  /** Rolling history of health checks (newest first). */
  history: HealthCheckRecord[];
}

/** A function that performs a health check for a service. */
export type HealthCheckFn = () => Promise<{
  status: ServiceHealthStatus;
  latencyMs: number;
  message?: string;
}>;

/** Configuration for a registered service. */
interface ServiceRegistration {
  name: string;
  checkFn: HealthCheckFn;
  intervalMs: number;
  circuitBreaker?: CircuitBreaker;
}

/** Configuration for the HealthMonitor. */
export interface HealthMonitorConfig {
  /** Default check interval in ms. */
  defaultIntervalMs: number;
  /** Maximum number of history records to keep per service. */
  maxHistoryPerService: number;
  /** Check timeout in ms. */
  checkTimeoutMs: number;
}

/** Callback type for health-change events. */
export type HealthChangeCallback = (
  service: string,
  oldStatus: ServiceHealthStatus,
  newStatus: ServiceHealthStatus,
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// HealthMonitor
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: HealthMonitorConfig = {
  defaultIntervalMs: 30_000,
  maxHistoryPerService: 100,
  checkTimeoutMs: 10_000,
};

/**
 * Continuous health monitor that periodically probes registered services
 * and maintains a rolling health history per service.
 *
 * Usage:
 * ```ts
 * const monitor = new HealthMonitor();
 * monitor.registerService('google-slides-api', checkSlides, { circuitBreaker });
 * monitor.onHealthChange((svc, oldS, newS) => alert(`${svc}: ${oldS} -> ${newS}`));
 * monitor.start();
 * ```
 */
export class HealthMonitor {
  private readonly config: HealthMonitorConfig;
  private readonly services = new Map<string, ServiceRegistration>();
  private readonly history = new Map<string, HealthCheckRecord[]>();
  private readonly currentStatus = new Map<string, ServiceHealthStatus>();
  private readonly statusSince = new Map<string, string>();
  private readonly consecutiveCounts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly changeCallbacks: HealthChangeCallback[] = [];
  private running = false;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Service registration ──────────────────────────────────────────────

  /**
   * Register a service for continuous health monitoring.
   *
   * @param name - Service identifier.
   * @param checkFn - Async function that performs the health check.
   * @param options - Optional overrides and circuit breaker integration.
   */
  registerService(
    name: string,
    checkFn: HealthCheckFn,
    options?: {
      intervalMs?: number;
      circuitBreaker?: CircuitBreaker;
    },
  ): void {
    if (this.services.has(name)) {
      log.warn('Service already registered — replacing', { service: name });
      this.unregisterService(name);
    }

    this.services.set(name, {
      name,
      checkFn,
      intervalMs: options?.intervalMs ?? this.config.defaultIntervalMs,
      circuitBreaker: options?.circuitBreaker,
    });

    this.history.set(name, []);
    this.currentStatus.set(name, 'healthy'); // assume healthy until proven otherwise
    this.statusSince.set(name, new Date().toISOString());
    this.consecutiveCounts.set(name, 0);

    log.info('Service registered for health monitoring', {
      service: name,
      intervalMs: options?.intervalMs ?? this.config.defaultIntervalMs,
      hasCircuitBreaker: !!options?.circuitBreaker,
    });

    // If the monitor is already running, start checking this service immediately
    if (this.running) {
      this.startServiceTimer(name);
    }
  }

  /**
   * Unregister a service and stop its health checks.
   */
  unregisterService(name: string): boolean {
    this.stopServiceTimer(name);
    this.services.delete(name);
    this.history.delete(name);
    this.currentStatus.delete(name);
    this.statusSince.delete(name);
    this.consecutiveCounts.delete(name);
    return true;
  }

  // ── Control ───────────────────────────────────────────────────────────

  /**
   * Start continuous monitoring for all registered services.
   * Each service is checked on its own interval.
   */
  start(): void {
    if (this.running) {
      log.warn('Health monitor already running');
      return;
    }

    this.running = true;

    for (const [name] of this.services) {
      this.startServiceTimer(name);
    }

    log.info('Health monitor started', { serviceCount: this.services.size });
  }

  /**
   * Stop all health check timers.
   */
  stop(): void {
    if (!this.running) return;

    for (const [name] of this.timers) {
      this.stopServiceTimer(name);
    }

    this.running = false;
    log.info('Health monitor stopped');
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * Get the full health state for a specific service.
   */
  getServiceHealth(service: string): ServiceHealth | undefined {
    if (!this.services.has(service)) return undefined;

    return {
      service,
      status: this.currentStatus.get(service) ?? 'unhealthy',
      since: this.statusSince.get(service) ?? new Date().toISOString(),
      consecutiveCount: this.consecutiveCounts.get(service) ?? 0,
      history: [...(this.history.get(service) ?? [])],
    };
  }

  /**
   * Get health state for all registered services.
   */
  getAllServiceHealth(): ServiceHealth[] {
    const result: ServiceHealth[] = [];
    for (const [name] of this.services) {
      const health = this.getServiceHealth(name);
      if (health) result.push(health);
    }
    return result;
  }

  /**
   * Get just the current status for all services.
   */
  getStatusSummary(): Record<string, ServiceHealthStatus> {
    const summary: Record<string, ServiceHealthStatus> = {};
    for (const [name, status] of this.currentStatus) {
      summary[name] = status;
    }
    return summary;
  }

  /** Whether the monitor is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Get the list of registered service names. */
  getServiceNames(): string[] {
    return [...this.services.keys()];
  }

  // ── Event subscription ────────────────────────────────────────────────

  /**
   * Register a callback that fires when a service transitions between
   * health statuses (e.g. healthy -> degraded).
   *
   * @param callback - Invoked with (service, oldStatus, newStatus).
   * @returns A dispose function to remove the callback.
   */
  onHealthChange(callback: HealthChangeCallback): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      const idx = this.changeCallbacks.indexOf(callback);
      if (idx !== -1) this.changeCallbacks.splice(idx, 1);
    };
  }

  // ── Manual check ──────────────────────────────────────────────────────

  /**
   * Manually trigger a health check for a specific service.
   * Useful for ad-hoc probes outside the normal interval.
   */
  async checkServiceNow(service: string): Promise<HealthCheckRecord | undefined> {
    const reg = this.services.get(service);
    if (!reg) {
      log.warn('Cannot check unregistered service', { service });
      return undefined;
    }
    return this.performCheck(reg);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private startServiceTimer(name: string): void {
    const reg = this.services.get(name);
    if (!reg) return;

    // Run an immediate check, then schedule periodic checks
    void this.performCheck(reg);

    const timer = setInterval(() => {
      void this.performCheck(reg);
    }, reg.intervalMs);

    if (timer.unref) {
      timer.unref();
    }

    this.timers.set(name, timer);
  }

  private stopServiceTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
  }

  /**
   * Perform a single health check for a service, update state, and
   * fire events as needed.
   */
  private async performCheck(reg: ServiceRegistration): Promise<HealthCheckRecord> {
    const { name, checkFn, circuitBreaker } = reg;
    let record: HealthCheckRecord;

    try {
      // Run the check with a timeout
      const result = await Promise.race([
        checkFn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Health check timed out after ${this.config.checkTimeoutMs}ms`)),
            this.config.checkTimeoutMs,
          ),
        ),
      ]);

      record = {
        timestamp: new Date().toISOString(),
        status: result.status,
        latencyMs: result.latencyMs,
        message: result.message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        timestamp: new Date().toISOString(),
        status: 'unhealthy',
        latencyMs: 0,
        message,
      };
    }

    // Update history
    const hist = this.history.get(name) ?? [];
    hist.unshift(record); // newest first
    if (hist.length > this.config.maxHistoryPerService) {
      hist.length = this.config.maxHistoryPerService;
    }
    this.history.set(name, hist);

    // Detect status transition
    const previousStatus = this.currentStatus.get(name) ?? 'healthy';
    const newStatus = record.status;

    if (newStatus === previousStatus) {
      // Same status — increment consecutive count
      this.consecutiveCounts.set(name, (this.consecutiveCounts.get(name) ?? 0) + 1);
    } else {
      // Status changed — reset counter and fire event
      this.currentStatus.set(name, newStatus);
      this.statusSince.set(name, record.timestamp);
      this.consecutiveCounts.set(name, 1);

      log.info('Service health status changed', {
        service: name,
        from: previousStatus,
        to: newStatus,
        message: record.message,
      });

      // Fire change callbacks
      for (const callback of this.changeCallbacks) {
        try {
          callback(name, previousStatus, newStatus);
        } catch (cbError) {
          const cbMsg = cbError instanceof Error ? cbError.message : String(cbError);
          log.error('Health change callback error', { service: name, error: cbMsg });
        }
      }

      // Integrate with circuit breaker
      if (circuitBreaker) {
        this.updateCircuitBreaker(circuitBreaker, newStatus);
      }
    }

    return record;
  }

  /**
   * Update a circuit breaker based on health status.
   *
   * - unhealthy -> force circuit OPEN
   * - healthy -> no action (let the circuit breaker's own recovery logic handle it)
   * - degraded -> no action (service is still functional)
   */
  private updateCircuitBreaker(
    cb: CircuitBreaker,
    status: ServiceHealthStatus,
  ): void {
    if (status === 'unhealthy' && cb.getState() !== CircuitState.OPEN) {
      log.warn('Forcing circuit breaker OPEN due to unhealthy service', {
        circuit: cb.name,
      });
      cb.forceState(CircuitState.OPEN);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built health check functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a health check function that tests an HTTP endpoint.
 * Returns healthy if the response status is 2xx, degraded for 5xx,
 * unhealthy on timeout or connection error.
 *
 * @param url - The health endpoint URL to probe.
 * @param timeoutMs - Request timeout in ms.
 */
export function createHttpHealthCheck(
  url: string,
  timeoutMs = 5000,
): HealthCheckFn {
  return async () => {
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      const latencyMs = Math.round(performance.now() - start);

      if (response.ok) {
        return { status: 'healthy', latencyMs };
      }

      if (response.status >= 500) {
        return {
          status: 'degraded',
          latencyMs,
          message: `HTTP ${response.status}`,
        };
      }

      return {
        status: 'unhealthy',
        latencyMs,
        message: `HTTP ${response.status}`,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'unhealthy', latencyMs, message };
    }
  };
}

/**
 * Create a health check function from a simple async boolean probe.
 *
 * @param probe - Returns `true` if the service is healthy.
 * @param degradedProbe - Optional: returns `true` if the service is
 *                        at least degraded (not fully down).
 */
export function createSimpleHealthCheck(
  probe: () => Promise<boolean>,
  degradedProbe?: () => Promise<boolean>,
): HealthCheckFn {
  return async () => {
    const start = performance.now();
    try {
      const healthy = await probe();
      const latencyMs = Math.round(performance.now() - start);

      if (healthy) {
        return { status: 'healthy', latencyMs };
      }

      // If not healthy, check for degraded
      if (degradedProbe) {
        const degraded = await degradedProbe();
        if (degraded) {
          return { status: 'degraded', latencyMs, message: 'Service is degraded' };
        }
      }

      return { status: 'unhealthy', latencyMs, message: 'Health probe returned false' };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'unhealthy', latencyMs, message };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global health monitor instance. */
export const healthMonitor = new HealthMonitor();
