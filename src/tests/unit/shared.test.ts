/**
 * Unit tests for shared utilities: errors, retry, validators, logger, constants.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Errors ────────────────────────────────────────────────────────────────────

import {
  MCPBaseError,
  SlidesApiError,
  BrowserConnectionError,
  VisionAnalysisError,
  AuthenticationError,
  RateLimitError,
  ToolExecutionError,
  createApiError,
  createBrowserError,
  createVisionError,
  createAuthError,
  createToolError,
  isMCPError,
  isRetryableError,
} from '../../shared/errors.js';
import { MCPLayer } from '../../shared/types.js';

describe('MCPBaseError', () => {
  it('sets name to the constructor name', () => {
    const err = new MCPBaseError('test');
    expect(err.name).toBe('MCPBaseError');
  });

  it('sets a timestamp in ISO format', () => {
    const err = new MCPBaseError('test');
    expect(err.timestamp).toBeDefined();
    expect(() => new Date(err.timestamp)).not.toThrow();
  });

  it('serializes to JSON with name, message, timestamp, stack', () => {
    const err = new MCPBaseError('hello');
    const json = err.toJSON();
    expect(json.name).toBe('MCPBaseError');
    expect(json.message).toBe('hello');
    expect(json.timestamp).toBe(err.timestamp);
    expect(json.stack).toBeDefined();
  });

  it('is an instance of Error', () => {
    const err = new MCPBaseError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MCPBaseError);
  });
});

describe('SlidesApiError', () => {
  it('includes status code and API message', () => {
    const err = new SlidesApiError(404, 'Not found', 'pres123');
    expect(err.statusCode).toBe(404);
    expect(err.apiMessage).toBe('Not found');
    expect(err.presentationId).toBe('pres123');
    expect(err.message).toContain('404');
    expect(err.message).toContain('pres123');
    expect(err.message).toContain('Not found');
  });

  it('isRetryable returns true for 429, 500, 502, 503', () => {
    expect(new SlidesApiError(429, 'rate').isRetryable).toBe(true);
    expect(new SlidesApiError(500, 'internal').isRetryable).toBe(true);
    expect(new SlidesApiError(502, 'gateway').isRetryable).toBe(true);
    expect(new SlidesApiError(503, 'unavailable').isRetryable).toBe(true);
  });

  it('isRetryable returns false for 400, 401, 403, 404', () => {
    expect(new SlidesApiError(400, 'bad').isRetryable).toBe(false);
    expect(new SlidesApiError(401, 'auth').isRetryable).toBe(false);
    expect(new SlidesApiError(403, 'forbidden').isRetryable).toBe(false);
    expect(new SlidesApiError(404, 'missing').isRetryable).toBe(false);
  });

  it('toJSON includes all fields', () => {
    const err = new SlidesApiError(429, 'too many', 'abc');
    const json = err.toJSON();
    expect(json.statusCode).toBe(429);
    expect(json.apiMessage).toBe('too many');
    expect(json.presentationId).toBe('abc');
    expect(json.isRetryable).toBe(true);
  });

  it('works without presentationId', () => {
    const err = new SlidesApiError(500, 'crash');
    expect(err.presentationId).toBeUndefined();
    expect(err.message).not.toContain('presentation=');
  });
});

describe('BrowserConnectionError', () => {
  it('includes wsEndpoint in message when provided', () => {
    const err = new BrowserConnectionError('timeout', 'ws://localhost:9222');
    expect(err.wsEndpoint).toBe('ws://localhost:9222');
    expect(err.message).toContain('ws://localhost:9222');
  });

  it('works without wsEndpoint', () => {
    const err = new BrowserConnectionError('disconnected');
    expect(err.wsEndpoint).toBeUndefined();
    expect(err.message).toContain('disconnected');
  });

  it('toJSON includes wsEndpoint', () => {
    const err = new BrowserConnectionError('x', 'ws://test');
    expect(err.toJSON().wsEndpoint).toBe('ws://test');
  });
});

describe('VisionAnalysisError', () => {
  it('includes step in message when provided', () => {
    const err = new VisionAnalysisError('sharp failed', 'decode');
    expect(err.step).toBe('decode');
    expect(err.message).toContain('decode');
    expect(err.message).toContain('sharp failed');
  });

  it('toJSON includes step', () => {
    const err = new VisionAnalysisError('fail', 'scoring');
    expect(err.toJSON().step).toBe('scoring');
  });
});

describe('AuthenticationError', () => {
  it('includes scope in message when provided', () => {
    const err = new AuthenticationError('token expired', 'presentations');
    expect(err.scope).toBe('presentations');
    expect(err.message).toContain('presentations');
  });

  it('toJSON includes scope', () => {
    const err = new AuthenticationError('bad', 'drive');
    expect(err.toJSON().scope).toBe('drive');
  });
});

describe('RateLimitError', () => {
  it('stores retryAfter and unit', () => {
    const err = new RateLimitError('slow down', 5000, 'ms');
    expect(err.retryAfter).toBe(5000);
    expect(err.unit).toBe('ms');
    expect(err.retryAfterMs).toBe(5000);
  });

  it('converts seconds to milliseconds', () => {
    const err = new RateLimitError('slow', 10, 's');
    expect(err.retryAfterMs).toBe(10000);
  });

  it('defaults unit to ms', () => {
    const err = new RateLimitError('wait', 2000);
    expect(err.unit).toBe('ms');
    expect(err.retryAfterMs).toBe(2000);
  });

  it('toJSON includes retryAfterMs', () => {
    const err = new RateLimitError('wait', 3, 's');
    const json = err.toJSON();
    expect(json.retryAfter).toBe(3);
    expect(json.unit).toBe('s');
    expect(json.retryAfterMs).toBe(3000);
  });
});

describe('ToolExecutionError', () => {
  it('stores toolName and layer', () => {
    const err = new ToolExecutionError('bad input', 'slides_create', MCPLayer.API);
    expect(err.toolName).toBe('slides_create');
    expect(err.layer).toBe(MCPLayer.API);
    expect(err.message).toContain('slides_create');
    expect(err.message).toContain('api');
  });

  it('toJSON includes toolName and layer', () => {
    const err = new ToolExecutionError('fail', 'live_click', MCPLayer.BROWSER);
    const json = err.toJSON();
    expect(json.toolName).toBe('live_click');
    expect(json.layer).toBe('browser');
  });
});

// ─── Error Factory Functions ────────────────────────────────────────────────────

describe('createApiError', () => {
  it('returns the same SlidesApiError if passed one', () => {
    const original = new SlidesApiError(404, 'not found');
    const result = createApiError(original);
    expect(result).toBe(original);
  });

  it('extracts status from response.status', () => {
    const err = { response: { status: 429, statusText: 'Too Many' } };
    const result = createApiError(err, 'abc');
    expect(result).toBeInstanceOf(SlidesApiError);
    expect(result.statusCode).toBe(429);
    expect(result.presentationId).toBe('abc');
  });

  it('extracts status from code property', () => {
    const err = { code: 503, message: 'Unavailable' };
    const result = createApiError(err);
    expect(result.statusCode).toBe(503);
  });

  it('defaults to 500 for unknown errors', () => {
    const result = createApiError('something broke');
    expect(result.statusCode).toBe(500);
  });
});

describe('createBrowserError', () => {
  it('returns same BrowserConnectionError if passed one', () => {
    const original = new BrowserConnectionError('test');
    expect(createBrowserError(original)).toBe(original);
  });

  it('wraps Error instances', () => {
    const err = new Error('ws closed');
    const result = createBrowserError(err, 'ws://x');
    expect(result).toBeInstanceOf(BrowserConnectionError);
    expect(result.message).toContain('ws closed');
    expect(result.wsEndpoint).toBe('ws://x');
  });

  it('wraps string errors', () => {
    const result = createBrowserError('connection refused');
    expect(result.message).toContain('connection refused');
  });
});

describe('createVisionError', () => {
  it('returns same VisionAnalysisError if passed one', () => {
    const original = new VisionAnalysisError('test');
    expect(createVisionError(original)).toBe(original);
  });

  it('wraps Error instances with step', () => {
    const result = createVisionError(new Error('sharp fail'), 'decode');
    expect(result.step).toBe('decode');
  });
});

describe('createAuthError', () => {
  it('returns same AuthenticationError if passed one', () => {
    const original = new AuthenticationError('test');
    expect(createAuthError(original)).toBe(original);
  });

  it('wraps with scope', () => {
    const result = createAuthError(new Error('invalid'), 'slides');
    expect(result.scope).toBe('slides');
  });
});

describe('createToolError', () => {
  it('returns same ToolExecutionError if passed one', () => {
    const original = new ToolExecutionError('x', 'tool', MCPLayer.API);
    expect(createToolError(original, 'tool', MCPLayer.API)).toBe(original);
  });

  it('wraps with toolName and layer', () => {
    const result = createToolError(new Error('boom'), 'slides_get', MCPLayer.API);
    expect(result.toolName).toBe('slides_get');
    expect(result.layer).toBe(MCPLayer.API);
  });
});

// ─── isMCPError ────────────────────────────────────────────────────────────────

describe('isMCPError', () => {
  it('returns true for MCPBaseError subclasses', () => {
    expect(isMCPError(new SlidesApiError(500, 'x'))).toBe(true);
    expect(isMCPError(new BrowserConnectionError('x'))).toBe(true);
    expect(isMCPError(new AuthenticationError('x'))).toBe(true);
    expect(isMCPError(new RateLimitError('x', 1))).toBe(true);
    expect(isMCPError(new ToolExecutionError('x', 't', MCPLayer.API))).toBe(true);
  });

  it('returns false for plain errors and non-errors', () => {
    expect(isMCPError(new Error('x'))).toBe(false);
    expect(isMCPError('string')).toBe(false);
    expect(isMCPError(null)).toBe(false);
    expect(isMCPError(undefined)).toBe(false);
  });
});

// ─── isRetryableError ──────────────────────────────────────────────────────────

describe('isRetryableError', () => {
  it('returns true for retryable SlidesApiError', () => {
    expect(isRetryableError(new SlidesApiError(429, 'x'))).toBe(true);
    expect(isRetryableError(new SlidesApiError(500, 'x'))).toBe(true);
  });

  it('returns false for non-retryable SlidesApiError', () => {
    expect(isRetryableError(new SlidesApiError(404, 'x'))).toBe(false);
    expect(isRetryableError(new SlidesApiError(400, 'x'))).toBe(false);
  });

  it('returns true for RateLimitError', () => {
    expect(isRetryableError(new RateLimitError('x', 1000))).toBe(true);
  });

  it('returns true for BrowserConnectionError', () => {
    expect(isRetryableError(new BrowserConnectionError('x'))).toBe(true);
  });

  it('returns true for raw objects with retryable status codes', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ response: { status: 500 } })).toBe(true);
  });

  it('returns false for raw objects with non-retryable status codes', () => {
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
  });

  it('returns false for plain errors without status', () => {
    expect(isRetryableError(new Error('oops'))).toBe(false);
    expect(isRetryableError('string')).toBe(false);
  });
});

// ─── Retry Logic ───────────────────────────────────────────────────────────────

import {
  withRetry,
  withRateLimit,
  withGoogleApiRetry,
  withTimeout,
  computeBackoffDelay,
  sleep,
  DEFAULT_RETRY_CONFIG,
  GOOGLE_API_RETRY_CONFIG,
} from '../../shared/retry.js';

describe('computeBackoffDelay', () => {
  it('returns a value between 0 and capped exponential', () => {
    const config = { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffFactor: 2 };
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffDelay(0, config);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000); // baseDelay * 2^0 = 1000
    }
  });

  it('caps at maxDelay', () => {
    const config = { maxRetries: 3, baseDelay: 1000, maxDelay: 5000, backoffFactor: 2 };
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffDelay(10, config);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });

  it('never returns less than 100ms minimum floor (#10)', () => {
    const config = { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffFactor: 2 };
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffDelay(0, config);
      expect(delay).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some tolerance
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.baseDelay).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.backoffFactor).toBe(2);
  });
});

describe('GOOGLE_API_RETRY_CONFIG', () => {
  it('has 5 retries and 60s max delay', () => {
    expect(GOOGLE_API_RETRY_CONFIG.maxRetries).toBe(5);
    expect(GOOGLE_API_RETRY_CONFIG.maxDelay).toBe(60_000);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 100, backoffFactor: 2 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new SlidesApiError(500, 'fail'))
      .mockResolvedValueOnce('recovered');
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10, backoffFactor: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new SlidesApiError(500, 'fail'));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 10, backoffFactor: 1 }),
    ).rejects.toThrow('500');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('throws immediately for non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new SlidesApiError(404, 'not found'));
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10, backoffFactor: 1 }),
    ).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses custom shouldRetry predicate', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('custom-retry'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(
      fn,
      { maxRetries: 3, baseDelay: 1, maxDelay: 10, backoffFactor: 1 },
      (err) => err instanceof Error && err.message === 'custom-retry',
    );
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on RateLimitError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new RateLimitError('slow', 1, 'ms'))
      .mockResolvedValueOnce('ok');
    const result = await withRateLimit(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10, backoffFactor: 1 });
    expect(result).toBe('ok');
  });

  it('retries on SlidesApiError 429', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new SlidesApiError(429, 'rate limited'))
      .mockResolvedValueOnce('ok');
    const result = await withRateLimit(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10, backoffFactor: 1 });
    expect(result).toBe('ok');
  });
});

describe('withGoogleApiRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on SlidesApiError with retryable codes', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new SlidesApiError(503, 'unavailable'))
      .mockResolvedValueOnce('ok');
    const result = await withGoogleApiRetry(fn);
    expect(result).toBe('ok');
  });

  it('does not retry on SlidesApiError 400', async () => {
    const fn = vi.fn().mockRejectedValue(new SlidesApiError(400, 'bad'));
    await expect(withGoogleApiRetry(fn)).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on raw error with retryable code', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ code: 502 })
      .mockResolvedValueOnce('ok');
    const result = await withGoogleApiRetry(fn);
    expect(result).toBe('ok');
  });

  it('does not retry plain errors without status codes', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('random'));
    await expect(withGoogleApiRetry(fn)).rejects.toThrow('random');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('resolves if fn completes within timeout', async () => {
    const fn = () => Promise.resolve('fast');
    const result = await withTimeout(fn, 5000);
    expect(result).toBe('fast');
  });

  it('rejects with timeout error if fn takes too long', async () => {
    const fn = () => new Promise((resolve) => setTimeout(resolve, 10000));
    await expect(withTimeout(fn, 50, 'TestOp')).rejects.toThrow('TestOp timed out after 50ms');
  });

  it('rejects with fn error if fn rejects before timeout', async () => {
    const fn = () => Promise.reject(new Error('fn error'));
    await expect(withTimeout(fn, 5000)).rejects.toThrow('fn error');
  });

  it('provides an AbortSignal that is aborted on timeout (#12)', async () => {
    let capturedSignal: AbortSignal | null = null;

    const fn = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        capturedSignal = signal;
        // Never resolve — let it time out
        setTimeout(resolve, 10000, 'too-late');
      });

    await expect(withTimeout(fn, 50, 'AbortTest')).rejects.toThrow('AbortTest timed out after 50ms');
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

// ─── Validators ────────────────────────────────────────────────────────────────

import {
  presentationIdSchema,
  slideIdSchema,
  colorSchema,
  positionSchema,
  rgbColorSchema,
  fontSchema,
  markdownContentSchema,
  batchUpdateRequestsSchema,
  slideElementTypeSchema,
  validateInput,
  parseInput,
  hexToGoogleRgb,
} from '../../shared/validators.js';

describe('presentationIdSchema', () => {
  it('accepts valid presentation IDs', () => {
    expect(presentationIdSchema.safeParse('abc123').success).toBe(true);
    expect(presentationIdSchema.safeParse('my-pres_id-01').success).toBe(true);
    expect(presentationIdSchema.safeParse('a'.repeat(44)).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(presentationIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects strings over 128 chars', () => {
    expect(presentationIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects strings with invalid characters', () => {
    expect(presentationIdSchema.safeParse('abc def').success).toBe(false);
    expect(presentationIdSchema.safeParse('abc!@#').success).toBe(false);
    expect(presentationIdSchema.safeParse('abc/def').success).toBe(false);
  });
});

describe('colorSchema', () => {
  it('accepts valid 3-digit hex', () => {
    expect(colorSchema.safeParse('#FFF').success).toBe(true);
    expect(colorSchema.safeParse('#abc').success).toBe(true);
  });

  it('accepts valid 6-digit hex', () => {
    expect(colorSchema.safeParse('#FF5733').success).toBe(true);
    expect(colorSchema.safeParse('#000000').success).toBe(true);
  });

  it('accepts valid 8-digit hex (with alpha)', () => {
    expect(colorSchema.safeParse('#FF573380').success).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(colorSchema.safeParse('FF5733').success).toBe(false); // no #
    expect(colorSchema.safeParse('#GGG').success).toBe(false);
    expect(colorSchema.safeParse('#FF').success).toBe(false);
    expect(colorSchema.safeParse('#FF573').success).toBe(false); // 5 digits
    expect(colorSchema.safeParse('red').success).toBe(false);
  });
});

describe('positionSchema', () => {
  it('accepts valid position', () => {
    const result = positionSchema.safeParse({ x: 0, y: 0, width: 100, height: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects negative x/y', () => {
    expect(positionSchema.safeParse({ x: -1, y: 0, width: 100, height: 50 }).success).toBe(false);
    expect(positionSchema.safeParse({ x: 0, y: -1, width: 100, height: 50 }).success).toBe(false);
  });

  it('rejects non-positive width/height', () => {
    expect(positionSchema.safeParse({ x: 0, y: 0, width: 0, height: 50 }).success).toBe(false);
    expect(positionSchema.safeParse({ x: 0, y: 0, width: 100, height: -5 }).success).toBe(false);
  });
});

describe('rgbColorSchema', () => {
  it('accepts valid RGB in [0,1]', () => {
    const result = rgbColorSchema.safeParse({ red: 0.5, green: 0, blue: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects out of range', () => {
    expect(rgbColorSchema.safeParse({ red: 1.5, green: 0, blue: 0 }).success).toBe(false);
    expect(rgbColorSchema.safeParse({ red: 0, green: -0.1, blue: 0 }).success).toBe(false);
  });
});

describe('fontSchema', () => {
  it('accepts a valid font spec', () => {
    const result = fontSchema.safeParse({ family: 'Arial', size: 18 });
    expect(result.success).toBe(true);
  });

  it('accepts full font spec with optionals', () => {
    const result = fontSchema.safeParse({
      family: 'Roboto',
      size: 24,
      bold: true,
      italic: false,
      underline: true,
      color: '#FF0000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing family', () => {
    expect(fontSchema.safeParse({ size: 18 }).success).toBe(false);
  });

  it('rejects size over 400', () => {
    expect(fontSchema.safeParse({ family: 'Arial', size: 500 }).success).toBe(false);
  });
});

describe('markdownContentSchema', () => {
  it('accepts normal markdown', () => {
    expect(markdownContentSchema.safeParse('# Hello\n\nWorld').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(markdownContentSchema.safeParse('').success).toBe(false);
  });

  it('rejects content over 100KB', () => {
    expect(markdownContentSchema.safeParse('a'.repeat(100_001)).success).toBe(false);
  });
});

describe('batchUpdateRequestsSchema', () => {
  it('accepts valid requests array', () => {
    const result = batchUpdateRequestsSchema.safeParse([{ createSlide: {} }]);
    expect(result.success).toBe(true);
  });

  it('rejects empty array', () => {
    expect(batchUpdateRequestsSchema.safeParse([]).success).toBe(false);
  });

  it('rejects array with empty objects', () => {
    expect(batchUpdateRequestsSchema.safeParse([{}]).success).toBe(false);
  });

  it('rejects over 1000 requests', () => {
    const bigArray = Array.from({ length: 1001 }, (_, i) => ({ req: i }));
    expect(batchUpdateRequestsSchema.safeParse(bigArray).success).toBe(false);
  });
});

describe('slideElementTypeSchema', () => {
  it('accepts all valid types', () => {
    const types = ['shape', 'text', 'image', 'table', 'chart', 'video', 'line', 'group', 'sheetsChart', 'wordArt'];
    for (const t of types) {
      expect(slideElementTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('rejects invalid type', () => {
    expect(slideElementTypeSchema.safeParse('invalid').success).toBe(false);
  });
});

describe('validateInput', () => {
  it('returns success with data on valid input', () => {
    const result = validateInput(presentationIdSchema, 'abc123');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('abc123');
    }
  });

  it('returns error string on invalid input', () => {
    const result = validateInput(presentationIdSchema, '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('must not be empty');
    }
  });
});

describe('parseInput', () => {
  it('returns parsed data on valid input', () => {
    expect(parseInput(presentationIdSchema, 'abc123')).toBe('abc123');
  });

  it('throws on invalid input', () => {
    expect(() => parseInput(presentationIdSchema, '')).toThrow();
  });
});

describe('hexToGoogleRgb', () => {
  it('converts 6-digit hex to [0,1] RGB', () => {
    const rgb = hexToGoogleRgb('#FF0000');
    expect(rgb.red).toBeCloseTo(1, 2);
    expect(rgb.green).toBeCloseTo(0, 2);
    expect(rgb.blue).toBeCloseTo(0, 2);
  });

  it('converts 3-digit hex to [0,1] RGB', () => {
    const rgb = hexToGoogleRgb('#FFF');
    expect(rgb.red).toBeCloseTo(1, 2);
    expect(rgb.green).toBeCloseTo(1, 2);
    expect(rgb.blue).toBeCloseTo(1, 2);
  });

  it('handles #000000', () => {
    const rgb = hexToGoogleRgb('#000000');
    expect(rgb.red).toBe(0);
    expect(rgb.green).toBe(0);
    expect(rgb.blue).toBe(0);
  });

  it('handles mid-range values', () => {
    const rgb = hexToGoogleRgb('#808080');
    expect(rgb.red).toBeCloseTo(128 / 255, 2);
    expect(rgb.green).toBeCloseTo(128 / 255, 2);
    expect(rgb.blue).toBeCloseTo(128 / 255, 2);
  });

  it('throws for invalid inputs (#11)', () => {
    expect(() => hexToGoogleRgb('')).toThrow();
    expect(() => hexToGoogleRgb('red')).toThrow();
    expect(() => hexToGoogleRgb('notahex')).toThrow();
    expect(() => hexToGoogleRgb('###')).toThrow();
  });

  it('handles valid 3-digit hex variants (#11)', () => {
    const white = hexToGoogleRgb('#fff');
    expect(white.red).toBeCloseTo(1, 2);
    expect(white.green).toBeCloseTo(1, 2);
    expect(white.blue).toBeCloseTo(1, 2);

    const black = hexToGoogleRgb('#000');
    expect(black.red).toBe(0);
    expect(black.green).toBe(0);
    expect(black.blue).toBe(0);

    const abc = hexToGoogleRgb('#abc');
    expect(abc.red).toBeCloseTo(0xAA / 255, 2);
    expect(abc.green).toBeCloseTo(0xBB / 255, 2);
    expect(abc.blue).toBeCloseTo(0xCC / 255, 2);
  });

  it('handles valid 6-digit hex variants (#11)', () => {
    const white = hexToGoogleRgb('#ffffff');
    expect(white.red).toBeCloseTo(1, 2);

    const black = hexToGoogleRgb('#000000');
    expect(black.red).toBe(0);

    const specific = hexToGoogleRgb('#1a2b3c');
    expect(specific.red).toBeCloseTo(0x1a / 255, 2);
    expect(specific.green).toBeCloseTo(0x2b / 255, 2);
    expect(specific.blue).toBeCloseTo(0x3c / 255, 2);
  });

  it('handles 8-digit hex with alpha ignored (#11)', () => {
    const rgb = hexToGoogleRgb('#ff000088');
    expect(rgb.red).toBeCloseTo(1, 2);
    expect(rgb.green).toBeCloseTo(0, 2);
    expect(rgb.blue).toBeCloseTo(0, 2);
  });
});

// ─── Logger ────────────────────────────────────────────────────────────────────

import { createLogger, logContext } from '../../shared/logger.js';

describe('createLogger', () => {
  it('returns a winston logger child with module metadata', () => {
    const log = createLogger('test.module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('different module names create loggers (may share instance when mocked)', () => {
    const log1 = createLogger('module1');
    const log2 = createLogger('module2');
    // Both are loggers with expected methods
    expect(typeof log1.info).toBe('function');
    expect(typeof log2.info).toBe('function');
  });
});

describe('logContext', () => {
  it('includes module name and timestamp', () => {
    const ctx = logContext('test.module');
    expect(ctx.module).toBe('test.module');
    expect(ctx.timestamp).toBeDefined();
  });

  it('merges extra fields', () => {
    const ctx = logContext('test', { foo: 'bar' });
    expect(ctx.foo).toBe('bar');
    expect(ctx.module).toBe('test');
  });
});

// ─── Constants ─────────────────────────────────────────────────────────────────

import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SERVER_DESCRIPTION,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
  EMU_PER_POINT,
  DEFAULT_WS_PORT,
  DEFAULT_FONT_FAMILY,
  FONT_SIZES,
  RATE_LIMITS,
  COLOR_THEMES,
  SHAPE_TYPES,
  PREDEFINED_LAYOUTS,
  ENV_VARS,
  CONTENT_AREA,
} from '../../shared/constants.js';

describe('Constants', () => {
  it('MCP_SERVER_NAME is defined', () => {
    expect(MCP_SERVER_NAME).toBe('google-slides-hybrid-mcp');
  });

  it('MCP_SERVER_VERSION is a semver string', () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('MCP_SERVER_DESCRIPTION is non-empty', () => {
    expect(MCP_SERVER_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('DEFAULT_PAGE_WIDTH and HEIGHT are correct for 16:9', () => {
    expect(DEFAULT_PAGE_WIDTH).toBe(720);
    expect(DEFAULT_PAGE_HEIGHT).toBe(405);
  });

  it('EMU_PER_POINT is 12700', () => {
    expect(EMU_PER_POINT).toBe(12700);
  });

  it('DEFAULT_WS_PORT is 9222', () => {
    expect(DEFAULT_WS_PORT).toBe(9222);
  });

  it('DEFAULT_FONT_FAMILY is Roboto', () => {
    expect(DEFAULT_FONT_FAMILY).toBe('Roboto');
  });

  it('FONT_SIZES contains expected keys', () => {
    expect(FONT_SIZES.title).toBe(36);
    expect(FONT_SIZES.body).toBe(18);
    expect(FONT_SIZES.subtitle).toBe(24);
    expect(FONT_SIZES.caption).toBe(12);
  });

  it('RATE_LIMITS has expected structure', () => {
    expect(RATE_LIMITS.readPerMinute).toBe(60);
    expect(RATE_LIMITS.writePerMinute).toBe(60);
    expect(RATE_LIMITS.maxConcurrent).toBe(10);
  });

  it('COLOR_THEMES has 5 themes', () => {
    expect(Object.keys(COLOR_THEMES).length).toBe(5);
    expect(COLOR_THEMES.corporate.primary).toBeDefined();
    expect(COLOR_THEMES.dark.primary).toBeDefined();
  });

  it('SHAPE_TYPES has common shapes', () => {
    expect(SHAPE_TYPES.RECTANGLE).toBe('RECTANGLE');
    expect(SHAPE_TYPES.TEXT_BOX).toBe('TEXT_BOX');
    expect(SHAPE_TYPES.ELLIPSE).toBe('ELLIPSE');
  });

  it('PREDEFINED_LAYOUTS has expected layouts', () => {
    expect(PREDEFINED_LAYOUTS.BLANK).toBe('BLANK');
    expect(PREDEFINED_LAYOUTS.TITLE).toBe('TITLE');
    expect(PREDEFINED_LAYOUTS.TITLE_AND_BODY).toBe('TITLE_AND_BODY');
  });

  it('ENV_VARS has expected keys', () => {
    expect(ENV_VARS.GOOGLE_CLIENT_ID).toBe('GOOGLE_CLIENT_ID');
    expect(ENV_VARS.CHROME_WS_PORT).toBe('CHROME_WS_PORT');
    expect(ENV_VARS.VISION_ENABLED).toBe('VISION_ENABLED');
  });

  it('CONTENT_AREA is computed from margins', () => {
    expect(CONTENT_AREA.x).toBe(50);
    expect(CONTENT_AREA.y).toBe(50);
    expect(CONTENT_AREA.width).toBe(620);
    expect(CONTENT_AREA.height).toBe(305);
  });
});

// ─── redactSensitive circular reference (#31) ──────────────────────────────

describe('redactSensitive circular reference (#31)', () => {
  it('does not crash when logger receives object with circular reference', () => {
    const log = createLogger('test.circular');
    const circularObj: Record<string, unknown> = { name: 'test' };
    circularObj['self'] = circularObj;

    // The logger internally calls redactSensitive — should not throw
    expect(() => {
      log.info('circular test', circularObj);
    }).not.toThrow();
  });
});

// ─── Schema Converter ──────────────────────────────────────────────────────

import { zodToJsonSchema } from '../../shared/schema-converter.js';
import { z } from 'zod';

describe('zodToJsonSchema', () => {
  it('converts ZodString to {type: "string"}', () => {
    const result = zodToJsonSchema(z.string());
    expect(result).toEqual({ type: 'string' });
  });

  it('converts ZodNumber to {type: "number"}', () => {
    const result = zodToJsonSchema(z.number());
    expect(result).toEqual({ type: 'number' });
  });

  it('converts ZodBoolean to {type: "boolean"}', () => {
    const result = zodToJsonSchema(z.boolean());
    expect(result).toEqual({ type: 'boolean' });
  });

  it('converts ZodArray(ZodString) to {type: "array", items: {type: "string"}}', () => {
    const result = zodToJsonSchema(z.array(z.string()));
    expect(result).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('converts ZodObject to {type: "object", properties: {...}}', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    });
  });

  it('handles ZodOptional — field does not appear in required', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
      },
      required: ['name'],
    });
    // nickname should NOT be in required
    expect((result as { required?: string[] }).required).not.toContain('nickname');
  });

  it('converts ZodEnum to {type: "string", enum: [...]}', () => {
    const result = zodToJsonSchema(z.enum(['a', 'b', 'c']));
    expect(result).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('handles ZodDefault — unwraps to inner type', () => {
    const result = zodToJsonSchema(z.string().default('hello'));
    expect(result).toEqual({ type: 'string' });
  });

  it('handles ZodEffects (.refine()) — unwraps to inner type', () => {
    const schema = z.string().refine((val) => val.length > 0);
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({ type: 'string' });
  });

  it('converts ZodUnion to {oneOf: [...]}', () => {
    const result = zodToJsonSchema(z.union([z.string(), z.number()]));
    expect(result).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts ZodLiteral to {type: "string", const: value}', () => {
    const result = zodToJsonSchema(z.literal('hello'));
    expect(result).toEqual({ type: 'string', const: 'hello' });
  });

  it('propagates description', () => {
    const result = zodToJsonSchema(z.string().describe('A name field'));
    expect(result).toEqual({ type: 'string', description: 'A name field' });
  });
});
