// ============================================================================
// Storage Layer - Database Migrations (forward-only)
// ============================================================================

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

const migrations: Migration[] = [
  // -- v1: Initial schema ---------------------------------------------------
  {
    version: 1,
    description: 'Initial schema - tenants, sessions, api_keys, presentation_actions, usage_records',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenants (
          id                    TEXT PRIMARY KEY,
          name                  TEXT NOT NULL,
          email                 TEXT NOT NULL,
          plan                  TEXT NOT NULL DEFAULT 'free',
          api_key               TEXT NOT NULL,
          google_client_id      TEXT,
          google_client_secret  TEXT,
          google_refresh_token  TEXT,
          settings              TEXT NOT NULL DEFAULT '{}',
          created_at            TEXT NOT NULL,
          last_active_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id               TEXT PRIMARY KEY,
          tenant_id        TEXT NOT NULL,
          token            TEXT NOT NULL,
          expires_at       TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          ip_address       TEXT,
          user_agent       TEXT,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS api_keys (
          key         TEXT PRIMARY KEY,
          tenant_id   TEXT NOT NULL,
          name        TEXT NOT NULL,
          permissions TEXT NOT NULL DEFAULT '[]',
          rate_limit  INTEGER NOT NULL DEFAULT 100,
          created_at  TEXT NOT NULL,
          last_used_at TEXT,
          expires_at   TEXT,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS presentation_actions (
          id              TEXT PRIMARY KEY,
          tenant_id       TEXT NOT NULL,
          presentation_id TEXT NOT NULL,
          action          TEXT NOT NULL,
          metadata        TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS usage_records (
          id         TEXT PRIMARY KEY,
          tenant_id  TEXT NOT NULL,
          tool       TEXT NOT NULL,
          layer      TEXT NOT NULL,
          duration   INTEGER NOT NULL DEFAULT 0,
          success    INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );
      `);
    },
  },

  // -- v2: Add indexes ------------------------------------------------------
  {
    version: 2,
    description: 'Add performance indexes',
    up(db) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_email
          ON tenants(email);
        CREATE INDEX IF NOT EXISTS idx_tenants_api_key
          ON tenants(api_key);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token
          ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id
          ON sessions(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
          ON sessions(expires_at);

        CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id
          ON api_keys(tenant_id);

        CREATE INDEX IF NOT EXISTS idx_presentation_actions_tenant_pres
          ON presentation_actions(tenant_id, presentation_id);
        CREATE INDEX IF NOT EXISTS idx_presentation_actions_created_at
          ON presentation_actions(created_at);

        CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_created
          ON usage_records(tenant_id, created_at);
      `);
    },
  },

  // -- v3: Add templates table ----------------------------------------------
  {
    version: 3,
    description: 'Add templates table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS templates (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          category      TEXT NOT NULL DEFAULT 'general',
          thumbnail_url TEXT,
          markdown      TEXT NOT NULL DEFAULT '',
          theme         TEXT NOT NULL DEFAULT 'default',
          tags          TEXT NOT NULL DEFAULT '[]',
          is_built_in   INTEGER NOT NULL DEFAULT 0,
          created_by    TEXT,
          created_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_templates_category
          ON templates(category);
        CREATE INDEX IF NOT EXISTS idx_templates_is_built_in
          ON templates(is_built_in);
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/** Ensures the schema_version table exists. */
function ensureVersionTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
}

/** Returns the highest applied migration version, or 0. */
function getCurrentVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS ver FROM schema_version')
    .get() as { ver: number | null } | undefined;
  return row?.ver ?? 0;
}

/**
 * Run all pending migrations inside a single transaction per migration.
 * Forward-only: there is no rollback support by design.
 */
export function runMigrations(db: Database.Database): void {
  ensureVersionTable(db);
  const current = getCurrentVersion(db);

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;

  const insertVersion = db.prepare(
    'INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      insertVersion.run(
        migration.version,
        migration.description,
        new Date().toISOString(),
      );
    });
    run();
  }
}

export { migrations };
