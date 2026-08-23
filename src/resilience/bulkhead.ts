/**
 * @module resilience/bulkhead
 * @description Bulkhead isolation pattern — limits concurrent executions per
 * service/resource to prevent a single failing dependency from consuming all
 * available resources and cascading failure across the system.
 *
 * Each `Bulkhead` instance enforces:
 * - A **maxConcurrent** cap on simultaneously executing operations.
 * - A **maxQueue** cap on waiting operations, with a per-item timeout.
 * - Immediate rejection when both execution slots and queue are full.
 *
 * Named bulkheads are provided for the three core operation groups:
 * API operations, Browser operations, and Vision operations.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('resilience.bulkhead');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for a Bulkhead instance. */
export interface BulkheadConfig {
  /** Human-readable name for logging and metrics. */
  name: string;
  /** Maximum number of concurrently executing operations. */
  maxConcurrent: number;
  /** Maximum number of operations waiting in the queue. */
  maxQueue: number;
  /** Timeout (ms) for queued operations before they are rejected. */
  queueTimeoutMs: number;
}

/** Statistics snapshot for a Bulkhead. */
export interface BulkheadStats {
  name: string;
  /** Currently executing operations. */
  activeCount: number;
  /** Operations waiting in the queue. */
  queueLength: number;
  /** Maximum concurrent slots. */
  maxConcurrent: number;
  /** Maximum queue depth. */
  maxQueue: number;
  /** Total operations that completed successfully. */
  totalSuccesses: number;
  /** Total operations that failed with an error. */
  totalFailures: number;
  /** Total operations rejected because the bulkhead was full. */
  totalRejections: number;
  /** Total operations that timed out while queued. */
  totalTimeouts: number;
}

/** Internal queued item. */
interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a bulkhead's execution slots and queue are both at capacity.
 */
export class BulkheadFullError extends Error {
  public readonly bulkheadName: string;
  public readonly activeCount: number;
  public readonly queueLength: number;

  constructor(name: string, activeCount: number, queueLength: number) {
    super(
      `Bulkhead "${name}" is full — ${activeCount} active, ` +
      `${queueLength} queued. Request rejected.`,
    );
    this.name = 'BulkheadFullError';
    this.bulkheadName = name;
    this.activeCount = activeCount;
    this.queueLength = queueLength;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a queued operation exceeds its queue timeout.
 */
export class BulkheadTimeoutError extends Error {
  public readonly bulkheadName: string;
  public readonly timeoutMs: number;

  constructor(name: string, timeoutMs: number) {
    super(
      `Bulkhead "${name}" queue timeout — operation waited ` +
      `${timeoutMs}ms without an execution slot.`,
    );
    this.name = 'BulkheadTimeoutError';
    this.bulkheadName = name;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulkhead
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<BulkheadConfig, 'name'> = {
  maxConcurrent: 10,
  maxQueue: 50,
  queueTimeoutMs: 30_000,
};

/**
 * Bulkhead isolation pattern for limiting concurrent access to a shared
 * resource.
 *
 * Usage:
 * ```ts
 * const bh = new Bulkhead({ name: 'api-ops', maxConcurrent: 10, maxQueue: 20 });
 * const result = await bh.execute(() => callSlidesApi(params));
 * ```
 */
export class Bulkhead {
  private readonly config: BulkheadConfig;
  private activeCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly queue: Array<QueueItem<any>> = [];

  // Lifetime counters
  private _totalSuccesses = 0;
  private _totalFailures = 0;
  private _totalRejections = 0;
  private _totalTimeouts = 0;

  constructor(config: Partial<BulkheadConfig> & { name: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    log.info('Bulkhead created', {
      name: this.config.name,
      maxConcurrent: this.config.maxConcurrent,
      maxQueue: this.config.maxQueue,
      queueTimeoutMs: this.config.queueTimeoutMs,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Execute an async function through the bulkhead.
   *
   * - If an execution slot is available, runs immediately.
   * - If only queue space is available, queues with a timeout.
   * - If both are full, rejects immediately with `BulkheadFullError`.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Fast path: execution slot available
    if (this.activeCount < this.config.maxConcurrent) {
      return this.runNow(fn);
    }

    // Queue path: check queue capacity
    if (this.queue.length >= this.config.maxQueue) {
      this._totalRejections++;
      log.warn('Bulkhead full — rejecting request', {
        name: this.config.name,
        activeCount: this.activeCount,
        queueLength: this.queue.length,
      });
      throw new BulkheadFullError(
        this.config.name,
        this.activeCount,
        this.queue.length,
      );
    }

    // Enqueue with timeout
    return this.enqueue(fn);
  }

  /** Get a stats snapshot. */
  getStats(): BulkheadStats {
    return {
      name: this.config.name,
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueue: this.config.maxQueue,
      totalSuccesses: this._totalSuccesses,
      totalFailures: this._totalFailures,
      totalRejections: this._totalRejections,
      totalTimeouts: this._totalTimeouts,
    };
  }

  /** Get the bulkhead's name. */
  get name(): string {
    return this.config.name;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /** Execute fn immediately in an active slot. */
  private async runNow<T>(fn: () => Promise<T>): Promise<T> {
    this.activeCount++;
    try {
      const result = await fn();
      this._totalSuccesses++;
      return result;
    } catch (error) {
      this._totalFailures++;
      throw error;
    } finally {
      this.activeCount--;
      this.dequeue();
    }
  }

  /** Enqueue fn and return a promise that resolves when it eventually runs. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this item from the queue
        const idx = this.queue.findIndex((item) => item.timer === timer);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        this._totalTimeouts++;
        log.warn('Bulkhead queue timeout', {
          name: this.config.name,
          timeoutMs: this.config.queueTimeoutMs,
        });
        reject(new BulkheadTimeoutError(this.config.name, this.config.queueTimeoutMs));
      }, this.config.queueTimeoutMs);

      // Don't prevent Node.js exit
      if (timer.unref) {
        timer.unref();
      }

      this.queue.push({ fn, resolve, reject, timer });
    });
  }

  /** Try to dequeue the next item if an execution slot is available. */
  private dequeue(): void {
    if (this.queue.length === 0 || this.activeCount >= this.config.maxConcurrent) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    clearTimeout(item.timer);

    // Run the dequeued item in an active slot
    this.activeCount++;
    item
      .fn()
      .then((result) => {
        this._totalSuccesses++;
        item.resolve(result);
      })
      .catch((error: unknown) => {
        this._totalFailures++;
        item.reject(error);
      })
      .finally(() => {
        this.activeCount--;
        this.dequeue();
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named Bulkheads
// ─────────────────────────────────────────────────────────────────────────────

/** Bulkhead for Google API operations (Slides + Drive). */
export const apiBulkhead = new Bulkhead({
  name: 'api-operations',
  maxConcurrent: 10,
  maxQueue: 50,
  queueTimeoutMs: 30_000,
});

/** Bulkhead for browser automation operations. */
export const browserBulkhead = new Bulkhead({
  name: 'browser-operations',
  maxConcurrent: 3,
  maxQueue: 10,
  queueTimeoutMs: 60_000,
});

/** Bulkhead for vision analysis operations. */
export const visionBulkhead = new Bulkhead({
  name: 'vision-operations',
  maxConcurrent: 5,
  maxQueue: 20,
  queueTimeoutMs: 45_000,
});

/**
 * Registry of all named bulkheads for iteration / health checks.
 */
export const bulkheads: ReadonlyMap<string, Bulkhead> = new Map([
  ['api-operations', apiBulkhead],
  ['browser-operations', browserBulkhead],
  ['vision-operations', visionBulkhead],
]);
