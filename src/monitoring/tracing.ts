/**
 * @module monitoring/tracing
 * @description Lightweight distributed tracing with W3C Trace Context format.
 *
 * Provides Span creation, context propagation via `AsyncLocalStorage`, and
 * structured JSON export — all without external dependencies like OpenTelemetry.
 *
 * Key features:
 * - W3C-compatible 128-bit trace IDs and 64-bit span IDs.
 * - Automatic parent-child span linking via `AsyncLocalStorage`.
 * - `withSpan()` helper for wrapping async functions in a span context.
 * - Express middleware factory for creating root request spans.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('monitoring.tracing');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Status of a completed span. */
export type SpanStatus = 'ok' | 'error' | 'unset';

/** An event recorded during the lifetime of a span. */
export interface SpanEvent {
  /** Event name. */
  name: string;
  /** Timestamp of the event (Unix ms). */
  timestamp: number;
  /** Optional key-value attributes on the event. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * A span represents a single unit of work in a distributed trace.
 */
export interface Span {
  /** 128-bit trace ID in W3C hex format (32 hex chars). */
  traceId: string;
  /** 64-bit span ID in hex format (16 hex chars). */
  spanId: string;
  /** Parent span ID, or null for root spans. */
  parentSpanId: string | null;
  /** Human-readable name describing this unit of work. */
  name: string;
  /** Start time as Unix timestamp in milliseconds. */
  startTime: number;
  /** End time as Unix timestamp in milliseconds. Null while in-flight. */
  endTime: number | null;
  /** Key-value attributes attached to this span. */
  attributes: Record<string, string | number | boolean>;
  /** Ordered list of events recorded during this span. */
  events: SpanEvent[];
  /** Final status of the span. */
  status: SpanStatus;
}

/** Options for starting a new span. */
export interface StartSpanOptions {
  /** Override the parent span (otherwise uses the active span from context). */
  parent?: Span | null;
  /** Initial attributes to attach. */
  attributes?: Record<string, string | number | boolean>;
}

/** Callback invoked when a span is ended (exported). */
export type SpanExporter = (span: Span) => void;

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation (W3C Trace Context Compatible)
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a 128-bit trace ID (32 hex characters). */
function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Generate a 64-bit span ID (16 hex characters). */
function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace Context Store
// ─────────────────────────────────────────────────────────────────────────────

/** The `AsyncLocalStorage` instance used to propagate the active span. */
const traceContext = new AsyncLocalStorage<Span>();

// ─────────────────────────────────────────────────────────────────────────────
// Tracer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lightweight tracer that creates spans, manages context propagation, and
 * exports completed spans via pluggable exporters.
 */
export class Tracer {
  private readonly exporters: SpanExporter[] = [];
  /** In-flight spans indexed by spanId. */
  private readonly activeSpans = new Map<string, Span>();
  /** Recently completed spans (ring buffer). */
  private readonly completedSpans: Span[] = [];
  /** Maximum number of completed spans to retain. */
  private readonly maxCompletedSpans: number;

  constructor(options?: { maxCompletedSpans?: number }) {
    this.maxCompletedSpans = options?.maxCompletedSpans ?? 1_000;
  }

  // ── Exporter management ─────────────────────────────────────────────

  /** Register a span exporter callback. */
  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  /** Remove a previously registered exporter. */
  removeExporter(exporter: SpanExporter): void {
    const idx = this.exporters.indexOf(exporter);
    if (idx !== -1) this.exporters.splice(idx, 1);
  }

  // ── Span lifecycle ──────────────────────────────────────────────────

  /**
   * Start a new span.
   *
   * If no parent is specified, the current `AsyncLocalStorage` context is
   * checked for an active span.  If one is found it becomes the parent.
   */
  startSpan(name: string, options?: StartSpanOptions): Span;
  startSpan(name: string, parent?: Span | null, attributes?: Record<string, string | number | boolean>): Span;
  startSpan(
    name: string,
    parentOrOptions?: Span | null | StartSpanOptions,
    maybeAttributes?: Record<string, string | number | boolean>,
  ): Span {
    let parentSpan: Span | null | undefined;
    let attributes: Record<string, string | number | boolean> | undefined;

    if (parentOrOptions && typeof parentOrOptions === 'object' && 'parent' in parentOrOptions) {
      // Options form
      parentSpan = parentOrOptions.parent;
      attributes = parentOrOptions.attributes;
    } else {
      parentSpan = parentOrOptions as Span | null | undefined;
      attributes = maybeAttributes;
    }

    // Fall back to the context-propagated active span
    if (parentSpan === undefined) {
      parentSpan = traceContext.getStore() ?? null;
    }

    const traceId = parentSpan ? parentSpan.traceId : generateTraceId();
    const spanId = generateSpanId();

    const span: Span = {
      traceId,
      spanId,
      parentSpanId: parentSpan ? parentSpan.spanId : null,
      name,
      startTime: Date.now(),
      endTime: null,
      attributes: { ...attributes },
      events: [],
      status: 'unset',
    };

    this.activeSpans.set(spanId, span);
    return span;
  }

  /**
   * End a span, optionally setting its final status.
   *
   * Once ended the span is exported to all registered exporters.
   */
  endSpan(span: Span, status?: SpanStatus): void {
    if (span.endTime !== null) return; // already ended

    span.endTime = Date.now();
    span.status = status ?? (span.status === 'unset' ? 'ok' : span.status);

    this.activeSpans.delete(span.spanId);

    // Store in completed ring buffer
    this.completedSpans.push(span);
    if (this.completedSpans.length > this.maxCompletedSpans) {
      this.completedSpans.shift();
    }

    // Export
    for (const exporter of this.exporters) {
      try {
        exporter(span);
      } catch {
        // Exporter errors must not crash the application
      }
    }
  }

  /** Add an event to an in-flight span. */
  addEvent(
    span: Span,
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }

  /** Set an attribute on a span. */
  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  /** Get the currently active span from AsyncLocalStorage context. */
  getActiveSpan(): Span | null {
    return traceContext.getStore() ?? null;
  }

  /**
   * Run an async function within the context of a new span.
   *
   * The span is automatically ended when the function completes or throws.
   * If the function throws, the span status is set to 'error' and the
   * error is re-thrown.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const span = this.startSpan(name, { attributes });

    return traceContext.run(span, async () => {
      try {
        const result = await fn(span);
        this.endSpan(span, 'ok');
        return result;
      } catch (err) {
        this.addEvent(span, 'exception', {
          'exception.message': err instanceof Error ? err.message : String(err),
          'exception.type': err instanceof Error ? err.constructor.name : 'unknown',
        });
        this.endSpan(span, 'error');
        throw err;
      }
    });
  }

  /**
   * Run a synchronous function within the context of a new span.
   */
  withSpanSync<T>(
    name: string,
    fn: (span: Span) => T,
    attributes?: Record<string, string | number | boolean>,
  ): T {
    const span = this.startSpan(name, { attributes });

    return traceContext.run(span, () => {
      try {
        const result = fn(span);
        this.endSpan(span, 'ok');
        return result;
      } catch (err) {
        this.addEvent(span, 'exception', {
          'exception.message': err instanceof Error ? err.message : String(err),
          'exception.type': err instanceof Error ? err.constructor.name : 'unknown',
        });
        this.endSpan(span, 'error');
        throw err;
      }
    });
  }

  // ── Query ────────────────────────────────────────────────────────────

  /** Get all currently in-flight spans. */
  getActiveSpans(): Span[] {
    return [...this.activeSpans.values()];
  }

  /** Get recently completed spans. */
  getCompletedSpans(): Span[] {
    return [...this.completedSpans];
  }

  /** Find all spans belonging to a given trace ID. */
  getSpansByTraceId(traceId: string): Span[] {
    const result: Span[] = [];
    for (const span of this.activeSpans.values()) {
      if (span.traceId === traceId) result.push(span);
    }
    for (const span of this.completedSpans) {
      if (span.traceId === traceId) result.push(span);
    }
    return result;
  }

  /** Clear completed spans buffer. */
  clearCompletedSpans(): void {
    this.completedSpans.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Span Exporters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Console exporter that writes completed spans as structured JSON log entries.
 */
export function consoleSpanExporter(span: Span): void {
  const durationMs = span.endTime !== null ? span.endTime - span.startTime : null;

  log.info('Span completed', {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    status: span.status,
    durationMs,
    attributes: span.attributes,
    events: span.events.length > 0 ? span.events : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// W3C Trace Context Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a W3C `traceparent` header into trace/span/flags.
 *
 * Format: `{version}-{traceId}-{parentSpanId}-{flags}`
 * Example: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`
 */
export function parseTraceparent(header: string): {
  version: string;
  traceId: string;
  parentSpanId: string;
  flags: string;
} | null {
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, parentSpanId, flags] = parts;
  if (!version || !traceId || !parentSpanId || !flags) return null;

  // Validate lengths
  if (version.length !== 2 || traceId.length !== 32 || parentSpanId.length !== 16 || flags.length !== 2) {
    return null;
  }

  // Validate hex
  const hexPattern = /^[0-9a-f]+$/;
  if (!hexPattern.test(traceId) || !hexPattern.test(parentSpanId)) {
    return null;
  }

  return { version, traceId, parentSpanId, flags };
}

/**
 * Serialise a span to a W3C `traceparent` header value.
 */
export function toTraceparent(span: Span): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express/Connect-compatible request/response types (minimal shape).
 * Using a structural type to avoid importing Express as a hard dependency.
 */
interface MiddlewareRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface MiddlewareResponse {
  statusCode?: number;
  setHeader?(name: string, value: string): void;
  on?(event: string, listener: () => void): void;
}

type NextFunction = (err?: unknown) => void;

/**
 * Create an Express-compatible middleware that wraps each request in a
 * root span. The span is ended automatically when the response finishes.
 *
 * Propagates incoming W3C `traceparent` header if present.
 */
export function createRequestTracer(
  tracer: Tracer,
): (req: MiddlewareRequest, res: MiddlewareResponse, next: NextFunction) => void {
  return (req: MiddlewareRequest, res: MiddlewareResponse, next: NextFunction): void => {
    const method = req.method ?? 'UNKNOWN';
    const url = req.url ?? '/';

    // Check for incoming trace context
    let parentContext: { traceId: string; parentSpanId: string } | null = null;
    const traceparentHeader = req.headers?.['traceparent'];
    if (typeof traceparentHeader === 'string') {
      const parsed = parseTraceparent(traceparentHeader);
      if (parsed) {
        parentContext = { traceId: parsed.traceId, parentSpanId: parsed.parentSpanId };
      }
    }

    const span = tracer.startSpan(`${method} ${url}`, null, {
      'http.method': method,
      'http.url': url,
    });

    // Override trace/parent IDs if propagated from upstream
    if (parentContext) {
      span.traceId = parentContext.traceId;
      span.parentSpanId = parentContext.parentSpanId;
    }

    // Propagate trace context downstream
    if (res.setHeader) {
      res.setHeader('traceparent', toTraceparent(span));
    }

    // End the span when the response finishes
    if (res.on) {
      res.on('finish', () => {
        const statusCode = res.statusCode ?? 0;
        span.attributes['http.status_code'] = statusCode;
        const status: SpanStatus = statusCode >= 400 ? 'error' : 'ok';
        tracer.endSpan(span, status);
      });
    }

    // Run the rest of the middleware chain inside the span context
    traceContext.run(span, () => {
      next();
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global tracer instance pre-configured with the console exporter. */
export const tracer = new Tracer();
tracer.addExporter(consoleSpanExporter);
