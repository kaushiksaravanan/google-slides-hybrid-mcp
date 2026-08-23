/**
 * @module monitoring/audit-log
 * @description Audit logging for all significant actions in the MCP server.
 *
 * Records tenant operations, presentation actions, API key lifecycle,
 * authentication attempts, configuration changes, and rate limit overrides
 * into both a structured logger and a pluggable storage adapter.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('monitoring.audit');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported audit event actions. */
export type AuditAction =
  // Tenant lifecycle
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.deleted'
  // Presentation lifecycle
  | 'presentation.created'
  | 'presentation.shared'
  | 'presentation.deleted'
  | 'presentation.exported'
  // API key lifecycle
  | 'apikey.generated'
  | 'apikey.revoked'
  // Authentication
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.token.refreshed'
  | 'auth.token.revoked'
  // Configuration
  | 'config.changed'
  | 'config.rate_limit_override'
  // Administrative
  | 'admin.plan_changed'
  | 'admin.feature_toggled'
  // Catch-all for extensibility
  | string;

/**
 * An audit event representing a significant action.
 */
export interface AuditEvent {
  /** Unique event ID (generated automatically if not provided). */
  id?: string;
  /** ISO-8601 timestamp of when the event occurred. */
  timestamp: string;
  /** The tenant that performed or was affected by the action. */
  tenantId: string;
  /** The action that was performed. */
  action: AuditAction;
  /** The type of resource affected (e.g. 'presentation', 'apikey', 'tenant'). */
  resource: string;
  /** Optional resource ID (e.g. presentation ID, API key prefix). */
  resourceId?: string;
  /** Free-form details about the action. */
  details: Record<string, unknown>;
  /** IP address of the client that initiated the action. */
  ipAddress?: string;
  /** User-Agent header from the client. */
  userAgent?: string;
  /** The authentication method used (e.g. 'api_key', 'session', 'oauth2'). */
  authMethod?: string;
  /** Outcome: 'success' or 'failure'. */
  outcome?: 'success' | 'failure';
}

/**
 * Filters for querying the audit log.
 */
export interface AuditQueryFilters {
  /** Filter by tenant ID. */
  tenantId?: string;
  /** Filter by action (exact match or prefix match with '*'). */
  action?: string;
  /** Filter by resource type. */
  resource?: string;
  /** Filter by resource ID. */
  resourceId?: string;
  /** Only events at or after this timestamp. */
  startTime?: string;
  /** Only events before this timestamp. */
  endTime?: string;
  /** Filter by outcome. */
  outcome?: 'success' | 'failure';
  /** Maximum number of events to return (default 100). */
  limit?: number;
  /** Offset for pagination (default 0). */
  offset?: number;
}

/**
 * Pluggable storage adapter for persisting audit events.
 */
export interface AuditStorageAdapter {
  /** Persist an audit event. */
  store(event: AuditEvent): Promise<void>;
  /** Query stored audit events. */
  query(filters: AuditQueryFilters): Promise<{ items: AuditEvent[]; total: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Storage Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default in-memory audit storage adapter.
 *
 * Stores events in a bounded ring buffer. Suitable for development and
 * testing. For production, replace with a persistent adapter (database, S3,
 * log aggregator, etc.).
 */
export class InMemoryAuditStorage implements AuditStorageAdapter {
  private readonly events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents;
  }

  async store(event: AuditEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  async query(filters: AuditQueryFilters): Promise<{ items: AuditEvent[]; total: number }> {
    let results = this.events;

    // Apply filters
    if (filters.tenantId) {
      results = results.filter((e) => e.tenantId === filters.tenantId);
    }
    if (filters.action) {
      if (filters.action.endsWith('*')) {
        const prefix = filters.action.slice(0, -1);
        results = results.filter((e) => e.action.startsWith(prefix));
      } else {
        results = results.filter((e) => e.action === filters.action);
      }
    }
    if (filters.resource) {
      results = results.filter((e) => e.resource === filters.resource);
    }
    if (filters.resourceId) {
      results = results.filter((e) => e.resourceId === filters.resourceId);
    }
    if (filters.outcome) {
      results = results.filter((e) => e.outcome === filters.outcome);
    }
    if (filters.startTime) {
      results = results.filter((e) => e.timestamp >= filters.startTime!);
    }
    if (filters.endTime) {
      results = results.filter((e) => e.timestamp < filters.endTime!);
    }

    const total = results.length;

    // Sort newest first
    results = [...results].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // Pagination
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    const items = results.slice(offset, offset + limit);

    return { items, total };
  }

  /** Get total event count (for diagnostics). */
  get size(): number {
    return this.events.length;
  }

  /** Clear all events. */
  clear(): void {
    this.events.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit Logger
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a simple unique ID for audit events. */
function generateEventId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `aud_${timestamp}_${random}`;
}

/**
 * Central audit logger that records significant actions to both a
 * structured log output and a pluggable storage adapter.
 */
export class AuditLogger {
  private storage: AuditStorageAdapter;

  constructor(storage?: AuditStorageAdapter) {
    this.storage = storage ?? new InMemoryAuditStorage();
  }

  /**
   * Replace the storage adapter at runtime (e.g. after database initialisation).
   */
  setStorage(storage: AuditStorageAdapter): void {
    this.storage = storage;
  }

  /**
   * Record an audit event.
   *
   * The event is written to both the structured logger (for real-time
   * observability) and the storage adapter (for query/compliance).
   */
  async log(event: AuditEvent): Promise<AuditEvent> {
    // Fill defaults — spread event first, then override missing fields
    const enrichedEvent: AuditEvent = {
      ...event,
      id: event.id ?? generateEventId(),
      timestamp: event.timestamp || new Date().toISOString(),
      outcome: event.outcome ?? 'success',
    };

    // Structured log output
    log.info(`[AUDIT] ${enrichedEvent.action} on ${enrichedEvent.resource}`, {
      audit: {
        id: enrichedEvent.id,
        tenantId: enrichedEvent.tenantId,
        action: enrichedEvent.action,
        resource: enrichedEvent.resource,
        resourceId: enrichedEvent.resourceId,
        outcome: enrichedEvent.outcome,
        ipAddress: enrichedEvent.ipAddress,
        details: enrichedEvent.details,
      },
    });

    // Persist
    try {
      await this.storage.store(enrichedEvent);
    } catch (err) {
      log.error('Failed to persist audit event', {
        eventId: enrichedEvent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return enrichedEvent;
  }

  /**
   * Query the audit log with filters.
   */
  async query(filters: AuditQueryFilters): Promise<{ items: AuditEvent[]; total: number }> {
    return this.storage.query(filters);
  }

  // ── Convenience methods ─────────────────────────────────────────────

  /** Record a tenant lifecycle event. */
  async logTenantEvent(
    action: 'tenant.created' | 'tenant.updated' | 'tenant.deleted',
    tenantId: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action,
      resource: 'tenant',
      resourceId: tenantId,
      details,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /** Record a presentation lifecycle event. */
  async logPresentationEvent(
    action: 'presentation.created' | 'presentation.shared' | 'presentation.deleted' | 'presentation.exported',
    tenantId: string,
    presentationId: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action,
      resource: 'presentation',
      resourceId: presentationId,
      details,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /** Record an API key lifecycle event. */
  async logApiKeyEvent(
    action: 'apikey.generated' | 'apikey.revoked',
    tenantId: string,
    keyPrefix: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action,
      resource: 'apikey',
      resourceId: keyPrefix,
      details,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /** Record an authentication event. */
  async logAuthEvent(
    action: 'auth.login.success' | 'auth.login.failure' | 'auth.logout' | 'auth.token.refreshed' | 'auth.token.revoked',
    tenantId: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string; authMethod?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action,
      resource: 'auth',
      details,
      outcome: action === 'auth.login.failure' ? 'failure' : 'success',
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      authMethod: context?.authMethod,
    });
  }

  /** Record a configuration change. */
  async logConfigChange(
    tenantId: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action: 'config.changed',
      resource: 'config',
      details,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /** Record a rate limit override. */
  async logRateLimitOverride(
    tenantId: string,
    details: Record<string, unknown>,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuditEvent> {
    return this.log({
      timestamp: new Date().toISOString(),
      tenantId,
      action: 'config.rate_limit_override',
      resource: 'rate_limit',
      details,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global audit logger instance with in-memory storage. */
export const auditLogger = new AuditLogger();
