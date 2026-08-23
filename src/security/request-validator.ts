/**
 * @module security/request-validator
 * @description Request validation middleware that inspects and enforces
 * Content-Type, Content-Length, payload size, JSON structure, required
 * headers, and query parameter types before the request reaches handlers.
 *
 * Acts as a first-line defence against malformed, oversized, or
 * maliciously crafted requests.
 */

import { createLogger } from '../shared/logger.js';

import type { Request, Response, NextFunction } from 'express';

const log = createLogger('security.request-validator');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the RequestValidator. */
export interface RequestValidatorConfig {
  /** Maximum allowed payload size in bytes (default 10 MB). */
  maxPayloadSize: number;

  /** Allowed Content-Type values for request bodies (default: JSON + form). */
  allowedContentTypes: string[];

  /** Required headers for all requests (e.g. ['X-Request-Id']). */
  requiredHeaders: string[];

  /** Headers to strip from incoming requests (unknown/dangerous). */
  stripHeaders: string[];

  /** Maximum allowed URL length in characters (default 2048). */
  maxUrlLength: number;

  /** Maximum number of query parameters (default 50). */
  maxQueryParams: number;

  /** Expected query parameter types for validation. */
  queryParamSchema: Record<string, QueryParamType>;

  /** Whether to validate JSON body structure (default true). */
  validateJsonStructure: boolean;

  /** Maximum JSON nesting depth (default 20). */
  maxJsonDepth: number;

  /** Maximum number of keys in JSON body (default 1000). */
  maxJsonKeys: number;
}

/** Supported query parameter type constraints. */
export type QueryParamType = 'string' | 'number' | 'boolean' | 'uuid' | 'email';

/** Validation error detail. */
export interface ValidationError {
  /** The field or header that failed validation. */
  field: string;
  /** Human-readable error message. */
  message: string;
  /** The invalid value (truncated for safety). */
  value?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_URL_LENGTH = 2048;
const DEFAULT_MAX_QUERY_PARAMS = 50;
const DEFAULT_MAX_JSON_DEPTH = 20;
const DEFAULT_MAX_JSON_KEYS = 1000;

const DEFAULT_ALLOWED_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

/** Headers that should be stripped from incoming requests. */
const DEFAULT_STRIP_HEADERS = [
  'x-forwarded-host',    // Can be spoofed without proper proxy config
  'x-original-url',      // IIS-specific, potential bypass
  'x-rewrite-url',       // IIS-specific, potential bypass
];

/** UUID v4 pattern. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Simple email pattern (matches sanitizeEmail in input-sanitizer). */
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Methods that carry a request body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// ─────────────────────────────────────────────────────────────────────────────
// RequestValidator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request validation middleware class.
 *
 * Performs a comprehensive set of checks on incoming requests:
 * 1. URL length enforcement
 * 2. Content-Type validation
 * 3. Content-Length vs body size
 * 4. Payload size limits
 * 5. JSON structure validation (depth, key count)
 * 6. Required header checks
 * 7. Unknown header stripping
 * 8. Query parameter type validation
 *
 * @example
 * ```ts
 * const validator = new RequestValidator({
 *   maxPayloadSize: 5 * 1024 * 1024,
 *   requiredHeaders: ['x-request-id'],
 *   queryParamSchema: {
 *     page: 'number',
 *     id: 'uuid',
 *   },
 * });
 *
 * app.use(validator.middleware());
 * ```
 */
export class RequestValidator {
  private readonly config: RequestValidatorConfig;

  constructor(config: Partial<RequestValidatorConfig> = {}) {
    this.config = {
      maxPayloadSize: config.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD,
      allowedContentTypes: config.allowedContentTypes ?? [...DEFAULT_ALLOWED_CONTENT_TYPES],
      requiredHeaders: config.requiredHeaders ?? [],
      stripHeaders: config.stripHeaders ?? [...DEFAULT_STRIP_HEADERS],
      maxUrlLength: config.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH,
      maxQueryParams: config.maxQueryParams ?? DEFAULT_MAX_QUERY_PARAMS,
      queryParamSchema: config.queryParamSchema ?? {},
      validateJsonStructure: config.validateJsonStructure ?? true,
      maxJsonDepth: config.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
      maxJsonKeys: config.maxJsonKeys ?? DEFAULT_MAX_JSON_KEYS,
    };

    log.info('RequestValidator initialised', {
      maxPayloadSize: this.config.maxPayloadSize,
      allowedContentTypes: this.config.allowedContentTypes,
      requiredHeaders: this.config.requiredHeaders,
    });
  }

  /**
   * Create an Express middleware that validates incoming requests.
   *
   * @returns An Express middleware function.
   */
  public middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const errors = this.validate(req);

      if (errors.length > 0) {
        log.warn('Request validation failed', {
          method: req.method,
          path: req.path,
          ip: req.ip,
          errors,
        });

        res.status(400).json({
          error: 'Request validation failed',
          details: errors,
        });
        return;
      }

      // Strip unknown/dangerous headers
      this.stripUnknownHeaders(req);

      next();
    };
  }

  /**
   * Validate a request and return any validation errors.
   *
   * @param req - The Express request to validate.
   * @returns An array of validation errors (empty if valid).
   */
  public validate(req: Request): ValidationError[] {
    const errors: ValidationError[] = [];

    // 1. URL length check
    this.validateUrlLength(req, errors);

    // 2. Query parameter count
    this.validateQueryParamCount(req, errors);

    // 3. Query parameter types
    this.validateQueryParamTypes(req, errors);

    // 4. Required headers
    this.validateRequiredHeaders(req, errors);

    // Skip body-related checks for non-body methods
    if (!BODY_METHODS.has(req.method)) {
      return errors;
    }

    // 5. Content-Type
    this.validateContentType(req, errors);

    // 6. Content-Length / payload size
    this.validatePayloadSize(req, errors);

    // 7. JSON structure (if applicable)
    if (this.config.validateJsonStructure && this.isJsonRequest(req)) {
      this.validateJsonBody(req, errors);
    }

    return errors;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Individual Validators
  // ─────────────────────────────────────────────────────────────────────────

  private validateUrlLength(req: Request, errors: ValidationError[]): void {
    const fullUrl = req.originalUrl || req.url;
    if (fullUrl.length > this.config.maxUrlLength) {
      errors.push({
        field: 'url',
        message: `URL length ${fullUrl.length} exceeds maximum ${this.config.maxUrlLength}`,
        value: fullUrl.slice(0, 100) + '...',
      });
    }
  }

  private validateContentType(req: Request, errors: ValidationError[]): void {
    const contentType = req.headers['content-type'];
    if (!contentType) {
      // Missing Content-Type for body methods
      errors.push({
        field: 'Content-Type',
        message: 'Content-Type header is required for request bodies',
      });
      return;
    }

    // Extract the MIME type (strip charset and boundary parameters)
    const mimeType = contentType.split(';')[0]?.trim().toLowerCase();
    if (!mimeType) {
      errors.push({
        field: 'Content-Type',
        message: 'Malformed Content-Type header',
        value: contentType.slice(0, 100),
      });
      return;
    }

    const isAllowed = this.config.allowedContentTypes.some((allowed) => {
      return mimeType === allowed.toLowerCase();
    });

    if (!isAllowed) {
      errors.push({
        field: 'Content-Type',
        message: `Content-Type "${mimeType}" is not allowed. Allowed: ${this.config.allowedContentTypes.join(', ')}`,
        value: mimeType,
      });
    }
  }

  private validatePayloadSize(req: Request, errors: ValidationError[]): void {
    const contentLength = req.headers['content-length'];

    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (Number.isNaN(size) || size < 0) {
        errors.push({
          field: 'Content-Length',
          message: 'Invalid Content-Length header value',
          value: contentLength,
        });
        return;
      }

      if (size > this.config.maxPayloadSize) {
        errors.push({
          field: 'Content-Length',
          message: `Payload size ${size} exceeds maximum ${this.config.maxPayloadSize} bytes`,
          value: String(size),
        });
      }
    }

    // Also check the actual body if it's been parsed
    if (req.body !== undefined && req.body !== null) {
      let bodySize: number;
      if (typeof req.body === 'string') {
        bodySize = Buffer.byteLength(req.body, 'utf8');
      } else if (Buffer.isBuffer(req.body)) {
        bodySize = req.body.length;
      } else {
        // Estimate JSON body size
        try {
          bodySize = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
        } catch {
          bodySize = 0; // Can't estimate; will be caught by JSON validation
        }
      }

      if (bodySize > this.config.maxPayloadSize) {
        errors.push({
          field: 'body',
          message: `Actual body size ${bodySize} exceeds maximum ${this.config.maxPayloadSize} bytes`,
          value: String(bodySize),
        });
      }
    }
  }

  private validateJsonBody(req: Request, errors: ValidationError[]): void {
    if (req.body === undefined || req.body === null) return;

    // Validate structure (depth and key count)
    const keyCount = { value: 0 };
    const depthCheck = this.checkJsonDepth(req.body, 0, keyCount);

    if (depthCheck.tooDeep) {
      errors.push({
        field: 'body',
        message: `JSON nesting depth ${depthCheck.maxDepthSeen} exceeds maximum ${this.config.maxJsonDepth}`,
      });
    }

    if (keyCount.value > this.config.maxJsonKeys) {
      errors.push({
        field: 'body',
        message: `JSON key count ${keyCount.value} exceeds maximum ${this.config.maxJsonKeys}`,
      });
    }
  }

  private validateRequiredHeaders(req: Request, errors: ValidationError[]): void {
    for (const header of this.config.requiredHeaders) {
      const normalized = header.toLowerCase();
      if (!req.headers[normalized]) {
        errors.push({
          field: header,
          message: `Required header "${header}" is missing`,
        });
      }
    }
  }

  private validateQueryParamCount(req: Request, errors: ValidationError[]): void {
    const paramCount = Object.keys(req.query).length;
    if (paramCount > this.config.maxQueryParams) {
      errors.push({
        field: 'query',
        message: `Query parameter count ${paramCount} exceeds maximum ${this.config.maxQueryParams}`,
      });
    }
  }

  private validateQueryParamTypes(req: Request, errors: ValidationError[]): void {
    for (const [param, expectedType] of Object.entries(this.config.queryParamSchema)) {
      const value = req.query[param];
      if (value === undefined) continue; // Not present, skip (use requiredHeaders for required params)

      // Express query values are always strings or arrays of strings
      const strValue = Array.isArray(value) ? String(value[0]) : String(value);

      if (!this.validateParamType(strValue, expectedType)) {
        errors.push({
          field: `query.${param}`,
          message: `Query parameter "${param}" must be a valid ${expectedType}`,
          value: strValue.slice(0, 100),
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  private stripUnknownHeaders(req: Request): void {
    for (const header of this.config.stripHeaders) {
      const normalized = header.toLowerCase();
      if (req.headers[normalized]) {
        delete req.headers[normalized];
      }
    }
  }

  private isJsonRequest(req: Request): boolean {
    const contentType = req.headers['content-type'];
    if (!contentType) return false;
    return contentType.toLowerCase().includes('application/json');
  }

  private validateParamType(value: string, type: QueryParamType): boolean {
    switch (type) {
      case 'string':
        return true; // All query values are strings

      case 'number': {
        const num = Number(value);
        return !Number.isNaN(num) && Number.isFinite(num);
      }

      case 'boolean':
        return value === 'true' || value === 'false' || value === '1' || value === '0';

      case 'uuid':
        return UUID_RE.test(value);

      case 'email':
        return EMAIL_RE.test(value);

      default:
        return true;
    }
  }

  private checkJsonDepth(
    value: unknown,
    currentDepth: number,
    keyCount: { value: number },
  ): { tooDeep: boolean; maxDepthSeen: number } {
    if (currentDepth > this.config.maxJsonDepth) {
      return { tooDeep: true, maxDepthSeen: currentDepth };
    }

    if (value === null || value === undefined || typeof value !== 'object') {
      return { tooDeep: false, maxDepthSeen: currentDepth };
    }

    let maxDepthSeen = currentDepth;

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.checkJsonDepth(item, currentDepth + 1, keyCount);
        if (result.tooDeep) return result;
        if (result.maxDepthSeen > maxDepthSeen) maxDepthSeen = result.maxDepthSeen;
      }
    } else {
      const keys = Object.keys(value as Record<string, unknown>);
      keyCount.value += keys.length;

      if (keyCount.value > this.config.maxJsonKeys) {
        return { tooDeep: false, maxDepthSeen };
      }

      for (const key of keys) {
        const result = this.checkJsonDepth(
          (value as Record<string, unknown>)[key],
          currentDepth + 1,
          keyCount,
        );
        if (result.tooDeep) return result;
        if (result.maxDepthSeen > maxDepthSeen) maxDepthSeen = result.maxDepthSeen;
      }
    }

    return { tooDeep: false, maxDepthSeen };
  }
}
