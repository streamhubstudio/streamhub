# Operations — Runbook (day-2)

Commands assume you are on the host. Substitute your domain for `streamhub.example.com` and
your token for `$STREAMHUB_API_TOKEN`.

## Start / stop / restart

**Docker Compose**

```bash
docker compose ps                       # status of all services
docker compose up -d                    # start / reconcile
docker compose restart core             # restart just the brain (picks up new .env after down/up)
docker compose logs -f core             # tail core logs
docker compose logs -f livekit egress   # tail media stack
docker compose down                     # stop all (keeps volumes/data)
docker compose up -d --build            # rebuild + restart after a code change
```

`.env` changes are only fully re-read on `down` + `up -d` (recreate), not `restart`.

**systemd (plain-server)**

```bash
systemctl status  streamhub-core livekit
systemctl restart streamhub-core        # after a rebuild (npm run build)
journalctl -u streamhub-core -f
docker restart ingress egress           # media workers are containers
```

## Health

```bash
# liveness (public, no auth)
curl -s https://streamhub.example.com/api/v1/health

# server stats (auth): CPU/mem/disk, uptime, version, livekit reachable,
# active streams/rooms, app count, egress/ingress status
curl -s -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://streamhub.example.com/api/v1/stats

# is core actually up locally?
curl -s http://127.0.0.1:3020/api/v1/health
```

If `/health` is fine but the site 502s, the problem is the reverse proxy or TLS, not core.
If LiveKit shows unreachable in `/stats`, check `livekit` service + redis.

## Metrics

```bash
curl -s http://127.0.0.1:3020/metrics | grep streamhub_
# with a token set (METRICS_TOKEN):
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3020/metrics
```

`/metrics` is at the **root path** (not under `/api/v1`) and public unless `METRICS_TOKEN`
is set. Full catalog + Prometheus/Grafana setup in [OBSERVABILITY.md](./OBSERVABILITY.md).

## Database health & optimize

Per-app and global maintenance via the `db-admin` endpoints (auth required):

```bash
# health snapshot (page count, size, WAL, integrity) for an app DB
curl -s -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://streamhub.example.com/api/v1/apps/<app>/db/health

# optimize an app DB: PRAGMA optimize → ANALYZE → REINDEX → VACUUM →
# wal_checkpoint(TRUNCATE). Returns before/after sizes (reclaimed bytes).
curl -s -X POST -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://streamhub.example.com/api/v1/apps/<app>/db/optimize

# global DB health / optimize
curl -s -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://streamhub.example.com/api/v1/system/db/health
```

Run `optimize` after large deletes/purges to reclaim space and shrink the `-wal` file. It is
online (no close/reopen) but `VACUUM` briefly locks — prefer low-traffic windows.

## Backups

Everything durable lives under `DATA_DIR`:

```
$DATA_DIR/
  data/streamhub.db            # global registry (+ .bak-<ts> from the split migration)
  data/secrets.json            # S3 credentials (chmod 600)
  apps/<app>/app.db            # per-app state
  apps/<app>/{recordings,hls,snapshots,samples}/
  logs/
  sdk/
```

- **VODs** already live in each app's S3 bucket; local `recordings/` are transient.
- Back up the **SQLite files consistently** (don't copy a live WAL DB naively). Use the
  online optimize's checkpoint, or `sqlite3 file.db ".backup out.db"` / `VACUUM INTO`, or
  stop core then copy. The split migration itself writes `streamhub.db.bak-<timestamp>`.
- Simplest cold backup:
  ```bash
  docker compose stop core
  tar czf streamhub-data-$(date +%F).tgz -C "$DATA_DIR" .
  docker compose start core
  ```

## Restore

1. Stop core (`docker compose stop core` / `systemctl stop streamhub-core`).
2. Restore `DATA_DIR` (or the specific `data/streamhub.db` / `apps/<app>/app.db`) from backup;
   ensure `data/secrets.json` stays `chmod 600`.
3. Start core. Boot migrations run idempotently over the restored DBs (safe — see
   [DEPLOY.md](./DEPLOY.md)).
4. Verify `/api/v1/health`, `/stats`, and that a known VOD still resolves a presigned URL.

To roll back the per-app split specifically, the pre-split global DB is at
`data/streamhub.db.bak-<timestamp>` (path also recorded in `_streamhub_meta.per_app_split_backup`).

## Rollback (bad deploy)

**Docker Compose** — redeploy the previous image/commit:

```bash
git checkout <previous-good-ref>
docker compose up -d --build
docker compose logs -f core
```

**systemd** — check out the prior build, `npm ci && npm run build`, `systemctl restart
streamhub-core`.

Migrations are **forward-only but additive/idempotent** (`CREATE … IF NOT EXISTS`, column
adds, copy-if-absent). A newer schema generally stays compatible with the prior code; if a
new build fails to boot, restore `DATA_DIR` from backup before starting the older build to be
safe.

## Common issues

| Symptom | Look at |
|---|---|
| Site 502 but `127.0.0.1:3020/health` ok | reverse proxy / TLS (Caddy or nginx+certbot) |
| WebRTC connects then no media | `7882/udp` firewall; STUN external-IP (host networking); Cloudflare proxying the domain (must be DNS-only) |
| RTMP push refused | `1935` firewall; ingress container up; stream key/password (`ingress_auth`) |
| Recording never becomes `ready` | egress container (headless Chrome, needs `--shm-size`); S3 creds in `secrets.json`; `streamhub_upload_queue_depth`, `streamhub_recording_failures_total` |
| Callbacks not arriving | app `callbacks.url`/`secret`; `streamhub_callbacks_total{result="failed"}` |
| DB file growing | run `db/optimize` (WAL checkpoint + VACUUM) |
