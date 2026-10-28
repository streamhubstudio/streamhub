CREATE TABLE IF NOT EXISTS edge_assignments (
     id TEXT PRIMARY KEY,
     node_id TEXT NOT NULL,
     app TEXT NOT NULL,
     plugin_id TEXT NOT NULL,
     stream_id TEXT,
     config_json TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_edge_assignments_node ON edge_assignments(node_id, status);
   CREATE INDEX IF NOT EXISTS idx_edge_assignments_app ON edge_assignments(app, plugin_id);
