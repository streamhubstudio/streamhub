CREATE TABLE IF NOT EXISTS vod_variants (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     vod_id INTEGER NOT NULL,
     kind TEXT NOT NULL DEFAULT 'rendition'
       CHECK (kind IN ('master','rendition','alternate')),
     format TEXT NOT NULL,
     height INTEGER,
     bitrate_kbps INTEGER,
     file_key TEXT,
     size_bytes INTEGER,
     extra_json TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_vod_variants_vod ON vod_variants(vod_id);
