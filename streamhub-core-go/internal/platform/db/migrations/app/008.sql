CREATE TABLE streams_v7 (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL CHECK (type IN ('webrtc','rtmp','rtsp','whip','ws-mjpeg')),
     room TEXT,
     participant TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT,
     last_stats_json TEXT
   );
   INSERT INTO streams_v7
     (id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json)
     SELECT id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json
     FROM streams;
   DROP TABLE streams;
   ALTER TABLE streams_v7 RENAME TO streams;
   CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
   CREATE INDEX IF NOT EXISTS idx_streams_room ON streams(room);
   CREATE INDEX IF NOT EXISTS idx_streams_started_at ON streams(started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_status_started ON streams(status, started_at);
