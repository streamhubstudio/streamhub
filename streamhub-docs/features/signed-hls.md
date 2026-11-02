# Signed HLS, geo-blocking and the play-auth webhook (3.4.0)

Roadmap item **G2** (`planning/FEATURE-GAPS-ROADMAP.md`); closes **A3** of the security
plan: before 3.4.0, `/hls/<app>/…` was public even for apps with
`features.public_playback: false` — anyone who guessed the room could watch a private
app over HLS while its WebRTC path required a signed URL.

Code: `streamhub-core-go/internal/playback` (token, geo, webhook, the per-app guard),
`internal/platform/web` (`/hls` gate, playlist rewriting, `/hls-auth`),
`internal/livekit` (token routes), `cmd/streamhub/playbackplane.go` (wiring).

## Signed HLS for private apps

An app with `public_playback: false` serves **every** `/hls/<app>/<room>/…` request —
playlists and segments, also under nginx/Caddy direct-serve — only with a valid token:

```
/hls/<app>/<room>/index.m3u8?st=<exp>.<mac>
```

- `exp` is unix seconds; `mac` = base64url(HMAC-SHA256(K, "hls|len:app|len:room|exp")),
  bound to the app **and** the `<room>` path segment (a token for one room never opens
  another). The length prefixes make the encoding injective.
- `K` is **derived** from the server secret (`STREAMHUB_JWT_SECRET`) with a labelled HMAC
  (`HMAC(secret, "streamhub/playback/hls-token/v1")`): the raw secret never signs a token
  and an HLS token is useless as anything else. The MAC is compared in constant time and
  the expiry is only reported once the MAC is authentic. No secret → private apps cannot
  mint (503) and their `/hls` answers 403 (fail closed).
- Lifetime: `features.hls_token_ttl_seconds` (default **21600 s = 6 h**, like the LiveKit
  token of the public play-token; clamped 60–86400).
- Without a token / with a bad one: `403 {"error":{"code":"forbidden","message":"HLS
  playback for this app requires a valid token (?st=)"}}`; expired: `… "HLS token
  expired"`. The 403 is answered **before** touching the disk, so it is the same whether
  or not the room/segment exists (no existence oracle). Public apps are served exactly
  like before (a stray `st` is ignored).
- An app whose config cannot be read is denied (its privacy is unknown); an unknown app
  falls through to the plain 404.

### Segments: playlist rewriting (not a cookie)

The token rides **only on the playlist URL**. For a private app the core rewrites the
playlist and appends the same `st` to every relative URI — segment lines, variant
playlists and the `URI="…"` of `EXT-X-KEY`/`EXT-X-MAP`/`EXT-X-MEDIA`/`EXT-X-PART`/
`EXT-X-PRELOAD-HINT`/`EXT-X-I-FRAME-STREAM-INF`/`EXT-X-RENDITION-REPORT`. Absolute URIs
(another origin, `skd:`, `data:`) are left alone, so the token never leaks elsewhere.
The token is propagated verbatim, never re-minted: a playlist cannot extend a token.

Why not a path cookie (the alternative the roadmap mentions for direct-serve): a cookie
on the media origin is a **third-party cookie** inside an embed on another site (Safari
ITP, Firefox ETP and the Chrome 3PC phase-out drop it), ExoPlayer/ffmpeg/smart-TV players
do not keep cookies between the playlist and the segments, and `Access-Control-Allow-
Origin: *` cannot carry credentials. A query token works in every player. Direct-serve
keeps working because playlists — tiny and `no-cache` — now always go to the core, and
only the segments are served from disk after an auth subrequest (below).

Cache policy of a private app: playlists `private, no-cache, no-store, must-revalidate`;
segments `private, max-age=31536000, immutable` — a CDN or the HLS edge
(`deploy/nginx-hls-edge.conf`, which honors `private`) never stores a tokenized object it
could hand to someone else. CDN-side signing (CloudFront/Bunny) is G11.

### Who adds the token

| Surface | How |
|---|---|
| `POST/GET /apps/{app}/streams/{id}/hls` (`playlistUrl`) | the core appends `?st=` for a private app (bound to the on-disk room dir) |
| `POST /apps/{app}/play-token/{room}/sign` | for a private app also returns `hlsToken`, `hlsExp`, `hlsUrl` (the playlist URL with `?st=`) |
| `GET /apps/{app}/hls-token/{room}` (public) | `{required, st, exp, ttlSeconds, playlistUrl}`; gated like `play-token` (signed URL `?exp=&sig=` for a private app, geo, play-auth). Public app → `required:false`, `st:""` |
| `/play` and `/embed` (dashboard SPA) | with `?exp=&sig=` on the page they fetch `hls-token` first and probe/play the tokenized playlist |
| Dashboard (Streams tab passthrough modal, Cockpit, share menu "Signed HLS URL") | mint through the sign endpoint (stream:read); public apps get no token and keep the bare URL |
| Samples (`/samples/…`) | **not yet** — the sample pages do not carry a signed capability for WebRTC either; for a private app pass `?exp=&sig=` yourself and append the `st` from `hls-token` |
| SDK (`streamhub-adaptor`) | builds no HLS URLs — nothing to do |

### Direct-serve (`STREAMHUB_HLS_DIRECT_SERVE`)

Direct-serve never exposes a private app. Before serving a file from disk the proxy asks
the core (`GET /hls-auth`, original URI in `X-Original-URI`, client IP in
`X-Forwarded-For`): nginx `auth_request` (`deploy/nginx-streamhub.conf`), Caddy
`forward_auth` (`deploy/Caddyfile`). `204` = serve, `403` = deny (the core answers the
403 itself, same JSON). The core judges the **normalized** path the proxy will serve, so
`/hls/pub/x/../../priv/r/s.ts` is judged as app `priv`. The 204 carries
`X-StreamHub-HLS-Scope: public|private`, from which the proxy picks the segment
`Cache-Control`. `auth_request` vs `secure_link`: `secure_link` needs the secret in the
nginx config (md5 only) and cannot know which apps are private; the subrequest keeps one
implementation, the per-app policy and geo in the core, at the cost of one bodiless
loopback request per segment (HMAC + a policy cached 3 s). Details and the upgrade note
for pre-3.4 nginx vhosts: [operations/SCALING.md](../operations/SCALING.md).

### Known limits

- **Workers pulling `/hls` over HTTP.** Built-in and co-located workers read the HLS
  directory from disk (unaffected). An *off-host* worker (a Studio App exported as a
  standalone bundle, or an edge-node worker that pulls the origin's `/hls` via
  `*_PUBLIC_BASE`) gets 403 for a private app — it would have to append a `?st=` (mint
  one with the sign endpoint). Not wired yet.
- **Edges/CDN and geo:** behind an HLS edge the origin sees the edge's IP, so `/hls`
  geo-blocking judges the edge, not the viewer (the token check is unaffected). Put geo
  rules on the edge/CDN, or rely on the token routes (which see the viewer).
- Changing `public_playback` / `geo` takes up to 3 s to reach `/hls` (policy cache).
- Rotating `STREAMHUB_JWT_SECRET` invalidates every issued HLS token and signed URL.

## Geo-blocking

```yaml
features:
  geo:
    allow: [AR, UY]   # only these countries (empty = no allowlist)
    deny: []          # always blocked, wins over allow
    publish: false    # also check RTMP publishes through the MediaMTX front
```

- Needs a local MaxMind **GeoLite2-Country** (or -City) base: `STREAMHUB_GEOIP_DB=/path/
  GeoLite2-Country.mmdb` (read with the pure-Go `oschwald/maxminddb-golang`,
  memory-mapped). Without it the feature is **off** — logged at boot, and once per app
  that configures `geo`. The base is not shipped (MaxMind licence); refresh it with
  `geoipupdate` and restart the core.
- Codes are ISO 3166-1 alpha-2, upper-cased; invalid entries are dropped. A network
  without a country uses its `registered_country`. With a non-empty `allow`, an IP the
  base does not know is **blocked** (fail closed); with only `deny` it passes.
  Loopback/private/link-local clients (LAN viewers, the proxies, the core's own workers)
  are never blocked.
- Applies to: `GET play-token`, `GET radio/…/listen-token`, `GET hls-token` → 403
  `playback is not available in your region`; `/hls` (and `/hls-auth`) → 403
  `{"error":{"code":"geo_blocked",…}}`.
- **Publish:** with `publish: true`, the RTMP publishes of the **passthrough** plane on
  the MediaMTX single-port front are checked against the publisher IP MediaMTX reports
  (`/internal/mediamtx/auth` → 401, MediaMTX drops the push). Limits: the LiveKit-plane
  path `live/<key>` does not name the app, so it is not geo-checked; WHIP (`:8080`) and a
  direct LiveKit ingress (`:1935` without the MediaMTX front) go straight to LiveKit and
  never touch the core — geo-block those at the firewall.

## Play-auth webhook

AntMedia's `webhookPlayAuthUrl`. Before every anonymous playback grant — public
play-token, listen-token, HLS token — the core asks your backend:

```yaml
features:
  play_auth:
    webhook_url: https://auth.example.com/streamhub/play
    timeout_ms: 3000   # default 3000, max 10000
    fail_open: false   # default: a failure/timeout DENIES
```

`POST <webhook_url>` with

```json
{"event":"play.authorize","app":"live","room":"ch1","mode":"viewer|listener|hls",
 "ip":"190.1.1.1","country":"AR","userAgent":"…","referer":"…","token":"<viewer ?token=>",
 "ts":"2026-10-29T12:00:00.000Z"}
```

headers `X-StreamHub-Event: play.authorize`, `X-StreamHub-Timestamp`, and — when the app
has `callbacks.secret` — `X-StreamHub-Signature: sha256=<hex HMAC of the raw body>` (same
scheme as the callbacks). **2xx grants**; anything else (including a 3xx: redirects are
never followed) denies with 403 `playback denied by the app's authorization webhook`.
Transport errors/timeouts deny unless `fail_open: true`. The URL is tenant-controlled:
the egress SSRF guard runs on every call (private/metadata targets refused;
`STREAMHUB_CALLBACK_ALLOW_HOSTS` exempts known-internal hosts, like callbacks).

`token` is the viewer's own credential: put `?token=<your session/ticket>` on the `/play`
or `/embed` URL (or pass it to `GET play-token|hls-token`) and the core forwards it
verbatim (capped at 2 KiB). The webhook gates the *grant*: once a viewer holds a LiveKit
token or an HLS `st`, it is valid for its lifetime. For a **public** app the webhook
gates the token routes, but `/hls` stays public — make the app private to gate HLS too.

## AntMedia TOTP (`enableTimeTokenForPlay` / `…ForPublish`, `timeTokenPeriod`) — pending

Evaluated for G2 and **not implemented**: in AntMedia the TOTP is per *subscriber*
(`subscriberId` + a base32 secret registered per stream via REST, the client sends a
6-digit `subscriberCode` that rotates every `timeTokenPeriod` s). Doing it properly
needs a subscriber registry per stream (table + CRUD routes + permissions), the code
passed by every player/SDK (the AMS shim in `streamhub-adaptor` ignores `subscriberCode`
today) and, for publish, a hook in a path the core does not own (WHIP and RTMP go
straight to LiveKit). What it buys — anti-sharing of links — StreamHub already covers
with short-TTL signed URLs (`?exp=&sig=`, 30 s–24 h) + the HLS token, and the play-auth
webhook covers per-viewer checks against the customer's own system. Kept in the
backlog; the RFC 6238 code is already in the tree (`internal/auth/totp.go`, used by 2FA)
if a customer needs it.
