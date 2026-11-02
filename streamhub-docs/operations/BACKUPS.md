# Operations — Backups & Restore

StreamHub's durable state is small and file-based: a handful of SQLite DBs plus one secrets
file. Two complementary layers protect it:

1. **In-app backup system (built-in)** — the core itself takes daily, versioned,
   gzip-compressed snapshots of every SQLite DB and exposes a superadmin **restore button**
   in the dashboard. Zero setup, on by default. See the next section.
2. **Host-level scripts** — `deploy/backup.sh` snapshots the DBs **plus `secrets.json`**,
   tar+gzips them with a UTC timestamp, optionally ships them **off-box to S3**, and prunes
   old copies; `deploy/restore.sh` brings one back. Use this for off-site/disaster recovery.

---

## In-app backup system (built-in, dashboard)

Module: `streamhub-core-go/internal/backups/` (wired by the ops plane; a flock on `<backupDir>/.lock` keeps two processes on one `DATA_DIR` from snapshotting concurrently).
UI: dashboard → **Settings → Database backups** (superadmin only).

### What a snapshot is

- Covers **every** SQLite DB: the global registry (`data/streamhub.db`) and each per-app DB
  (`apps/<app>/app.db`). Media files, `secrets.json` and `config.yaml` are NOT included
  (recordings/VODs live in the app's S3; for secrets use the host-level script below).
- Taken with SQLite's **safe hot-backup**: `VACUUM INTO` a temp file — consistent through the
  WAL even while the core is writing. A raw `cp` of a live DB is **never** done.
- gzip-compressed and atomically renamed into place:

```
<DATA_DIR>/backups/
  streamhub/                      # the global registry (data/streamhub.db)
    2026-07-06T03-30-00-000Z.db.gz
    2026-07-05T03-30-00-000Z.db.gz
  app-live/                       # apps/live/app.db
    2026-07-06T03-30-00-000Z.db.gz
    2026-07-06T14-02-11-482Z.pre-restore.db.gz   # auto safety copy (see below)
```

- The filename **is** the version stamp (UTC ISO time with `:`/`.` → `-`);
  `.pre-restore` marks the automatic safety copy created before a restore.
- Coexists with the host-level tarballs (`BACKUP_LOCAL_DIR` defaults to the same
  `<DATA_DIR>/backups` root): the in-app system only manages its per-DB **subdirectories**,
  the script only manages its `*.tar.gz` files.

### Schedule + retention

- A daily in-process cron job (`STREAMHUB_BACKUP_CRON`, default `30 3 * * *`) snapshots
  every DB, then prunes snapshots older than `STREAMHUB_BACKUP_RETENTION_DAYS`
  (default **7**; `0` = never prune). Pruning also covers dirs of deleted apps.
- A **catch-up** run fires at boot when the newest snapshot is older than ~26 h
  (server was off at the scheduled time).
- Redis down / scheduler init failure never crashes boot — on-demand backups via the API
  keep working.
- Env (`.env.example` + [ENV.md → Backups](ENV.md#backups-sqlite-snapshots)):
  `STREAMHUB_BACKUPS_ENABLED` (default on), `STREAMHUB_BACKUP_RETENTION_DAYS` (7),
  `STREAMHUB_BACKUP_DIR` (`<DATA_DIR>/backups`), `STREAMHUB_BACKUP_CRON` (`30 3 * * *`).

### API (superadmin / global scope only)

All under `/api/v1`, `Authorization: Bearer <global sk_ token or admin JWT>`. App-scoped
tokens get `403` on every endpoint.

| Method | Path | What |
|---|---|---|
| GET | `/system/backups` | Settings + per-DB snapshot inventory (file, size, timestamp, pre-restore flag). Dirs of deleted apps show as `orphaned`. |
| POST | `/system/backups` | Back up every DB **now** (+ prune). Returns the run summary incl. per-DB errors. |
| POST | `/system/backups/restore` | Restore one snapshot over the live DB. Body: `{ "db": "streamhub" \| "app-<name>", "snapshot": "<file>", "confirm": true }`. |

```bash
# list
curl -H "Authorization: Bearer $TOK" https://<host>/api/v1/system/backups
# backup now
curl -X POST -H "Authorization: Bearer $TOK" https://<host>/api/v1/system/backups
# restore (destructive!)
curl -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"db":"app-live","snapshot":"2026-07-06T03-30-00-000Z.db.gz","confirm":true}' \
  https://<host>/api/v1/system/backups/restore
```

### Restore safety sequence

Restoring **overwrites a live database** — the flow is deliberately paranoid:

1. **Explicit confirm** — `confirm: true` in the body (the dashboard dialog additionally
   makes you type the confirmation phrase).
2. **Name validation** — `db` must resolve to a registered target, `snapshot` must match the
   stamp pattern inside that DB's snapshot dir (no path traversal possible).
3. **Integrity gate** — the snapshot is gunzipped to a temp file **next to the live DB** and
   opened read-only; anything but `PRAGMA integrity_check` = `ok` (or a non-SQLite /
   corrupt-gzip file) aborts with `400` — the live DB stays untouched, byte for byte.
4. **Automatic safety copy** — a fresh `.pre-restore` snapshot of the *current* live DB is
   taken first. Restored the wrong thing? Restore the safety copy.
5. **Atomic swap** — the validated copy is written into the live DB with SQLite's
   **online-backup API**, which is atomic for every open connection (the shared handles stay
   valid; no request can see a half-swapped file). App DBs are then reopened, so the numbered
   migrations re-run and an **older** snapshot is upgraded to the current schema
   automatically. (The 2.x Node core did checkpoint → close → `rename()` → reopen.)
6. **Audit log** — a `warn`-level `backups` entry in `server_logs` records the actor,
   snapshot and safety-copy name.

#### Restoring the GLOBAL registry — restart recommended

`app-<name>` restores are fully transparent (the per-app handle is closed and reopened).
Restoring **`streamhub`** (the global registry) also swaps the handle safely and the API
keeps working, **but** long-lived in-memory state derived from that DB — casbin RBAC
policies, tenancy/quota caches, the cluster nodes view — refreshes only on process restart.
The response flags this (`restartRecommended: true`) and the dashboard tells you to run:

```bash
docker compose restart core        # compose install
sudo systemctl restart skyline-core  # plain-server (historical unit name)
```

No restart is *required* for the swap itself (handles are reopened in-place); it is
recommended so every cached consumer of the old data becomes consistent.

### Disaster path (core won't boot)

Snapshots are plain gzipped SQLite files — no tooling needed:

```bash
cd $DATA_DIR
cp data/streamhub.db data/streamhub.db.broken   # keep the evidence
gunzip -c backups/streamhub/<stamp>.db.gz > data/streamhub.db
rm -f data/streamhub.db-wal data/streamhub.db-shm
docker compose restart core
```

Same shape for an app DB → `apps/<app>/app.db`.

---

## Host-level backups (`deploy/backup.sh` / `deploy/restore.sh`)

### What gets backed up

Everything lives under the host **`DATA_DIR`** (the dir bind-mounted to `/data` in the
containers, `STREAMHUB_HOST_DATA_DIR`; on the plain-server it's the `DATA_DIR` of the core's
`.env` — `deploy/deploy-core.sh` passes exactly that as `BACKUP_DATA_DIR`):

| Item | Path (under `DATA_DIR`) | Why |
|---|---|---|
| Global DB | `data/streamhub.db` | tenants, users, `api_tokens`, `apps`, nodes registry |
| Per-app DBs | `apps/<app>/app.db` | streams, vods, `ingress_auth` — one per app |
| Per-app secrets | `data/secrets.json` (chmod 600) | per-app S3 credentials referenced from `config.yaml` |

The archive mirrors that layout under `data/` (`data/data/streamhub.db`,
`data/apps/<app>/app.db`, `data/data/secrets.json`). Archives written before this fix used a
flat `data/streamhub.db` / `data/secrets.json` (and, on the real layout, silently missed the
global DB and the secrets — re-take a backup); `restore.sh` reads both shapes. A pre-2.x flat
`DATA_DIR` (`streamhub.db` directly under it) is still picked up as a fallback.

**Not** backed up (regenerable or bulky): recordings/HLS/snapshots (already in the app's S3
bucket), `logs/`, `redis/`, the served `sdk/`, `node_modules`.

### Consistency — how the snapshot is taken

Each `*.db` is copied with `sqlite3 <db> "VACUUM INTO '<dst>'"`, which produces a compacted,
**WAL-safe** single-file snapshot of a committed state — the same technique the core uses
before its boot-time migration (`streamhub-core-go/internal/platform/db`). We never `tar`
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
BACKUP_DATA_DIR=/opt/skyline-core/data \
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
BACKUP_DATA_DIR=/opt/skyline-core/data
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
`/opt/skyline-core`) in the unit for your host.

### cron (alternative)

```cron
# /etc/cron.d/streamhub-backup  — daily 03:15
15 3 * * *  root  BACKUP_DATA_DIR=/opt/skyline-core/data BACKUP_S3_BUCKET=my-streamhub-backups /opt/skyline-core/deploy/backup.sh >> /var/log/streamhub-backup.log 2>&1
```

---

## Restore — step by step (tested procedure)

`deploy/restore.sh` fetches a backup (S3 or local), **verifies every DB with
`PRAGMA integrity_check`**, then — after an explicit confirmation and after snapshotting the
current target so the restore is itself reversible — copies the DBs + `data/secrets.json` into
the target `DATA_DIR`.

```bash
# 1. See what's available
deploy/restore.sh --list

# 2. STOP the core first (writing DBs under a live core is unsafe)
docker compose stop core          # compose deploys
#   or:  sudo systemctl stop skyline-core        # plain-server

# 3. Restore (interactive: type the target path to confirm)
BACKUP_S3_BUCKET=my-streamhub-backups deploy/restore.sh \
  --from latest --target /opt/skyline-core/data
#   --from 20260701T031500Z   # a specific backup
#   --from /path/to/x.tar.gz  # an explicit local file
#   --yes                     # non-interactive (automation only)

# 4. Start the core and confirm health
sudo systemctl start skyline-core     # or: docker compose start core
curl -fsS http://127.0.0.1:3020/api/v1/health   # {"status":"ok",...}
```

What the script does internally, in order:

1. resolve the archive (`latest`, a timestamp substring, or an explicit file);
2. download (if S3) → extract to a temp dir;
3. **verify**: `PRAGMA integrity_check` on each `*.db` — aborts on any failure;
4. confirm (type the exact target path) unless `--yes`;
5. snapshot the current target into `<target>/pre-restore-<UTC>/` (rollback point);
6. copy `data/streamhub.db`, every `apps/<app>/app.db`, and `data/secrets.json` (re-chmod 600)
   into place, dropping any stale `-wal`/`-shm` next to a replaced DB (they would be replayed
   over the restored file on the next open).

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
