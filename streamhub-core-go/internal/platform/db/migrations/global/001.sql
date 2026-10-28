CREATE TABLE IF NOT EXISTS apps (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     display_name TEXT,
     livekit_room_prefix TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     settings_json TEXT
   );
