/**
 * @module shared/errors
 * @description Custom error classes for every failure mode in the hybrid MCP server.
 * Each error carries structured context so callers can react programmatically
 * (retry, surface to the user, log with full metadata, etc.).
 */

import { MCPLayer } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Base MCP Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base class for all MCP server errors.
 * Guarantees a consistent `toJSON()` shape for structured logging.
 */
export class MCPBaseError extends Error {
  /** ISO-8601 timestamp of when the error was created. */
  public readonly timestamp: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date().toISOString();
    // Ensure the prototype chain is correct for instanceof checks.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialise to a plain object suitable for JSON logging. */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Slides API Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when a Google Slides REST API call fails.
 *
 * @example
 * ```ts
 * throw new SlidesApiError(404, 'Presentation not found', 'abc123');
 * ```
 */
export class SlidesApiError extends MCPBaseError {
  /** HTTP status code returned by the API. */
  public readonly statusCode: number;
  /** The error message from the Google API response body. */
  public readonly apiMessage: string;
  /** The presentation ID the request targeted, if available. */
  public readonly presentationId?: string;

  constructor(statusCode: number, apiMessage: string, presentationId?: string) {
    const idSegment = presentationId ? ` [presentation=${presentationId}]` : '';
    super(`Google Slides API error ${statusCode}${idSegment}: ${apiMessage}`);
    this.statusCode = statusCode;
    this.apiMessage = apiMessage;
    this.presentationId = presentationId;
  }

  /** Whether this error is retryable based on the HTTP status code. */
  public get isRetryable(): boolean {
    return [429, 500, 502, 503].includes(this.statusCode);
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      statusCode: this.statusCode,
      apiMessage: this.apiMessage,
      presentationId: this.presentationId,
      isRetryable: this.isRetryable,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Connection Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when a connection to the browser (Chrome DevTools Protocol) fails.
 */
export class BrowserConnectionError extends MCPBaseError {
  /** The WebSocket endpoint that was being connected to, if known. */
  public readonly wsEndpoint?: string;

  constructor(message: string, wsEndpoint?: string) {
    const epSegment = wsEndpoint ? ` (endpoint=${wsEndpoint})` : '';
    super(`Browser connection failed${epSegment}: ${message}`);
    this.wsEndpoint = wsEndpoint;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      wsEndpoint: this.wsEndpoint,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vision Analysis Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the vision / design-analysis pipeline encounters an error.
 */
export class VisionAnalysisError extends MCPBaseError {
  /** The analysis step that failed (e.g. "screenshot", "inference", "scoring"). */
  public readonly step?: string;

  constructor(message: string, step?: string) {
    const stepSegment = step ? ` [step=${step}]` : '';
    super(`Vision analysis error${stepSegment}: ${message}`);
    this.step = step;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      step: this.step,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when OAuth authentication or token refresh fails.
 */
export class AuthenticationError extends MCPBaseError {
  /** The OAuth scope that was being requested when the failure occurred. */
  public readonly scope?: string;

  constructor(message: string, scope?: string) {
    const scopeSegment = scope ? ` (scope=${scope})` : '';
    super(`Authentication failed${scopeSegment}: ${message}`);
    this.scope = scope;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      scope: this.scope,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the server or the upstream Google API enforces a rate limit.
 */
export class RateLimitError extends MCPBaseError {
  /**
   * Number of seconds (or milliseconds — see `unit`) the caller should wait
   * before retrying.
   */
  public readonly retryAfter: number;
  /** The unit for `retryAfter`. Defaults to milliseconds. */
  public readonly unit: 'ms' | 's';

  constructor(message: string, retryAfter: number, unit: 'ms' | 's' = 'ms') {
    super(`Rate limit exceeded: ${message} (retry after ${retryAfter}${unit})`);
    this.retryAfter = retryAfter;
    this.unit = unit;
  }

  /** Returns the retry-after value normalised to milliseconds. */
  public get retryAfterMs(): number {
    return this.unit === 's' ? this.retryAfter * 1000 : this.retryAfter;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      retryAfter: this.retryAfter,
      unit: this.unit,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Execution Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when an MCP tool handler encounters an unrecoverable failure.
 */
export class ToolExecutionError extends MCPBaseError {
  /** Name of the MCP tool that failed. */
  public readonly toolName: string;
  /** The server layer the tool belongs to. */
  public readonly layer: MCPLayer;

  constructor(message: string, toolName: string, layer: MCPLayer) {
    super(`Tool "${toolName}" (${layer}) failed: ${message}`);
    this.toolName = toolName;
    this.layer = layer;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      toolName: this.toolName,
      layer: this.layer,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a {@link SlidesApiError} from a raw Google API error response.
 *
 * @param error - The caught error (typically an Axios or googleapis error).
 * @param presentationId - Optional presentation ID for context.
 * @returns A structured {@link SlidesApiError}.
 */
export function createApiError(
  error: unknown,
  presentationId?: string,
): SlidesApiError {
  if (error instanceof SlidesApiError) {
    return error;
  }

  const err = error as Record<string, unknown> | undefined;
  const response = err?.response as Record<string, unknown> | undefined;
  const status =
    (response?.status as number) ?? (err?.code as number) ?? 500;
  const message =
    (response?.statusText as string) ??
    (err?.message as string) ??
    'Unknown API error';

  return new SlidesApiError(status, message, presentationId);
}

/**
 * Create a {@link BrowserConnectionError} from a raw error.
 *
 * @param error - The caught error.
 * @param wsEndpoint - The WebSocket endpoint, if known.
 * @returns A structured {@link BrowserConnectionError}.
 */
export function createBrowserError(
  error: unknown,
  wsEndpoint?: string,
): BrowserConnectionError {
  if (error instanceof BrowserConnectionError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : String(error);
  return new BrowserConnectionError(message, wsEndpoint);
}

/**
 * Create a {@link VisionAnalysisError} from a raw error.
 *
 * @param error - The caught error.
 * @param step - The analysis step that failed.
 * @returns A structured {@link VisionAnalysisError}.
 */
export function createVisionError(
  error: unknown,
  step?: string,
): VisionAnalysisError {
  if (error instanceof VisionAnalysisError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : String(error);
  return new VisionAnalysisError(message, step);
}

/**
 * Create an {@link AuthenticationError} from a raw error.
 *
 * @param error - The caught error.
 * @param scope - The OAuth scope, if relevant.
 * @returns A structured {@link AuthenticationError}.
 */
export function createAuthError(
  error: unknown,
  scope?: string,
): AuthenticationError {
  if (error instanceof AuthenticationError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : String(error);
  return new AuthenticationError(message, scope);
}

/**
 * Create a {@link ToolExecutionError} from a raw error.
 *
 * @param error - The caught error.
 * @param toolName - The MCP tool name.
 * @param layer - The MCP layer the tool belongs to.
 * @returns A structured {@link ToolExecutionError}.
 */
export function createToolError(
  error: unknown,
  toolName: string,
  layer: MCPLayer,
): ToolExecutionError {
  if (error instanceof ToolExecutionError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(message, toolName, layer);
}

/**
 * Type-guard that checks whether an unknown value is an instance of
 * any of the custom MCP error classes.
 */
export function isMCPError(error: unknown): error is MCPBaseError {
  return error instanceof MCPBaseError;
}

/**
 * Determine whether an error is retryable.
 * Works with both custom MCP errors and raw Google API errors.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof SlidesApiError) {
    return error.isRetryable;
  }
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof BrowserConnectionError) {
    // Browser disconnects are often transient.
    return true;
  }

  // Check for raw HTTP status codes on unknown error shapes.
  const err = error as Record<string, unknown> | undefined;
  const status =
    (err?.status as number) ??
    ((err?.response as Record<string, unknown>)?.status as number);
  if (typeof status === 'number') {
    return [429, 500, 502, 503].includes(status);
  }

  return false;
}
