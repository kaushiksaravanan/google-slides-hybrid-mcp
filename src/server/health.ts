/**
 * @module server/health
 * @description Health, readiness, and metrics endpoints for the HTTP server.
 *
 * - GET /health — Liveness probe (always 200 if the process is up).
 * - GET /ready — Readiness probe (checks API connectivity, layer status).
 * - GET /metrics — Prometheus-compatible metrics in text exposition format.
 *
 * Metrics are collected via a singleton {@link MetricsCollector} that
 * middleware and handlers update throughout the request lifecycle.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '../shared/logger.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../shared/constants.js';
import { metricsRegistry } from '../monitoring/metrics.js';

const log = createLogger('server.health');

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Collector
// ─────────────────────────────────────────────────────────────────────────────

/** Histogram bucket boundaries in seconds. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Internal histogram bucket state. */
interface HistogramData {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

/**
 * Lightweight Prometheus-compatible metrics collector.
 *
 * Designed to be used as a singleton across the application. Provides
 * counters, gauges, and histograms that render into Prometheus text
 * exposition format.
 */
export class MetricsCollector {
  /** Counter: total requests by method and status. */
  private readonly requestsTotal: Map<string, number> = new Map();

  /** Histogram: request duration in seconds by method. */
  private readonly requestDuration: Map<string, HistogramData> = new Map();

  /** Gauge: currently active SSE sessions. */
  private _activeSessions: number = 0;

  /** Counter: API errors by type. */
  private readonly apiErrorsTotal: Map<string, number> = new Map();

  /** Counter: presentations created. */
  private _presentationsCreated: number = 0;

  /** Counter: total SSE messages sent. */
  private _sseMessagesSent: number = 0;

  /** Server start time for uptime calculation. */
  private readonly startTime: number = Date.now();

  // ───────────────────────────────────────────────────────────────────────
  // Counter Methods
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Increment the requests total counter.
   *
   * @param method - HTTP method (GET, POST, etc.).
   * @param status - HTTP status code.
   */
  public incRequestsTotal(method: string, status: number): void {
    const key = `method="${method}",status="${status}"`;
    this.requestsTotal.set(key, (this.requestsTotal.get(key) ?? 0) + 1);
  }

  /**
   * Record a request duration observation.
   *
   * @param method - HTTP method.
   * @param durationSeconds - Duration in seconds.
   */
  public observeRequestDuration(method: string, durationSeconds: number): void {
    const key = `method="${method}"`;
    let hist = this.requestDuration.get(key);
    if (!hist) {
      hist = {
        buckets: new Map(DURATION_BUCKETS.map((b) => [b, 0])),
        sum: 0,
        count: 0,
      };
      this.requestDuration.set(key, hist);
    }

    hist.sum += durationSeconds;
    hist.count += 1;

    for (const boundary of DURATION_BUCKETS) {
      if (durationSeconds <= boundary) {
        hist.buckets.set(boundary, (hist.buckets.get(boundary) ?? 0) + 1);
      }
    }
  }

  /**
   * Set the number of active SSE sessions.
   */
  public set activeSessions(count: number) {
    this._activeSessions = count;
  }

  /**
   * Get the number of active SSE sessions.
   */
  public get activeSessions(): number {
    return this._activeSessions;
  }

  /**
   * Increment the API errors counter.
   *
   * @param type - Error type (e.g. "auth", "validation", "upstream", "internal").
   */
  public incApiErrors(type: string): void {
    const key = `type="${type}"`;
    this.apiErrorsTotal.set(key, (this.apiErrorsTotal.get(key) ?? 0) + 1);
  }

  /**
   * Increment the presentations created counter.
   */
  public incPresentationsCreated(): void {
    this._presentationsCreated++;
  }

  /**
   * Increment the SSE messages sent counter.
   */
  public incSseMessagesSent(): void {
    this._sseMessagesSent++;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Prometheus Text Exposition
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Render all metrics in Prometheus text exposition format.
   *
   * @returns A string suitable for the /metrics endpoint.
   */
  public render(): string {
    const lines: string[] = [];

    // ── gslides_requests_total ──────────────────────────────────────────
    lines.push('# HELP gslides_requests_total Total number of HTTP requests.');
    lines.push('# TYPE gslides_requests_total counter');
    for (const [labels, value] of this.requestsTotal.entries()) {
      lines.push(`gslides_requests_total{${labels}} ${value}`);
    }

    // ── gslides_request_duration_seconds ────────────────────────────────
    lines.push('# HELP gslides_request_duration_seconds HTTP request duration in seconds.');
    lines.push('# TYPE gslides_request_duration_seconds histogram');
    for (const [labels, hist] of this.requestDuration.entries()) {
      let cumulativeCount = 0;
      for (const boundary of DURATION_BUCKETS) {
        cumulativeCount += hist.buckets.get(boundary) ?? 0;
        lines.push(`gslides_request_duration_seconds_bucket{${labels},le="${boundary}"} ${cumulativeCount}`);
      }
      lines.push(`gslides_request_duration_seconds_bucket{${labels},le="+Inf"} ${hist.count}`);
      lines.push(`gslides_request_duration_seconds_sum{${labels}} ${hist.sum.toFixed(6)}`);
      lines.push(`gslides_request_duration_seconds_count{${labels}} ${hist.count}`);
    }

    // ── gslides_active_sessions ────────────────────────────────────────
    lines.push('# HELP gslides_active_sessions Number of active SSE sessions.');
    lines.push('# TYPE gslides_active_sessions gauge');
    lines.push(`gslides_active_sessions ${this._activeSessions}`);

    // ── gslides_api_errors_total ───────────────────────────────────────
    lines.push('# HELP gslides_api_errors_total Total number of API errors by type.');
    lines.push('# TYPE gslides_api_errors_total counter');
    for (const [labels, value] of this.apiErrorsTotal.entries()) {
      lines.push(`gslides_api_errors_total{${labels}} ${value}`);
    }

    // ── gslides_presentations_created_total ─────────────────────────────
    lines.push('# HELP gslides_presentations_created_total Total presentations created.');
    lines.push('# TYPE gslides_presentations_created_total counter');
    lines.push(`gslides_presentations_created_total ${this._presentationsCreated}`);

    // ── gslides_sse_messages_sent_total ─────────────────────────────────
    lines.push('# HELP gslides_sse_messages_sent_total Total SSE messages sent.');
    lines.push('# TYPE gslides_sse_messages_sent_total counter');
    lines.push(`gslides_sse_messages_sent_total ${this._sseMessagesSent}`);

    // ── gslides_uptime_seconds ──────────────────────────────────────────
    lines.push('# HELP gslides_uptime_seconds Server uptime in seconds.');
    lines.push('# TYPE gslides_uptime_seconds gauge');
    lines.push(`gslides_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`);

    return lines.join('\n') + '\n';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Metrics Instance
// ─────────────────────────────────────────────────────────────────────────────

/** Global metrics collector instance. */
export const metrics = new MetricsCollector();

// ─────────────────────────────────────────────────────────────────────────────
// Readiness Check Callback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A function that performs a readiness check and returns status details.
 * The server is ready if the returned object has `ready: true`.
 */
export type ReadinessCheck = () => Promise<{
  ready: boolean;
  checks: Record<string, { status: 'ok' | 'degraded' | 'error'; message?: string }>;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// Router Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an Express router with health, readiness, and metrics endpoints.
 *
 * @param readinessCheck - Optional async function to perform readiness checks.
 *   If not provided, the readiness endpoint simply returns `ready: true`.
 * @returns An Express Router with /health, /ready, and /metrics routes.
 */
export function createHealthRouter(readinessCheck?: ReadinessCheck): Router {
  const router = Router();

  // ── GET /health — Liveness ───────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      server: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // ── GET /ready — Readiness ──────────────────────────────────────────
  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      if (readinessCheck) {
        const result = await readinessCheck();
        const statusCode = result.ready ? 200 : 503;
        res.status(statusCode).json({
          status: result.ready ? 'ready' : 'not_ready',
          server: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          timestamp: new Date().toISOString(),
          checks: result.checks,
        });
      } else {
        res.status(200).json({
          status: 'ready',
          server: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          timestamp: new Date().toISOString(),
          checks: {
            server: { status: 'ok' },
          },
        });
      }
    } catch (error) {
      log.error('Readiness check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        status: 'error',
        server: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Readiness check failed',
      });
    }
  });

  // ── GET /metrics — Prometheus ───────────────────────────────────────
  router.get('/metrics', (_req: Request, res: Response) => {
    // Combine health.ts MetricsCollector output with monitoring MetricsRegistry output
    const healthMetrics = metrics.render();
    const monitoringMetrics = metricsRegistry.toPrometheusText();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(healthMetrics + '\n' + monitoringMetrics);
  });

  return router;
}
