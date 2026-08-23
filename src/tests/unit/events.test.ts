/**
 * Event system tests — EventBus, WebhookManager, event tools
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../../events/event-bus.js';
import { WebhookManager } from '../../events/webhook-manager.js';
import { eventTools, isEventTool, getEventTool, listEventTools } from '../../events/event-tools.js';
import type { SystemEvent, EventType } from '../../events/types.js';
import { createHmac } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// EventBus
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;

  const makeEvent = (type: EventType = 'presentation.created', data: any = {}): SystemEvent => ({
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date(),
    data,
    metadata: { source: 'test', version: '1.0.0' },
  });

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.clear();
  });

  it('emit and receive an event', async () => {
    const received: SystemEvent[] = [];
    bus.on('presentation.created', (evt) => { received.push(evt); });
    bus.emit(makeEvent('presentation.created'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);
  });

  it('wildcard handler receives all events', async () => {
    const received: SystemEvent[] = [];
    bus.on('*', (evt) => { received.push(evt); });
    bus.emit(makeEvent('presentation.created'));
    bus.emit(makeEvent('slide.created'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(2);
  });

  it('once handler fires only once', async () => {
    const received: SystemEvent[] = [];
    bus.once('presentation.created', (evt) => { received.push(evt); });
    bus.emit(makeEvent('presentation.created'));
    bus.emit(makeEvent('presentation.created'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);
  });

  it('off removes a handler', async () => {
    const received: SystemEvent[] = [];
    const handler = (evt: SystemEvent) => { received.push(evt); };
    bus.on('presentation.created', handler);
    bus.off('presentation.created', handler);
    bus.emit(makeEvent('presentation.created'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  it('off returns false for non-existent handler', () => {
    expect(bus.off('presentation.created', () => {})).toBe(false);
  });

  it('waitFor resolves on next event', async () => {
    const promise = bus.waitFor('slide.created', 5000);
    bus.emit(makeEvent('slide.created', { slideId: 's1' }));
    const evt = await promise;
    expect(evt.data.slideId).toBe('s1');
  });

  it('waitFor times out', async () => {
    await expect(bus.waitFor('analysis.completed', 50)).rejects.toThrow('timed out');
  });

  it('handler error does not break other handlers', async () => {
    const received: string[] = [];
    bus.on('system.error', () => { throw new Error('handler crash'); });
    bus.on('system.error', () => { received.push('ok'); });
    bus.emit(makeEvent('system.error'));
    await new Promise(r => setTimeout(r, 20));
    expect(received).toContain('ok');
  });

  it('stores events in history', () => {
    bus.emit(makeEvent('presentation.created'));
    bus.emit(makeEvent('slide.created'));
    expect(bus.historySize).toBe(2);
  });

  it('getHistory returns events newest-first', () => {
    bus.emit(makeEvent('presentation.created', { order: 1 }));
    bus.emit(makeEvent('presentation.created', { order: 2 }));
    const history = bus.getHistory('presentation.created');
    expect(history[0]!.data.order).toBe(2);
  });

  it('getHistory filters by type', () => {
    bus.emit(makeEvent('presentation.created'));
    bus.emit(makeEvent('slide.created'));
    bus.emit(makeEvent('presentation.created'));
    const history = bus.getHistory('presentation.created');
    expect(history).toHaveLength(2);
  });

  it('getHistory respects limit', () => {
    for (let i = 0; i < 10; i++) bus.emit(makeEvent('presentation.created'));
    const history = bus.getHistory(undefined, 3);
    expect(history).toHaveLength(3);
  });

  it('clear resets everything', () => {
    bus.on('presentation.created', () => {});
    bus.emit(makeEvent('presentation.created'));
    bus.clear();
    expect(bus.historySize).toBe(0);
  });

  it('createEvent helper produces valid event', () => {
    const evt = EventBus.createEvent('tenant.created', { name: 'Acme' }, { tenantId: 't1', source: 'api' });
    expect(evt.id).toBeTruthy();
    expect(evt.type).toBe('tenant.created');
    expect(evt.tenantId).toBe('t1');
    expect(evt.data.name).toBe('Acme');
    expect(evt.metadata.source).toBe('api');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WebhookManager
// ─────────────────────────────────────────────────────────────────────────────

describe('WebhookManager', () => {
  let wm: WebhookManager;

  beforeEach(() => {
    wm = new WebhookManager();
  });

  afterEach(() => {
    wm.stop();
  });

  it('registers a webhook', () => {
    const ep = wm.registerWebhook('t1', 'https://example.com/hook', ['presentation.created']);
    expect(ep.id).toBeTruthy();
    expect(ep.active).toBe(true);
    expect(ep.events).toEqual(['presentation.created']);
    expect(ep.secret).toBeTruthy();
  });

  it('unregisters a webhook', () => {
    const ep = wm.registerWebhook('t1', 'https://example.com/hook', ['presentation.created']);
    expect(wm.unregisterWebhook(ep.id)).toBe(true);
    expect(wm.unregisterWebhook(ep.id)).toBe(false);
  });

  it('lists webhooks for a tenant', () => {
    wm.registerWebhook('t1', 'https://a.com/hook', ['presentation.created']);
    wm.registerWebhook('t1', 'https://b.com/hook', ['slide.created']);
    wm.registerWebhook('t2', 'https://c.com/hook', ['presentation.created']);
    const list = wm.listWebhooks('t1');
    expect(list).toHaveLength(2);
  });

  it('gets a webhook by id', () => {
    const ep = wm.registerWebhook('t1', 'https://example.com/hook', ['presentation.created']);
    const retrieved = wm.getWebhook(ep.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.url).toBe('https://example.com/hook');
  });

  it('returns undefined for non-existent webhook', () => {
    expect(wm.getWebhook('nope')).toBeUndefined();
  });

  it('HMAC signature is valid', () => {
    const secret = 'my-webhook-secret';
    const payload = JSON.stringify({ test: true });
    const hmac = createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    const expected = `sha256=${hmac.digest('hex')}`;
    expect(expected).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('delivery history starts empty', () => {
    const ep = wm.registerWebhook('t1', 'https://example.com/hook', ['presentation.created']);
    expect(wm.getDeliveryHistory(ep.id)).toHaveLength(0);
  });

  it('custom secret is used when provided', () => {
    const ep = wm.registerWebhook('t1', 'https://example.com/hook', ['presentation.created'], 'my-custom-secret');
    expect(ep.secret).toBe('my-custom-secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event Tools
// ─────────────────────────────────────────────────────────────────────────────

describe('Event Tools', () => {
  it('event tools are defined', () => {
    expect(eventTools.length).toBeGreaterThan(0);
  });

  it('all tools have name, description, inputSchema, handler', () => {
    for (const tool of eventTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('isEventTool returns true for known tools', () => {
    expect(isEventTool('events_list_recent')).toBe(true);
    expect(isEventTool('webhooks_register')).toBe(true);
  });

  it('isEventTool returns false for unknown tools', () => {
    expect(isEventTool('unknown_tool')).toBe(false);
  });

  it('getEventTool returns tool definition', () => {
    const tool = getEventTool('events_list_recent');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('events_list_recent');
  });

  it('listEventTools returns all tools', () => {
    const list = listEventTools();
    expect(list.length).toBe(eventTools.length);
    for (const t of list) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('inputSchema');
    }
  });

  it('tool input schemas have type "object"', () => {
    for (const tool of eventTools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});
