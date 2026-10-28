CREATE TABLE IF NOT EXISTS app_plugins (
     plugin_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 1,
     config_json TEXT,
     installed_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_app_plugins_enabled ON app_plugins(enabled);
