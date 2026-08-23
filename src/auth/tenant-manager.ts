/**
 * @module auth/tenant-manager
 * @description In-memory tenant CRUD manager with API key lifecycle management.
 *
 * Provides create/read/update/delete operations for tenants, API key
 * generation and validation, and plan-based limit enforcement.
 *
 * The current implementation uses in-memory `Map` storage — designed to
 * be replaced with a persistent database layer in production.
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type {
  Tenant,
  Plan,
  ApiKeyInfo,
  TenantSettings,
  GoogleCredentials,
} from './types.js';
import { PLAN_LIMITS } from './types.js';

const log = createLogger('auth.tenant-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix applied to all generated API keys for easy identification. */
const API_KEY_PREFIX = 'gshm_';

/** Length in bytes for the random portion of an API key. */
const API_KEY_BYTES = 32;

/** Default rate limit (requests per minute) for newly generated API keys. */
const DEFAULT_RATE_LIMIT = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when a tenant operation fails due to a logical constraint
 * (e.g. duplicate email, not found, plan limit exceeded).
 */
export class TenantError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TenantError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages the full lifecycle of tenants and their API keys.
 *
 * Storage is currently in-memory (`Map`-based).  All public methods
 * are synchronous but return types are designed to be easily migrated
 * to `Promise`-based database calls.
 *
 * @example
 * ```ts
 * const manager = new TenantManager();
 * const tenant = manager.createTenant('Acme Corp', 'admin@acme.com', 'pro');
 * const key = manager.generateApiKey(tenant.id, 'CI Pipeline', ['slides:read', 'slides:write']);
 * ```
 */
export class TenantManager {
  /** Primary tenant store keyed by tenant ID. */
  private readonly tenants: Map<string, Tenant> = new Map();

  /** Secondary index: email → tenant ID for fast lookup by email. */
  private readonly emailIndex: Map<string, string> = new Map();

  /** Secondary index: API key → tenant ID for fast lookup by key. */
  private readonly apiKeyIndex: Map<string, string> = new Map();

  /** API key metadata store keyed by API key string. */
  private readonly apiKeys: Map<string, ApiKeyInfo> = new Map();

  // ───────────────────────────────────────────────────────────────────────
  // Tenant CRUD
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Create a new tenant.
   *
   * @param name - Display name for the tenant.
   * @param email - Primary email (must be unique across tenants).
   * @param plan - Subscription plan.
   * @param googleCredentials - Optional Google OAuth2 credentials.
   * @returns The newly created {@link Tenant}.
   * @throws {TenantError} If the email is already in use.
   */
  public createTenant(
    name: string,
    email: string,
    plan: Plan = 'free',
    googleCredentials?: GoogleCredentials,
  ): Tenant {
    const normalizedEmail = email.toLowerCase().trim();

    if (this.emailIndex.has(normalizedEmail)) {
      throw new TenantError(
        `A tenant with email "${normalizedEmail}" already exists`,
        'EMAIL_ALREADY_EXISTS',
      );
    }

    const now = new Date();
    const tenant: Tenant = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: normalizedEmail,
      plan,
      googleCredentials,
      createdAt: now,
      lastActiveAt: now,
      settings: { ...PLAN_LIMITS[plan] },
    };

    this.tenants.set(tenant.id, tenant);
    this.emailIndex.set(normalizedEmail, tenant.id);

    log.info('Tenant created', { tenantId: tenant.id, email: normalizedEmail, plan });
    return tenant;
  }

  /**
   * Retrieve a tenant by ID.
   *
   * @param id - The tenant UUID.
   * @returns The tenant, or `null` if not found.
   */
  public getTenant(id: string): Tenant | null {
    return this.tenants.get(id) ?? null;
  }

  /**
   * Retrieve a tenant by email address.
   *
   * @param email - The email to look up (case-insensitive).
   * @returns The tenant, or `null` if not found.
   */
  public getTenantByEmail(email: string): Tenant | null {
    const normalizedEmail = email.toLowerCase().trim();
    const tenantId = this.emailIndex.get(normalizedEmail);
    if (!tenantId) return null;
    return this.tenants.get(tenantId) ?? null;
  }

  /**
   * Retrieve a tenant by API key.
   *
   * @param key - The full API key string.
   * @returns The tenant, or `null` if the key is invalid or expired.
   */
  public getTenantByApiKey(key: string): Tenant | null {
    const keyInfo = this.validateApiKey(key);
    if (!keyInfo) return null;
    return this.tenants.get(keyInfo.tenantId) ?? null;
  }

  /**
   * Update a tenant's mutable fields.
   *
   * @param id - The tenant UUID.
   * @param updates - Partial tenant fields to merge.
   * @returns The updated tenant.
   * @throws {TenantError} If the tenant is not found.
   * @throws {TenantError} If a new email conflicts with an existing tenant.
   */
  public updateTenant(
    id: string,
    updates: Partial<Pick<Tenant, 'name' | 'email' | 'plan' | 'googleCredentials' | 'settings'>>,
  ): Tenant {
    const tenant = this.tenants.get(id);
    if (!tenant) {
      throw new TenantError(`Tenant "${id}" not found`, 'TENANT_NOT_FOUND');
    }

    // Handle email change — must re-index and check uniqueness
    if (updates.email && updates.email.toLowerCase().trim() !== tenant.email) {
      const newEmail = updates.email.toLowerCase().trim();
      if (this.emailIndex.has(newEmail)) {
        throw new TenantError(
          `A tenant with email "${newEmail}" already exists`,
          'EMAIL_ALREADY_EXISTS',
        );
      }
      this.emailIndex.delete(tenant.email);
      this.emailIndex.set(newEmail, id);
      tenant.email = newEmail;
    }

    // Handle plan change — update settings to match new plan limits
    if (updates.plan && updates.plan !== tenant.plan) {
      tenant.plan = updates.plan;
      tenant.settings = { ...PLAN_LIMITS[updates.plan] };
      log.info('Tenant plan changed', { tenantId: id, newPlan: updates.plan });
    }

    if (updates.name !== undefined) {
      tenant.name = updates.name.trim();
    }
    if (updates.googleCredentials !== undefined) {
      tenant.googleCredentials = updates.googleCredentials;
    }
    if (updates.settings !== undefined && !updates.plan) {
      // Allow granular settings override only if plan wasn't also changed
      tenant.settings = { ...tenant.settings, ...updates.settings };
    }

    tenant.lastActiveAt = new Date();
    this.tenants.set(id, tenant);

    log.debug('Tenant updated', { tenantId: id });
    return tenant;
  }

  /**
   * Permanently delete a tenant and all associated API keys.
   *
   * @param id - The tenant UUID.
   * @returns `true` if the tenant was found and deleted, `false` otherwise.
   */
  public deleteTenant(id: string): boolean {
    const tenant = this.tenants.get(id);
    if (!tenant) return false;

    // Remove all API keys belonging to this tenant
    for (const [key, info] of this.apiKeys.entries()) {
      if (info.tenantId === id) {
        this.apiKeys.delete(key);
        this.apiKeyIndex.delete(key);
      }
    }

    this.emailIndex.delete(tenant.email);
    this.tenants.delete(id);

    log.info('Tenant deleted', { tenantId: id, email: tenant.email });
    return true;
  }

  /**
   * List tenants with pagination.
   *
   * @param limit - Maximum number of tenants to return (default 50).
   * @param offset - Number of tenants to skip (default 0).
   * @returns An array of tenants ordered by creation date (newest first).
   */
  public listTenants(limit = 50, offset = 0): Tenant[] {
    const all = Array.from(this.tenants.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all.slice(offset, offset + limit);
  }

  // ───────────────────────────────────────────────────────────────────────
  // API Key Management
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Generate a new API key for a tenant.
   *
   * Keys are prefixed with `gshm_` and consist of 32 crypto-random bytes
   * encoded as hex (64 hex characters).
   *
   * @param tenantId - The tenant to create the key for.
   * @param name - A human-readable name for this key.
   * @param permissions - Scoped permissions (e.g. `['slides:read', 'slides:write']`).
   * @param rateLimit - Requests per minute (defaults to {@link DEFAULT_RATE_LIMIT}).
   * @param expiresAt - Optional expiry date for the key.
   * @returns The created {@link ApiKeyInfo} including the full key.
   * @throws {TenantError} If the tenant is not found.
   */
  public generateApiKey(
    tenantId: string,
    name: string,
    permissions: string[],
    rateLimit: number = DEFAULT_RATE_LIMIT,
    expiresAt?: Date,
  ): ApiKeyInfo {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new TenantError(`Tenant "${tenantId}" not found`, 'TENANT_NOT_FOUND');
    }

    const rawKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');
    const key = `${API_KEY_PREFIX}${rawKey}`;

    const keyInfo: ApiKeyInfo = {
      key,
      tenantId,
      name: name.trim(),
      permissions: [...permissions],
      rateLimit,
      createdAt: new Date(),
      lastUsedAt: undefined,
      expiresAt,
    };

    this.apiKeys.set(key, keyInfo);
    this.apiKeyIndex.set(key, tenantId);

    // Also store the key reference on the tenant for convenience
    tenant.apiKey = key;
    tenant.lastActiveAt = new Date();

    log.info('API key generated', {
      tenantId,
      keyName: name,
      permissionCount: permissions.length,
    });
    return keyInfo;
  }

  /**
   * Revoke an API key, permanently removing it from the system.
   *
   * @param key - The full API key string.
   * @returns `true` if the key was found and revoked, `false` otherwise.
   */
  public revokeApiKey(key: string): boolean {
    const keyInfo = this.apiKeys.get(key);
    if (!keyInfo) return false;

    // Clear the key reference from the tenant if it matches
    const tenant = this.tenants.get(keyInfo.tenantId);
    if (tenant && tenant.apiKey === key) {
      tenant.apiKey = undefined;
    }

    this.apiKeys.delete(key);
    this.apiKeyIndex.delete(key);

    log.info('API key revoked', { tenantId: keyInfo.tenantId, keyName: keyInfo.name });
    return true;
  }

  /**
   * Validate an API key and return its metadata.
   *
   * Checks that the key exists and has not expired.  On valid access,
   * updates the `lastUsedAt` timestamp.
   *
   * @param key - The full API key string.
   * @returns The key info if valid, or `null` if invalid/expired.
   */
  public validateApiKey(key: string): ApiKeyInfo | null {
    const keyInfo = this.apiKeys.get(key);
    if (!keyInfo) return null;

    // Check expiry
    if (keyInfo.expiresAt && keyInfo.expiresAt.getTime() < Date.now()) {
      log.debug('API key expired', { tenantId: keyInfo.tenantId, keyName: keyInfo.name });
      // Auto-revoke expired keys
      this.revokeApiKey(key);
      return null;
    }

    // Update last-used timestamp
    keyInfo.lastUsedAt = new Date();
    return keyInfo;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Plan Enforcement
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Check whether a tenant's plan allows a specific setting/feature.
   *
   * @param tenantId - The tenant UUID.
   * @param setting - The setting key to check.
   * @returns `true` if the feature is enabled for this tenant's plan.
   * @throws {TenantError} If the tenant is not found.
   */
  public checkPlanLimit(
    tenantId: string,
    setting: keyof TenantSettings,
  ): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new TenantError(`Tenant "${tenantId}" not found`, 'TENANT_NOT_FOUND');
    }

    const value = tenant.settings[setting];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    return false;
  }

  /**
   * Get the numeric limit for a plan-gated setting.
   *
   * @param tenantId - The tenant UUID.
   * @param setting - The numeric setting key.
   * @returns The limit value.
   * @throws {TenantError} If the tenant is not found.
   */
  public getNumericLimit(
    tenantId: string,
    setting: 'maxPresentationsPerDay' | 'maxSlidesPerPresentation',
  ): number {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new TenantError(`Tenant "${tenantId}" not found`, 'TENANT_NOT_FOUND');
    }
    return tenant.settings[setting];
  }

  /**
   * Touch the tenant's `lastActiveAt` timestamp.
   * Call this on every authenticated request to track activity.
   *
   * @param tenantId - The tenant UUID.
   */
  public touchActivity(tenantId: string): void {
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      tenant.lastActiveAt = new Date();
    }
  }

  /**
   * Get the total number of registered tenants.
   *
   * @returns The count of tenants currently in the store.
   */
  public get tenantCount(): number {
    return this.tenants.size;
  }

  /**
   * Get the total number of active API keys.
   *
   * @returns The count of API keys currently in the store.
   */
  public get apiKeyCount(): number {
    return this.apiKeys.size;
  }
}
