# Operations — Environment variables

The canonical template is [`.env.example`](../../.env.example) at the repo root (used by
Docker Compose and `install.sh`). This is the annotated reference. Secrets are **never**
committed. Anything ending in `_SECRET`/`_PASS`/`_TOKEN` must be long and random in prod.

## Public identity / TLS (Compose + installer)

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_DOMAIN` | `streamhub.example.com` | The single public domain Caddy fronts (dashboard + API + `/rtc`). Real hostname with a **DNS-only** A record (not Cloudflare-proxied — WebRTC is UDP). `localhost` for a local self-signed test. |
| `ACME_EMAIL` | `admin@example.com` | Let's Encrypt / ACME registration email (real domains only). |

## LiveKit (shared by server + ingress + egress)

| Var | Default | Meaning |
|---|---|---|
| `LIVEKIT_API_KEY` | `APIchangeme…` | LiveKit API key. `livekit-server generate-keys` (installer generates one). |
| `LIVEKIT_API_SECRET` | change-me | LiveKit API secret. |
| `LIVEKIT_URL` | `ws://127.0.0.1:7880` | How core reaches LiveKit locally (control plane). |
| `STREAMHUB_EGRESS_COMPOSITE_CPU` | `2.0` | CPU the egress **reserves** per room-composite job (live HLS, recording) before accepting it — written into the egress config by `docker-compose.yml` (recreate `egress` to apply). It caps how many live-HLS streams one origin runs at once: ≈ `0.8 × vCPU ÷ value` (8 vCPU → 3 at 2.0). LiveKit's own default is 4, which let an 8-vCPU origin take a single live HLS although a 720p30 composite measured ~0.9 CPU (max 1.7); a 2nd `hls/start` then failed with `no response from servers` ([LOADTEST-4-REPORT.md](../../planning/LOADTEST-4-REPORT.md)). Raise it for 1080p/heavier layouts; lower only after measuring. |
| `LIVEKIT_USE_EXTERNAL_IP` | `true` | Compose → LiveKit `rtc.use_external_ip`. `install.sh --node-ip auto` (or an IP) sets `false` on a cloud 1:1-NAT host (detected from the AWS/GCP/Azure instance metadata) together with `LIVEKIT_NODE_IP`, for clusters whose media ports are closed to the internet: with the STUN-detected public IP the egress' headless Chrome then can't reach LiveKit (black / no HLS — AWS load tests LT3/LT4). WebRTC clients outside that private network then need TURN or a VPN. Default (`--node-ip off`): unset, STUN detection. |
| `LIVEKIT_NODE_IP` | — (autodetect) | Compose → LiveKit `rtc.node_ip`: the IP LiveKit advertises (the PRIVATE IP on a 1:1-NAT cloud host). Written by `install.sh` with `LIVEKIT_USE_EXTERNAL_IP=false`; the choice (`auto`/`off`/an IP) is persisted as `STREAMHUB_PROFILE_NODE_IP` so `streamhub upgrade` keeps it. |
| `COMPOSE_PROFILES` | — | Compose profiles to start. `install.sh --proxy caddy` writes `caddy` (the `caddy` service only runs under that profile, so an nginx-fronted host never starts it); an nginx origin has it stripped. `.env.example` ships `caddy` for the plain `docker compose up -d` shape. Others: `mediamtx`, `rtmps`. |

### TURN relay (embedded LiveKit TURN/TLS)

OFF by default. Without TURN, clients behind symmetric NAT / VPN / corporate
firewalls (Safari/iOS the strictest) can't establish WebRTC. LiveKit terminates
the TURN cert itself and hands ICE servers to clients in the JoinResponse — the
browser needs nothing. **v1 is ORIGIN-only + the nginx shape only** (needs the
on-disk letsencrypt PEMs; Caddy keeps certs in its own store). Enable with the
installer's `--turn` (issues the cert, opens the ports, flips the seam once the
cert exists); or set these by hand and `streamhub restart`.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_TURN_ENABLE` | `false` | Turn on LiveKit's embedded TURN/TLS relay (`tls_port 5349`, `udp_port 3478`). The installer only flips this to `true` **after** the cert is on disk — LiveKit loads `cert_file` at boot, so enabling it without the cert crash-loops livekit. |
| `STREAMHUB_TURN_DOMAIN` | `turn.localhost` (installer: `turn.<domain>`) | The TURN FQDN advertised to clients. Needs **its own DNS A record → this host**. `cert_file`/`key_file` derive from it (`/etc/letsencrypt/live/<turn-domain>/…`). |
| `STREAMHUB_TURN_CERT_DIR` | `./data/certs/turn` (installer: `/etc/letsencrypt`) | Host dir bind-mounted **read-only** into the livekit container at `/etc/letsencrypt`. Mounting the whole certbot store keeps the `live/` symlinks resolvable (`archive/` is under the same mount). Default is a harmless empty dir when TURN is off. |

Firewall: open `5349/tcp` + `3478/udp` (the installer's ufw step does this).
Networks that only allow outbound 443 need the relay on 443 (dedicated IP) or an
external coturn — out of scope for v1. See
[features/WEBRTC-BROWSER-COMPAT.md](../features/WEBRTC-BROWSER-COMPAT.md).

## streamhub-core runtime

| Var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Local bind of core (the reverse proxy targets this). |
| `PORT` | `3020` | Core HTTP port. |
| `PUBLIC_WS_URL` | `wss://<domain>` | ws/wss URL handed to browser clients in join links/tokens. Localhost: `ws://127.0.0.1:7880`. |
| `RTMP_PUBLIC_HOST` | `<domain>` | Public host advertised for RTMP push URLs. |
| `STREAMHUB_RTMPS_ENABLE` | `false` | Advertise a TLS `rtmps_url` next to `rtmp_url` on the ingress endpoints. Requires the `rtmps` compose profile (stunnel front) to also be started — see [RTMPS ingest](#rtmps-ingest-tls-terminated-rtmp-in). |
| `STREAMHUB_RTMPS_PORT` | `1936` | TLS listen port of the RTMPS front (and the port in the advertised `rtmps://` URL). |
| `RTMPS_PUBLIC_HOST` | `` (→ `RTMP_PUBLIC_HOST`) | Public host for the `rtmps://` URL. Empty falls back to `RTMP_PUBLIC_HOST`. |
| `STREAMHUB_RTMPS_CERT_DIR` | `./data/certs/rtmps` | Host dir bind-mounted into the stunnel front; must hold `fullchain.pem` + `privkey.pem`. Point at `/etc/letsencrypt/live/<domain>` to reuse the certbot cert with zero copying. |
| `STREAMHUB_RTMP_BACKEND` | `127.0.0.1:1935` | Where the RTMPS front forwards the decrypted RTMP (the plaintext ingress). |
| `STREAMHUB_RTMP_PASSTHROUGH_ENABLE` | `false` | RTMP→HLS passthrough (remux, no transcode — AntMedia-style): accept an H.264/AAC push (RTMP, or SRT via `{inputType:'srt'}`) — or **PULL** an MPEG-TS-over-UDP unicast/multicast source (`{inputType:'mpegts', url:'udp://@GROUP:PORT'}`) — and `ffmpeg -c copy` it straight to HLS, **bypassing LiveKit** (near-zero CPU, no GPU). Runs independent of the :1935 ingress + transcode path. This one switch gates all three transports (RTMP/SRT push + MPEG-TS pull). Per-app opt-in via `rtmp.passthrough` / the `rtmp-passthrough` preset + the ingress API `{mode:'passthrough'}` — see [features/rtmp-passthrough.md](../features/rtmp-passthrough.md), [features/mpegts-multicast.md](../features/mpegts-multicast.md). |
| `STREAMHUB_RTMP_PASSTHROUGH_PORT` | `1937` | Base port the passthrough front binds (NOT LiveKit's :1935). Each concurrent RTMP/SRT passthrough ingress takes the next free port from here. RTMP (TCP) and SRT (UDP) ingresses share this pool and the same enable gate — no SRT-specific env. **MPEG-TS ingresses do NOT use this pool**: they are a PULL (no listener), so the group/port lives in the `udp://@GROUP:PORT` source, not a bound base port. |
| `STREAMHUB_MEDIAMTX_ENABLE` | `false` | **Single public RTMP port (:1935) via a MediaMTX front.** When on, MediaMTX terminates every publish on :1935 and fires loopback hooks to the core, which classifies by stream key — a `ptk_` key → passthrough remux, else (a real `live/<key>`) → forward to the LiveKit ingress (moved to the internal :11935) — replacing the multi-port model (LiveKit :1935 + passthrough :1937+, the fallback when off). Enable it as a set with `STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=11935` + `STREAMHUB_MEDIAMTX_HOOK_SECRET`, and start the MediaMTX front (installer `--mediamtx`, or `docker compose --profile mediamtx up -d`). Read at boot → **restart to apply**. See [features/rtmp-single-port.md](../features/rtmp-single-port.md). |
| `STREAMHUB_MEDIAMTX_HOOK_SECRET` | (unset) | Shared secret the MediaMTX front presents on the core hooks: `X-MediaMTX-Secret` header on `POST /internal/mediamtx/{ready,notready}` and a `?secret=` query on `/internal/mediamtx/auth` (`authHTTPAddress` can't send a header). The core rejects a hook without the matching value. **Required** when `STREAMHUB_MEDIAMTX_ENABLE=true` (the installer generates one). Must be long + random. |
| `STREAMHUB_MEDIAMTX_RTMP_PORT` | `1935` | Public RTMP port MediaMTX owns — also the port the core advertises in passthrough push URLs (`rtmp://<host>:1935/<app>/<key>`) when the single-port front is enabled. Rarely changed. |
| `STREAMHUB_MEDIAMTX_API_URL` | `http://127.0.0.1:9997` | MediaMTX control-API base the core queries on **boot re-arm** (`GET /v3/paths/list`) to restore remuxes/forwards for streams already publishing after a core restart. Must match the front's `apiAddress` (loopback). Default fits the shipped `deploy/mediamtx.yml`; rarely changed. |
| `STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT` | `11935`¹ | The LiveKit **ingress** RTMP port when the MediaMTX front is enabled — BOTH the port the ingress listens on AND the core's forward target (one var, so they can't drift). ¹The core defaults it to `11935`; the compose `ingress` service defaults its *listen* port to `1935` (unchanged multi-port behaviour) and only moves to `11935` when this is set. Set to `11935` alongside `STREAMHUB_MEDIAMTX_ENABLE=true`. |
| `STREAMHUB_INGEST_PROFILE` | `livekit` | Encoding profile for the LiveKit-transcoded ingress. `livekit` (default, **stable**): StreamHub attaches no encoding opinions — LiveKit decides everything (legacy behaviour; its default is a 3-layer 720p simulcast). `efficient` (opt-in, experimental): StreamHub attaches an explicit **single-layer preset** (capped 3-layer preset when the app enables adaptive) — measured 3×1080p ≈ 100% → **~24%** of an 8-core box. Includes fallback-on-reject: if LiveKit rejects the options the create retries with LiveKit defaults, so options degrade, never break. Server-wide (set per node in a cluster); read at boot → **restart to apply**; affects newly-created ingresses. Instant rollback = set back to `livekit` + restart. See [features/efficient-transcode.md](../features/efficient-transcode.md). |
| `PUBLIC_BASE_URL` / `STREAMHUB_PUBLIC_URL` | derived from domain | Base URL used to build player/embed/sample URLs. |
| `STREAMHUB_SAMPLES_URL` | (unset) | **Own origin for the per-app sample pages** (absolute, e.g. `https://samples.example.com`; reduced to its origin). Set: `/samples/*` is served only when `Host` is that host (which also serves `/api`, `/sdk`, `/hls` for the pages' same-origin calls and redirects everything else — SPA included — to `PUBLIC_BASE_URL`); `/samples/*` on any other host is a `302` there; pages, `embedUrl`s and the dashboard's Samples editor use it; and `sample:write` is plain RBAC again. Unset: samples share the dashboard origin and `sample:write` is superadmin-only. The proxy must forward the original `Host`. Invalid, or equal to `PUBLIC_BASE_URL`'s origin → ignored. Read at boot → **restart to apply**. See [features/samples.md](../features/samples.md#own-origin-for-samples-streamhub_samples_url). |
| `SAMPLES_DOMAIN` | (unset) | **Docker shape only** (read by Caddy, not the core): the samples hostname Caddy serves (auto-TLS like `STREAMHUB_DOMAIN`; `http://<host>` for plain HTTP). Pair with `STREAMHUB_SAMPLES_URL=https://<SAMPLES_DOMAIN>`; installer flag `--samples-domain`. |
| `STREAMHUB_HLS_CDN` | `off` | Make live HLS **playlists** cacheable by an edge/CDN (`.ts` segments are always immutable + long-cached). Off → `.m3u8` is `no-cache` (pre-CDN behavior); `1/true/on/yes` → `.m3u8` gets a short live TTL + `stale-while-revalidate` (and a longer TTL once finished). Turn on when fronting `/hls` with a CDN or edge cache — see [features/HLS-CDN.md](../features/HLS-CDN.md). |
| `STREAMHUB_HLS_SEGMENT_S` | `4` | Live HLS **segment length** in seconds (integer `1`–`10`; anything else → `4` + a boot warning). Sets the LiveKit egress `segment_duration` of every new live HLS egress (an app's `features.hls.segment_seconds` still wins for that app) and the `stale-while-revalidate` (= segment/2, ≥ 1 s) of the CDN live-playlist header. Also scales the dead-egress check (a playlist frozen for 3 segments). Running egresses keep their length until restarted. Read at boot → **restart to apply**. See [Live HLS latency](#live-hls-latency). |
| `STREAMHUB_HLS_PLAYLIST_MAX_AGE` | `1` | `max-age` (seconds, integer `0`–`10`; invalid → `1` + warning) of the **live** `.m3u8` when `STREAMHUB_HLS_CDN` is on: `public, max-age=N, stale-while-revalidate=<segment/2>`. `0` → `public, max-age=0, must-revalidate` (no TTL, no stale serving) — only for an edge that micro-caches on its own. No effect with `STREAMHUB_HLS_CDN` off (`no-cache`), on finished playlists (1 h) or on segments (1 y, immutable). Read at boot → **restart to apply**. See [Live HLS latency](#live-hls-latency). |
| `STREAMHUB_HLS_EDGE_SELECT` | `off` | **HLS edge selection** over the registered **cdn-edge** nodes (HLS cache nodes joined with `install.sh --cdn-edge`, listed in `GET /cluster/nodes` with their `stats.cdn`). `off` → every playlist URL the API hands out points at the origin (pre-3.4 contract). `least-loaded` → for **public apps without enforced geo rules**, `playlistUrl` (`hls/start`, `hls/status`, `hls-token`), `hlsUrl` (passthrough, sign) use the base URL of the healthy cdn-edge (status `active`, heartbeat < 150 s, `http(s)` url) with the lowest `cdn.txMbps` (tie → fewer `conns`, then node id); no healthy edge → the origin. Private apps (signed HLS) and geo-blocked apps always stay on the origin. Pair with `STREAMHUB_HLS_CDN=on`. See [features/HLS-CDN.md](../features/HLS-CDN.md#registered-cdn-edges-and-hls-edge-selection). |
| `STREAMHUB_GEOIP_DB` | — | Path to a local MaxMind **GeoLite2-Country** (or -City) `.mmdb`, read by the core at boot (pure Go, memory-mapped). Enables per-app geo-blocking (`features.geo`, [signed-hls.md](../features/signed-hls.md#geo-blocking)). Unset or unreadable → geo-blocking OFF (logged at boot; an app with `features.geo` logs a warning once). The base is not shipped (MaxMind licence: free account + `geoipupdate`); refresh it and restart the core. |
| `STREAMHUB_HLS_DIRECT_SERVE` | `off` | `1/true/on/yes` → the front proxy (Caddy in the compose shape; nginx via `install.sh`) serves live HLS **segments straight from disk** (`sendfile`) instead of proxying them to the core, each one after an `auth_request`/`forward_auth` to the core's `/hls-auth` (signed HLS of private apps + geo — direct-serve never exposes a private app); playlists always go to the core (3.4.0). Misses fall back to the core, so VODs and control routes still work. Off → every `/hls` request goes through the core (which already handles ~10k viewers per origin). Trade-offs while on: the per-app HLS egress-**bytes** counter only sees fall-through requests, disk-served playlists are always `no-cache` (no `STREAMHUB_HLS_CDN` TTL), and the core's IP allow/blocklist does not see disk hits. Read by the `caddy` service (recreate it to apply) and by `install.sh` when it writes the nginx vhost. See [SCALING.md](./SCALING.md). |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis for LiveKit ingress/egress coordination. (The 3.x Go core runs its own jobs/schedules in-process and never dials it; the value is only reported, host:port, in `GET /system/settings`.) |
| `NODE_ENV` | `production` | Node environment. |
| `STREAMHUB_SHADOW` | `off` | **Go core only.** `1/true/on/yes` = serve HTTP but start **no** background work (timers, watchdogs, reconcilers, worker resume, boot re-arm; callbacks/MQTT don't publish). For running a second core side by side with a live one on the same LiveKit/host (e.g. the Go-vs-Node comparison instance) without both acting on shared media state. Never set it on the serving core. |
| `SYSTEMD_UNIT` | `streamhub-core` | Unit restarted by `POST /admin/restart` (`systemctl restart <unit> \|\| sudo -n systemctl restart <unit>`) — plain-server installs only (e.g. `skyline` on stream01). |
| `STREAMHUB_HLS_WATCHDOG` | `on` | `off` disables the always-on HLS / DVR watchdog: every interval it reconciles apps whose `features.linear` opts into always-on HLS (relaunches a dead egress once — one LiveKit no longer lists, or one it still lists whose `index.m3u8` stopped advancing for 3 segment durations) and/or DVR (prunes expired segments). Also off under `NODE_ENV=test`. |
| `STREAMHUB_HLS_WATCHDOG_INTERVAL_S` | `30` | Watchdog pass interval in seconds (values < 5 or invalid → 30). |

### Live HLS latency

Live HLS glass-to-glass is roughly 3 segments of player buffer + the egress
segment + the edge's playlist propagation: measured **11–13 s** with the
default 4 s segments (LT4), of which ~1.2 s is the edge holding the playlist
(`max-age=1` + `stale-while-revalidate=2`). The two knobs trade delay for
requests; the defaults are exactly the pre-knob behaviour.

| Setting | Expected delay | Cost |
|---|---|---|
| `STREAMHUB_HLS_SEGMENT_S=4` (default) | 11–13 s | baseline |
| `STREAMHUB_HLS_SEGMENT_S=2` | ≈ half the segment-driven part (estimated ~6–7 s) | ~**2×** playlist and segment requests per viewer (to the edge, and edge → origin), ~2× files per room on disk; slightly worse compression (a keyframe every 2 s) |
| `STREAMHUB_HLS_PLAYLIST_MAX_AGE=0` | about −1 s at the edge | every player poll revalidates; see below |

`STREAMHUB_HLS_PLAYLIST_MAX_AGE=0` sends `public, max-age=0, must-revalidate`:
no browser caching and no stale playlist from a standards-compliant cache. An
edge that honours the origin header then **does not cache the playlist at
all** — every viewer's poll reaches the origin. Use `0` only with an edge that
micro-caches itself (nginx: `proxy_cache_lock on` + a short
`proxy_cache_valid 200 1s` with the origin's `Cache-Control` ignored for
`.m3u8`), so concurrent polls still collapse into one origin request. The
edge config is the owner's call — [features/HLS-CDN.md](../features/HLS-CDN.md).

Measure every change with `loadgen latency mode=hls` through the edge, and
watch edge → origin requests (the M3 metric) while it runs.

### RTMPS ingest (TLS-terminated RTMP-in)

Ingest is plain RTMP on `:1935` by default. To accept **encrypted** RTMP push
(`rtmps://`), StreamHub ships an opt-in TLS front (`stunnel`) that terminates TLS
on `:1936` and forwards the decrypted stream to the plaintext ingress on
`:1935`. The wrapper is transparent, so the `rtmps://` URL is the `rtmp://` URL
with only the scheme and port swapped — **same `/live/<stream-key>` path, same
stream key**. (LiveKit ingress has no native RTMPS listener; this is the
supported pattern.)

Enable it in two steps:

1. In `.env`: `STREAMHUB_RTMPS_ENABLE=true` (so core advertises the `rtmps_url`),
   plus `STREAMHUB_RTMPS_CERT_DIR` pointing at a dir with `fullchain.pem` +
   `privkey.pem`. On the default nginx+certbot install that is
   `/etc/letsencrypt/live/<your-domain>` (used as-is). On the Caddy proxy shape,
   export the domain cert into `./data/certs/rtmps/` (Caddy keeps it under its
   `caddy_data` volume at `.../certificates/…/<domain>/`).
2. Start the front: `docker compose --profile rtmps up -d`.

Then open the firewall for the TLS port: `ufw allow 1936/tcp`. The ingress
endpoints (`POST /apps/:app/ingress`, the ingress listing) now return an
`rtmps_url` alongside `rtmp_url`. Publish to it exactly like the RTMP URL (OBS:
Server = `rtmps://<host>:1936/live`, Stream Key = the stream key). Renew the cert
as usual — restart the `rtmps` service (or let it restart) to pick up a new cert.

## Auth / RBAC

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_JWT_SECRET` | change-me | Signs the dashboard login JWT (`POST /api/v1/auth/login`). Also the root the signed playback URLs and the HLS `?st=` token key are **derived** from (labelled HMAC, never the raw secret): rotating it invalidates every issued playback link and HLS token. Without it private apps cannot mint either (503) and their `/hls` answers 403. |
| `ADMIN_USER` | `admin` | Break-glass dashboard admin user. Login disabled if user or pass is empty. |
| `ADMIN_PASS` | change-me | Break-glass admin password. |
| `STREAMHUB_API_TOKEN` | `sk_change_me` | Global API bearer token (`Authorization: Bearer sk_…`). Stored here only so re-running the installer stays idempotent; the DB keeps a hash. Seeded via `streamhub-core seed-token` (the installer pipes it on stdin). |
| `STREAMHUB_AUTHZ_ENFORCE` | `on` | RBAC + quota + per-app-token isolation mode: `off` \| `log` \| `on`. **Default is now `on`** (secure-by-default, Fase-0). `log` runs the same checks but only **logs** what they would block (use it to migrate a deployment that ran unenforced). In every mode GLOBAL `sk_` tokens and the break-glass admin bypass RBAC; only **app-scoped** `sk_` tokens are confined to their own app. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Max attempts per client IP per window on the SENSITIVE auth routes only (login, magic-link, magic/verify). The rest of the API (incl. dashboard polling) is not limited. Exceeding it → `429`. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in ms (default 15 min) for the auth routes above. |
| `STREAMHUB_AUTH_IP_LIMIT` | `10` | Auth throttle (3.3.4, in memory, independent of the autoban): max password/TOTP attempts per client IP per **minute** over `/auth/login`, `/auth/magic/verify` and `/account/2fa/{enable,disable}` → `429` + `Retry-After`. `0` = off. |
| `STREAMHUB_AUTH_ACCOUNT_FAILS` | `5` | Auth throttle: consecutive failed passwords/TOTP codes of one account (from any IP) before it is locked — 30s, doubling per further failure, max 15 min; the right password is refused while locked, a success resets it. `0` = off. |
| `STREAMHUB_PUBLIC_REGISTRATION` | (unset → off) | Enables PUBLIC user registration / self-signup (`POST /auth/signup` + the "Create account" flow in the dashboard). `1`/`true`/`on`/`yes` → anyone can create an account + their own free-plan tenant. Unset/anything else → **invite-only** (default): a brand-new email gets `403 signup_disabled` and a magic link to it is not sent (same generic answer) nor creates an account; an invited *pending* user can still complete signup; break-glass admin, existing users and admin-driven user creation are unaffected. Surfaced to the SPA via `GET /auth/config` (which hides the register UI when off). |
| `STREAMHUB_ALLOW_SIGNUP` | (unset → off) | **Legacy alias** for `STREAMHUB_PUBLIC_REGISTRATION` (same values/semantics). Kept for backward compatibility; consulted only when the canonical flag is unset. Prefer `STREAMHUB_PUBLIC_REGISTRATION` in new deployments. |
| `STREAMHUB_SUPERADMIN_EMAIL` | (unset → none) | Email that becomes the superadmin principal when it signs in via magic-link. **No default since 3.3.3**: unset = no email is ever promoted (the break-glass `ADMIN_USER`/`ADMIN_PASS` login still works). The promotion also requires that no other user owns that email (unless the `admin` mirror already holds it), so a user can't inherit it by taking the address. Set it with `install.sh --superadmin-email <e>`. |
| `STREAMHUB_APP_URL` | `https://app.streamhub.studio` | Public base URL of the dashboard used to build magic-link / invite URLs in emails. |

### Dashboard / API surface hardening (3.3.4)

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_DASHBOARD_CSP` | (unset → built-in) | `Content-Security-Policy` of the dashboard SPA (only the SPA: `/samples`, `/hls`, `/sdk`, `/live` and the API don't get it). Built-in: `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `connect-src 'self'` + the `PUBLIC_WS_URL` origin (`wss://` + `https://`) + `https:` (VOD/HLS from S3/CDN), plus `X-Frame-Options: DENY`. The embeddable SPA routes `/embed/*` and `/play/*` get the same policy with `frame-ancestors *` and no `X-Frame-Options`. A value replaces the policy verbatim (on `/embed`/`/play` its `frame-ancestors 'none'` becomes `*`); `off` sends neither header (escape hatch if a browser console shows a CSP block). |
| `STREAMHUB_API_DOCS_PUBLIC` | `true` | Serves the API reference publicly: `GET /api/v1/docs` (UI), `/api/v1/openapi.json` (+ `.yaml`, `-3.0.json`, `-3.0.yaml`) and `/api/v1/schemas/*`. Default `true` for backward compatibility (SDK generators, the smoke check `cmd/smoke` and integrators fetch it). **To turn it off** set `STREAMHUB_API_DOCS_PUBLIC=false` (anything not `1`/`true`/`on`/`yes`) in `.env` and restart the core: those paths then answer `404 Cannot GET …` like any unmounted route; the API itself is unaffected. The committed spec stays at `streamhub-docs/api/openapi.json` for anyone who needs it offline. |

## Network security (in-app IP access control + auto-ban)

Full feature doc: [network-security](../features/network-security.md). Loopback + RFC1918/private
IPs are ALWAYS permitted and NEVER banned (lock-out guarantee), in every mode.

These settings also gate **WebSocket upgrades** for the direct WS ingest
(`/ingest/ws`) and viewer (`/live/ws`) endpoints — a banned/blocklisted public IP
is rejected with an HTTP `403` at the upgrade (same allow/blocklist + auto-ban
precedence as the HTTP plane). No new env var: the WS gate reuses the vars below.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_IP_ACCESS_MODE` | `off` | Global IP allow/blocklist mode: `off` \| `log` (record + annotate would-blocks, never reject) \| `enforce` (blocklisted / non-allowlisted → `403`). Rules are managed at runtime via `/api/v1/security/ip-rules` (dashboard → Settings → Network security). |
| `STREAMHUB_IP_ALLOWLIST_ONLY` | `false` | Strict allowlist: in `enforce` mode, PUBLIC IPs without an explicit `allow` rule are rejected. Loopback/private always pass. |
| `STREAMHUB_AUTOBAN_ENABLED` | `false` | In-app fail2ban master switch: records offenses (failed login, failed magic verify, invalid `sk_`/JWT, auth 429s) per client IP and auto-bans repeat offenders with `429`. |
| `STREAMHUB_AUTOBAN_MAX_OFFENSES` | `10` | Offenses within the window that trigger a ban. |
| `STREAMHUB_AUTOBAN_WINDOW_S` | `300` | Sliding offense window (seconds). |
| `STREAMHUB_AUTOBAN_BASE_TTL_S` | `900` | First-ban duration (seconds). Doubles per repeat ban (escalation), capped at 7 days. Active bans persist across restarts (`ip_bans`). |
| `STREAMHUB_AUTOBAN_404_ENABLED` | `false` | Also count 404 responses (from public IPs) as offenses — catches path scanners; leave off if anything legitimate probes unknown URLs. |

## Egress SSRF guard (outbound dial protection)

Tenant-controlled outbound targets — the per-app **callback URL**, a **custom
S3 endpoint** and the **MQTT broker URL** (plus the URL-pull ingress, guarded
since the LiveKit wave) — are validated before every dial: scheme allowlist +
the host must not be / resolve to a private, loopback, link-local, metadata or
unspecified address (`169.254.0.0/16`, `127/8`, `10/8`, `172.16/12`,
`192.168/16`, `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0`). Callback URLs are
additionally rejected at **save time** (`PATCH /apps/:app/config`, raw editor).
Since 3.3.3 the outbound HTTP itself (callbacks, streamflow `action.http` /
`action.plugin` / `action.ai`, the notifier's Discord/Telegram posts, the DRM
key server, a custom S3 endpoint) also re-checks at **dial time**: the IP the
socket actually connects to must pass the same check (DNS rebinding), every
redirect is re-validated and at most 5 are followed, and `HTTP(S)_PROXY` is
ignored for these clients. The escapes below are operator-only (env, never
per-tenant) and default deny; they apply to both checks.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_CALLBACK_ALLOW_HOSTS` | (empty) | Comma-separated hostnames / IPs / CIDRs allowed as PRIVATE webhook/callback targets (e.g. `hooks.internal.lan,10.1.2.0/24`). Empty = private callback targets are always rejected. |
| `STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT` | `0` | `1` = allow a private/loopback custom S3 endpoint (self-hosted MinIO on the LAN). The `http(s)` scheme allowlist still applies. |
| `STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER` | `0` | `1` = allow a private/loopback MQTT broker URL (on-prem broker). The `mqtt/mqtts/ws/wss/tcp` scheme allowlist still applies. |
| `STREAMHUB_ALLOW_PRIVATE_SMTP_HOST` | `0` | `1` = allow a private/loopback host in a **tenant** SMTP override (per-app `PUT /apps/:app/smtp`, per-user `/account/smtp`), e.g. an on-prem relay. Since 3.3.3 those are dialed through the guard; the global `STREAMHUB_SMTP_*` relay is operator config and never checked. |

## Security audit trail (ISO 27002 §8.15/§8.16)

Always on — no enable flag. Security-relevant events (login/signup success+failure,
token mint/revoke, RBAC permission denials, app create/delete, config + S3/MQTT
secret changes, db purges, IP-rule changes, unbans, LiveKit moderation) are
appended to the tamper-evident `audit_log` table in the global DB: INSERT-only
(UPDATE/DELETE rejected by SQLite triggers) with a per-row sha256 hash chain.
Read via `GET /api/v1/system/audit` (+ `/verify` for chain integrity) or the
dashboard's Audit page; live control posture at `GET /api/v1/system/compliance`.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_AUDIT_RETENTION_DAYS` | `90` | Days audit entries are kept (the only sanctioned delete path; runs ~90 s after boot and every 6 h). `0` = keep forever. For ISO scope, auditors typically expect ≥ 12 months — set `365`+. |

## Email (SMTP — magic links, invites)

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_SMTP_HOST` | `mail.wipermax.online` | SMTP server. Without host+pass every send is skipped (logged, never crashes the request). |
| `STREAMHUB_SMTP_PORT` | `587` | `587` → STARTTLS; `465` → implicit TLS. |
| `STREAMHUB_SMTP_USER` | `no-reply@streamhub.studio` | SMTP auth user. |
| `STREAMHUB_SMTP_PASS` | (unset, **required** to send) | SMTP password — secret, never logged. |
| `STREAMHUB_SMTP_FROM` | `StreamHub <no-reply@streamhub.studio>` | From header on outgoing mail. |

> These are the **global default**, used whenever no override applies. Owner
> item 29 adds two optional overrides, resolved **per-user > per-app >
> global**: a per-app `smtp:` block in `config.yaml` (`GET/PUT
> /apps/{app}/smtp`, password in `data/secrets.json` like the S3/MQTT
> credentials — never an env var) used by that app's notifications, and a
> per-user SMTP block (`GET/PUT /account/smtp`, password encrypted at rest)
> used for mail a user initiates themselves (their own magic-link, an invite
> they send as inviter). Both have a `.../smtp/test` probe endpoint. See
> [features/smtp.md](../features/smtp.md).

## Notifications (notifier fan-out — Discord / Telegram)

Global defaults for the notifier fan-out ([features/vision-edge.md](../features/vision-edge.md#watchdog--notifications)).
Cluster-scope events (`node.online`/`node.offline`, `network.threshold_*`) fan out
to these env-configured channels; a per-app `notifications:` block in
`config.yaml` overrides/extends them (and adds the per-app callback+MQTT+email
channels). Every channel is isolated and rate-limited per (app, channel, key) for
300 s. All unset → those channels are simply skipped.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_NOTIFY_DISCORD_WEBHOOK` | (unset) | Discord webhook URL. When set, cluster events POST `{content}` to it; a per-app `notifications.discord.webhook` overrides it. |
| `STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN` | (unset) | Telegram bot token. Telegram fires only when BOTH the token and the chat id resolve. Per-app `notifications.telegram.bot_token` overrides it. |
| `STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID` | (unset) | Telegram chat id `sendMessage` targets. Per-app `notifications.telegram.chat_id` overrides it. |

## Cluster (multi-node / edge nodes)

Used by the one-liner installer when a box joins an existing control plane
(`POST /api/v1/cluster/join`). On a single-node install both can stay unset.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_CLUSTER_TOKEN` | (unset) | Shared secret an edge node must send as `X-Cluster-Token` to `POST /cluster/join` and `/cluster/heartbeat`. **Since 2.13.0 it ALSO guards the edge control WebSocket** (`/api/v1/edge/ws`): unset/empty → the WS upgrade returns `503` (channel disabled), a wrong/absent token → `401` (timing-safe). It is also the HMAC secret for the per-assignment vision ingest token. **Unset/empty → joining is disabled** (the HTTP endpoints return `503`). Must be long and random in prod. **3.3.4+: it is only the JOIN secret** — the join response carries the node's own `nodeSecret` = `hex(HMAC-SHA256(token, "node:"+nodeId))`, and heartbeat / edge WS / bundle download / master→node grid calls use that instead (see [INSTALL-NODE.md § Per-node credential](INSTALL-NODE.md#per-node-credential-334)). Rotating it invalidates every node secret (re-join all nodes). On a joined node it is **no longer needed** (only for legacy mode against a pre-3.3.4 master). |
| `STREAMHUB_CLUSTER_LEGACY_TOKEN` | `on` | **Security (3.3.4, C5.3) — migration switch.** On: where a per-node secret is expected (heartbeat, edge WS, bundle download on the master; `/grid/*` on a core edge) the raw `STREAMHUB_CLUSTER_TOKEN` is still accepted, with a one-time `warn` per surface and node — nodes joined before 3.3.4 keep working. `off`/`0`/`false`/`no`: only node secrets pass (the origin's own `nodeId=origin` heartbeat keeps using the token). Turn it off once every node is re-joined and the master log shows no more legacy warnings. |
| `STREAMHUB_NODE_SECRET` | (unset) | **Joined node only** (written by `install.sh --join` into `.env`, `heartbeat.env` and `edge.env`): this node's per-node credential, from the master's join response. On a core edge the value stored by `POST /cluster/join-master` (KV `node_secret`) wins; it authenticates the master's `/grid/*` calls. Never set it on the master. |
| `STREAMHUB_CLUSTER_REDIS_URL` | (unset) | Redis URL handed back to a joining node so it attaches to the same LiveKit coordination Redis. Unset → returned as `null` in the join payload (the node keeps its local default). |
| `STREAMHUB_CLUSTER_REQUIRE_TLS` | `on` | **Security (P0).** When on, `POST /cluster/join` only returns the LiveKit **apiSecret** + **Redis URL** if the request arrived over TLS (`X-Forwarded-Proto: https` at the trusted proxy, a direct TLS socket, or a loopback client). Over plaintext those fields are withheld (the node still gets its id + apiKey + wsUrl + a `hint`). Set `off`/`0`/`false`/`no` to allow vending secrets over plaintext HTTP (legacy behaviour). A failed `X-Cluster-Token` also records an offense for the in-app auto-ban (`modules/security`). |
| `STREAMHUB_NODE_ROLE` | `standalone` | This node's cluster role: `standalone` \| `master` \| `edge`. **Seed only** — read on FIRST boot into the `_streamhub_meta` KV, which is authoritative thereafter (so a runtime conversion via `POST /cluster/join-master` / `/cluster/leave` survives restarts regardless of this value). On an `edge`, **login is disabled** (`GET /auth/config` returns `loginEnabled:false`; every session-mint path returns `403 cluster_edge_login_disabled`) — manage the node from the master. Already-issued JWTs and `sk_` API tokens keep working. |
| `STREAMHUB_MASTER_URL` | (unset) | Master API base URL for an edge (seed only, alongside `STREAMHUB_NODE_ROLE=edge`). Surfaced on `GET /auth/config` so the SPA links "manage at the master". `POST /cluster/join-master` sets this at runtime. |
| `STREAMHUB_EDGE_SCHEDULER_POLICY` | `round_robin` | Default Vision-Edge placement policy: `round_robin` (even spread) or `weighted` (share ∝ each node's `weight`). Overridable per assignment. See [features/vision-edge.md](../features/vision-edge.md#scheduler--balancing). |
| `STREAMHUB_EDGE_ALLOW_COMMON` | `off` | When on (`1`/`true`/`on`/`yes`), `common` (full media) nodes are also eligible for edge assignments, not just `edge` nodes. |
| `STREAMHUB_EDGE_MAX_ASSIGNMENTS_PER_APP` | `200` | **Security (3.3.4).** Cap on the live (`pending`/`offered`/`running`) edge assignments one app may hold through `POST /apps/:app/edge/assignments`; past it → `429 {"error":"app_quota_exceeded","scope":"app","metric":"maxEdgeAssignments",…}`. Phased with `STREAMHUB_AUTHZ_ENFORCE` like every quota (`log` only logs); global credentials (global `sk_`, superadmin) are exempt, and so is the global `POST /edge/assignments`. `0` or negative = unlimited. |
| `STREAMHUB_MEDIAMTX_SRT_ENABLE` | `false` | **E2 — SRT behind the MediaMTX front** (needs `STREAMHUB_MEDIAMTX_ENABLE` + `STREAMHUB_RTMP_PASSTHROUGH_ENABLE`). On: an SRT passthrough ingress gets `srt_url = srt://<host>:8890?streamid=publish:<app>/<ptk_key>` instead of its own key-blind ffmpeg listener on `:1937+`; MediaMTX's auth hook checks the key (unknown → `401`), the ready hook arms an SRT pull off loopback → HLS, and an SRT `read` passes only from loopback. Compose hands the value to MediaMTX as `MTX_SRT` — use **only `true`/`false`** (the installer normalizes it in `mediamtx.env`). Open `8890/udp`. See [rtmp-single-port.md § SRT](../features/rtmp-single-port.md#srt). |
| `STREAMHUB_MEDIAMTX_SRT_PORT` | `8890` | MediaMTX SRT listener port (`MTX_SRTADDRESS=:<port>`) used in `srt_url` and by the core's loopback pull. |
| `STREAMHUB_PASSTHROUGH_HEVC` | `off` | **E1 — HEVC passthrough.** With the MediaMTX front: when MediaMTX reports a publish's video as `H265`, the passthrough remux writes fMP4 HLS (`init.mp4` + `.m4s`, `-tag:v hvc1`) so Safari / hls.js can play it; H.264 or a failed probe keep MPEG-TS. Off: no probe, MPEG-TS always (unchanged). See [rtmp-single-port.md § HEVC](../features/rtmp-single-port.md#hevc). |
| `STREAMHUB_DEVICES_ENABLE` | `off` | **Field devices (encoders).** Master switch of the device plane ([features/devices.md](../features/devices.md)): code pairing (`POST /devices/pair/start`, `GET /devices/pair/{id}`), `POST /apps/:app/devices/claim`, the app-scoped device routes and the device WS `/api/v1/devices/ws` (`Authorization: Device dk_…`). Off: every device route answers `503` and the WS refuses (`503`). `on`/`1`/`true`/`yes` enables it. |
| `STREAMHUB_NODE_EGRESS` | `0` (off) | **Egress affinity.** Installer-only (`--with-egress`), a joined **common** node. Default OFF: the node runs `livekit`+`ingress` but **not** `egress`, so every recording/HLS job is claimed by the origin's egress and lands on the origin's disk (where core uploads to S3 and serves `/hls`). Set `1` to also run egress here — but any recording/live-HLS whose egress lands on this node then breaks (origin can't find the artifact: VOD `failed` / HLS `404`, ~50% with 2 nodes) until S3 transport (see [architecture/CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md)). The choice persists in `.join-profile`, so upgrades preserve it; the `streamhub` CLI reads it from `.install-profile` (`STREAMHUB_PROFILE_EGRESS`) so `streamhub start/restart` respects it. Origin/standalone always run egress (unaffected). |

> **Conversion & heartbeat.env.** `POST /cluster/join-master {masterUrl, clusterToken, nodeName}` flips this node to an edge and calls the master's join; it returns the `heartbeatEnv` values (`STREAMHUB_NODE_ROLE=edge`, `STREAMHUB_MASTER_URL`, `STREAMHUB_MASTER_NODE_ID`, `STREAMHUB_NODE_ID`) for the operator/installer to write into `/etc/streamhub/heartbeat.env` — rewriting that host file is intentionally left to the installer, and the media plane needs a container recreate to attach. `POST /cluster/leave {masterToken?}` reverts to standalone.

## Storage / data

| Var | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Path **inside** the containers where core (and egress) read/write: `data/streamhub.db`, `apps/<name>/{recordings,hls,snapshots,samples}`, `logs/`, `sdk/`. Must be identical for `core` and `egress`. |
| `STREAMHUB_HOST_DATA_DIR` | `./data` | Host path bind-mounted to `DATA_DIR` in both containers (Compose). |
| `SDK_DIR` | `<DATA_DIR>/sdk` | Where core serves `/sdk/*` (the browser SDK) from. |
| `WEB_DIR` | `<binary dir>/web`, else `./web` | **Go core.** Where the dashboard SPA (`streamhub-web` build) is served from. The image and the plain-server bundle put it next to the binary, so it's normally unset; dev: `WEB_DIR=../streamhub-web/dist`. |
| `STREAMHUB_PLUGINS_VENDOR_DIR` | `<binary dir>/plugins-vendor` | **Go core.** Root of the composed decoupled apps (`<id>/streamhub.app.json` + `worker/`). Default resolution: this var › `plugins-vendor/` next to the binary › (repo checkout) `<repo>/plugins-vendor`. |
| `STREAMHUB_VOD_RETENTION` | `on` | `off` disables the VOD retention janitor, which deletes terminal VODs older than each app's `recording.retentionDays` (S3 objects best-effort, then the row). Apps without `retentionDays` keep VODs forever. Also off under `NODE_ENV=test`. |
| `STREAMHUB_VOD_RETENTION_INTERVAL_S` | `3600` | Janitor pass interval in seconds (values < 60 or invalid → 1 h). |
| `STREAMHUB_SNAPSHOT_SOURCE` | (auto) | Override for the on-demand snapshot capture source. |

> Per-app **credentials** (S3 key/secret, MQTT/SMTP passwords, DRM key-server token) are
> **not** env vars — they live in `data/secrets.json` (`chmod 600`) under a
> **server-derived** key `APP_<SLUG>_{S3_KEY,S3_SECRET,MQTT_PASSWORD,SMTP_PASS,DRM_TOKEN}`,
> mirrored in each app's `config.yaml` `*_env` keys (since 3.3.3 the yaml cannot point
> them elsewhere). The core never resolves an app credential from the process env, with
> one fixed exception: an app of the **platform** tenant falls back to an env var named
> exactly like one of its own five derived refs (e.g. `APP_LIVE_S3_KEY`) when
> `secrets.json` lacks it — `secrets.json` (what `PUT /apps/{app}/s3|mqtt|smtp` writes)
> wins. `STREAMFLOW_AI_API_KEY` keeps its env fallback (fixed name, read only by the
> Streamflow AI client). See [`../config-reference.md`](../config-reference.md).

## Backups (SQLite snapshots)

Full feature doc: [BACKUPS](BACKUPS.md). Daily, versioned + gzip-compressed
hot-backups (`VACUUM INTO`, never a raw copy) of **every** SQLite DB — the
global `data/streamhub.db` and each `apps/<app>/app.db` — stored under
`<DATA_DIR>/backups/<db>/<timestamp>.db.gz`. Managed at runtime from the
dashboard (Settings → Database backups) or `/api/v1/system/backups`.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_BACKUPS_ENABLED` | `true` | Master switch for the **scheduled** daily backups. `false`/`0`/`off`/`no` disables the scheduler; on-demand backups via `POST /system/backups` keep working. |
| `STREAMHUB_BACKUP_RETENTION_DAYS` | `7` | Snapshots older than this many days are pruned after every run (scheduled or manual). `0` disables age-based pruning (snapshots are kept forever — watch disk usage). |
| `STREAMHUB_BACKUP_DIR` | `<DATA_DIR>/backups` | Override for the snapshot root. Point it at a different disk/mount to survive a `DATA_DIR` volume loss. |
| `STREAMHUB_BACKUP_CRON` | `30 3 * * *` | Daily schedule (in-process cron, server-local time; 5 fields, or 6 with leading seconds). Invalid patterns fall back to the default. A boot **catch-up** run also fires when the newest snapshot is older than ~26 h (covers servers that were off at the scheduled time). |
| `BACKUP_LOCAL_DIR` | `<DATA_DIR>/backups` | Where the **host** script `deploy/backup.sh` keeps its tarballs. The core only reads it (with `BACKUP_S3_BUCKET`) for the compliance report's "Automated backups" control (`GET /system/compliance`): it checks the newest file's age there. |
| `BACKUP_S3_BUCKET` | (empty) | `deploy/backup.sh` uploads its tarball here (empty = local only). Setting it (or `BACKUP_LOCAL_DIR`) marks backups as *configured* in the compliance report. |

## Metrics

| Var | Default | Meaning |
|---|---|---|
| `METRICS_TOKEN` | (unset) | Guards `GET /metrics`. **Fase-0 default-deny:** UNSET → `/metrics` returns `404` (disabled, never leaks). Set it and `/metrics` requires a matching `Authorization: Bearer <token>` header (constant-time compare). **Since 3.3.4 `?token=` is no longer accepted** (it leaked into access logs and proxies) — a scraper that used it gets `403`; send the bearer header (Prometheus: `authorization.credentials_file`). |
| `METRICS_DEFAULT_METRICS` | on | Set `off` to disable the default `process_*` / `nodejs_*` collectors. |

### Resource-usage history (in-app, lightweight)

A built-in, dependency-free host resource-usage history — CPU / RAM / Disk / Network sampled
**once per hour** into the global DB and rendered as dot charts on the dashboard's
**Resource history** (superadmin) page via `GET /system/metrics/history`. This is the
lightweight complement to the Prometheus/Grafana stack above; see
[OBSERVABILITY](OBSERVABILITY.md) §1b. Degrades gracefully on non-Linux hosts (Network
counters need Linux `/proc`; disk needs `fs.statfsSync`).

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_METRICS_HISTORY_ENABLED` | `true` | Master switch for the **hourly** sampler. `false`/`0`/`off`/`no` disables the scheduler; the read API keeps serving whatever history is already stored. |
| `STREAMHUB_METRICS_HISTORY_RETENTION_DAYS` | `30` | Samples older than this many days are pruned after every run. `0` disables age-based pruning (kept forever). Precision is fixed at 1 hour. |
| `STREAMHUB_METRICS_HISTORY_CRON` | `0 * * * *` | Sampling schedule (in-process cron, server-local time). Invalid patterns fall back to hourly. A boot **catch-up** run fires when the newest sample is older than ~70 min. |

## Transcoding / GPU

| Var | Default | Meaning |
|---|---|---|
| `TRANSCODING_HWACCEL` | auto | Hardware-accel preference for transcoding (LiveKit egress/ingress NVENC/VAAPI — see [`deploy/GPU.md`](../../deploy/GPU.md)). |
| `GPU_DISABLE` | (unset) | Force CPU-only; skips GPU detection. |
| `STREAMHUB_FFMPEG_BIN` | `ffmpeg` | ffmpeg used by the RTMP→HLS **passthrough** remux (other core media jobs call `ffmpeg`/`ffprobe` from `PATH`). |
| `SHAKA_PACKAGER_BIN` | `packager` | Shaka Packager binary used by the **DRM** VOD packaging (`features.drm`); not shipped in the image — install it and point here when DRM is enabled. |

The core image ships **ffmpeg** out of the box (needed for snapshots, the
`h264+vp8` recording alternate and adaptive VOD post-transcode — see
[features/transcoding-gpu.md](../features/transcoding-gpu.md)); passing
`gpus: all` to the **core** service in `docker-compose.yml` (commented out by
default, opt-in) additionally lets that bundled ffmpeg use NVENC.

## Plugins / worker runtime

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_PLUGINS_ENABLE` | `true` | Master switch for the plugin framework: `false`/`0`/`off`/`no` loads no plugins (built-in or vendored) and starts no workers. |
| `PLUGIN_PYTHON` | `python3` | Interpreter the decoupled apps' workers spawn with (`python -m <worker>`). The image sets `/opt/workers/venv/bin/python` (the venv with the baked worker deps); a plain-server `deploy/deploy-core.sh` install sets `<APP_DIR>/venv/bin/python` in its systemd drop-in (venv + deps per `WORKER_DEPS`, see [DEPLOY.md §B.7](./DEPLOY.md#b7-redeploys--deploydeploy-coresh-secure-no-hardcoded-secrets)). |
| `STREAMHUB_WORKER_ENV_ALLOW` | — | Extra variable names (comma-separated) that plugin/app workers inherit from the core. Workers do **not** get the core's environment (no `JWT_SECRET`, `SMTP_PASS`, `LIVEKIT_API_SECRET`, `STREAMHUB_API_TOKEN`, S3 keys…): only OS/runtime plumbing (`PATH`, `HOME`, `LANG`/`LC_*`, `TZ`, `TMPDIR`, CA bundles, proxies, `LD_LIBRARY_PATH`, CUDA/NVIDIA, thread counts, `HF_HOME`/`TORCH_HOME`/`YOLO_CONFIG_DIR`, `XDG_*`, `VISION_AI_BASE_URL`) plus what their spawn spec sets. |
| `HEALTH_FFPROBE` / `HEALTH_FFMPEG` | `ffprobe` / `ffmpeg` on `PATH` | Media binaries the **stream-health** worker (`streamhub-core health-worker`, spawned per app by the plugin framework) probes segments with; inherited by the worker. (2.x's `PLUGIN_NODE` / `HEALTH_WORKER_DIR` are gone: the worker is the core binary itself.) Its other inputs are not env vars but the app's install config (`HEALTH_CONFIG_JSON`, set by the framework): the thresholds and, since 3.4, `edge_hls_bases` — the edge/CDN bases to probe through ([stream-health.md](../features/stream-health.md#probing-through-the-cdnedges-edge_hls_bases-34)). |
| `STREAMHUB_STREAMFLOW_DANGEROUS` | (empty = off) | Apps whose Streamflow workflows may run **execution boxes** (`action.code` / `action.shell` / `action.ssh` / `action.db` — code, commands and SQL **on the host**): comma-separated app names, or `*` for every app. Replaces the per-app `dangerousNodes` plugin setting (removed in 3.3.3; a PATCH carrying it is ignored), so a tenant can never enable them. Even for a listed app, saving a workflow that holds one (create / import / graph update / re-enable) needs a **superadmin** (`403` otherwise; `400` when the app is not listed). Re-checked on every run. At boot, enabled workflows with execution boxes in an app not listed are disabled with a `disabledReason` + a `streamflow.workflow_quarantined` audit event (idempotent). |
| `STREAMHUB_WORKER_SRC_ROOT` | (unset) | Extra root where the Studio-App **export** looks for worker sources (and the LICENSE it bundles) before the vendored package / repo checkout. The image sets `/opt/worker-src`. |

## Logging

| Var | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | pino log level. |
| `LOG_MAX_BYTES` | `10485760` | Rotating log file size cap (10 MB). |
| `LOG_MAX_FILES` | `10` | Number of rotated log files kept (count cap). |
| `LOG_RETENTION_DAYS` | `30` | Retention window for operational logs: purges `server_logs` rows **and** rotated log files older than this. `0` disables age-based purging (the file count cap still applies). The DB purge runs ~1 min after boot and every 6 h. |

## Minimal production `.env`

```env
STREAMHUB_DOMAIN=streamhub.example.com
ACME_EMAIL=admin@example.com
LIVEKIT_API_KEY=API…            # generate-keys
LIVEKIT_API_SECRET=…            # long random
PUBLIC_WS_URL=wss://streamhub.example.com
RTMP_PUBLIC_HOST=streamhub.example.com
REDIS_URL=redis://127.0.0.1:6379
STREAMHUB_JWT_SECRET=…          # long random
ADMIN_USER=admin
ADMIN_PASS=…                    # strong
STREAMHUB_API_TOKEN=sk_…        # long random
STREAMHUB_AUTHZ_ENFORCE=log
DATA_DIR=/data
STREAMHUB_HOST_DATA_DIR=./data
LOG_LEVEL=info
NODE_ENV=production
```

## Installer / CLI / release env (not `.env` keys)

These are read by `install.sh`, the `streamhub` CLI and the release tooling at
run time — they are **not** written into `.env`. Every install flag also has an
env equivalent (`install.sh --help`); the ones specific to the packaging/upgrade
flow:

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_DIR` | `/opt/streamhub` | Install dir (flag `--dir`). The CLI/systemd honor it too. |
| `STREAMHUB_SRC_URL` | `…/streamhub-src.tar.gz` | Source tarball the installer fetches. `streamhub upgrade --version X.Y.Z` points it at `streamhub-<version>.tar.gz`. |
| `STREAMHUB_LATEST_URL` | `…/latest.json` | Read-only release manifest used only to preview the target version under `--dry-run`. |
| `STREAMHUB_FORCE_REINSTALL` | `0` | `1` = re-run the upgrade steps (backup + rebuild + re-stamp) even at the target version (flag `--force-reinstall`). |
| `STREAMHUB_INSTALL_URL` | `…/install.sh` | Where `streamhub upgrade` / the re-exec prologue fetch the installer. |
| `STREAMHUB_NO_TELEMETRY` | `0` | `1` = skip the anonymous install ping (see [INSTALL.md §9](./INSTALL.md#9-telemetry--anonymous-install-ping-opt-out)). |
| `STREAMHUB_TELEMETRY_URL` | `https://streamhub.studio/api/installs` | Override the phone-home endpoint (testing). |
| `STREAMHUB_TELEMETRY_CHANNEL` | `stable` (or the image's channel) | `channel` field of the install ping. A marketplace image reports its own (`marketplace-<builder>`, from the `.image-prepared` marker) so installs can be counted per channel. |
| `STREAMHUB_PREPARE_IMAGE` | `0` | `1` = `--prepare-image`: golden-image build (deps + source + pre-pulled images + pre-built core; no `.env`, nothing started). See [MARKETPLACE.md](./MARKETPLACE.md). |
| `STREAMHUB_IMAGE_CHANNEL` | `image` | With `--prepare-image`: the telemetry channel written into the marker (Packer sets `marketplace-${source.type}`). |
| `STREAMHUB_IMAGE_REFRESH` | `0` | On a prepared image's first install: `1` = fetch the source again instead of installing the baked one. |
| `STREAMHUB_SKIP_REDIS_PREFLIGHT` | `0` | Join mode: `1` = skip the pre-start TCP check that the origin's Redis is reachable. |

Full layout, CLI reference and the release pipeline (incl. the `LANDING_*` CI
variables) are in [INSTALL.md](./INSTALL.md).
