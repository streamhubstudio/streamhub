# Operations — Backups & Restore

StreamHub's durable state is small and file-based: a handful of SQLite DBs plus one secrets
file. `deploy/backup.sh` snapshots them consistently, tar+gzips them with a UTC timestamp,
optionally ships them to S3, and prunes old copies. `deploy/restore.sh` brings one back.

---

## What gets backed up

Everything lives under the host **`DATA_DIR`** (the dir bind-mounted to `/data` in the
containers, `STREAMHUB_HOST_DATA_DIR`; on the plain-server it's `<APP_DIR>/data`):

| Item | Path | Why |
|---|---|---|
| Global DB | `streamhub.db` | tenants, users, `api_tokens`, `apps`, nodes registry |
| Per-app DBs | `apps/<app>/app.db` | streams, vods, `ingress_auth` — one per app |
| Per-app secrets | `secrets.json` (chmod 600) | per-app S3 credentials referenced from `config.yaml` |

**Not** backed up (regenerable or bulky): recordings/HLS/snapshots (already in the app's S3
bucket), `logs/`, `redis/`, the served `sdk/`, `node_modules`.

### Consistency — how the snapshot is taken

Each `*.db` is copied with `sqlite3 <db> "VACUUM INTO '<dst>'"`, which produces a compacted,
**WAL-safe** single-file snapshot of a committed state — the same technique the core uses
before its boot-time migration (`streamhub-core/src/shared/db/db.service.ts`). We never `tar`
a live `.db` directly (that can capture a torn write-ahead log). On very old `sqlite3` without
`VACUUM INTO`, the script falls back to the `.backup` API. `secrets.json` is a plain file, so
it's copied preserving its `600` mode.

---

## Configuration (all env)

| Var | Default | Meaning |
|---|---|---|
| `BACKUP_DATA_DIR` | `/opt/streamhub/data` | host data dir to back up |
| `BACKUP_LOCAL_DIR` | `<DATA_DIR>/backups` | where the tarball is written |
| `BACKUP_RETENTION_DAYS` | `30` | prune local + remote copies older than this |
| `BACKUP_S3_BUCKET` | *(empty)* | S3 bucket; empty ⇒ **local backup only** |
| `BACKUP_S3_ENDPOINT` | *(empty)* | S3-compatible endpoint (Wasabi/MinIO); omit for AWS |
| `BACKUP_S3_PREFIX` | `streamhub-backups` | key prefix in the bucket |
| `BACKUP_S3_REGION` | `us-east-1` | AWS region |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | ambient `AWS_*` | upload creds |

Run it by hand:

```bash
BACKUP_DATA_DIR=/opt/streamhub-core/data \
BACKUP_S3_BUCKET=my-streamhub-backups \
BACKUP_S3_ENDPOINT=https://s3.wasabisys.com \
BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=… \
  deploy/backup.sh
```

Exit codes: `0` ok · `1` usage · `2` preflight (missing dep/dir) · `3` snapshot failed ·
`4` upload failed. Retention errors are warnings only (a completed backup still exits `0`).

---

## Scheduling

### systemd timer (recommended)

Ship the two units and an env file, then enable the timer:

```bash
sudo install -m 644 deploy/streamhub-backup.service /etc/systemd/system/
sudo install -m 644 deploy/streamhub-backup.timer   /etc/systemd/system/

sudo mkdir -p /etc/streamhub
sudo tee /etc/streamhub/backup.env >/dev/null <<'EOF'
BACKUP_DATA_DIR=/opt/streamhub-core/data
BACKUP_S3_BUCKET=my-streamhub-backups
BACKUP_S3_ENDPOINT=https://s3.wasabisys.com
BACKUP_S3_ACCESS_KEY_ID=change-me
BACKUP_S3_SECRET_ACCESS_KEY=change-me
BACKUP_RETENTION_DAYS=30
EOF
sudo chmod 600 /etc/streamhub/backup.env

sudo systemctl daemon-reload
sudo systemctl enable --now streamhub-backup.timer
systemctl list-timers streamhub-backup.timer      # confirm next run
sudo systemctl start streamhub-backup.service     # run once now to test
journalctl -u streamhub-backup.service --no-pager # inspect the run
```

The timer fires **daily at 03:15 UTC** (±5 min jitter, `Persistent=true` catches a missed run
after downtime). Adjust `OnCalendar` / the `ExecStart` path (`/opt/streamhub` vs
`/opt/streamhub-core`) in the unit for your host.

### cron (alternative)

```cron
# /etc/cron.d/streamhub-backup  — daily 03:15
15 3 * * *  root  BACKUP_DATA_DIR=/opt/streamhub-core/data BACKUP_S3_BUCKET=my-streamhub-backups /opt/streamhub-core/deploy/backup.sh >> /var/log/streamhub-backup.log 2>&1
```

---

## Restore — step by step (tested procedure)

`deploy/restore.sh` fetches a backup (S3 or local), **verifies every DB with
`PRAGMA integrity_check`**, then — after an explicit confirmation and after snapshotting the
current target so the restore is itself reversible — copies the DBs + `secrets.json` into the
target `DATA_DIR`.

```bash
# 1. See what's available
deploy/restore.sh --list

# 2. STOP the core first (writing DBs under a live core is unsafe)
docker compose stop core          # compose deploys
#   or:  sudo systemctl stop streamhub-core        # plain-server

# 3. Restore (interactive: type the target path to confirm)
BACKUP_S3_BUCKET=my-streamhub-backups deploy/restore.sh \
  --from latest --target /opt/streamhub-core/data
#   --from 20260701T031500Z   # a specific backup
#   --from /path/to/x.tar.gz  # an explicit local file
#   --yes                     # non-interactive (automation only)

# 4. Start the core and confirm health
sudo systemctl start streamhub-core     # or: docker compose start core
curl -fsS http://127.0.0.1:3020/api/v1/health   # {"status":"ok",...}
```

What the script does internally, in order:

1. resolve the archive (`latest`, a timestamp substring, or an explicit file);
2. download (if S3) → extract to a temp dir;
3. **verify**: `PRAGMA integrity_check` on each `*.db` — aborts on any failure;
4. confirm (type the exact target path) unless `--yes`;
5. snapshot the current target into `<target>/pre-restore-<UTC>/` (rollback point);
6. copy `streamhub.db`, every `apps/<app>/app.db`, and `secrets.json` (re-chmod 600) into place.

If a restore goes wrong, the previous state is in `<target>/pre-restore-<UTC>/` — stop the
core, copy those files back, start it again.

Exit codes: `0` ok · `1` usage · `2` preflight · `3` not found · `4` verify failed ·
`5` aborted by user.

### Verifying a backup without touching prod (conceptual test)

You don't need a spare server to prove a backup is good:

```bash
# Restore the latest backup into a throwaway dir (no prod paths touched)
mkdir -p /tmp/sh-restore-test
BACKUP_S3_BUCKET=my-streamhub-backups \
  deploy/restore.sh --from latest --target /tmp/sh-restore-test --yes

# Inspect it: integrity + that the expected rows are there
sqlite3 /tmp/sh-restore-test/streamhub.db 'PRAGMA integrity_check;'      # -> ok
sqlite3 /tmp/sh-restore-test/streamhub.db 'SELECT count(*) FROM apps;'   # -> N apps
for db in /tmp/sh-restore-test/apps/*/app.db; do
  echo "$db:"; sqlite3 "$db" 'SELECT count(*) FROM streams;'
done
rm -rf /tmp/sh-restore-test
```

The script already ran `integrity_check` during restore; this second pass plus the row counts
confirms the data (not just the file) survived the round-trip. Do this on a schedule (e.g. a
monthly ops task) so backups are proven, not assumed.

---

## RPO / RTO

- **RPO (max data loss):** the backup interval — **≤ 24h** with the daily timer. Tighten by
  adding `OnCalendar` entries (e.g. every 6h) if the write volume warrants it. Recordings/VODs
  are unaffected (they live in S3 independently).
- **RTO (time to recover):** dominated by download + copy of a few small SQLite files, so
  typically **a few minutes** (stop core → restore → start core → health-check). It scales with
  DB size and S3 download speed, not with the number of apps.
