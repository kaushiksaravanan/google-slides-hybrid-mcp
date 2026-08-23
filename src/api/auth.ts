/**
 * @module api/auth
 * @description OAuth2 authentication for Google Slides and Drive APIs.
 *
 * Provides:
 * - OAuth2 client creation from credentials (client ID, secret, refresh token)
 * - Automatic access-token refresh
 * - Factory functions for authenticated Slides and Drive service instances
 *
 * All credential values are read from environment variables at module level,
 * but can also be supplied explicitly to the factory functions for testing
 * or multi-account scenarios.
 */

import { google, type slides_v1, type drive_v3 } from 'googleapis';
// Use the OAuth2Client type via googleapis re-export to avoid a direct
// dependency on google-auth-library (which googleapis bundles internally).
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import type { OAuthCredentials, ApiConfig } from '../shared/types.js';
import { AuthenticationError, createAuthError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import {
  ENV_VARS,
  GOOGLE_SLIDES_SCOPE,
  GOOGLE_DRIVE_SCOPE,
} from '../shared/constants.js';

const log = createLogger('api.auth');

// ─────────────────────────────────────────────────────────────────────────────
// Internal State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached OAuth2 client singleton. Created lazily on first call to
 * {@link getAuthenticatedClient}.
 */
let cachedOAuth2Client: OAuth2Client | null = null;

/**
 * The redirect URI used during the OAuth consent flow.
 * For installed / CLI apps Google recommends `urn:ietf:wg:oauth:2.0:oob`
 * or a localhost redirect. We use localhost to match `getRefreshToken.ts`.
 */
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// ─────────────────────────────────────────────────────────────────────────────
// Credential Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve OAuth credentials from an explicit config object **or** from
 * environment variables.
 *
 * @param config - Optional explicit credentials. When omitted the function
 *   reads from `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
 *   `GOOGLE_REFRESH_TOKEN` environment variables.
 * @returns A validated {@link OAuthCredentials} object.
 * @throws {AuthenticationError} if any required credential is missing.
 */
function resolveCredentials(config?: Partial<ApiConfig>): OAuthCredentials {
  const clientId =
    config?.clientId ?? process.env[ENV_VARS.GOOGLE_CLIENT_ID] ?? '';
  const clientSecret =
    config?.clientSecret ?? process.env[ENV_VARS.GOOGLE_CLIENT_SECRET] ?? '';
  const refreshToken =
    config?.refreshToken ?? process.env[ENV_VARS.GOOGLE_REFRESH_TOKEN] ?? '';

  if (!clientId) {
    throw new AuthenticationError(
      `Missing Google OAuth client ID. Set the ${ENV_VARS.GOOGLE_CLIENT_ID} environment variable or pass it in config.`,
    );
  }
  if (!clientSecret) {
    throw new AuthenticationError(
      `Missing Google OAuth client secret. Set the ${ENV_VARS.GOOGLE_CLIENT_SECRET} environment variable or pass it in config.`,
    );
  }
  if (!refreshToken) {
    throw new AuthenticationError(
      `Missing Google OAuth refresh token. Set the ${ENV_VARS.GOOGLE_REFRESH_TOKEN} environment variable or run "npm run get-token".`,
    );
  }

  return { clientId, clientSecret, refreshToken };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Client Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new Google OAuth2 client from the given credentials.
 *
 * The client is configured with the refresh token and will automatically
 * request a new access token on the first API call (and whenever the
 * current access token expires).
 *
 * @param credentials - OAuth credentials (client ID, secret, refresh token).
 * @returns A configured {@link OAuth2Client} instance.
 */
function createOAuth2Client(credentials: OAuthCredentials): OAuth2Client {
  const client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    REDIRECT_URI,
  );

  client.setCredentials({
    refresh_token: credentials.refreshToken,
  });

  // Listen for automatic token refreshes so we can log them (never log the
  // actual token value — the logger's redaction format handles this).
  client.on('tokens', (tokens) => {
    log.info('OAuth2 access token refreshed', {
      expiryDate: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : 'unknown',
      tokenType: tokens.token_type,
    });
  });

  return client;
}

/**
 * Get (or create) a cached, authenticated OAuth2 client.
 *
 * The first call creates the client and triggers an initial access-token
 * fetch. Subsequent calls return the same client instance, which
 * transparently refreshes its token as needed.
 *
 * @param config - Optional explicit credentials. If omitted, environment
 *   variables are used.
 * @param forceNew - When `true`, discard any cached client and create a
 *   fresh one. Useful after credential rotation.
 * @returns A ready-to-use {@link OAuth2Client}.
 * @throws {AuthenticationError} on missing credentials or token-refresh
 *   failure.
 */
export async function getAuthenticatedClient(
  config?: Partial<ApiConfig>,
  forceNew = false,
): Promise<OAuth2Client> {
  if (cachedOAuth2Client && !forceNew && !config) {
    return cachedOAuth2Client;
  }

  try {
    const credentials = resolveCredentials(config);
    const client = createOAuth2Client(credentials);

    // Force an immediate token refresh to validate credentials early.
    log.debug('Performing initial access-token fetch');
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new AuthenticationError(
        'OAuth2 token refresh succeeded but returned no access token.',
      );
    }

    log.info('OAuth2 client authenticated successfully');
    cachedOAuth2Client = client;
    return client;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw createAuthError(error, GOOGLE_SLIDES_SCOPE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get an authenticated Google Slides API service instance.
 *
 * @param config - Optional explicit credentials.
 * @returns A `slides_v1.Slides` service ready for API calls.
 * @throws {AuthenticationError} on missing or invalid credentials.
 *
 * @example
 * ```ts
 * const slides = await getSlidesService();
 * const pres = await slides.presentations.get({ presentationId: 'abc' });
 * ```
 */
export async function getSlidesService(
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Slides> {
  const auth = await getAuthenticatedClient(config);
  return google.slides({ version: 'v1', auth });
}

/**
 * Get an authenticated Google Drive API service instance.
 *
 * Used for file-level operations such as PDF export and sharing.
 *
 * @param config - Optional explicit credentials.
 * @returns A `drive_v3.Drive` service ready for API calls.
 * @throws {AuthenticationError} on missing or invalid credentials.
 *
 * @example
 * ```ts
 * const drive = await getDriveService();
 * const file = await drive.files.get({ fileId: 'abc' });
 * ```
 */
export async function getDriveService(
  config?: Partial<ApiConfig>,
): Promise<drive_v3.Drive> {
  const auth = await getAuthenticatedClient(config);
  return google.drive({ version: 'v3', auth });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invalidate the cached OAuth2 client. The next call to
 * {@link getAuthenticatedClient} will create a fresh client.
 *
 * Useful when credentials have been rotated or revoked.
 */
export function clearAuthCache(): void {
  cachedOAuth2Client = null;
  log.info('OAuth2 client cache cleared');
}

/**
 * Generate the OAuth2 authorization URL for the interactive consent flow.
 *
 * @param clientId - OAuth client ID.
 * @param clientSecret - OAuth client secret.
 * @param scopes - Requested OAuth scopes.
 * @returns The full authorization URL the user should visit.
 */
export function getAuthorizationUrl(
  clientId: string,
  clientSecret: string,
  scopes: readonly string[] = [GOOGLE_SLIDES_SCOPE, GOOGLE_DRIVE_SCOPE],
): string {
  const client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes as string[],
  });
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param clientId - OAuth client ID.
 * @param clientSecret - OAuth client secret.
 * @param code - The authorization code received from the consent redirect.
 * @returns The token response, including the refresh token.
 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; expiryDate: number | null }> {
  const client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new AuthenticationError('Token exchange returned no access token.');
  }
  if (!tokens.refresh_token) {
    throw new AuthenticationError(
      'Token exchange returned no refresh token. Ensure prompt=consent was used.',
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ?? null,
  };
}
