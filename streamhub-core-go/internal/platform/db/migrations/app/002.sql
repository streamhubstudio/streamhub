CREATE TABLE IF NOT EXISTS vods (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT,
     room TEXT,
     name TEXT NOT NULL,
     file_key TEXT,
     s3_url TEXT,
     public_url TEXT,
     size_bytes INTEGER,
     duration_s REAL,
     width INTEGER,
     height INTEGER,
     format TEXT,
     status TEXT NOT NULL DEFAULT 'recording'
       CHECK (status IN ('recording','uploading','ready','failed')),
     local_path TEXT,
     started_at TEXT,
     ended_at TEXT,
     metatags_json TEXT,
     snapshot_key TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_vods_status ON vods(status);
   CREATE INDEX IF NOT EXISTS idx_vods_stream ON vods(stream_id);
