# Operations — Deploy

Two supported shapes for the same single-node architecture:

- **A. Docker Compose + Caddy** — the OSS quick-install (recommended). One command, auto-TLS.
- **B. systemd + nginx + certbot** — plain-server / Ploi path (e.g. `media01`).

Both need a **Linux host with a public IP**. LiveKit uses host networking for UDP media +
STUN external-IP detection, so Docker Desktop on macOS is not a target.

---

## 0. Build artifacts

The deployable is the **Go core** (`streamhub-core-go/` → one static binary, `streamhub-core`,
which also serves the compiled React **web** SPA), the LiveKit stack (server + ingress +
egress + redis), and the browser SDK. The 2.x NestJS core is no longer deployed nor in the
tree (branch `legacy/node-2.x`, tag `2.24.0`).

```bash
# streamhub-core-go (the brain + SPA host) — static, no runtime deps beyond ffmpeg/python3
cd streamhub-core-go
CGO_ENABLED=0 go build -trimpath -o bin/streamhub ./cmd/streamhub   # → bin/streamhub

# streamhub-web (React SPA) — its dist/ is served by the core from ./web next to the binary
cd ../streamhub-web
npm ci && npm run build # → dist/ (Vite + Tailwind)

# streamhub-adaptor (browser SDK) — the drop-in AntMedia WebRTCAdaptor shim
cd ../streamhub-adaptor
npm ci && npm run build # → dist/streamhub-adaptor.global.js
```

In Docker Compose these builds happen inside the image (`deploy/Dockerfile`); you don't run
them by hand. For the plain-server shape, `deploy/make-core-bundle.sh` does all three and
packs `dist/streamhub-core-<version>-linux-amd64.tar.gz` (binary + `web/` + SDK +
`plugins-vendor/`; the stream-health worker is the binary's own `health-worker`
subcommand), the artifact `deploy/deploy-core.sh` installs.

Decoupled Studio Apps are composed **before** either build with
`streamhub-core apps pull` — from a checkout `(cd streamhub-core-go && go run ./cmd/streamhub apps pull)`
(needs `STREAMHUB_APPS_TOKEN`; no Node); without it the core ships with
the in-tree built-ins only.

---

## A. Docker Compose + Caddy (recommended)

> The app installs as one self-contained folder managed as one service (the
> `streamhub` CLI + a systemd unit), with an idempotent, backed-up **upgrade**
> path on re-run. Full layout, CLI reference, upgrade/rollback and the release
> pipeline live in [INSTALL.md](./INSTALL.md); this section is the quick-start.

### A.1 One-liner installer

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
```

`install.sh` is idempotent and does:

1. checks prerequisites (docker + compose plugin, openssl, curl);
2. clones the repo if run standalone (into `./vision-media-server`);
3. prompts for `STREAMHUB_DOMAIN`, `ADMIN_PASS`, `ACME_EMAIL` (or reuses an existing `.env`;
   pre-set any of `STREAMHUB_DOMAIN`/`ADMIN_USER`/`ADMIN_PASS`/`ACME_EMAIL` in the env to run
   non-interactively);
4. generates a `.env` with strong random secrets: `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`,
   `STREAMHUB_JWT_SECRET`, `ADMIN_PASS`, `STREAMHUB_API_TOKEN` (`sk_…`);
5. builds + starts the stack: `docker compose up -d --build` (clamping `EGRESS_CPUS` to
   `min(nproc, 4)` first, so a host with fewer than 4 vCPUs doesn't hard-fail the compose-up);
6. waits for core health, then **seeds the global API token** into the DB
   (`docker compose exec -T core streamhub-core seed-token - bootstrap`, token on stdin);
7. installs a `streamhub-heartbeat.service`/`.timer` (every 60s, `POST /cluster/heartbeat`) so the
   node stays live in the cluster registry without a manual cron workaround — see
   [operations/INSTALL-NODE.md](./INSTALL-NODE.md) and
   [architecture/cluster.md](../architecture/cluster.md#node-liveness-heartbeat--self-registration).

A bare IP passed as `STREAMHUB_DOMAIN` (or `--no-tls`) now drives a **real** no-TLS mode end to
end (`http://`/`ws://` URLs, plain-HTTP Caddy/nginx, no ACME attempt) instead of only skipping
certbot.

### A.2 Manual Compose

```bash
cp .env.example .env      # then edit — see operations/ENV.md
docker compose up -d --build
docker compose ps         # redis, livekit, ingress, egress, core, caddy → healthy
```

Compose services (`docker-compose.yml`): `redis` (7-alpine), `livekit`
(`livekit/livekit-server:v1.8.4`), `ingress`, `egress`, `core` (`streamhub-core:local`,
built from `deploy/Dockerfile`), `caddy` (2-alpine, `deploy/Caddyfile`, auto-TLS). Caddy
routes `/rtc`→LiveKit and everything else→core on one TLS vhost.

For a full walk-through see [`self-hosting.md`](./self-hosting.md).

---

## B. systemd + nginx + certbot (plain-server)

Used on `media01` (VPS, Ploi-managed, Ubuntu). LiveKit + core run as **systemd units**,
ingress/egress as **Docker containers**, redis native, TLS via **nginx + certbot**.

> On a Ploi **plain-server** there is no Ploi-managed web stack, so TLS is nginx+certbot's
> own `certbot.timer` — there is no Ploi renewal cron to break here. (On Ploi-managed sites,
> always let Ploi own SSL.)

1. **Base + LiveKit**
   ```bash
   apt-get install -y redis-server ffmpeg nginx certbot python3-certbot-nginx
   curl -sSL https://get.livekit.io | bash        # livekit-server
   curl -sSL https://get.livekit.io/cli | bash    # lk CLI
   livekit-server generate-keys                   # → API_KEY / API_SECRET
   # deploy/livekit.yaml   → /etc/livekit/livekit.yaml     (chmod 600)
   # deploy/livekit.service→ /etc/systemd/system/livekit.service
   systemctl enable --now livekit
   ```
2. **ingress + egress (Docker, host net)**
   ```bash
   curl -fsSL https://get.docker.com | sh
   docker run -d --name ingress --restart unless-stopped --network host \
     -e INGRESS_CONFIG_BODY="$(cat deploy/ingress.yaml)" livekit/ingress:latest
   docker run -d --name egress  --restart unless-stopped --network host --shm-size=1g \
     -e EGRESS_CONFIG_BODY="$(cat deploy/egress.yaml)" \
     -v "$DATA_DIR:/data" livekit/egress:latest
   ```
3. **streamhub-core** (Go binary — no Node/npm on the host)
   ```bash
   apt-get install -y ffmpeg python3 python3-venv   # media tools + decoupled-app workers
   # on the build side: deploy/make-core-bundle.sh  → dist/streamhub-core-<ver>-linux-amd64.tar.gz
   mkdir -p /home/ploi/streamhub-core && tar -xzf streamhub-core-*.tar.gz -C /home/ploi/streamhub-core
   # .env → /home/ploi/streamhub-core/.env (see operations/ENV.md)
   # deploy/streamhub-core.service → /etc/systemd/system/
   #   (ExecStart: <APP_DIR>/streamhub-core, bind 127.0.0.1:3020)
   systemctl enable --now streamhub-core
   ```
   Later upgrades go through `deploy/deploy-core.sh` (B.7).
4. **nginx + TLS**
   ```bash
   cp deploy/nginx-streamhub.conf /etc/nginx/sites-available/streamhub.example.com
   ln -s /etc/nginx/sites-available/streamhub.example.com /etc/nginx/sites-enabled/
   rm -f /etc/nginx/sites-enabled/default
   nginx -t && systemctl reload nginx
   certbot --nginx -d streamhub.example.com --redirect -m "$ACME_EMAIL" --agree-tos -n
   ```
   The vhost proxies `/api/`, `/hls/`, `/sdk/`, `/samples/` and `/` to `127.0.0.1:3020`, and
   `/rtc` (WebSocket upgrade) to `127.0.0.1:7880`. **`/metrics` is denied from the outside**
   (`location = /metrics { deny all; return 403; }` in `deploy/nginx-streamhub.conf`, which
   `install.sh` copies verbatim) — Prometheus scrapes the core locally at
   `127.0.0.1:3020/metrics`.
5. **Seed the global API token** (idempotent):
   `grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2 | DATA_DIR=<DATA_DIR> ./streamhub-core seed-token - bootstrap`.
6. **Cert renewal**: keep `certbot.timer` active plus a backup cron
   `0 3 * * * certbot renew --quiet && systemctl reload nginx`.

### B.7 Redeploys — `deploy/deploy-core.sh` (secure, no hardcoded secrets)

The old `deploy-streamhub.sh` baked secrets into the script (it's gitignored — never commit
it). Its replacement **`deploy/deploy-core.sh`** never takes or writes secrets: it reuses the
`.env` that already lives in `APP_DIR`, backs up first, then installs a new core bundle and
restarts.

```bash
# On the build side (go + node/npm): binary + SPA + SDK + composed apps in one tarball
deploy/make-core-bundle.sh                 # → dist/streamhub-core-<ver>-linux-amd64.tar.gz
scp dist/streamhub-core-*-linux-amd64.tar.gz deploy@media01:/tmp/

# On the host (root — it writes a systemd drop-in):
APP_DIR=/opt/skyline-core SERVICE_NAME=skyline \
  deploy/deploy-core.sh /tmp/streamhub-core-<ver>-linux-amd64.tar.gz
```

It (1) checks `APP_DIR/.env` exists (aborts rather than invent secrets), (2) runs
`deploy/backup.sh` (aborts the deploy if the backup fails — override with `--skip-backup`),
(3) unpacks the bundle, verifies the binary checksum and that it runs on this host, then swaps
in `streamhub-core` (atomic rename), `web/`, `plugins-vendor/`, `VERSION`
and publishes the SDK into `<DATA_DIR>/sdk` — never touching `.env`, `data/`, `apps/`,
`logs/`; (3b) provisions the **Python worker runtime** — see below; (4) writes the systemd drop-in
`/etc/systemd/system/<service>.service.d/10-go-core.conf` (`ExecStart=<APP_DIR>/streamhub-core`,
`UMask=0002`, and `PLUGIN_PYTHON=<APP_DIR>/venv/bin/python` when the venv
exists) — idempotent (`--no-unit` skips it); (5) `systemctl restart "$SERVICE_NAME"` and
waits for `/api/v1/health`. Defaults: `APP_DIR=/opt/skyline-core`, `SERVICE_NAME=skyline`,
`BACKUP_DATA_DIR` = the `.env` `DATA_DIR` (else `APP_DIR`), `PORT` from the `.env` (else 3020). See
[`BACKUPS.md`](./BACKUPS.md) for the backup/restore details.

**Python worker runtime (step 3b).** The decoupled apps' workers spawn
`$PLUGIN_PYTHON -m <worker>`; with the system `python3` they die on `import cv2`. The script
mirrors the image (`deploy/Dockerfile`): it creates a venv at `<APP_DIR>/venv` (installing
`python3-venv` via apt if needed) and pip-installs the worker `requirements.txt` of the apps
selected by `WORKER_DEPS` / `--worker-deps` — a comma list of app ids
(`deface,people-counter`), `all`, or `0` (venv only). Default `deface`, like the image's
`INSTALL_VENDORED_WORKER_DEPS`: the ultralytics-based apps (yolo, people-counter, presence,
safety-ppe, the four vision apps) pull CPU torch (~1 GB+), so they are opt-in. When a selected
app needs torch, the **CPU** build is installed first (from the PyTorch CPU index) so pip
doesn't resolve the CUDA one; and since ultralytics depends on the GUI `opencv-python` (which
needs `libGL`, absent on servers and shadowing `opencv-python-headless`'s `cv2`), it is swapped
back to `opencv-python-headless` afterwards. Idempotent: the venv is reused and pip only re-runs
when the selection, the Python version or a `requirements.txt` changes (stamp
`<APP_DIR>/venv/.streamhub-worker-deps`; pip output in `<APP_DIR>/logs/worker-venv-pip.log`). A
pip failure warns but does not abort the core deploy. `--no-venv` skips the step (an existing
venv stays wired). Adding an app later: re-run with the new list, e.g.
`WORKER_DEPS=deface,people-counter deploy/deploy-core.sh <bundle>`.

**Upgrading a 2.x (Node) plain-server install to 3.x (Go):** run the same command. The drop-in
overrides the unit's `node dist/main.js` while keeping its `User`, `EnvironmentFile` and
`DATA_DIR`; the Go core opens the 2.x SQLite schema as-is (no migration step). The old
`dist/` + `node_modules/` stay in `APP_DIR`, so **rollback** = `rm` the drop-in,
`systemctl daemon-reload && systemctl restart <service>`.

---

## DB migration — automatic, idempotent, backed up

Migrations run **at core boot** (`internal/platform/db`, the same numbered DDL the 2.x core
applied — a 2.x `DATA_DIR` opens unchanged); you never run them manually. They:

- create `data/streamhub.db` (global) and seed the default `live` app on a fresh install;
- apply `GLOBAL_MIGRATIONS`, idempotent `GLOBAL_COLUMN_ADDS` and `GLOBAL_TENANCY_BACKFILL`;
- open each `apps/<app>/app.db` lazily and apply `APP_MIGRATIONS`, importing any legacy
  `apps/<app>/vods.db` (left in place as a backup);
- perform the **per-app split** (streams/vods/ingress_auth global→`app.db`) **once**, guarded
  by a marker in `_streamhub_meta`, after taking a `VACUUM INTO` **backup** of the global DB
  as `streamhub.db.bak-<timestamp>`.

Everything is `CREATE TABLE IF NOT EXISTS` + copy-if-absent, so **re-running is safe**
(re-deploys, restarts, re-run installer). Rolling forward = deploy the new build and restart
core; migrations self-apply. See
[`../architecture/data-model.md`](../architecture/data-model.md).

---

## Copy the browser SDK to `/sdk`

Core serves the SDK statically from `SDK_DIR` (default `<DATA_DIR>/sdk`) at
`/sdk/streamhub-adaptor.global.js`. On deploy, place the built adaptor there:

```bash
cp streamhub-adaptor/dist/streamhub-adaptor.global.js "$DATA_DIR/sdk/"
```

The Docker entrypoint does this at every boot; `deploy/deploy-core.sh` does it on the
plain-server shape. A missing file simply 404s — sample pages then fall
back to plain `livekit-client`, so this step is non-fatal but recommended.

---

## (Re)generate per-app sample pages

Each app scaffolds `apps/<app>/samples/` (`publish.html`, `play.html`, `embed.html`,
`meeting.html`) with the public embeddable URLs, served auth-less at `/samples/<app>/<file>`.
They are (re)generated when an app is created and can be regenerated for an existing app via
the apps/samples API (see the `api-app.md` docs). After changing `PUBLIC_WS_URL`,
`RTMP_PUBLIC_HOST` or the public base URL, regenerate samples so the embedded URLs match.

---

## Own origin for samples

Sample pages are tenant-editable HTML/JS. On the dashboard's origin they could read the
dashboard session (JWT in localStorage), so by default editing them is superadmin-only. Give
them a second hostname and they run isolated, and owners/editors may edit them again
([features/samples.md](../features/samples.md#own-origin-for-samples-streamhub_samples_url)).

1. **DNS:** an A record for the samples host (e.g. `samples.example.com`) → this server
   (DNS-only, like the main domain).
2. **Proxy** — forward it to the core **with the original `Host`**:
   - *Docker/Caddy:* `SAMPLES_DOMAIN=samples.example.com` in `.env` (Caddy's second site in
     `deploy/Caddyfile`, auto-TLS), then `docker compose up -d caddy`.
   - *nginx:* `deploy/nginx-samples.conf` (replace `samples.example.com`) →
     `sites-available/` + `sites-enabled/`, `nginx -t && systemctl reload nginx`, then
     `certbot --nginx -d samples.example.com --redirect`.
   - *Installer:* `install.sh --samples-domain samples.example.com` does both, plus step 3.
3. **Core:** `STREAMHUB_SAMPLES_URL=https://samples.example.com` (and `PUBLIC_BASE_URL` set to
   the dashboard URL, which the samples host redirects to), then restart the core.
4. **Check:**
   ```bash
   curl -sI https://streamhub.example.com/samples/<app>/webrtc-play.html | grep -i location  # 302 → samples host
   curl -sI https://samples.example.com/ | grep -i location                                   # 302 → dashboard
   curl -s  https://samples.example.com/api/v1/auth/config                                     # "samplesUrl":"https://samples.example.com"
   ```
   Untouched standard pages are moved onto the new origin at boot; regenerate edited ones from
   the dashboard (Samples → Regenerate) so they call the API same-origin.

Rollback: unset `STREAMHUB_SAMPLES_URL` and restart — samples are served on the dashboard
origin again and `sample:write` goes back to superadmin-only (pages already rendered against
the samples host keep its URLs: regenerate them).

---

## Post-deploy smoke test

```bash
curl -s https://streamhub.example.com/api/v1/health          # {"status":"ok",...}
# /metrics is denied at the vhost (403); scrape it locally on the host:
curl -s http://127.0.0.1:3020/metrics | grep streamhub_
# authed:
curl -s -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://streamhub.example.com/api/v1/stats
# Swagger UI:  https://streamhub.example.com/api/v1/docs
```

Then exercise a real path: create an app, push RTMP (`ffmpeg … -f flv
rtmp://HOST:1935/live/<key>`), see it in `/streams`, start recording, confirm the VOD lands
in the app's S3 bucket as `ready` with a working presigned URL. Full checklist lives with the
testing docs.
