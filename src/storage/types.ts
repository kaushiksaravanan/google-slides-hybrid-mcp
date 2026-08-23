// ============================================================================
// Storage Layer - Type Definitions & Interfaces
// ============================================================================

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface TenantRecord {
  id: string;
  name: string;
  email: string;
  plan: 'free' | 'pro' | 'enterprise';
  apiKey: string;
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleRefreshToken: string | null;
  /** JSON-serialised settings blob */
  settings: string;
  createdAt: string;   // ISO-8601
  lastActiveAt: string; // ISO-8601
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  token: string;
  expiresAt: string;       // ISO-8601
  createdAt: string;       // ISO-8601
  lastActivityAt: string;  // ISO-8601
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ApiKeyRecord {
  key: string;
  tenantId: string;
  name: string;
  /** JSON-serialised string[] of allowed operations */
  permissions: string;
  rateLimit: number;
  createdAt: string;     // ISO-8601
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export type PresentationActionType =
  | 'create'
  | 'update'
  | 'delete'
  | 'share'
  | 'polish'
  | 'export';

export interface PresentationAction {
  id: string;
  tenantId: string;
  presentationId: string;
  action: PresentationActionType;
  /** JSON-serialised arbitrary metadata */
  metadata: string;
  createdAt: string; // ISO-8601
}

export type UsageLayer = 'api' | 'browser' | 'vision';

export interface UsageRecord {
  id: string;
  tenantId: string;
  tool: string;
  layer: UsageLayer;
  duration: number;   // milliseconds
  success: boolean;
  createdAt: string;  // ISO-8601
}

export interface UsageSummary {
  totalRequests: number;
  successRate: number;       // 0-1
  avgDuration: number;       // ms
  byTool: Record<string, number>;
  byLayer: Record<string, number>;
  byDay: Record<string, number>; // ISO date -> count
}

export interface TemplateRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  thumbnailUrl: string | null;
  markdown: string;
  theme: string;
  /** JSON-serialised string[] */
  tags: string;
  isBuiltIn: boolean;
  createdBy: string | null;
  createdAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Storage adapter interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /** Create tables / run migrations. Must be called before any other method. */
  initialize(): Promise<void>;
  /** Gracefully close the underlying connection. */
  close(): Promise<void>;

  // -- Tenants ---------------------------------------------------------------
  createTenant(tenant: TenantRecord): Promise<TenantRecord>;
  getTenant(id: string): Promise<TenantRecord | null>;
  getTenantByEmail(email: string): Promise<TenantRecord | null>;
  getTenantByApiKey(apiKey: string): Promise<TenantRecord | null>;
  updateTenant(id: string, updates: Partial<TenantRecord>): Promise<TenantRecord | null>;
  deleteTenant(id: string): Promise<boolean>;
  listTenants(limit: number, offset: number): Promise<{ items: TenantRecord[]; total: number }>;

  // -- Sessions --------------------------------------------------------------
  createSession(session: SessionRecord): Promise<SessionRecord>;
  getSession(token: string): Promise<SessionRecord | null>;
  updateSession(token: string, updates: Partial<SessionRecord>): Promise<void>;
  deleteSession(token: string): Promise<boolean>;
  deleteExpiredSessions(): Promise<number>;
  deleteSessionsByTenant(tenantId: string): Promise<number>;

  // -- API Keys --------------------------------------------------------------
  createApiKey(key: ApiKeyRecord): Promise<ApiKeyRecord>;
  getApiKey(key: string): Promise<ApiKeyRecord | null>;
  deleteApiKey(key: string): Promise<boolean>;
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;

  // -- Presentation History --------------------------------------------------
  recordPresentationAction(action: PresentationAction): Promise<void>;
  getHistory(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PresentationAction[]; total: number }>;
  getPresentation(tenantId: string, presentationId: string): Promise<PresentationAction[]>;

  // -- Usage Metrics ---------------------------------------------------------
  recordUsage(usage: UsageRecord): Promise<void>;
  getUsage(tenantId: string, startDate: Date, endDate: Date): Promise<UsageRecord[]>;
  getUsageSummary(tenantId: string, period: 'day' | 'week' | 'month'): Promise<UsageSummary>;

  // -- Templates -------------------------------------------------------------
  createTemplate(template: TemplateRecord): Promise<TemplateRecord>;
  getTemplate(id: string): Promise<TemplateRecord | null>;
  listTemplates(category?: string): Promise<TemplateRecord[]>;
  deleteTemplate(id: string): Promise<boolean>;
}
