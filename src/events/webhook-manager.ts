/**
 * @module events/webhook-manager
 * @description Webhook delivery system that listens to the in-process
 * {@link EventBus}, matches events against registered endpoint subscriptions,
 * signs payloads with HMAC-SHA256, delivers via HTTP POST, and retries
 * failed deliveries with exponential backoff.
 *
 * ```ts
 * import { webhookManager } from './webhook-manager.js';
 *
 * const endpoint = webhookManager.registerWebhook(
 *   'tenant-1',
 *   'https://example.com/hooks',
 *   ['presentation.created', 'slide.created'],
 * );
 *
 * // Events from the EventBus are automatically delivered.
 * ```
 */

import { randomUUID, createHmac } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { eventBus } from './event-bus.js';
import type {
  EventType,
  SystemEvent,
  WebhookEndpoint,
  WebhookDelivery,
} from './types.js';

const log = createLogger('events.webhooks');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Retry delays in milliseconds: 1 min, 5 min, 30 min, 2 hr. */
const RETRY_DELAYS_MS: readonly number[] = [
  1 * 60 * 1_000,
  5 * 60 * 1_000,
  30 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
];

/** After this many consecutive failures the webhook is auto-disabled. */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Maximum response body bytes stored per delivery record. */
const MAX_RESPONSE_BODY = 2048;

/** HTTP request timeout for webhook delivery (ms). */
const DELIVERY_TIMEOUT_MS = 30_000;

/** Maximum number of delivery records retained per webhook. */
const MAX_DELIVERIES_PER_WEBHOOK = 500;

// ─────────────────────────────────────────────────────────────────────────────
// HMAC Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 signature of a payload string using the given
 * secret.  Returns the hex-encoded digest prefixed with `sha256=`.
 */
function signPayload(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebhookManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages webhook endpoint registrations, matches incoming events against
 * subscriptions, and handles reliable delivery with retries.
 */
export class WebhookManager {
  /** Registered webhook endpoints keyed by webhook ID. */
  private readonly endpoints = new Map<string, WebhookEndpoint>();

  /** Delivery history keyed by webhook ID -> array of deliveries. */
  private readonly deliveries = new Map<string, WebhookDelivery[]>();

  /** Pending retry timers so they can be cancelled on shutdown. */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Whether this manager has subscribed to the event bus. */
  private subscribed = false;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start listening for events on the global {@link eventBus}.
   * Safe to call multiple times; only subscribes once.
   */
  start(): void {
    if (this.subscribed) return;
    eventBus.on('*', this.handleEvent);
    this.subscribed = true;
    log.info('WebhookManager subscribed to EventBus');
  }

  /**
   * Stop listening and cancel all pending retry timers.
   */
  stop(): void {
    if (this.subscribed) {
      eventBus.off('*', this.handleEvent);
      this.subscribed = false;
    }
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    log.info('WebhookManager stopped');
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Register a new webhook endpoint.
   *
   * @param tenantId - Owning tenant identifier.
   * @param url      - HTTPS URL to receive POSTed events.
   * @param events   - Event types to subscribe to.
   * @param secret   - Optional HMAC signing secret.  A random secret is
   *                    generated if omitted.
   * @returns The newly created {@link WebhookEndpoint}.
   */
  registerWebhook(
    tenantId: string,
    url: string,
    events: EventType[],
    secret?: string,
  ): WebhookEndpoint {
    const endpoint: WebhookEndpoint = {
      id: randomUUID(),
      tenantId,
      url,
      events: [...events],
      secret: secret ?? randomUUID(),
      active: true,
      createdAt: new Date(),
      failureCount: 0,
      maxRetries: RETRY_DELAYS_MS.length,
    };

    this.endpoints.set(endpoint.id, endpoint);
    this.deliveries.set(endpoint.id, []);

    log.info('Webhook registered', {
      webhookId: endpoint.id,
      tenantId,
      url,
      events,
    });

    return endpoint;
  }

  /**
   * Unregister a webhook endpoint and discard its delivery history.
   *
   * @returns `true` if the webhook existed and was removed.
   */
  unregisterWebhook(webhookId: string): boolean {
    const existed = this.endpoints.delete(webhookId);
    this.deliveries.delete(webhookId);
    if (existed) {
      log.info('Webhook unregistered', { webhookId });
    }
    return existed;
  }

  /**
   * List all webhook endpoints for a tenant.
   */
  listWebhooks(tenantId: string): WebhookEndpoint[] {
    const results: WebhookEndpoint[] = [];
    for (const ep of this.endpoints.values()) {
      if (ep.tenantId === tenantId) {
        results.push({ ...ep });
      }
    }
    return results;
  }

  /**
   * Get a single webhook endpoint by ID.
   */
  getWebhook(webhookId: string): WebhookEndpoint | undefined {
    const ep = this.endpoints.get(webhookId);
    return ep ? { ...ep } : undefined;
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  /**
   * Deliver an event to **all** matching active webhook endpoints.
   *
   * This is called automatically by the EventBus subscription, but can
   * also be invoked directly for manual dispatch.
   */
  async deliverEvent(event: SystemEvent): Promise<void> {
    const matching = this.findMatchingEndpoints(event);
    if (matching.length === 0) return;

    log.debug('Delivering event to webhooks', {
      eventId: event.id,
      type: event.type,
      endpointCount: matching.length,
    });

    const promises = matching.map((ep) => this.deliverToEndpoint(ep, event));
    await Promise.allSettled(promises);
  }

  /**
   * Return the delivery history for a specific webhook endpoint.
   *
   * @param webhookId - The webhook endpoint ID.
   * @param limit     - Maximum records to return (default 50, newest first).
   */
  getDeliveryHistory(webhookId: string, limit: number = 50): WebhookDelivery[] {
    const records = this.deliveries.get(webhookId);
    if (!records) return [];
    // newest first
    return records.slice().reverse().slice(0, limit);
  }

  /**
   * Re-deliver a previously failed delivery.
   *
   * @param deliveryId - The delivery record ID to replay.
   * @returns `true` if the delivery was found, re-queued, and succeeded.
   */
  async replayEvent(deliveryId: string): Promise<boolean> {
    // Find the delivery record across all endpoints
    for (const [webhookId, records] of this.deliveries.entries()) {
      const record = records.find((d) => d.id === deliveryId);
      if (!record) continue;

      const endpoint = this.endpoints.get(webhookId);
      if (!endpoint) {
        log.warn('Replay failed: endpoint no longer exists', { deliveryId, webhookId });
        return false;
      }

      // Retrieve the original event from EventBus history
      const history = eventBus.getHistory(undefined, 1000);
      const originalEvent = history.find((e) => e.id === record.eventId);
      if (!originalEvent) {
        log.warn('Replay failed: original event not found in history', {
          deliveryId,
          eventId: record.eventId,
        });
        return false;
      }

      log.info('Replaying webhook delivery', { deliveryId, webhookId, eventId: record.eventId });
      await this.deliverToEndpoint(endpoint, originalEvent);
      return true;
    }

    log.warn('Replay failed: delivery record not found', { deliveryId });
    return false;
  }

  /**
   * Send a test event to a specific webhook endpoint to verify connectivity.
   *
   * @param webhookId - The webhook to test.
   * @returns The resulting {@link WebhookDelivery} record.
   */
  async testWebhook(webhookId: string): Promise<WebhookDelivery | undefined> {
    const endpoint = this.endpoints.get(webhookId);
    if (!endpoint) {
      log.warn('Test failed: webhook not found', { webhookId });
      return undefined;
    }

    const testEvent: SystemEvent = {
      id: randomUUID(),
      type: 'system.started',
      timestamp: new Date(),
      tenantId: endpoint.tenantId,
      data: { test: true, message: 'Webhook connectivity test' },
      metadata: { source: 'webhook-manager', version: '1.0.0' },
    };

    return this.deliverToEndpoint(endpoint, testEvent);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Bound handler for EventBus subscription. */
  private readonly handleEvent = (event: SystemEvent): void => {
    // Fire-and-forget; errors are handled inside deliverEvent.
    void this.deliverEvent(event).catch((err) => {
      log.error('Unexpected error in deliverEvent', {
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  /** Find all active endpoints whose subscriptions match the event type. */
  private findMatchingEndpoints(event: SystemEvent): WebhookEndpoint[] {
    const results: WebhookEndpoint[] = [];
    for (const ep of this.endpoints.values()) {
      if (!ep.active) continue;
      if (event.tenantId && ep.tenantId !== event.tenantId) continue;
      if (ep.events.includes(event.type)) {
        results.push(ep);
      }
    }
    return results;
  }

  /** Deliver a single event to a single endpoint, with retry scheduling. */
  private async deliverToEndpoint(
    endpoint: WebhookEndpoint,
    event: SystemEvent,
  ): Promise<WebhookDelivery> {
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      webhookId: endpoint.id,
      eventId: event.id,
      status: 'pending',
      attempts: 0,
    };

    this.recordDelivery(endpoint.id, delivery);

    await this.attemptDelivery(endpoint, event, delivery);

    return delivery;
  }

  /** Attempt a single HTTP POST and update the delivery record. */
  private async attemptDelivery(
    endpoint: WebhookEndpoint,
    event: SystemEvent,
    delivery: WebhookDelivery,
  ): Promise<void> {
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date();

    const payload = JSON.stringify({
      id: event.id,
      type: event.type,
      tenantId: event.tenantId,
      timestamp: event.timestamp.toISOString(),
      data: event.data,
      metadata: event.metadata,
    });

    const signature = signPayload(payload, endpoint.secret);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'GoogleSlidesMCP-Webhook/1.0',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': event.type,
          'X-Webhook-Delivery-ID': delivery.id,
        },
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      delivery.responseStatus = response.status;

      // Read a limited portion of the response body
      try {
        const text = await response.text();
        delivery.responseBody = text.slice(0, MAX_RESPONSE_BODY);
      } catch {
        // Ignore response body read failures
      }

      if (response.ok) {
        // Success
        delivery.status = 'success';
        endpoint.lastDeliveryAt = new Date();
        endpoint.lastDeliveryStatus = response.status;
        endpoint.failureCount = 0;

        log.debug('Webhook delivered successfully', {
          webhookId: endpoint.id,
          deliveryId: delivery.id,
          status: response.status,
        });
      } else {
        // Non-2xx response
        this.handleFailure(endpoint, event, delivery, `HTTP ${response.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      delivery.error = message;
      this.handleFailure(endpoint, event, delivery, message);
    }

    // Update endpoint state
    if (delivery.status !== 'success') {
      endpoint.lastDeliveryAt = new Date();
      endpoint.lastDeliveryStatus = delivery.responseStatus;
    }
  }

  /** Handle a delivery failure: increment counters, schedule retry or disable. */
  private handleFailure(
    endpoint: WebhookEndpoint,
    event: SystemEvent,
    delivery: WebhookDelivery,
    reason: string,
  ): void {
    endpoint.failureCount += 1;

    log.warn('Webhook delivery failed', {
      webhookId: endpoint.id,
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      reason,
      failureCount: endpoint.failureCount,
    });

    // Check if we should disable the endpoint
    if (endpoint.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      endpoint.active = false;
      delivery.status = 'failed';
      log.error('Webhook disabled after consecutive failures', {
        webhookId: endpoint.id,
        failureCount: endpoint.failureCount,
      });
      return;
    }

    // Check if we have retries remaining
    const retryIndex = delivery.attempts - 1; // attempts is already incremented
    if (retryIndex >= RETRY_DELAYS_MS.length) {
      delivery.status = 'failed';
      log.warn('Webhook delivery exhausted all retries', {
        webhookId: endpoint.id,
        deliveryId: delivery.id,
        attempts: delivery.attempts,
      });
      return;
    }

    // Schedule retry
    const delayMs = RETRY_DELAYS_MS[retryIndex]!;
    delivery.status = 'retrying';
    delivery.nextRetryAt = new Date(Date.now() + delayMs);

    log.info('Scheduling webhook retry', {
      webhookId: endpoint.id,
      deliveryId: delivery.id,
      retryIndex,
      delayMs,
      nextRetryAt: delivery.nextRetryAt.toISOString(),
    });

    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);

      // Verify the endpoint still exists and is active
      const currentEndpoint = this.endpoints.get(endpoint.id);
      if (!currentEndpoint || !currentEndpoint.active) {
        delivery.status = 'failed';
        delivery.error = 'Webhook was disabled or removed before retry';
        return;
      }

      void this.attemptDelivery(currentEndpoint, event, delivery).catch((err) => {
        log.error('Retry attempt failed unexpectedly', {
          webhookId: endpoint.id,
          deliveryId: delivery.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);

    this.retryTimers.add(timer);
  }

  /** Append a delivery record to the per-webhook history, pruning old records. */
  private recordDelivery(webhookId: string, delivery: WebhookDelivery): void {
    let records = this.deliveries.get(webhookId);
    if (!records) {
      records = [];
      this.deliveries.set(webhookId, records);
    }
    records.push(delivery);

    // Prune oldest entries if we exceed the limit
    if (records.length > MAX_DELIVERIES_PER_WEBHOOK) {
      records.splice(0, records.length - MAX_DELIVERIES_PER_WEBHOOK);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global singleton webhook manager instance. */
export const webhookManager = new WebhookManager();
