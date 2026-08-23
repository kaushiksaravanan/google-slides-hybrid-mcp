/**
 * @module shared/logger
 * @description Winston-based structured logger for the Google Slides Hybrid MCP server.
 *
 * - JSON format in production for machine parsing.
 * - Pretty-printed colourised output in development.
 * - Automatic redaction of sensitive fields (tokens, secrets, passwords).
 * - Child logger factory for per-module context.
 */

import winston from 'winston';

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive Field Redaction
// ─────────────────────────────────────────────────────────────────────────────

/** Field names whose values must never appear in logs. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'accessToken',
  'access_token',
  'token',
  'secret',
  'password',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
]);

/** Placeholder used in place of redacted values. */
const REDACTED = '[REDACTED]';

/**
 * Recursively walk an object and replace sensitive field values with a
 * redaction placeholder.  Returns a **new** object — the original is not
 * mutated.
 *
 * Uses a `WeakSet` to track already-visited objects and safely handle
 * circular references.
 */
function redactSensitive(obj: unknown, visited: WeakSet<object> = new WeakSet()): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj;
  }

  if (Array.isArray(obj)) {
    if (visited.has(obj)) return '[Circular]';
    visited.add(obj);
    return obj.map((item) => redactSensitive(item, visited));
  }

  if (typeof obj === 'object') {
    if (visited.has(obj)) return '[Circular]';
    visited.add(obj);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.has(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactSensitive(value, visited);
      }
    }
    return result;
  }

  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Formats
// ─────────────────────────────────────────────────────────────────────────────

/** Winston format that applies sensitive-field redaction to `info` metadata.
 *  Preserves Symbol properties (used internally by Winston for metadata)
 *  by selectively replacing only own enumerable string-keyed sensitive values
 *  in-place via Object.assign rather than recreating the info object.
 */
const redactionFormat = winston.format((info) => {
  // Iterate only over own enumerable string keys and selectively redact.
  // This preserves all Symbol-keyed properties that Winston uses internally
  // (e.g. Symbol.for('level'), Symbol.for('message'), Symbol.for('splat')).
  const redactedStringKeys: Record<string, unknown> = {};
  for (const key of Object.keys(info)) {
    const value = (info as Record<string, unknown>)[key];
    if (SENSITIVE_FIELDS.has(key)) {
      redactedStringKeys[key] = REDACTED;
    } else if (value !== null && value !== undefined && typeof value === 'object') {
      redactedStringKeys[key] = redactSensitive(value);
    }
    // Primitives that are not sensitive are left as-is (no need to copy).
  }
  Object.assign(info, redactedStringKeys);
  return info;
});

/** Determine the current runtime environment. */
function getEnvironment(): 'production' | 'development' | 'test' {
  const env = process.env['NODE_ENV']?.toLowerCase();
  if (env === 'production') return 'production';
  if (env === 'test') return 'test';
  return 'development';
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the root Winston logger instance.
 *
 * - **production** → JSON to stdout (for structured log aggregators).
 * - **development** → colourised, pretty-printed to stdout.
 * - **test** → silent unless `LOG_LEVEL` is explicitly set.
 */
function buildLogger(): winston.Logger {
  const environment = getEnvironment();
  const level =
    process.env['LOG_LEVEL'] ??
    (environment === 'production'
      ? 'info'
      : environment === 'test'
        ? 'error'
        : 'debug');

  const formats: winston.Logform.Format[] = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    redactionFormat(),
  ];

  if (environment === 'production') {
    formats.push(winston.format.json());
  } else {
    formats.push(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level: lvl, message, module: mod, ...rest }) => {
        const moduleTag = mod ? `[${mod}]` : '';
        const extra = Object.keys(rest).length > 0
          ? ` ${JSON.stringify(rest, null, 2)}`
          : '';
        return `${timestamp} ${lvl} ${moduleTag} ${message}${extra}`;
      }),
    );
  }

  return winston.createLogger({
    level,
    format: winston.format.combine(...formats),
    transports: [
      new winston.transports.Console({
        silent: environment === 'test' && !process.env['LOG_LEVEL'],
      }),
    ],
    // Do not exit on uncaught exceptions — let the process handler decide.
    exitOnError: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton & Child Logger Factory
// ─────────────────────────────────────────────────────────────────────────────

/** The singleton root logger instance. */
export const logger: winston.Logger = buildLogger();

/**
 * Create a child logger that automatically attaches a `module` field
 * to every log entry.  Use this at the top of each module:
 *
 * ```ts
 * import { createLogger } from '../shared/logger.js';
 * const log = createLogger('api.client');
 * log.info('Initialised API client');
 * ```
 *
 * @param moduleName - A dot-separated module identifier (e.g. "api.auth").
 * @returns A child winston logger with the module metadata pre-set.
 */
export function createLogger(moduleName: string): winston.Logger {
  return logger.child({ module: moduleName });
}

/**
 * Convenience: create a log entry and return it as a plain object.
 * Useful for embedding log context in MCP tool error responses.
 */
export function logContext(
  moduleName: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    module: moduleName,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}
