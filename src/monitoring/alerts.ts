/**
 * @module monitoring/alerts
 * @description Alerting system that evaluates rules against live metrics and
 * dispatches alerts through configurable channels.
 *
 * Features:
 * - Declarative alert rules with threshold, window, severity, and cooldown.
 * - Pre-defined rules for error rate, latency, rate limiting, quota, etc.
 * - Pluggable alert channels (console, webhook).
 * - Alert deduplication with per-rule cooldown.
 * - Alert history ring buffer (last 100 alerts).
 */

import { createLogger } from '../shared/logger.js';
import { metricsRegistry } from './metrics.js';
import type { Counter, Gauge, Histogram } from './metrics.js';

const log = createLogger('monitoring.alerts');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Severity levels for fired alerts. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Current state of an alert rule evaluation. */
export type AlertState = 'ok' | 'firing' | 'resolved';

/**
 * A single alert rule definition.
 */
export interface AlertRule {
  /** Unique name of the alert rule. */
  name: string;
  /**
   * Evaluation function that inspects current metrics and returns a numeric
   * value.  The alert fires when `condition(currentValue, threshold)` is true.
   */
  evaluate: () => number;
  /**
   * Predicate that compares the evaluated value against the threshold.
   * Return `true` to fire the alert.
   */
  condition: (value: number, threshold: number) => boolean;
  /** The threshold value the condition is compared against. */
  threshold: number;
  /** Evaluation window in milliseconds. Used for rate calculations. */
  windowMs: number;
  /** Severity of the alert. */
  severity: AlertSeverity;
  /** Human-readable message template.  `{value}` is replaced with current value. */
  message: string;
  /** Minimum milliseconds between consecutive firings of this rule. */
  cooldownMs: number;
}

/**
 * A fired alert instance.
 */
export interface Alert {
  /** The rule name that fired. */
  ruleName: string;
  /** Severity of the fired alert. */
  severity: AlertSeverity;
  /** Formatted message with the evaluated value substituted. */
  message: string;
  /** The numeric value that triggered the alert. */
  value: number;
  /** The threshold the value was compared against. */
  threshold: number;
  /** ISO-8601 timestamp of when the alert fired. */
  firedAt: string;
  /** Current state. */
  state: AlertState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Channels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for an alert delivery channel.
 */
export interface AlertChannel {
  /** Human-readable name of the channel. */
  name: string;
  /** Send an alert through this channel. */
  send(alert: Alert): Promise<void>;
}

/**
 * Console alert channel — logs alerts as structured JSON via the logger.
 */
export class ConsoleAlertChannel implements AlertChannel {
  public readonly name = 'console';

  async send(alert: Alert): Promise<void> {
    const logLevel = alert.severity === 'critical' ? 'error'
      : alert.severity === 'warning' ? 'warn'
      : 'info';

    log[logLevel](`[ALERT] ${alert.ruleName}: ${alert.message}`, {
      alert: {
        ruleName: alert.ruleName,
        severity: alert.severity,
        value: alert.value,
        threshold: alert.threshold,
        firedAt: alert.firedAt,
        state: alert.state,
      },
    });
  }
}

/**
 * Webhook alert channel — posts alerts to a configurable HTTP endpoint.
 */
export class WebhookAlertChannel implements AlertChannel {
  public readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    url: string,
    options?: {
      name?: string;
      headers?: Record<string, string>;
    },
  ) {
    this.url = url;
    this.name = options?.name ?? `webhook:${url}`;
    this.headers = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };
  }

  async send(alert: Alert): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          alert,
          source: 'google-slides-hybrid-mcp',
          sentAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.warn(`Webhook alert delivery failed: HTTP ${response.status}`, {
          channel: this.name,
          ruleName: alert.ruleName,
          statusCode: response.status,
        });
      }
    } catch (err) {
      log.error('Webhook alert delivery error', {
        channel: this.name,
        ruleName: alert.ruleName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The AlertManager evaluates alert rules against current metrics, manages
 * cooldown / deduplication, dispatches to channels, and maintains history.
 */
export class AlertManager {
  private readonly rules: AlertRule[] = [];
  private readonly channels: AlertChannel[] = [];
  private readonly history: Alert[] = [];
  private readonly maxHistory: number;
  /** Last fire timestamp per rule name (for cooldown). */
  private readonly lastFired = new Map<string, number>();
  /** Current state per rule name. */
  private readonly ruleStates = new Map<string, AlertState>();
  /** Handle to an optional periodic evaluation interval. */
  private evaluationInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 100;
  }

  // ── Rule management ─────────────────────────────────────────────────

  /** Register an alert rule. If a rule with the same name exists, skip silently. */
  addRule(rule: AlertRule): void {
    // Skip duplicate names silently to avoid double-registration crashes
    if (this.rules.some((r) => r.name === rule.name)) {
      return;
    }
    this.rules.push(rule);
    this.ruleStates.set(rule.name, 'ok');
  }

  /** Remove a rule by name. */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.ruleStates.delete(name);
    this.lastFired.delete(name);
    return true;
  }

  /** Get all registered rules. */
  getRules(): readonly AlertRule[] {
    return this.rules;
  }

  // ── Channel management ──────────────────────────────────────────────

  /** Register an alert channel. */
  addChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  /** Remove a channel by name. */
  removeChannel(name: string): boolean {
    const idx = this.channels.findIndex((c) => c.name === name);
    if (idx === -1) return false;
    this.channels.splice(idx, 1);
    return true;
  }

  // ── Evaluation ──────────────────────────────────────────────────────

  /**
   * Evaluate all rules against current metrics. Fires alerts and dispatches
   * them to all registered channels. Returns the list of newly fired alerts.
   */
  async evaluate(): Promise<Alert[]> {
    const firedAlerts: Alert[] = [];
    const now = Date.now();

    for (const rule of this.rules) {
      let value: number;
      try {
        value = rule.evaluate();
      } catch (err) {
        log.warn(`Alert rule "${rule.name}" evaluation error`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const shouldFire = rule.condition(value, rule.threshold);
      const previousState = this.ruleStates.get(rule.name) ?? 'ok';

      if (shouldFire) {
        // Check cooldown
        const lastFiredAt = this.lastFired.get(rule.name) ?? 0;
        if (now - lastFiredAt < rule.cooldownMs) {
          continue; // still in cooldown
        }

        const alert: Alert = {
          ruleName: rule.name,
          severity: rule.severity,
          message: rule.message.replace('{value}', value.toFixed(2)),
          value,
          threshold: rule.threshold,
          firedAt: new Date(now).toISOString(),
          state: 'firing',
        };

        this.lastFired.set(rule.name, now);
        this.ruleStates.set(rule.name, 'firing');

        // Store in history
        this.history.push(alert);
        if (this.history.length > this.maxHistory) {
          this.history.shift();
        }

        firedAlerts.push(alert);

        // Dispatch to channels (fire-and-forget per channel)
        for (const channel of this.channels) {
          channel.send(alert).catch((err) => {
            log.error(`Alert channel "${channel.name}" failed`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } else if (previousState === 'firing') {
        // Transition to resolved
        this.ruleStates.set(rule.name, 'resolved');

        const resolvedAlert: Alert = {
          ruleName: rule.name,
          severity: rule.severity,
          message: `[RESOLVED] ${rule.message.replace('{value}', value.toFixed(2))}`,
          value,
          threshold: rule.threshold,
          firedAt: new Date(now).toISOString(),
          state: 'resolved',
        };

        this.history.push(resolvedAlert);
        if (this.history.length > this.maxHistory) {
          this.history.shift();
        }

        for (const channel of this.channels) {
          channel.send(resolvedAlert).catch((err) => {
            log.error(`Alert channel "${channel.name}" failed`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } else {
        this.ruleStates.set(rule.name, 'ok');
      }
    }

    return firedAlerts;
  }

  // ── History ─────────────────────────────────────────────────────────

  /** Get the alert history (most recent last). */
  getHistory(): readonly Alert[] {
    return this.history;
  }

  /** Get the current state of a rule by name. */
  getRuleState(name: string): AlertState | undefined {
    return this.ruleStates.get(name);
  }

  /** Clear alert history. */
  clearHistory(): void {
    this.history.length = 0;
  }

  // ── Periodic evaluation ─────────────────────────────────────────────

  /**
   * Start periodic evaluation of all rules.
   *
   * @param intervalMs - How often to run evaluation (default 30 seconds).
   */
  startPeriodicEvaluation(intervalMs = 30_000): void {
    if (this.evaluationInterval) return;

    this.evaluationInterval = setInterval(() => {
      this.evaluate().catch((err) => {
        log.error('Periodic alert evaluation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    // Don't prevent process exit
    if (this.evaluationInterval.unref) {
      this.evaluationInterval.unref();
    }

    log.info('Alert periodic evaluation started', { intervalMs });
  }

  /** Stop periodic evaluation. */
  stopPeriodicEvaluation(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
      log.info('Alert periodic evaluation stopped');
    }
  }

  /** Dispose of all resources. */
  destroy(): void {
    this.stopPeriodicEvaluation();
    this.rules.length = 0;
    this.channels.length = 0;
    this.history.length = 0;
    this.lastFired.clear();
    this.ruleStates.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric Helper: Safe counter value reader
// ─────────────────────────────────────────────────────────────────────────────

/** Safely read a counter total across all label combinations. */
function sumCounter(name: string): number {
  const metric = metricsRegistry.getMetric(name);
  if (!metric || metric.type !== 'counter') return 0;
  const counter = metric as Counter;
  // Sum all label combinations by rendering and parsing (since we don't
  // expose the internal map). Instead, use a cheaper approach: re-export
  // the render lines and parse values.
  let total = 0;
  const lines = counter.render();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const parts = line.split(' ');
    const val = Number(parts[parts.length - 1]);
    if (!Number.isNaN(val)) total += val;
  }
  return total;
}

/** Read a gauge value (unlabelled). */
function readGauge(name: string): number {
  const metric = metricsRegistry.getMetric(name);
  if (!metric || metric.type !== 'gauge') return 0;
  return (metric as Gauge).get();
}

/** Safely read histogram p95 (approximate from bucket boundaries). */
function readHistogramP95(name: string): number {
  const metric = metricsRegistry.getMetric(name);
  if (!metric || metric.type !== 'histogram') return 0;
  const histogram = metric as Histogram;
  // We need to approximate p95 from all label combinations.
  // Parse rendered output for _count and _sum to get average, and use
  // the bucket closest to the 95th percentile.
  const rendered = histogram.render();
  let totalCount = 0;
  let totalSum = 0;
  const bucketCounts: { le: number; count: number }[] = [];

  for (const line of rendered) {
    if (line.startsWith('#')) continue;
    if (line.includes('_count')) {
      const val = Number(line.split(' ').pop());
      if (!Number.isNaN(val)) totalCount += val;
    } else if (line.includes('_sum')) {
      const val = Number(line.split(' ').pop());
      if (!Number.isNaN(val)) totalSum += val;
    } else if (line.includes('_bucket')) {
      const leMatch = /le="([^"]+)"/.exec(line);
      const valStr = line.split(' ').pop();
      if (leMatch && valStr) {
        const le = leMatch[1] === '+Inf' ? Infinity : Number(leMatch[1]);
        const count = Number(valStr);
        if (!Number.isNaN(le) && !Number.isNaN(count)) {
          bucketCounts.push({ le, count });
        }
      }
    }
  }

  if (totalCount === 0) return 0;

  // Find the bucket where cumulative count >= 95% of total
  const target = totalCount * 0.95;
  for (const bucket of bucketCounts) {
    if (bucket.count >= target && bucket.le !== Infinity) {
      return bucket.le;
    }
  }

  // Fallback: use average
  return totalSum / totalCount;
}

/** Read counter values for specific labels. */
function readCounterLabelled(name: string, labels: Record<string, string>): number {
  const metric = metricsRegistry.getMetric(name);
  if (!metric || metric.type !== 'counter') return 0;
  return (metric as Counter).get(labels);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-defined Alert Rules
// ─────────────────────────────────────────────────────────────────────────────

/** Create all pre-defined alert rules for the Google Slides MCP server. */
export function createDefaultAlertRules(): AlertRule[] {
  return [
    // ── High error rate (>5% of requests in 5min window) ────────────
    {
      name: 'high_error_rate',
      evaluate: () => {
        const totalRequests = sumCounter('gslides_requests_total');
        const totalErrors = sumCounter('gslides_errors_total');
        if (totalRequests === 0) return 0;
        return (totalErrors / totalRequests) * 100;
      },
      condition: (value, threshold) => value > threshold,
      threshold: 5,
      windowMs: 5 * 60 * 1000,
      severity: 'critical',
      message: 'Error rate is {value}% (threshold: 5%)',
      cooldownMs: 5 * 60 * 1000,
    },

    // ── High latency (p95 > 10s) ───────────────────────────────────
    {
      name: 'high_latency',
      evaluate: () => readHistogramP95('gslides_request_duration_seconds'),
      condition: (value, threshold) => value > threshold,
      threshold: 10,
      windowMs: 5 * 60 * 1000,
      severity: 'warning',
      message: 'Request p95 latency is {value}s (threshold: 10s)',
      cooldownMs: 5 * 60 * 1000,
    },

    // ── Rate limit storm (>100 hits in 1min) ────────────────────────
    {
      name: 'rate_limit_storm',
      evaluate: () => sumCounter('gslides_rate_limit_hits_total'),
      condition: (value, threshold) => value > threshold,
      threshold: 100,
      windowMs: 60 * 1000,
      severity: 'warning',
      message: 'Rate limit hits: {value} (threshold: 100)',
      cooldownMs: 2 * 60 * 1000,
    },

    // ── API quota exhaustion (>90% of daily quota) ──────────────────
    {
      name: 'api_quota_exhaustion',
      evaluate: () => {
        // Google Slides API default: ~60 requests/min = 86400/day
        // Approximate daily quota at 86400 calls
        const dailyQuota = 86_400;
        const totalCalls = sumCounter('gslides_api_calls_total');
        return (totalCalls / dailyQuota) * 100;
      },
      condition: (value, threshold) => value > threshold,
      threshold: 90,
      windowMs: 24 * 60 * 60 * 1000,
      severity: 'critical',
      message: 'API quota usage at {value}% (threshold: 90%)',
      cooldownMs: 30 * 60 * 1000,
    },

    // ── Vision analysis failures (>50% failure rate) ────────────────
    {
      name: 'vision_analysis_failures',
      evaluate: () => {
        const successes = readCounterLabelled('gslides_vision_analyses_total', { result: 'success' });
        const failures = readCounterLabelled('gslides_vision_analyses_total', { result: 'failure' });
        const total = successes + failures;
        if (total === 0) return 0;
        return (failures / total) * 100;
      },
      condition: (value, threshold) => value > threshold,
      threshold: 50,
      windowMs: 5 * 60 * 1000,
      severity: 'warning',
      message: 'Vision analysis failure rate: {value}% (threshold: 50%)',
      cooldownMs: 10 * 60 * 1000,
    },

    // ── Browser connection loss ─────────────────────────────────────
    {
      name: 'browser_connection_loss',
      evaluate: () => readGauge('gslides_browser_connections'),
      condition: (value, threshold) => value < threshold,
      threshold: 1,
      windowMs: 60 * 1000,
      severity: 'critical',
      message: 'Browser connections: {value} (expected at least 1)',
      cooldownMs: 2 * 60 * 1000,
    },

    // ── Memory usage > 90% ──────────────────────────────────────────
    {
      name: 'high_memory_usage',
      evaluate: () => {
        const memUsage = process.memoryUsage();
        // Compare RSS against a reasonable threshold.
        // Default Node.js heap limit is ~1.7GB on 64-bit.
        const heapUsedMb = memUsage.heapUsed / (1024 * 1024);
        const heapTotalMb = memUsage.heapTotal / (1024 * 1024);
        if (heapTotalMb === 0) return 0;
        return (heapUsedMb / heapTotalMb) * 100;
      },
      condition: (value, threshold) => value > threshold,
      threshold: 90,
      windowMs: 60 * 1000,
      severity: 'critical',
      message: 'Heap memory usage: {value}% (threshold: 90%)',
      cooldownMs: 5 * 60 * 1000,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global AlertManager instance pre-configured with default rules and console channel. */
export const alertManager = new AlertManager();

// Register default channel
alertManager.addChannel(new ConsoleAlertChannel());

// Register default rules
for (const rule of createDefaultAlertRules()) {
  alertManager.addRule(rule);
}
