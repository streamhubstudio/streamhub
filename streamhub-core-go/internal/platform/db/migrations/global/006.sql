INSERT OR IGNORE INTO tenants (id, name, plan)
     VALUES ('platform', 'Platform', 'platform');
   INSERT OR IGNORE INTO quotas
     (tenant_id, max_apps, max_concurrent_streams,
      max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
     VALUES ('platform', 100000, 100000, 100000000, 100000, 100000);
