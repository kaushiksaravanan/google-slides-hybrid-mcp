/**
 * @module events/event-tools
 * @description MCP tool definitions for the event and webhook subsystem.
 *
 * Provides tools to:
 * - List and inspect recent system events.
 * - Register, list, delete, and test webhook endpoints.
 * - View webhook delivery history.
 *
 * Tools are prefixed with `events_` or `webhooks_` to distinguish them
 * from other layers.
 */

import { z } from 'zod';
import type { ToolResult } from '../shared/types.js';
import { MCPLayer } from '../shared/types.js';
import { validateInput } from '../shared/validators.js';
import { createToolError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { zodToJsonSchema } from '../shared/schema-converter.js';
import { eventBus } from './event-bus.js';
import { webhookManager } from './webhook-manager.js';
import type { EventType } from './types.js';

const log = createLogger('events.tools');

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Helpers
// ─────────────────────────────────────────────────────────────────────────────

function successText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function executeTool<T>(
  toolName: string,
  schema: z.ZodType<T>,
  args: unknown,
  handler: (validated: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const validation = validateInput(schema, args);
  if (!validation.success) {
    log.warn('Tool input validation failed', { toolName, error: validation.error });
    return errorResult(`Invalid input for ${toolName}: ${validation.error}`);
  }

  try {
    return await handler(validation.data);
  } catch (error) {
    const toolError = createToolError(error, toolName, MCPLayer.API);
    log.error('Tool execution failed', { toolName, error: toolError.message });
    return errorResult(toolError.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Valid Event Types (for Zod validation)
// ─────────────────────────────────────────────────────────────────────────────

const ALL_EVENT_TYPES: [EventType, ...EventType[]] = [
  'presentation.created',
  'presentation.updated',
  'presentation.deleted',
  'presentation.shared',
  'presentation.exported',
  'slide.created',
  'slide.deleted',
  'slide.duplicated',
  'slide.updated',
  'analysis.completed',
  'analysis.failed',
  'autofix.applied',
  'theme.applied',
  'template.used',
  'template.created',
  'tenant.created',
  'tenant.updated',
  'session.created',
  'session.expired',
  'apikey.created',
  'apikey.revoked',
  'system.started',
  'system.shutdown',
  'system.error',
  'health.changed',
  'rate_limit.hit',
  'quota.warning',
  'quota.exceeded',
];

const eventTypeSchema = z.enum(ALL_EVENT_TYPES).describe('System event type');

// ─────────────────────────────────────────────────────────────────────────────
// Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const listRecentEventsSchema = z.object({
  eventType: eventTypeSchema.optional().describe('Filter by event type'),
  limit: z.number().int().min(1).max(200).optional().describe('Max events to return (default 50)'),
});

const getEventSchema = z.object({
  eventId: z.string().min(1).describe('Unique event ID'),
});

const registerWebhookSchema = z.object({
  tenantId: z.string().min(1).describe('Tenant identifier'),
  url: z.string().url().describe('Webhook endpoint URL (HTTPS recommended)'),
  events: z.array(eventTypeSchema).min(1).describe('Event types to subscribe to'),
  secret: z.string().min(16).optional().describe('HMAC signing secret (auto-generated if omitted, min 16 chars)'),
});

const listWebhooksSchema = z.object({
  tenantId: z.string().min(1).describe('Tenant identifier'),
});

const deleteWebhookSchema = z.object({
  webhookId: z.string().min(1).describe('Webhook endpoint ID to delete'),
});

const testWebhookSchema = z.object({
  webhookId: z.string().min(1).describe('Webhook endpoint ID to test'),
});

const webhookDeliveriesSchema = z.object({
  webhookId: z.string().min(1).describe('Webhook endpoint ID'),
  limit: z.number().int().min(1).max(200).optional().describe('Max deliveries to return (default 50)'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definition Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Full definition of an MCP tool for the events layer. */
export interface EventToolDefinition {
  /** The MCP tool name. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** The handler function that executes the tool. */
  handler: (args: unknown) => Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

export const eventTools: EventToolDefinition[] = [
  // ── 1. events_list_recent ───────────────────────────────────────────────
  {
    name: 'events_list_recent',
    description:
      'List recent system events. Optionally filter by event type and limit the number of results. Events are returned newest-first.',
    inputSchema: zodToJsonSchema(listRecentEventsSchema),
    handler: (args) =>
      executeTool('events_list_recent', listRecentEventsSchema, args, async ({ eventType, limit }) => {
        const events = eventBus.getHistory(eventType, limit ?? 50);
        return successText(
          JSON.stringify(
            {
              totalInHistory: eventBus.historySize,
              returned: events.length,
              filter: eventType ?? 'all',
              events: events.map((e) => ({
                id: e.id,
                type: e.type,
                tenantId: e.tenantId,
                timestamp: e.timestamp.toISOString(),
                source: e.metadata.source,
                correlationId: e.metadata.correlationId,
                dataPreview:
                  JSON.stringify(e.data).slice(0, 200) +
                  (JSON.stringify(e.data).length > 200 ? '...' : ''),
              })),
            },
            null,
            2,
          ),
        );
      }),
  },

  // ── 2. events_get_event ─────────────────────────────────────────────────
  {
    name: 'events_get_event',
    description: 'Get full details of a specific system event by its unique ID.',
    inputSchema: zodToJsonSchema(getEventSchema),
    handler: (args) =>
      executeTool('events_get_event', getEventSchema, args, async ({ eventId }) => {
        const history = eventBus.getHistory(undefined, 1000);
        const event = history.find((e) => e.id === eventId);

        if (!event) {
          return errorResult(`Event not found: ${eventId}`);
        }

        return successText(
          JSON.stringify(
            {
              id: event.id,
              type: event.type,
              tenantId: event.tenantId,
              timestamp: event.timestamp.toISOString(),
              data: event.data,
              metadata: event.metadata,
            },
            null,
            2,
          ),
        );
      }),
  },

  // ── 3. webhooks_register ────────────────────────────────────────────────
  {
    name: 'webhooks_register',
    description:
      'Register a new webhook endpoint to receive event notifications. ' +
      'Specify which event types to subscribe to. An HMAC-SHA256 signing ' +
      'secret is auto-generated if not provided. Returns the full endpoint ' +
      'configuration including the secret.',
    inputSchema: zodToJsonSchema(registerWebhookSchema),
    handler: (args) =>
      executeTool(
        'webhooks_register',
        registerWebhookSchema,
        args,
        async ({ tenantId, url, events, secret }) => {
          const endpoint = webhookManager.registerWebhook(tenantId, url, events, secret);
          return successText(
            JSON.stringify(
              {
                status: 'registered',
                webhook: {
                  id: endpoint.id,
                  tenantId: endpoint.tenantId,
                  url: endpoint.url,
                  events: endpoint.events,
                  secret: endpoint.secret,
                  active: endpoint.active,
                  createdAt: endpoint.createdAt.toISOString(),
                  maxRetries: endpoint.maxRetries,
                },
                instructions: [
                  'Verify payloads using the X-Webhook-Signature header.',
                  'Signature format: sha256=<hex-encoded HMAC-SHA256 of the raw JSON body>.',
                  'Respond with 2xx to acknowledge delivery; non-2xx triggers retries.',
                  `After ${MAX_CONSECUTIVE_FAILURES} consecutive failures, the webhook is auto-disabled.`,
                ],
              },
              null,
              2,
            ),
          );
        },
      ),
  },

  // ── 4. webhooks_list ────────────────────────────────────────────────────
  {
    name: 'webhooks_list',
    description: 'List all webhook endpoints registered for a specific tenant.',
    inputSchema: zodToJsonSchema(listWebhooksSchema),
    handler: (args) =>
      executeTool('webhooks_list', listWebhooksSchema, args, async ({ tenantId }) => {
        const webhooks = webhookManager.listWebhooks(tenantId);
        return successText(
          JSON.stringify(
            {
              tenantId,
              count: webhooks.length,
              webhooks: webhooks.map((w) => ({
                id: w.id,
                url: w.url,
                events: w.events,
                active: w.active,
                createdAt: w.createdAt.toISOString(),
                lastDeliveryAt: w.lastDeliveryAt?.toISOString() ?? null,
                lastDeliveryStatus: w.lastDeliveryStatus ?? null,
                failureCount: w.failureCount,
              })),
            },
            null,
            2,
          ),
        );
      }),
  },

  // ── 5. webhooks_delete ──────────────────────────────────────────────────
  {
    name: 'webhooks_delete',
    description: 'Delete a webhook endpoint. All associated delivery history is also removed.',
    inputSchema: zodToJsonSchema(deleteWebhookSchema),
    handler: (args) =>
      executeTool('webhooks_delete', deleteWebhookSchema, args, async ({ webhookId }) => {
        const removed = webhookManager.unregisterWebhook(webhookId);
        if (!removed) {
          return errorResult(`Webhook not found: ${webhookId}`);
        }
        return successText(
          JSON.stringify(
            { status: 'deleted', webhookId },
            null,
            2,
          ),
        );
      }),
  },

  // ── 6. webhooks_test ────────────────────────────────────────────────────
  {
    name: 'webhooks_test',
    description:
      'Send a test event to a specific webhook endpoint to verify connectivity. ' +
      'Returns the delivery result including HTTP status and response body.',
    inputSchema: zodToJsonSchema(testWebhookSchema),
    handler: (args) =>
      executeTool('webhooks_test', testWebhookSchema, args, async ({ webhookId }) => {
        const delivery = await webhookManager.testWebhook(webhookId);
        if (!delivery) {
          return errorResult(`Webhook not found: ${webhookId}`);
        }
        return successText(
          JSON.stringify(
            {
              webhookId,
              test: true,
              delivery: {
                id: delivery.id,
                status: delivery.status,
                attempts: delivery.attempts,
                lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
                responseStatus: delivery.responseStatus ?? null,
                responseBody: delivery.responseBody ?? null,
                error: delivery.error ?? null,
              },
            },
            null,
            2,
          ),
        );
      }),
  },

  // ── 7. webhooks_deliveries ──────────────────────────────────────────────
  {
    name: 'webhooks_deliveries',
    description:
      'List delivery history for a specific webhook endpoint. Shows status, attempts, ' +
      'response codes, and errors. Results are returned newest-first.',
    inputSchema: zodToJsonSchema(webhookDeliveriesSchema),
    handler: (args) =>
      executeTool(
        'webhooks_deliveries',
        webhookDeliveriesSchema,
        args,
        async ({ webhookId, limit }) => {
          const endpoint = webhookManager.getWebhook(webhookId);
          if (!endpoint) {
            return errorResult(`Webhook not found: ${webhookId}`);
          }

          const deliveries = webhookManager.getDeliveryHistory(webhookId, limit ?? 50);
          return successText(
            JSON.stringify(
              {
                webhookId,
                url: endpoint.url,
                active: endpoint.active,
                returned: deliveries.length,
                deliveries: deliveries.map((d) => ({
                  id: d.id,
                  eventId: d.eventId,
                  status: d.status,
                  attempts: d.attempts,
                  lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
                  nextRetryAt: d.nextRetryAt?.toISOString() ?? null,
                  responseStatus: d.responseStatus ?? null,
                  error: d.error ?? null,
                })),
              },
              null,
              2,
            ),
          );
        },
      ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Internal constant re-exported for tools layer reference
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CONSECUTIVE_FAILURES = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Map of tool name -> tool definition for O(1) lookups. */
export const eventToolMap = new Map<string, EventToolDefinition>(
  eventTools.map((tool) => [tool.name, tool]),
);

/**
 * Get an event tool definition by name.
 */
export function getEventTool(name: string): EventToolDefinition | undefined {
  return eventToolMap.get(name);
}

/**
 * Check whether a given tool name belongs to the events layer.
 */
export function isEventTool(name: string): boolean {
  return eventToolMap.has(name);
}

/**
 * Execute an event tool by name.
 */
export async function executeEventTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = eventToolMap.get(name);
  if (!tool) {
    return errorResult(`Unknown event tool: ${name}`);
  }
  log.info('Executing event tool', { name });
  return tool.handler(args);
}

/**
 * Get all event tool definitions in the format expected by
 * `server.setRequestHandler(ListToolsRequestSchema, ...)`.
 */
export function listEventTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return eventTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
