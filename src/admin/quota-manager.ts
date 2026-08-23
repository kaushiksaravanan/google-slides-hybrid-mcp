/**
 * @module admin/quota-manager
 * @description Usage quota enforcement with plan-based limits, automatic daily
 * reset, and threshold event emission.
 *
 * The QuotaManager tracks per-tenant resource consumption (presentations,
 * API calls, vision analyses, storage) against plan-defined limits.  Quotas
 * reset automatically at midnight UTC each day.  Events are emitted when
 * tenants approach (80%) or reach (100%) their quota limits.
 */

import { createLogger } from '../shared/logger.js';
import { eventBus, EventBus } from '../events/event-bus.js';
import type { Plan } from '../auth/types.js';
import type {
  UsageQuota,
  QuotaOperation,
  QuotaCheckResult,
  PlanQuotaLimits,
} from './types.js';
import { PLAN_QUOTA_LIMITS } from './types.js';

const log = createLogger('admin.quota-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Internal Usage Tracker
// ─────────────────────────────────────────────────────────────────────────────

/** Internal mutable usage counters for a single tenant in a single day. */
interface TenantUsage {
  presentations: number;
  apiCalls: number;
  visionAnalyses: number;
  storageMb: number;
  /** The UTC date string (YYYY-MM-DD) this usage belongs to. */
  date: string;
}

/** Get today's date as a UTC YYYY-MM-DD string. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get the next midnight UTC as a Date. */
function nextMidnightUTC(): Date {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return tomorrow;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuotaManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages per-tenant usage quotas with plan-based limits, daily auto-reset,
 * and threshold event emission.
 *
 * @example
 * ```ts
 * const quota = new QuotaManager(getTenantPlan);
 * const result = await quota.consumeQuota('tenant-123', 'apiCalls');
 * if (!result.allowed) {
 *   throw new Error('API call quota exceeded');
 * }
 * ```
 */
export class QuotaManager {
  /** Per-tenant usage counters keyed by tenant ID. */
  private readonly usage = new Map<string, TenantUsage>();

  /** Callback to resolve a tenant's current plan. */
  private readonly getPlan: (tenantId: string) => Plan | null;

  /** Event bus for emitting quota threshold events. */
  private readonly bus: EventBus;

  /** Set of already-emitted threshold warnings to prevent duplicates per day. */
  private readonly emittedWarnings = new Set<string>();

  /** Handle to the daily reset timer. */
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    getPlan: (tenantId: string) => Plan | null,
    bus: EventBus = eventBus,
  ) {
    this.getPlan = getPlan;
    this.bus = bus;
    this.scheduleDailyReset();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Map a QuotaOperation to the corresponding key in TenantUsage.
   */
  private usageKey(operation: QuotaOperation): keyof TenantUsage {
    return operation === 'storage' ? 'storageMb' : operation;
  }

  /**
   * Check whether a tenant can perform the given operation without consuming
   * a unit.  Use this for read-ahead checks.
   */
  checkQuota(tenantId: string, operation: QuotaOperation): QuotaCheckResult {
    const limits = this.getLimits(tenantId);
    const usage = this.getOrCreateUsage(tenantId);
    const key = this.usageKey(operation);
    const used = usage[key] as number;
    const limit = this.operationLimit(limits, operation);

    return {
      allowed: used < limit,
      remaining: Math.max(0, limit - used),
      resetAt: nextMidnightUTC(),
    };
  }

  /**
   * Consume one unit of quota for the given operation.
   *
   * Returns the result including whether the operation was allowed.
   * If allowed, the usage counter is incremented.  If denied, the
   * counter is not modified.
   */
  consumeQuota(tenantId: string, operation: QuotaOperation): QuotaCheckResult {
    const limits = this.getLimits(tenantId);
    const usage = this.getOrCreateUsage(tenantId);
    const key = this.usageKey(operation);
    const used = usage[key] as number;
    const limit = this.operationLimit(limits, operation);

    if (used >= limit) {
      this.emitThresholdEvent(tenantId, operation, used, limit, 100);
      log.warn('Quota exceeded', { tenantId, operation, used, limit });
      return {
        allowed: false,
        remaining: 0,
        resetAt: nextMidnightUTC(),
      };
    }

    // Increment usage
    usage[key] = (used + 1) as never;

    const newUsed = used + 1;
    const remaining = Math.max(0, limit - newUsed);
    const percentage = (newUsed / limit) * 100;

    // Emit warning events at thresholds
    if (percentage >= 100) {
      this.emitThresholdEvent(tenantId, operation, newUsed, limit, 100);
    } else if (percentage >= 80) {
      this.emitThresholdEvent(tenantId, operation, newUsed, limit, 80);
    }

    return {
      allowed: true,
      remaining,
      resetAt: nextMidnightUTC(),
    };
  }

  /**
   * Get the full usage quota snapshot for a tenant.
   */
  getQuotaStatus(tenantId: string): UsageQuota {
    const limits = this.getLimits(tenantId);
    const usage = this.getOrCreateUsage(tenantId);

    return {
      tenantId,
      period: 'daily',
      presentations: {
        used: usage.presentations,
        limit: limits.presentations,
      },
      apiCalls: {
        used: usage.apiCalls,
        limit: limits.apiCalls,
      },
      visionAnalyses: {
        used: usage.visionAnalyses,
        limit: limits.visionAnalyses,
      },
      storage: {
        usedMb: usage.storageMb,
        limitMb: limits.storageMb,
      },
    };
  }

  /**
   * Get raw usage data for billing calculations over a specified period.
   */
  getUsageForBilling(
    tenantId: string,
    _period: 'daily' | 'monthly',
  ): {
    tenantId: string;
    presentations: number;
    apiCalls: number;
    visionAnalyses: number;
    storageMb: number;
    periodStart: string;
    periodEnd: string;
  } {
    const usage = this.getOrCreateUsage(tenantId);
    const today = todayUTC();

    return {
      tenantId,
      presentations: usage.presentations,
      apiCalls: usage.apiCalls,
      visionAnalyses: usage.visionAnalyses,
      storageMb: usage.storageMb,
      periodStart: today,
      periodEnd: today,
    };
  }

  /**
   * Manually reset a tenant's usage counters.
   */
  resetTenantUsage(tenantId: string): void {
    this.usage.delete(tenantId);
    // Clear warnings for this tenant
    for (const key of this.emittedWarnings) {
      if (key.startsWith(`${tenantId}:`)) {
        this.emittedWarnings.delete(key);
      }
    }
    log.info('Tenant usage reset', { tenantId });
  }

  /**
   * Reset all tenant quotas.  Called automatically at midnight UTC.
   */
  resetAllQuotas(): void {
    const tenantCount = this.usage.size;
    this.usage.clear();
    this.emittedWarnings.clear();
    log.info('All daily quotas reset', { tenantsAffected: tenantCount });
  }

  /**
   * Dispose of timers and resources.
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.usage.clear();
    this.emittedWarnings.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve plan quota limits for a tenant.  Falls back to 'free' limits
   * if the tenant or plan is not found.
   */
  private getLimits(tenantId: string): PlanQuotaLimits {
    const plan = this.getPlan(tenantId);
    return PLAN_QUOTA_LIMITS[plan ?? 'free'] ?? PLAN_QUOTA_LIMITS['free']!;
  }

  /**
   * Extract the numeric limit for a specific operation from plan limits.
   */
  private operationLimit(limits: PlanQuotaLimits, operation: QuotaOperation): number {
    switch (operation) {
      case 'presentations': return limits.presentations;
      case 'apiCalls': return limits.apiCalls;
      case 'visionAnalyses': return limits.visionAnalyses;
      case 'storage': return limits.storageMb;
    }
  }

  /**
   * Get or create daily usage counters for a tenant.
   * Auto-resets if the stored usage is from a previous day.
   */
  private getOrCreateUsage(tenantId: string): TenantUsage {
    const today = todayUTC();
    const existing = this.usage.get(tenantId);

    if (existing && existing.date === today) {
      return existing;
    }

    // Reset for the new day
    const fresh: TenantUsage = {
      presentations: 0,
      apiCalls: 0,
      visionAnalyses: 0,
      storageMb: 0,
      date: today,
    };
    this.usage.set(tenantId, fresh);
    return fresh;
  }

  /**
   * Emit a quota threshold event if not already emitted for this
   * tenant/operation/percentage combination today.
   */
  private emitThresholdEvent(
    tenantId: string,
    operation: QuotaOperation,
    used: number,
    limit: number,
    percentage: number,
  ): void {
    const key = `${tenantId}:${operation}:${percentage}:${todayUTC()}`;
    if (this.emittedWarnings.has(key)) return;
    this.emittedWarnings.add(key);

    const eventType = percentage >= 100 ? 'quota.exceeded' : 'quota.warning';
    this.bus.emit(EventBus.createEvent(
      eventType,
      {
        tenantId,
        operation,
        used,
        limit,
        percentage,
      },
      { tenantId, source: 'quota-manager' },
    ));

    log.info('Quota threshold event emitted', {
      tenantId,
      operation,
      percentage,
      used,
      limit,
    });
  }

  /**
   * Schedule the next daily quota reset at midnight UTC.
   */
  private scheduleDailyReset(): void {
    const msUntilMidnight = nextMidnightUTC().getTime() - Date.now();

    this.resetTimer = setTimeout(() => {
      this.resetAllQuotas();
      // Reschedule for the next day
      this.scheduleDailyReset();
    }, msUntilMidnight);

    // Don't prevent process exit
    if (this.resetTimer.unref) {
      this.resetTimer.unref();
    }

    log.debug('Daily quota reset scheduled', {
      msUntilReset: msUntilMidnight,
      resetAt: nextMidnightUTC().toISOString(),
    });
  }
}
