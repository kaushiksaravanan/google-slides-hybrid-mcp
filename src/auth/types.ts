/**
 * @module auth/types
 * @description Type definitions for the multi-tenant authentication system.
 *
 * Covers tenants, sessions, API keys, OAuth credentials, plan limits,
 * and authentication result types used across the auth subsystem.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tenant Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported subscription plans with tiered capabilities. */
export type Plan = 'free' | 'pro' | 'enterprise';

/**
 * A tenant represents an organisation or individual account in the
 * multi-tenant SaaS system.  Each tenant has isolated Google credentials,
 * an API key, and plan-gated feature limits.
 */
export interface Tenant {
  /** Unique tenant identifier (UUID v4). */
  id: string;
  /** Human-readable display name for the tenant. */
  name: string;
  /** Primary email address associated with the tenant account. */
  email: string;
  /** Subscription plan determining feature limits and capabilities. */
  plan: Plan;
  /** Optional API key for programmatic access. */
  apiKey?: string;
  /** Google OAuth2 credentials for Slides API access. */
  googleCredentials?: GoogleCredentials;
  /** Timestamp when the tenant account was created. */
  createdAt: Date;
  /** Timestamp of the tenant's most recent activity. */
  lastActiveAt: Date;
  /** Plan-specific settings and feature flags. */
  settings: TenantSettings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Credentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Google OAuth2 credentials for a tenant.
 * Stores both long-lived refresh token and short-lived access token.
 */
export interface GoogleCredentials {
  /** OAuth2 client ID from Google Cloud Console. */
  clientId: string;
  /** OAuth2 client secret from Google Cloud Console. */
  clientSecret: string;
  /** Long-lived refresh token obtained via OAuth consent flow. */
  refreshToken: string;
  /** Short-lived access token (cached for reuse until expiry). */
  accessToken?: string;
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant Settings & Plan Limits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-tenant settings that gate features and enforce usage limits.
 * Populated from {@link PLAN_LIMITS} based on the tenant's plan.
 */
export interface TenantSettings {
  /** Maximum number of presentations a tenant can create per calendar day. */
  maxPresentationsPerDay: number;
  /** Maximum number of slides allowed in a single presentation. */
  maxSlidesPerPresentation: number;
  /** Whether vision-based slide analysis is enabled. */
  visionEnabled: boolean;
  /** Whether live browser automation is enabled. */
  browserEnabled: boolean;
  /** Whether custom slide templates are enabled. */
  customTemplatesEnabled: boolean;
  /** Whether outbound webhook notifications are enabled. */
  webhooksEnabled: boolean;
}

/**
 * Default settings for each subscription plan.
 * Used when creating new tenants and when enforcing plan limits.
 */
export const PLAN_LIMITS: Record<Plan, TenantSettings> = {
  free: {
    maxPresentationsPerDay: 5,
    maxSlidesPerPresentation: 20,
    visionEnabled: false,
    browserEnabled: false,
    customTemplatesEnabled: false,
    webhooksEnabled: false,
  },
  pro: {
    maxPresentationsPerDay: 50,
    maxSlidesPerPresentation: 100,
    visionEnabled: true,
    browserEnabled: true,
    customTemplatesEnabled: true,
    webhooksEnabled: false,
  },
  enterprise: {
    maxPresentationsPerDay: 500,
    maxSlidesPerPresentation: 500,
    visionEnabled: true,
    browserEnabled: true,
    customTemplatesEnabled: true,
    webhooksEnabled: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents an active authenticated session for a tenant.
 * Sessions are created upon login and validated on each request.
 */
export interface Session {
  /** Unique session identifier (UUID v4). */
  id: string;
  /** The tenant this session belongs to. */
  tenantId: string;
  /** Opaque bearer token used for authentication (crypto-random hex). */
  token: string;
  /** When this session expires and must be re-authenticated. */
  expiresAt: Date;
  /** When this session was originally created. */
  createdAt: Date;
  /** Updated on each successful request to track activity. */
  lastActivityAt: Date;
  /** IP address of the client that created this session. */
  ipAddress?: string;
  /** User-Agent header from the client that created this session. */
  userAgent?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Key Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata and configuration for a tenant API key.
 * API keys provide stateless authentication with scoped permissions.
 */
export interface ApiKeyInfo {
  /** The full API key string (prefixed, crypto-random). */
  key: string;
  /** The tenant this API key belongs to. */
  tenantId: string;
  /** Human-readable name for identifying this key (e.g. "CI/CD Pipeline"). */
  name: string;
  /** List of permission scopes this key is authorised for. */
  permissions: string[];
  /** Maximum requests per minute allowed for this key. */
  rateLimit: number;
  /** When this API key was created. */
  createdAt: Date;
  /** Timestamp of the most recent usage, if any. */
  lastUsedAt?: Date;
  /** Optional expiry date after which the key is invalid. */
  expiresAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Result Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported authentication methods for incoming requests. */
export type AuthMethod = 'api_key' | 'session' | 'oauth2' | 'service_account';

/**
 * The result of an authentication attempt.
 * On success, contains the resolved tenant and session context.
 * On failure, contains a descriptive error message.
 */
export interface AuthResult {
  /** Whether the authentication succeeded. */
  authenticated: boolean;
  /** The resolved tenant, if authentication succeeded. */
  tenant?: Tenant;
  /** The resolved session, if authentication was session-based. */
  session?: Session;
  /** The method used to authenticate. */
  method: AuthMethod;
  /** Human-readable error description on failure. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Authorization Code Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stored authorization code issued during the OAuth2 authorization code flow.
 * Codes are single-use and short-lived (10 minute TTL).
 */
export interface AuthorizationCode {
  /** The authorization code string. */
  code: string;
  /** The tenant ID this code was issued for. */
  tenantId: string;
  /** The client_id that requested this code. */
  clientId: string;
  /** The redirect URI provided in the authorization request. */
  redirectUri: string;
  /** The PKCE code challenge (S256). */
  codeChallenge: string;
  /** The PKCE code challenge method (always "S256"). */
  codeChallengeMethod: 'S256';
  /** The scopes granted for this authorization. */
  scopes: string[];
  /** When this code expires (10 min from creation). */
  expiresAt: Date;
  /** When this code was created. */
  createdAt: Date;
}

/**
 * An OAuth2 access/refresh token pair issued after code exchange.
 */
export interface OAuthToken {
  /** The access token string. */
  accessToken: string;
  /** The refresh token string. */
  refreshToken: string;
  /** The tenant this token was issued for. */
  tenantId: string;
  /** The client_id this token was issued to. */
  clientId: string;
  /** The scopes granted. */
  scopes: string[];
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt: number;
  /** When this token was created. */
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan Ordering (for plan comparison)
// ─────────────────────────────────────────────────────────────────────────────

/** Numeric ordering of plans for comparison (higher = more capable). */
export const PLAN_ORDER: Record<Plan, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};
