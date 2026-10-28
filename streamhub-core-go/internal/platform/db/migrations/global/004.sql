CREATE TABLE IF NOT EXISTS ingress_auth (
     ingress_id TEXT PRIMARY KEY,
     app TEXT NOT NULL,
     room TEXT,
     stream_key TEXT,
     password_hash TEXT,
     password_salt TEXT,
     requires_password INTEGER NOT NULL DEFAULT 0,
     validated_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_ingress_auth_app ON ingress_auth(app);
