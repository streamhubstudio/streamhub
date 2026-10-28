CREATE TABLE IF NOT EXISTS scheduled_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app TEXT NOT NULL,
     room TEXT,
     title TEXT,
     start_at INTEGER NOT NULL,
     timezone TEXT NOT NULL DEFAULT 'UTC',
     message TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_scheduled_events_lookup ON scheduled_events(enabled, start_at);
