/**
 * @module admin/index
 * @description Public exports for the admin dashboard, billing integration,
 * and usage quota enforcement subsystem.
 */

// Types
export type {
  AdminStats,
  DailyStats,
  RevenueMetrics,
  BillingEvent,
  BillingEventType,
  UsageQuota,
  QuotaBucket,
  StorageBucket,
  QuotaOperation,
  QuotaCheckResult,
  PlanQuotaLimits,
} from './types.js';

export { PLAN_QUOTA_LIMITS } from './types.js';

// Admin API
export { createAdminApiRouter } from './admin-api.js';
export type { AdminApiDependencies } from './admin-api.js';

// Billing
export { BillingManager, BillingError, verifyStripeSignature } from './billing.js';
export type { StripeWebhookEvent } from './billing.js';

// Quota Manager
export { QuotaManager } from './quota-manager.js';
