# StreamHub

**Self-hosted, open-source media server built on [LiveKit](https://livekit.io) — a
drop-in style alternative to AntMedia.** StreamHub wraps a LiveKit SFU with a management
layer that gives you multi-tenant *apps*, RTMP/WHIP/RTSP ingest, WebRTC + HLS playback,
one-command recording to **per-app S3**, an embeddable player, signed webhooks, a REST API,
and a React dashboard — all behind a **single domain** with automatic HTTPS.

Everything runs from one `docker compose up`.

**[Website](https://streamhub.studio) · [Documentation](http://docs.streamhub.studio) · [Dashboard demo](https://streamhub.studio/demo) · License: [AGPL-3.0](LICENSE)**

```
                    https://streamhub.example.com   (Caddy, auto-TLS, 1 cert)
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  /rtc  → LiveKit signaling (wss / WebRTC)                                  │
   │  /*    → streamhub-core (NestJS): REST API + React SPA + HLS + browser SDK │
   └──────────────────────────────────────────────────────────────────────────┘
        WebRTC media (UDP 7882) and RTMP (1935) go straight to the server IP
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ livekit-server   SFU · signaling 7880 · tcp 7881 · media 7882/udp         │
   │ livekit/ingress  RTMP 1935 · WHIP 8080                                     │
   │ livekit/egress   room-composite recording → <DATA_DIR> → S3               │
   │ redis            coordinates ingress/egress + BullMQ job queues           │
   │ streamhub-core   API + serves the SPA + JWT login + SQLite + S3 + jobs     │
   └──────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Multi-tenant apps** — isolated namespaces, each with its own tokens, config and S3 bucket.
- **Ingest**: WebRTC publish, RTMP, WHIP, and RTSP (via ffmpeg relay).
- **Playback**: WebRTC (sub-second) and **HLS** (`/hls/<app>/<room>/index.m3u8`), plus an
  embeddable player and a drop-in browser SDK (`streamhub-adaptor`, an AntMedia-`WebRTCAdaptor`
  shim over `livekit-client`) served at `/sdk/streamhub-adaptor.global.js`.
- **Recording → S3**: `POST /recording/start` → room-composite MP4 → uploaded to the app's S3
  bucket → snapshot + VOD entry; local file cleaned up. (Verified: 2× H.264 720p → Wasabi.)
- **Signed webhooks** (HMAC) for every event, plus MP4 split + snapshots.
- **REST API** (global + per-app) with Swagger at `/api/v1/docs`, guarded by `sk_` bearer tokens.
- **React dashboard** (Vite + Tailwind) with a break-glass admin login (JWT).
- **RBAC + quotas** with a safe phased rollout (`off` → `log` → `on`).

## Quick start

Requirements: a **Linux host with a public IP**, Docker + the Docker Compose plugin. (Host
networking is used for LiveKit media, so this targets Linux, not Docker Desktop on macOS.)

### Option A — one-liner installer (recommended)

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
```

Targets **Ubuntu Server 24.04/26.04 LTS x64** (validated; aborts elsewhere) and is
**idempotent** — re-run it to update. It installs Docker (+ nginx/certbot for TLS), clones the
repo into `/opt/streamhub`, asks for your **domain** + **admin password** (auto-generates the
rest), writes a `.env` with strong random secrets, builds + starts the whole stack, waits for
health, seeds the `sk_` API token and prints the dashboard URL, credentials, token and a
**cluster token** for joining edge nodes. Fully scriptable with
`--non-interactive --domain … --email …` (every flag has a `STREAMHUB_*` env twin), and
`--join --cluster-token … --origin-ip …` turns a fresh box into a **media edge node**.
Full reference: **[streamhub-docs/operations/INSTALL-NODE.md](streamhub-docs/operations/INSTALL-NODE.md)**.

### Option B — docker compose by hand

```bash
git clone https://github.com/streamhubstudio/streamhub.git
cd streamhub
cp .env.example .env          # edit: STREAMHUB_DOMAIN, ACME_EMAIL, secrets...
docker compose up -d --build
# seed the first global API token once core is healthy:
docker compose exec -T core node deploy/seed-token.js "$(grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2)"
```

Then open `https://<your-domain>/` (dashboard), `/api/v1/docs` (Swagger), and check
`curl http://127.0.0.1:3020/api/v1/health`.

For a **real domain**, first: add a DNS `A` record (DNS-only, not Cloudflare-proxied) and open
firewall ports **80, 443, 7880/tcp, 7881/tcp, 7882/udp, 1935/tcp**.

### Day-2

```bash
docker compose logs -f core          # tail logs
docker compose down                  # stop
git pull && docker compose up -d --build   # update
```

## Configuration

All configuration is a single **`.env`** (see **[`.env.example`](.env.example)** — fully
commented). Data (SQLite DB, per-app recordings/snapshots/HLS, logs, the served SDK) lives under
`DATA_DIR`, bind-mounted from `STREAMHUB_HOST_DATA_DIR` (default `./data`) into both the `core`
and `egress` containers — egress writes MP4s exactly where core looks to upload them.

Per-app S3 credentials are set in `data/secrets.json` (chmod 600) referenced from the app's
`config.yaml`; see **[streamhub-docs/config-reference.md](streamhub-docs/config-reference.md)**.

## What's in the box

| Path | Stack | Role |
|---|---|---|
| `docker-compose.yml` | Compose | brings up core + LiveKit + ingress + egress + redis + Caddy |
| `install.sh` | Bash | quick-install: secrets → build → up → seed token |
| `deploy/` | Dockerfile, Caddyfile, entrypoint, seeder (+ bare-metal systemd/nginx units) |
| `streamhub-core/` | Node 20 + **NestJS** | REST API + serves the React SPA + JWT login + S3 + jobs + SQLite |
| `streamhub-web/` | **React + Vite + Tailwind** | dashboard SPA (built into the core image) |
| `streamhub-adaptor/` | TypeScript | browser SDK (`WebRTCAdaptor` shim over `livekit-client`) |
| `streamhub-docs/` | Markdown | full API reference |

## Documentation

- **[streamhub-docs/](streamhub-docs/README.md)** — the full documentation map: architecture,
  operations (deploy/runbook/env/observability), API reference (global + per-app + `api/` endpoint
  reference + webhooks + `config.yaml`), per-feature deep-dives, testing strategy (unit tests +
  functional simulations), and device/native integrations.
- **[streamhub-docs/operations/self-hosting.md](streamhub-docs/operations/self-hosting.md)** —
  this Docker quick-install, expanded, with troubleshooting.
- **[INSTALL.md](INSTALL.md)** — the manual bare-metal runbook (systemd + nginx, no Docker),
  useful if you'd rather not run containers.
- **[streamhub-docs/SPEC.md](streamhub-docs/SPEC.md)** — product spec (architecture, data model, features).

## License

StreamHub follows an **open-core** model: the self-hosted core in this repository — everything
under `streamhub-core/`, `streamhub-web/`, `yolo-worker/`, `deploy/` and this Compose stack — is
open source under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). Copyright © 2026 StreamHub /
Digital Hub. Commercial **Enterprise Edition (EE)** modules are distributed and licensed
separately and are not part of this repo. The browser SDK
[`streamhub-adaptor/`](streamhub-adaptor/) is intentionally **MIT** so it can be embedded
drop-in in any client app.
