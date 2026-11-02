CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY,
     app TEXT NOT NULL,
     name TEXT NOT NULL,
     model TEXT,
     version TEXT,
     serial TEXT,
     credential_hash TEXT,
     capabilities_json TEXT,
     status_json TEXT,
     last_seen_at TEXT,
     last_ip TEXT,
     config_rev INTEGER NOT NULL DEFAULT 0,
     created_by TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_devices_app ON devices(app);
   CREATE TABLE IF NOT EXISTS device_pairings (
     device_id TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL UNIQUE,
     poll_hash TEXT NOT NULL,
     model TEXT,
     version TEXT,
     serial TEXT,
     ip TEXT,
     poll_failures INTEGER NOT NULL DEFAULT 0,
     claimed_app TEXT,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS device_channels (
     device_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     app TEXT NOT NULL,
     name TEXT,
     room TEXT NOT NULL,
     protocol TEXT NOT NULL,
     ingress_id TEXT,
     stream_key TEXT,
     publish_url TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (device_id, channel_id)
   );
   CREATE INDEX IF NOT EXISTS idx_device_channels_app_room ON device_channels(app, room);
