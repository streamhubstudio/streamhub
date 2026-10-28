CREATE TABLE IF NOT EXISTS net_samples (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bucket TEXT NOT NULL,
     direction TEXT NOT NULL,
     source TEXT NOT NULL,
     bytes INTEGER NOT NULL DEFAULT 0,
     UNIQUE(bucket, direction, source)
   );
   CREATE INDEX IF NOT EXISTS idx_net_samples_bucket ON net_samples(bucket);
