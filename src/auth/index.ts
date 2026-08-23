/**
 * @module auth
 * @description Multi-tenant authentication subsystem for the Google Slides Hybrid MCP server.
 *
 * Provides tenant management, session lifecycle, API key validation,
 * HTTP authentication middleware, and an OAuth 2.1 provider with PKCE support.
 *
 * @example
 * ```ts
 * import {
 *   TenantManager,
 *   SessionManager,
 *   AuthMiddleware,
 *   OAuthProvider,
 * } from './auth/index.js';
 *
 * const tenants = new TenantManager();
 * const sessions = new SessionManager();
 * const auth = new AuthMiddleware(tenants, sessions);
 * const oauth = new OAuthProvider(tenants, sessions);
 *
 * // Create a tenant
 * const tenant = tenants.createTenant('Acme Corp', 'admin@acme.com', 'pro');
 *
 * // Generate an API key
 * const key = tenants.generateApiKey(tenant.id, 'CI Pipeline', ['slides:read']);
 *
 * // Authenticate a request
 * const result = auth.authenticateRequest({
 *   headers: { 'x-api-key': key.key },
 * });
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Tenant,
  Plan,
  GoogleCredentials,
  TenantSettings,
  Session,
  ApiKeyInfo,
  AuthMethod,
  AuthResult,
  AuthorizationCode,
  OAuthToken,
} from './types.js';

export { PLAN_LIMITS, PLAN_ORDER } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant Manager
// ─────────────────────────────────────────────────────────────────────────────

export { TenantManager, TenantError } from './tenant-manager.js';

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager
// ─────────────────────────────────────────────────────────────────────────────

export { SessionManager } from './session-manager.js';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Middleware
// ─────────────────────────────────────────────────────────────────────────────

export { AuthMiddleware } from './middleware.js';
export type { AuthRequest, TenantContext } from './middleware.js';

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.1 Provider
// ─────────────────────────────────────────────────────────────────────────────

export { OAuthProvider, OAuthError } from './oauth-provider.js';
export type {
  AuthorizeParams,
  TokenExchangeParams,
  RefreshParams,
  TokenResponse,
  OAuthClient,
} from './oauth-provider.js';
