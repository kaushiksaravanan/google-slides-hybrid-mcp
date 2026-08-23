/**
 * @module server/http-transport
 * @description HTTP+SSE transport layer for the MCP server.
 *
 * Implements the MCP {@link Transport} interface over HTTP:
 * - **GET /mcp/sse** — Establishes a Server-Sent Events stream for
 *   server-to-client messages (responses, notifications).
 * - **POST /mcp/message** — Receives client-to-server JSON-RPC messages.
 *
 * Each SSE connection represents one MCP session. The transport manages
 * session lifecycle, request/response correlation, and connection
 * keepalive via periodic pings.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../shared/logger.js';
import { metrics } from './health.js';

const log = createLogger('server.http-transport');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the HTTP+SSE transport. */
export interface HttpSseTransportConfig {
  /** Base path for MCP endpoints (default: "/mcp"). */
  basePath?: string;
  /** Keepalive ping interval in ms (default: 30000). */
  keepaliveIntervalMs?: number;
  /** Maximum number of concurrent SSE sessions (default: 100). */
  maxSessions?: number;
}

/** State of a single SSE session. */
interface SseSession {
  /** Unique session identifier. */
  id: string;
  /** The SSE response object. */
  res: Response;
  /** Whether the session is connected and active. */
  connected: boolean;
  /** Keepalive timer handle. */
  keepaliveTimer: ReturnType<typeof setInterval>;
  /** Timestamp of session creation (ms). */
  createdAt: number;
  /** Timestamp of last activity (ms). */
  lastActivityAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HttpSseTransport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP Transport implementation over HTTP + Server-Sent Events.
 *
 * - Server-to-client messages flow over SSE (GET /mcp/sse).
 * - Client-to-server messages arrive via HTTP POST (POST /mcp/message).
 * - Each SSE connection = one session, identified by session ID in the
 *   query string of the POST endpoint.
 *
 * @example
 * ```ts
 * const transport = new HttpSseTransport({ basePath: '/mcp' });
 * app.use(transport.router);
 * const server = new Server(serverInfo, { capabilities: { tools: {} } });
 * await server.connect(transport);
 * ```
 */
export class HttpSseTransport implements Transport {
  /** Express router with SSE and message endpoints. */
  public readonly router: Router;

  /** Active SSE sessions keyed by session ID. */
  private readonly sessions: Map<string, SseSession> = new Map();

  /** Configuration. */
  private readonly config: Required<HttpSseTransportConfig>;

  /** Whether the transport has been started. */
  private _started = false;

  /** Whether the transport has been closed. */
  private _closed = false;

  /** The session ID of the current "primary" connection (last connected). */
  private _sessionId: string | undefined;

  // ── Transport interface callbacks ────────────────────────────────────
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(config?: HttpSseTransportConfig) {
    this.config = {
      basePath: config?.basePath ?? '/mcp',
      keepaliveIntervalMs: config?.keepaliveIntervalMs ?? 30_000,
      maxSessions: config?.maxSessions ?? 100,
    };

    this.router = Router();
    this.setupRoutes();

    log.info('HTTP+SSE transport created', {
      basePath: this.config.basePath,
      keepaliveIntervalMs: this.config.keepaliveIntervalMs,
      maxSessions: this.config.maxSessions,
    });
  }

  // ── Transport Interface ──────────────────────────────────────────────

  /**
   * The session ID for the transport (most recent SSE connection).
   */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * Start the transport. For HTTP+SSE, routes are already set up — this
   * just marks the transport as ready.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    log.info('HTTP+SSE transport started');
  }

  /**
   * Send a JSON-RPC message to the client over SSE.
   *
   * If `relatedRequestId` is provided, routes to the specific session
   * that originated the request. Otherwise broadcasts to the primary session.
   */
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this._closed) {
      throw new Error('Transport is closed');
    }

    const targetSessionId = options?.relatedRequestId
      ? this.findSessionForRequest(String(options.relatedRequestId))
      : this._sessionId;

    if (!targetSessionId) {
      log.warn('No active session to send message to', {
        messageType: (message as Record<string, unknown>)['method'] ?? 'response',
      });
      return;
    }

    const session = this.sessions.get(targetSessionId);
    if (!session || !session.connected) {
      log.warn('Target session not connected', { sessionId: targetSessionId });
      return;
    }

    this.writeSseEvent(session, 'message', JSON.stringify(message));
    session.lastActivityAt = Date.now();
    metrics.incSseMessagesSent();
  }

  /**
   * Close the transport and disconnect all SSE sessions.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    log.info('Closing HTTP+SSE transport', { activeSessions: this.sessions.size });

    for (const session of this.sessions.values()) {
      this.destroySession(session);
    }
    this.sessions.clear();
    metrics.activeSessions = 0;

    this.onclose?.();
    log.info('HTTP+SSE transport closed');
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Get the number of active SSE sessions.
   */
  public get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get session info for monitoring.
   */
  public getSessionInfo(): Array<{
    id: string;
    connected: boolean;
    createdAt: number;
    lastActivityAt: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      connected: s.connected,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  // ── Route Setup ──────────────────────────────────────────────────────

  /**
   * Set up Express routes for SSE and message endpoints.
   */
  private setupRoutes(): void {
    const basePath = this.config.basePath;

    // GET /mcp/sse — Establish SSE connection
    this.router.get(`${basePath}/sse`, (req: Request, res: Response) => {
      this.handleSseConnection(req, res);
    });

    // POST /mcp/message — Receive JSON-RPC messages from clients
    this.router.post(`${basePath}/message`, (req: Request, res: Response) => {
      void this.handlePostMessage(req, res);
    });

    // GET /mcp/sessions — List active sessions (debug/monitoring)
    this.router.get(`${basePath}/sessions`, (_req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        data: {
          sessions: this.getSessionInfo(),
          count: this.sessions.size,
        },
      });
    });
  }

  // ── SSE Connection Handler ───────────────────────────────────────────

  /**
   * Handle a new SSE connection request.
   */
  private handleSseConnection(_req: Request, res: Response): void {
    if (this._closed) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Transport is shutting down' },
      });
      return;
    }

    if (this.sessions.size >= this.config.maxSessions) {
      log.warn('Max SSE sessions reached', { max: this.config.maxSessions });
      res.status(429).json({
        success: false,
        error: { code: 'TOO_MANY_SESSIONS', message: 'Maximum concurrent sessions reached' },
      });
      return;
    }

    const sessionId = randomUUID();

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
      'X-Session-Id': sessionId,
    });

    // Flush headers immediately
    res.flushHeaders();

    // Create session
    const session: SseSession = {
      id: sessionId,
      res,
      connected: true,
      keepaliveTimer: setInterval(() => {
        this.sendKeepalive(session);
      }, this.config.keepaliveIntervalMs),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this._sessionId = sessionId;
    metrics.activeSessions = this.sessions.size;

    // Send the session endpoint info as the first event
    // The client uses this to know where to POST messages
    const endpoint = `${this.config.basePath}/message?sessionId=${sessionId}`;
    this.writeSseEvent(session, 'endpoint', endpoint);

    log.info('SSE session established', {
      sessionId,
      activeSessions: this.sessions.size,
    });

    // Handle client disconnect
    res.on('close', () => {
      this.handleSessionDisconnect(sessionId);
    });

    res.on('error', (error) => {
      log.error('SSE connection error', {
        sessionId,
        error: error.message,
      });
      this.handleSessionDisconnect(sessionId);
    });
  }

  // ── POST Message Handler ─────────────────────────────────────────────

  /**
   * Handle an incoming POST message from a client.
   */
  private async handlePostMessage(req: Request, res: Response): Promise<void> {
    if (this._closed) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Transport is shutting down' },
      });
      return;
    }

    const sessionId = req.query['sessionId'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION_ID', message: 'sessionId query parameter is required' },
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !session.connected) {
      res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found or disconnected` },
      });
      return;
    }

    // Parse the JSON-RPC message
    const body = req.body as unknown;
    if (!body || typeof body !== 'object') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'Request body must be a JSON-RPC message' },
      });
      return;
    }

    const message = body as JSONRPCMessage;

    // Store the request-to-session mapping for response routing
    const rpcId = (message as Record<string, unknown>)['id'];
    if (rpcId !== undefined) {
      this.requestSessionMap.set(String(rpcId), sessionId);
    }

    session.lastActivityAt = Date.now();

    log.debug('Received JSON-RPC message via POST', {
      sessionId,
      method: (message as Record<string, unknown>)['method'],
      id: rpcId,
    });

    // Acknowledge receipt immediately
    res.status(202).json({ jsonrpc: '2.0', received: true });

    // Dispatch to the MCP server's message handler
    try {
      this.onmessage?.(message);
    } catch (error) {
      log.error('Error processing JSON-RPC message', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /** Map of JSON-RPC request ID -> session ID for response routing. */
  private readonly requestSessionMap: Map<string, string> = new Map();

  /**
   * Find the session that sent a particular request.
   */
  private findSessionForRequest(requestId: string): string | undefined {
    const sessionId = this.requestSessionMap.get(requestId);
    if (sessionId) {
      // Clean up after use (responses are one-shot)
      this.requestSessionMap.delete(requestId);
    }
    return sessionId ?? this._sessionId;
  }

  /**
   * Write an SSE event to a session's response stream.
   */
  private writeSseEvent(session: SseSession, event: string, data: string): void {
    if (!session.connected) return;

    try {
      session.res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch (error) {
      log.error('Failed to write SSE event', {
        sessionId: session.id,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      this.handleSessionDisconnect(session.id);
    }
  }

  /**
   * Send a keepalive ping to prevent connection timeout.
   */
  private sendKeepalive(session: SseSession): void {
    if (!session.connected) return;

    try {
      session.res.write(':keepalive\n\n');
    } catch {
      // Connection likely broken — the 'close' event will handle cleanup
      this.handleSessionDisconnect(session.id);
    }
  }

  /**
   * Handle a session disconnection.
   */
  private handleSessionDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.destroySession(session);
    this.sessions.delete(sessionId);
    metrics.activeSessions = this.sessions.size;

    // Clean up any pending request-to-session mappings for this session
    for (const [reqId, sid] of this.requestSessionMap.entries()) {
      if (sid === sessionId) {
        this.requestSessionMap.delete(reqId);
      }
    }

    // Update primary session if the disconnected one was primary
    if (this._sessionId === sessionId) {
      // Pick the next most recent session, if any
      const remaining = Array.from(this.sessions.values())
        .filter((s) => s.connected)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      this._sessionId = remaining[0]?.id;
    }

    log.info('SSE session disconnected', {
      sessionId,
      remainingSessions: this.sessions.size,
    });
  }

  /**
   * Destroy a session: stop keepalive and end the response.
   */
  private destroySession(session: SseSession): void {
    session.connected = false;
    clearInterval(session.keepaliveTimer);

    try {
      if (!session.res.writableEnded) {
        session.res.end();
      }
    } catch {
      // Already closed — ignore
    }
  }
}
