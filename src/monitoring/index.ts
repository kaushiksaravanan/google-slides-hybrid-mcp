/**
 * @module monitoring
 * @description Unified monitoring, metrics, tracing, alerting, audit logging,
 * and health checking for the Google Slides Hybrid MCP server.
 *
 * Re-exports all public APIs from the monitoring subsystem for convenient
 * single-import usage:
 *
 * ```ts
 * import {
 *   metricsRegistry,
 *   defaultMetrics,
 *   tracer,
 *   alertManager,
 *   auditLogger,
 *   healthChecker,
 * } from './monitoring/index.js';
 * ```
 */

// ── Metrics ────────────────────────────────────────────────────────────────
export {
  // Classes
  Counter,
  Gauge,
  Histogram,
  Summary,
  MetricsRegistry,
  // Singletons & helpers
  metricsRegistry,
  defaultMetrics,
  registerDefaultMetrics,
  // Bucket / quantile presets
  HTTP_DURATION_BUCKETS,
  API_CALL_DURATION_BUCKETS,
  DEFAULT_QUANTILES,
  // Types
  type DefaultMetrics,
} from './metrics.js';

// ── Tracing ────────────────────────────────────────────────────────────────
export {
  // Classes
  Tracer,
  // Singletons & helpers
  tracer,
  consoleSpanExporter,
  createRequestTracer,
  parseTraceparent,
  toTraceparent,
  // Types
  type Span,
  type SpanStatus,
  type SpanEvent,
  type StartSpanOptions,
  type SpanExporter,
} from './tracing.js';

// ── Alerts ─────────────────────────────────────────────────────────────────
export {
  // Classes
  AlertManager,
  ConsoleAlertChannel,
  WebhookAlertChannel,
  // Singletons & helpers
  alertManager,
  createDefaultAlertRules,
  // Types
  type AlertRule,
  type Alert,
  type AlertSeverity,
  type AlertState,
  type AlertChannel,
} from './alerts.js';

// ── Audit Log ──────────────────────────────────────────────────────────────
export {
  // Classes
  AuditLogger,
  InMemoryAuditStorage,
  // Singletons
  auditLogger,
  // Types
  type AuditEvent,
  type AuditAction,
  type AuditQueryFilters,
  type AuditStorageAdapter,
} from './audit-log.js';

// ── Health Checker ─────────────────────────────────────────────────────────
export {
  // Classes
  HealthChecker,
  // Singletons
  healthChecker,
  // Types
  type HealthStatus,
  type HealthReport,
  type ComponentHealthResult,
  type MemoryHealthResult,
  type DiskHealthResult,
  type ExternalChecker,
} from './health-checker.js';
