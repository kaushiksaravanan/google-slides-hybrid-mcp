/**
 * @module resilience/circuit-breaker
 * @description Circuit breaker pattern implementation for service isolation.
 *
 * Implements the three-state circuit breaker (CLOSED, OPEN, HALF_OPEN) with:
 * - A sliding-window failure counter that accurately tracks failures within
 *   a configurable time window.
 * - Automatic transition from OPEN to HALF_OPEN after a configurable timeout.
 * - Configurable success threshold in HALF_OPEN before closing the circuit.
 * - Event emission for state changes, failures, successes, and rejections.
 *
 * Named circuit breakers are provided for the four core services:
 * Google Slides API, Google Drive API, Browser Connection, and Vision Analysis.
 */

import EventEmitter from 'node:events';
import { createLogger } from '../shared/logger.js';

const log = createLogger('resilience.circuit-breaker');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The three possible states of a circuit breaker. */
export enum CircuitState {
  /** Normal operation — requests flow through. */
  CLOSED = 'CLOSED',
  /** Circuit tripped — all requests are rejected immediately. */
  OPEN = 'OPEN',
  /** Testing recovery — limited requests allowed through. */
  HALF_OPEN = 'HALF_OPEN',
}

/** Configuration for a CircuitBreaker instance. */
export interface CircuitBreakerConfig {
  /** Human-readable name for this circuit (used in logs and events). */
  name: string;
  /** Number of failures within `monitorWindowMs` before the circuit opens. */
  failureThreshold: number;
  /** Number of consecutive successes in HALF_OPEN needed to close the circuit. */
  successThreshold: number;
  /** Time in ms the circuit stays OPEN before transitioning to HALF_OPEN. */
  timeoutMs: number;
  /** Sliding window size in ms for failure counting. */
  monitorWindowMs: number;
}

/** Event types emitted by a CircuitBreaker. */
export interface CircuitBreakerEvents {
  stateChange: { from: CircuitState; to: CircuitState; name: string };
  failure: { name: string; error: unknown; state: CircuitState };
  success: { name: string; state: CircuitState };
  rejected: { name: string; state: CircuitState };
}

/** Statistics snapshot for a CircuitBreaker. */
export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  /** Total number of successful calls since creation or last reset. */
  totalSuccesses: number;
  /** Total number of failed calls since creation or last reset. */
  totalFailures: number;
  /** Total number of requests rejected due to OPEN state. */
  totalRejections: number;
  /** Number of failures in the current sliding window. */
  windowFailures: number;
  /** Consecutive successes counted during current HALF_OPEN phase. */
  halfOpenSuccesses: number;
  /** Timestamp (ms) when the circuit last opened, or 0. */
  lastOpenedAt: number;
  /** Timestamp (ms) when the circuit last closed, or 0. */
  lastClosedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a request is rejected because the circuit is OPEN.
 */
export class CircuitOpenError extends Error {
  public readonly circuitName: string;
  public readonly retryAfterMs: number;

  constructor(circuitName: string, retryAfterMs: number) {
    super(
      `Circuit "${circuitName}" is OPEN — request rejected. ` +
      `Retry after ${retryAfterMs}ms.`,
    );
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding Window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A time-based sliding window that tracks failure timestamps.
 *
 * Only timestamps within the window are counted.  Old timestamps are
 * lazily pruned on each `count()` call — no background timers needed.
 */
class SlidingWindow {
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Record a failure at the current time. */
  record(): void {
    this.timestamps.push(Date.now());
  }

  /** Return the number of failures within the sliding window. */
  count(): number {
    this.prune();
    return this.timestamps.length;
  }

  /** Remove all timestamps outside the window. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    // Binary search would be faster for very large arrays, but the
    // expected cardinality (< failureThreshold, typically 5-20) makes
    // a simple filter perfectly adequate.
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }

  /** Clear all recorded timestamps. */
  reset(): void {
    this.timestamps = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CircuitBreaker
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30_000,
  monitorWindowMs: 60_000,
};

/**
 * Circuit breaker implementation for service isolation.
 *
 * Usage:
 * ```ts
 * const cb = new CircuitBreaker({ name: 'google-slides-api' });
 * const result = await cb.execute(() => slidesClient.getPresentation(id));
 * ```
 */
export class CircuitBreaker extends EventEmitter {
  private readonly config: CircuitBreakerConfig;
  private state: CircuitState = CircuitState.CLOSED;
  private readonly failureWindow: SlidingWindow;

  /** Timer handle for the OPEN -> HALF_OPEN transition. */
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive successes in HALF_OPEN. */
  private _halfOpenSuccesses = 0;

  // Lifetime counters
  private _totalSuccesses = 0;
  private _totalFailures = 0;
  private _totalRejections = 0;
  private _lastOpenedAt = 0;
  private _lastClosedAt = 0;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.failureWindow = new SlidingWindow(this.config.monitorWindowMs);

    log.info('Circuit breaker created', {
      name: this.config.name,
      failureThreshold: this.config.failureThreshold,
      successThreshold: this.config.successThreshold,
      timeoutMs: this.config.timeoutMs,
      monitorWindowMs: this.config.monitorWindowMs,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Execute an async function through the circuit breaker.
   *
   * - **CLOSED**: runs `fn`, tracks success/failure.
   * - **OPEN**: rejects immediately with `CircuitOpenError`.
   * - **HALF_OPEN**: runs `fn`, counts successes toward recovery.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check for OPEN -> HALF_OPEN transition (timeout elapsed)
    this.checkOpenTimeout();

    if (this.state === CircuitState.OPEN) {
      this._totalRejections++;
      const retryAfterMs = this.retryAfterMs();
      this.emitEvent('rejected', {
        name: this.config.name,
        state: this.state,
      });
      throw new CircuitOpenError(this.config.name, retryAfterMs);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /** Get the current circuit state. */
  getState(): CircuitState {
    // Always check for pending timeout transition before reporting state
    this.checkOpenTimeout();
    return this.state;
  }

  /** Get a stats snapshot. */
  getStats(): CircuitBreakerStats {
    return {
      name: this.config.name,
      state: this.getState(),
      totalSuccesses: this._totalSuccesses,
      totalFailures: this._totalFailures,
      totalRejections: this._totalRejections,
      windowFailures: this.failureWindow.count(),
      halfOpenSuccesses: this._halfOpenSuccesses,
      lastOpenedAt: this._lastOpenedAt,
      lastClosedAt: this._lastClosedAt,
    };
  }

  /** Force-reset the circuit to CLOSED and clear all counters. */
  reset(): void {
    const prevState = this.state;
    this.clearOpenTimer();
    this.state = CircuitState.CLOSED;
    this.failureWindow.reset();
    this._halfOpenSuccesses = 0;
    this._totalSuccesses = 0;
    this._totalFailures = 0;
    this._totalRejections = 0;
    this._lastOpenedAt = 0;
    this._lastClosedAt = 0;

    if (prevState !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED);
    }

    log.info('Circuit breaker reset', { name: this.config.name });
  }

  /** Force the circuit to a specific state (primarily for testing). */
  forceState(state: CircuitState): void {
    const from = this.state;
    this.clearOpenTimer();

    if (state === CircuitState.OPEN) {
      this._lastOpenedAt = Date.now();
      this.scheduleHalfOpen();
    } else if (state === CircuitState.HALF_OPEN) {
      this._halfOpenSuccesses = 0;
    }

    this.state = state;
    if (from !== state) {
      this.emitStateChange(from, state);
    }
  }

  /** Get the circuit breaker's name. */
  get name(): string {
    return this.config.name;
  }

  // ── Internal state machine ────────────────────────────────────────────

  private onSuccess(): void {
    this._totalSuccesses++;
    this.emitEvent('success', { name: this.config.name, state: this.state });

    if (this.state === CircuitState.HALF_OPEN) {
      this._halfOpenSuccesses++;

      log.debug('HALF_OPEN success', {
        name: this.config.name,
        consecutive: this._halfOpenSuccesses,
        threshold: this.config.successThreshold,
      });

      if (this._halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }

  private onFailure(error: unknown): void {
    this._totalFailures++;
    this.emitEvent('failure', {
      name: this.config.name,
      error,
      state: this.state,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN immediately reopens the circuit
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.failureWindow.record();
      const windowCount = this.failureWindow.count();

      log.debug('Failure recorded in sliding window', {
        name: this.config.name,
        windowFailures: windowCount,
        threshold: this.config.failureThreshold,
      });

      if (windowCount >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const from = this.state;
    this.clearOpenTimer();

    switch (newState) {
      case CircuitState.OPEN:
        this._lastOpenedAt = Date.now();
        this._halfOpenSuccesses = 0;
        this.scheduleHalfOpen();
        break;

      case CircuitState.HALF_OPEN:
        this._halfOpenSuccesses = 0;
        break;

      case CircuitState.CLOSED:
        this._lastClosedAt = Date.now();
        this._halfOpenSuccesses = 0;
        this.failureWindow.reset();
        break;
    }

    this.state = newState;
    this.emitStateChange(from, newState);
  }

  /**
   * Check whether the OPEN timeout has elapsed and, if so, transition
   * to HALF_OPEN.  This acts as a synchronous fallback in case the
   * timer-based transition hasn't fired yet (e.g. if the event loop
   * was blocked).
   */
  private checkOpenTimeout(): void {
    if (
      this.state === CircuitState.OPEN &&
      this._lastOpenedAt > 0 &&
      Date.now() - this._lastOpenedAt >= this.config.timeoutMs
    ) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
  }

  /** Schedule the timer-based OPEN -> HALF_OPEN transition. */
  private scheduleHalfOpen(): void {
    this.clearOpenTimer();
    this.openTimer = setTimeout(() => {
      if (this.state === CircuitState.OPEN) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }, this.config.timeoutMs);

    // Don't prevent Node.js process exit
    if (this.openTimer.unref) {
      this.openTimer.unref();
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  /** Calculate how many ms until the circuit transitions to HALF_OPEN. */
  private retryAfterMs(): number {
    if (this._lastOpenedAt === 0) return this.config.timeoutMs;
    const elapsed = Date.now() - this._lastOpenedAt;
    return Math.max(0, this.config.timeoutMs - elapsed);
  }

  // ── Event emission helpers ────────────────────────────────────────────

  private emitStateChange(from: CircuitState, to: CircuitState): void {
    log.info('Circuit breaker state change', {
      name: this.config.name,
      from,
      to,
    });
    this.emit('stateChange', { from, to, name: this.config.name });
  }

  private emitEvent(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named Circuit Breakers
// ─────────────────────────────────────────────────────────────────────────────

/** Circuit breaker for the Google Slides API. */
export const googleSlidesCircuit = new CircuitBreaker({
  name: 'google-slides-api',
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30_000,
  monitorWindowMs: 60_000,
});

/** Circuit breaker for the Google Drive API. */
export const googleDriveCircuit = new CircuitBreaker({
  name: 'google-drive-api',
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30_000,
  monitorWindowMs: 60_000,
});

/** Circuit breaker for browser (Chrome DevTools Protocol) connections. */
export const browserCircuit = new CircuitBreaker({
  name: 'browser-connection',
  failureThreshold: 3,
  successThreshold: 2,
  timeoutMs: 15_000,
  monitorWindowMs: 30_000,
});

/** Circuit breaker for the vision analysis layer. */
export const visionCircuit = new CircuitBreaker({
  name: 'vision-analysis',
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30_000,
  monitorWindowMs: 60_000,
});

/**
 * Registry of all named circuit breakers for iteration / health checks.
 */
export const circuitBreakers: ReadonlyMap<string, CircuitBreaker> = new Map([
  ['google-slides-api', googleSlidesCircuit],
  ['google-drive-api', googleDriveCircuit],
  ['browser-connection', browserCircuit],
  ['vision-analysis', visionCircuit],
]);
