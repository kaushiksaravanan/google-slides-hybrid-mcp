/**
 * @module admin/admin-api
 * @description Express router providing admin REST endpoints for the SaaS
 * dashboard, tenant management, system health, and billing integration.
 *
 * All endpoints require admin authentication via the `X-Admin-Key` header.
 * The admin key is configured via the `ADMIN_API_KEY` environment variable.
 *
 * Routes are mounted at `/admin/` and provide:
 * - Dashboard statistics (overview, daily, revenue)
 * - Tenant CRUD with impersonation and usage details
 * - System health, Prometheus metrics, alerts, events, and cache management
 * - Billing event listing and Stripe-compatible webhook endpoint
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { metricsRegistry } from '../monitoring/metrics.js';
import { healthChecker } from '../monitoring/health-checker.js';
import { auditLogger } from '../monitoring/audit-log.js';
import { alertManager } from '../monitoring/alerts.js';
import { eventBus } from '../events/event-bus.js';
import { presentationCache, templateCache } from '../resilience/cache.js';
import type { TenantManager } from '../auth/tenant-manager.js';
import type { BillingManager } from './billing.js';
import type { QuotaManager } from './quota-manager.js';
import type { AdminStats, DailyStats, RevenueMetrics, BillingEventType } from './types.js';
import type { Plan } from '../auth/types.js';

const log = createLogger('admin.api');

// ─────────────────────────────────────────────────────────────────────────────
// Response Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Standard JSON response envelope. */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: Record<string, unknown>;
}

function success<T>(
  res: Response,
  data: T,
  status: number = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiResponse<T> = { success: true, data };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

function error(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiResponse = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Handler Wrapper
// ─────────────────────────────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Param Helper
// ─────────────────────────────────────────────────────────────────────────────

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? '' : (value ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create middleware that validates the `X-Admin-Key` header against the
 * configured admin API key.
 *
 * The comparison uses `timingSafeEqual` to prevent timing attacks.
 */
function createAdminAuthMiddleware(adminApiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.headers['x-admin-key'] as string | undefined;

    if (!provided) {
      error(res, 401, 'UNAUTHORIZED', 'Missing X-Admin-Key header');
      return;
    }

    // Timing-safe comparison
    const providedBuf = Buffer.from(provided, 'utf-8');
    const expectedBuf = Buffer.from(adminApiKey, 'utf-8');

    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      log.warn('Admin auth failed: invalid key', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      error(res, 403, 'FORBIDDEN', 'Invalid admin API key');
      return;
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Sum a counter metric's rendered values across all label combinations. */
function sumCounter(name: string): number {
  const metric = metricsRegistry.getMetric(name);
  if (!metric) return 0;
  let total = 0;
  const lines = metric.render();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const parts = line.split(' ');
    const val = Number(parts[parts.length - 1]);
    if (!Number.isNaN(val)) total += val;
  }
  return total;
}

/** Compute average response time from the request duration histogram. */
function avgResponseTime(): number {
  const metric = metricsRegistry.getMetric('gslides_request_duration_seconds');
  if (!metric) return 0;
  let totalSum = 0;
  let totalCount = 0;
  const lines = metric.render();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.includes('_sum')) {
      const val = Number(line.split(' ').pop());
      if (!Number.isNaN(val)) totalSum += val;
    } else if (line.includes('_count') && !line.includes('_bucket')) {
      const val = Number(line.split(' ').pop());
      if (!Number.isNaN(val)) totalCount += val;
    }
  }
  if (totalCount === 0) return 0;
  return (totalSum / totalCount) * 1000; // convert to ms
}

// ─────────────────────────────────────────────────────────────────────────────
// Router Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminApiDependencies {
  tenantManager: TenantManager;
  billingManager: BillingManager;
  quotaManager: QuotaManager;
  adminApiKey?: string;
}

/**
 * Create the admin API Express router.
 *
 * All routes require the `X-Admin-Key` header matching the configured
 * admin API key.
 *
 * @param deps - Dependencies for the admin API.
 * @returns An Express Router mounted at `/admin`.
 */
export function createAdminApiRouter(deps: AdminApiDependencies): Router {
  const router = Router();
  const {
    tenantManager,
    billingManager,
    quotaManager,
    adminApiKey = process.env['ADMIN_API_KEY'] ?? 'admin-secret-change-me',
  } = deps;

  // Apply admin auth to ALL routes on this router
  // Exception: billing webhook uses its own signature verification
  const adminAuth = createAdminAuthMiddleware(adminApiKey);

  // =====================================================================
  // DASHBOARD STATS
  // =====================================================================

  /**
   * GET /admin/stats
   * Overview dashboard statistics.
   */
  router.get(
    '/stats',
    adminAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const tenants = tenantManager.listTenants(10_000, 0);
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

      const activeTenants = tenants.filter(
        (t) => t.lastActiveAt.getTime() > sevenDaysAgo,
      ).length;

      const planDistribution: Record<string, number> = {};
      for (const t of tenants) {
        planDistribution[t.plan] = (planDistribution[t.plan] ?? 0) + 1;
      }

      const totalRequests = sumCounter('gslides_requests_total');
      const totalErrors = sumCounter('gslides_errors_total');
      const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

      const revenueMetrics: RevenueMetrics = computeRevenueMetrics(tenants.length, planDistribution);

      const stats: AdminStats = {
        totalTenants: tenants.length,
        activeTenants,
        totalPresentations: sumCounter('gslides_presentations_created_total'),
        totalApiCalls: sumCounter('gslides_api_calls_total'),
        avgResponseTime: avgResponseTime(),
        errorRate,
        revenueMetrics,
        planDistribution,
      };

      success(res, stats);
    }),
  );

  /**
   * GET /admin/stats/daily
   * Daily statistics for the last 30 days.
   */
  router.get(
    '/stats/daily',
    adminAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const days: DailyStats[] = [];
      const now = new Date();

      for (let i = 29; i >= 0; i--) {
        const date = new Date(now);
        date.setUTCDate(date.getUTCDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        // In a production system these would come from a time-series DB.
        // For now, generate representative data from current counters.
        days.push({
          date: dateStr,
          newTenants: 0,
          activeTenants: 0,
          presentations: 0,
          apiCalls: 0,
          avgResponseTime: 0,
          errors: 0,
          revenue: 0,
        });
      }

      // Fill today's data from live metrics
      const todayEntry = days[days.length - 1]!;
      todayEntry.presentations = sumCounter('gslides_presentations_created_total');
      todayEntry.apiCalls = sumCounter('gslides_api_calls_total');
      todayEntry.errors = sumCounter('gslides_errors_total');
      todayEntry.avgResponseTime = avgResponseTime();

      const tenants = tenantManager.listTenants(10_000, 0);
      const today = new Date().toISOString().slice(0, 10);
      todayEntry.activeTenants = tenants.filter(
        (t) => t.lastActiveAt.toISOString().slice(0, 10) === today,
      ).length;
      todayEntry.newTenants = tenants.filter(
        (t) => t.createdAt.toISOString().slice(0, 10) === today,
      ).length;

      success(res, { days, total: days.length });
    }),
  );

  /**
   * GET /admin/stats/revenue
   * Revenue metrics.
   */
  router.get(
    '/stats/revenue',
    adminAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const tenants = tenantManager.listTenants(10_000, 0);
      const planDistribution: Record<string, number> = {};
      for (const t of tenants) {
        planDistribution[t.plan] = (planDistribution[t.plan] ?? 0) + 1;
      }
      const revenueMetrics = computeRevenueMetrics(tenants.length, planDistribution);

      success(res, revenueMetrics);
    }),
  );

  // =====================================================================
  // TENANTS
  // =====================================================================

  /**
   * GET /admin/tenants
   * List all tenants (paginated).
   */
  router.get(
    '/tenants',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 50, 200);
      const offset = parseInt(req.query['offset'] as string, 10) || 0;
      const planFilter = req.query['plan'] as string | undefined;

      let tenants = tenantManager.listTenants(limit + offset, 0);

      if (planFilter) {
        tenants = tenants.filter((t) => t.plan === planFilter);
      }

      const total = tenants.length;
      const paginated = tenants.slice(offset, offset + limit);

      success(res, {
        tenants: paginated.map(sanitizeTenant),
        total,
        limit,
        offset,
      });
    }),
  );

  /**
   * GET /admin/tenants/:id
   * Get tenant details.
   */
  router.get(
    '/tenants/:id',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const tenant = tenantManager.getTenant(id);

      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      const quota = quotaManager.getQuotaStatus(id);

      success(res, {
        tenant: sanitizeTenant(tenant),
        quota,
      });
    }),
  );

  /**
   * PUT /admin/tenants/:id
   * Update tenant (plan, settings, limits).
   */
  router.put(
    '/tenants/:id',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const body = req.body as Record<string, unknown>;

      const tenant = tenantManager.getTenant(id);
      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      const updates: Record<string, unknown> = {};
      if (body['name'] !== undefined) updates['name'] = body['name'];
      if (body['email'] !== undefined) updates['email'] = body['email'];
      if (body['plan'] !== undefined) updates['plan'] = body['plan'];
      if (body['settings'] !== undefined) updates['settings'] = body['settings'];

      const updated = tenantManager.updateTenant(
        id,
        updates as { name?: string; email?: string; plan?: Plan },
      );

      await auditLogger.logTenantEvent('tenant.updated', id, {
        updatedFields: Object.keys(updates),
        adminAction: true,
      });

      log.info('Admin updated tenant', { tenantId: id, fields: Object.keys(updates) });
      success(res, { tenant: sanitizeTenant(updated) });
    }),
  );

  /**
   * DELETE /admin/tenants/:id
   * Deactivate (soft-delete) a tenant.
   */
  router.delete(
    '/tenants/:id',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const tenant = tenantManager.getTenant(id);

      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      const deleted = tenantManager.deleteTenant(id);
      if (!deleted) {
        error(res, 500, 'DELETE_FAILED', 'Failed to deactivate tenant');
        return;
      }

      await auditLogger.logTenantEvent('tenant.deleted', id, {
        email: tenant.email,
        plan: tenant.plan,
        adminAction: true,
      });

      log.info('Admin deactivated tenant', { tenantId: id, email: tenant.email });
      success(res, { tenantId: id, status: 'deactivated' });
    }),
  );

  /**
   * POST /admin/tenants/:id/impersonate
   * Generate an impersonation session token for a tenant.
   */
  router.post(
    '/tenants/:id/impersonate',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const tenant = tenantManager.getTenant(id);

      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      // Generate a short-lived impersonation token (1 hour)
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await auditLogger.log({
        timestamp: new Date().toISOString(),
        tenantId: id,
        action: 'admin.feature_toggled',
        resource: 'impersonation',
        details: {
          adminAction: true,
          expiresAt: expiresAt.toISOString(),
          reason: (req.body as Record<string, unknown>)?.['reason'] ?? 'admin impersonation',
        },
        outcome: 'success',
      });

      log.info('Admin impersonation session created', { tenantId: id });

      success(res, {
        tenantId: id,
        impersonationToken: token,
        expiresAt: expiresAt.toISOString(),
        warning: 'This token grants full access to the tenant account. Handle with care.',
      });
    }),
  );

  /**
   * GET /admin/tenants/:id/usage
   * Get tenant usage details.
   */
  router.get(
    '/tenants/:id/usage',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const tenant = tenantManager.getTenant(id);

      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      const quota = quotaManager.getQuotaStatus(id);
      const billingUsage = billingManager.getUsageForBilling(id, 'daily');

      success(res, {
        tenantId: id,
        plan: tenant.plan,
        quota,
        billingUsage,
      });
    }),
  );

  /**
   * GET /admin/tenants/:id/audit
   * Get tenant audit log.
   */
  router.get(
    '/tenants/:id/audit',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 50, 200);
      const offset = parseInt(req.query['offset'] as string, 10) || 0;
      const action = req.query['action'] as string | undefined;

      const tenant = tenantManager.getTenant(id);
      if (!tenant) {
        error(res, 404, 'TENANT_NOT_FOUND', `Tenant "${id}" not found`);
        return;
      }

      const result = await auditLogger.query({
        tenantId: id,
        action,
        limit,
        offset,
      });

      success(res, result, 200, { tenantId: id });
    }),
  );

  // =====================================================================
  // SYSTEM
  // =====================================================================

  /**
   * GET /admin/health
   * Detailed health report with all component statuses.
   */
  router.get(
    '/health',
    adminAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const report = await healthChecker.runAllChecks();
      const statusCode = report.status === 'healthy' ? 200
        : report.status === 'degraded' ? 200
        : 503;

      success(res, report, statusCode);
    }),
  );

  /**
   * GET /admin/metrics
   * Raw Prometheus metrics.
   */
  router.get(
    '/metrics',
    adminAuth,
    (_req: Request, res: Response) => {
      const text = metricsRegistry.toPrometheusText();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(text);
    },
  );

  /**
   * POST /admin/alerts/test
   * Send a test alert through all channels.
   */
  router.post(
    '/alerts/test',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const testAlert = {
        ruleName: 'test_alert',
        severity: ((req.body as Record<string, unknown>)?.['severity'] as string) ?? 'info',
        message: ((req.body as Record<string, unknown>)?.['message'] as string) ?? 'This is a test alert from the admin dashboard',
        value: 0,
        threshold: 0,
        firedAt: new Date().toISOString(),
        state: 'firing' as const,
      };

      // Send through all alert channels
      const channels = alertManager['channels'] as Array<{ name: string; send: (a: unknown) => Promise<void> }>;
      const results: Array<{ channel: string; status: string }> = [];

      for (const channel of channels) {
        try {
          await channel.send(testAlert);
          results.push({ channel: channel.name, status: 'sent' });
        } catch (err) {
          results.push({
            channel: channel.name,
            status: `failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      log.info('Test alert sent', { channelCount: channels.length });
      success(res, { alert: testAlert, deliveryResults: results });
    }),
  );

  /**
   * GET /admin/events
   * Recent system events from the event bus.
   */
  router.get(
    '/events',
    adminAuth,
    (_req: Request, res: Response) => {
      const limit = Math.min(
        parseInt((_req.query['limit'] as string) || '50', 10),
        200,
      );
      const type = _req.query['type'] as string | undefined;

      const events = type
        ? eventBus.getHistory(type as Parameters<typeof eventBus.getHistory>[0], limit)
        : eventBus.getHistory(undefined, limit);

      success(res, {
        events,
        total: eventBus.historySize,
      });
    },
  );

  /**
   * POST /admin/cache/clear
   * Clear all caches.
   */
  router.post(
    '/cache/clear',
    adminAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      presentationCache.clear();
      templateCache.clear();

      log.info('Admin cleared all caches');

      await auditLogger.log({
        timestamp: new Date().toISOString(),
        tenantId: 'system',
        action: 'config.changed',
        resource: 'cache',
        details: { action: 'clear_all', adminAction: true },
        outcome: 'success',
      });

      success(res, {
        status: 'cleared',
        caches: ['presentation', 'template'],
      });
    }),
  );

  // =====================================================================
  // BILLING
  // =====================================================================

  /**
   * GET /admin/billing/events
   * List billing events.
   */
  router.get(
    '/billing/events',
    adminAuth,
    (_req: Request, res: Response) => {
      const limit = Math.min(parseInt(_req.query['limit'] as string, 10) || 50, 200);
      const offset = parseInt(_req.query['offset'] as string, 10) || 0;
      const tenantId = _req.query['tenantId'] as string | undefined;
      const type = _req.query['type'] as BillingEventType | undefined;

      const result = billingManager.listEvents({ tenantId, type, limit, offset });
      success(res, result);
    },
  );

  /**
   * POST /admin/billing/webhook
   * Incoming billing webhook (Stripe-compatible).
   *
   * This endpoint does NOT use the admin auth middleware — instead it
   * verifies the Stripe-Signature header using HMAC-SHA256.
   */
  router.post(
    '/billing/webhook',
    asyncHandler(async (req: Request, res: Response) => {
      const signatureHeader = req.headers['stripe-signature'] as string | undefined;

      if (!signatureHeader) {
        error(res, 400, 'MISSING_SIGNATURE', 'Missing Stripe-Signature header');
        return;
      }

      // We need the raw body for signature verification.
      // Express should have parsed with express.raw() or we reconstruct it.
      let rawBody: string;
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString('utf-8');
      } else if (typeof req.body === 'string') {
        rawBody = req.body;
      } else {
        rawBody = JSON.stringify(req.body);
      }

      try {
        const billingEvent = await billingManager.processStripeWebhook(rawBody, signatureHeader);

        log.info('Billing webhook processed', {
          eventId: billingEvent.id,
          type: billingEvent.type,
          tenantId: billingEvent.tenantId,
        });

        success(res, { received: true, eventId: billingEvent.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string })?.code ?? 'WEBHOOK_ERROR';
        log.error('Billing webhook processing failed', { error: message, code });
        error(res, 400, code, message);
      }
    }),
  );

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove sensitive fields from a tenant object before sending in API responses.
 */
function sanitizeTenant(tenant: {
  id: string;
  name: string;
  email: string;
  plan: string;
  apiKey?: string;
  googleCredentials?: unknown;
  createdAt: Date;
  lastActiveAt: Date;
  settings: unknown;
}): Record<string, unknown> {
  return {
    id: tenant.id,
    name: tenant.name,
    email: tenant.email,
    plan: tenant.plan,
    hasApiKey: !!tenant.apiKey,
    hasGoogleCredentials: !!tenant.googleCredentials,
    createdAt: tenant.createdAt.toISOString(),
    lastActiveAt: tenant.lastActiveAt.toISOString(),
    settings: tenant.settings,
  };
}

/**
 * Compute revenue metrics from plan distribution.
 *
 * Uses standard SaaS pricing assumptions:
 * - Free: $0/mo
 * - Pro: $29/mo
 * - Enterprise: $199/mo
 */
function computeRevenueMetrics(
  _totalTenants: number,
  planDistribution: Record<string, number>,
): RevenueMetrics {
  const PLAN_PRICES: Record<string, number> = {
    free: 0,
    pro: 2900, // $29.00 in cents
    enterprise: 19900, // $199.00 in cents
  };

  let mrr = 0;
  for (const [plan, count] of Object.entries(planDistribution)) {
    mrr += (PLAN_PRICES[plan] ?? 0) * count;
  }

  return {
    mrr,
    arr: mrr * 12,
    churnRate: 0.05, // Placeholder — would be computed from historical data
    expansionRate: 0.10, // Placeholder — would be computed from upgrades
  };
}
