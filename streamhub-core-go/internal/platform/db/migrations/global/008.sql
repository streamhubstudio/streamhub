CREATE INDEX IF NOT EXISTS idx_api_tokens_app ON api_tokens(app_id);
   CREATE INDEX IF NOT EXISTS idx_server_logs_app_ts ON server_logs(app_id, ts);
