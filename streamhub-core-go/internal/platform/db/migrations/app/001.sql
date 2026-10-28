CREATE TABLE IF NOT EXISTS streams (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL CHECK (type IN ('webrtc','rtmp','rtsp','whip')),
     room TEXT,
     participant TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT,
     last_stats_json TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
