/**
 * Security tests — Input sanitizer, SecretsManager, DDoSProtector, SlidingWindowRateLimiter, CSRF, RequestValidator
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sanitizeString,
  sanitizePresentationId,
  sanitizeMarkdown,
  sanitizeUrl,
  sanitizeEmail,
  sanitizeFilename,
  sanitizeHtml,
  sanitizeJsonPayload,
} from '../../security/input-sanitizer.js';
import { SecretsManager } from '../../security/secrets-manager.js';
import { DDoSProtector, SlidingWindowRateLimiter } from '../../security/rate-limiter-advanced.js';
import { generateCsrfToken } from '../../security/csrf-protection.js';
import { RequestValidator } from '../../security/request-validator.js';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeString
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeString', () => {
  it('strips HTML tags', () => {
    expect(sanitizeString('<script>alert("xss")</script>hello')).not.toContain('<script>');
    expect(sanitizeString('<b>bold</b>')).not.toContain('<b>');
  });

  it('escapes special chars', () => {
    const result = sanitizeString('a & b < c > d "e" \'f\'', { stripHtml: false });
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  it('truncates to maxLength', () => {
    const result = sanitizeString('a'.repeat(200), { maxLength: 50 });
    expect(result).toHaveLength(50);
  });

  it('removes null bytes', () => {
    expect(sanitizeString('hello\x00world')).toBe('hello world'.replace(' ', '')); // Just no null byte
    expect(sanitizeString('a\0b')).not.toContain('\0');
  });

  it('trims whitespace', () => {
    expect(sanitizeString('  hello  ')).toBe('hello');
  });

  it('normalises unicode to NFC', () => {
    // Composed vs decomposed é
    const decomposed = 'e\u0301'; // e + combining accent
    const result = sanitizeString(decomposed);
    expect(result).toBe(result.normalize('NFC'));
  });

  it('handles empty string', () => {
    expect(sanitizeString('')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizePresentationId
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizePresentationId', () => {
  it('accepts valid Google Slides ID', () => {
    const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms';
    expect(sanitizePresentationId(id)).toBe(id);
  });

  it('accepts id with underscores and dashes', () => {
    expect(sanitizePresentationId('abc_DEF-123_456')).toBe('abc_DEF-123_456');
  });

  it('rejects id that is too short', () => {
    expect(() => sanitizePresentationId('abc')).toThrow('Invalid presentation ID');
  });

  it('rejects id with special characters', () => {
    expect(() => sanitizePresentationId('abc!@#$%^&*()test')).toThrow();
  });

  it('trims whitespace', () => {
    const id = '1BxiMVs0XRA5nFMdKvBd';
    expect(sanitizePresentationId(`  ${id}  `)).toBe(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeMarkdown
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeMarkdown', () => {
  it('strips script tags', () => {
    expect(sanitizeMarkdown('Hello <script>alert(1)</script> world')).not.toContain('<script');
  });

  it('removes javascript: URLs in markdown links', () => {
    const result = sanitizeMarkdown('[click](javascript:alert(1))');
    expect(result).not.toContain('javascript:');
  });

  it('removes event handler attributes', () => {
    const result = sanitizeMarkdown('<div onclick="alert(1)">test</div>');
    expect(result).not.toContain('onclick');
  });

  it('preserves normal markdown', () => {
    const md = '# Title\n\n- Item 1\n- Item 2\n\n**Bold text**';
    expect(sanitizeMarkdown(md)).toContain('# Title');
    expect(sanitizeMarkdown(md)).toContain('**Bold text**');
  });

  it('removes iframe tags', () => {
    expect(sanitizeMarkdown('<iframe src="evil.com"></iframe>')).not.toContain('<iframe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeUrl', () => {
  it('accepts valid http URL', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
  });

  it('accepts valid https URL', () => {
    expect(sanitizeUrl('https://example.com/path?q=1')).toContain('https://example.com');
  });

  it('rejects javascript: URL', () => {
    expect(() => sanitizeUrl('javascript:alert(1)')).toThrow('disallowed scheme');
  });

  it('rejects data: URL', () => {
    expect(() => sanitizeUrl('data:text/html,<h1>XSS</h1>')).toThrow('disallowed scheme');
  });

  it('rejects ftp: URL', () => {
    expect(() => sanitizeUrl('ftp://files.com/doc')).toThrow('not allowed');
  });

  it('rejects malformed URL', () => {
    expect(() => sanitizeUrl('not a url at all')).toThrow('Malformed');
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() => sanitizeUrl('https://user:pass@example.com')).toThrow('credentials');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeEmail
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeEmail', () => {
  it('accepts valid email', () => {
    expect(sanitizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('lowercases domain', () => {
    expect(sanitizeEmail('user@EXAMPLE.COM')).toBe('user@example.com');
  });

  it('rejects invalid email', () => {
    expect(() => sanitizeEmail('not-an-email')).toThrow('Invalid email');
  });

  it('rejects empty string', () => {
    expect(() => sanitizeEmail('')).toThrow();
  });

  it('rejects overly long email', () => {
    const long = 'a'.repeat(255) + '@test.com';
    expect(() => sanitizeEmail(long)).toThrow('maximum length');
  });

  it('accepts email with plus addressing', () => {
    expect(sanitizeEmail('user+tag@example.com')).toBe('user+tag@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeFilename
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('passes through safe filename', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('prevents path traversal', () => {
    expect(() => sanitizeFilename('../../../etc/passwd')).toThrow('Path traversal');
  });

  it('strips directory components', () => {
    expect(sanitizeFilename('/path/to/file.txt')).toBe('file.txt');
  });

  it('removes unsafe characters', () => {
    const result = sanitizeFilename('file<>:"/\\|?*.txt');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain(':');
  });

  it('removes leading dots', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden');
  });

  it('throws for empty result', () => {
    expect(() => sanitizeFilename('...')).toThrow('empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SecretsManager
// ─────────────────────────────────────────────────────────────────────────────

describe('SecretsManager', () => {
  let secrets: SecretsManager;

  beforeEach(() => {
    secrets = new SecretsManager();
  });

  it('encrypt/decrypt roundtrip succeeds', () => {
    const key = crypto.randomBytes(32);
    const plaintext = 'my-secret-value';
    const encrypted = secrets.encrypt(plaintext, key);
    const decrypted = secrets.decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('decrypt fails with wrong key', () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const encrypted = secrets.encrypt('secret', key1);
    expect(() => secrets.decrypt(encrypted, key2)).toThrow('Decryption failed');
  });

  it('encrypt rejects invalid key length', () => {
    expect(() => secrets.encrypt('x', Buffer.alloc(16))).toThrow('32 bytes');
  });

  it('key derivation is deterministic', () => {
    const salt = crypto.randomBytes(32);
    const k1 = secrets.deriveKey('password', salt);
    const k2 = secrets.deriveKey('password', salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it('different passwords produce different keys', () => {
    const salt = crypto.randomBytes(32);
    const k1 = secrets.deriveKey('password1', salt);
    const k2 = secrets.deriveKey('password2', salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it('hashApiKey produces salt:hash format', () => {
    const hash = secrets.hashApiKey('gshm_testkey123');
    expect(hash).toContain(':');
    const parts = hash.split(':');
    expect(parts).toHaveLength(2);
  });

  it('verifyApiKey succeeds for correct key', () => {
    const key = 'gshm_myapikey';
    const hash = secrets.hashApiKey(key);
    expect(secrets.verifyApiKey(key, hash)).toBe(true);
  });

  it('verifyApiKey fails for wrong key', () => {
    const hash = secrets.hashApiKey('gshm_correct');
    expect(secrets.verifyApiKey('gshm_wrong', hash)).toBe(false);
  });

  it('verifyApiKey fails for malformed hash', () => {
    expect(secrets.verifyApiKey('key', 'nocolon')).toBe(false);
  });

  it('generateSecureToken returns hex string of correct length', () => {
    const token = secrets.generateSecureToken(32);
    expect(token).toHaveLength(64); // 32 bytes = 64 hex
  });

  it('generateSecureToken rejects too-short length', () => {
    expect(() => secrets.generateSecureToken(8)).toThrow('at least 16');
  });

  it('maskSecret hides most of the string', () => {
    expect(secrets.maskSecret('mysecrettoken', 4)).toBe('*********oken');
  });

  it('maskSecret with short string', () => {
    expect(secrets.maskSecret('ab', 4)).toBe('**');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DDoSProtector
// ─────────────────────────────────────────────────────────────────────────────

describe('DDoSProtector', () => {
  let ddos: DDoSProtector;

  beforeEach(() => {
    ddos = new DDoSProtector({
      maxRequestsPerIp: 5,
      ipWindowMs: 60_000,
      blockThreshold: 3,
      blockDurationMs: 60_000,
    });
  });

  afterEach(() => {
    ddos.dispose();
  });

  it('allows requests under the limit', () => {
    const result = ddos.checkRequest('1.1.1.1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks after exceeding limit', () => {
    for (let i = 0; i < 5; i++) ddos.checkRequest('2.2.2.2');
    const result = ddos.checkRequest('2.2.2.2');
    expect(result.allowed).toBe(false);
  });

  it('blocks IP manually', () => {
    ddos.blockIp('3.3.3.3');
    expect(ddos.isBlocked('3.3.3.3')).toBe(true);
    const result = ddos.checkRequest('3.3.3.3');
    expect(result.allowed).toBe(false);
  });

  it('unblocks IP', () => {
    ddos.blockIp('4.4.4.4');
    ddos.unblockIp('4.4.4.4');
    expect(ddos.isBlocked('4.4.4.4')).toBe(false);
  });

  it('whitelisted IPs always pass', () => {
    ddos.addToWhitelist('5.5.5.5');
    for (let i = 0; i < 100; i++) ddos.checkRequest('5.5.5.5');
    expect(ddos.checkRequest('5.5.5.5').allowed).toBe(true);
  });

  it('getBlockedIps returns blocked IPs', () => {
    ddos.blockIp('6.6.6.6');
    const blocked = ddos.getBlockedIps();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.ip).toBe('6.6.6.6');
  });

  it('getMetrics returns correct counts', () => {
    ddos.blockIp('7.7.7.7');
    ddos.addToWhitelist('8.8.8.8');
    const metrics = ddos.getMetrics();
    expect(metrics.blockedIps).toBe(1);
    expect(metrics.whitelistedIps).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlidingWindowRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

describe('SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 });
  });

  afterEach(() => {
    limiter.dispose();
  });

  it('allows requests within the limit', () => {
    expect(limiter.check('k1').allowed).toBe(true);
    expect(limiter.check('k1').allowed).toBe(true);
    expect(limiter.check('k1').allowed).toBe(true);
  });

  it('rejects requests over the limit', () => {
    limiter.check('k2');
    limiter.check('k2');
    limiter.check('k2');
    const result = limiter.check('k2');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('different keys are independent', () => {
    limiter.check('a');
    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('getCurrentCount returns correct count', () => {
    limiter.check('c');
    limiter.check('c');
    expect(limiter.getCurrentCount('c')).toBe(2);
  });

  it('reset clears a key', () => {
    limiter.check('d');
    limiter.check('d');
    limiter.reset('d');
    expect(limiter.getCurrentCount('d')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSRF Token
// ─────────────────────────────────────────────────────────────────────────────

describe('CSRF Token', () => {
  it('generates a 64-char hex token', () => {
    const token = generateCsrfToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique tokens', () => {
    const t1 = generateCsrfToken();
    const t2 = generateCsrfToken();
    expect(t1).not.toBe(t2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RequestValidator
// ─────────────────────────────────────────────────────────────────────────────

describe('RequestValidator', () => {
  let validator: RequestValidator;

  beforeEach(() => {
    validator = new RequestValidator({
      maxPayloadSize: 1024,
      maxUrlLength: 100,
    });
  });

  it('validates clean GET requests', () => {
    const req = {
      method: 'GET',
      originalUrl: '/api/test',
      url: '/api/test',
      headers: {},
      query: {},
    } as any;
    const errors = validator.validate(req);
    expect(errors).toHaveLength(0);
  });

  it('rejects POST without content-type', () => {
    const req = {
      method: 'POST',
      originalUrl: '/api/test',
      url: '/api/test',
      headers: {},
      query: {},
    } as any;
    const errors = validator.validate(req);
    expect(errors.some(e => e.field === 'Content-Type')).toBe(true);
  });

  it('rejects oversized content-length', () => {
    const req = {
      method: 'POST',
      originalUrl: '/api/test',
      url: '/api/test',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      query: {},
    } as any;
    const errors = validator.validate(req);
    expect(errors.some(e => e.field === 'Content-Length')).toBe(true);
  });

  it('rejects too-long URLs', () => {
    const req = {
      method: 'GET',
      originalUrl: '/' + 'a'.repeat(200),
      url: '/' + 'a'.repeat(200),
      headers: {},
      query: {},
    } as any;
    const errors = validator.validate(req);
    expect(errors.some(e => e.field === 'url')).toBe(true);
  });

  it('strips dangerous headers', () => {
    const req = {
      method: 'GET',
      originalUrl: '/test',
      url: '/test',
      headers: { 'x-forwarded-host': 'evil.com' },
      query: {},
    } as any;
    // Call middleware to strip
    const middleware = validator.middleware();
    const res = { status: () => ({ json: () => {} }) } as any;
    const next = () => {};
    middleware(req, res, next);
    expect(req.headers['x-forwarded-host']).toBeUndefined();
  });
});
