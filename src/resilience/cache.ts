/**
 * @module resilience/cache
 * @description Smart caching layer with TTL-based expiration and LRU eviction.
 *
 * Provides a generic `Cache<T>` with true LRU (least-recently-used) eviction
 * when the cache reaches its maximum size, TTL-based per-entry expiration,
 * and a `getOrSet` factory method for transparent cache-through patterns.
 *
 * Also provides specialised caches for presentation data and rendered
 * templates with domain-appropriate TTLs and invalidation semantics.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('resilience.cache');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for a Cache instance. */
export interface CacheConfig {
  /** Maximum number of entries before LRU eviction kicks in. */
  maxSize: number;
  /** Default TTL in milliseconds for entries without an explicit TTL. */
  defaultTtlMs: number;
}

/** Internal entry stored in the cache. */
interface CacheEntry<T> {
  value: T;
  /** Absolute time (ms since epoch) when this entry expires. */
  expiresAt: number;
}

/** Statistics reported by `Cache.getStats()`. */
export interface CacheStats {
  /** Current number of entries (including expired but not yet evicted). */
  size: number;
  /** Maximum allowed entries. */
  maxSize: number;
  /** Total cache hits. */
  hits: number;
  /** Total cache misses. */
  misses: number;
  /** Total evictions (both LRU and TTL). */
  evictions: number;
  /** Hit rate as a number between 0 and 1. */
  hitRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic in-memory cache with TTL expiration and LRU eviction.
 *
 * Implementation notes:
 * - Uses a plain `Map` which preserves insertion order in JS engines.
 *   On every `get` hit we delete and re-insert the entry to move it to
 *   the end (most-recently-used position).  The *first* entry in the
 *   map is therefore always the least-recently-used — O(1) eviction.
 * - TTL expiration is checked lazily on `get`/`has` and eagerly on `set`
 *   when eviction is needed.  A periodic sweep is *not* used to avoid
 *   unnecessary timer overhead.
 */
export class Cache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly config: CacheConfig;

  // Stats tracking
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize ?? 1000,
      defaultTtlMs: config.defaultTtlMs ?? 5 * 60 * 1000, // 5 minutes
    };
  }

  // ── Core API ──────────────────────────────────────────────────────────

  /**
   * Retrieve a value from the cache.
   * Returns `undefined` if the key is absent or expired.
   * On a hit the entry is promoted to most-recently-used.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this._misses++;
      this._evictions++;
      return undefined;
    }

    // Promote to MRU: delete then re-insert at end
    this.store.delete(key);
    this.store.set(key, entry);
    this._hits++;
    return entry.value;
  }

  /**
   * Insert or update a value in the cache.
   *
   * @param key - Cache key.
   * @param value - The value to store.
   * @param ttlMs - Optional per-entry TTL in milliseconds.
   *                Falls back to the cache's `defaultTtlMs`.
   */
  set(key: string, value: T, ttlMs?: number): void {
    // If updating an existing key, remove it first to reset LRU position
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    // Evict if at capacity
    this.evictIfNeeded();

    const expiresAt = Date.now() + (ttlMs ?? this.config.defaultTtlMs);
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Check whether a key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this._evictions++;
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key from the cache.
   * @returns `true` if the key existed, `false` otherwise.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Remove all entries from the cache and reset stats. */
  clear(): void {
    this.store.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Get a cached value or compute it via `factory`, store the result, and
   * return it.  This is the primary cache-through access pattern.
   *
   * @param key - Cache key.
   * @param factory - Async function that produces the value on cache miss.
   * @param ttlMs - Optional per-entry TTL.
   * @returns The cached or freshly-computed value.
   */
  async getOrSet(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  /** Return a snapshot of cache statistics. */
  getStats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      size: this.store.size,
      maxSize: this.config.maxSize,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /** Return all current keys (including potentially expired). */
  keys(): string[] {
    return [...this.store.keys()];
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Evict entries until the cache is below `maxSize`.
   *
   * Strategy:
   * 1. First pass: remove all expired entries (cheap, no data loss).
   * 2. If still over capacity, remove LRU entries (first in iteration order).
   */
  private evictIfNeeded(): void {
    if (this.store.size < this.config.maxSize) return;

    const now = Date.now();

    // First pass: remove expired entries
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        this._evictions++;
      }
      // If we freed enough space, stop early
      if (this.store.size < this.config.maxSize) return;
    }

    // Second pass: LRU eviction — remove from the front of the map
    for (const key of this.store.keys()) {
      if (this.store.size < this.config.maxSize) return;
      this.store.delete(key);
      this._evictions++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation Cache
// ─────────────────────────────────────────────────────────────────────────────

/** TTL constants for presentation data. */
const PRESENTATION_METADATA_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const SLIDE_THUMBNAIL_TTL_MS       = 10 * 60 * 1000;  // 10 minutes
const TEXT_EXTRACTION_TTL_MS       = 5 * 60 * 1000;    // 5 minutes

/**
 * Specialised cache for Google Slides presentation data.
 *
 * Internally manages three separate caches with domain-appropriate TTLs
 * and provides a unified `invalidatePresentation()` method for cache
 * busting after batch updates.
 */
export class PresentationCache {
  /** Presentation metadata (title, slide count, page dimensions). */
  readonly metadata = new Cache<Record<string, unknown>>({
    maxSize: 200,
    defaultTtlMs: PRESENTATION_METADATA_TTL_MS,
  });

  /** Slide thumbnails keyed by `${presentationId}:${slideId}`. */
  readonly thumbnails = new Cache<Buffer | string>({
    maxSize: 500,
    defaultTtlMs: SLIDE_THUMBNAIL_TTL_MS,
  });

  /** Extracted text keyed by `${presentationId}:${slideId}`. */
  readonly textExtractions = new Cache<string>({
    maxSize: 500,
    defaultTtlMs: TEXT_EXTRACTION_TTL_MS,
  });

  // ── Convenience getters / setters ───────────────────────────────────

  getMetadata(presentationId: string): Record<string, unknown> | undefined {
    return this.metadata.get(presentationId);
  }

  setMetadata(presentationId: string, data: Record<string, unknown>): void {
    this.metadata.set(presentationId, data);
  }

  getThumbnail(presentationId: string, slideId: string): Buffer | string | undefined {
    return this.thumbnails.get(`${presentationId}:${slideId}`);
  }

  setThumbnail(presentationId: string, slideId: string, data: Buffer | string): void {
    this.thumbnails.set(`${presentationId}:${slideId}`, data);
  }

  getTextExtraction(presentationId: string, slideId: string): string | undefined {
    return this.textExtractions.get(`${presentationId}:${slideId}`);
  }

  setTextExtraction(presentationId: string, slideId: string, text: string): void {
    this.textExtractions.set(`${presentationId}:${slideId}`, text);
  }

  // ── Invalidation ────────────────────────────────────────────────────

  /**
   * Invalidate all cached data for a specific presentation.
   * Call this after a batchUpdate or any mutation to that presentation.
   */
  invalidatePresentation(presentationId: string): void {
    // Remove metadata
    this.metadata.delete(presentationId);

    // Remove all thumbnails and text extractions for this presentation.
    // We scan keys with the presentation prefix.
    const prefix = `${presentationId}:`;
    for (const key of this.thumbnails.keys()) {
      if (key.startsWith(prefix)) {
        this.thumbnails.delete(key);
      }
    }
    for (const key of this.textExtractions.keys()) {
      if (key.startsWith(prefix)) {
        this.textExtractions.delete(key);
      }
    }

    log.debug('Invalidated presentation cache', { presentationId });
  }

  /** Invalidate all cached data across all presentations. */
  clear(): void {
    this.metadata.clear();
    this.thumbnails.clear();
    this.textExtractions.clear();
    log.debug('Cleared all presentation caches');
  }

  /** Return aggregate stats across all sub-caches. */
  getStats(): Record<string, CacheStats> {
    return {
      metadata: this.metadata.getStats(),
      thumbnails: this.thumbnails.getStats(),
      textExtractions: this.textExtractions.getStats(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Cache
// ─────────────────────────────────────────────────────────────────────────────

/** Default TTL for rendered templates: 15 minutes. */
const TEMPLATE_TTL_MS = 15 * 60 * 1000;

/**
 * Specialised cache for rendered slide templates.
 *
 * Templates are keyed by `${templateId}:${hash(variables)}` so that the
 * same template with different variable bindings are cached separately.
 */
export class TemplateCache {
  private readonly cache = new Cache<Record<string, unknown>>({
    maxSize: 100,
    defaultTtlMs: TEMPLATE_TTL_MS,
  });

  /**
   * Build a cache key from a template ID and its variable bindings.
   * Uses a stable JSON serialisation of the variables as a suffix.
   */
  private buildKey(templateId: string, variables: Record<string, unknown>): string {
    // Sort keys for deterministic hashing
    const sorted = Object.keys(variables)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = variables[k];
        return acc;
      }, {});
    return `${templateId}:${JSON.stringify(sorted)}`;
  }

  get(templateId: string, variables: Record<string, unknown>): Record<string, unknown> | undefined {
    return this.cache.get(this.buildKey(templateId, variables));
  }

  set(
    templateId: string,
    variables: Record<string, unknown>,
    rendered: Record<string, unknown>,
    ttlMs?: number,
  ): void {
    this.cache.set(this.buildKey(templateId, variables), rendered, ttlMs);
  }

  /** Invalidate all cached renderings for a specific template. */
  invalidateTemplate(templateId: string): void {
    const prefix = `${templateId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    log.debug('Invalidated template cache', { templateId });
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): CacheStats {
    return this.cache.getStats();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singletons
// ─────────────────────────────────────────────────────────────────────────────

/** Global presentation cache instance. */
export const presentationCache = new PresentationCache();

/** Global template cache instance. */
export const templateCache = new TemplateCache();
