/**
 * @module monitoring/health-checker
 * @description Deep health checking for all server components.
 *
 * Performs independent health checks for Google Slides API, Google Drive API,
 * browser connections, vision layer, database, memory, and disk. Aggregates
 * results into a comprehensive health report with an overall status derived
 * from the worst individual component status.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('monitoring.health');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Health status for an individual component. */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** Result of a single component health check. */
export interface ComponentHealthResult {
  /** Name of the component being checked. */
  component: string;
  /** Health status. */
  status: HealthStatus;
  /** Check latency in milliseconds. */
  latencyMs: number;
  /** Human-readable status message. */
  message: string;
  /** Optional additional details. */
  details?: Record<string, unknown>;
}

/** Memory-specific health result. */
export interface MemoryHealthResult extends ComponentHealthResult {
  details: {
    usedMb: number;
    totalMb: number;
    percentage: number;
    rss: number;
    external: number;
  };
}

/** Disk-specific health result. */
export interface DiskHealthResult extends ComponentHealthResult {
  details: {
    freeMb: number;
    totalMb: number;
    percentage: number;
  };
}

/** Comprehensive health report containing all component checks. */
export interface HealthReport {
  /** Overall status — the worst of all individual statuses. */
  status: HealthStatus;
  /** ISO-8601 timestamp of when this report was generated. */
  timestamp: string;
  /** Server uptime in seconds. */
  uptimeSeconds: number;
  /** Server version. */
  version: string;
  /** Individual component results. */
  components: ComponentHealthResult[];
  /** Total time to run all checks in milliseconds. */
  totalCheckDurationMs: number;
}

/**
 * External dependency checker function type.
 * Implementations perform the actual connectivity/availability test.
 * Return a partial result; the HealthChecker fills in latency.
 */
export type ExternalChecker = () => Promise<{
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// Status Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Numeric ordering for health statuses (higher = worse). */
const STATUS_SEVERITY: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

/** Determine the worst status from a list of statuses. */
function worstStatus(statuses: HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'healthy';
  for (const s of statuses) {
    if (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst]) {
      worst = s;
    }
  }
  return worst;
}

/** Time an async function and return [result, durationMs]. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  return [result, durationMs];
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Checker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep health checker that probes each server component independently and
 * aggregates the results into a comprehensive health report.
 *
 * External dependency checkers (Google APIs, browser, vision, database)
 * are pluggable — register them via `setChecker()` so the health checker
 * doesn't need hard dependencies on those modules.
 */
export class HealthChecker {
  /** Server start time for uptime computation. */
  private readonly startTime: number = Date.now();
  /** Server version string. */
  private readonly version: string;
  /** Registered external checkers. */
  private readonly checkers = new Map<string, ExternalChecker>();
  /** Timeout for individual external checks (ms). */
  private readonly checkTimeoutMs: number;

  constructor(options?: { version?: string; checkTimeoutMs?: number }) {
    this.version = options?.version ?? '1.0.0';
    this.checkTimeoutMs = options?.checkTimeoutMs ?? 10_000;
  }

  // ── Checker Registration ────────────────────────────────────────────

  /**
   * Register an external dependency checker.
   *
   * @param name - Component name (e.g. 'google_slides_api', 'database').
   * @param checker - Async function that performs the health check.
   */
  setChecker(name: string, checker: ExternalChecker): void {
    this.checkers.set(name, checker);
  }

  /** Remove a registered checker. */
  removeChecker(name: string): boolean {
    return this.checkers.delete(name);
  }

  // ── Individual Checks ───────────────────────────────────────────────

  /**
   * Check Google Slides API connectivity.
   * Delegates to the registered 'google_slides_api' checker, or reports
   * degraded if no checker is registered.
   */
  async checkGoogleSlidesApi(): Promise<ComponentHealthResult> {
    return this.runExternalCheck('google_slides_api', 'Google Slides API');
  }

  /**
   * Check Google Drive API connectivity.
   */
  async checkGoogleDriveApi(): Promise<ComponentHealthResult> {
    return this.runExternalCheck('google_drive_api', 'Google Drive API');
  }

  /**
   * Check browser (Chrome DevTools Protocol) connectivity.
   */
  async checkBrowserConnection(): Promise<ComponentHealthResult> {
    return this.runExternalCheck('browser', 'Browser Connection');
  }

  /**
   * Check vision analysis layer availability.
   */
  async checkVisionLayer(): Promise<ComponentHealthResult> {
    return this.runExternalCheck('vision', 'Vision Layer');
  }

  /**
   * Check database connectivity.
   */
  async checkDatabase(): Promise<ComponentHealthResult> {
    return this.runExternalCheck('database', 'Database');
  }

  /**
   * Check memory usage against thresholds.
   *
   * - healthy: < 70% heap used
   * - degraded: 70-90% heap used
   * - unhealthy: > 90% heap used
   */
  async checkMemory(): Promise<MemoryHealthResult> {
    const mem = process.memoryUsage();
    const usedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100;
    const totalMb = Math.round((mem.heapTotal / (1024 * 1024)) * 100) / 100;
    const rssMb = Math.round((mem.rss / (1024 * 1024)) * 100) / 100;
    const externalMb = Math.round((mem.external / (1024 * 1024)) * 100) / 100;
    const percentage = totalMb > 0 ? Math.round((usedMb / totalMb) * 10000) / 100 : 0;

    let status: HealthStatus = 'healthy';
    let message = `Heap: ${usedMb}MB / ${totalMb}MB (${percentage}%)`;

    if (percentage > 90) {
      status = 'unhealthy';
      message = `CRITICAL: ${message}`;
    } else if (percentage > 70) {
      status = 'degraded';
      message = `WARNING: ${message}`;
    }

    return {
      component: 'memory',
      status,
      latencyMs: 0,
      message,
      details: {
        usedMb,
        totalMb,
        percentage,
        rss: rssMb,
        external: externalMb,
      },
    };
  }

  /**
   * Check disk space.
   *
   * Uses a heuristic based on `process.resourceUsage()` for platforms
   * that support it, otherwise reports healthy with a note.
   *
   * - healthy: > 20% free
   * - degraded: 10-20% free
   * - unhealthy: < 10% free
   */
  async checkDisk(): Promise<DiskHealthResult> {
    try {
      // Node.js >= 18.15 has fs.statfs on supported platforms
      const { statfs } = await import('node:fs/promises');
      const stats = await statfs('/');
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      const freeBytes = Number(stats.bavail) * blockSize;

      const totalMb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
      const freeMb = Math.round((freeBytes / (1024 * 1024)) * 100) / 100;
      const percentage = totalMb > 0 ? Math.round((freeMb / totalMb) * 10000) / 100 : 0;

      let status: HealthStatus = 'healthy';
      let message = `Disk: ${freeMb}MB free / ${totalMb}MB total (${percentage}% free)`;

      if (percentage < 10) {
        status = 'unhealthy';
        message = `CRITICAL: ${message}`;
      } else if (percentage < 20) {
        status = 'degraded';
        message = `WARNING: ${message}`;
      }

      return {
        component: 'disk',
        status,
        latencyMs: 0,
        message,
        details: { freeMb, totalMb, percentage },
      };
    } catch {
      // statfs not available (Windows, or older Node.js)
      return {
        component: 'disk',
        status: 'healthy',
        latencyMs: 0,
        message: 'Disk check not available on this platform — skipped',
        details: { freeMb: -1, totalMb: -1, percentage: -1 },
      };
    }
  }

  // ── Aggregate Check ─────────────────────────────────────────────────

  /**
   * Run all registered health checks and produce a comprehensive report.
   * Each check is run concurrently with a per-check timeout.
   */
  async runAllChecks(): Promise<HealthReport> {
    const overallStart = performance.now();

    // Run all checks concurrently
    const [
      slidesResult,
      driveResult,
      browserResult,
      visionResult,
      dbResult,
      memoryResult,
      diskResult,
    ] = await Promise.all([
      this.checkGoogleSlidesApi(),
      this.checkGoogleDriveApi(),
      this.checkBrowserConnection(),
      this.checkVisionLayer(),
      this.checkDatabase(),
      this.checkMemory(),
      this.checkDisk(),
    ]);

    const components: ComponentHealthResult[] = [
      slidesResult,
      driveResult,
      browserResult,
      visionResult,
      dbResult,
      memoryResult,
      diskResult,
    ];

    const status = worstStatus(components.map((c) => c.status));
    const totalCheckDurationMs =
      Math.round((performance.now() - overallStart) * 100) / 100;

    const report: HealthReport = {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.version,
      components,
      totalCheckDurationMs,
    };

    log.info('Health check completed', {
      status: report.status,
      durationMs: report.totalCheckDurationMs,
      components: components.map((c) => ({ name: c.component, status: c.status })),
    });

    return report;
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  /**
   * Run an external checker by name with timeout protection.
   */
  private async runExternalCheck(
    checkerName: string,
    displayName: string,
  ): Promise<ComponentHealthResult> {
    const checker = this.checkers.get(checkerName);

    if (!checker) {
      return {
        component: checkerName,
        status: 'degraded',
        latencyMs: 0,
        message: `${displayName} checker not registered — status unknown`,
      };
    }

    try {
      const [result, latencyMs] = await timed(() =>
        Promise.race([
          checker(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${displayName} health check timed out after ${this.checkTimeoutMs}ms`)),
              this.checkTimeoutMs,
            ),
          ),
        ]),
      );

      return {
        component: checkerName,
        status: result.status,
        latencyMs,
        message: result.message,
        details: result.details,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Health check failed for ${displayName}`, { error: message });

      return {
        component: checkerName,
        status: 'unhealthy',
        latencyMs: 0,
        message: `${displayName} check failed: ${message}`,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global health checker instance. */
export const healthChecker = new HealthChecker();
