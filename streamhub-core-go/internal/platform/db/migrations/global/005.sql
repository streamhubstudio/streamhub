CREATE TABLE IF NOT EXISTS tenants (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     plan TEXT NOT NULL DEFAULT 'free',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT,
     is_superadmin INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

   CREATE TABLE IF NOT EXISTS memberships (
     user_id TEXT NOT NULL,
     tenant_id TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'viewer'
       CHECK (role IN ('owner','editor','viewer')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (user_id, tenant_id),
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

   CREATE TABLE IF NOT EXISTS quotas (
     tenant_id TEXT PRIMARY KEY,
     max_apps INTEGER NOT NULL DEFAULT 2,
     max_concurrent_streams INTEGER NOT NULL DEFAULT 2,
     max_recording_minutes_month INTEGER NOT NULL DEFAULT 300,
     max_egress_gb_month INTEGER NOT NULL DEFAULT 5,
     max_storage_gb INTEGER NOT NULL DEFAULT 5,
     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
   );
