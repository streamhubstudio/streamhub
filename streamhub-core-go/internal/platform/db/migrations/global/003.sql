CREATE TABLE IF NOT EXISTS server_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL DEFAULT (datetime('now')),
     level TEXT NOT NULL,
     source TEXT,
     app_id INTEGER,
     message TEXT NOT NULL,
     meta_json TEXT,
     FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
   );
   CREATE INDEX IF NOT EXISTS idx_server_logs_ts ON server_logs(ts);
   CREATE INDEX IF NOT EXISTS idx_server_logs_app_level ON server_logs(app_id, level);
