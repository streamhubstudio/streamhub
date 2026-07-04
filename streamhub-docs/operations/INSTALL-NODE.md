# Node install — one-liner (day-0) & join-cluster (day-1)

Standardized provisioning of StreamHub nodes with the hosted installer.
**Target OS: Ubuntu Server 24.04 LTS or 26.04 LTS, x86_64 only** — the script validates
`/etc/os-release` + `uname -m` and aborts with a clear message on anything else. It is
**idempotent**: re-running keeps your `.env` secrets, updates the code and restarts services.

The canonical copy is hosted at **`https://www.streamhub.studio/install.sh`** (served by the
StreamHub landing site; the repo copy at `install.sh` is the source of truth — see
[Hosting the installer](#hosting-the-installer)).

## Day-0 — install an origin node

Interactive (prompts for domain/email, generates every secret):

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
```

Non-interactive (CI/cloud-init — every prompt has a flag and a `STREAMHUB_*` env equivalent):

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --non-interactive \
  --domain media.example.com \
  --email admin@example.com \
  --admin-pass 'S3cret!' \
  --smtp-host mail.example.com --smtp-port 587 \
  --smtp-user no-reply@example.com --smtp-pass 'smtp-secret' \
  --superadmin-email info@example.com
```

`| sudo sh` also works (the script re-execs itself under bash). Run `--help` for all flags.

Re-run semantics: **flags/env update their `.env` keys; generated secrets are never rotated.**
On a non-TTY / `--non-interactive` run the final summary **redacts secrets** (cloud-init/CI
persist stdout) and points at `/opt/streamhub/.env` instead.

To prepare an origin that edges will join later, add `--cluster-redis-bind <private-ip>`:
Redis then also listens on that (private!) address with a generated password, and
`cluster/join` hands `redis://:<pass>@<ip>:6379` to edges. Allow each edge explicitly:
`ufw allow from <edge-ip> to any port 6379 proto tcp`.

What it provisions, in order:

1. **Gate**: root, Ubuntu 24.04/26.04 x64, and a **port preflight** (80, 443, 1935, 3020,
   6379, 7880, 7881, 8080/tcp + 7882/udp — ports already held by a previous StreamHub run
   are fine).
2. **Deps** (idempotent): Docker + compose plugin (via get.docker.com — it resolves the right
   apt repo for both 24.04 *noble* and 26.04), and for the default `--proxy nginx`:
   nginx + certbot (`python3-certbot-nginx`). If `ufw` is active, ports get allowed.
3. **Repo** → `/opt/streamhub` (`--dir` overrides); clone or `git pull` on re-run.
4. **`.env`** — generated with strong random secrets (LiveKit keys, JWT, `sk_` API token,
   `mtk_` metrics token, `clt_` **cluster token**, admin password). Existing values are
   NEVER overwritten.
5. **Stack**: `docker compose up -d --build` — `redis livekit ingress egress core`
   (plus `caddy` only with `--proxy caddy`). Waits for `/api/v1/health`, seeds the `sk_` token.
   `EGRESS_CPUS` is auto-clamped to `min(nproc, 4)` before the stack starts (an operator's
   explicit `.env` value is respected) — a host with fewer than 4 vCPUs used to hard-fail
   `docker compose up` ("range of CPUs is 0.01 to N"), killing the install mid-way.
6. **TLS / no-TLS**: writes the nginx server block (`/rtc`→7880 websocket, `/`→3020) and runs
   `certbot --nginx --redirect` (skipped for `localhost` installs, `--no-tls`, or when the
   cert already exists; renewals via `certbot.timer`). `--no-tls` (or `STREAMHUB_NO_TLS=1`,
   or auto-detected when `--domain`/`STREAMHUB_DOMAIN` is a bare IP literal) is a **real**
   no-TLS mode: public URLs switch to `http://`/`ws://`, Caddy serves plain HTTP with no
   ACME attempt (`STREAMHUB_SITE_ADDRESS`), and nginx writes an IP-friendly catch-all
   (`server_name _; listen 80 default_server;`) instead of a name-based vhost — no
   half-configured TLS state on an IP-only box.
7. **Heartbeat agent**: installs `/usr/local/bin/streamhub-heartbeat.sh` +
   a `streamhub-heartbeat.service`/`.timer` pair (`systemctl enable --now
   streamhub-heartbeat.timer`, runs every 60s) that POSTs `{nodeId, stats}` to
   `POST /cluster/heartbeat`. Installed for **both** the origin and joined edges, so a node
   no longer needs a manual cron workaround to avoid going `stale=true` 90s after its last
   ping — see [`../architecture/cluster.md`](../architecture/cluster.md#node-liveness-heartbeat--self-registration).
   The origin also self-registers into its own `nodes` registry on boot, so it shows up
   in `GET /cluster/nodes` alongside its edges.
8. Prints a **summary**: dashboard URL + credentials, `sk_` token, RTMP/WHIP/HLS endpoints,
   and the **cluster token + ready-made join one-liner** for edges.

Before pointing real traffic: DNS `A` record → the server's public IP (DNS-only, no CDN
proxy — WebRTC media is UDP) and firewall open on 80, 443, 1935, 7880, 7881/tcp, 7882/udp.

## Day-1 — join a media/edge node to the cluster

On a fresh Ubuntu 24.04/26.04 x64 box:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join \
  --master-token clt_...             # printed by the master install (its .env: STREAMHUB_CLUSTER_TOKEN)
  --master-ip 10.0.0.10              # edges share the MASTER's redis: redis://<ip>:6379
  --master-url https://media.example.com   # master API base for registration + webhooks (default: http://<master-ip>:3020)
  --node-name edge-ams-1 --region eu-west
```

(Los flags legacy `--cluster-token/--origin-ip/--origin-url` siguen aceptados.)
El alta es **100% por API**: el nodo se registra contra el master con el token y
recibe en la respuesta las keys de LiveKit y la URL de redis — no se comparten
llaves a mano. El token de cluster es dedicado (menor privilegio que el `sk_`
admin) y revocable por separado.

What join does:

1. Same OS/port gates and Docker install (no nginx/certbot — edges don't terminate TLS).
2. `POST /api/v1/cluster/join` on the origin with header `X-Cluster-Token` — registers the
   node in the `nodes` registry and receives the **LiveKit keys** (must be identical
   cluster-wide) and the redis URL (password included when the origin was installed with
   `--cluster-redis-bind`).
3. Writes the edge `.env` (`LIVEKIT_REDIS_ADDRESS` + `LIVEKIT_REDIS_PASSWORD`, and
   `LIVEKIT_WEBHOOK_URL` pointing room events at the **origin's** core) and starts **only**
   `livekit ingress egress` (`--no-deps` — no local redis, no core: the control plane stays
   on the origin). LiveKit's shared-redis coordination gives WebRTC **session affinity**
   (a room pins to one node).

Joins are **re-runnable**: an already-joined edge re-registers when the origin answers
(rotated keys are picked up) and keeps its existing config with a warning when it doesn't.

**Reachability requirement:** the origin's redis (6379) must be reachable from the edge —
install the origin with `--cluster-redis-bind <private-ip>` (binds redis on that address
with a generated password) and allow each edge (`ufw allow from <edge-ip> to any port 6379
proto tcp`). Do NOT expose 6379 to the public internet; prefer a private network/VPN. The
origin can override the advertised URL with `STREAMHUB_CLUSTER_REDIS_URL`.

Verify: `GET /api/v1/cluster/nodes` (Bearer `sk_` token) lists the node with its
`last_seen_at`; full cluster design in
[../architecture/cluster.md](../architecture/cluster.md).

## Hosting the installer

The one-liner URL `https://www.streamhub.studio/install.sh` serves the script from the
landing site (the `www` host 301s to the apex; `curl -fsSL` follows it). By default the
installer `git clone`s the public repo `https://github.com/streamhubstudio/streamhub.git`
and falls back to a **source tarball** if git is unavailable; `STREAMHUB_REPO_URL` /
`STREAMHUB_SRC_URL` override either.

## Day-2

```bash
cd /opt/streamhub
docker compose logs -f core        # logs
docker compose down                # stop
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash   # re-run = update + restart
```

**Refresh semantics on re-run (tarball installs):** the tarball fallback path
(see [Hosting the installer](#hosting-the-installer)) now
mirrors the fresh tree onto `/opt/streamhub` with **delete** semantics —
`rsync -a --delete` (falling back to a `find`-based mirror if `rsync` isn't
available, auto-installed when possible) — so files removed upstream since
your last install are actually removed locally too, instead of accumulating
forever. `.env`/`.env.local`/`*.local`/`data/`/`.git/` are always excluded from
the mirror, so secrets and app data are never touched. A git-checkout install
still just does `git pull --ff-only` (git already tracks deletions).
