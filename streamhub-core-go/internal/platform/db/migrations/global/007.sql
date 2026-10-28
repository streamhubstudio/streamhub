CREATE TABLE IF NOT EXISTS nodes (
     id TEXT PRIMARY KEY,
     name TEXT,
     url TEXT,
     region TEXT,
     status TEXT NOT NULL DEFAULT 'unknown',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_seen_at TEXT
   );

   CREATE TABLE IF NOT EXISTS _streamhub_meta (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
