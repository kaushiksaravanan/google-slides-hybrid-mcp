/**
 * @module admin/billing
 * @description Billing integration layer with Stripe-compatible webhook handling,
 * usage metering, and quota enforcement.
 *
 * The BillingManager processes incoming Stripe webhooks, maps them to tenant
 * lifecycle events (plan changes, payment recording, alerts), and provides
 * usage data for metered billing calculations.
 *
 * Webhook signature verification uses HMAC-SHA256 as per the Stripe
 * webhook signing spec.
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { eventBus, EventBus } from '../events/event-bus.js';
import { alertManager } from '../monitoring/alerts.js';
import type { TenantManager } from '../auth/tenant-manager.js';
import type { Plan } from '../auth/types.js';
import type { QuotaManager } from './quota-manager.js';
import type { BillingEvent, BillingEventType, UsageQuota } from './types.js';

const log = createLogger('admin.billing');

// ─────────────────────────────────────────────────────────────────────────────
// Stripe Webhook Types
// ─────────────────────────────────────────────────────────────────────────────

/** Shape of a Stripe webhook event (simplified). */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
}

/** Maps Stripe price IDs to our internal plan names. */
const STRIPE_PRICE_TO_PLAN: Record<string, Plan> = {
  price_free: 'free',
  price_pro_monthly: 'pro',
  price_pro_yearly: 'pro',
  price_enterprise_monthly: 'enterprise',
  price_enterprise_yearly: 'enterprise',
};

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Signature Verification
// ─────────────────────────────────────────────────────────────────────────────

/** Stripe webhook signing header format: `t=<timestamp>,v1=<signature>`. */
interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

/**
 * Parse the Stripe-Signature header into its components.
 *
 * Header format: `t=1614556828,v1=abc123...,v1=def456...`
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader {
  const parts = header.split(',');
  let timestamp = 0;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') {
      timestamp = parseInt(value ?? '0', 10);
    } else if (key === 'v1' && value) {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 *
 * @param payload - Raw request body (string or Buffer).
 * @param signatureHeader - Value of the `Stripe-Signature` header.
 * @param secret - Webhook endpoint signing secret.
 * @param toleranceSeconds - Maximum age of the event in seconds (default 300 = 5 min).
 * @returns `true` if the signature is valid and the timestamp is within tolerance.
 */
export function verifyStripeSignature(
  payload: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300,
): boolean {
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  if (signatures.length === 0 || timestamp === 0) {
    log.warn('Invalid Stripe signature header: missing timestamp or signatures');
    return false;
  }

  // Check timestamp tolerance to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    log.warn('Stripe webhook timestamp outside tolerance', {
      eventTimestamp: timestamp,
      currentTimestamp: now,
      toleranceSeconds,
    });
    return false;
  }

  // Compute expected signature: HMAC-SHA256(secret, "<timestamp>.<payload>")
  const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf-8');
  const signedPayload = `${timestamp}.${payloadStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf-8')
    .digest('hex');

  // Time-safe comparison against all provided signatures
  for (const sig of signatures) {
    if (sig.length === expectedSignature.length) {
      const sigBuf = Buffer.from(sig, 'hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    }
  }

  log.warn('Stripe webhook signature mismatch');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// BillingManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages billing integration with Stripe (or compatible payment processors).
 *
 * Responsibilities:
 * - Process incoming Stripe webhooks and map to tenant lifecycle events
 * - Track billing events for audit purposes
 * - Provide usage data for metered billing
 * - Enforce usage quotas via the QuotaManager
 * - Emit system events on payment failures and plan changes
 */
export class BillingManager {
  /** In-memory billing event log (bounded ring buffer). */
  private readonly events: BillingEvent[] = [];
  private readonly maxEvents: number;

  /** Stripe webhook signing secret. */
  private readonly webhookSecret: string;

  /** Tenant manager for plan updates. */
  private readonly tenantManager: TenantManager;

  /** Quota manager for usage enforcement. */
  private readonly quotaManager: QuotaManager;

  /** Event bus for system events. */
  private readonly bus: EventBus;

  constructor(options: {
    tenantManager: TenantManager;
    quotaManager: QuotaManager;
    webhookSecret?: string;
    maxEvents?: number;
    bus?: EventBus;
  }) {
    this.tenantManager = options.tenantManager;
    this.quotaManager = options.quotaManager;
    this.webhookSecret = options.webhookSecret ?? process.env['STRIPE_WEBHOOK_SECRET'] ?? '';
    this.maxEvents = options.maxEvents ?? 10_000;
    this.bus = options.bus ?? eventBus;

    if (!this.webhookSecret) {
      log.warn('No Stripe webhook secret configured — webhook verification will reject all events');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stripe Webhook Processing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Process a raw Stripe webhook request.
   *
   * Verifies the signature, parses the event, and dispatches to the
   * appropriate handler based on event type.
   *
   * @param rawBody - Raw request body as string or Buffer.
   * @param signatureHeader - Value of the `Stripe-Signature` header.
   * @returns The processed billing event, or throws on verification failure.
   */
  async processStripeWebhook(
    rawBody: string | Buffer,
    signatureHeader: string,
  ): Promise<BillingEvent> {
    // Verify signature
    if (!verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret)) {
      throw new BillingError('Webhook signature verification failed', 'SIGNATURE_INVALID');
    }

    // Parse event
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    let stripeEvent: StripeWebhookEvent;
    try {
      stripeEvent = JSON.parse(bodyStr) as StripeWebhookEvent;
    } catch {
      throw new BillingError('Invalid webhook payload JSON', 'INVALID_PAYLOAD');
    }

    log.info('Processing Stripe webhook', {
      eventId: stripeEvent.id,
      type: stripeEvent.type,
    });

    // Dispatch based on event type
    switch (stripeEvent.type) {
      case 'customer.subscription.created':
        return this.handleSubscriptionCreated(stripeEvent);

      case 'customer.subscription.updated':
        return this.handleSubscriptionUpdated(stripeEvent);

      case 'customer.subscription.deleted':
        return this.handleSubscriptionDeleted(stripeEvent);

      case 'invoice.payment_succeeded':
        return this.handlePaymentSucceeded(stripeEvent);

      case 'invoice.payment_failed':
        return this.handlePaymentFailed(stripeEvent);

      default:
        log.debug('Unhandled Stripe event type', { type: stripeEvent.type });
        return this.recordBillingEvent({
          id: stripeEvent.id,
          tenantId: this.extractTenantId(stripeEvent),
          type: 'subscription.updated',
          data: { stripeEvent: stripeEvent.data.object },
          timestamp: new Date(stripeEvent.created * 1000),
          processed: true,
        });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle `customer.subscription.created` — create or upgrade tenant.
   */
  private async handleSubscriptionCreated(
    event: StripeWebhookEvent,
  ): Promise<BillingEvent> {
    const sub = event.data.object;
    const tenantId = this.extractTenantId(event);
    const plan = this.resolvePlan(sub);

    // Update tenant plan if tenant exists
    const tenant = this.tenantManager.getTenant(tenantId);
    if (tenant) {
      this.tenantManager.updateTenant(tenantId, { plan });
      log.info('Tenant plan set from new subscription', { tenantId, plan });
    } else {
      log.warn('Subscription created for unknown tenant', { tenantId });
    }

    this.bus.emit(EventBus.createEvent('tenant.updated', {
      tenantId,
      action: 'subscription.created',
      plan,
    }, { tenantId, source: 'billing' }));

    return this.recordBillingEvent({
      id: event.id,
      tenantId,
      type: 'subscription.created',
      data: {
        plan,
        subscriptionId: sub['id'],
        customerId: sub['customer'],
        status: sub['status'],
      },
      timestamp: new Date(event.created * 1000),
      processed: true,
    });
  }

  /**
   * Handle `customer.subscription.updated` — update plan (upgrade/downgrade).
   */
  private async handleSubscriptionUpdated(
    event: StripeWebhookEvent,
  ): Promise<BillingEvent> {
    const sub = event.data.object;
    const tenantId = this.extractTenantId(event);
    const newPlan = this.resolvePlan(sub);

    const tenant = this.tenantManager.getTenant(tenantId);
    if (tenant) {
      const previousPlan = tenant.plan;
      this.tenantManager.updateTenant(tenantId, { plan: newPlan });

      const isUpgrade = this.isPlanUpgrade(previousPlan, newPlan);
      const billingType: BillingEventType = isUpgrade ? 'plan.upgraded' : 'plan.downgraded';

      log.info('Tenant plan updated', { tenantId, previousPlan, newPlan, billingType });

      this.bus.emit(EventBus.createEvent('tenant.updated', {
        tenantId,
        action: billingType,
        previousPlan,
        newPlan,
      }, { tenantId, source: 'billing' }));

      return this.recordBillingEvent({
        id: event.id,
        tenantId,
        type: billingType,
        data: {
          previousPlan,
          newPlan,
          subscriptionId: sub['id'],
          status: sub['status'],
        },
        timestamp: new Date(event.created * 1000),
        processed: true,
      });
    }

    return this.recordBillingEvent({
      id: event.id,
      tenantId,
      type: 'subscription.updated',
      data: { plan: newPlan, subscriptionId: sub['id'] },
      timestamp: new Date(event.created * 1000),
      processed: true,
    });
  }

  /**
   * Handle `customer.subscription.deleted` — downgrade to free.
   */
  private async handleSubscriptionDeleted(
    event: StripeWebhookEvent,
  ): Promise<BillingEvent> {
    const sub = event.data.object;
    const tenantId = this.extractTenantId(event);

    const tenant = this.tenantManager.getTenant(tenantId);
    if (tenant) {
      const previousPlan = tenant.plan;
      this.tenantManager.updateTenant(tenantId, { plan: 'free' });

      log.info('Subscription deleted — tenant downgraded to free', {
        tenantId,
        previousPlan,
      });

      this.bus.emit(EventBus.createEvent('tenant.updated', {
        tenantId,
        action: 'subscription.cancelled',
        previousPlan,
        newPlan: 'free',
      }, { tenantId, source: 'billing' }));
    }

    return this.recordBillingEvent({
      id: event.id,
      tenantId,
      type: 'subscription.cancelled',
      data: {
        subscriptionId: sub['id'],
        cancelledAt: sub['canceled_at'] ?? sub['cancelled_at'],
      },
      timestamp: new Date(event.created * 1000),
      processed: true,
    });
  }

  /**
   * Handle `invoice.payment_succeeded` — record payment.
   */
  private async handlePaymentSucceeded(
    event: StripeWebhookEvent,
  ): Promise<BillingEvent> {
    const invoice = event.data.object;
    const tenantId = this.extractTenantId(event);
    const amount = (invoice['amount_paid'] as number) ?? 0;

    log.info('Payment succeeded', {
      tenantId,
      amount,
      invoiceId: invoice['id'],
    });

    this.bus.emit(EventBus.createEvent('tenant.updated', {
      tenantId,
      action: 'payment.succeeded',
      amount,
      invoiceId: invoice['id'],
    }, { tenantId, source: 'billing' }));

    return this.recordBillingEvent({
      id: event.id,
      tenantId,
      type: 'payment.succeeded',
      data: {
        amount,
        currency: invoice['currency'],
        invoiceId: invoice['id'],
        subscriptionId: invoice['subscription'],
      },
      timestamp: new Date(event.created * 1000),
      processed: true,
    });
  }

  /**
   * Handle `invoice.payment_failed` — flag tenant and send alert.
   */
  private async handlePaymentFailed(
    event: StripeWebhookEvent,
  ): Promise<BillingEvent> {
    const invoice = event.data.object;
    const tenantId = this.extractTenantId(event);
    const amount = (invoice['amount_due'] as number) ?? 0;
    const attemptCount = (invoice['attempt_count'] as number) ?? 1;

    log.error('Payment failed', {
      tenantId,
      amount,
      attemptCount,
      invoiceId: invoice['id'],
    });

    // Send an alert through the alert system
    const alertChannels = alertManager['channels'] as Array<{ send: (a: unknown) => Promise<void> }>;
    for (const channel of alertChannels) {
      channel.send({
        ruleName: 'payment_failed',
        severity: attemptCount >= 3 ? 'critical' : 'warning',
        message: `Payment failed for tenant ${tenantId}: $${(amount / 100).toFixed(2)} (attempt ${attemptCount})`,
        value: attemptCount,
        threshold: 1,
        firedAt: new Date().toISOString(),
        state: 'firing',
      }).catch((err: Error) => {
        log.error('Failed to send payment failure alert', { error: err.message });
      });
    }

    this.bus.emit(EventBus.createEvent('system.error', {
      type: 'payment.failed',
      tenantId,
      amount,
      attemptCount,
      invoiceId: invoice['id'],
    }, { tenantId, source: 'billing' }));

    return this.recordBillingEvent({
      id: event.id,
      tenantId,
      type: 'payment.failed',
      data: {
        amount,
        currency: invoice['currency'],
        invoiceId: invoice['id'],
        attemptCount,
        nextPaymentAttempt: invoice['next_payment_attempt'],
      },
      timestamp: new Date(event.created * 1000),
      processed: true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Usage & Quota
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check the current usage quota for a tenant.
   */
  checkUsageQuota(tenantId: string): UsageQuota {
    return this.quotaManager.getQuotaStatus(tenantId);
  }

  /**
   * Enforce quota for a specific operation.
   * Returns `true` if the operation is allowed, `false` if it should be denied.
   */
  enforceQuota(tenantId: string, operation: 'presentations' | 'apiCalls' | 'visionAnalyses' | 'storage'): boolean {
    const result = this.quotaManager.consumeQuota(tenantId, operation);
    return result.allowed;
  }

  /**
   * Get usage data formatted for billing calculations.
   */
  getUsageForBilling(
    tenantId: string,
    period: 'daily' | 'monthly',
  ): {
    tenantId: string;
    presentations: number;
    apiCalls: number;
    visionAnalyses: number;
    storageMb: number;
    periodStart: string;
    periodEnd: string;
  } {
    return this.quotaManager.getUsageForBilling(tenantId, period);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Billing Event Storage
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a billing event in the in-memory audit log.
   */
  recordBillingEvent(event: BillingEvent): BillingEvent {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    log.debug('Billing event recorded', {
      id: event.id,
      type: event.type,
      tenantId: event.tenantId,
    });

    return event;
  }

  /**
   * List billing events with optional filters.
   */
  listEvents(filters?: {
    tenantId?: string;
    type?: BillingEventType;
    processed?: boolean;
    limit?: number;
    offset?: number;
  }): { items: BillingEvent[]; total: number } {
    let results = [...this.events];

    if (filters?.tenantId) {
      results = results.filter((e) => e.tenantId === filters.tenantId);
    }
    if (filters?.type) {
      results = results.filter((e) => e.type === filters.type);
    }
    if (filters?.processed !== undefined) {
      results = results.filter((e) => e.processed === filters.processed);
    }

    const total = results.length;

    // Sort newest first
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 50;
    const items = results.slice(offset, offset + limit);

    return { items, total };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract the tenant ID from a Stripe event.
   *
   * Looks at `metadata.tenantId` on the object first, then falls back to
   * using the customer ID as a tenant reference.
   */
  private extractTenantId(event: StripeWebhookEvent): string {
    const obj = event.data.object;
    const metadata = obj['metadata'] as Record<string, string> | undefined;

    if (metadata?.['tenantId']) {
      return metadata['tenantId'];
    }

    // Fall back to customer ID
    const customer = obj['customer'] as string | undefined;
    return customer ?? `stripe_${event.id}`;
  }

  /**
   * Resolve the internal Plan from a Stripe subscription/price object.
   */
  private resolvePlan(obj: Record<string, unknown>): Plan {
    // Try items.data[0].price.id
    const items = obj['items'] as { data?: Array<{ price?: { id?: string } }> } | undefined;
    const priceId = items?.data?.[0]?.price?.id;
    if (priceId && STRIPE_PRICE_TO_PLAN[priceId]) {
      return STRIPE_PRICE_TO_PLAN[priceId]!;
    }

    // Try plan.id (legacy Stripe format)
    const plan = obj['plan'] as { id?: string } | undefined;
    if (plan?.id && STRIPE_PRICE_TO_PLAN[plan.id]) {
      return STRIPE_PRICE_TO_PLAN[plan.id]!;
    }

    // Try metadata.plan
    const metadata = obj['metadata'] as Record<string, string> | undefined;
    if (metadata?.['plan']) {
      const planName = metadata['plan'] as Plan;
      if (['free', 'pro', 'enterprise'].includes(planName)) {
        return planName;
      }
    }

    return 'free';
  }

  /**
   * Determine if a plan change is an upgrade.
   */
  private isPlanUpgrade(from: Plan, to: Plan): boolean {
    const order: Record<Plan, number> = { free: 0, pro: 1, enterprise: 2 };
    return order[to] > order[from];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Billing-specific error with a machine-readable code.
 */
export class BillingError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
