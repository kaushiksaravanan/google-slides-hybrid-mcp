/**
 * @module server/app
 * @description Express application factory for the Google Slides MCP server.
 *
 * Creates a fully configured Express app with:
 * - Helmet security headers
 * - CORS (configurable origins)
 * - JSON body parser (10MB limit for base64 screenshots)
 * - Request ID middleware (X-Request-ID)
 * - Request logging middleware
 * - Authentication middleware (optional, from src/auth/)
 * - Per-tenant rate limiting
 * - MCP HTTP+SSE transport routes
 * - REST API routes
 * - Health, readiness, and metrics endpoints
 * - Global error handling middleware
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createLogger } from '../shared/logger.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../shared/constants.js';
import { isMCPError, MCPBaseError, RateLimitError } from '../shared/errors.js';
import type { HybridOrchestrator } from '../orchestrator/orchestrator.js';
import {
  TenantManager,
  SessionManager,
  AuthMiddleware,
} from '../auth/index.js';
import type { Tenant, Plan } from '../auth/types.js';
import { HttpSseTransport } from './http-transport.js';
import type { HttpSseTransportConfig } from './http-transport.js';
import { createRestApiRouter } from './rest-api.js';
import { createHealthRouter, metrics } from './health.js';
import type { ReadinessCheck } from './health.js';
import { RateLimiter } from './rate-limiter.js';
import type { PlanRateLimitConfig } from './rate-limiter.js';
import { tracer, createRequestTracer } from '../monitoring/tracing.js';
import { csrfProtection } from '../security/csrf-protection.js';
import { DDoSProtector } from '../security/rate-limiter-advanced.js';
import { RequestValidator } from '../security/request-validator.js';

const log = createLogger('server.app');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the Express application. */
export interface AppConfig {
  /** CORS allowed origins (default: ['*']). */
  corsOrigins?: string[];

  /** JSON body size limit (default: '10mb'). */
  bodyLimit?: string;

  /** Enable authentication middleware (default: true). */
  enableAuth?: boolean;

  /** Base path for MCP transport (default: '/mcp'). */
  mcpBasePath?: string;

  /** SSE keepalive interval in ms (default: 30000). */
  sseKeepaliveMs?: number;

  /** Maximum concurrent SSE sessions (default: 100). */
  maxSseSessions?: number;

  /** Per-plan rate limit overrides. */
  rateLimits?: Partial<Record<Plan, PlanRateLimitConfig>>;

  /** Custom readiness check function. */
  readinessCheck?: ReadinessCheck;

  /** Pre-configured TenantManager (for shared state). */
  tenantManager?: TenantManager;

  /** Pre-configured SessionManager (for shared state). */
  sessionManager?: SessionManager;
}

/** The result of createApp — contains the Express app and supporting objects. */
export interface AppContext {
  /** The configured Express application. */
  app: express.Application;

  /** The HTTP+SSE transport for MCP connections. */
  transport: HttpSseTransport;

  /** The tenant manager instance. */
  tenantManager: TenantManager;

  /** The session manager instance. */
  sessionManager: SessionManager;

  /** The auth middleware instance. */
  authMiddleware: AuthMiddleware;

  /** The rate limiter instance. */
  rateLimiter: RateLimiter;

  /** Dispose function to clean up resources. */
  dispose: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended Request Type
// ─────────────────────────────────────────────────────────────────────────────

/** Extend Express Request with our custom fields. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Unique request identifier. */
      requestId?: string;
      /** Start time for duration tracking (ms). */
      startTime?: number;
      /** Authenticated tenant, if any. */
      tenant?: Tenant;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Application Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fully configured Express application with all middleware,
 * routes, and subsystems.
 *
 * @param orchestrator - The hybrid orchestrator for handling requests.
 * @param config - Optional application configuration.
 * @returns An {@link AppContext} with the app and associated components.
 *
 * @example
 * ```ts
 * const orchestrator = new HybridOrchestrator(config);
 * await orchestrator.initialize();
 *
 * const ctx = createApp(orchestrator, {
 *   corsOrigins: ['https://my-app.example.com'],
 *   enableAuth: true,
 * });
 *
 * ctx.app.listen(3000, () => {
 *   console.log('Server running on http://localhost:3000');
 * });
 * ```
 */
export function createApp(
  orchestrator: HybridOrchestrator,
  config?: AppConfig,
): AppContext {
  const app = express();

  const corsOrigins = config?.corsOrigins ?? ['*'];
  const bodyLimit = config?.bodyLimit ?? '10mb';
  const enableAuth = config?.enableAuth ?? true;
  const mcpBasePath = config?.mcpBasePath ?? '/mcp';

  // ── Initialize subsystems ───────────────────────────────────────────────

  const tenantManager = config?.tenantManager ?? new TenantManager();
  const sessionManager = config?.sessionManager ?? new SessionManager();
  const authMiddleware = new AuthMiddleware(tenantManager, sessionManager);
  const rateLimiter = new RateLimiter(config?.rateLimits);

  const transportConfig: HttpSseTransportConfig = {
    basePath: mcpBasePath,
    keepaliveIntervalMs: config?.sseKeepaliveMs ?? 30_000,
    maxSessions: config?.maxSseSessions ?? 100,
  };
  const transport = new HttpSseTransport(transportConfig);

  log.info('Creating Express application', {
    corsOrigins,
    bodyLimit,
    enableAuth,
    mcpBasePath,
  });

  // ── 1. Security Headers ─────────────────────────────────────────────────

  app.use(helmet({
    contentSecurityPolicy: false, // Disabled for SSE compatibility
    crossOriginEmbedderPolicy: false,
  }));

  // ── 2. CORS ─────────────────────────────────────────────────────────────

  app.use(cors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Request-ID',
      'X-Session-Id',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-Session-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 86400,
  }));

  // ── 3. JSON Body Parser ─────────────────────────────────────────────────

  app.use(express.json({ limit: bodyLimit }));

  // ── 4. Request ID Middleware ─────────────────────────────────────────────

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  // ── 4a. DDoS Protection (early, before auth) ───────────────────────────

  const ddosProtector = new DDoSProtector();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? '0.0.0.0';
    const contentLength = req.headers['content-length']
      ? parseInt(req.headers['content-length'], 10)
      : undefined;
    const ddosResult = ddosProtector.checkRequest(ip, contentLength);
    if (!ddosResult.allowed) {
      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: `Rate limit exceeded. Retry after ${ddosResult.retryAfterSeconds} seconds.`,
        },
      });
      return;
    }
    ddosProtector.trackConnectionStart(ip);
    res.on('finish', () => {
      ddosProtector.trackConnectionEnd(ip);
    });
    next();
  });

  // ── 4b. Request Tracing (before auth, after request ID) ────────────────

  const tracingEnabled = (process.env['TRACING_ENABLED'] ?? 'true').toLowerCase() !== 'false';
  if (tracingEnabled) {
    app.use(createRequestTracer(tracer) as unknown as (req: Request, res: Response, next: NextFunction) => void);
  }

  // ── 4c. Request Validator (after body parser) ──────────────────────────

  const requestValidator = new RequestValidator();
  app.use(requestValidator.middleware());

  // ── 5. Request Timing & Logging ─────────────────────────────────────────

  app.use((req: Request, res: Response, next: NextFunction) => {
    req.startTime = Date.now();

    // Log after response
    res.on('finish', () => {
      const duration = Date.now() - (req.startTime ?? Date.now());
      const durationSeconds = duration / 1000;

      // Record metrics
      metrics.incRequestsTotal(req.method, res.statusCode);
      metrics.observeRequestDuration(req.method, durationSeconds);

      // Track errors
      if (res.statusCode >= 400) {
        const errorType = res.statusCode >= 500 ? 'internal' :
          res.statusCode === 401 ? 'auth' :
          res.statusCode === 403 ? 'forbidden' :
          res.statusCode === 429 ? 'rate_limit' :
          'client';
        metrics.incApiErrors(errorType);
      }

      // Log the request (skip health checks at debug level)
      const isHealthCheck = req.path === '/health' || req.path === '/ready';
      const logFn = isHealthCheck ? log.debug.bind(log) : log.info.bind(log);

      logFn('HTTP request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.substring(0, 100),
      });
    });

    next();
  });

  // ── 6. Health/Readiness/Metrics (no auth required) ──────────────────────

  const healthRouter = createHealthRouter(config?.readinessCheck);
  app.use(healthRouter);

  // ── 7. Auth Middleware (for API routes) ──────────────────────────────────

  // Authentication middleware factory for protected routes
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!enableAuth) {
      next();
      return;
    }

    // MCP endpoints are authenticated the same as other routes.
    // No special bypass — clients must provide auth via headers or query param.
    // For SSE connections, allow API key via ?apiKey= query parameter.
    if (req.path.startsWith(mcpBasePath) && req.query['apiKey'] && !req.headers['x-api-key'] && !req.headers['authorization']) {
      req.headers['x-api-key'] = req.query['apiKey'] as string;
    }

    const result = authMiddleware.authenticateRequest({
      headers: req.headers as Record<string, string | string[] | undefined>,
      ip: req.ip,
    });

    if (!result.authenticated || !result.tenant) {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: result.error ?? 'Authentication required',
        },
      });
      return;
    }

    req.tenant = result.tenant;
    tenantManager.touchActivity(result.tenant.id);
    next();
  };

  // ── 8. Rate Limiting Middleware (for API routes) ─────────────────────────

  const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting for health/metrics and MCP transport
    if (
      req.path === '/health' ||
      req.path === '/ready' ||
      req.path === '/metrics' ||
      req.path.startsWith(mcpBasePath)
    ) {
      next();
      return;
    }

    const tenant = req.tenant;
    const tenantId = tenant?.id ?? req.ip ?? 'anonymous';
    const plan: Plan = tenant?.plan ?? 'free';

    const result = rateLimiter.consume(tenantId, plan);
    const headers = rateLimiter.getHeaders(result);

    // Set rate limit headers on all responses
    res.setHeader('X-RateLimit-Limit', headers['X-RateLimit-Limit']);
    res.setHeader('X-RateLimit-Remaining', headers['X-RateLimit-Remaining']);
    res.setHeader('X-RateLimit-Reset', headers['X-RateLimit-Reset']);

    if (!result.allowed) {
      if (headers['Retry-After']) {
        res.setHeader('Retry-After', headers['Retry-After']);
      }
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Retry after ${result.retryAfter} seconds.`,
        },
        meta: {
          limit: result.limit,
          remaining: result.remaining,
          resetAt: result.resetAt,
          retryAfter: result.retryAfter,
        },
      });
      return;
    }

    next();
  };

  // ── 9. Mount MCP Transport Routes ───────────────────────────────────────

  app.use(transport.router);

  // ── 9a. CSRF Protection (for non-API-key, non-MCP requests) ─────────────

  app.use(csrfProtection({ exemptPrefixes: [mcpBasePath, '/health', '/ready', '/metrics'] }));

  // ── 10. Mount REST API Routes (with auth + rate limiting) ───────────────

  const restRouter = createRestApiRouter(orchestrator);
  app.use('/api/v1', requireAuth, rateLimitMiddleware, restRouter);

  // ── 11. 404 Handler ─────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist',
      },
    });
  });

  // ── 12. Global Error Handler ────────────────────────────────────────────

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.requestId ?? 'unknown';

    // Handle Zod validation errors
    if (err && typeof err === 'object' && 'issues' in err) {
      const zodError = err as { issues: Array<{ path: string[]; message: string }> };
      log.warn('Validation error', { requestId, issues: zodError.issues });
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: zodError.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
      return;
    }

    // Handle rate limit errors
    if (err instanceof RateLimitError) {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: err.message,
        },
        meta: {
          retryAfterMs: err.retryAfterMs,
        },
      });
      return;
    }

    // Handle MCP errors
    if (isMCPError(err)) {
      const mcpErr = err as MCPBaseError;
      const statusCode = 'statusCode' in mcpErr
        ? (mcpErr as Record<string, unknown>)['statusCode'] as number
        : 500;

      log.error('MCP error in request handler', {
        requestId,
        error: mcpErr.message,
        errorType: mcpErr.name,
      });

      res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
        success: false,
        error: {
          code: mcpErr.name,
          message: mcpErr.message,
        },
      });
      return;
    }

    // Handle JSON parse errors
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_JSON',
          message: 'Request body contains invalid JSON',
        },
      });
      return;
    }

    // Handle generic errors
    const message = err instanceof Error ? err.message : 'Internal server error';
    const stack = err instanceof Error ? err.stack : undefined;

    log.error('Unhandled error in request handler', {
      requestId,
      error: message,
      stack,
      path: req.path,
      method: req.method,
    });

    const isProduction = process.env['NODE_ENV'] === 'production';

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'An internal error occurred' : message,
        ...(isProduction ? {} : { stack }),
      },
    });
  });

  // ── Dispose Function ────────────────────────────────────────────────────

  function dispose(): void {
    rateLimiter.dispose();
    sessionManager.dispose();
    ddosProtector.dispose();
    transport.close().catch((err) => {
      log.error('Error closing transport during dispose', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    log.info('App context disposed');
  }

  log.info('Express application created', {
    server: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    routes: [
      'GET /health',
      'GET /ready',
      'GET /metrics',
      `GET ${mcpBasePath}/sse`,
      `POST ${mcpBasePath}/message`,
      `GET ${mcpBasePath}/sessions`,
      'POST /api/v1/presentations',
      'GET /api/v1/presentations/:id',
      'PUT /api/v1/presentations/:id',
      'DELETE /api/v1/presentations/:id',
      'POST /api/v1/presentations/:id/slides',
      'GET /api/v1/presentations/:id/slides/:slideId',
      'DELETE /api/v1/presentations/:id/slides/:slideId',
      'POST /api/v1/presentations/:id/slides/:slideId/duplicate',
      'GET /api/v1/presentations/:id/export/pdf',
      'POST /api/v1/presentations/:id/share',
      'GET /api/v1/templates',
      'POST /api/v1/templates/:id/apply',
      'POST /api/v1/presentations/:id/analyze',
      'POST /api/v1/presentations/:id/polish',
      'POST /api/v1/presentations/:id/theme',
      'POST /api/v1/markdown/preview',
      'POST /api/v1/markdown/create',
    ],
  });

  return {
    app,
    transport,
    tenantManager,
    sessionManager,
    authMiddleware,
    rateLimiter,
    dispose,
  };
}
