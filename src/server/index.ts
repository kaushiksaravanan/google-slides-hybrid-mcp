/**
 * @module server
 * @description HTTP server entry point and barrel exports for the
 * Google Slides Hybrid MCP server's HTTP+SSE transport layer.
 *
 * Provides a `startServer` function that initializes the orchestrator,
 * creates the Express app, connects the MCP server to the HTTP transport,
 * and starts listening on the configured port.
 *
 * @example
 * ```ts
 * import { startServer } from './server/index.js';
 *
 * const handle = await startServer({
 *   port: 3000,
 *   corsOrigins: ['https://my-app.example.com'],
 * });
 *
 * // Later...
 * await handle.shutdown();
 * ```
 */

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server as HttpServer } from 'node:http';
import { createLogger } from '../shared/logger.js';
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SERVER_DESCRIPTION,
  ENV_VARS,
  DEFAULT_WS_PORT,
} from '../shared/constants.js';
import { ToolExecutionError } from '../shared/errors.js';
import type { HybridConfig } from '../shared/types.js';
import { HybridOrchestrator } from '../orchestrator/orchestrator.js';
import type { LayerStatus } from '../orchestrator/orchestrator.js';
import { createApp } from './app.js';
import type { AppConfig } from './app.js';
import type { Plan } from '../auth/types.js';
import type { PlanRateLimitConfig } from './rate-limiter.js';
import type { TenantManager } from '../auth/tenant-manager.js';
import type { SessionManager } from '../auth/session-manager.js';
import { healthChecker } from '../monitoring/health-checker.js';
import { alertManager } from '../monitoring/alerts.js';

const log = createLogger('server');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for starting the HTTP server. */
export interface ServerConfig {
  /** Port to listen on (default: 3000, or PORT env var). */
  port?: number;

  /** Hostname to bind to (default: '0.0.0.0'). */
  host?: string;

  /** CORS allowed origins (default: ['*']). */
  corsOrigins?: string[];

  /** JSON body size limit (default: '10mb'). */
  bodyLimit?: string;

  /** Enable authentication (default: true). */
  enableAuth?: boolean;

  /** Per-plan rate limit overrides. */
  rateLimits?: Partial<Record<Plan, PlanRateLimitConfig>>;

  /** SSE keepalive interval in ms. */
  sseKeepaliveMs?: number;

  /** Maximum concurrent SSE sessions. */
  maxSseSessions?: number;

  /** Override the hybrid config (otherwise built from env). */
  hybridConfig?: HybridConfig;

  /** Pre-configured TenantManager (for shared state with container). */
  tenantManager?: TenantManager;

  /** Pre-configured SessionManager (for shared state with container). */
  sessionManager?: SessionManager;
}

/** Handle returned by startServer for lifecycle management. */
export interface ServerHandle {
  /** The Node.js HTTP server instance. */
  httpServer: HttpServer;

  /** The MCP server instance. */
  mcpServer: McpServer;

  /** The hybrid orchestrator instance. */
  orchestrator: HybridOrchestrator;

  /** Layer status after initialization. */
  layerStatus: LayerStatus;

  /** The port the server is listening on. */
  port: number;

  /** The host the server is bound to. */
  host: string;

  /** Gracefully shut down the server and all subsystems. */
  shutdown: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Config from Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the hybrid configuration from environment variables.
 */
function buildHybridConfig(): HybridConfig {
  const wsPort = parseInt(process.env[ENV_VARS.CHROME_WS_PORT] ?? '', 10);
  const visionEnabled = (process.env[ENV_VARS.VISION_ENABLED] ?? 'true').toLowerCase();
  const visionAutoFix = (process.env[ENV_VARS.VISION_AUTO_FIX] ?? 'false').toLowerCase();

  return {
    api: {
      clientId: process.env[ENV_VARS.GOOGLE_CLIENT_ID] ?? '',
      clientSecret: process.env[ENV_VARS.GOOGLE_CLIENT_SECRET] ?? '',
      refreshToken: process.env[ENV_VARS.GOOGLE_REFRESH_TOKEN] ?? '',
    },
    browser: {
      wsPort: Number.isFinite(wsPort) && wsPort > 0 ? wsPort : DEFAULT_WS_PORT,
      screenshotFormat: 'png',
      timeout: 30_000,
    },
    vision: {
      enabled: visionEnabled === 'true' || visionEnabled === '1',
      analysisModel: process.env[ENV_VARS.VISION_MODEL] ?? 'built-in',
      autoFix: visionAutoFix === 'true' || visionAutoFix === '1',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// startServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the orchestrator, create the Express application, wire up the
 * MCP server over HTTP+SSE transport, and start listening.
 *
 * @param config - Server configuration.
 * @returns A {@link ServerHandle} for lifecycle management.
 */
export async function startServer(config?: ServerConfig): Promise<ServerHandle> {
  const port = config?.port ?? parseInt(process.env['PORT'] ?? '3000', 10);
  const host = config?.host ?? '0.0.0.0';

  log.info(`Starting ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} (HTTP+SSE mode)`, {
    port,
    host,
  });
  log.info(MCP_SERVER_DESCRIPTION);

  // ── 1. Initialize Orchestrator ────────────────────────────────────────

  const hybridConfig = config?.hybridConfig ?? buildHybridConfig();
  const orchestrator = new HybridOrchestrator(hybridConfig);

  let layerStatus: LayerStatus;
  try {
    layerStatus = await orchestrator.initialize();
  } catch (error) {
    log.error('Fatal: Orchestrator initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const availableTools = orchestrator.getAvailableTools();
  log.info(`Registered ${availableTools.length} tools across active layers`);

  // ── 2. Create Express App ──────────────────────────────────────────────

  const appConfig: AppConfig = {
    corsOrigins: config?.corsOrigins,
    bodyLimit: config?.bodyLimit,
    enableAuth: config?.enableAuth,
    rateLimits: config?.rateLimits,
    sseKeepaliveMs: config?.sseKeepaliveMs,
    maxSseSessions: config?.maxSseSessions,
    tenantManager: config?.tenantManager,
    sessionManager: config?.sessionManager,
    readinessCheck: async () => {
      const status = await orchestrator.getLayerStatus();
      return {
        ready: status.api.available, // At minimum, API layer should be up
        checks: {
          api: {
            status: status.api.available ? 'ok' : 'error',
            message: status.api.available ? 'Authenticated' : (status.api.error ?? 'Not initialized'),
          },
          browser: {
            status: status.browser.available
              ? (status.browser.connected ? 'ok' : 'degraded')
              : 'error',
            message: status.browser.available
              ? (status.browser.connected ? 'Connected' : 'Waiting for extension')
              : (status.browser.error ?? 'Not available'),
          },
          vision: {
            status: status.vision.available ? 'ok' : (status.vision.enabled ? 'error' : 'ok'),
            message: status.vision.available
              ? 'Available'
              : (status.vision.enabled ? (status.vision.error ?? 'Not available') : 'Disabled'),
          },
        },
      };
    },
  };

  const appCtx = createApp(orchestrator, appConfig);

  // ── 3. Create MCP Server & Wire to HTTP Transport ─────────────────────

  const mcpServer = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register ListTools handler
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = orchestrator.getAvailableTools();
    log.debug('ListTools request (HTTP)', { toolCount: tools.length });
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Register CallTool handler
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.info('CallTool request (HTTP)', { toolName: name });

    try {
      const result = await orchestrator.executeToolAuto(name, args ?? {});
      return {
        content: result.content.map((c) => {
          if (c.type === 'image') {
            return {
              type: 'image' as const,
              data: c.data ?? '',
              mimeType: c.mimeType ?? 'image/png',
            };
          }
          return {
            type: 'text' as const,
            text: c.text ?? '',
          };
        }),
        isError: result.isError ?? false,
      };
    } catch (error) {
      const message = error instanceof ToolExecutionError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

      log.error('Tool execution error (HTTP)', { toolName: name, error: message });
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server to HTTP+SSE transport
  await mcpServer.connect(appCtx.transport);
  log.info('MCP server connected to HTTP+SSE transport');

  // ── 4. Start HTTP Server ──────────────────────────────────────────────

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = appCtx.app.listen(port, host, () => {
      resolve(server);
    });
    server.on('error', reject);
  });

  log.info(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} is running`, {
    transport: 'HTTP+SSE',
    url: `http://${host}:${port}`,
    tools: availableTools.length,
    endpoints: {
      health: `http://${host}:${port}/health`,
      ready: `http://${host}:${port}/ready`,
      metrics: `http://${host}:${port}/metrics`,
      sse: `http://${host}:${port}/mcp/sse`,
      message: `http://${host}:${port}/mcp/message`,
      api: `http://${host}:${port}/api/v1`,
    },
  });

  // ── 4a. Register Health Checker External Checks ───────────────────────

  healthChecker.setChecker('google_slides_api', async () => {
    const status = await orchestrator.getLayerStatus();
    return status.api.available
      ? { status: 'healthy', message: 'Google Slides API authenticated' }
      : { status: 'unhealthy', message: status.api.error ?? 'API not available' };
  });

  healthChecker.setChecker('browser', async () => {
    const status = await orchestrator.getLayerStatus();
    if (!status.browser.available) {
      return { status: 'unhealthy', message: status.browser.error ?? 'Browser not available' };
    }
    return status.browser.connected
      ? { status: 'healthy', message: 'Browser connected' }
      : { status: 'degraded', message: 'Browser available but extension not connected' };
  });

  healthChecker.setChecker('vision', async () => {
    const status = await orchestrator.getLayerStatus();
    if (!status.vision.enabled) {
      return { status: 'healthy', message: 'Vision disabled by configuration' };
    }
    return status.vision.available
      ? { status: 'healthy', message: 'Vision layer (sharp) loaded' }
      : { status: 'unhealthy', message: status.vision.error ?? 'Vision not available' };
  });

  log.info('Health checker external checks registered');

  // ── 4b. Start Alert Periodic Evaluation ───────────────────────────────

  alertManager.startPeriodicEvaluation();
  log.info('Alert periodic evaluation started');

  // ── 5. Graceful Shutdown ──────────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info('Shutting down HTTP server');

    // Stop alert periodic evaluation
    alertManager.stopPeriodicEvaluation();

    // Close HTTP server (stop accepting new connections)
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    // Close MCP server
    try {
      await mcpServer.close();
    } catch (error) {
      log.error('Error closing MCP server', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Dispose app resources
    appCtx.dispose();

    // Shut down orchestrator
    try {
      await orchestrator.shutdown();
    } catch (error) {
      log.error('Error during orchestrator shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.info('Server shutdown complete');
  }

  // Register signal handlers
  const signalHandler = (signal: string) => {
    log.info(`Received ${signal}`);
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  };

  process.on('SIGINT', () => signalHandler('SIGINT'));
  process.on('SIGTERM', () => signalHandler('SIGTERM'));

  return {
    httpServer,
    mcpServer,
    orchestrator,
    layerStatus,
    port,
    host,
    shutdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Barrel Exports
// ─────────────────────────────────────────────────────────────────────────────

// App factory
export { createApp } from './app.js';
export type { AppConfig, AppContext } from './app.js';

// HTTP+SSE Transport
export { HttpSseTransport } from './http-transport.js';
export type { HttpSseTransportConfig } from './http-transport.js';

// REST API
export { createRestApiRouter } from './rest-api.js';

// Health & Metrics
export { createHealthRouter, MetricsCollector, metrics } from './health.js';
export type { ReadinessCheck } from './health.js';

// Rate Limiter
export { RateLimiter, DEFAULT_PLAN_RATE_LIMITS } from './rate-limiter.js';
export type { RateLimitResult, RateLimitHeaders, PlanRateLimitConfig } from './rate-limiter.js';
