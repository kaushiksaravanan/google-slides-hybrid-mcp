/**
 * Storage layer tests — InMemoryStorageAdapter
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorageAdapter } from '../../storage/index.js';
import type {
  TenantRecord,
  SessionRecord,
  ApiKeyRecord,
  PresentationAction,
  UsageRecord,
  TemplateRecord,
} from '../../storage/types.js';

describe('InMemoryStorageAdapter', () => {
  let store: InMemoryStorageAdapter;

  beforeEach(async () => {
    store = new InMemoryStorageAdapter();
    await store.initialize();
  });

  // ── Tenants ──────────────────────────────────────────────────────────────

  describe('Tenants', () => {
    const makeTenant = (overrides: Partial<TenantRecord> = {}): TenantRecord => ({
      id: 'tenant-1',
      name: 'Acme',
      email: 'a@acme.com',
      plan: 'free',
      apiKey: 'gshm_test',
      googleClientId: null,
      googleClientSecret: null,
      googleRefreshToken: null,
      settings: '{}',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ...overrides,
    });

    it('creates and retrieves a tenant', async () => {
      const t = makeTenant();
      await store.createTenant(t);
      const retrieved = await store.getTenant('tenant-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('Acme');
    });

    it('returns null for unknown tenant', async () => {
      expect(await store.getTenant('nope')).toBeNull();
    });

    it('finds tenant by email', async () => {
      await store.createTenant(makeTenant());
      const found = await store.getTenantByEmail('a@acme.com');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('tenant-1');
    });

    it('returns null for unknown email', async () => {
      expect(await store.getTenantByEmail('nope@nope.com')).toBeNull();
    });

    it('finds tenant by API key', async () => {
      await store.createTenant(makeTenant());
      const found = await store.getTenantByApiKey('gshm_test');
      expect(found).not.toBeNull();
    });

    it('updates a tenant', async () => {
      await store.createTenant(makeTenant());
      const updated = await store.updateTenant('tenant-1', { name: 'New Name' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New Name');
      expect(updated!.id).toBe('tenant-1'); // id immutable
    });

    it('returns null when updating non-existent tenant', async () => {
      expect(await store.updateTenant('nope', { name: 'X' })).toBeNull();
    });

    it('deletes a tenant', async () => {
      await store.createTenant(makeTenant());
      expect(await store.deleteTenant('tenant-1')).toBe(true);
      expect(await store.getTenant('tenant-1')).toBeNull();
    });

    it('returns false when deleting non-existent', async () => {
      expect(await store.deleteTenant('nope')).toBe(false);
    });

    it('lists tenants with pagination', async () => {
      await store.createTenant(makeTenant({ id: 't1', email: 'a@t.com' }));
      await store.createTenant(makeTenant({ id: 't2', email: 'b@t.com' }));
      await store.createTenant(makeTenant({ id: 't3', email: 'c@t.com' }));

      const { items, total } = await store.listTenants(2, 0);
      expect(items).toHaveLength(2);
      expect(total).toBe(3);

      const page2 = await store.listTenants(2, 2);
      expect(page2.items).toHaveLength(1);
    });

    it('returns copies (not references)', async () => {
      await store.createTenant(makeTenant());
      const a = await store.getTenant('tenant-1');
      const b = await store.getTenant('tenant-1');
      expect(a).not.toBe(b);
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  describe('Sessions', () => {
    const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
      id: 'sess-1',
      tenantId: 'tenant-1',
      token: 'tok-abc',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ipAddress: null,
      userAgent: null,
      ...overrides,
    });

    it('creates and retrieves a session', async () => {
      await store.createSession(makeSession());
      const s = await store.getSession('tok-abc');
      expect(s).not.toBeNull();
      expect(s!.tenantId).toBe('tenant-1');
    });

    it('updates a session', async () => {
      await store.createSession(makeSession());
      await store.updateSession('tok-abc', { ipAddress: '1.2.3.4' });
      const s = await store.getSession('tok-abc');
      expect(s!.ipAddress).toBe('1.2.3.4');
    });

    it('deletes a session', async () => {
      await store.createSession(makeSession());
      expect(await store.deleteSession('tok-abc')).toBe(true);
      expect(await store.getSession('tok-abc')).toBeNull();
    });

    it('deletes expired sessions', async () => {
      const past = new Date(Date.now() - 10000).toISOString();
      await store.createSession(makeSession({ token: 't1', expiresAt: past }));
      await store.createSession(makeSession({ token: 't2', expiresAt: past }));
      await store.createSession(makeSession({ token: 't3' })); // not expired
      const count = await store.deleteExpiredSessions();
      expect(count).toBe(2);
    });

    it('deletes sessions by tenant', async () => {
      await store.createSession(makeSession({ token: 't1' }));
      await store.createSession(makeSession({ token: 't2' }));
      await store.createSession(makeSession({ token: 't3', tenantId: 'other' }));
      const count = await store.deleteSessionsByTenant('tenant-1');
      expect(count).toBe(2);
    });
  });

  // ── API Keys ─────────────────────────────────────────────────────────────

  describe('API Keys', () => {
    const makeKey = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
      key: 'gshm_test1',
      tenantId: 'tenant-1',
      name: 'Test Key',
      permissions: '["*"]',
      rateLimit: 60,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      ...overrides,
    });

    it('creates and retrieves an API key', async () => {
      await store.createApiKey(makeKey());
      const k = await store.getApiKey('gshm_test1');
      expect(k).not.toBeNull();
      expect(k!.name).toBe('Test Key');
    });

    it('deletes an API key', async () => {
      await store.createApiKey(makeKey());
      expect(await store.deleteApiKey('gshm_test1')).toBe(true);
      expect(await store.getApiKey('gshm_test1')).toBeNull();
    });

    it('lists keys for a tenant', async () => {
      await store.createApiKey(makeKey({ key: 'k1' }));
      await store.createApiKey(makeKey({ key: 'k2' }));
      await store.createApiKey(makeKey({ key: 'k3', tenantId: 'other' }));
      const keys = await store.listApiKeys('tenant-1');
      expect(keys).toHaveLength(2);
    });
  });

  // ── Presentation History ─────────────────────────────────────────────────

  describe('Presentation History', () => {
    const makeAction = (overrides: Partial<PresentationAction> = {}): PresentationAction => ({
      id: 'act-1',
      tenantId: 'tenant-1',
      presentationId: 'pres-1',
      action: 'create',
      metadata: '{}',
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it('records and retrieves history', async () => {
      await store.recordPresentationAction(makeAction());
      const { items, total } = await store.getHistory('tenant-1', 10, 0);
      expect(total).toBe(1);
      expect(items[0]!.action).toBe('create');
    });

    it('supports pagination on history', async () => {
      for (let i = 0; i < 5; i++) {
        await store.recordPresentationAction(makeAction({ id: `a${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString() }));
      }
      const { items } = await store.getHistory('tenant-1', 2, 0);
      expect(items).toHaveLength(2);
    });

    it('gets actions for a specific presentation', async () => {
      await store.recordPresentationAction(makeAction({ id: 'a1', presentationId: 'p1' }));
      await store.recordPresentationAction(makeAction({ id: 'a2', presentationId: 'p2' }));
      const actions = await store.getPresentation('tenant-1', 'p1');
      expect(actions).toHaveLength(1);
    });
  });

  // ── Usage ────────────────────────────────────────────────────────────────

  describe('Usage', () => {
    const makeUsage = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
      id: 'u-1',
      tenantId: 'tenant-1',
      tool: 'create_presentation',
      layer: 'api',
      duration: 500,
      success: true,
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it('records and retrieves usage', async () => {
      await store.recordUsage(makeUsage());
      const records = await store.getUsage('tenant-1', new Date(0), new Date());
      expect(records).toHaveLength(1);
    });

    it('filters by date range', async () => {
      const past = new Date(Date.now() - 86400000 * 2).toISOString();
      await store.recordUsage(makeUsage({ id: 'u1', createdAt: past }));
      await store.recordUsage(makeUsage({ id: 'u2' }));
      const recent = await store.getUsage('tenant-1', new Date(Date.now() - 86400000), new Date());
      expect(recent).toHaveLength(1);
    });

    it('computes usage summary', async () => {
      await store.recordUsage(makeUsage({ id: 'u1', tool: 'create', success: true }));
      await store.recordUsage(makeUsage({ id: 'u2', tool: 'create', success: false, duration: 1000 }));
      const summary = await store.getUsageSummary('tenant-1', 'day');
      expect(summary.totalRequests).toBe(2);
      expect(summary.successRate).toBe(0.5);
      expect(summary.byTool['create']).toBe(2);
    });
  });

  // ── Templates ────────────────────────────────────────────────────────────

  describe('Templates', () => {
    const makeTemplate = (overrides: Partial<TemplateRecord> = {}): TemplateRecord => ({
      id: 'tpl-1',
      name: 'Business',
      description: 'A business template',
      category: 'business',
      thumbnailUrl: null,
      markdown: '# Title',
      theme: 'default',
      tags: '["business"]',
      isBuiltIn: true,
      createdBy: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it('creates and retrieves a template', async () => {
      await store.createTemplate(makeTemplate());
      const t = await store.getTemplate('tpl-1');
      expect(t).not.toBeNull();
      expect(t!.name).toBe('Business');
    });

    it('lists all templates', async () => {
      await store.createTemplate(makeTemplate({ id: 't1', category: 'business' }));
      await store.createTemplate(makeTemplate({ id: 't2', category: 'pitch' }));
      const all = await store.listTemplates();
      expect(all).toHaveLength(2);
    });

    it('lists templates by category', async () => {
      await store.createTemplate(makeTemplate({ id: 't1', category: 'business' }));
      await store.createTemplate(makeTemplate({ id: 't2', category: 'pitch' }));
      const filtered = await store.listTemplates('business');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.category).toBe('business');
    });

    it('deletes a template', async () => {
      await store.createTemplate(makeTemplate());
      expect(await store.deleteTemplate('tpl-1')).toBe(true);
      expect(await store.getTemplate('tpl-1')).toBeNull();
    });

    it('returns false when deleting non-existent', async () => {
      expect(await store.deleteTemplate('nope')).toBe(false);
    });
  });

  // ── Close ────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('clears all data', async () => {
      await store.createTenant({ id: 't1', name: 'X', email: 'x@x.com', plan: 'free', apiKey: '', googleClientId: null, googleClientSecret: null, googleRefreshToken: null, settings: '{}', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() });
      await store.close();
      expect(await store.getTenant('t1')).toBeNull();
    });
  });
});
