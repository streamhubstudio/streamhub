# Scaling HLS to tens of thousands of viewers

StreamHub serves WebRTC (via LiveKit), but **HLS is the wide-reach path** — it's what
scales to large audiences. This page covers where the single-origin HLS ceiling is, the
opt-in knob that takes segment serving off the core entirely, how to measure the knee
before spending on a cloud run, and how to go horizontal with edge nodes.

## Where the ceiling is

Every `/hls/<app>/<room>/<file>.ts|.m3u8` request is served by the core by default
(`internal/platform/web`: it adds CORS + the cache policy, honours `STREAMHUB_HLS_CDN`,
counts per-app HLS egress bytes, and goes through the security middleware). Segments
are static files the egress recorder already wrote to `DATA_DIR`.

- **Node core (2.x):** the event loop was the wall — **~1–1.5k concurrent viewers**
  with spare CPU and NIC, and past that the whole API stopped answering
  (`planning/LOADTEST-REPORT.md`).
- **Go core (3.x):** no knee found up to **10k viewers** on one box (p95 2.6 ms,
  3.67 GB/s, ~3 cores) and the API latency does not move with the fan-out
  (`planning/GO-CORE-BENCHMARK.md`). In practice the origin limit is now the NIC.

So with the Go core direct-serve is **not required** to pass 1.5k viewers. It is still
useful as a CPU saver and headroom lever for very large audiences (the proxy's
`sendfile` path costs less CPU per byte than any userland server).

## `STREAMHUB_HLS_DIRECT_SERVE` (opt-in)

With the flag on (`1`/`true`/`on`/`yes`), the **reverse proxy serves the segments
straight from disk** (`sendfile`) and the core never touches segment bytes. The core
keeps doing the API, auth, signaling, the SPA — and, since 3.4.0, the playlists and the
authorization of every disk-served segment.

- **Private apps are never exposed (3.4.0, [signed-hls](../features/signed-hls.md)):**
  before serving a file from disk the proxy asks the core — nginx `auth_request`, Caddy
  `forward_auth` — on `GET /hls-auth` (the original URI rides in `X-Original-URI`, the
  client IP in `X-Forwarded-For`). The core answers `204` (serve) or `403` in
  microseconds (HMAC + a per-app policy cached 3 s); for an app with
  `public_playback:false` the request must carry a valid `?st=`, and `features.geo` is
  applied too. The answer's `X-StreamHub-HLS-Scope: public|private` picks the segment
  `Cache-Control` (`private` for private apps, so no shared cache stores them). A 403 is
  answered by the core itself (same JSON as without direct-serve).
- **Playlists always go to the core:** the core rewrites a private app's playlist so
  every segment / key / variant URI carries the token — a proxy serving the `.m3u8` from
  disk could not. Playlists are tiny and `no-cache`, so this costs little; the bytes
  that matter (segments) still come from disk. Each segment costs one extra loopback
  subrequest to the core (no body) — still far below proxying the segment itself.

- **Mapping:** public `/hls/<app>/<room>/<file>` → `<DATA_DIR>/apps/<app>/hls/<room>/<file>`.
- **Fallback is automatic:** anything not on disk (a VOD path, a just-rotated playlist)
  falls through to the core with its original URL. With the flag **off**, nothing is
  ever served from disk — **zero behavior change when off**.
- **Path safety:** a path segment starting with `.` (including `..`) never matches the
  disk handler (same rule as the core's `safeJoin`); such requests go to the core,
  which rejects them.
- **Headers on disk hits:** `.ts` → `public, max-age=31536000, immutable` (or
  `private, …` for a private app); `Access-Control-Allow-Origin: *`. Fallback answers keep the core's own
  headers.

### Enabling it

**Docker + Caddy** (`docker-compose.yml` + `deploy/Caddyfile`): set in `.env`

```
STREAMHUB_HLS_DIRECT_SERVE=on
```

and recreate the proxy (`docker compose up -d caddy`). The `caddy` service always mounts
the data dir read-only at `/srv/streamhub-data` and gets the flag in its environment; the
Caddyfile's `@hls` handler only reads the disk when the flag is on. `STREAMHUB_HLS_ROOT`
overrides the root for a Caddy run outside compose.

**Plain server + nginx** (`deploy/nginx-streamhub.conf`): set the same flag in `.env`
(or the environment) before running `install.sh`. The installer replaces
`__STREAMHUB_HLS_ROOT__` with the host `DATA_DIR` and `__STREAMHUB_HLS_AUTH__` with
`/_streamhub_hls_auth` (flag on), or with `/var/empty` and `off` (flag off, so `try_files`
always misses and everything falls back to the core, which validates tokens itself) —
the two always move together: **never pair a real root with `auth_request off`**. nginx
needs `ngx_http_auth_request_module` (built into the Debian/Ubuntu `nginx` packages;
`nginx -t` fails loudly without it). With the flag on
grants **only the nginx worker user** traverse access (`setfacl -m u:<user>:x`) down to
`data/apps` — `data/apps` is `770`, and opening it to everyone would expose `app.db`.
Without `setfacl` (package `acl`) it prints the command to run.

Toggling the flag on an **existing** nginx install: `install.sh` does not overwrite an
existing site file — either remove `/etc/nginx/sites-available/<domain>` (and the
`sites-enabled` symlink) and re-run the installer, or edit the `root …;` **and**
`auth_request …;` lines of the `/hls` location by hand (`/var/empty` + `off` ↔ the data
dir + `/_streamhub_hls_auth`) and `nginx -t && systemctl reload nginx`. A vhost copied by
hand from the repo keeps the literal placeholders and fails `nginx -t` until both are set.
Hosts whose nginx is managed by a panel (e.g. Ploi) need the `location ~ ^/hls/.+\.m3u8$`,
`location = /_streamhub_hls_auth`, `location ~ ^/hls/…` + `location @streamhub_core`
blocks (and the `map "$streamhub_hls_scope|$uri" $streamhub_hls_cache` at http level)
pasted in.

**Upgrading a pre-3.4 nginx vhost with direct-serve ON** — the old vhost serves
`/hls` from disk *without asking the core*, which would hand out the segments of apps
with `public_playback:false` without a token. Re-running `install.sh` warns about it
(`… predates the /hls auth_request`); regenerate or merge the vhost before relying on
private playback. The Caddyfile ships in the repo, so the compose shape picks the
change up on the next `docker compose up -d caddy`.

### Trade-offs while it is on (why it's opt-in)

Disk-served segment BYTES never reach the core (only their bodiless auth subrequest
does), so:

- the per-app HLS egress-**bytes** counter (`GET /apps/:app/net`, the network threshold
  alert) only sees fall-through requests — measure served bytes at the proxy instead;
- since 3.4.0 playlists are never disk-served, so the `STREAMHUB_HLS_CDN` playlist
  policy applies to them again;
- the token check, geo-blocking and the core's network security layer (IP
  allow/blocklist, auto-ban — it wraps every route, `/hls-auth` included) DO gate
  disk-served segments, through the auth subrequest; the core's access log shows the
  `/hls-auth` line instead of the segment;
- the samples origin (`STREAMHUB_SAMPLES_URL`) host is unaffected: its `/hls` keeps going
  through the core.

## Measure the knee first — `loadgen hls` ("fly mode")

Before paying for a cloud ramp, find the fan-out knee locally against any HLS endpoint —
the core directly, the proxy with direct-serve on/off, an edge, or a remote origin. The
viewer simulator is the Go load generator in `streamhub-core-go/test/bench/loadgen` (it
replaced the Node `scripts/hls-loadtest.mjs` of the 2.x branch):

```bash
cd streamhub-core-go
go build -o /tmp/loadgen ./test/bench/loadgen

# dry-run: print the ramp plan, send nothing
/tmp/loadgen hls -plan -ramp 100,1000,5000,10000

# real run against a live playlist (a master playlist resolves to its first variant)
/tmp/loadgen hls -url https://<host>/hls/<app>/<room>/index.m3u8 \
    -ramp 100,500,1000,2500,5000,10000 -hold 20s

# no live stream handy? fake one on the origin's disk (4 s segments, 1–2 MB each)
/tmp/loadgen feeder -dir <DATA_DIR>/apps/live/hls/bench
```

Each virtual viewer holds one keep-alive connection, polls the media playlist every
target duration and downloads each new segment once, starting 3 segments behind the live
edge like hls.js. Viewers join at `-joinrate`/s (default 100). Per step it prints one JSON
line: segment p50/p95/p99/max, playlist p95, errors, stalls, MB/s and a `verdict`; the
**knee** is the first step where segment p95 > `-target-p95` (default 2 s) or errors >
`-max-error` (default 2 %), and the ramp stops there (`-stop-at-knee=false` keeps going).
`-viewers N` runs one fixed level, `-insecure` accepts a self-signed origin, and `-pid` /
`-metrics` sample the server's CPU/RSS and `/metrics` when it runs on the same box. One
machine's sockets/CPU cap absolute concurrency — run K copies for ~K× load. Compare the
knee with direct-serve **off** vs **on** to see the difference on your own hardware.
`test/bench/bench.sh` is the full Node-vs-Go benchmark driver built on the same modes.

## Go horizontal: edge fan-out

One origin serving from disk scales far, but for truly large or geo-spread audiences,
add **edge caches** that serve `/hls` while the origin does ingest/record only.

- `deploy/nginx-hls-edge.conf` (or `deploy/Caddyfile.edge`) is a caching HLS edge vhost:
  it caches segments from the origin and serves viewers from its own disk. Put edges
  behind DNS/GeoDNS or a CDN and point players at them; capacity scales ~linearly with
  edge count. See [features/HLS-CDN.md](../features/HLS-CDN.md).
- Segments are `immutable`, so edge cache hit-rates are near 100% after the first
  viewer; only the small playlist is re-fetched each target duration
  (`STREAMHUB_HLS_CDN=on` lets edges cache it for a short live TTL).
- Direct-serve on the **origin** makes origin→edge fills disk-served too.

See `planning/LOADTEST-REPORT.md` and `planning/GO-CORE-BENCHMARK.md` for measured knees
and methodology, and [INSTALL-NODE.md](./INSTALL-NODE.md) for joining nodes to a cluster.
