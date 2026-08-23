// ============================================================================
// Storage Layer - Factory, In-Memory Adapter & Public Exports
// ============================================================================

import { SqliteStorageAdapter } from './sqlite-adapter.js';
import type {
  ApiKeyRecord,
  PresentationAction,
  SessionRecord,
  StorageAdapter,
  TemplateRecord,
  TenantRecord,
  UsageRecord,
  UsageSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Re-exports (barrel)
// ---------------------------------------------------------------------------

export type {
  StorageAdapter,
  TenantRecord,
  SessionRecord,
  ApiKeyRecord,
  PresentationAction,
  UsageRecord,
  UsageSummary,
  TemplateRecord,
} from './types.js';
export type { PresentationActionType, UsageLayer } from './types.js';

export { SqliteStorageAdapter } from './sqlite-adapter.js';
export { runMigrations } from './migrations.js';

// ---------------------------------------------------------------------------
// In-Memory adapter (for unit tests & quick prototyping)
// ---------------------------------------------------------------------------

export class InMemoryStorageAdapter implements StorageAdapter {
  private tenants = new Map<string, TenantRecord>();
  private sessions = new Map<string, SessionRecord>();       // key = token
  private apiKeys = new Map<string, ApiKeyRecord>();          // key = key
  private actions: PresentationAction[] = [];
  private usageRecords: UsageRecord[] = [];
  private templates = new Map<string, TemplateRecord>();

  async initialize(): Promise<void> {
    /* no-op */
  }

  async close(): Promise<void> {
    this.tenants.clear();
    this.sessions.clear();
    this.apiKeys.clear();
    this.actions = [];
    this.usageRecords = [];
    this.templates.clear();
  }

  // -- Tenants ---------------------------------------------------------------

  async createTenant(tenant: TenantRecord): Promise<TenantRecord> {
    this.tenants.set(tenant.id, { ...tenant });
    return { ...tenant };
  }

  async getTenant(id: string): Promise<TenantRecord | null> {
    const t = this.tenants.get(id);
    return t ? { ...t } : null;
  }

  async getTenantByEmail(email: string): Promise<TenantRecord | null> {
    for (const t of this.tenants.values()) {
      if (t.email === email) return { ...t };
    }
    return null;
  }

  async getTenantByApiKey(apiKey: string): Promise<TenantRecord | null> {
    for (const t of this.tenants.values()) {
      if (t.apiKey === apiKey) return { ...t };
    }
    return null;
  }

  async updateTenant(id: string, updates: Partial<TenantRecord>): Promise<TenantRecord | null> {
    const existing = this.tenants.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id }; // id is immutable
    this.tenants.set(id, updated);
    return { ...updated };
  }

  async deleteTenant(id: string): Promise<boolean> {
    return this.tenants.delete(id);
  }

  async listTenants(limit: number, offset: number): Promise<{ items: TenantRecord[]; total: number }> {
    const all = [...this.tenants.values()];
    return { items: all.slice(offset, offset + limit).map((t) => ({ ...t })), total: all.length };
  }

  // -- Sessions --------------------------------------------------------------

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    this.sessions.set(session.token, { ...session });
    return { ...session };
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(token);
    return s ? { ...s } : null;
  }

  async updateSession(token: string, updates: Partial<SessionRecord>): Promise<void> {
    const existing = this.sessions.get(token);
    if (!existing) return;
    this.sessions.set(token, { ...existing, ...updates, token });
  }

  async deleteSession(token: string): Promise<boolean> {
    return this.sessions.delete(token);
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const [token, s] of this.sessions) {
      if (s.expiresAt < now) {
        this.sessions.delete(token);
        count++;
      }
    }
    return count;
  }

  async deleteSessionsByTenant(tenantId: string): Promise<number> {
    let count = 0;
    for (const [token, s] of this.sessions) {
      if (s.tenantId === tenantId) {
        this.sessions.delete(token);
        count++;
      }
    }
    return count;
  }

  // -- API Keys --------------------------------------------------------------

  async createApiKey(key: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.apiKeys.set(key.key, { ...key });
    return { ...key };
  }

  async getApiKey(key: string): Promise<ApiKeyRecord | null> {
    const k = this.apiKeys.get(key);
    return k ? { ...k } : null;
  }

  async deleteApiKey(key: string): Promise<boolean> {
    return this.apiKeys.delete(key);
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()].filter((k) => k.tenantId === tenantId).map((k) => ({ ...k }));
  }

  // -- Presentation History --------------------------------------------------

  async recordPresentationAction(action: PresentationAction): Promise<void> {
    this.actions.push({ ...action });
  }

  async getHistory(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PresentationAction[]; total: number }> {
    const filtered = this.actions.filter((a) => a.tenantId === tenantId);
    const sorted = filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: sorted.slice(offset, offset + limit).map((a) => ({ ...a })), total: filtered.length };
  }

  async getPresentation(tenantId: string, presentationId: string): Promise<PresentationAction[]> {
    return this.actions
      .filter((a) => a.tenantId === tenantId && a.presentationId === presentationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => ({ ...a }));
  }

  // -- Usage Metrics ---------------------------------------------------------

  async recordUsage(usage: UsageRecord): Promise<void> {
    this.usageRecords.push({ ...usage });
  }

  async getUsage(tenantId: string, startDate: Date, endDate: Date): Promise<UsageRecord[]> {
    const start = startDate.toISOString();
    const end = endDate.toISOString();
    return this.usageRecords
      .filter((r) => r.tenantId === tenantId && r.createdAt >= start && r.createdAt <= end)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }));
  }

  async getUsageSummary(tenantId: string, period: 'day' | 'week' | 'month'): Promise<UsageSummary> {
    const now = new Date();
    const start = new Date(now);
    if (period === 'day') start.setDate(start.getDate() - 1);
    else if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const records = await this.getUsage(tenantId, start, now);

    const totalRequests = records.length;
    const successCount = records.filter((r) => r.success).length;
    const successRate = totalRequests > 0 ? successCount / totalRequests : 0;
    const totalDuration = records.reduce((sum, r) => sum + r.duration, 0);
    const avgDuration = totalRequests > 0 ? totalDuration / totalRequests : 0;

    const byTool: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const byDay: Record<string, number> = {};

    for (const r of records) {
      byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
      byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;
      const day = r.createdAt.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    return { totalRequests, successRate, avgDuration, byTool, byLayer, byDay };
  }

  // -- Templates -------------------------------------------------------------

  async createTemplate(template: TemplateRecord): Promise<TemplateRecord> {
    this.templates.set(template.id, { ...template });
    return { ...template };
  }

  async getTemplate(id: string): Promise<TemplateRecord | null> {
    const t = this.templates.get(id);
    return t ? { ...t } : null;
  }

  async listTemplates(category?: string): Promise<TemplateRecord[]> {
    const all = [...this.templates.values()];
    const filtered = category ? all.filter((t) => t.category === category) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => ({ ...t }));
  }

  async deleteTemplate(id: string): Promise<boolean> {
    return this.templates.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface StorageConfig {
  /** Path to the SQLite database file (only for 'sqlite' type). Defaults to ./data/gslides.db */
  dbPath?: string;
}

/**
 * Create a StorageAdapter of the requested type.
 *
 * - `'sqlite'` (default) – persistent SQLite via better-sqlite3
 * - `'memory'` – ephemeral in-memory store (tests / dev)
 */
export function createStorage(
  type: 'sqlite' | 'memory' = 'sqlite',
  config?: StorageConfig,
): StorageAdapter {
  switch (type) {
    case 'memory':
      return new InMemoryStorageAdapter();
    case 'sqlite':
    default:
      return new SqliteStorageAdapter(config?.dbPath);
  }
}
