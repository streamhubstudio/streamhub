# Self-hosting StreamHub with Docker

This is the containerized quick-install. For the manual, bare-metal runbook (systemd + nginx,
no Docker) see [`../INSTALL.md`](../INSTALL.md). For the API, see
[`../streamhub-docs/`](../streamhub-docs/README.md).

## 1. Requirements

- A **Linux server with a public IP** (an OVH/Hetzner/DO VM, etc.). Host networking is used for
  LiveKit's UDP media + STUN external-IP detection, so this is Linux-only (not Docker Desktop).
- **Docker** + the **Docker Compose v2** plugin (`docker compose version`).
- For a real domain: a DNS `A` record (DNS-only — do **not** proxy through Cloudflare, WebRTC is
  UDP) and these firewall ports open:

  | Port | Proto | Purpose |
  |---|---|---|
  | 80, 443 | tcp | Caddy: dashboard + API + `/rtc` signaling (auto-TLS) |
  | 7880 | tcp | LiveKit signaling/API |
  | 7881 | tcp | LiveKit TCP fallback |
  | 7882 | udp | LiveKit media (single mux port) |
  | 1935 | tcp | Ingress RTMP |

## 2. Install

### One-liner

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
```

It will:
1. check prerequisites, clone the repo into `./vision-media-server`;
2. prompt for **domain**, **admin user/password**, **ACME email** (or reuse an existing `.env`);
3. generate a `.env` with random `LIVEKIT_API_KEY/SECRET`, `STREAMHUB_JWT_SECRET`, `ADMIN_PASS`
   and a global `STREAMHUB_API_TOKEN` (`sk_...`);
4. `docker compose up -d --build`;
5. wait for `core` health, then seed the API token into the DB;
6. print the dashboard URL, login and token.

Non-interactive (CI/automation): pre-set `STREAMHUB_DOMAIN`, `ADMIN_USER`, `ADMIN_PASS`,
`ACME_EMAIL` in the environment and the prompts are skipped.

### Manual

```bash
git clone https://github.com/streamhubstudio/streamhub.git vision-media-server
cd vision-media-server
cp .env.example .env      # fill in STREAMHUB_DOMAIN, ACME_EMAIL, secrets
docker compose up -d --build
docker compose exec -T core node deploy/seed-token.js "$(grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2)"
```

## 3. Verify

```bash
curl http://127.0.0.1:3020/api/v1/health                  # {"status":"ok",...}
curl -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://<domain>/api/v1/stats
# dashboard: https://<domain>/   (login: ADMIN_USER / ADMIN_PASS)
# swagger:   https://<domain>/api/v1/docs
```

## 4. How the stack fits together

`docker-compose.yml` runs six services, all on the host network so they reach each other over
`127.0.0.1` (the LiveKit-recommended layout for media):

- **redis** — coordinates ingress/egress and backs BullMQ job queues.
- **livekit** — the SFU. Config comes from `LIVEKIT_CONFIG_BODY` (compose substitutes your keys
  from `.env`); a webhook points at `core` at `/api/v1/webhooks/livekit`.
- **ingress** / **egress** — RTMP/WHIP ingest and room-composite recording. **Egress bind-mounts
  the data dir at the same path the core uses** (`DATA_DIR`, default `/data`) so the MP4 it writes
  lands exactly where core looks to upload it to S3.
- **core** — built from `deploy/Dockerfile` (bundles the React SPA and the browser SDK). Serves
  the API + SPA on `:3020`, owns the SQLite DB and jobs.
- **caddy** — terminates TLS on `:80/:443`, routes `/rtc*` → LiveKit and everything else → core.

Persistent data:
- `STREAMHUB_HOST_DATA_DIR` (host, default `./data`) → `DATA_DIR` (`/data`) in core + egress:
  holds `data/streamhub.db`, `apps/<name>/{recordings,snapshots,hls,samples}`, `logs/`, `sdk/`.
- `./data/redis` → redis AOF.
- `caddy_data` / `caddy_config` volumes → ACME certs.

## 5. Per-app S3 (recording target)

The core seeds a default app `live`. Each app lives under
`data/apps/<name>/{config.yaml, vods.db, recordings/, snapshots/, samples/}`. S3 credentials are
**not** stored in the yaml — they go in `data/secrets.json` (chmod 600) and are referenced from
`config.yaml` (e.g. `APP_LIVE_S3_KEY` / `APP_LIVE_S3_SECRET`). Works with AWS S3, Wasabi or MinIO.

```bash
# inside STREAMHUB_HOST_DATA_DIR (default ./data)
echo '{"APP_LIVE_S3_KEY":"<key>","APP_LIVE_S3_SECRET":"<secret>"}' > data/secrets.json
chmod 600 data/secrets.json
docker compose restart core
```

See [`../streamhub-docs/config-reference.md`](../streamhub-docs/config-reference.md).

## 6. Ingest cheatsheet

- **WebRTC**: publish from the dashboard or via the `streamhub-adaptor` SDK.
- **RTMP**: `rtmp://<domain>:1935/<app>/<streamKey>`.
- **RTSP** (LiveKit ingress has no native RTSP pull): relay it as RTMP —
  `ffmpeg -rtsp_transport tcp -i rtsp://... -f flv rtmp://<domain>:1935/live/<key>`.
- **HLS playback**: `https://<domain>/hls/<app>/<room>/index.m3u8`.

## 7. Day-2 operations

```bash
docker compose ps                         # status
docker compose logs -f core               # tail core logs
docker compose restart core               # after editing .env
docker compose down                       # stop (keeps data + volumes)
git pull && docker compose up -d --build  # update to a newer release
```

## 8. Troubleshooting

- **`core` unhealthy / restarting** → `docker compose logs core`. Usually a bad `.env`
  (missing `LIVEKIT_API_*`) or the data dir not writable.
- **Recording produces no VOD** → confirm `egress` is up (`docker compose logs egress`), that
  the `egress` and `core` data-dir mounts match, and that `data/secrets.json` has valid S3 creds.
- **WebRTC connects but no media** → open **UDP 7882** on the firewall and make sure the server's
  public IP is reachable (LiveKit uses `use_external_ip: true`).
- **Browser TLS warning on `localhost`** → expected; Caddy issues a local self-signed cert for
  `localhost`. Use a real domain for a trusted cert.
- **LiveKit webhook signature 401** → the core registers a body parser for
  `application/webhook+json`; if you front it with your own proxy, don't rewrite the body.
