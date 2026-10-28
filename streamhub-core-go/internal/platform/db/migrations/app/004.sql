CREATE INDEX IF NOT EXISTS idx_vods_room ON vods(room);
   CREATE INDEX IF NOT EXISTS idx_vods_started_at ON vods(started_at);
   CREATE INDEX IF NOT EXISTS idx_vods_status_started ON vods(status, started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_room ON streams(room);
   CREATE INDEX IF NOT EXISTS idx_streams_started_at ON streams(started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_status_started ON streams(status, started_at);
