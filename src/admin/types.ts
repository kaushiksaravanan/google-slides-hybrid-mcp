/**
 * @module admin/types
 * @description Type definitions for the admin dashboard, billing integration,
 * and usage quota enforcement systems.
 *
 * Covers admin dashboard statistics, revenue metrics, billing events,
 * usage quotas, and plan-based resource limits used across the admin
 * subsystem.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Revenue Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revenue-related KPIs for the SaaS dashboard.
 */
export interface RevenueMetrics {
  /** Monthly recurring revenue in cents. */
  mrr: number;
  /** Annual recurring revenue in cents (MRR × 12). */
  arr: number;
  /** Monthly churn rate as a decimal (e.g. 0.05 = 5%). */
  churnRate: number;
  /** Monthly expansion rate as a decimal (e.g. 0.10 = 10%). */
  expansionRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Dashboard Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate statistics for the admin dashboard overview.
 */
export interface AdminStats {
  /** Total number of registered tenants. */
  totalTenants: number;
  /** Tenants active in the last 7 days. */
  activeTenants: number;
  /** Total presentations created across all tenants. */
  totalPresentations: number;
  /** Total API calls served. */
  totalApiCalls: number;
  /** Average response time in milliseconds. */
  avgResponseTime: number;
  /** Error rate as a decimal (e.g. 0.02 = 2%). */
  errorRate: number;
  /** Revenue KPIs. */
  revenueMetrics: RevenueMetrics;
  /** Number of tenants on each plan (e.g. { free: 100, pro: 25, enterprise: 3 }). */
  planDistribution: Record<string, number>;
}

/**
 * Daily statistics snapshot for time-series charts.
 */
export interface DailyStats {
  /** ISO-8601 date string (YYYY-MM-DD). */
  date: string;
  /** New tenants registered on this day. */
  newTenants: number;
  /** Active tenants on this day. */
  activeTenants: number;
  /** Presentations created on this day. */
  presentations: number;
  /** API calls served on this day. */
  apiCalls: number;
  /** Average response time in ms on this day. */
  avgResponseTime: number;
  /** Error count on this day. */
  errors: number;
  /** Revenue collected on this day (cents). */
  revenue: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Billing Events
// ─────────────────────────────────────────────────────────────────────────────

/** All recognised billing event types. */
export type BillingEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'invoice.created'
  | 'usage.threshold'
  | 'plan.upgraded'
  | 'plan.downgraded';

/**
 * A billing lifecycle event recorded for audit and processing.
 */
export interface BillingEvent {
  /** Unique billing event identifier. */
  id: string;
  /** Tenant this event relates to. */
  tenantId: string;
  /** Type of billing event. */
  type: BillingEventType;
  /** Event-specific payload data. */
  data: Record<string, unknown>;
  /** When this event occurred. */
  timestamp: Date;
  /** Whether this event has been processed by the billing manager. */
  processed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Quotas
// ─────────────────────────────────────────────────────────────────────────────

/** A used/limit pair for a single resource dimension. */
export interface QuotaBucket {
  used: number;
  limit: number;
}

/** Storage-specific quota bucket (megabytes). */
export interface StorageBucket {
  usedMb: number;
  limitMb: number;
}

/**
 * Current usage quota snapshot for a tenant.
 */
export interface UsageQuota {
  /** The tenant this quota belongs to. */
  tenantId: string;
  /** Quota period. */
  period: 'daily' | 'monthly';
  /** Presentation creation quota. */
  presentations: QuotaBucket;
  /** API call quota. */
  apiCalls: QuotaBucket;
  /** Vision analysis quota. */
  visionAnalyses: QuotaBucket;
  /** Storage quota. */
  storage: StorageBucket;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota Check Results
// ─────────────────────────────────────────────────────────────────────────────

/** Supported quota operation types. */
export type QuotaOperation = 'presentations' | 'apiCalls' | 'visionAnalyses' | 'storage';

/**
 * Result of a quota check for a specific operation.
 */
export interface QuotaCheckResult {
  /** Whether the operation is allowed under the current quota. */
  allowed: boolean;
  /** Remaining units before the quota is exhausted. */
  remaining: number;
  /** When the quota resets (midnight UTC for daily quotas). */
  resetAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan Quota Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-plan daily quota limits.
 */
export interface PlanQuotaLimits {
  presentations: number;
  apiCalls: number;
  visionAnalyses: number;
  storageMb: number;
}

/**
 * Default daily quota limits for each plan tier.
 *
 * Enterprise uses high soft-limit values (not truly unlimited) so that
 * alerting can still fire on unusual activity.
 */
export const PLAN_QUOTA_LIMITS: Record<string, PlanQuotaLimits> = {
  free: {
    presentations: 5,
    apiCalls: 100,
    visionAnalyses: 10,
    storageMb: 100,
  },
  pro: {
    presentations: 50,
    apiCalls: 5_000,
    visionAnalyses: 200,
    storageMb: 5_000,
  },
  enterprise: {
    presentations: 10_000,
    apiCalls: 1_000_000,
    visionAnalyses: 50_000,
    storageMb: 100_000,
  },
};
