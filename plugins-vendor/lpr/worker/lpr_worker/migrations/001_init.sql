-- LPR read log — initial schema (schema version 1).
--
-- Idempotent (CREATE ... IF NOT EXISTS) so it applies cleanly to a brand-new db
-- AND to a pre-migration db created by an older worker (which built this exact
-- schema directly). The migration runner records user_version=1 either way.
CREATE TABLE IF NOT EXISTS reads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,   -- unix seconds (float) of the read
  plate         TEXT    NOT NULL,   -- normalized plate (A-Z0-9)
  confidence    REAL    NOT NULL,   -- OCR confidence 0..1
  list_match    TEXT,               -- 'whitelist' | 'blacklist' | NULL
  snapshot_path TEXT                -- absolute JPEG path, or NULL
);
CREATE INDEX IF NOT EXISTS idx_reads_ts    ON reads(ts);
CREATE INDEX IF NOT EXISTS idx_reads_plate ON reads(plate);
