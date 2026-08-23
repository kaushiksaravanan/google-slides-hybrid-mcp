/**
 * @module security/index
 * @description Public API for the security hardening layer.
 *
 * Re-exports all security utilities, classes, and middleware factories
 * from a single entry point.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Input Sanitization
// ─────────────────────────────────────────────────────────────────────────────
export {
  sanitizeString,
  sanitizePresentationId,
  sanitizeMarkdown,
  sanitizeUrl,
  sanitizeEmail,
  sanitizeHtml,
  sanitizeFilename,
  sanitizeJsonPayload,
} from './input-sanitizer.js';

export type { SanitizeStringOptions } from './input-sanitizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Secrets Management
// ─────────────────────────────────────────────────────────────────────────────
export { SecretsManager } from './secrets-manager.js';

export type { EncryptedPayload } from './secrets-manager.js';

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────
export {
  SlidingWindowRateLimiter,
  AdaptiveRateLimiter,
  DDoSProtector,
  DEFAULT_DDOS_CONFIG,
} from './rate-limiter-advanced.js';

export type {
  RateLimitCheckResult,
  SlidingWindowConfig,
  AdaptiveRateLimiterConfig,
  DDoSProtectorConfig,
} from './rate-limiter-advanced.js';

// ─────────────────────────────────────────────────────────────────────────────
// CORS Configuration
// ─────────────────────────────────────────────────────────────────────────────
export { CorsConfig } from './cors-config.js';

export type { CorsPolicy, RouteCorsConfig } from './cors-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// CSRF Protection
// ─────────────────────────────────────────────────────────────────────────────
export {
  generateCsrfToken,
  validateCsrfToken,
  csrfProtection,
  csrfTokenEndpoint,
} from './csrf-protection.js';

export type { CsrfOptions } from './csrf-protection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request Validation
// ─────────────────────────────────────────────────────────────────────────────
export { RequestValidator } from './request-validator.js';

export type {
  RequestValidatorConfig,
  QueryParamType,
  ValidationError,
} from './request-validator.js';
