/**
 * @module auth/session-manager
 * @description Session lifecycle manager with automatic expiration cleanup.
 *
 * Manages creation, validation, refresh, and destruction of authenticated
 * sessions.  Session tokens are generated using `crypto.randomBytes(32)`.
 *
 * Includes an automatic interval-based cleanup of expired sessions to
 * prevent memory leaks in long-running server processes.
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { Session } from './types.js';

const log = createLogger('auth.session-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default session time-to-live: 24 hours in milliseconds. */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Interval for automatic expired session cleanup: 15 minutes. */
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** Number of random bytes used to generate session tokens. */
const TOKEN_BYTES = 32;

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages authenticated sessions with automatic expiration and cleanup.
 *
 * @example
 * ```ts
 * const sessions = new SessionManager();
 * const session = sessions.createSession('tenant-uuid', '192.168.1.1');
 * const validated = sessions.validateSession(session.token);
 * sessions.destroySession(session.token);
 * sessions.dispose(); // Stop cleanup interval
 * ```
 */
export class SessionManager {
  /** Session store keyed by token for O(1) token validation. */
  private readonly sessions: Map<string, Session> = new Map();

  /** Secondary index: session ID → token for lookups by ID. */
  private readonly sessionIdIndex: Map<string, string> = new Map();

  /** Secondary index: tenant ID → Set of tokens for bulk operations. */
  private readonly tenantSessionIndex: Map<string, Set<string>> = new Map();

  /** Session time-to-live in milliseconds. */
  private readonly ttlMs: number;

  /** Handle for the periodic cleanup interval. */
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  /**
   * Create a new SessionManager.
   *
   * @param ttlMs - Session TTL in milliseconds (default 24 hours).
   * @param cleanupIntervalMs - Cleanup interval in ms (default 15 minutes).
   */
  constructor(
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
    cleanupIntervalMs: number = CLEANUP_INTERVAL_MS,
  ) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, cleanupIntervalMs);

    // Allow the Node.js process to exit even if the timer is still active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    log.info('Session manager initialised', {
      ttlMs: this.ttlMs,
      cleanupIntervalMs,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Create a new authenticated session for a tenant.
   *
   * @param tenantId - The tenant UUID.
   * @param ipAddress - Optional client IP address.
   * @param userAgent - Optional client User-Agent string.
   * @returns The newly created {@link Session}.
   */
  public createSession(
    tenantId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Session {
    const now = new Date();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');

    const session: Session = {
      id: crypto.randomUUID(),
      tenantId,
      token,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      createdAt: now,
      lastActivityAt: now,
      ipAddress,
      userAgent,
    };

    // Store in primary index
    this.sessions.set(token, session);

    // Store in ID index
    this.sessionIdIndex.set(session.id, token);

    // Store in tenant index
    const tenantSessions = this.tenantSessionIndex.get(tenantId) ?? new Set();
    tenantSessions.add(token);
    this.tenantSessionIndex.set(tenantId, tenantSessions);

    log.debug('Session created', {
      sessionId: session.id,
      tenantId,
      expiresAt: session.expiresAt.toISOString(),
    });

    return session;
  }

  /**
   * Validate a session token and return the associated session.
   *
   * Returns `null` if the token is unknown or the session has expired.
   * On success, updates the `lastActivityAt` timestamp.
   *
   * @param token - The bearer token to validate.
   * @returns The session if valid, or `null`.
   */
  public validateSession(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    // Check expiry
    if (session.expiresAt.getTime() < Date.now()) {
      log.debug('Session expired during validation', {
        sessionId: session.id,
        tenantId: session.tenantId,
      });
      this.removeSession(token);
      return null;
    }

    // Update activity timestamp
    session.lastActivityAt = new Date();
    return session;
  }

  /**
   * Refresh a session, extending its expiry by the configured TTL.
   *
   * Returns `null` if the token is unknown or already expired.
   *
   * @param token - The bearer token to refresh.
   * @returns The refreshed session, or `null`.
   */
  public refreshSession(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    // Do not refresh already-expired sessions
    if (session.expiresAt.getTime() < Date.now()) {
      this.removeSession(token);
      return null;
    }

    const now = new Date();
    session.expiresAt = new Date(now.getTime() + this.ttlMs);
    session.lastActivityAt = now;

    log.debug('Session refreshed', {
      sessionId: session.id,
      tenantId: session.tenantId,
      newExpiresAt: session.expiresAt.toISOString(),
    });

    return session;
  }

  /**
   * Destroy a single session by token.
   *
   * @param token - The bearer token of the session to destroy.
   * @returns `true` if a session was found and destroyed.
   */
  public destroySession(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;

    this.removeSession(token);
    log.debug('Session destroyed', {
      sessionId: session.id,
      tenantId: session.tenantId,
    });
    return true;
  }

  /**
   * Destroy all sessions belonging to a specific tenant.
   *
   * Useful for forced logout, password change, or tenant deletion.
   *
   * @param tenantId - The tenant UUID.
   * @returns The number of sessions destroyed.
   */
  public destroyAllSessions(tenantId: string): number {
    const tokens = this.tenantSessionIndex.get(tenantId);
    if (!tokens || tokens.size === 0) return 0;

    let count = 0;
    for (const token of tokens) {
      const session = this.sessions.get(token);
      if (session) {
        this.sessionIdIndex.delete(session.id);
      }
      this.sessions.delete(token);
      count++;
    }

    this.tenantSessionIndex.delete(tenantId);
    log.info('All sessions destroyed for tenant', { tenantId, count });
    return count;
  }

  /**
   * Remove all expired sessions from the store.
   *
   * This is called automatically on a timer but can also be invoked
   * manually for immediate cleanup.
   *
   * @returns The number of expired sessions removed.
   */
  public cleanupExpiredSessions(): number {
    const now = Date.now();
    let removed = 0;

    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt.getTime() < now) {
        this.removeSession(token);
        removed++;
      }
    }

    if (removed > 0) {
      log.info('Expired sessions cleaned up', {
        removed,
        remaining: this.sessions.size,
      });
    }

    return removed;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Get the number of active (non-expired) sessions for a tenant.
   *
   * @param tenantId - The tenant UUID.
   * @returns The count of active sessions.
   */
  public getActiveSessionCount(tenantId: string): number {
    const tokens = this.tenantSessionIndex.get(tenantId);
    if (!tokens) return 0;

    const now = Date.now();
    let count = 0;
    for (const token of tokens) {
      const session = this.sessions.get(token);
      if (session && session.expiresAt.getTime() > now) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the total number of sessions currently stored (including expired).
   *
   * @returns The total session count.
   */
  public get sessionCount(): number {
    return this.sessions.size;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Disposal
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Stop the automatic cleanup timer and release resources.
   *
   * Call this when shutting down the server to prevent interval leaks.
   */
  public dispose(): void {
    clearInterval(this.cleanupTimer);
    log.info('Session manager disposed', { remainingSessions: this.sessions.size });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Remove a session from all indices.
   *
   * @param token - The session token to remove.
   */
  private removeSession(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;

    // Remove from primary store
    this.sessions.delete(token);

    // Remove from ID index
    this.sessionIdIndex.delete(session.id);

    // Remove from tenant index
    const tenantSessions = this.tenantSessionIndex.get(session.tenantId);
    if (tenantSessions) {
      tenantSessions.delete(token);
      if (tenantSessions.size === 0) {
        this.tenantSessionIndex.delete(session.tenantId);
      }
    }
  }
}
