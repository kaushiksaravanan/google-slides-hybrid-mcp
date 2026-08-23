#!/usr/bin/env node

/**
 * @module index
 * @description Main entry point for the Google Slides Hybrid MCP server.
 *
 * Supports two transport modes selected via CLI flags:
 *
 * **stdio** (default, backward compatible):
 *   `node build/index.js` or `node build/index.js --transport stdio`
 *   Runs as a standard MCP server over stdin/stdout.
 *
 * **http** (SaaS mode):
 *   `node build/index.js --transport http`
 *   Starts an Express HTTP+SSE server with all SaaS features:
 *   multi-tenant auth, SQLite storage, monitoring, resilience,
 *   event bus, webhooks, and template tools.
 *
 * CLI arguments:
 * - `--transport stdio|http` (default: stdio)
 * - `--port NUMBER` (default: 8080)
 * - `--host STRING` (default: 0.0.0.0)
 * - `--db-path STRING` (default: ./data/gslides.db)
 * - `--log-level STRING` (default: info)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { HybridConfig } from './shared/types.js';
import { createLogger } from './shared/logger.js';
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SERVER_DESCRIPTION,
  ENV_VARS,
  DEFAULT_WS_PORT,
} from './shared/constants.js';
import { ToolExecutionError } from './shared/errors.js';
import { HybridOrchestrator } from './orchestrator/orchestrator.js';
import type { LayerStatus } from './orchestrator/orchestrator.js';
import { initializeContainer, destroyContainer } from './shared/container.js';

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CLIArgs {
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  dbPath: string;
  logLevel: string;
}

function parseCLIArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const parsed: CLIArgs = {
    transport: 'stdio',
    port: 8080,
    host: '0.0.0.0',
    dbPath: './data/gslides.db',
    logLevel: 'info',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--transport':
        if (next === 'http' || next === 'stdio') {
          parsed.transport = next;
          i++;
        }
        break;
      case '--port':
        if (next) {
          const port = parseInt(next, 10);
          if (Number.isFinite(port) && port > 0) parsed.port = port;
          i++;
        }
        break;
      case '--host':
        if (next) {
          parsed.host = next;
          i++;
        }
        break;
      case '--db-path':
        if (next) {
          parsed.dbPath = next;
          i++;
        }
        break;
      case '--log-level':
        if (next) {
          parsed.logLevel = next;
          i++;
        }
        break;
    }
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function buildConfig(): HybridConfig {
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
// Layer Availability Logging
// ─────────────────────────────────────────────────────────────────────────────

function logLayerStatus(log: ReturnType<typeof createLogger>, status: LayerStatus): void {
  const apiIcon = status.api.available ? '[OK]' : '[--]';
  const browserIcon = status.browser.available ? '[OK]' : '[--]';
  const visionIcon = status.vision.available ? '[OK]' : '[--]';

  log.info(`Layer status: API ${apiIcon} | Browser ${browserIcon} | Vision ${visionIcon}`);

  if (status.api.available) {
    log.info('  API: Authenticated and ready');
  } else {
    log.info(`  API: Not available${status.api.error ? ` — ${status.api.error}` : ''}`);
  }

  if (status.browser.available) {
    const connStatus = status.browser.connected ? 'extension connected' : 'waiting for extension';
    log.info(`  Browser: WebSocket on port ${status.browser.wsPort} (${connStatus})`);
  } else {
    log.info(`  Browser: Not available${status.browser.error ? ` — ${status.browser.error}` : ''}`);
  }

  if (status.vision.available) {
    log.info('  Vision: sharp loaded, design analysis ready');
  } else if (!status.vision.enabled) {
    log.info('  Vision: Disabled by configuration (VISION_ENABLED=false)');
  } else {
    log.info(`  Vision: Not available${status.vision.error ? ` — ${status.vision.error}` : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdio Transport Mode
// ─────────────────────────────────────────────────────────────────────────────

async function startStdioMode(): Promise<void> {
  const log = createLogger('main');
  log.info(`Starting ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} (stdio mode)`);
  log.info(MCP_SERVER_DESCRIPTION);

  // ── Build Configuration ─────────────────────────────────────────────────
  const config = buildConfig();

  // ── Initialize Orchestrator ─────────────────────────────────────────────
  const orchestrator = new HybridOrchestrator(config);
  let layerStatus: LayerStatus;

  try {
    layerStatus = await orchestrator.initialize();
  } catch (error) {
    log.error('Fatal: Orchestrator initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  logLayerStatus(log, layerStatus);

  // Count available tools
  const availableTools = orchestrator.getAvailableTools();
  log.info(`Registered ${availableTools.length} tools across active layers`);

  // ── Create MCP Server ───────────────────────────────────────────────────
  const server = new Server(
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

  // ── Register ListTools Handler ──────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = orchestrator.getAvailableTools();
    log.debug('ListTools request', { toolCount: tools.length });
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // ── Register CallTool Handler ───────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.info('CallTool request', { toolName: name });

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

      log.error('Tool execution error', { toolName: name, error: message });
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // ── Set Up Transport ────────────────────────────────────────────────────
  const transport = new StdioServerTransport();

  // ── Graceful Shutdown ───────────────────────────────────────────────────
  async function gracefulShutdown(signal: string): Promise<void> {
    log.info(`Received ${signal}, shutting down gracefully`);

    try {
      await orchestrator.shutdown();
    } catch (error) {
      log.error('Error during orchestrator shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await server.close();
    } catch (error) {
      log.error('Error during server close', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.info('Server shut down complete');
    process.exit(0);
  }

  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // ── Connect and Start ───────────────────────────────────────────────────
  try {
    await server.connect(transport);
    log.info(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} is running`);
    log.info(`Transport: stdio`);
    log.info(`Tools: ${availableTools.length} registered`);
  } catch (error) {
    log.error('Failed to connect server to transport', {
      error: error instanceof Error ? error.message : String(error),
    });
    await orchestrator.shutdown();
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Transport Mode (SaaS)
// ─────────────────────────────────────────────────────────────────────────────

async function startHttpMode(cliArgs: CLIArgs): Promise<void> {
  const log = createLogger('main');
  log.info(`Starting ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} (HTTP mode)`);
  log.info(MCP_SERVER_DESCRIPTION);

  // ── 1. Initialize Storage ──────────────────────────────────────────────
  const { createStorage } = await import('./storage/index.js');
  const storage = createStorage('sqlite', { dbPath: cliArgs.dbPath });
  await storage.initialize();
  log.info('Storage initialized', { dbPath: cliArgs.dbPath });

  // ── 2. Initialize Auth ─────────────────────────────────────────────────
  const { TenantManager, SessionManager } = await import('./auth/index.js');
  const tenantManager = new TenantManager();
  const sessionManager = new SessionManager();
  log.info('Auth subsystem initialized (TenantManager + SessionManager)');

  // ── 3. Initialize Monitoring ───────────────────────────────────────────
  const {
    metricsRegistry,
    alertManager,
    auditLogger,
    healthChecker,
  } = await import('./monitoring/index.js');

  // Default alert rules are auto-registered by the alertManager singleton
  log.info('Monitoring initialized (Metrics, Alerts, AuditLog, HealthChecker)');

  // ── 4. Initialize Resilience ───────────────────────────────────────────
  const {
    shutdownManager,
    healthMonitor,
    presentationCache,
    ShutdownPriority,
  } = await import('./resilience/index.js');
  log.info('Resilience initialized (CircuitBreakers, ShutdownManager, HealthMonitor, Cache)');

  // ── 5. Initialize Event Bus + Webhook Manager ─────────────────────────
  const { eventBus, webhookManager } = await import('./events/index.js');
  log.info('Event bus and webhook manager initialized');

  // ── 6. Initialize Orchestrator ─────────────────────────────────────────
  const config = buildConfig();
  const orchestrator = new HybridOrchestrator(config);

  let layerStatus: LayerStatus;
  try {
    layerStatus = await orchestrator.initialize();
  } catch (error) {
    log.error('Fatal: Orchestrator initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  logLayerStatus(log, layerStatus);

  // ── Initialize Service Container ───────────────────────────────────────
  initializeContainer({
    storage,
    tenantManager,
    sessionManager,
    orchestrator,
    metricsRegistry,
    alertManager,
    auditLogger,
    healthChecker,
    eventBus,
    webhookManager,
    shutdownManager,
    healthMonitor,
    cache: presentationCache,
  });
  log.info('Service container initialized');

  // ── 7. Create Express App with All Middleware ──────────────────────────
  const { startServer } = await import('./server/index.js');
  const handle = await startServer({
    port: cliArgs.port,
    host: cliArgs.host,
    hybridConfig: config,
    enableAuth: true,
    tenantManager,
    sessionManager,
  });

  log.info(`HTTP server started`, {
    url: `http://${cliArgs.host}:${cliArgs.port}`,
    tools: orchestrator.getAvailableTools().length,
  });

  // Emit system started event
  eventBus.emit({
    id: crypto.randomUUID(),
    type: 'system.started',
    timestamp: new Date(),
    data: {
      transport: 'http',
      port: cliArgs.port,
      host: cliArgs.host,
      toolCount: orchestrator.getAvailableTools().length,
    },
    metadata: { source: 'main', version: MCP_SERVER_VERSION },
  });

  // ── 8. Start Health Monitoring ─────────────────────────────────────────
  healthMonitor.start();
  log.info('Health monitoring started');

  // ── 9. Register Shutdown Handlers ──────────────────────────────────────
  shutdownManager.register(
    'http-server',
    async () => { await handle.shutdown(); },
    ShutdownPriority.STOP_ACCEPTING,
    10_000,
  );

  shutdownManager.register(
    'health-monitor',
    () => { healthMonitor.stop(); },
    ShutdownPriority.CLOSE_CONNECTIONS,
    5_000,
  );

  shutdownManager.register(
    'event-bus-shutdown-event',
    async () => {
      eventBus.emit({
        id: crypto.randomUUID(),
        type: 'system.shutdown',
        timestamp: new Date(),
        data: { reason: 'graceful' },
        metadata: { source: 'main', version: MCP_SERVER_VERSION },
      });
    },
    ShutdownPriority.CLOSE_CONNECTIONS,
    5_000,
  );

  shutdownManager.register(
    'session-manager',
    () => { sessionManager.dispose(); },
    ShutdownPriority.DRAIN_REQUESTS,
    5_000,
  );

  shutdownManager.register(
    'storage',
    async () => { await storage.close(); },
    10, // Low priority - close last
    5_000,
  );

  shutdownManager.register(
    'container-cleanup',
    () => { destroyContainer(); },
    0,
    1_000,
  );

  // ── Signal Handlers ────────────────────────────────────────────────────
  const signalHandler = (signal: string) => {
    log.info(`Received ${signal}, initiating graceful shutdown`);
    shutdownManager.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  };

  process.on('SIGINT', () => signalHandler('SIGINT'));
  process.on('SIGTERM', () => signalHandler('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseCLIArgs();

  if (cliArgs.transport === 'http') {
    await startHttpMode(cliArgs);
  } else {
    await startStdioMode();
  }
}

main().catch((error: unknown) => {
  const log = createLogger('main');
  log.error('Fatal startup error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
