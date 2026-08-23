/**
 * @module events/event-bus
 * @description In-process event bus with wildcard subscriptions, one-shot
 * listeners, `waitFor` promises, and a ring-buffer event history.
 *
 * All handlers execute asynchronously and are isolated — a failure in one
 * handler never prevents other handlers from executing or blocks the
 * `emit()` caller.
 *
 * ```ts
 * import { eventBus } from './event-bus.js';
 *
 * eventBus.on('presentation.created', async (event) => {
 *   console.log('New presentation:', event.data);
 * });
 *
 * eventBus.emit({
 *   id: crypto.randomUUID(),
 *   type: 'presentation.created',
 *   timestamp: new Date(),
 *   data: { presentationId: 'abc123' },
 *   metadata: { source: 'api', version: '1.0.0' },
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { EventType, SystemEvent, EventHandler } from './types.js';

const log = createLogger('events.bus');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Wildcard token that matches every event type. */
const WILDCARD = '*' as const;

/** Maximum number of events retained in the ring-buffer history. */
const MAX_HISTORY = 1000;

/** Default timeout (ms) for {@link EventBus.waitFor}. */
const DEFAULT_WAIT_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// EventBus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-process publish/subscribe event bus.
 *
 * Features:
 * - Typed event subscriptions via {@link on}, {@link once}, {@link off}.
 * - Wildcard (`*`) subscriptions that receive every event.
 * - {@link waitFor} returns a `Promise` that resolves on the next matching event.
 * - Ring-buffer history of the last {@link MAX_HISTORY} events.
 * - Fully async, error-isolated handler execution.
 */
export class EventBus {
  /** Map of event type (or wildcard) -> set of handlers. */
  private readonly handlers = new Map<string, Set<EventHandler>>();

  /** Ring buffer of recent events. */
  private readonly history: SystemEvent[] = [];

  /** Pointer into the ring buffer (next write position). */
  private historyIndex = 0;

  /** Whether the ring buffer has wrapped around at least once. */
  private historyFull = false;

  // ── Subscription API ────────────────────────────────────────────────────

  /**
   * Subscribe to an event type.
   *
   * @param eventType - A specific {@link EventType} or `'*'` for all events.
   * @param handler   - Async (or sync) handler function.
   */
  on(eventType: EventType | '*', handler: EventHandler): void {
    const key = eventType as string;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    log.debug('Handler subscribed', { eventType });
  }

  /**
   * Unsubscribe a previously registered handler.
   *
   * @returns `true` if the handler was found and removed.
   */
  off(eventType: EventType | '*', handler: EventHandler): boolean {
    const set = this.handlers.get(eventType as string);
    if (!set) return false;
    const removed = set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(eventType as string);
    }
    if (removed) {
      log.debug('Handler unsubscribed', { eventType });
    }
    return removed;
  }

  /**
   * Subscribe for exactly one event.  The handler is automatically removed
   * after its first invocation.
   */
  once(eventType: EventType | '*', handler: EventHandler): void {
    const wrapper: EventHandler = async (event) => {
      this.off(eventType, wrapper);
      await handler(event);
    };
    this.on(eventType, wrapper);
  }

  /**
   * Return a `Promise` that resolves with the next event of the given type.
   *
   * @param eventType - The event type to wait for.
   * @param timeoutMs - Maximum wait time in milliseconds (default 30 s).
   *                     Pass `0` or `Infinity` to wait indefinitely.
   * @throws If the timeout elapses before an event fires.
   */
  waitFor<T = unknown>(
    eventType: EventType,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT,
  ): Promise<SystemEvent<T>> {
    return new Promise<SystemEvent<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const handler: EventHandler = (event) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(event as SystemEvent<T>);
      };

      this.once(eventType, handler);

      if (timeoutMs > 0 && timeoutMs < Infinity) {
        timer = setTimeout(() => {
          this.off(eventType, handler);
          reject(new Error(`waitFor('${eventType}') timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  // ── Emit ────────────────────────────────────────────────────────────────

  /**
   * Publish an event to all matching subscribers.
   *
   * Handlers are invoked asynchronously.  Errors in individual handlers are
   * caught and logged but do **not** propagate to the caller or affect other
   * handlers.
   */
  emit(event: SystemEvent): void {
    // Store in history ring buffer
    this.pushHistory(event);

    // Collect matching handlers: specific type + wildcard
    const specific = this.handlers.get(event.type as string);
    const wildcard = this.handlers.get(WILDCARD);

    const targets: EventHandler[] = [];
    if (specific) targets.push(...specific);
    if (wildcard) targets.push(...wildcard);

    if (targets.length === 0) {
      log.debug('Event emitted with no subscribers', { type: event.type, id: event.id });
      return;
    }

    log.debug('Dispatching event', { type: event.type, id: event.id, handlerCount: targets.length });

    // Fire all handlers concurrently; isolate errors
    for (const handler of targets) {
      // Wrap in an immediately-invoked async function so that sync throws
      // are also caught.
      void (async () => {
        try {
          await handler(event);
        } catch (err) {
          log.error('Event handler threw', {
            type: event.type,
            id: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }
  }

  // ── History ─────────────────────────────────────────────────────────────

  /**
   * Retrieve recent events from the ring-buffer history.
   *
   * @param eventType - Filter by event type.  Omit to return all events.
   * @param limit     - Maximum number of events to return (default 50).
   * @returns Events ordered newest-first.
   */
  getHistory(eventType?: EventType, limit: number = 50): SystemEvent[] {
    const all = this.drainHistory();

    const filtered = eventType
      ? all.filter((e) => e.type === eventType)
      : all;

    // newest first
    return filtered.reverse().slice(0, limit);
  }

  /**
   * Total number of events currently stored in the history buffer.
   */
  get historySize(): number {
    return this.historyFull ? MAX_HISTORY : this.historyIndex;
  }

  /**
   * Remove all events from history and reset all handlers.
   * Primarily intended for testing.
   */
  clear(): void {
    this.handlers.clear();
    this.history.length = 0;
    this.historyIndex = 0;
    this.historyFull = false;
    log.debug('EventBus cleared');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Create a fully-populated {@link SystemEvent} with sensible defaults. */
  static createEvent<T = unknown>(
    type: EventType,
    data: T,
    options: {
      tenantId?: string;
      source?: string;
      correlationId?: string;
    } = {},
  ): SystemEvent<T> {
    return {
      id: randomUUID(),
      type,
      tenantId: options.tenantId,
      timestamp: new Date(),
      data,
      metadata: {
        source: options.source ?? 'system',
        correlationId: options.correlationId,
        version: '1.0.0',
      },
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Push an event into the ring buffer. */
  private pushHistory(event: SystemEvent): void {
    if (this.history.length < MAX_HISTORY) {
      this.history.push(event);
    } else {
      this.history[this.historyIndex] = event;
    }
    this.historyIndex = (this.historyIndex + 1) % MAX_HISTORY;
    if (this.historyIndex === 0 && this.history.length >= MAX_HISTORY) {
      this.historyFull = true;
    }
  }

  /**
   * Read all events from the ring buffer in chronological order
   * (oldest → newest).
   */
  private drainHistory(): SystemEvent[] {
    if (!this.historyFull) {
      // Buffer hasn't wrapped; elements 0..historyIndex-1 are in order.
      return this.history.slice(0, this.historyIndex);
    }
    // Buffer has wrapped: the oldest element is at historyIndex.
    return [
      ...this.history.slice(this.historyIndex),
      ...this.history.slice(0, this.historyIndex),
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Global singleton event bus instance. */
export const eventBus = new EventBus();
