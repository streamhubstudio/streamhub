# Serving VOD + Live through a CDN (OTT playbook)

How to serve StreamHub **VOD** and **live HLS** through an external CDN (CloudFront,
Cloudflare, Fastly, Bunny…) **or** through the cluster's own edge nodes acting as a
pull-through CDN. Written for an OTT front-end (e.g. a Laravel app) that embeds the
StreamHub player. Cross-ref: [`HLS-CDN.md`](./HLS-CDN.md), [`players.md`](./players.md),
[`CLUSTER-OBSERVABILITY.md`](../operations/CLUSTER-OBSERVABILITY.md).

## The three delivery planes

| Content | Origin object | Playback URL today | CDN strategy |
|---|---|---|---|
| **VOD** (recordings + their HLS renditions) | app's **S3** bucket | `<s3.public_url>/<key>` when the app has a public/CDN base, else a short-lived presigned GET | Put a CDN **in front of the S3 bucket**, set `s3.public_url` to the CDN hostname |
| **Live HLS** (`.m3u8` + `.ts`) | origin disk, served at `/hls/<app>/<room>/…` | `<PUBLIC_BASE_URL>/hls/…` (or proxy-derived) | Put a CDN / edge cache **in front of `/hls`**; `STREAMHUB_HLS_CDN=on` makes the cache-control correct |
| **Live WebRTC** (sub-second) | LiveKit SFU | `wss://…/rtc` | Not CDN-able — LiveKit media goes P2P from the owning node (see the cluster docs) |

## A) VOD via an external CDN (in front of S3) — already supported

VODs live in the app's per-app S3 bucket. When the app config sets a **public/CDN base**
the download/playback URL is built as `<s3.public_url>/<objectKey>` instead of a presigned
GET (`internal/recording`, the app's `s3.public_url` in `internal/apps`). So:

1. Create a CDN distribution whose **origin is the app's S3 bucket** (CloudFront → the
   bucket; Cloudflare/Bunny → the bucket's static endpoint). Restrict the bucket to the CDN
   (OAC/OAI) if the content is entitlement-gated.
2. In the app's `config.yaml`, set the S3 `public_url` to the CDN hostname (and confirm the
   "public VODs" acknowledgement — enabling `public_url` makes recordings reachable at that
   base, not presigned). Now `GET /apps/:app/vods/:id` returns `publicUrl =
   https://<cdn>/<key>`, which the player/OTT uses directly.
3. The VOD's **HLS renditions** (from the vod-transcode ladder) are objects under the same
   bucket, so they ride the same CDN automatically.

**OTT note:** for signed/entitled VOD, keep `public_url` pointing at a CDN that enforces
signed URLs/cookies (CloudFront signed URLs, Cloudflare token auth) — StreamHub hands the
OTT the object key; the OTT/edge signs it. Geo/entitlement is an edge concern (see §D).

## B) Live HLS via an external CDN

1. Set `STREAMHUB_HLS_CDN=on` on the origin (core). This makes `/hls` cache-control
   CDN-correct: `.ts` segments `immutable, 1y`; the live `.m3u8` short-TTL +
   stale-while-revalidate so a CDN can cache-collapse concurrent viewers without serving a
   stale edge (see `HLS-CDN.md`).
2. Point a CDN distribution at the origin (`https://<origin>/hls/*`). Honour the origin
   cache-control (don't override). For a bounded live window / DVR, enable the app's
   `features.linear.dvr` so the public manifest is the rolling `live.m3u8`.
3. The OTT plays `https://<cdn>/hls/<app>/<room>/index.m3u8` (or `live.m3u8` for DVR).

## C) Cluster nodes as a CDN (pull-through edge cache) — no external CDN needed

Instead of (or in addition to) a commercial CDN, run a **pull-through HLS cache on cluster
edge nodes** and send viewers to the nearest edge. The cache config ships in the repo:
`deploy/nginx-hls-edge.conf` (nginx `proxy_cache` with request-collapsing +
stale-while-revalidate) / `deploy/Caddyfile.edge`.

Per edge node (e.g. media02/media03):
1. Add `deploy/nginx-hls-edge.conf` to the node's nginx: it proxies `/hls/*` to the origin
   (`proxy_pass https://<origin>/hls/…`) with a local `proxy_cache`, honouring the origin's
   `Cache-Control` (`.ts` cached hard, `.m3u8` briefly). Reload nginx.
2. Point the OTT/player's HLS base at that edge: `https://<edge-host>/hls/<app>/<room>/…`.
   The edge fetches once from the origin and serves every local viewer from cache → the
   origin uploads each segment once regardless of audience size (~N×bitrate → ~1×bitrate).
3. For VOD-on-edge: the same edge can pull-through-cache the app's S3 public base
   (`proxy_pass https://<s3-or-cdn>/…`) so VOD segments are also cached at the edge.

**Caveat (multi-region live):** a live room's segments only exist on the node whose egress
produced them, so a *different* node's edge cache is a pull-through from the origin, not from
local disk — bandwidth still leaves the origin once per segment. True multi-region live
origin-shielding needs egress→S3 (cluster roadmap #0). For **VOD** there is no such caveat —
S3 is the shared origin, so every edge caches equally.

## D) Choosing per-app / per-content

- **Player**: the OTT embeds the StreamHub player (video.js by default, or the **Vidstack**
  player plugin — see `players.md`), pointed at whichever base URL above. The player is
  agnostic to where the HLS/MP4 comes from.
- **Entitlement/geo**: gate at the CDN/edge (signed URLs/cookies, GeoIP) in front of `/hls`
  or the S3 CDN. StreamHub's own signed-playback tokens gate the **WebRTC** plane; `/hls` is
  public+CORS-open by design for ad-supported embeds (`ENDLESS-RADIO-STATUS.md` QW-5).

## Quick recipes
- **External CDN, everything**: `s3.public_url = https://cdn.example.com` (VOD) +
  `STREAMHUB_HLS_CDN=on` and a CDN in front of `/hls` (live). OTT plays the CDN URLs.
- **Cluster-only CDN**: `nginx-hls-edge.conf` on each edge + OTT points region-nearest edge.
- **Hybrid**: commercial CDN for VOD (global, cheap egress) + cluster edges for live
  (low-latency, no third-party).
