/**
 * @module events
 * @description Unified event bus, webhook management, and MCP event/webhook
 * tools for the Google Slides Hybrid MCP server.
 *
 * Re-exports all public APIs from the events subsystem for convenient
 * single-import usage:
 *
 * ```ts
 * import {
 *   eventBus,
 *   EventBus,
 *   webhookManager,
 *   WebhookManager,
 *   listEventTools,
 *   executeEventTool,
 * } from './events/index.js';
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────
export type {
  EventType,
  SystemEvent,
  EventMetadata,
  WebhookEndpoint,
  WebhookDelivery,
  WebhookDeliveryStatus,
  EventHandler,
} from './types.js';

// ── Event Bus ──────────────────────────────────────────────────────────────
export { EventBus, eventBus } from './event-bus.js';

// ── Webhook Manager ────────────────────────────────────────────────────────
export { WebhookManager, webhookManager } from './webhook-manager.js';

// ── MCP Tools ──────────────────────────────────────────────────────────────
export {
  eventTools,
  eventToolMap,
  getEventTool,
  isEventTool,
  executeEventTool,
  listEventTools,
  type EventToolDefinition,
} from './event-tools.js';
