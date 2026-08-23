/**
 * @module security/csrf-protection
 * @description CSRF protection using the double-submit cookie pattern.
 *
 * How it works:
 * 1. A cryptographic token is generated and set as an HTTP-only cookie.
 * 2. The same token must be sent in a request header (`X-CSRF-Token`).
 * 3. The middleware compares the two values using constant-time comparison.
 *
 * Exemptions:
 * - Requests authenticated via API key (stateless, not vulnerable to CSRF).
 * - MCP transport endpoints (SSE/stdio, not browser-originated).
 * - Safe HTTP methods (GET, HEAD, OPTIONS).
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';

import type { Request, Response, NextFunction } from 'express';

const log = createLogger('security.csrf-protection');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Token length in bytes (32 bytes = 64 hex chars). */
const TOKEN_BYTES = 32;

/** Name of the CSRF cookie. */
const CSRF_COOKIE_NAME = '__csrf_token';

/** Name of the CSRF header clients must send. */
const CSRF_HEADER_NAME = 'x-csrf-token';

/** Safe methods that do not mutate state (exempt from CSRF checks). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Route prefixes exempt from CSRF (MCP transport endpoints). */
const EXEMPT_PREFIXES: string[] = [
  '/mcp',
  '/sse',
  '/stdio',
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for CSRF protection middleware. */
export interface CsrfOptions {
  /** Cookie name (default `__csrf_token`). */
  cookieName?: string;
  /** Header name (default `x-csrf-token`). */
  headerName?: string;
  /** Additional route prefixes to exempt from CSRF checks. */
  exemptPrefixes?: string[];
  /** Cookie path (default `/`). */
  cookiePath?: string;
  /** Whether to set the Secure flag on the cookie (default: auto-detect from NODE_ENV). */
  secure?: boolean;
  /** SameSite cookie attribute (default `strict`). */
  sameSite?: 'strict' | 'lax' | 'none';
  /** Token validity duration in ms (default 24 hours). */
  tokenTtlMs?: number;
}

/** Extended request with optional auth context. */
interface AuthenticatedRequest extends Request {
  /** Auth method from upstream auth middleware. */
  authMethod?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure CSRF token.
 *
 * @returns A 64-character hex string.
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the CSRF token from a request.
 *
 * Compares the cookie value against the header value using constant-time
 * comparison to prevent timing attacks.
 *
 * @param req        - The Express request object.
 * @param cookieName - The cookie name to read from (default `__csrf_token`).
 * @param headerName - The header name to read from (default `x-csrf-token`).
 * @returns `true` if the CSRF token is valid.
 */
export function validateCsrfToken(
  req: Request,
  cookieName: string = CSRF_COOKIE_NAME,
  headerName: string = CSRF_HEADER_NAME,
): boolean {
  // Extract token from cookie
  const cookieToken = extractCookieValue(req, cookieName);
  if (!cookieToken) {
    log.debug('CSRF validation failed: no cookie token');
    return false;
  }

  // Extract token from header
  const headerToken = req.headers[headerName] as string | undefined;
  if (!headerToken) {
    log.debug('CSRF validation failed: no header token');
    return false;
  }

  // Constant-time comparison
  if (cookieToken.length !== headerToken.length) {
    return false;
  }

  try {
    const a = Buffer.from(cookieToken, 'utf8');
    const b = Buffer.from(headerToken, 'utf8');

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an Express middleware for CSRF protection using the double-submit
 * cookie pattern.
 *
 * @param options - Configuration options.
 * @returns An Express middleware function.
 *
 * @example
 * ```ts
 * import { csrfProtection } from '../security/csrf-protection.js';
 * app.use(csrfProtection());
 * ```
 */
export function csrfProtection(options: CsrfOptions = {}): (req: Request, res: Response, next: NextFunction) => void {
  const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
  const headerName = options.headerName ?? CSRF_HEADER_NAME;
  const exemptPrefixes = [...EXEMPT_PREFIXES, ...(options.exemptPrefixes ?? [])];
  const cookiePath = options.cookiePath ?? '/';
  const secure = options.secure ?? (process.env['NODE_ENV'] === 'production');
  const sameSite = options.sameSite ?? 'strict';

  log.info('CSRF protection middleware initialised', {
    cookieName,
    headerName,
    exemptPrefixes,
    secure,
    sameSite,
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    // ── Exemptions ──────────────────────────────────────────────────────

    // Safe methods don't need CSRF protection
    if (SAFE_METHODS.has(req.method)) {
      ensureCsrfCookie(res, req, cookieName, cookiePath, secure, sameSite);
      next();
      return;
    }

    // API key authenticated requests are exempt (not browser-originated)
    if (authReq.authMethod === 'api_key') {
      next();
      return;
    }

    // Check if request has an API key header (pre-auth check)
    if (req.headers['x-api-key']) {
      next();
      return;
    }

    // Exempt route prefixes (MCP transport endpoints)
    const isExempt = exemptPrefixes.some((prefix) => req.path.startsWith(prefix));
    if (isExempt) {
      next();
      return;
    }

    // ── Validation ──────────────────────────────────────────────────────

    const valid = validateCsrfToken(req, cookieName, headerName);

    if (!valid) {
      log.warn('CSRF validation failed', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        hasCookie: !!extractCookieValue(req, cookieName),
        hasHeader: !!req.headers[headerName],
      });

      res.status(403).json({
        error: 'CSRF token validation failed',
        message: 'Missing or invalid CSRF token. Ensure the token from the cookie is sent in the X-CSRF-Token header.',
      });
      return;
    }

    // Rotate token after successful validation (optional defense-in-depth)
    ensureCsrfCookie(res, req, cookieName, cookiePath, secure, sameSite, true);

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Endpoint Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express route handler that returns a fresh CSRF token.
 * Clients call this endpoint to get a token for subsequent mutating requests.
 *
 * @example
 * ```ts
 * app.get('/api/csrf-token', csrfTokenEndpoint());
 * ```
 */
export function csrfTokenEndpoint(
  options: Pick<CsrfOptions, 'cookieName' | 'cookiePath' | 'secure' | 'sameSite'> = {},
): (req: Request, res: Response) => void {
  const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
  const cookiePath = options.cookiePath ?? '/';
  const secure = options.secure ?? (process.env['NODE_ENV'] === 'production');
  const sameSite = options.sameSite ?? 'strict';

  return (_req: Request, res: Response) => {
    const token = generateCsrfToken();

    setCsrfCookie(res, cookieName, token, cookiePath, secure, sameSite);

    res.json({ token });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a CSRF cookie exists on the response. If the client doesn't have one,
 * generate and set it.
 */
function ensureCsrfCookie(
  res: Response,
  req: Request,
  cookieName: string,
  cookiePath: string,
  secure: boolean,
  sameSite: 'strict' | 'lax' | 'none',
  forceRotate: boolean = false,
): void {
  const existingToken = extractCookieValue(req, cookieName);

  if (!existingToken || forceRotate) {
    const token = generateCsrfToken();
    setCsrfCookie(res, cookieName, token, cookiePath, secure, sameSite);
  }
}

/**
 * Set the CSRF cookie on the response.
 */
function setCsrfCookie(
  res: Response,
  cookieName: string,
  token: string,
  path: string,
  secure: boolean,
  sameSite: 'strict' | 'lax' | 'none',
): void {
  // Build a Set-Cookie header manually to avoid depending on cookie-parser
  const parts = [
    `${cookieName}=${token}`,
    `Path=${path}`,
    'HttpOnly',
    `SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`,
  ];

  if (secure) {
    parts.push('Secure');
  }

  // Append to existing Set-Cookie headers (don't overwrite)
  const existing = res.getHeader('Set-Cookie');
  const cookieStr = parts.join('; ');

  if (existing) {
    const cookies = Array.isArray(existing) ? existing : [String(existing)];
    // Remove any existing CSRF cookie before appending new one
    const filtered = cookies.filter((c) => !c.startsWith(`${cookieName}=`));
    filtered.push(cookieStr);
    res.setHeader('Set-Cookie', filtered);
  } else {
    res.setHeader('Set-Cookie', cookieStr);
  }
}

/**
 * Extract a cookie value from the raw Cookie header.
 * Does NOT require cookie-parser middleware.
 */
function extractCookieValue(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split('=');
    if (key?.trim() === name) {
      return valueParts.join('=').trim();
    }
  }

  return undefined;
}
