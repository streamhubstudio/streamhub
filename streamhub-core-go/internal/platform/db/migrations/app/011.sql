CREATE TABLE IF NOT EXISTS tags (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slug TEXT NOT NULL UNIQUE,
     label TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'custom',
     config_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_tags_kind ON tags(kind);
