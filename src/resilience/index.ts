/**
 * @module resilience
 * @description Unified resilience layer for the Google Slides Hybrid MCP server.
 *
 * Re-exports all public APIs from the resilience subsystem for convenient
 * single-import usage:
 *
 * ```ts
 * import {
 *   googleSlidesCircuit,
 *   apiBulkhead,
 *   presentationCache,
 *   shutdownManager,
 *   healthMonitor,
 *   FallbackChain,
 * } from './resilience/index.js';
 * ```
 */

// ── Circuit Breaker ────────────────────────────────────────────────────────
export {
  // Classes & enums
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
  // Named instances
  googleSlidesCircuit,
  googleDriveCircuit,
  browserCircuit,
  visionCircuit,
  circuitBreakers,
  // Types
  type CircuitBreakerConfig,
  type CircuitBreakerEvents,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

// ── Bulkhead ───────────────────────────────────────────────────────────────
export {
  // Classes
  Bulkhead,
  BulkheadFullError,
  BulkheadTimeoutError,
  // Named instances
  apiBulkhead,
  browserBulkhead,
  visionBulkhead,
  bulkheads,
  // Types
  type BulkheadConfig,
  type BulkheadStats,
} from './bulkhead.js';

// ── Fallback ───────────────────────────────────────────────────────────────
export {
  // Classes
  FallbackChain,
  // Factory functions
  apiWithCacheFallback,
  visionWithStructuralFallback,
  browserWithApiFallback,
  // Types
  type FallbackStrategy,
  type FallbackResult,
} from './fallback.js';

// ── Cache ──────────────────────────────────────────────────────────────────
export {
  // Classes
  Cache,
  PresentationCache,
  TemplateCache,
  // Singletons
  presentationCache,
  templateCache,
  // Types
  type CacheConfig,
  type CacheStats,
} from './cache.js';

// ── Graceful Shutdown ──────────────────────────────────────────────────────
export {
  // Classes
  ShutdownManager,
  // Constants
  ShutdownPriority,
  // Singletons
  shutdownManager,
  // Types
  type ShutdownHandler,
  type ShutdownManagerConfig,
} from './graceful-shutdown.js';

// ── Health Monitor ─────────────────────────────────────────────────────────
export {
  // Classes
  HealthMonitor,
  // Factory functions
  createHttpHealthCheck,
  createSimpleHealthCheck,
  // Singletons
  healthMonitor,
  // Types
  type ServiceHealthStatus,
  type HealthCheckRecord,
  type ServiceHealth,
  type HealthCheckFn,
  type HealthMonitorConfig,
  type HealthChangeCallback,
} from './health-monitor.js';
