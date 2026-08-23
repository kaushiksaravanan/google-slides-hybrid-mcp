/**
 * @module resilience/graceful-shutdown
 * @description Graceful shutdown manager for the MCP server.
 *
 * Orchestrates an orderly shutdown sequence when the process receives a
 * termination signal (SIGINT, SIGTERM, SIGUSR2).  Handlers are executed
 * in priority order (higher priority first) with per-handler and total
 * timeout protection.
 *
 * The shutdown sequence for a typical deployment:
 * 1. Stop accepting new HTTP connections.
 * 2. Wait for in-flight requests to complete.
 * 3. Close SSE / WebSocket connections.
 * 4. Flush metrics and audit logs.
 * 5. Close database connections.
 * 6. Final cleanup.
 *
 * If the total timeout is exceeded the process is forcefully terminated.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('resilience.shutdown');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A registered shutdown handler. */
export interface ShutdownHandler {
  /** Human-readable name for logging. */
  name: string;
  /** The cleanup function to execute. */
  handler: () => Promise<void> | void;
  /** Priority (higher = runs earlier).  Default: 0. */
  priority: number;
  /** Per-handler timeout in ms.  Default: 5000. */
  timeoutMs: number;
}

/** Configuration for the ShutdownManager. */
export interface ShutdownManagerConfig {
  /** Total time budget for the entire shutdown sequence, in ms. */
  totalTimeoutMs: number;
  /** Default per-handler timeout, in ms. */
  defaultHandlerTimeoutMs: number;
  /** Whether to forcefully exit the process after the total timeout. */
  forceExitOnTimeout: boolean;
  /** Exit code to use on forced exit. */
  forceExitCode: number;
}

/** Suggested priority levels for common handler types. */
export const ShutdownPriority = {
  /** Stop accepting new connections (highest). */
  STOP_ACCEPTING: 100,
  /** Wait for in-flight requests. */
  DRAIN_REQUESTS: 90,
  /** Close long-lived connections (SSE, WebSocket). */
  CLOSE_CONNECTIONS: 80,
  /** Flush buffered data (metrics, audit logs). */
  FLUSH_BUFFERS: 70,
  /** Close external resource connections. */
  CLOSE_RESOURCES: 60,
  /** General cleanup (lowest of the named tiers). */
  CLEANUP: 50,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// ShutdownManager
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ShutdownManagerConfig = {
  totalTimeoutMs: 30_000,
  defaultHandlerTimeoutMs: 5_000,
  forceExitOnTimeout: true,
  forceExitCode: 1,
};

/**
 * Singleton manager that orchestrates a graceful shutdown.
 *
 * Usage:
 * ```ts
 * const sm = ShutdownManager.getInstance();
 * sm.register('http-server', async () => httpServer.close(), ShutdownPriority.STOP_ACCEPTING);
 * sm.register('database', async () => db.close(), ShutdownPriority.CLOSE_RESOURCES);
 * sm.registerSignalHandlers(); // auto-shutdown on SIGINT / SIGTERM
 * ```
 */
export class ShutdownManager {
  private static instance: ShutdownManager | null = null;

  private readonly config: ShutdownManagerConfig;
  private readonly handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private signalHandlersRegistered = false;

  /** Bound signal handler references for cleanup. */
  private readonly boundSignalHandler: (signal: string) => void;

  private constructor(config: Partial<ShutdownManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.boundSignalHandler = (signal: string) => {
      void this.shutdown(signal);
    };
  }

  /** Get (or create) the singleton instance. */
  static getInstance(config?: Partial<ShutdownManagerConfig>): ShutdownManager {
    if (!ShutdownManager.instance) {
      ShutdownManager.instance = new ShutdownManager(config);
    }
    return ShutdownManager.instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    if (ShutdownManager.instance) {
      ShutdownManager.instance.removeSignalHandlers();
    }
    ShutdownManager.instance = null;
  }

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register a cleanup handler.
   *
   * @param name - Human-readable name for logging.
   * @param handler - The cleanup function.
   * @param priority - Higher runs first. Default: 0.
   * @param timeoutMs - Per-handler timeout. Default: config.defaultHandlerTimeoutMs.
   */
  register(
    name: string,
    handler: () => Promise<void> | void,
    priority?: number,
    timeoutMs?: number,
  ): void {
    this.handlers.push({
      name,
      handler,
      priority: priority ?? 0,
      timeoutMs: timeoutMs ?? this.config.defaultHandlerTimeoutMs,
    });

    log.debug('Shutdown handler registered', { name, priority: priority ?? 0 });
  }

  /**
   * Unregister a handler by name.
   * @returns `true` if a handler was found and removed.
   */
  unregister(name: string): boolean {
    const idx = this.handlers.findIndex((h) => h.name === name);
    if (idx === -1) return false;
    this.handlers.splice(idx, 1);
    return true;
  }

  // ── Signal handling ───────────────────────────────────────────────────

  /**
   * Register process signal handlers for graceful shutdown.
   * Handles SIGINT (Ctrl+C), SIGTERM (Docker/Kubernetes), and
   * SIGUSR2 (nodemon restart).
   */
  registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;

    const signals = ['SIGINT', 'SIGTERM'];

    // SIGUSR2 is not available on Windows
    if (process.platform !== 'win32') {
      signals.push('SIGUSR2');
    }

    for (const signal of signals) {
      process.on(signal, () => this.boundSignalHandler(signal));
    }

    // Handle uncaught exceptions as a last resort
    process.on('uncaughtException', (error) => {
      log.error('Uncaught exception — initiating shutdown', {
        error: error.message,
        stack: error.stack,
      });
      void this.shutdown('uncaughtException');
    });

    this.signalHandlersRegistered = true;
    log.info('Signal handlers registered for graceful shutdown');
  }

  /**
   * Remove registered signal handlers (useful for testing).
   */
  removeSignalHandlers(): void {
    if (!this.signalHandlersRegistered) return;

    // Note: We can't precisely remove *our* listener because process.on
    // doesn't return a reference in the same way. In production this
    // manager lives for the lifetime of the process, so this is mainly
    // useful in tests where we reset the singleton.
    this.signalHandlersRegistered = false;
  }

  // ── Shutdown execution ────────────────────────────────────────────────

  /**
   * Execute the shutdown sequence.
   *
   * All registered handlers are run in priority order (descending).
   * Each handler is given its own timeout; the entire sequence is
   * also bounded by `totalTimeoutMs`.
   *
   * @param signal - The signal or reason that triggered shutdown.
   */
  async shutdown(signal?: string): Promise<void> {
    // Prevent concurrent shutdowns
    if (this.isShuttingDown) {
      log.warn('Shutdown already in progress — ignoring duplicate call', { signal });
      return;
    }
    this.isShuttingDown = true;

    log.info('Graceful shutdown initiated', {
      signal: signal ?? 'manual',
      handlerCount: this.handlers.length,
      totalTimeoutMs: this.config.totalTimeoutMs,
    });

    // Set up the total-timeout force-exit timer
    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.config.forceExitOnTimeout) {
      forceExitTimer = setTimeout(() => {
        log.error('Shutdown total timeout exceeded — forcing exit', {
          totalTimeoutMs: this.config.totalTimeoutMs,
        });
        process.exit(this.config.forceExitCode);
      }, this.config.totalTimeoutMs);

      // Make sure the timer doesn't prevent exit if handlers complete first
      if (forceExitTimer.unref) {
        forceExitTimer.unref();
      }
    }

    try {
      // Sort handlers by priority descending (highest first)
      const sorted = [...this.handlers].sort((a, b) => b.priority - a.priority);

      for (const handler of sorted) {
        await this.runHandler(handler);
      }

      log.info('Graceful shutdown completed successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Error during shutdown sequence', { error: message });
    } finally {
      if (forceExitTimer) {
        clearTimeout(forceExitTimer);
      }
    }
  }

  /** Whether a shutdown is currently in progress. */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /** Get the list of registered handler names (in registration order). */
  getHandlerNames(): string[] {
    return this.handlers.map((h) => h.name);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Run a single shutdown handler with timeout protection.
   */
  private async runHandler(handler: ShutdownHandler): Promise<void> {
    const { name, timeoutMs } = handler;
    const start = performance.now();

    log.info(`Running shutdown handler: ${name}`, {
      priority: handler.priority,
      timeoutMs,
    });

    try {
      await Promise.race([
        Promise.resolve(handler.handler()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Shutdown handler "${name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);

      const durationMs = Math.round(performance.now() - start);
      log.info(`Shutdown handler completed: ${name}`, { durationMs });
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Shutdown handler failed: ${name}`, {
        error: message,
        durationMs,
      });
      // Continue with the next handler — don't let one failure abort shutdown
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global shutdown manager instance. */
export const shutdownManager = ShutdownManager.getInstance();
