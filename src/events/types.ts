/**
 * @module events/types
 * @description Type definitions for the event and webhook system.
 *
 * Covers all system event types (presentation, slide, vision, template,
 * auth, and system events), webhook endpoint configuration, and delivery
 * tracking.  These types are consumed by the EventBus, WebhookManager,
 * and the MCP event/webhook tools.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Event Type Union
// ─────────────────────────────────────────────────────────────────────────────

/** Every event type the system can emit. */
export type EventType =
  // Presentation events
  | 'presentation.created'
  | 'presentation.updated'
  | 'presentation.deleted'
  | 'presentation.shared'
  | 'presentation.exported'
  // Slide events
  | 'slide.created'
  | 'slide.deleted'
  | 'slide.duplicated'
  | 'slide.updated'
  // Vision events
  | 'analysis.completed'
  | 'analysis.failed'
  | 'autofix.applied'
  | 'theme.applied'
  // Template events
  | 'template.used'
  | 'template.created'
  // Auth events
  | 'tenant.created'
  | 'tenant.updated'
  | 'session.created'
  | 'session.expired'
  | 'apikey.created'
  | 'apikey.revoked'
  // System events
  | 'system.started'
  | 'system.shutdown'
  | 'system.error'
  | 'health.changed'
  | 'rate_limit.hit'
  | 'quota.warning'
  | 'quota.exceeded';

// ─────────────────────────────────────────────────────────────────────────────
// System Event
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata attached to every system event. */
export interface EventMetadata {
  /** The subsystem that produced the event (e.g. "api", "vision", "auth"). */
  source: string;
  /** Optional correlation ID for request tracing across service boundaries. */
  correlationId?: string;
  /** Schema version for the event payload (semver). */
  version: string;
}

/**
 * A typed system event.
 *
 * @typeParam T - Shape of the event-specific `data` payload.
 */
export interface SystemEvent<T = unknown> {
  /** Unique event identifier (UUID v4). */
  id: string;
  /** The event type from the {@link EventType} union. */
  type: EventType;
  /** Tenant this event belongs to, if applicable. */
  tenantId?: string;
  /** When the event was created. */
  timestamp: Date;
  /** Event-specific payload. */
  data: T;
  /** Provenance and versioning metadata. */
  metadata: EventMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** A registered webhook endpoint that receives event deliveries. */
export interface WebhookEndpoint {
  /** Unique webhook identifier (UUID v4). */
  id: string;
  /** The tenant that owns this webhook. */
  tenantId: string;
  /** The HTTPS URL to POST events to. */
  url: string;
  /** Which event types this endpoint subscribes to. */
  events: EventType[];
  /** HMAC-SHA256 signing secret for payload verification. */
  secret: string;
  /** Whether deliveries are currently enabled. */
  active: boolean;
  /** When this webhook was registered. */
  createdAt: Date;
  /** Timestamp of the most recent delivery attempt. */
  lastDeliveryAt?: Date;
  /** HTTP status code of the most recent delivery attempt. */
  lastDeliveryStatus?: number;
  /** Consecutive delivery failure count (resets on success). */
  failureCount: number;
  /** Maximum retry attempts per delivery before giving up. */
  maxRetries: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Delivery
// ─────────────────────────────────────────────────────────────────────────────

/** Delivery status for a single webhook invocation attempt. */
export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed' | 'retrying';

/** Tracks the lifecycle of delivering a single event to a single webhook. */
export interface WebhookDelivery {
  /** Unique delivery identifier (UUID v4). */
  id: string;
  /** The webhook endpoint this delivery targets. */
  webhookId: string;
  /** The system event being delivered. */
  eventId: string;
  /** Current delivery status. */
  status: WebhookDeliveryStatus;
  /** Number of delivery attempts made so far. */
  attempts: number;
  /** Timestamp of the most recent delivery attempt. */
  lastAttemptAt?: Date;
  /** When the next retry is scheduled (if status is 'retrying'). */
  nextRetryAt?: Date;
  /** HTTP status code from the webhook endpoint's response. */
  responseStatus?: number;
  /** Truncated response body from the webhook endpoint. */
  responseBody?: string;
  /** Error message if the delivery failed. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler Types
// ─────────────────────────────────────────────────────────────────────────────

/** Async handler function invoked when an event fires. */
export type EventHandler<T = unknown> = (event: SystemEvent<T>) => void | Promise<void>;
