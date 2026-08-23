/**
 * @module security/cors-config
 * @description CORS configuration with whitelist-based origin validation,
 * wildcard subdomain support, per-route policies, and env-var configuration.
 *
 * Integrates with Express via a middleware factory.
 */

import { createLogger } from '../shared/logger.js';

import type { Request, Response, NextFunction } from 'express';

const log = createLogger('security.cors-config');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** CORS policy for a specific route prefix. */
export interface CorsPolicy {
  /** Allowed origins (exact match or wildcard pattern like `*.example.com`). */
  allowedOrigins: string[];
  /** Allowed HTTP methods. */
  allowedMethods: string[];
  /** Allowed request headers. */
  allowedHeaders: string[];
  /** Headers to expose to the client. */
  exposedHeaders: string[];
  /** Whether to send Access-Control-Allow-Credentials. */
  credentials: boolean;
  /** Preflight cache duration in seconds. */
  maxAge: number;
}

/** Route-prefix to CORS policy mapping. */
export interface RouteCorsConfig {
  /** The route prefix (e.g., `/api`, `/mcp`, `/health`). */
  prefix: string;
  /** The CORS policy for this prefix. */
  policy: CorsPolicy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-API-Key',
  'X-CSRF-Token',
  'Accept',
  'Origin',
];
const DEFAULT_EXPOSED_HEADERS = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-Request-Id',
  'Retry-After',
];
const DEFAULT_MAX_AGE = 86400; // 24 hours

// ─────────────────────────────────────────────────────────────────────────────
// CorsConfig Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builder class for constructing CORS configuration.
 *
 * Supports:
 * - Global defaults.
 * - Per-route-prefix overrides.
 * - Wildcard subdomain matching (e.g. `*.example.com`).
 * - Environment variable configuration via `CORS_ALLOWED_ORIGINS`.
 *
 * @example
 * ```ts
 * const cors = new CorsConfig()
 *   .addOrigins(['https://app.example.com', 'https://*.example.com'])
 *   .setRoutePolicy('/api', { credentials: true })
 *   .setRoutePolicy('/health', { allowedOrigins: ['*'] })
 *   .loadFromEnv();
 *
 * app.use(cors.middleware());
 * ```
 */
export class CorsConfig {
  /** Global allowed origins. */
  private origins: string[] = [];

  /** Per-route-prefix policies. */
  private routePolicies: RouteCorsConfig[] = [];

  /** Global default policy values. */
  private defaultPolicy: CorsPolicy = {
    allowedOrigins: [],
    allowedMethods: [...DEFAULT_ALLOWED_METHODS],
    allowedHeaders: [...DEFAULT_ALLOWED_HEADERS],
    exposedHeaders: [...DEFAULT_EXPOSED_HEADERS],
    credentials: true,
    maxAge: DEFAULT_MAX_AGE,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Builder Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add allowed origins to the global whitelist.
   */
  public addOrigins(origins: string[]): this {
    for (const origin of origins) {
      const trimmed = origin.trim();
      if (trimmed.length > 0 && !this.origins.includes(trimmed)) {
        this.origins.push(trimmed);
      }
    }
    return this;
  }

  /**
   * Set allowed HTTP methods for the global default.
   */
  public setAllowedMethods(methods: string[]): this {
    this.defaultPolicy.allowedMethods = methods.map((m) => m.toUpperCase());
    return this;
  }

  /**
   * Set allowed request headers for the global default.
   */
  public setAllowedHeaders(headers: string[]): this {
    this.defaultPolicy.allowedHeaders = headers;
    return this;
  }

  /**
   * Set exposed response headers for the global default.
   */
  public setExposedHeaders(headers: string[]): this {
    this.defaultPolicy.exposedHeaders = headers;
    return this;
  }

  /**
   * Set whether credentials are allowed in the global default.
   */
  public setCredentials(credentials: boolean): this {
    this.defaultPolicy.credentials = credentials;
    return this;
  }

  /**
   * Set preflight cache max-age for the global default.
   */
  public setMaxAge(seconds: number): this {
    this.defaultPolicy.maxAge = seconds;
    return this;
  }

  /**
   * Set a CORS policy override for a specific route prefix.
   *
   * @param prefix  - The route prefix (e.g. `/api`).
   * @param overrides - Partial policy overrides. Unspecified fields inherit from global default.
   */
  public setRoutePolicy(prefix: string, overrides: Partial<CorsPolicy>): this {
    // Remove any existing policy for this prefix
    this.routePolicies = this.routePolicies.filter((r) => r.prefix !== prefix);

    this.routePolicies.push({
      prefix,
      policy: {
        ...this.defaultPolicy,
        allowedOrigins: overrides.allowedOrigins ?? [...this.origins],
        ...overrides,
      },
    });

    // Sort by prefix length descending for most-specific-first matching
    this.routePolicies.sort((a, b) => b.prefix.length - a.prefix.length);

    return this;
  }

  /**
   * Load origins from the `CORS_ALLOWED_ORIGINS` environment variable.
   * Comma-separated list, e.g.: `https://app.example.com,https://*.example.com`
   */
  public loadFromEnv(): this {
    const envOrigins = process.env['CORS_ALLOWED_ORIGINS'];
    if (envOrigins) {
      const parsed = envOrigins
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      this.addOrigins(parsed);
      log.info('Loaded CORS origins from environment', { count: parsed.length, origins: parsed });
    }
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Middleware
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an Express middleware function that applies CORS headers.
   *
   * @returns An Express middleware.
   */
  public middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const policy = this.getPolicyForPath(req.path);
      const requestOrigin = req.headers['origin'] as string | undefined;

      // Determine if the origin is allowed
      const allowedOrigins = policy.allowedOrigins.length > 0
        ? policy.allowedOrigins
        : this.origins;

      const originAllowed = requestOrigin
        ? this.isOriginAllowed(requestOrigin, allowedOrigins)
        : false;

      // Set CORS headers
      if (originAllowed && requestOrigin) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Vary', 'Origin');
      } else if (allowedOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }

      if (policy.credentials && originAllowed) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (policy.exposedHeaders.length > 0) {
        res.setHeader('Access-Control-Expose-Headers', policy.exposedHeaders.join(', '));
      }

      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', policy.allowedMethods.join(', '));
        res.setHeader('Access-Control-Allow-Headers', policy.allowedHeaders.join(', '));
        res.setHeader('Access-Control-Max-Age', String(policy.maxAge));
        res.status(204).end();
        return;
      }

      next();
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Origin Validation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether an origin is in the allowed list.
   * Supports exact match, wildcard `*`, and subdomain wildcards `*.example.com`.
   *
   * @param origin  - The request Origin header value.
   * @param allowed - The list of allowed origins/patterns.
   * @returns `true` if the origin is allowed.
   */
  public isOriginAllowed(origin: string, allowed?: string[]): boolean {
    const origins = allowed ?? this.origins;

    for (const pattern of origins) {
      // Wildcard: allow everything
      if (pattern === '*') return true;

      // Exact match
      if (pattern === origin) return true;

      // Subdomain wildcard: https://*.example.com
      if (pattern.includes('*')) {
        if (this.matchWildcardOrigin(origin, pattern)) return true;
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Introspection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the resolved policy for a given request path.
   */
  public getPolicyForPath(path: string): CorsPolicy {
    for (const route of this.routePolicies) {
      if (path.startsWith(route.prefix)) {
        return route.policy;
      }
    }

    return {
      ...this.defaultPolicy,
      allowedOrigins: [...this.origins],
    };
  }

  /**
   * Get all configured origins.
   */
  public getOrigins(): string[] {
    return [...this.origins];
  }

  /**
   * Get all configured route policies.
   */
  public getRoutePolicies(): RouteCorsConfig[] {
    return this.routePolicies.map((r) => ({
      prefix: r.prefix,
      policy: { ...r.policy },
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Match an origin against a wildcard pattern.
   *
   * Patterns like `https://*.example.com` match any single subdomain level:
   * - `https://app.example.com` → match
   * - `https://staging.example.com` → match
   * - `https://example.com` → no match (no subdomain)
   * - `https://a.b.example.com` → match (any subdomain depth)
   */
  private matchWildcardOrigin(origin: string, pattern: string): boolean {
    // Split pattern at the wildcard
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) return origin === pattern;

    const prefix = pattern.slice(0, wildcardIndex);
    const suffix = pattern.slice(wildcardIndex + 1);

    // Origin must start with the prefix and end with the suffix
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) {
      return false;
    }

    // The middle part (what the * matched) must not be empty
    const middle = origin.slice(prefix.length, origin.length - suffix.length);
    if (middle.length === 0) return false;

    return true;
  }
}
