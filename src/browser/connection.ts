/**
 * @module browser/connection
 * @description WebSocket server for Chrome extension communication.
 *
 * Creates a WebSocket server that accepts connections from a companion
 * Chrome extension.  The extension acts as the bridge between this MCP
 * server and the real browser tab running Google Slides.
 *
 * Features:
 * - Configurable port (default 9222, from `BrowserConfig.wsPort`)
 * - Promise-based request/response message protocol
 * - Connection health monitoring via ping/pong
 * - Automatic reconnection handling
 * - Event emitter for connection state changes
 * - Port cleanup (kills existing process) before binding
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../shared/logger.js';
import { BrowserConnectionError, createBrowserError } from '../shared/errors.js';
import { DEFAULT_WS_PORT, DEFAULT_BROWSER_TIMEOUT } from '../shared/constants.js';
import { withTimeout } from '../shared/retry.js';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';

const log = createLogger('browser.connection');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Message sent from the MCP server to the Chrome extension. */
export interface OutgoingMessage {
  /** Unique message identifier for correlating responses. */
  id: string;
  /** The action type the extension should execute. */
  type: string;
  /** Action-specific payload data. */
  payload: Record<string, unknown>;
}

/** Message received from the Chrome extension. */
export interface IncomingExtensionMessage {
  /** The message ID this is a response to (correlates with {@link OutgoingMessage.id}). */
  id: string;
  /** Whether the action succeeded. */
  success: boolean;
  /** The result payload on success. */
  result?: unknown;
  /** Error message on failure. */
  error?: string;
}

/** Events emitted by the {@link BrowserConnectionManager}. */
export interface ConnectionEvents {
  /** Fired when a Chrome extension client connects. */
  connected: (info: { remoteAddress: string }) => void;
  /** Fired when the Chrome extension client disconnects. */
  disconnected: (info: { code: number; reason: string }) => void;
  /** Fired when a connection error occurs. */
  error: (error: BrowserConnectionError) => void;
  /** Fired when the connection state changes. */
  stateChange: (state: ConnectionState) => void;
  /** Fired on every incoming message (for debugging/logging). */
  message: (message: IncomingExtensionMessage) => void;
}

/** Possible states of the browser connection. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/** Configuration options for the connection manager. */
export interface ConnectionManagerOptions {
  /** WebSocket server port. Defaults to {@link DEFAULT_WS_PORT}. */
  port: number;
  /** Interval in ms between ping frames. Defaults to 15000. */
  pingIntervalMs: number;
  /** How long to wait for a pong before considering the connection dead. Defaults to 10000. */
  pongTimeoutMs: number;
  /** Default timeout for waiting on a message response. Defaults to {@link DEFAULT_BROWSER_TIMEOUT}. */
  messageTimeoutMs: number;
  /** Maximum reconnection attempts before giving up. Defaults to 10. */
  maxReconnectAttempts: number;
  /** Delay between reconnection attempts in ms. Defaults to 2000. */
  reconnectDelayMs: number;
}

/** Default options for the connection manager. */
const DEFAULT_OPTIONS: ConnectionManagerOptions = {
  port: DEFAULT_WS_PORT,
  pingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  messageTimeoutMs: DEFAULT_BROWSER_TIMEOUT,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 2_000,
};

/** Internal tracker for a pending request waiting for a response. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Maximum number of concurrent pending requests before rejecting new ones. */
const MAX_PENDING_REQUESTS = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Port Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to kill any process currently listening on the given port.
 * This is best-effort; failures are logged but not thrown.
 *
 * @param port - The TCP port to free up.
 * @param killExisting - Whether to actually kill the process. When false
 *   (the default), the function only logs a warning if a process is found.
 */
function killProcessOnPort(port: number, killExisting: boolean = false): void {
  try {
    const platform = process.platform;

    if (platform === 'win32') {
      // Find the PID listening on this port
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5_000 },
      ).trim();

      if (output) {
        // Extract PIDs from all matching lines
        const pids = new Set<string>();
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          // Validate PID is purely numeric to prevent command injection
          if (pid && pid !== '0' && /^\d+$/.test(pid)) {
            pids.add(pid);
          }
        }

        if (!killExisting) {
          if (pids.size > 0) {
            log.warn('Existing process found on port — set killExisting=true to terminate', {
              port,
              pids: [...pids],
            });
          }
          return;
        }

        for (const pid of pids) {
          try {
            execSync(`taskkill /PID ${pid} /F`, { timeout: 5_000 });
            log.info('Killed existing process on port', { port, pid });
          } catch {
            // Process may have already exited
          }
        }
      }
    } else {
      // macOS / Linux
      const output = execSync(
        `lsof -ti tcp:${port}`,
        { encoding: 'utf-8', timeout: 5_000 },
      ).trim();

      if (output) {
        const pids = output.split('\n').filter(Boolean);

        if (!killExisting) {
          // Validate and warn but do not kill
          const validPids = pids.filter((pid) => /^\d+$/.test(pid));
          if (validPids.length > 0) {
            log.warn('Existing process found on port — set killExisting=true to terminate', {
              port,
              pids: validPids,
            });
          }
          return;
        }

        for (const pid of pids) {
          // Validate PID is purely numeric to prevent command injection
          if (!/^\d+$/.test(pid)) {
            log.warn('Skipping non-numeric PID', { pid });
            continue;
          }
          try {
            execSync(`kill -9 ${pid}`, { timeout: 5_000 });
            log.info('Killed existing process on port', { port, pid });
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // No process on the port, or command failed — both are fine
    log.debug('No existing process found on port (or cleanup not needed)', { port });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages the WebSocket connection between the MCP server and the
 * Chrome extension.
 *
 * @example
 * ```ts
 * const conn = new BrowserConnectionManager({ port: 9222 });
 * await conn.start();
 * await conn.waitForConnection(30_000);
 *
 * const snapshot = await conn.sendMessage('snapshot', {});
 * console.log(snapshot);
 *
 * await conn.stop();
 * ```
 */
export class BrowserConnectionManager extends EventEmitter<ConnectionEvents> {
  /** Resolved configuration options. */
  private readonly options: ConnectionManagerOptions;

  /** The underlying WebSocket server instance. */
  private wss: WebSocketServer | null = null;

  /** The currently connected client WebSocket (from the Chrome extension). */
  private client: WebSocket | null = null;

  /** Map of pending request IDs to their resolve/reject handlers. */
  private readonly pending = new Map<string, PendingRequest>();

  /** Current connection state. */
  private _state: ConnectionState = 'disconnected';

  /** Handle for the ping interval timer. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the client is still alive (pong received). */
  private isAlive = false;

  /** Counter for reconnection attempts. */
  private reconnectAttempts = 0;

  /** Handle for the reconnect delay timer. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: Partial<ConnectionManagerOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ── Public Getters ────────────────────────────────────────────────────────

  /** Current connection state. */
  public get state(): ConnectionState {
    return this._state;
  }

  /** Whether a Chrome extension client is currently connected. */
  public get isConnected(): boolean {
    return (
      this._state === 'connected' &&
      this.client !== null &&
      this.client.readyState === WebSocket.OPEN
    );
  }

  /** The port the WebSocket server is (or will be) listening on. */
  public get port(): number {
    return this.options.port;
  }

  // ── State Management ──────────────────────────────────────────────────────

  /**
   * Transition to a new connection state and emit the `stateChange` event.
   *
   * @param newState - The state to transition to.
   */
  private setState(newState: ConnectionState): void {
    const previous = this._state;
    if (previous === newState) return;
    this._state = newState;
    log.info('Connection state changed', { from: previous, to: newState });
    this.emit('stateChange', newState);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the WebSocket server.
   *
   * Kills any existing process on the configured port, then creates a
   * new `WebSocketServer` and begins accepting connections.
   */
  public async start(): Promise<void> {
    if (this.wss) {
      log.warn('WebSocket server is already running');
      return;
    }

    log.info('Starting WebSocket server', { port: this.options.port });

    // Check if something else is holding the port (does not kill by default)
    killProcessOnPort(this.options.port);

    // Small delay to let the OS release the port
    await new Promise((resolve) => setTimeout(resolve, 500));

    return new Promise<void>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.options.port,
          maxPayload: 50 * 1024 * 1024, // 50 MB — screenshots can be large
        });

        this.wss.on('listening', () => {
          log.info('WebSocket server listening', { port: this.options.port });
          this.setState('disconnected');
          resolve();
        });

        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (error: Error) => {
          log.error('WebSocket server error', { error: error.message });
          const browserErr = createBrowserError(
            error,
            `ws://localhost:${this.options.port}`,
          );
          this.emit('error', browserErr);
          // If the server failed to start, reject the promise
          if (!this.wss?.address()) {
            reject(browserErr);
          }
        });

        this.wss.on('close', () => {
          log.info('WebSocket server closed');
          this.setState('closed');
        });
      } catch (error) {
        reject(
          createBrowserError(error, `ws://localhost:${this.options.port}`),
        );
      }
    });
  }

  /**
   * Stop the WebSocket server and clean up all resources.
   */
  public async stop(): Promise<void> {
    log.info('Stopping WebSocket server');

    // Clear timers
    this.stopPingMonitor();
    this.clearReconnectTimer();

    // Reject all pending requests
    this.rejectAllPending(new BrowserConnectionError('Server shutting down'));

    // Close the client connection
    if (this.client) {
      try {
        this.client.close(1000, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown
      }
      this.client = null;
    }

    // Close the server
    if (this.wss) {
      return new Promise<void>((resolve) => {
        this.wss!.close(() => {
          this.wss = null;
          this.setState('closed');
          log.info('WebSocket server stopped');
          resolve();
        });
      });
    }

    this.setState('closed');
  }

  // ── Connection Handling ───────────────────────────────────────────────────

  /**
   * Handle a new WebSocket connection from the Chrome extension.
   *
   * @param ws - The connected WebSocket client.
   * @param req - The underlying HTTP upgrade request.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteAddress = req.socket.remoteAddress ?? 'unknown';
    log.info('Chrome extension connected', { remoteAddress });

    // If there's already a connected client, close the old one
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      log.warn('Replacing existing client connection');
      this.client.close(1000, 'Replaced by new connection');
    }

    this.client = ws;
    this.isAlive = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.setState('connected');
    this.emit('connected', { remoteAddress });

    // Start health monitoring
    this.startPingMonitor();

    // Message handler
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleMessage(data);
    });

    // Pong handler
    ws.on('pong', () => {
      this.isAlive = true;
    });

    // Close handler
    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString('utf-8');
      log.info('Chrome extension disconnected', { code, reason: reasonStr });
      this.stopPingMonitor();
      this.client = null;
      this.setState('disconnected');
      this.emit('disconnected', { code, reason: reasonStr });

      // Reject pending requests
      this.rejectAllPending(
        new BrowserConnectionError(
          `Connection closed (code=${code}, reason=${reasonStr})`,
        ),
      );

      // Attempt reconnection (wait for extension to reconnect)
      if (this._state !== 'closed') {
        this.scheduleReconnectWait();
      }
    });

    // Error handler
    ws.on('error', (error: Error) => {
      log.error('WebSocket client error', { error: error.message });
      this.emit('error', createBrowserError(error));
    });
  }

  /**
   * Parse and handle an incoming message from the Chrome extension.
   *
   * @param rawData - The raw WebSocket message data.
   */
  private handleMessage(rawData: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const text =
        rawData instanceof Buffer
          ? rawData.toString('utf-8')
          : rawData instanceof ArrayBuffer
            ? Buffer.from(rawData).toString('utf-8')
            : Buffer.concat(rawData as Buffer[]).toString('utf-8');

      const message: IncomingExtensionMessage = JSON.parse(text);

      log.debug('Received message', {
        id: message.id,
        success: message.success,
      });

      this.emit('message', message);

      // Resolve the corresponding pending request
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);

        if (message.success) {
          pending.resolve(message.result);
        } else {
          pending.reject(
            new BrowserConnectionError(
              message.error ?? 'Unknown extension error',
            ),
          );
        }
      } else {
        log.debug('Received message with no matching pending request', {
          id: message.id,
        });
      }
    } catch (error) {
      log.error('Failed to parse incoming message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Message Sending ───────────────────────────────────────────────────────

  /**
   * Send a message to the Chrome extension and wait for a response.
   *
   * @param type - The action type the extension should execute.
   * @param payload - Action-specific payload data.
   * @param timeout - Optional timeout override in ms.
   * @returns A promise that resolves with the extension's response payload.
   * @throws {BrowserConnectionError} If not connected or the request times out.
   */
  public async sendMessage(
    type: string,
    payload: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown> {
    if (!this.isConnected || !this.client) {
      throw new BrowserConnectionError(
        'No Chrome extension connected. Ensure the extension is installed and the browser is open.',
        `ws://localhost:${this.options.port}`,
      );
    }

    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new BrowserConnectionError(
        `Too many pending requests (${this.pending.size}). Wait for existing requests to complete before sending more.`,
        `ws://localhost:${this.options.port}`,
      );
    }

    const id = randomUUID();
    const timeoutMs = timeout ?? this.options.messageTimeoutMs;

    const message: OutgoingMessage = { id, type, payload };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrowserConnectionError(
            `Message "${type}" timed out after ${timeoutMs}ms`,
            `ws://localhost:${this.options.port}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.client!.send(JSON.stringify(message), (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              createBrowserError(
                error,
                `ws://localhost:${this.options.port}`,
              ),
            );
          }
        });

        log.debug('Sent message', { id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        throw createBrowserError(
          error,
          `ws://localhost:${this.options.port}`,
        );
      }
    });
  }

  // ── Wait for Connection ───────────────────────────────────────────────────

  /**
   * Wait for a Chrome extension client to connect.
   *
   * @param timeout - Maximum time to wait in ms. Defaults to 60000.
   * @returns A promise that resolves when a client connects.
   * @throws {BrowserConnectionError} If the timeout is reached without a connection.
   */
  public async waitForConnection(timeout = 60_000): Promise<void> {
    if (this.isConnected) {
      return;
    }

    return withTimeout(
      () =>
        new Promise<void>((resolve) => {
          const handler = () => {
            this.off('connected', handler);
            resolve();
          };
          this.on('connected', handler);
        }),
      timeout,
      'Waiting for Chrome extension connection',
    );
  }

  // ── Health Monitoring ─────────────────────────────────────────────────────

  /**
   * Start the ping/pong health monitoring interval.
   * Sends a ping frame every `pingIntervalMs` and checks that a pong
   * was received before the next ping.
   */
  private startPingMonitor(): void {
    this.stopPingMonitor();

    this.pingTimer = setInterval(() => {
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        this.stopPingMonitor();
        return;
      }

      if (!this.isAlive) {
        // No pong received since last ping — connection is dead
        log.warn('No pong received, terminating connection');
        this.client.terminate();
        return;
      }

      this.isAlive = false;
      this.client.ping();
    }, this.options.pingIntervalMs);
  }

  /** Stop the ping/pong health monitoring interval. */
  private stopPingMonitor(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  /**
   * Schedule a reconnection wait period.
   *
   * Since the Chrome extension initiates the connection, "reconnection"
   * here means we wait for the extension to re-connect. If the maximum
   * number of reconnection attempts is reached we give up.
   */
  private scheduleReconnectWait(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      log.warn('Max reconnect attempts reached, giving up', {
        attempts: this.reconnectAttempts,
        max: this.options.maxReconnectAttempts,
      });
      this.emit(
        'error',
        new BrowserConnectionError(
          `Chrome extension did not reconnect after ${this.reconnectAttempts} attempts`,
        ),
      );
      return;
    }

    this.reconnectAttempts++;
    this.setState('reconnecting');
    log.info('Waiting for Chrome extension to reconnect', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.options.maxReconnectAttempts,
      delayMs: this.options.reconnectDelayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      if (!this.isConnected && this._state !== 'closed') {
        this.scheduleReconnectWait();
      }
    }, this.options.reconnectDelayMs);
  }

  /** Clear the reconnect delay timer. */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Pending Request Cleanup ───────────────────────────────────────────────

  /**
   * Reject all pending requests with the given error.
   *
   * @param error - The error to reject each pending request with.
   */
  private rejectAllPending(error: BrowserConnectionError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      log.debug('Rejected pending request', { id });
    }
    this.pending.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Factory
// ─────────────────────────────────────────────────────────────────────────────

/** Lazily-created singleton connection manager. */
let _instance: BrowserConnectionManager | null = null;

/** The options used to create the current singleton, for comparison. */
let _instanceOptions: Partial<ConnectionManagerOptions> | undefined;

/**
 * Get (or create) the singleton {@link BrowserConnectionManager}.
 *
 * If the instance already exists and the provided options differ from those
 * used to create it, the old instance is destroyed and a new one is created
 * with the updated options.
 *
 * @param options - Options to use when creating the manager for the first time.
 * @returns The singleton connection manager instance.
 */
export function getConnectionManager(
  options?: Partial<ConnectionManagerOptions>,
): BrowserConnectionManager {
  if (_instance) {
    // Check if options differ from the existing instance
    if (options && _instanceOptions && optionsDiffer(_instanceOptions, options)) {
      log.warn('Connection manager options differ from existing instance — recreating', {
        previous: _instanceOptions,
        requested: options,
      });
      // Destroy synchronously is not ideal, but we must replace the instance.
      // The caller should await destroyConnectionManager() for a clean teardown.
      _instance.stop().catch((err) => {
        log.warn('Error stopping old connection manager during replacement', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      _instance = new BrowserConnectionManager(options);
      _instanceOptions = options;
    }
  } else {
    _instance = new BrowserConnectionManager(options);
    _instanceOptions = options;
  }
  return _instance;
}

/**
 * Get the existing singleton {@link BrowserConnectionManager} without
 * creating one. Returns `null` if no instance has been created yet.
 */
export function getExistingConnectionManager(): BrowserConnectionManager | null {
  return _instance;
}

/**
 * Check if two option sets differ on any provided key.
 */
function optionsDiffer(
  a: Partial<ConnectionManagerOptions>,
  b: Partial<ConnectionManagerOptions>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ConnectionManagerOptions>;
  for (const key of keys) {
    if (a[key] !== undefined && b[key] !== undefined && a[key] !== b[key]) {
      return true;
    }
  }
  return false;
}

/**
 * Destroy the singleton connection manager and release all resources.
 * After calling this, the next call to {@link getConnectionManager} will
 * create a fresh instance.
 */
export async function destroyConnectionManager(): Promise<void> {
  if (_instance) {
    await _instance.stop();
    _instance = null;
  }
}
