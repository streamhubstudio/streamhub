# Operations — Deploy

Two supported shapes for the same single-node architecture:

- **A. Docker Compose + Caddy** — the OSS quick-install (recommended). One command, auto-TLS.
- **B. systemd + nginx + certbot** — bare-metal / VPS path.

Both need a **Linux host with a public IP**. LiveKit uses host networking for UDP media +
STUN external-IP detection, so Docker Desktop on macOS is not a target.

---

## 0. Build artifacts

The deployable is the NestJS **core** (which also serves the compiled React **web** SPA),
the LiveKit stack (server + ingress + egress + redis), and the browser SDK.

```bash
# streamhub-core (the brain + SPA host)
cd streamhub-core
npm ci
npm run build          # → dist/ (nest build); runtime entry: node dist/main.js

# streamhub-web (React SPA) — built and its dist/ is served by core as static assets
cd ../streamhub-web
npm ci && npm run build # → dist/ (Vite + Tailwind)

# streamhub-adaptor (browser SDK) — the drop-in AntMedia WebRTCAdaptor shim
cd ../streamhub-adaptor
npm ci && npm run build # → dist/streamhub-adaptor.global.js
```

In Docker Compose these builds happen inside the image (`deploy/Dockerfile`); you don't run
them by hand.

---

## A. Docker Compose + Caddy (recommended)

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
6. waits for core health, then **seeds the global API token** into the DB (`deploy/seed-token.js`);
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

A bare-metal / VPS deploy (Ubuntu). LiveKit + core run as **systemd units**,
ingress/egress as **Docker containers**, redis native, TLS via **nginx + certbot**.

> On this shape TLS is nginx + certbot's own `certbot.timer` for renewal — nothing else
> manages SSL here, so let certbot own it.

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
3. **streamhub-core**
   ```bash
   cd streamhub-core && npm ci && npm run build
   # deploy/streamhub-core.service → /etc/systemd/system/  (ExecStart: node dist/main.js, bind 127.0.0.1:3020)
   # env in the unit / EnvironmentFile — see operations/ENV.md
   systemctl enable --now streamhub-core
   ```
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
5. **Seed the global API token** (idempotent): `node deploy/seed-token.js`.
6. **Cert renewal**: keep `certbot.timer` active plus a backup cron
   `0 3 * * * certbot renew --quiet && systemctl reload nginx`.

### B.7 Redeploys — `deploy/deploy-core.sh` (secure, no hardcoded secrets)

The old `deploy-streamhub.sh` baked secrets into the script (it's gitignored — never commit
it). Its replacement **`deploy/deploy-core.sh`** never takes or writes secrets: it reuses the
`.env` that already lives in `APP_DIR`, backs up first, then ships new code and restarts.

```bash
# On the build side: tar the core source at the archive root
tar czf /tmp/core.tgz -C streamhub-core .
scp /tmp/core.tgz deploy@your-server:/tmp/

# On the host:
APP_DIR=/opt/streamhub-core SERVICE_NAME=streamhub-core \
  deploy/deploy-core.sh /tmp/core.tgz
```

It (1) checks `APP_DIR/.env` exists (aborts rather than invent secrets), (2) runs
`deploy/backup.sh` (aborts the deploy if the backup fails — override with `--skip-backup`),
(3) `tar`-overlays the new code onto `APP_DIR` (never touching `.env`, `data/`, `apps/`,
`logs/`), (4) `npm ci && npm run build`, (5) `systemctl restart "$SERVICE_NAME"` and waits for
`/api/v1/health`. Defaults: `APP_DIR=/opt/streamhub-core`, `SERVICE_NAME=streamhub-core`,
`BACKUP_DATA_DIR=<APP_DIR>/data`, `PORT=3020`. See
[`BACKUPS.md`](./BACKUPS.md) for the backup/restore details.

---

## DB migration — automatic, idempotent, backed up

Migrations run **at core boot** (`DbService.init`); you never run them manually. They:

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

The Docker image does this during build. A missing file simply 404s — sample pages then fall
back to plain `livekit-client`, so this step is non-fatal but recommended.

---

## (Re)generate per-app sample pages

Each app scaffolds `apps/<app>/samples/` (`publish.html`, `play.html`, `embed.html`,
`meeting.html`) with the public embeddable URLs, served auth-less at `/samples/<app>/<file>`.
They are (re)generated when an app is created and can be regenerated for an existing app via
the apps/samples API (see the `api-app.md` docs). After changing `PUBLIC_WS_URL`,
`RTMP_PUBLIC_HOST` or the public base URL, regenerate samples so the embedded URLs match.

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
