CREATE TABLE IF NOT EXISTS restream_targets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app TEXT NOT NULL,
     room TEXT NOT NULL,
     stream_id TEXT,
     name TEXT,
     platform TEXT NOT NULL DEFAULT 'custom',
     url TEXT NOT NULL,
     url_masked TEXT NOT NULL,
     egress_id TEXT,
     status TEXT NOT NULL DEFAULT 'starting'
       CHECK (status IN ('starting','active','failed','stopped')),
     error TEXT,
     retries INTEGER NOT NULL DEFAULT 0,
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_restream_targets_room ON restream_targets(room);
   CREATE INDEX IF NOT EXISTS idx_restream_targets_egress ON restream_targets(egress_id);
   CREATE INDEX IF NOT EXISTS idx_restream_targets_status ON restream_targets(status);
