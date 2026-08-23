/**
 * @module auth/middleware
 * @description HTTP authentication middleware for the MCP server's HTTP transport.
 *
 * Supports multiple authentication methods:
 * - Bearer token (session-based) via `Authorization: Bearer <token>`
 * - API key via `Authorization: ApiKey <key>` or `X-API-Key: <key>` header
 *
 * Provides composable middleware functions for enforcing authentication,
 * plan-level access, and permission-scoped API key validation.
 */

import { createLogger } from '../shared/logger.js';
import { TenantManager } from './tenant-manager.js';
import { SessionManager } from './session-manager.js';
import type {
  AuthResult,
  AuthMethod,
  Tenant,
  Session,
  Plan,
} from './types.js';
import { PLAN_ORDER } from './types.js';
import { auditLogger } from '../monitoring/audit-log.js';

const log = createLogger('auth.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// Request / Response Abstractions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal request interface compatible with Node.js `IncomingMessage`
 * and common HTTP frameworks (Express, Hono, etc.).
 */
export interface AuthRequest {
  /** HTTP headers (lowercase keys). */
  headers: Record<string, string | string[] | undefined>;
  /** Client IP address, if available. */
  ip?: string;
  /** Attached tenant context (populated by middleware). */
  tenant?: Tenant;
  /** Attached session context (populated by middleware). */
  session?: Session;
  /** The authentication method used (populated by middleware). */
  authMethod?: AuthMethod;
}

/**
 * Extracted tenant context from an authenticated request.
 */
export interface TenantContext {
  /** The resolved tenant. */
  tenant: Tenant;
  /** The session, if authentication was session-based. */
  session?: Session;
  /** The authentication method used. */
  method: AuthMethod;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication middleware that coordinates tenant and session managers
 * to validate incoming requests.
 *
 * @example
 * ```ts
 * const auth = new AuthMiddleware(tenantManager, sessionManager);
 * const result = auth.authenticateRequest(req);
 * if (!result.authenticated) {
 *   res.status(401).json({ error: result.error });
 * }
 * ```
 */
export class AuthMiddleware {
  constructor(
    private readonly tenantManager: TenantManager,
    private readonly sessionManager: SessionManager,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Core Authentication
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Authenticate an incoming request by inspecting its headers.
   *
   * Checks in order:
   * 1. `Authorization: Bearer <token>` → session validation
   * 2. `Authorization: ApiKey <key>` → API key validation
   * 3. `X-API-Key: <key>` → API key validation
   *
   * @param req - The incoming request with headers.
   * @returns An {@link AuthResult} indicating success or failure.
   */
  public authenticateRequest(req: AuthRequest): AuthResult {
    const authHeader = this.getHeader(req, 'authorization');
    const apiKeyHeader = this.getHeader(req, 'x-api-key');

    // 1. Try Bearer token (session-based auth)
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token.length > 0) {
        const result = this.authenticateWithSession(token);
        this.emitAuthAudit(result, req);
        return result;
      }
    }

    // 2. Try Authorization: ApiKey <key>
    if (authHeader?.startsWith('ApiKey ')) {
      const key = authHeader.slice(7).trim();
      if (key.length > 0) {
        const result = this.authenticateWithApiKey(key);
        this.emitAuthAudit(result, req);
        return result;
      }
    }

    // 3. Try X-API-Key header
    if (apiKeyHeader && apiKeyHeader.length > 0) {
      const result = this.authenticateWithApiKey(apiKeyHeader);
      this.emitAuthAudit(result, req);
      return result;
    }

    return {
      authenticated: false,
      method: 'api_key',
      error: 'No authentication credentials provided. Include an Authorization header or X-API-Key header.',
    };
  }

  /**
   * Extract the full tenant context from an authenticated request.
   *
   * This is a convenience wrapper that calls {@link authenticateRequest}
   * and returns a structured context on success, or `null` on failure.
   *
   * @param req - The incoming request.
   * @returns The tenant context, or `null` if authentication failed.
   */
  public extractTenantContext(req: AuthRequest): TenantContext | null {
    const result = this.authenticateRequest(req);
    if (!result.authenticated || !result.tenant) return null;

    return {
      tenant: result.tenant,
      session: result.session,
      method: result.method,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Higher-Order Middleware Factories
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Create a handler wrapper that enforces authentication.
   *
   * The wrapped handler receives the request with `tenant`, `session`,
   * and `authMethod` fields populated.  If authentication fails, the
   * wrapper calls the `onUnauthorized` callback instead.
   *
   * @param handler - The handler to wrap.
   * @param onUnauthorized - Called when authentication fails.
   * @returns A wrapped handler function.
   */
  public requireAuth<TReq extends AuthRequest, TRes>(
    handler: (req: TReq, res: TRes) => void | Promise<void>,
    onUnauthorized: (req: TReq, res: TRes, error: string) => void | Promise<void>,
  ): (req: TReq, res: TRes) => void | Promise<void> {
    return (req: TReq, res: TRes) => {
      const result = this.authenticateRequest(req);
      if (!result.authenticated || !result.tenant) {
        log.warn('Authentication failed', {
          error: result.error,
          ip: req.ip,
        });
        return onUnauthorized(req, res, result.error ?? 'Authentication required');
      }

      // Attach context to request
      req.tenant = result.tenant;
      req.session = result.session;
      req.authMethod = result.method;

      // Touch activity tracking
      this.tenantManager.touchActivity(result.tenant.id);

      return handler(req, res);
    };
  }

  /**
   * Create a handler wrapper that enforces a minimum subscription plan.
   *
   * The request must already be authenticated (use after {@link requireAuth}).
   *
   * @param minPlan - The minimum plan required ('free', 'pro', or 'enterprise').
   * @param onForbidden - Called when the tenant's plan is insufficient.
   * @returns A handler wrapper function.
   */
  public requirePlan<TReq extends AuthRequest, TRes>(
    minPlan: Plan,
    onForbidden: (req: TReq, res: TRes, error: string) => void | Promise<void>,
  ): (handler: (req: TReq, res: TRes) => void | Promise<void>) => (req: TReq, res: TRes) => void | Promise<void> {
    return (handler) => {
      return (req: TReq, res: TRes) => {
        const tenant = req.tenant;
        if (!tenant) {
          return onForbidden(req, res, 'Authentication required before plan check');
        }

        const tenantPlanLevel = PLAN_ORDER[tenant.plan];
        const requiredPlanLevel = PLAN_ORDER[minPlan];

        if (tenantPlanLevel < requiredPlanLevel) {
          log.warn('Plan check failed', {
            tenantId: tenant.id,
            tenantPlan: tenant.plan,
            requiredPlan: minPlan,
          });
          return onForbidden(
            req,
            res,
            `This feature requires the "${minPlan}" plan or higher. Current plan: "${tenant.plan}".`,
          );
        }

        return handler(req, res);
      };
    };
  }

  /**
   * Create a handler wrapper that enforces a specific permission on API keys.
   *
   * Only applicable when the authentication method is `api_key`.
   * Session-based authentication bypasses permission checks (full access).
   *
   * @param permission - The required permission string (e.g. `'slides:write'`).
   * @param onForbidden - Called when the API key lacks the permission.
   * @returns A handler wrapper function.
   */
  public requirePermission<TReq extends AuthRequest, TRes>(
    permission: string,
    onForbidden: (req: TReq, res: TRes, error: string) => void | Promise<void>,
  ): (handler: (req: TReq, res: TRes) => void | Promise<void>) => (req: TReq, res: TRes) => void | Promise<void> {
    return (handler) => {
      return (req: TReq, res: TRes) => {
        // Session-based auth has full access
        if (req.authMethod === 'session') {
          return handler(req, res);
        }

        // For API key auth, check permissions
        if (req.authMethod === 'api_key') {
          const apiKeyHeader = this.getHeader(req, 'x-api-key');
          const authHeader = this.getHeader(req, 'authorization');
          const key = apiKeyHeader ?? authHeader?.slice(7).trim();

          if (key) {
            const keyInfo = this.tenantManager.validateApiKey(key);
            if (keyInfo && !keyInfo.permissions.includes(permission) && !keyInfo.permissions.includes('*')) {
              log.warn('Permission check failed', {
                tenantId: keyInfo.tenantId,
                requiredPermission: permission,
                keyPermissions: keyInfo.permissions,
              });
              return onForbidden(
                req,
                res,
                `API key lacks the required permission: "${permission}".`,
              );
            }
          }
        }

        return handler(req, res);
      };
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Audit Logging
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Emit an audit event for an authentication attempt (fire-and-forget).
   */
  private emitAuthAudit(result: AuthResult, req: AuthRequest): void {
    const action = result.authenticated ? 'auth.login.success' : 'auth.login.failure';
    const tenantId = result.tenant?.id ?? 'unknown';
    auditLogger.logAuthEvent(
      action,
      tenantId,
      { method: result.method, error: result.error },
      { ipAddress: req.ip, authMethod: result.method },
    ).catch(() => { /* audit is best-effort */ });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internal Methods
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Authenticate using a session bearer token.
   *
   * @param token - The session token.
   * @returns An {@link AuthResult}.
   */
  private authenticateWithSession(token: string): AuthResult {
    const session = this.sessionManager.validateSession(token);
    if (!session) {
      return {
        authenticated: false,
        method: 'session',
        error: 'Invalid or expired session token.',
      };
    }

    const tenant = this.tenantManager.getTenant(session.tenantId);
    if (!tenant) {
      log.error('Session references non-existent tenant', {
        sessionId: session.id,
        tenantId: session.tenantId,
      });
      return {
        authenticated: false,
        method: 'session',
        error: 'Session references an unknown tenant.',
      };
    }

    return {
      authenticated: true,
      tenant,
      session,
      method: 'session',
    };
  }

  /**
   * Authenticate using an API key.
   *
   * @param key - The API key string.
   * @returns An {@link AuthResult}.
   */
  private authenticateWithApiKey(key: string): AuthResult {
    const keyInfo = this.tenantManager.validateApiKey(key);
    if (!keyInfo) {
      return {
        authenticated: false,
        method: 'api_key',
        error: 'Invalid or expired API key.',
      };
    }

    const tenant = this.tenantManager.getTenant(keyInfo.tenantId);
    if (!tenant) {
      log.error('API key references non-existent tenant', {
        tenantId: keyInfo.tenantId,
        keyName: keyInfo.name,
      });
      return {
        authenticated: false,
        method: 'api_key',
        error: 'API key references an unknown tenant.',
      };
    }

    return {
      authenticated: true,
      tenant,
      method: 'api_key',
    };
  }

  /**
   * Extract a single header value from a request (case-insensitive).
   *
   * @param req - The request object.
   * @param name - The header name (lowercase).
   * @returns The header value as a string, or `undefined`.
   */
  private getHeader(req: AuthRequest, name: string): string | undefined {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
