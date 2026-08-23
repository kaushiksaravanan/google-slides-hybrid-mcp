/**
 * @module shared/container
 * @description Simple dependency injection container for the Google Slides Hybrid MCP server.
 *
 * Holds references to all shared services initialised at startup.
 * This avoids passing dozens of parameters through function calls
 * and gives any module access to services via `getContainer()`.
 *
 * @example
 * ```ts
 * import { initializeContainer, getContainer } from './shared/container.js';
 *
 * // At startup
 * const container = initializeContainer(config);
 *
 * // Anywhere else
 * const { orchestrator, eventBus } = getContainer();
 * ```
 */

import type { StorageAdapter } from '../storage/index.js';
import type { TenantManager } from '../auth/tenant-manager.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { HybridOrchestrator } from '../orchestrator/orchestrator.js';
import type { MetricsRegistry } from '../monitoring/metrics.js';
import type { AlertManager } from '../monitoring/alerts.js';
import type { AuditLogger } from '../monitoring/audit-log.js';
import type { HealthChecker } from '../monitoring/health-checker.js';
import type { EventBus } from '../events/event-bus.js';
import type { WebhookManager } from '../events/webhook-manager.js';
import type { ShutdownManager } from '../resilience/graceful-shutdown.js';
import type { HealthMonitor } from '../resilience/health-monitor.js';
import type { PresentationCache } from '../resilience/cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Service Container Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Global service container holding all shared services. */
export interface ServiceContainer {
  storage: StorageAdapter;
  tenantManager: TenantManager;
  sessionManager: SessionManager;
  orchestrator: HybridOrchestrator;
  metricsRegistry: MetricsRegistry;
  alertManager: AlertManager;
  auditLogger: AuditLogger;
  healthChecker: HealthChecker;
  eventBus: EventBus;
  webhookManager: WebhookManager;
  shutdownManager: ShutdownManager;
  healthMonitor: HealthMonitor;
  cache: PresentationCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module State
// ─────────────────────────────────────────────────────────────────────────────

let container: ServiceContainer | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the global service container with the given services.
 *
 * @param services - All required service instances.
 * @returns The initialised container.
 * @throws If the container is already initialised.
 */
export function initializeContainer(services: ServiceContainer): ServiceContainer {
  if (container !== null) {
    throw new Error('Service container is already initialised. Call destroyContainer() first.');
  }
  container = services;
  return container;
}

/**
 * Retrieve the global service container.
 *
 * @returns The service container.
 * @throws If the container has not been initialised yet.
 */
export function getContainer(): ServiceContainer {
  if (container === null) {
    throw new Error('Service container has not been initialised. Call initializeContainer() first.');
  }
  return container;
}

/**
 * Destroy the global service container and release references.
 * After calling this, `getContainer()` will throw until re-initialised.
 */
export function destroyContainer(): void {
  container = null;
}
