# HLS edge / CDN caching

Front StreamHub's **live HLS** output with an edge/CDN reverse proxy so viewer
fan-out bandwidth is offloaded from the origin. This is the "cache variant" of
[CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md) §4 item #2 — near-zero
code, immediate win: the origin serves each segment/playlist ~once and the edge
fans it out to every viewer.

```
                         cache HIT (most viewers)
   many viewers ──────> [ edge/CDN cache ] ─────┐
                              │ cache MISS       │  origin serves each
                              ▼                  │  object ~once
                        [ StreamHub origin :3020 /hls ]
```

## Why it works: correct cache headers

Live HLS egress writes `index.m3u8` + `.ts` segments to
`<DATA_DIR>/apps/<app>/hls/<room>/`; the origin serves them at `/hls/...`. The
two file kinds have very different mutability, so they get different
`Cache-Control` (policy in `streamhub-core-go/internal/platform/web/hls_cache.go`,
applied by the `/hls` static mount in `static.go`):

| File | Mutability | `Content-Type` | `Cache-Control` |
|------|-----------|----------------|-----------------|
| `*.ts` segment | **immutable** once written (never rewritten) | `video/mp2t` | `public, max-age=31536000, immutable` |
| `*.m3u8` **live** playlist | rewritten every segment (~4s) | `application/vnd.apple.mpegurl` | `public, max-age=1, stale-while-revalidate=2` |
| `*.m3u8` **finished** playlist (`#EXT-X-ENDLIST`) | immutable for that recording | `application/vnd.apple.mpegurl` | `public, max-age=3600` |

All `/hls` responses also carry `Access-Control-Allow-Origin: *` so cross-origin
players and CDNs can fetch them.

The key insight:

- **Segments are the bytes.** A `.ts` file is content-addressed by its name and
  never changes, so `immutable` + a 1-year TTL means a CDN/edge caches it once
  and never revalidates. This is where ~all the bandwidth relief comes from.
- **The live playlist is tiny but hot.** Every viewer re-fetches `index.m3u8`
  every few seconds to discover new segments. `max-age=1, stale-while-revalidate`
  lets a CDN **collapse** those concurrent polls into ~1 origin request/sec while
  never serving a live edge more than a segment-half stale.
- **A finished playlist stops changing.** Once egress writes `#EXT-X-ENDLIST`,
  the playlist is frozen, so a longer TTL lets replays of a just-ended stream
  come entirely from cache. StreamHub detects this by reading the on-disk
  playlist for the `#EXT-X-ENDLIST` tag.

### The `STREAMHUB_HLS_CDN` knob

Default **off**, preserving the pre-CDN behavior: with the knob off, playlists
are served `no-cache, no-store, must-revalidate` (segments are *always*
immutable + long-cached — that policy is unconditional and safe). Turn it on to
make **playlists** briefly cacheable as above:

```bash
# .env on the origin
STREAMHUB_HLS_CDN=on     # 1/true/on/yes (case-insensitive)
```

The knob only changes the playlist policy; it is safe to leave on even without a
CDN in front (a 1-second playlist TTL is negligible for a 4-second segment
cadence). Turn it on whenever an edge/CDN or a caching proxy fronts `/hls`.

## Putting a cache in front

The playlist base URL is already reverse-proxy-aware (it honors
`X-Forwarded-Proto`/`X-Forwarded-Host`, or a configured `PUBLIC_BASE_URL`), so
you can front `/hls` with any HTTP cache without rewriting URLs. Set
`STREAMHUB_HLS_CDN=on` on the origin first.

### Option A — a generic CDN (Cloudflare, Fastly, CloudFront, …)

Point the CDN at the origin and let it **respect origin Cache-Control** (the
default for all of the above). Recommended tuning:

- **Honor origin headers** — do *not* override TTLs; the origin already sends
  the right ones per file type.
- **Enable "origin shield" / request collapsing / tiered cache** so a burst of
  concurrent viewers for the same uncached segment becomes one origin pull.
- **Cache by path only** — no cookies/auth are involved on `/hls` (it is public
  playback); strip cookies from the cache key.
- On Cloudflare specifically: a Cache Rule matching `/hls/*` with *Respect
  origin* + *Serve stale while revalidate* mirrors the intended semantics; `.ts`
  gets cached by Cloudflare's `immutable` handling automatically.

### Option B — an edge Caddy or nginx cache node

Copy-paste configs live next to the other deploy assets:

- **nginx:** [`deploy/nginx-hls-edge.conf`](../../deploy/nginx-hls-edge.conf) —
  uses the built-in `proxy_cache` with `proxy_cache_lock` (request collapsing),
  `proxy_cache_background_update` bounded by the origin's own
  `stale-while-revalidate` (no `proxy_cache_use_stale updating` — see below),
  and honors the origin's Cache-Control. Set the origin URL + `server_name`,
  create `/var/cache/nginx/hls`, reload. Check a change with
  [`deploy/test-hls-edge.sh`](../../deploy/test-hls-edge.sh) (Docker: fake origin + the
  config; `EDGE_TEST_IMAGE=<any Debian nginx image>`).
- **Caddy:** [`deploy/Caddyfile.edge`](../../deploy/Caddyfile.edge) — uses the
  Souin `cache-handler` module (build with
  `xcaddy build --with github.com/caddyserver/cache-handler`). Set the origin +
  hostname; auto-TLS is handled by Caddy.

Deploy either on a node **near your viewers**; viewers hit the edge's
`/hls/...`, the edge pulls through to the origin on a miss.

**Automated nginx edge:** `install.sh --cdn-edge --master-token … --master-ip …
[--edge-url https://cdn1.example.com] [--edge-cache-tmpfs 8g]` installs nginx with
the rendered `deploy/nginx-hls-edge.conf` (no Docker/LiveKit), registers the
edge in the cluster (`type: cdn-edge`, its public `url`) and heartbeats its
load (`conns`, `reqTotal`, `txBytes`, `txMbps`) every 15 s — see
[INSTALL-NODE.md § CDN edge node](../operations/INSTALL-NODE.md#cdn-edge-node---cdn-edge).

### Two edge pitfalls (fixed in 3.4.0, measured in LOADTEST-4)

- **Duplicate `Access-Control-Allow-Origin`.** The origin already sends `ACAO: *`;
  an edge that *adds* it again answers `*, *`, which browsers reject — every
  cross-origin web player fails through the edge (hls.js `manifestLoadError`) while
  `curl` looks fine. The nginx config now `proxy_hide_header`s the upstream copy; the
  Caddy one sets it with `header_down` inside `reverse_proxy`.
- **Unbounded stale playlists.** `proxy_cache_use_stale updating` serves a stale
  object with **no age limit**: after a quiet spell the first viewer got a playlist
  up to a minute old and hls.js stayed that far behind live for the whole session
  (glass-to-glass 20–49 s vs 11.5 s at the origin). Without `updating`, the origin's
  `stale-while-revalidate=<seg/2>` bounds it and the edge matches the origin
  (9.9–12.7 s).

## Cross-node / multi-region caveat

An edge cache pulls through to **one origin**, and today the HLS segments for a
room live **only on the node whose egress produced them** — there is no shared
object store for live HLS. So:

- A single caching edge (or CDN) in front of the origin works today and is the
  recommended setup: it offloads fan-out without needing the segments anywhere
  else.
- **True multi-region** (edges in several regions, each pulling from a *nearby*
  copy of the segments) requires breaking the filesystem coupling first —
  egress writing segments to S3 so any edge can source them. That is the
  prerequisite **#0 (S3 as transport)** in
  [CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md) §4; the multi-region
  HLS variant (#2) depends on it. Until then, point all edges at the origin that
  owns the room, or pin egress to the origin.

Also note LiveKit OSS does not cascade WebRTC media — this HLS caching only
offloads the **HLS** playback path, not the low-latency WebRTC path (§4 #7).

## Expected bandwidth relief

For a live stream with **N** concurrent HLS viewers, origin egress bandwidth
drops from ~**N × bitrate** to ~**1 × bitrate** for the segments (each `.ts` is
pulled once and fanned out by the edge), plus a small, near-constant playlist
load (collapsed to ~1 origin request/sec regardless of N). The relief grows
with the audience: a 1 Mbps stream to 1,000 viewers goes from ~1 Gbps of origin
egress to a few Mbps. The origin keeps doing the expensive work (the egress
transcode/segmentation) exactly once; the edge does the cheap, cacheable
fan-out.

### Measured (LOADTEST-4, AWS, 2026-10-31)

Origin (8 vCPU) + 2 nginx edges, real 720p30 stream (~3.3 Mbps), viewers on the
same zone ([LOADTEST-4-REPORT.md](../../planning/LOADTEST-4-REPORT.md)):

| | Result |
|---|---|
| 10,000 viewers (5k per edge), 8 min | 0 segment errors, 0 stalls, segment p95 6–8 ms, ~16 Gbps per edge |
| Origin while serving those 10k | **9.6 Mbps** out, 2–3 req/s per edge, CPU 19 % (the egress itself) |
| One edge to its NIC (c8gn.4xlarge, 50 Gbps) | 15,000 viewers at 50.6 Gbps, CPU 22 %, p95 2.3 s (≤ 10k: p95 < 65 ms) |
| Edge restart under 5k viewers | 24 refused playlist requests, 0 lost segments, 0 stalls |
| HLS glass-to-glass through the edge | p50 11.1–11.3 s with 4 s segments, the same from 1k to 15k per edge; the edge adds ~1.2 s of playlist propagation |

Rule of thumb: **viewers per edge ≈ 0.6 × sustained Gbps ÷ rendition Mbps** (60 %
of the NIC keeps p95 in the tens of ms and leaves room for a failed sibling). The
edge is network-bound, not CPU-bound — pick instances by *sustained* bandwidth.

## What it costs at scale

At 100k viewers × 3.3 Mbps the fan-out is ~330 Gbps. Twelve 50 Gbps edges carry
it (simulated from the measurements above: 55 % per edge, survives 3 failures),
and the machines are the cheap part (~USD 1.2/h spot, ~12/h on-demand on AWS). The
**delivery bandwidth is what dominates**: ~148 TB/h, ≈ USD 7,400/h at AWS's
cheapest internet-egress tier. So:

- run production edges where egress is flat-rate or cheap (dedicated servers with
  unmetered 10/25 Gbps ports, or a CDN contract), and keep the origin anywhere —
  it only ships ~1 copy of each segment per edge;
- in a cloud, keep origin↔edge traffic on private IPs in one zone (free) and
  account egress per edge/app before offering per-viewer pricing.

## Registered CDN edges and HLS edge selection

*(3.4.0 — core side; the installer half is `install.sh --cdn-edge`.)*

An nginx/Caddy cache edge can **register with the cluster** instead of being an
invisible box the viewers are pinned to by hand. The edge joins like any node,
with node type `cdn-edge` and its **public base URL** as `url`:

```bash
curl -fsS https://origin.example.com/api/v1/cluster/join \
  -H "X-Cluster-Token: $STREAMHUB_CLUSTER_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"cdn-1","ip":"203.0.113.20","url":"https://cdn1.example.com","type":"cdn-edge"}'
# → data.nodeId + data.nodeSecret (no LiveKit apiSecret / Redis URL: a cache edge needs neither)
```

then heartbeats every 60 s with its own `nodeSecret` (`X-Node-Secret`, the
3.3.4 per-node credential) and this stats contract:

```json
{"nodeId":"<id>","stats":{"role":"cdn-edge","cdn":{"conns":4100,"reqTotal":123456,"txBytes":9900000000000,"txMbps":812.5,"cacheDir":"/var/cache/nginx/hls"}}}
```

The stats are stored as-is (4096-byte cap, like every heartbeat) and shown by
`GET /api/v1/cluster/nodes` under `stats`; the dashboard's **Cluster** page
lists the cdn-edges with their Gbps out (`txMbps / 1000`), connections and last
heartbeat. A cdn-edge never opens the edge WS: it gets no processing
assignments and the edge watchdog ignores it.

### Edge selection — `STREAMHUB_HLS_EDGE_SELECT`

| Value | Behaviour |
|---|---|
| `off` (default) | Every HLS URL the API hands out points at the origin — the pre-3.4 contract, byte-for-byte. |
| `least-loaded` | The URL base is the **healthy** cdn-edge with the lowest `cdn.txMbps`; tie → fewer `cdn.conns`; tie → smallest node id. No healthy edge → the origin. |

*Healthy* = operator status `active` (a `draining`/`disabled` edge is never
picked), last heartbeat younger than **150 s** (2.5 × the 60 s interval), and an
`http(s)` `url`. An edge that has not reported stats yet counts as idle (load 0).
The registry is re-read at most every 5 s.

URLs it rewrites: `playlistUrl` of `POST/GET /apps/:app/streams/:id/hls/{start,status}`,
`playlistUrl` of `GET /apps/:app/hls-token/:room`, `hlsUrl` of
`POST /apps/:app/play-token/:room/sign`, and the passthrough ingress `hlsUrl` /
`hls_url` (create, get, list). `playerUrl`/`embedUrl` stay on the origin (the
player page is not cached). Not rewritten: the dashboard's own `/play` and
`/embed` pages (they fetch the same-origin relative `/hls/...` path) and the
generated sample pages (their `HLS_URL` is baked into files at app creation) —
point viewers at an API-provided URL (`hls-token` works for public apps too) to
get the edge.

**Only public apps without enforced geo rules are steered.** Private apps
(`features.public_playback: false`, signed HLS) and apps with `features.geo`
(while a GeoIP base is loaded) always get the origin, see the next section.

Run `STREAMHUB_HLS_CDN=on` on the origin as well, so the playlists are briefly
cacheable at the edge.

**Freshness caveat.** Selection is only as fresh as the heartbeats: a burst of
new viewers between two heartbeats lands on the same edge (players keep the
playlist host for the whole session). If audiences ramp fast, heartbeat the
cdn-edges more often (e.g. every 10–15 s; the health window stays 150 s).

### ⚠ Signed HLS (private apps) and the edge cache key

**Finding (3.4.0).** For a private app the HLS token travels in the query
string: every playlist URL the core hands out is `…/index.m3u8?st=<exp>.<mac>`,
minted per request (`exp` = now + TTL, so effectively one token per viewer), and
the core rewrites the playlist so every segment URI carries that same `?st=`.
The stock edge config keys the cache on `$uri$is_args$args`, so every viewer
would be a cache miss — and on top of that the core marks those responses
`Cache-Control: private` (playlists `private, no-cache, no-store`, segments
`private, max-age=31536000, immutable`), which nginx's `proxy_cache` honors by
not storing them at all. Net effect with `deploy/nginx-hls-edge.conf`: for a
private app the edge is a **pure pass-through** — still correct (the origin
checks every token, expired ones are refused, nothing private is ever stored
in a shared cache) but **zero offload**: the origin serves N × bitrate.
Public apps (the default) carry no token and no query string; they cache
perfectly.

**What the core does about it.** Nothing in signed HLS is relaxed: segment
names are sequential and guessable, so token-free segment URLs would make a
private app public. Instead edge selection never steers a private or geo app
to a cdn-edge (`playback.Guard.EdgeCacheable`): those viewers stay on the
origin rather than taking a pass-through hop that doubles the traffic.

**Offloading a private app anyway (operator recipe, not shipped).** An edge
may cache a private app's segments only if it **authorizes every request
itself before serving from cache** and keys the cache on the path alone. The
origin already exposes the check the direct-serve proxies use, `GET /hls-auth`
(`204` = serve, `403` = deny; the URI in `X-Original-URI`; answer header
`X-StreamHub-HLS-Scope: public|private`):

```nginx
# http {} level: never cache what is per-viewer or mutable — playlists (a
# private app's embed the viewer's own st) and the fMP4 init segment
# (rewritten when a publish restarts).
map $uri $sh_nocache {
    ~\.m3u8$       1;
    ~/init\.mp4$   1;
    default        "";
}

location /hls/ {
    auth_request /_sh_hls_auth;                       # every request, hit or miss
    proxy_pass https://origin.example.com;
    proxy_cache hls_cache;
    proxy_cache_key "$uri";                           # args (the per-viewer st) NOT in the key
    # .ts/.m4s segments are immutable and identical for every viewer once authorized
    proxy_ignore_headers Cache-Control;               # only safe because of auth_request above
    proxy_cache_valid 200 1h;
    proxy_no_cache $sh_nocache;
    proxy_cache_bypass $sh_nocache;
}
location = /_sh_hls_auth {
    internal;
    proxy_pass https://origin.example.com/hls-auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
}
```

Costs and limits: one tiny `/hls-auth` round-trip to the origin per viewer
request (HMAC + a cached per-app policy — cheap, but it is still ~N/4 req/s for
N viewers on 4 s segments; it can be micro-cached keyed on
`$remote_addr$request_uri`); playlists always go to the origin (small); and
**geo-blocking cannot be enforced through an edge today** — the core takes the
client IP from the right-most `X-Forwarded-For` hop, which is the edge, so geo
apps must stay on the origin. Because the core cannot tell an auth-aware edge
from a stock one, it never steers private apps even to an edge configured like
this; pin those viewers by hand (or wait for an edge capability flag in the
heartbeat stats — follow-up).

## Related

- [`hls-live.md`](hls-live.md) — the live HLS egress itself (start/stop/status).
- [`recording.md`](recording.md) / [`vod.md`](vod.md) — VOD playback (served from
  S3, a separate path from `/hls`).
- [CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md) §4 — the distribution
  roadmap this implements item #2 of.
