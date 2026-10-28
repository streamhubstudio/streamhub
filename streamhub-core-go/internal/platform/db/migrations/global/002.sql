CREATE TABLE IF NOT EXISTS api_tokens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('global','app')),
     app_id INTEGER,
     allowed_ips_json TEXT,
     last_used_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     revoked INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
