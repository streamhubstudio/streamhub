ALTER TABLE vods ADD COLUMN source TEXT;
   CREATE TABLE IF NOT EXISTS clips (
     id TEXT PRIMARY KEY,
     stream_id TEXT,
     room TEXT NOT NULL,
     from_ms INTEGER NOT NULL,
     to_ms INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued'
       CHECK (status IN ('queued','running','ready','failed')),
     vod_id INTEGER,
     error TEXT,
     origin_json TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);
   CREATE INDEX IF NOT EXISTS idx_clips_stream ON clips(stream_id);
   CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at);
