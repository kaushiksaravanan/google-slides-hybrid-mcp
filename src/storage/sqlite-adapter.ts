// ============================================================================
// Storage Layer - SQLite Adapter (better-sqlite3)
// ============================================================================

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { runMigrations } from './migrations.js';
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
// Helpers: snake_case <-> camelCase mapping for each entity
// ---------------------------------------------------------------------------

function tenantFromRow(row: Record<string, unknown>): TenantRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    plan: row.plan as TenantRecord['plan'],
    apiKey: row.api_key as string,
    googleClientId: (row.google_client_id as string) ?? null,
    googleClientSecret: (row.google_client_secret as string) ?? null,
    googleRefreshToken: (row.google_refresh_token as string) ?? null,
    settings: row.settings as string,
    createdAt: row.created_at as string,
    lastActiveAt: row.last_active_at as string,
  };
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    token: row.token as string,
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
    lastActivityAt: row.last_activity_at as string,
    ipAddress: (row.ip_address as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
  };
}

function apiKeyFromRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    key: row.key as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    permissions: row.permissions as string,
    rateLimit: row.rate_limit as number,
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string) ?? null,
    expiresAt: (row.expires_at as string) ?? null,
  };
}

function actionFromRow(row: Record<string, unknown>): PresentationAction {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    presentationId: row.presentation_id as string,
    action: row.action as PresentationAction['action'],
    metadata: row.metadata as string,
    createdAt: row.created_at as string,
  };
}

function usageFromRow(row: Record<string, unknown>): UsageRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    tool: row.tool as string,
    layer: row.layer as UsageRecord['layer'],
    duration: row.duration as number,
    success: (row.success as number) === 1,
    createdAt: row.created_at as string,
  };
}

function templateFromRow(row: Record<string, unknown>): TemplateRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as string,
    thumbnailUrl: (row.thumbnail_url as string) ?? null,
    markdown: row.markdown as string,
    theme: row.theme as string,
    tags: row.tags as string,
    isBuiltIn: (row.is_built_in as number) === 1,
    createdBy: (row.created_by as string) ?? null,
    createdAt: row.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// SQLite Storage Adapter
// ---------------------------------------------------------------------------

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  // Prepared-statement cache (lazily populated in initialize())
  private stmts!: ReturnType<SqliteStorageAdapter['prepareStatements']>;

  constructor(dbPath: string = './data/gslides.db') {
    this.dbPath = dbPath;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async initialize(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);

    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Run forward-only migrations
    runMigrations(this.db);

    // Pre-compile prepared statements
    this.stmts = this.prepareStatements(this.db);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Internal helper: throw if db was not initialized. */
  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter: not initialized – call initialize() first');
    }
    return this.db;
  }

  // =========================================================================
  // Prepared statements
  // =========================================================================

  private prepareStatements(db: Database.Database) {
    return {
      // -- Tenants -----------------------------------------------------------
      insertTenant: db.prepare(`
        INSERT INTO tenants
          (id, name, email, plan, api_key, google_client_id, google_client_secret, google_refresh_token, settings, created_at, last_active_at)
        VALUES
          (@id, @name, @email, @plan, @apiKey, @googleClientId, @googleClientSecret, @googleRefreshToken, @settings, @createdAt, @lastActiveAt)
      `),
      getTenantById: db.prepare('SELECT * FROM tenants WHERE id = ?'),
      getTenantByEmail: db.prepare('SELECT * FROM tenants WHERE email = ?'),
      getTenantByApiKey: db.prepare('SELECT * FROM tenants WHERE api_key = ?'),
      deleteTenant: db.prepare('DELETE FROM tenants WHERE id = ?'),
      countTenants: db.prepare('SELECT COUNT(*) AS cnt FROM tenants'),
      listTenants: db.prepare('SELECT * FROM tenants ORDER BY created_at DESC LIMIT ? OFFSET ?'),

      // -- Sessions ----------------------------------------------------------
      insertSession: db.prepare(`
        INSERT INTO sessions
          (id, tenant_id, token, expires_at, created_at, last_activity_at, ip_address, user_agent)
        VALUES
          (@id, @tenantId, @token, @expiresAt, @createdAt, @lastActivityAt, @ipAddress, @userAgent)
      `),
      getSessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
      deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      deleteByTenant: db.prepare('DELETE FROM sessions WHERE tenant_id = ?'),

      // -- API Keys ----------------------------------------------------------
      insertApiKey: db.prepare(`
        INSERT INTO api_keys
          (key, tenant_id, name, permissions, rate_limit, created_at, last_used_at, expires_at)
        VALUES
          (@key, @tenantId, @name, @permissions, @rateLimit, @createdAt, @lastUsedAt, @expiresAt)
      `),
      getApiKey: db.prepare('SELECT * FROM api_keys WHERE key = ?'),
      deleteApiKey: db.prepare('DELETE FROM api_keys WHERE key = ?'),
      listApiKeys: db.prepare('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC'),

      // -- Presentation Actions -----------------------------------------------
      insertAction: db.prepare(`
        INSERT INTO presentation_actions
          (id, tenant_id, presentation_id, action, metadata, created_at)
        VALUES
          (@id, @tenantId, @presentationId, @action, @metadata, @createdAt)
      `),
      countActions: db.prepare('SELECT COUNT(*) AS cnt FROM presentation_actions WHERE tenant_id = ?'),
      listActions: db.prepare(
        'SELECT * FROM presentation_actions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ),
      getByPresentation: db.prepare(
        'SELECT * FROM presentation_actions WHERE tenant_id = ? AND presentation_id = ? ORDER BY created_at ASC',
      ),

      // -- Usage Records -----------------------------------------------------
      insertUsage: db.prepare(`
        INSERT INTO usage_records
          (id, tenant_id, tool, layer, duration, success, created_at)
        VALUES
          (@id, @tenantId, @tool, @layer, @duration, @success, @createdAt)
      `),
      getUsageRange: db.prepare(
        'SELECT * FROM usage_records WHERE tenant_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC',
      ),

      // -- Templates ---------------------------------------------------------
      insertTemplate: db.prepare(`
        INSERT INTO templates
          (id, name, description, category, thumbnail_url, markdown, theme, tags, is_built_in, created_by, created_at)
        VALUES
          (@id, @name, @description, @category, @thumbnailUrl, @markdown, @theme, @tags, @isBuiltIn, @createdBy, @createdAt)
      `),
      getTemplate: db.prepare('SELECT * FROM templates WHERE id = ?'),
      listTemplates: db.prepare('SELECT * FROM templates ORDER BY created_at DESC'),
      listTemplatesByCategory: db.prepare(
        'SELECT * FROM templates WHERE category = ? ORDER BY created_at DESC',
      ),
      deleteTemplate: db.prepare('DELETE FROM templates WHERE id = ?'),
    };
  }

  // =========================================================================
  // Tenants
  // =========================================================================

  async createTenant(tenant: TenantRecord): Promise<TenantRecord> {
    this.stmts.insertTenant.run(tenant);
    return tenant;
  }

  async getTenant(id: string): Promise<TenantRecord | null> {
    const row = this.stmts.getTenantById.get(id) as Record<string, unknown> | undefined;
    return row ? tenantFromRow(row) : null;
  }

  async getTenantByEmail(email: string): Promise<TenantRecord | null> {
    const row = this.stmts.getTenantByEmail.get(email) as Record<string, unknown> | undefined;
    return row ? tenantFromRow(row) : null;
  }

  async getTenantByApiKey(apiKey: string): Promise<TenantRecord | null> {
    const row = this.stmts.getTenantByApiKey.get(apiKey) as Record<string, unknown> | undefined;
    return row ? tenantFromRow(row) : null;
  }

  async updateTenant(
    id: string,
    updates: Partial<TenantRecord>,
  ): Promise<TenantRecord | null> {
    const db = this.getDb();

    // Build dynamic SET clause from supplied fields
    const columnMap: Record<string, string> = {
      name: 'name',
      email: 'email',
      plan: 'plan',
      apiKey: 'api_key',
      googleClientId: 'google_client_id',
      googleClientSecret: 'google_client_secret',
      googleRefreshToken: 'google_refresh_token',
      settings: 'settings',
      lastActiveAt: 'last_active_at',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [field, column] of Object.entries(columnMap)) {
      if (field in updates) {
        setClauses.push(`${column} = ?`);
        values.push((updates as Record<string, unknown>)[field]);
      }
    }

    if (setClauses.length === 0) {
      return this.getTenant(id);
    }

    values.push(id);
    db.prepare(`UPDATE tenants SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getTenant(id);
  }

  async deleteTenant(id: string): Promise<boolean> {
    const info = this.stmts.deleteTenant.run(id);
    return info.changes > 0;
  }

  async listTenants(
    limit: number,
    offset: number,
  ): Promise<{ items: TenantRecord[]; total: number }> {
    const { cnt } = this.stmts.countTenants.get() as { cnt: number };
    const rows = this.stmts.listTenants.all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(tenantFromRow), total: cnt };
  }

  // =========================================================================
  // Sessions
  // =========================================================================

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    this.stmts.insertSession.run(session);
    return session;
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const row = this.stmts.getSessionByToken.get(token) as Record<string, unknown> | undefined;
    return row ? sessionFromRow(row) : null;
  }

  async updateSession(token: string, updates: Partial<SessionRecord>): Promise<void> {
    const db = this.getDb();

    const columnMap: Record<string, string> = {
      expiresAt: 'expires_at',
      lastActivityAt: 'last_activity_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [field, column] of Object.entries(columnMap)) {
      if (field in updates) {
        setClauses.push(`${column} = ?`);
        values.push((updates as Record<string, unknown>)[field]);
      }
    }

    if (setClauses.length === 0) return;

    values.push(token);
    db.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE token = ?`).run(...values);
  }

  async deleteSession(token: string): Promise<boolean> {
    const info = this.stmts.deleteSession.run(token);
    return info.changes > 0;
  }

  async deleteExpiredSessions(): Promise<number> {
    const info = this.stmts.deleteExpired.run(new Date().toISOString());
    return info.changes;
  }

  async deleteSessionsByTenant(tenantId: string): Promise<number> {
    const info = this.stmts.deleteByTenant.run(tenantId);
    return info.changes;
  }

  // =========================================================================
  // API Keys
  // =========================================================================

  async createApiKey(key: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.stmts.insertApiKey.run(key);
    return key;
  }

  async getApiKey(key: string): Promise<ApiKeyRecord | null> {
    const row = this.stmts.getApiKey.get(key) as Record<string, unknown> | undefined;
    return row ? apiKeyFromRow(row) : null;
  }

  async deleteApiKey(key: string): Promise<boolean> {
    const info = this.stmts.deleteApiKey.run(key);
    return info.changes > 0;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const rows = this.stmts.listApiKeys.all(tenantId) as Record<string, unknown>[];
    return rows.map(apiKeyFromRow);
  }

  // =========================================================================
  // Presentation History
  // =========================================================================

  async recordPresentationAction(action: PresentationAction): Promise<void> {
    this.stmts.insertAction.run(action);
  }

  async getHistory(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PresentationAction[]; total: number }> {
    const { cnt } = this.stmts.countActions.get(tenantId) as { cnt: number };
    const rows = this.stmts.listActions.all(tenantId, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(actionFromRow), total: cnt };
  }

  async getPresentation(
    tenantId: string,
    presentationId: string,
  ): Promise<PresentationAction[]> {
    const rows = this.stmts.getByPresentation.all(tenantId, presentationId) as Record<
      string,
      unknown
    >[];
    return rows.map(actionFromRow);
  }

  // =========================================================================
  // Usage Metrics
  // =========================================================================

  async recordUsage(usage: UsageRecord): Promise<void> {
    this.stmts.insertUsage.run({
      ...usage,
      success: usage.success ? 1 : 0,
    });
  }

  async getUsage(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<UsageRecord[]> {
    const rows = this.stmts.getUsageRange.all(
      tenantId,
      startDate.toISOString(),
      endDate.toISOString(),
    ) as Record<string, unknown>[];
    return rows.map(usageFromRow);
  }

  async getUsageSummary(
    tenantId: string,
    period: 'day' | 'week' | 'month',
  ): Promise<UsageSummary> {
    const db = this.getDb();

    const now = new Date();
    const start = new Date(now);
    if (period === 'day') start.setDate(start.getDate() - 1);
    else if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const rows = db
      .prepare(
        'SELECT * FROM usage_records WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at ASC',
      )
      .all(tenantId, start.toISOString()) as Record<string, unknown>[];

    const records = rows.map(usageFromRow);
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
      const day = r.createdAt.slice(0, 10); // YYYY-MM-DD
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    return { totalRequests, successRate, avgDuration, byTool, byLayer, byDay };
  }

  // =========================================================================
  // Templates
  // =========================================================================

  async createTemplate(template: TemplateRecord): Promise<TemplateRecord> {
    this.stmts.insertTemplate.run({
      ...template,
      isBuiltIn: template.isBuiltIn ? 1 : 0,
    });
    return template;
  }

  async getTemplate(id: string): Promise<TemplateRecord | null> {
    const row = this.stmts.getTemplate.get(id) as Record<string, unknown> | undefined;
    return row ? templateFromRow(row) : null;
  }

  async listTemplates(category?: string): Promise<TemplateRecord[]> {
    const rows = category
      ? (this.stmts.listTemplatesByCategory.all(category) as Record<string, unknown>[])
      : (this.stmts.listTemplates.all() as Record<string, unknown>[]);
    return rows.map(templateFromRow);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const info = this.stmts.deleteTemplate.run(id);
    return info.changes > 0;
  }
}
