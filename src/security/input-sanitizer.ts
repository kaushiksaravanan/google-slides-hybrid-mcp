/**
 * @module security/input-sanitizer
 * @description Input sanitization utilities for all user-supplied data.
 *
 * Every string, ID, URL, email, filename, and JSON payload entering the
 * system MUST pass through the appropriate sanitizer before use.
 *
 * Design goals:
 * - Zero external dependencies (no DOMPurify, no sanitize-html).
 * - Defence-in-depth: strip, escape, truncate, normalise.
 * - Prevent XSS, injection, path traversal, and data exfiltration.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security.input-sanitizer');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for generic string sanitization. */
export interface SanitizeStringOptions {
  /** Maximum allowed string length (default 10 000). */
  maxLength?: number;
  /** Strip HTML tags (default true). */
  stripHtml?: boolean;
  /** Escape HTML-significant characters (default true). */
  escapeHtml?: boolean;
  /** Remove null bytes (default true). */
  removeNullBytes?: boolean;
  /** Normalise Unicode to NFC form (default true). */
  normalizeUnicode?: boolean;
  /** Trim leading/trailing whitespace (default true). */
  trim?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_LENGTH = 10_000;
const DEFAULT_MAX_JSON_DEPTH = 10;
const DEFAULT_MAX_JSON_KEYS = 1_000;

/** Google Slides presentation IDs are base64url-safe, typically 44 chars. */
const PRESENTATION_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;

/**
 * Matches common email addresses. This is intentionally permissive to handle
 * real-world addresses while still rejecting obvious junk.
 */
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Characters that are dangerous in filenames across all OSes. */
const UNSAFE_FILENAME_RE = /[<>:"/\\|?*\x00-\x1f]/g;

/** Path traversal patterns. */
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** HTML tag pattern (including self-closing and CDATA). */
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/gi;

/** Matches javascript:, data:, vbscript: URIs in various forms. */
const DANGEROUS_URI_RE = /^\s*(?:javascript|data|vbscript)\s*:/i;

/** Script tags and event handlers. */
const SCRIPT_TAG_RE = /<\s*\/?\s*script[^>]*>/gi;
const EVENT_HANDLER_RE = /\bon\w+\s*=\s*["'][^"']*["']/gi;

// ─────────────────────────────────────────────────────────────────────────────
// HTML Entity Escaping
// ─────────────────────────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
};

const HTML_ESCAPE_RE = /[&<>"'/`]/g;

function escapeHtmlChars(str: string): string {
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeString
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General-purpose string sanitizer.
 *
 * @param input  - The raw user-supplied string.
 * @param options - Fine-grained control over which sanitization steps to apply.
 * @returns The cleaned string.
 */
export function sanitizeString(input: string, options: SanitizeStringOptions = {}): string {
  const {
    maxLength = DEFAULT_MAX_LENGTH,
    stripHtml = true,
    escapeHtml = true,
    removeNullBytes = true,
    normalizeUnicode = true,
    trim = true,
  } = options;

  let result = input;

  // 1. Remove null bytes (often used to bypass WAFs / parsers)
  if (removeNullBytes) {
    result = result.replace(/\0/g, '');
  }

  // 2. Normalise Unicode to NFC (prevents homoglyph attacks and duplicate representations)
  if (normalizeUnicode) {
    result = result.normalize('NFC');
  }

  // 3. Strip HTML tags
  if (stripHtml) {
    result = result.replace(HTML_TAG_RE, '');
  }

  // 4. Escape HTML-significant characters
  if (escapeHtml) {
    result = escapeHtmlChars(result);
  }

  // 5. Trim whitespace
  if (trim) {
    result = result.trim();
  }

  // 6. Truncate to max length
  if (result.length > maxLength) {
    result = result.slice(0, maxLength);
    log.debug('String truncated', { originalLength: input.length, maxLength });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizePresentationId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and sanitize a Google Slides presentation ID.
 *
 * @param id - The raw presentation ID string.
 * @returns The validated ID.
 * @throws {Error} If the ID does not match the expected Google format.
 */
export function sanitizePresentationId(id: string): string {
  const cleaned = id.trim().replace(/\0/g, '');

  if (!PRESENTATION_ID_RE.test(cleaned)) {
    throw new Error(
      `Invalid presentation ID format: expected 10-80 alphanumeric/dash/underscore characters, got "${cleaned.slice(0, 20)}..."`,
    );
  }

  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeMarkdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize markdown content to prevent embedded scripts, dangerous URIs,
 * and HTML injection.
 *
 * @param md - Raw markdown string.
 * @returns Sanitized markdown.
 */
export function sanitizeMarkdown(md: string): string {
  let result = md;

  // Remove null bytes
  result = result.replace(/\0/g, '');

  // Normalise Unicode
  result = result.normalize('NFC');

  // Strip <script> tags
  result = result.replace(SCRIPT_TAG_RE, '');

  // Strip event handler attributes (onclick, onload, etc.)
  result = result.replace(EVENT_HANDLER_RE, '');

  // Remove javascript:, data:, vbscript: URIs in markdown links/images
  // Pattern: [text](javascript:...) or ![alt](data:...)
  result = result.replace(
    /(!?\[[^\]]*\])\(\s*(?:javascript|data|vbscript)\s*:[^)]*\)/gi,
    '$1()',
  );

  // Remove javascript:, data:, vbscript: URIs in raw HTML href/src attributes
  result = result.replace(
    /(?:href|src|action)\s*=\s*["']\s*(?:javascript|data|vbscript)\s*:[^"']*["']/gi,
    'href=""',
  );

  // Remove <iframe>, <object>, <embed>, <applet>, <form> tags
  result = result.replace(/<\s*\/?\s*(?:iframe|object|embed|applet|form|base|meta|link)[^>]*>/gi, '');

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeUrl
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and sanitize a URL. Only HTTP and HTTPS schemes are allowed.
 *
 * @param url - The raw URL string.
 * @returns The validated URL string.
 * @throws {Error} If the URL uses a disallowed scheme or is malformed.
 */
export function sanitizeUrl(url: string): string {
  const cleaned = url.trim().replace(/\0/g, '');

  // Reject dangerous URI schemes before parsing
  if (DANGEROUS_URI_RE.test(cleaned)) {
    throw new Error('URL uses a disallowed scheme (javascript:, data:, vbscript:)');
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(`Malformed URL: "${cleaned.slice(0, 100)}"`);
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL scheme "${parsed.protocol}" is not allowed. Use http: or https:.`);
  }

  // Prevent credentials in URLs
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }

  return parsed.href;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeEmail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalise an email address.
 *
 * @param email - The raw email string.
 * @returns The normalised, validated email (lowercased).
 * @throws {Error} If the email format is invalid.
 */
export function sanitizeEmail(email: string): string {
  const cleaned = email.trim().replace(/\0/g, '').normalize('NFC');

  if (cleaned.length > 254) {
    throw new Error('Email address exceeds maximum length (254 characters).');
  }

  if (!EMAIL_RE.test(cleaned)) {
    throw new Error(`Invalid email format: "${cleaned.slice(0, 50)}"`);
  }

  // Lowercase the domain part (local part is technically case-sensitive per RFC,
  // but virtually all providers treat it as case-insensitive)
  const atIndex = cleaned.lastIndexOf('@');
  const local = cleaned.slice(0, atIndex);
  const domain = cleaned.slice(atIndex + 1).toLowerCase();

  return `${local}@${domain}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeHtml
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip ALL HTML tags from input (DOMPurify-like, zero external dependencies).
 *
 * This is intentionally aggressive: no tags survive. Use this when you need
 * plain text output from potentially-HTML input.
 *
 * @param html - The raw HTML string.
 * @returns Plain text with all tags removed.
 */
export function sanitizeHtml(html: string): string {
  let result = html;

  // Remove null bytes
  result = result.replace(/\0/g, '');

  // Normalise Unicode
  result = result.normalize('NFC');

  // Remove CDATA sections
  result = result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');

  // Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // Remove style and script blocks entirely (content + tags)
  result = result.replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
  result = result.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '');

  // Remove all remaining HTML tags
  result = result.replace(HTML_TAG_RE, '');

  // Decode common HTML entities to plain text
  result = result
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x60;/gi, '`')
    .replace(/&nbsp;/gi, ' ');

  return result.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeFilename
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a filename to prevent path traversal and OS-specific issues.
 *
 * @param name - The raw filename.
 * @returns A safe filename string.
 * @throws {Error} If the resulting filename is empty.
 */
export function sanitizeFilename(name: string): string {
  let cleaned = name;

  // Remove null bytes
  cleaned = cleaned.replace(/\0/g, '');

  // Normalise Unicode
  cleaned = cleaned.normalize('NFC');

  // Reject path traversal attempts
  if (PATH_TRAVERSAL_RE.test(cleaned)) {
    throw new Error('Path traversal detected in filename.');
  }

  // Strip directory components — take only the final segment
  cleaned = cleaned.replace(/^.*[\\/]/, '');

  // Remove unsafe characters
  cleaned = cleaned.replace(UNSAFE_FILENAME_RE, '_');

  // Remove leading dots (hidden files / special files on Unix)
  cleaned = cleaned.replace(/^\.+/, '');

  // Remove trailing dots and spaces (Windows issue)
  cleaned = cleaned.replace(/[\s.]+$/, '');

  // Truncate to 255 chars (filesystem limit)
  cleaned = cleaned.slice(0, 255);

  // Trim
  cleaned = cleaned.trim();

  if (cleaned.length === 0) {
    throw new Error('Filename is empty after sanitization.');
  }

  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeJsonPayload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep-sanitize a JSON-like object.
 *
 * - Recursively sanitizes all string values.
 * - Enforces maximum nesting depth (prevents prototype-pollution-style attacks).
 * - Enforces maximum key count (prevents DoS via huge objects).
 * - Strips `__proto__`, `constructor`, and `prototype` keys.
 *
 * @param obj      - The raw parsed JSON value.
 * @param maxDepth - Maximum nesting depth (default 10).
 * @returns A new deep-sanitized copy of the input.
 */
export function sanitizeJsonPayload(obj: unknown, maxDepth: number = DEFAULT_MAX_JSON_DEPTH): unknown {
  const keyCount = { value: 0 };
  return deepSanitize(obj, 0, maxDepth, keyCount, new WeakSet());
}

/** Dangerous property names that can lead to prototype pollution. */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepSanitize(
  value: unknown,
  depth: number,
  maxDepth: number,
  keyCount: { value: number },
  visited: WeakSet<object>,
): unknown {
  // Primitives
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return null; // NaN, Infinity → null
    }
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeString(value, {
      stripHtml: true,
      escapeHtml: false, // preserve raw text for JSON values
      maxLength: DEFAULT_MAX_LENGTH,
    });
  }

  // Depth guard
  if (depth >= maxDepth) {
    log.warn('JSON payload exceeded max depth, truncating', { maxDepth, depth });
    return '[MAX_DEPTH_EXCEEDED]';
  }

  // Circular reference guard
  if (typeof value === 'object') {
    if (visited.has(value as object)) {
      return '[CIRCULAR]';
    }
    visited.add(value as object);
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item, depth + 1, maxDepth, keyCount, visited));
  }

  // Plain objects
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(value as Record<string, unknown>)) {
      // Skip prototype-pollution keys
      if (PROTO_KEYS.has(key)) {
        log.warn('Stripped dangerous key from JSON payload', { key });
        continue;
      }

      keyCount.value++;
      if (keyCount.value > DEFAULT_MAX_JSON_KEYS) {
        log.warn('JSON payload exceeded max key count', { maxKeys: DEFAULT_MAX_JSON_KEYS });
        break;
      }

      const sanitizedKey = sanitizeString(key, {
        maxLength: 256,
        stripHtml: true,
        escapeHtml: false,
      });

      result[sanitizedKey] = deepSanitize(
        (value as Record<string, unknown>)[key],
        depth + 1,
        maxDepth,
        keyCount,
        visited,
      );
    }

    return result;
  }

  // Functions and symbols are dropped
  return undefined;
}
