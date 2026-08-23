/**
 * @module auth/oauth-provider
 * @description OAuth 2.1 Authorization Code provider for MCP clients.
 *
 * Implements the authorization code flow with PKCE (S256) for secure
 * client authentication.  Designed for MCP clients that need to obtain
 * access tokens to interact with the server's HTTP transport.
 *
 * Flow:
 * 1. Client redirects user to `/authorize` with PKCE challenge
 * 2. User authenticates and grants consent
 * 3. Server issues a short-lived authorization code (10 min TTL)
 * 4. Client exchanges code + PKCE verifier for access + refresh tokens
 * 5. Client uses refresh token to obtain new access tokens
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { TenantManager } from './tenant-manager.js';
import { SessionManager } from './session-manager.js';
import type { AuthorizationCode, OAuthToken } from './types.js';

const log = createLogger('auth.oauth-provider');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Authorization code TTL: 10 minutes in milliseconds. */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

/** Access token TTL: 1 hour in milliseconds. */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Byte length for generated authorization codes. */
const AUTH_CODE_BYTES = 32;

/** Byte length for generated refresh tokens. */
const REFRESH_TOKEN_BYTES = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OAuth-specific errors with RFC 6749 error codes.
 */
export class OAuthError extends Error {
  /** RFC 6749 error code (e.g. "invalid_grant", "invalid_client"). */
  public readonly errorCode: string;
  /** Optional URI pointing to a human-readable error description. */
  public readonly errorUri?: string;

  constructor(errorCode: string, message: string, errorUri?: string) {
    super(message);
    this.name = 'OAuthError';
    this.errorCode = errorCode;
    this.errorUri = errorUri;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialise to the RFC 6749 JSON error response format. */
  public toJSON(): Record<string, string> {
    const result: Record<string, string> = {
      error: this.errorCode,
      error_description: this.message,
    };
    if (this.errorUri) {
      result['error_uri'] = this.errorUri;
    }
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Authorization Request Parameters
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters for initiating an authorization request. */
export interface AuthorizeParams {
  /** The client_id of the requesting MCP client. */
  clientId: string;
  /** The URI to redirect to after authorization. */
  redirectUri: string;
  /** Must be "code" for authorization code flow. */
  responseType: string;
  /** Space-separated list of requested scopes. */
  scope: string;
  /** Opaque state value for CSRF protection. */
  state: string;
  /** PKCE code challenge (base64url-encoded SHA-256 hash). */
  codeChallenge: string;
  /** PKCE code challenge method (must be "S256"). */
  codeChallengeMethod: string;
}

/** Parameters for exchanging an authorization code for tokens. */
export interface TokenExchangeParams {
  /** Must be "authorization_code". */
  grantType: string;
  /** The authorization code to exchange. */
  code: string;
  /** Must match the redirect_uri from the authorization request. */
  redirectUri: string;
  /** The client_id that requested the authorization. */
  clientId: string;
  /** The PKCE code verifier (plain text, unhashed). */
  codeVerifier: string;
}

/** Parameters for refreshing an access token. */
export interface RefreshParams {
  /** Must be "refresh_token". */
  grantType: string;
  /** The refresh token. */
  refreshToken: string;
  /** The client_id that owns the refresh token. */
  clientId: string;
}

/** Successful token response. */
export interface TokenResponse {
  /** The access token. */
  access_token: string;
  /** Always "bearer". */
  token_type: 'bearer';
  /** Time until the access token expires, in seconds. */
  expires_in: number;
  /** The refresh token (included on initial exchange). */
  refresh_token?: string;
  /** The granted scopes (space-separated). */
  scope: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registered Client
// ─────────────────────────────────────────────────────────────────────────────

/** A registered OAuth2 client application. */
export interface OAuthClient {
  /** The unique client identifier. */
  clientId: string;
  /** The client secret (for confidential clients). */
  clientSecret: string;
  /** Allowed redirect URIs. */
  redirectUris: string[];
  /** Human-readable client name. */
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuthProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OAuth 2.1 Authorization Code provider with PKCE support.
 *
 * @example
 * ```ts
 * const oauth = new OAuthProvider(tenantManager, sessionManager);
 * oauth.registerClient({ clientId: 'mcp-client', ... });
 *
 * // 1. Generate authorization URL
 * const authUrl = oauth.buildAuthorizationUrl(params, tenantId);
 *
 * // 2. Exchange code for tokens
 * const tokens = oauth.exchangeCode(exchangeParams);
 *
 * // 3. Refresh access token
 * const newTokens = oauth.refreshAccessToken(refreshParams);
 * ```
 */
export class OAuthProvider {
  /** Registered OAuth2 clients keyed by client_id. */
  private readonly clients: Map<string, OAuthClient> = new Map();

  /** Pending authorization codes keyed by code string. */
  private readonly authCodes: Map<string, AuthorizationCode> = new Map();

  /** Issued refresh tokens keyed by refresh token string. */
  private readonly refreshTokens: Map<string, OAuthToken> = new Map();

  /** Handle for the periodic code cleanup interval. */
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tenantManager: TenantManager,
    private readonly sessionManager: SessionManager,
  ) {
    // Periodically clean up expired authorization codes
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredCodes();
    }, 5 * 60 * 1000); // Every 5 minutes

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    log.info('OAuth provider initialised');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Client Registration
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Register an OAuth2 client application.
   *
   * @param client - The client configuration to register.
   * @throws {OAuthError} If the client_id is already registered.
   */
  public registerClient(client: OAuthClient): void {
    if (this.clients.has(client.clientId)) {
      throw new OAuthError(
        'invalid_client',
        `Client "${client.clientId}" is already registered.`,
      );
    }

    this.clients.set(client.clientId, { ...client });
    log.info('OAuth client registered', { clientId: client.clientId, name: client.name });
  }

  /**
   * Unregister an OAuth2 client application.
   *
   * @param clientId - The client_id to unregister.
   * @returns `true` if the client was found and removed.
   */
  public unregisterClient(clientId: string): boolean {
    const removed = this.clients.delete(clientId);
    if (removed) {
      log.info('OAuth client unregistered', { clientId });
    }
    return removed;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Authorization Endpoint
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Validate an authorization request and generate an authorization code.
   *
   * In a real deployment, this would be called after the user has
   * authenticated and granted consent via a web UI.
   *
   * @param params - The authorization request parameters.
   * @param tenantId - The authenticated tenant granting authorization.
   * @returns The generated authorization code and redirect URI with parameters.
   * @throws {OAuthError} On invalid parameters.
   */
  public authorize(
    params: AuthorizeParams,
    tenantId: string,
  ): { code: string; redirectUri: string } {
    // Validate client
    const client = this.clients.get(params.clientId);
    if (!client) {
      throw new OAuthError('invalid_client', `Unknown client_id: "${params.clientId}".`);
    }

    // Validate redirect URI
    if (!client.redirectUris.includes(params.redirectUri)) {
      throw new OAuthError(
        'invalid_request',
        `Redirect URI "${params.redirectUri}" is not registered for this client.`,
      );
    }

    // Validate response_type
    if (params.responseType !== 'code') {
      throw new OAuthError(
        'unsupported_response_type',
        `Only "code" response_type is supported. Received: "${params.responseType}".`,
      );
    }

    // Validate PKCE
    if (params.codeChallengeMethod !== 'S256') {
      throw new OAuthError(
        'invalid_request',
        'Only "S256" code_challenge_method is supported.',
      );
    }

    if (!params.codeChallenge || params.codeChallenge.length === 0) {
      throw new OAuthError('invalid_request', 'code_challenge is required for PKCE.');
    }

    // Validate tenant exists
    const tenant = this.tenantManager.getTenant(tenantId);
    if (!tenant) {
      throw new OAuthError('invalid_request', 'Tenant not found.');
    }

    // Generate authorization code
    const code = crypto.randomBytes(AUTH_CODE_BYTES).toString('base64url');
    const scopes = params.scope.split(' ').filter((s) => s.length > 0);
    const now = new Date();

    const authCode: AuthorizationCode = {
      code,
      tenantId,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      scopes,
      expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS),
      createdAt: now,
    };

    this.authCodes.set(code, authCode);

    log.info('Authorization code issued', {
      clientId: params.clientId,
      tenantId,
      scopes,
    });

    // Build redirect URL with code and state
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    redirectUrl.searchParams.set('state', params.state);

    return {
      code,
      redirectUri: redirectUrl.toString(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Token Endpoint — Code Exchange
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Exchange an authorization code for access and refresh tokens.
   *
   * Validates the code, PKCE verifier, client, and redirect URI.
   * Authorization codes are single-use and deleted after exchange.
   *
   * @param params - The token exchange parameters.
   * @returns A {@link TokenResponse} containing access and refresh tokens.
   * @throws {OAuthError} On invalid or expired code, PKCE failure, etc.
   */
  public exchangeCode(params: TokenExchangeParams): TokenResponse {
    // Validate grant_type
    if (params.grantType !== 'authorization_code') {
      throw new OAuthError(
        'unsupported_grant_type',
        `Only "authorization_code" grant_type is supported. Received: "${params.grantType}".`,
      );
    }

    // Look up the authorization code
    const authCode = this.authCodes.get(params.code);
    if (!authCode) {
      throw new OAuthError('invalid_grant', 'Authorization code not found or already used.');
    }

    // Delete immediately to prevent replay (single-use)
    this.authCodes.delete(params.code);

    // Check expiry
    if (authCode.expiresAt.getTime() < Date.now()) {
      throw new OAuthError('invalid_grant', 'Authorization code has expired.');
    }

    // Validate client_id matches
    if (authCode.clientId !== params.clientId) {
      throw new OAuthError('invalid_grant', 'client_id does not match the authorization request.');
    }

    // Validate redirect_uri matches
    if (authCode.redirectUri !== params.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
    }

    // Validate PKCE code_verifier against stored code_challenge (S256)
    if (!this.verifyPKCE(params.codeVerifier, authCode.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE code_verifier validation failed.');
    }

    // Generate tokens
    const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const now = new Date();
    const expiresAt = now.getTime() + ACCESS_TOKEN_TTL_MS;

    // Create a server session and use its token as the access token so
    // the auth middleware (which validates session tokens) can authenticate
    // requests bearing this OAuth access token.
    const session = this.sessionManager.createSession(authCode.tenantId);
    const accessToken = session.token;

    // Store refresh token
    const oauthToken: OAuthToken = {
      accessToken,
      refreshToken,
      tenantId: authCode.tenantId,
      clientId: authCode.clientId,
      scopes: authCode.scopes,
      expiresAt,
      createdAt: now,
    };

    this.refreshTokens.set(refreshToken, oauthToken);

    log.info('Authorization code exchanged for tokens', {
      clientId: authCode.clientId,
      tenantId: authCode.tenantId,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: authCode.scopes.join(' '),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Token Endpoint — Refresh
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Refresh an access token using a refresh token.
   *
   * Issues a new access token with the same scopes.
   * The refresh token itself is rotated (old one invalidated).
   *
   * @param params - The refresh parameters.
   * @returns A {@link TokenResponse} with a new access token and rotated refresh token.
   * @throws {OAuthError} On invalid or unknown refresh token.
   */
  public refreshAccessToken(params: RefreshParams): TokenResponse {
    if (params.grantType !== 'refresh_token') {
      throw new OAuthError(
        'unsupported_grant_type',
        `Only "refresh_token" grant_type is supported. Received: "${params.grantType}".`,
      );
    }

    const existing = this.refreshTokens.get(params.refreshToken);
    if (!existing) {
      throw new OAuthError('invalid_grant', 'Refresh token not found or revoked.');
    }

    // Validate client_id
    if (existing.clientId !== params.clientId) {
      throw new OAuthError('invalid_grant', 'client_id does not match the refresh token.');
    }

    // Delete old refresh token (rotation)
    this.refreshTokens.delete(params.refreshToken);

    // Generate new tokens — create a session so the access token matches
    const newRefreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const now = new Date();
    const expiresAt = now.getTime() + ACCESS_TOKEN_TTL_MS;

    const newSession = this.sessionManager.createSession(existing.tenantId);
    const newAccessToken = newSession.token;

    const newOAuthToken: OAuthToken = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      tenantId: existing.tenantId,
      clientId: existing.clientId,
      scopes: existing.scopes,
      expiresAt,
      createdAt: now,
    };

    this.refreshTokens.set(newRefreshToken, newOAuthToken);

    log.info('Access token refreshed', {
      clientId: existing.clientId,
      tenantId: existing.tenantId,
    });

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: newRefreshToken,
      scope: existing.scopes.join(' '),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Token Revocation
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Revoke a refresh token, preventing further use.
   *
   * @param refreshToken - The refresh token to revoke.
   * @returns `true` if the token was found and revoked.
   */
  public revokeRefreshToken(refreshToken: string): boolean {
    const existed = this.refreshTokens.has(refreshToken);
    this.refreshTokens.delete(refreshToken);
    if (existed) {
      log.info('Refresh token revoked');
    }
    return existed;
  }

  /**
   * Revoke all refresh tokens for a specific tenant.
   *
   * @param tenantId - The tenant whose tokens should be revoked.
   * @returns The number of tokens revoked.
   */
  public revokeAllTokensForTenant(tenantId: string): number {
    let count = 0;
    for (const [token, info] of this.refreshTokens.entries()) {
      if (info.tenantId === tenantId) {
        this.refreshTokens.delete(token);
        count++;
      }
    }
    if (count > 0) {
      log.info('All refresh tokens revoked for tenant', { tenantId, count });
    }
    return count;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Cleanup & Disposal
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Remove expired authorization codes from the store.
   *
   * @returns The number of codes removed.
   */
  public cleanupExpiredCodes(): number {
    const now = Date.now();
    let removed = 0;

    for (const [code, authCode] of this.authCodes.entries()) {
      if (authCode.expiresAt.getTime() < now) {
        this.authCodes.delete(code);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug('Expired authorization codes cleaned up', { removed });
    }

    return removed;
  }

  /**
   * Stop the cleanup timer and release resources.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    log.info('OAuth provider disposed');
  }

  // ───────────────────────────────────────────────────────────────────────
  // PKCE Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Verify a PKCE code_verifier against a stored code_challenge (S256).
   *
   * The verifier is hashed with SHA-256 and base64url-encoded, then
   * compared against the stored challenge.
   *
   * @param codeVerifier - The plain-text code verifier from the client.
   * @param codeChallenge - The stored code challenge from the authorization request.
   * @returns `true` if the verifier matches the challenge.
   */
  private verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
    const hash = crypto
      .createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    return hash === codeChallenge;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Static Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Generate a PKCE code verifier and its corresponding S256 challenge.
   *
   * Useful for clients that need to create PKCE parameters.
   *
   * @returns An object with `codeVerifier` and `codeChallenge`.
   */
  public static generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }
}
