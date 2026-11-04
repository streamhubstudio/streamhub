# Node install — one-liner (day-0) & join-cluster (day-1)

Standardized provisioning of StreamHub nodes with the hosted installer.
**Target OS: Ubuntu Server 24.04/26.04 LTS or Debian 12 (bookworm) / 13 (trixie),
x86_64 only** — the script validates `/etc/os-release` + `uname -m` and aborts with a
clear message on anything else (`STREAMHUB_SKIP_OS_CHECK=1` overrides). It is
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

1. **Gate**: root, Ubuntu 24.04/26.04 or Debian 12/13, x64, and a **port preflight** (80,
   443, 1935, 3020, 6379, 7880, 7881, 8080/tcp + 7882/udp — ports already held by a previous
   StreamHub run are fine).
2. **Deps** (idempotent): Docker + compose plugin (via get.docker.com — it reads
   `/etc/os-release` and resolves the right apt repo for each: Ubuntu 24.04 *noble* / 26.04
   and Debian *bookworm* / *trixie*), and for the default `--proxy nginx`:
   nginx + certbot (`python3-certbot-nginx`). If `ufw` is present + active, ports get allowed
   (Debian has no `ufw` by default — the firewall step is skipped, same as an Ubuntu box
   without it).
3. **Repo** → `/opt/streamhub` (`--dir` overrides); clone or `git pull` on re-run.
4. **`.env`** — generated with strong random secrets (LiveKit keys, JWT, `sk_` API token,
   `mtk_` metrics token, `clt_` **cluster token**, admin password). Existing values are
   NEVER overwritten.
5. **Stack**: `docker compose up -d --build` — `redis livekit ingress egress core`
   (plus `caddy` only with `--proxy caddy`). The compose `caddy` service sits behind the
   **`caddy` profile**: `--proxy caddy` writes `COMPOSE_PROFILES=caddy` into `.env` (so a raw
   `docker compose up -d` and `streamhub start` include it) and an nginx origin has it
   stripped — before 3.4.0 a plain `docker compose up -d` on an nginx origin started Caddy,
   which crash-looped against nginx on :80; a re-run removes that stale container. The proxy
   choice is persisted (`.install-profile`), so `streamhub upgrade` of a Caddy origin stays
   Caddy. Waits for `/api/v1/health`, seeds the `sk_` token
   (`docker compose exec -T core streamhub-core seed-token - bootstrap`, token on stdin).
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
   half-configured TLS state on an IP-only box. **No domain at all** (`--no-tls` without
   `--domain`, or a blank answer → `localhost`) gets the same catch-all as
   `/etc/nginx/sites-available/streamhub-default` (nginx's `default` site is removed): before
   3.4.0 nothing was written and nginx's welcome page answered `/api` and `/hls`. Every nginx
   origin also gets `worker_connections 65535` (only raised, original saved for
   `uninstall.sh`), `worker_rlimit_nofile` and a `LimitNOFILE` systemd drop-in, and the
   template (`deploy/nginx-streamhub.conf`) proxies to the core through a **keepalive
   upstream** (`streamhub_core`, 64 idle connections) instead of a new TCP connection per
   request. Existing vhosts are left alone (`rm` them and re-run to regenerate).
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

On a fresh Ubuntu 24.04/26.04 or Debian 12/13 x64 box:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join \
  --master-token clt_...             # printed by the master install (its .env: STREAMHUB_CLUSTER_TOKEN)
  --master-ip 10.0.0.10              # edges share the MASTER's redis: redis://<ip>:6379
  --master-url https://media.example.com   # OPTIONAL: master API base for registration + webhooks
  --node-name edge-ams-1 --region eu-west
```

`--master-ip` alone is enough: the join now targets the master's **reverse proxy on
`:80`** by default (`http://<master-ip>`) — the core binds `127.0.0.1:3020`, so the old
`:3020` default could never connect. If the `:80` call can't connect, it automatically
falls back to trying `http://<master-ip>:3020`. Pass `--master-url` only to override
explicitly (e.g. a TLS master: `https://media.example.com`).

(Los flags legacy `--cluster-token/--origin-ip/--origin-url` siguen aceptados.)
El alta es **100% por API**: el nodo se registra contra el master con el token y
recibe en la respuesta las keys de LiveKit y la URL de redis — no se comparten
llaves a mano. El token de cluster es dedicado (menor privilegio que el `sk_`
admin) y revocable por separado.

What join does:

1. Same OS/port gates and Docker install (no nginx/certbot — edges don't terminate TLS).
2. `POST /api/v1/cluster/join` on the origin (default target: its proxy on `:80`, fallback
   `:3020`) with header `X-Cluster-Token` — registers the node in the `nodes` registry and
   receives the **LiveKit keys** (must be identical cluster-wide) and the redis URL (password
   included when the origin was installed with `--cluster-redis-bind`).
3. Writes the edge `.env` (`LIVEKIT_REDIS_ADDRESS` + `LIVEKIT_REDIS_PASSWORD`, and
   `LIVEKIT_WEBHOOK_URL` pointing room events at the **origin's** core).
4. **Redis preflight** — TCP-checks that the origin's Redis is reachable at
   `LIVEKIT_REDIS_ADDRESS` **before** starting media services. If it can't connect (the
   common default-origin failure, see below) it **aborts with the origin-side remedy** rather
   than leaving LiveKit/ingress/egress crash-looping. Override with
   `STREAMHUB_SKIP_REDIS_PREFLIGHT=1`.
5. Starts **only** `livekit ingress` (`--no-deps` — no local redis, no core: the
   control plane stays on the origin). **Egress is NOT started by default** (egress
   affinity, see below). LiveKit's shared-redis coordination gives WebRTC
   **session affinity** (a room pins to one node).

Joins are **re-runnable**: an already-joined edge re-registers when the origin answers
(rotated keys are picked up) and keeps its existing config with a warning when it doesn't.

### Per-node credential (3.3.4+)

El token de cluster (`clt_…`) es **solo el secreto de alta**. En la respuesta del
`POST /cluster/join` el master entrega además el **`nodeSecret`** del nodo —
`hex(HMAC-SHA256(clusterToken, "node:" + nodeId))` — y desde ahí el nodo se autentica
**con ese valor**, no con el token compartido:

| Llamada | Credencial (3.3.4+) |
|---|---|
| `POST /cluster/join` (alta / re-alta) | token de cluster (`X-Cluster-Token`) |
| `POST /cluster/heartbeat` | `nodeSecret` del `nodeId` del body (`X-Node-Secret`, o en `X-Cluster-Token`) |
| WS `/api/v1/edge/ws?nodeId=…` | `nodeSecret` de ese `nodeId` (`X-Node-Secret`, `X-Cluster-Token` o `?token=`) |
| master → nodo `/api/v1/grid/*` | el master firma con el `nodeSecret` del nodo destino (`X-Node-Secret`) |
| `GET /plugins/:id/versions/:v/bundle` (edge) | `nodeSecret` de cualquier nodo registrado |

Lo que escribe `install.sh --join` (sin python: `sed` sobre la respuesta):
`STREAMHUB_NODE_SECRET` + `STREAMHUB_NODE_ID` en el `.env`; el secreto en
`/etc/streamhub/heartbeat.env` (`STREAMHUB_HB_TOKEN`) y en `/etc/streamhub/edge.env`
(`STREAMHUB_NODE_SECRET`, y el mismo valor como alias `STREAMHUB_CLUSTER_TOKEN` para el
runtime edge actual, que sólo conoce ese nombre). **El token de cluster no queda guardado
en el nodo** (ni en `.join-profile`): un re-run sin `--cluster-token` reusa el alta
existente; para re-registrar (rotar keys de LiveKit) se vuelve a pasar `--cluster-token`.
Un nodo convertido por API (`POST /cluster/join-master`) guarda el secreto en su KV
(`_streamhub_meta.node_secret`) y lo devuelve en `heartbeatEnv.STREAMHUB_NODE_SECRET`.

Propiedades: un nodo comprometido sólo puede hacerse pasar por **sí mismo** (su secreto no
abre el WS ni el heartbeat de otro `nodeId`, no da de alta nodos nuevos y no sirve contra
el `/grid` de otro nodo). **Revocar un nodo** = `DELETE /cluster/nodes/:id` (el secreto
deriva del id; un re-join crea un id nuevo). **Rotar el token de cluster** invalida todos
los `nodeSecret` → hay que re-joinear todos los nodos.

**Migración / modo legado (`STREAMHUB_CLUSTER_LEGACY_TOKEN`, default `on` en 3.3.x).**
Con el modo legado prendido el master **sigue aceptando el token compartido** donde
espera un `nodeSecret` (heartbeat, WS edge, bundle) y loguea un `warn` por superficie y
nodo (`authenticated with the shared STREAMHUB_CLUSTER_TOKEN … legacy mode`): los nodos
unidos antes de 3.3.4 no se cortan. El heartbeat del propio origin (`nodeId=origin`,
contra su core local) usa el token siempre. Pasos:

1. Actualizar el master a 3.3.4.
2. Re-joinear cada nodo con el instalador nuevo (`install.sh --join --cluster-token …`;
   el re-alta por nombre conserva el `nodeId`) o, para un core edge, repetir
   `POST /cluster/join-master`. Actualizar el runtime edge cuando soporte el secreto
   (mientras tanto lee el alias `STREAMHUB_CLUSTER_TOKEN` de `edge.env`, que ya es el secreto).
3. **Apagar el modo legado** (`STREAMHUB_CLUSTER_LEGACY_TOKEN=off` en el `.env` del master
   y de cada core edge, reiniciar) cuando **no aparezcan más warnings de modo legado** en
   el log del master durante al menos un ciclo completo de heartbeat/reconexión (≥ 5 min)
   con todos los nodos online. Sin nodos registrados (caso prod hoy) se puede apagar ya.

Grid: el master **nunca** manda el token compartido a un nodo. Un agente grid < 3.3.4
(que compara el token crudo) contesta `401` y el worker cae a spawn local hasta que ese
nodo se actualice y re-joinee.

### Egress affinity (default) & the `--with-egress` tradeoff

A joined **common** node does **not** run the egress container by default. Egress is
what records rooms and composites live-HLS, and **any** egress worker in the cluster can
claim a recording/HLS job off the shared Redis queue — writing the MP4 / HLS segments to
**its own local disk**. But the origin is the one that uploads recordings to the app's S3
bucket and serves `/hls`, and it looks on **its own** disk. So a job claimed by an
off-origin egress produces a VOD that goes `failed` ("local recording file missing") and a
live-HLS URL that `404`s while the egress reports success — roughly **50 % of jobs broken
with two nodes** (reproduced in [CLUSTER-2NODE-TEST.md](CLUSTER-2NODE-TEST.md)).

Keeping egress on the **origin only** makes every artifact land where the origin expects
it, so recording + HLS work again — at the cost of capping egress capacity to the origin
until the definitive fix ships.

- **Default (recommended):** join without `--with-egress`. This node runs `livekit`+
  `ingress`; recordings/HLS are handled by the origin's egress.
- **`--with-egress` (opt-in):** also run egress here. The installer prints a loud warning
  because cross-node recordings/live-HLS remain broken until **S3 transport** (egress writes
  straight to S3, core resolves the object instead of a local path) — the Wave C item in
  [../architecture/CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md). Use only if you
  understand that limitation (e.g. an all-WebRTC deployment that never records).

The choice is persisted (`.join-profile` / `.install-profile` → `STREAMHUB_PROFILE_EGRESS`)
so `streamhub upgrade` and `streamhub start/restart` preserve it. Env equivalent:
`STREAMHUB_NODE_EGRESS=1`.

**Reachability requirement (critical):** the origin's redis (6379) must be reachable from
the edge over a **private** interface. A default origin binds redis to `127.0.0.1` only, so
edges are handed `redis://<origin>:6379` and their media services **crash-loop** — the join's
redis preflight now catches this and aborts with the fix. **Install the origin for clustering
with `--cluster-redis-bind <origin-private-ip>`** (binds redis on that address with a
generated password + advertises the right URL), then allow each edge:
`ufw allow from <edge-private-ip> to any port 6379 proto tcp`. Quick manual remedy on an
already-running origin: append `REDIS_BIND=127.0.0.1 <origin-private-ip>` to its `.env` and
`docker compose up -d --force-recreate redis`. Do NOT expose 6379 to the public internet.
The origin can override the advertised URL with `STREAMHUB_CLUSTER_REDIS_URL`.

Verify: `GET /api/v1/cluster/nodes` (Bearer `sk_` token) lists the node with its
`last_seen_at`; full cluster design in
[../architecture/cluster.md](../architecture/cluster.md).

## Cloud 1:1 NAT — LiveKit node IP (`--node-ip`)

On AWS / GCP / Azure the public IP is **not on any interface**: the provider maps it 1:1 onto
the private one. With the compose default `use_external_ip: true` LiveKit advertises the
STUN-detected public IP, so the egress' headless Chrome (and ingress) inside the VPC reach
LiveKit **through the public IP** (a hairpin out and back in). That works when the security
group/firewall opens the media ports (7881/tcp, 7882/udp) to the internet — the normal setup for
public WebRTC — and fails when they are open only inside the private network: room-composite
HLS/recordings then come out black or never start (what the AWS load tests LT3/LT4 hit, with a
security group that only allowed its own members; fixed by hand on the origin **and** every
joined node).

Default `off` keeps today's behaviour (internet browsers reach WebRTC directly). For clusters
whose media ports are closed to the internet, pass `--node-ip auto` (or an explicit IP) on the
**origin and every common join**:

| `--node-ip` (env `STREAMHUB_NODE_IP`) | Effect |
|---|---|
| `auto` | Detect: one 1 s TCP probe to `169.254.169.254`; if it answers, AWS IMDSv2 (token, then IMDSv1), GCP (`Metadata-Flavor: Google`) and Azure IMDS (`Metadata: true`) are asked for the private + public IPv4 (1 s cap each). Without metadata the public IP from `api.ipify.org` is compared with the local interfaces. **Public IP present and not on any interface** ⇒ `.env` gets `LIVEKIT_USE_EXTERNAL_IP=false` + `LIVEKIT_NODE_IP=<private IP>` (the metadata private IP if it is on a NIC, else the default-route source IP). Nothing detected ⇒ nothing changes (and a value an earlier run wrote is kept, so a metadata blip never flips it back). Never fails the install. |
| `<ip>` | Force `node_ip=<ip>`, `use_external_ip=false`. |
| `off` (default) | Remove both keys → STUN public-IP detection (the behaviour before this flag existed). |

The compose `livekit` service renders them as `rtc.use_external_ip: ${LIVEKIT_USE_EXTERNAL_IP:-true}`
and `rtc.node_ip: ${LIVEKIT_NODE_IP:-}` (empty = autodetect). The choice is persisted as
`STREAMHUB_PROFILE_NODE_IP` in `.install-profile`, so `streamhub upgrade` and bare re-runs keep it;
the next `compose up` recreates LiveKit with the new config.

**Tradeoff.** With `node_ip` = the private IP LiveKit advertises **only** that IP for ICE
(it logs `using node IP for NAT1To1`): egress/ingress, joined nodes and clients in the same
private network connect, but **browsers on the internet need TURN** (`--turn` on the origin)
or a VPN to publish/play WebRTC. HLS playback (origin or `--cdn-edge`) is unaffected. The
generic fallback (no metadata) also fires behind an ordinary home/office NAT; if that box
relies on port forwarding of 7881/7882 for public WebRTC, install with `--node-ip off`.

## Vision Edge node (`--node-type edge`)

Add `--node-type edge` (or `STREAMHUB_NODE_TYPE=edge`) to a join to provision a
**Vision Edge** node: a compute node that runs **no public media plane** (no
livekit/ingress/egress) and instead **dials the master's WS control channel**
(`/api/v1/edge/ws`) and runs the `vision-edge-runtime` daemon, which supervises
per-assignment model workers the master schedules onto it.

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join --node-type edge \
  --master-token clt_... --master-ip 10.0.0.10 \
  --master-url https://media.example.com \
  --node-name edge-cv-1 --region eu-west
```

What the installer provisions for an edge node, on top of the registration +
heartbeat every join does:

1. **`streamhub-edge.service`** (systemd) + `/etc/streamhub/edge.env` holding
   `STREAMHUB_MASTER_URL` / `STREAMHUB_NODE_SECRET` / `STREAMHUB_NODE_ID` (3.3.4+:
   `STREAMHUB_CLUSTER_TOKEN` there is only a compat alias holding the same **node
   secret**, see [Per-node credential](#per-node-credential-334)). The
   unit is `ConditionPathExists`-gated on the runtime shim, so it is a harmless
   no-op until step 2 lands.
2. **The runtime**, provisioned in place (best-effort): a Python **venv** at
   `<install-dir>/vision-edge-venv`, `pip install`ed from the fetched
   `vision-edge-runtime/` source tree, plus the `/usr/local/bin/streamhub-vision-edge`
   shim (`exec <venv>/bin/python -m vision_edge --mode edge`, env from
   `/etc/streamhub/edge.env`). Once the shim exists the unit's condition passes
   and the daemon is (re)started.

**Heavy deps / CPU vs GPU.** The runtime pulls `ultralytics` + `opencv` (via
`torch`), which are large. The installer installs **CPU** `torch`/`torchvision`
wheels **by default** (from `https://download.pytorch.org/whl/cpu`) — they work
everywhere. On a box with a GPU (`nvidia-smi` present) it logs a note but still
installs CPU wheels; to enable GPU inference, reinstall the CUDA wheels into the
venv afterwards, e.g.:

```bash
/opt/streamhub/vision-edge-venv/bin/pip install --force-reinstall torch torchvision
```

**Best-effort + idempotent.** A pip failure (offline box, no egress) **warns but
never aborts the join** — the node still registers and heartbeats; re-run the
installer once the deps are reachable and the runtime finishes provisioning. The
venv is reused across re-runs/upgrades and the shim is rewritten each run.

**Skip it.** Set `STREAMHUB_NO_EDGE_RUNTIME=1` to install only the inert unit and
skip the venv/deps/shim entirely (e.g. to provision the runtime yourself, or to
keep a slim join). Tunables the daemon reads from `edge.env`:
`VISION_EDGE_PYTHON` (override the child interpreter), `VISION_EDGE_WS_IDLE_TIMEOUT`
(force-reconnect after N seconds with no master frame; default 30 = 2× the 15s
ping), `VISION_EDGE_CAPABILITIES`, `VISION_EDGE_ALLOW_REBOOT`.

Verify: `journalctl -u streamhub-edge -f` shows `registered with master`; the
node appears connected in `GET /api/v1/edge/nodes`.

## CDN edge node (`--cdn-edge`)

A **lightweight HLS cache** in front of the origin's `/hls`: nginx only — **no Docker, no
LiveKit, no compose stack**. It registers in the cluster like any join, heartbeats its load,
and serves viewers from cache (the origin serves each segment ~once per edge; see
[HLS-CDN.md](../features/HLS-CDN.md)). Turn on `STREAMHUB_HLS_CDN=on` on the origin.

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --cdn-edge \
  --master-token clt_... --master-ip 10.0.0.10 \
  [--master-url https://media.example.com] \
  [--edge-url https://cdn1.example.com] [--cdn-origin-url http://10.0.0.10] \
  [--edge-cache-tmpfs 8g] --node-name cdn1 --region sa-east
```

`--cdn-edge` = `--join --node-type cdn-edge` (env `STREAMHUB_CDN_EDGE=1`). Flags:

| Flag (env) | Default | Meaning |
|---|---|---|
| `--edge-url` (`STREAMHUB_EDGE_URL`) | `http://<public IP>` | Public base URL viewers use; registered as the node `url` (the master's edge selection hands it to players). **Use `https://<dns-name>`**: an `http://` edge is blocked as mixed content by players on an https page (the installer warns), and an IP can't carry a public cert. Its host becomes nginx's `server_name` (`_` for an IP). |
| `--cdn-origin-url` (`STREAMHUB_CDN_ORIGIN_URL`) | the master URL the join succeeded against (`http://<master-ip>` or `--master-url`) | Where nginx pulls `/hls` from. For a TLS origin pass its `https://<domain>` (its port-80 block only redirects). |
| `--edge-cache-tmpfs <size>` (`STREAMHUB_EDGE_CACHE_TMPFS`) | `off` | Cache dir on tmpfs (`4g`, `2048m`, ≥ 64m): a tagged `/etc/fstab` line + mount (`mode=0700`, owned by the nginx user); nginx's `max_size` is set to 90 % of it so the cache manager evicts before RAM fills. `off` on a re-run unmounts it and drops the fstab line. |

What it provisions:

1. **Gates**: same OS check; port preflight only `80/tcp`; `ufw` (if active) opens 80 + 443. No
   Docker, no sysctl UDP buffers.
2. **Source** (same fetch as every install) — needed for the template.
3. **Join**: `POST /api/v1/cluster/join` with `X-Cluster-Token` and
   `{"name","ip","region","type":"cdn-edge","url":"<edge-url>"}`. Stores `STREAMHUB_NODE_ID` +
   `STREAMHUB_NODE_SECRET` in `.env` and the secret in `/etc/streamhub/heartbeat.env`, exactly
   like other joins ([Per-node credential](#per-node-credential-334)); **no LiveKit keys or
   Redis URL are kept** (the master returns none for a cdn-edge). Needs a master that knows the
   `cdn-edge` node type (3.4.0+; older ones answer 400).
4. **nginx**: `/etc/nginx/conf.d/streamhub-hls-edge.conf` rendered from the repo's
   [`deploy/nginx-hls-edge.conf`](../../deploy/nginx-hls-edge.conf) — the installer only fills
   its two `>>>` markers (`https://origin.example.com` → the origin URL, `server_name
   edge.example.com` → the edge name; plus `max_size` with tmpfs) and **aborts** if the template
   no longer carries them, so cache-policy fixes land by editing that one file. Also: a
   `stub_status` server on `127.0.0.1:18081` only (`/etc/nginx/conf.d/streamhub-stub-status.conf`),
   nginx's `default` site removed, `worker_connections 65535` + `worker_rlimit_nofile` + a
   `LimitNOFILE` drop-in, `nginx -t` (a rejected config is moved to `*.rejected` and the install
   stops), restart.
5. **Heartbeat** every **15 s** (`streamhub-heartbeat.timer`; `STREAMHUB_HB_INTERVAL` overrides)
   with the node secret in `X-Cluster-Token` **and** `X-Node-Secret`. The usual
   `stats` gain the CDN block (payload ≈ 260 bytes):

   ```json
   {"nodeId":"…","stats":{"cores":4,"loadavg1":0.12,"cpu":0.03,"memTotalKb":…,"memAvailKb":…,
     "memUsedRatio":0.21,"role":"cdn-edge",
     "cdn":{"conns":123,"reqTotal":45678,"txBytes":987654321,"txMbps":412.345,"cacheDir":"/var/cache/nginx/hls"}}}
   ```

   `conns` = stub_status *Active connections* minus the probe itself, `reqTotal` = its request
   counter, `txBytes` = bytes sent on the default-route NIC (`/proc/net/dev`), `txMbps` = delta
   since the previous beat (state in `/run/streamhub/hb-cdn.state`; 0 on the first beat / after
   a reboot or counter reset). A failing probe reports 0 — it never fails the beat.
6. **CLI**: `.install-profile` gets `STREAMHUB_PROFILE_MODE=cdn-edge`; `streamhub
   start|stop|restart|status|logs|doctor|version` drive nginx + the heartbeat timer (no
   `streamhub.service` is installed — nginx is the service). `streamhub upgrade` / a bare re-run
   resume from `.join-profile` (no token needed; pass `--cluster-token` to re-register).

TLS on the edge is not automated yet: terminate it on a load balancer in front, or add a cert
to the rendered file by hand (see the comments in the template). `uninstall.sh` reverses it:
removes both conf.d files (and `*.rejected`), the tmpfs fstab entry + mount + cache dir, the
nginx limit tuning and drop-in, restores nginx's default site and reloads nginx. Deregister
the node on the master with `DELETE /api/v1/cluster/nodes/:id`.

Verify: `curl -I http://<edge>/hls/<app>/<room>/index.m3u8` shows `X-Cache-Status`
(`MISS` then `HIT` for segments); `streamhub doctor`; the node appears in
`GET /api/v1/cluster/nodes` with its `cdn` stats.

## Golden images (`--prepare-image`)

`install.sh --prepare-image` is the build step of the marketplace images (Packer): it runs
the OS gate, the dependencies, the source fetch, `docker compose pull` of the pinned stack
images and `docker compose build core` — then **stops**. No `.env`, no secrets, no domain,
nothing started, no telemetry; it leaves a `/opt/streamhub/.image-prepared` marker (version,
default proxy, telemetry channel). The first normal run on a server booted from that image
(`/opt/streamhub/first-boot.sh`, or `install.sh --domain … --email …` by hand) sees the marker,
installs **the baked source** as a fresh install (no re-fetch; `STREAMHUB_IMAGE_REFRESH=1`
fetches anyway), generates the secrets, starts the stack and removes the marker — from then
on re-runs behave as usual. Re-running `--prepare-image` itself is idempotent. See
[MARKETPLACE.md](./MARKETPLACE.md).

## Hosting the installer

The one-liner URL is the landing site (`203.0.113.20`, repo
`streamhub-site` / `digitalhub_com_ar/streamhub-web`): the script lives at `public/install.sh`
there and ships with the site build — `https://www.streamhub.studio/install.sh` (the `www`
host 301s to the apex; `curl -fsSL` follows it).

Because the product repo is **private**, the installer falls back to a **source tarball**
hosted next to it: `https://www.streamhub.studio/streamhub-src.tar.gz` (generated with
`git archive HEAD` — tracked files only, never secrets). `git clone` is attempted first
(`GIT_TERMINAL_PROMPT=0`, fails fast) so a public repo or configured credentials keep
working; `STREAMHUB_SRC_URL` / `STREAMHUB_REPO_URL` override both.

**Release procedure when `install.sh` or the source changes:**

```bash
# from vision-media-server/ (main, gate green)
git archive --format=tar.gz -o /tmp/streamhub-src.tar.gz HEAD
scp install.sh /tmp/streamhub-src.tar.gz ploi@203.0.113.20:/home/ploi/streamhub.studio/public/
ssh ploi@203.0.113.20 'cp /home/ploi/streamhub.studio/public/{install.sh,streamhub-src.tar.gz} /home/ploi/streamhub.studio/dist/'
```

(`public/` persists across site builds — Astro copies it into `dist/` on every build; the
direct `dist/` copy makes it live without rebuilding. Also commit `public/install.sh` to the
landing repo to keep git in sync; the tarball stays out of git.)

## Upgrading a 2.x node to 3.x (Go core)

Nothing changes for the operator: re-run the installer (or `streamhub upgrade`). It fetches
the 3.x source, rebuilds the `core` image — now the Go core (`streamhub-core-go/`) instead of
NestJS — and recreates the container on the **same** `.env` and bind-mounted `DATA_DIR`. The Go
core opens the 2.x SQLite databases (global + every `apps/<app>/app.db`) as-is; the
installer's pre-upgrade backup + `user_version` before/after evidence work unchanged.
Re-seeding the API token is a no-op (it's already there). Rollback is the usual
`streamhub upgrade --version <2.x>` (see [CLUSTER-UPDATES.md](./CLUSTER-UPDATES.md)). Plain-server
(systemd, non-Docker) installs upgrade with `deploy/deploy-core.sh` — see
[DEPLOY.md §B.7](./DEPLOY.md#b7-redeploys--deploydeploy-coresh-secure-no-hardcoded-secrets).

## Day-2

```bash
cd /opt/streamhub
docker compose logs -f core        # logs
docker compose down                # stop
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash   # re-run = update + restart
```

**Refresh semantics on re-run (tarball installs):** the private-repo fallback
(source tarball, see [Hosting the installer](#hosting-the-installer)) now
mirrors the fresh tree onto `/opt/streamhub` with **delete** semantics —
`rsync -a --delete` (falling back to a `find`-based mirror if `rsync` isn't
available, auto-installed when possible) — so files removed upstream since
your last install are actually removed locally too, instead of accumulating
forever. `.env`/`.env.local`/`*.local`/`data/`/`.git/` are always excluded from
the mirror, so secrets and app data are never touched. A git-checkout install
still just does `git pull --ff-only` (git already tracks deletions).
