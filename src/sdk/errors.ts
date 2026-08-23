/**
 * @module sdk/errors
 * @description Typed error classes for the Google Slides Hybrid MCP client SDK.
 *
 * All errors extend the base {@link ApiError} class which carries the
 * HTTP status code, response body, and headers from the failed request.
 * Specialised subclasses add semantics for rate-limiting, authentication,
 * not-found, and validation failures.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base API Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base error for all HTTP API failures.
 *
 * @example
 * ```ts
 * try {
 *   await client.getPresentation('bad-id');
 * } catch (err) {
 *   if (err instanceof ApiError) {
 *     console.error(err.statusCode, err.body);
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** HTTP status code returned by the server. */
  public readonly statusCode: number;

  /** Parsed JSON body of the error response, if available. */
  public readonly body: unknown;

  /** Response headers from the failed request. */
  public readonly headers: Record<string, string>;

  constructor(
    statusCode: number,
    message: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.body = body;
    this.headers = headers ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the server responds with HTTP 429 (Too Many Requests).
 *
 * The {@link retryAfter} property indicates how many seconds the client
 * should wait before retrying.
 */
export class RateLimitError extends ApiError {
  /** Number of seconds to wait before retrying. */
  public readonly retryAfter: number;

  constructor(
    message: string,
    retryAfter: number,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    super(429, message, body, headers);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the server responds with HTTP 401 (Unauthorized) or
 * 403 (Forbidden), indicating an authentication or authorisation failure.
 */
export class AuthenticationError extends ApiError {
  constructor(
    statusCode: number,
    message: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    super(statusCode, message, body, headers);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Not Found Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the server responds with HTTP 404 (Not Found).
 */
export class NotFoundError extends ApiError {
  constructor(
    message: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    super(404, message, body, headers);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Error
// ─────────────────────────────────────────────────────────────────────────────

/** A single field-level validation error returned by the server. */
export interface ValidationField {
  /** Dot-separated path to the invalid field (e.g. "title" or "options.insertionIndex"). */
  path: string;
  /** Human-readable description of the validation failure. */
  message: string;
}

/**
 * Raised when the server responds with HTTP 400 and a validation error code.
 *
 * The {@link fields} array contains per-field error details when available.
 */
export class ValidationError extends ApiError {
  /** Per-field validation error details. */
  public readonly fields: ValidationField[];

  constructor(
    message: string,
    fields?: ValidationField[],
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    super(400, message, body, headers);
    this.name = 'ValidationError';
    this.fields = fields ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
