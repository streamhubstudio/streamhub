# RTMP/SRT → HLS passthrough (remux, no transcode)

**Status:** shipped (env-gated OFF by default). **Module:** `streamhub-core-go/internal/passthrough`.

Match AntMedia's cheap ingest: accept an **H.264/AAC** RTMP **or SRT** push and
serve it as HLS by **remuxing** (`ffmpeg -c copy`), **bypassing LiveKit**
entirely. No re-encode ⇒ near-zero CPU and **no GPU**. This is the opposite
trade to the normal LiveKit ingress (WebRTC + sub-second latency + adaptive):
passthrough is dirt cheap and scales wide, but gives up everything that needs
the media to enter the SFU.

It is **additive and independent**: LiveKit's `:1935` ingress and the entire
transcode / WebRTC / egress path are untouched. Passthrough runs on its **own**
port pool (base `:1937`, RTMP and SRT share it) and is **OFF by default**.

> **MPEG-TS over UDP (multicast) too.** The same plane also ingests an **MPEG-TS
> transport stream over UDP** (unicast + multicast, incl. SSM) as a **PULL**
> source — `{inputType:'mpegts', mode:'passthrough', url:'udp://@GROUP:PORT'}`.
> It shares this enable switch and the same `-c copy` remux discipline, but has
> no listener/port (it connects OUT to the group). See
> [mpegts-multicast.md](mpegts-multicast.md).

> **Single public port?** The `:1937+` pool described here is the **multi-port**
> model. With `STREAMHUB_MEDIAMTX_ENABLE=true`, a MediaMTX front collapses both
> planes onto one public `:1935` (path `<app>/<key>` → this remux; path
> `live/<key>` → LiveKit) — the passthrough remux logic below is unchanged, it's
> just armed by MediaMTX hooks instead of an `ffmpeg -listen`. See
> [rtmp-single-port.md](rtmp-single-port.md). This page documents the default
> (MediaMTX-off) fallback.

## When to use it

- A source encoder already outputs **H.264 + AAC** (OBS, hardware encoders,
  cameras) and you only need HLS playback.
- You want to relay many RTMP/SRT → HLS channels cheaply (no per-channel CPU/GPU).
- The contribution link is lossy/long-haul and the encoder speaks **SRT**
  (retransmission + configurable latency budget beats RTMP-over-TCP there).

Do **not** use it when you need WebRTC/sub-second latency, adaptive bitrate,
recording/VOD, or room features (chat/reactions/viewer-count/moderation) — those
require the LiveKit path.

## How it works

```
encoder ──RTMP(H.264/AAC)──▶  ffmpeg -listen 1 -c copy ──▶  <DATA_DIR>/apps/<app>/hls/<room>/index.m3u8
        rtmp://host:1937/<app>/<key>                          (served at /hls/<app>/<room>/… — free)

encoder ──SRT(H.264/AAC)───▶  ffmpeg -i srt://0.0.0.0:<port>?mode=listener -c copy ──▶  same HLS dir
        srt://host:<port>?streamid=<key>                      (UDP; libsrt latency ~120 ms default)
```

- **Ingest front:** there is **no** LiveKit in this path. `ffmpeg` itself is the
  acceptor on the passthrough port (see the dependency note below): `-listen 1`
  for RTMP, the `srt://…?mode=listener` URL param for SRT (that param is
  libsrt's listen switch — `-listen 1` is RTMP-only). A listener is armed
  **only** for a registered passthrough key, so an unknown key finds no server
  (connection refused) and nothing is spawned — the key IS the capability (auth).
- **SRT specifics:** SRT URLs have no path, so the push URL carries the key as
  `?streamid=<key>`. ffmpeg's srt *listener* does not enforce a streamid match,
  so — exactly like RTMP — the real capability is the per-ingress port that only
  exists for a registered key; the `streamid` is kept for encoder
  compatibility/traceability. SRT adds a **configurable latency budget**
  (retransmission window) on top of HLS latency — libsrt's default ~120 ms —
  surfaced as `capabilities.latencyMs` in the API. Remember SRT is **UDP**: open
  the passthrough ports as UDP for SRT (TCP for RTMP).
- **Remux:** `ffmpeg -c copy -f hls -hls_time 4 -hls_list_size 6 -hls_flags
  delete_segments+append_list` writes a rolling live playlist + `.ts` segments
  (`RemuxManager` in `remux.go` + `remuxargs.go`).
- **Playback is FREE:** the output dir is exactly the one the `/hls` static mount
  (`internal/platform/web/static.go`)
  already serves under `/hls/<app>/<room>/…`, so the existing HLS/Vidstack player,
  samples and CDN caching all work with **zero** extra wiring.
- **Supervision:** `RemuxManager` owns the ffmpeg lifecycle (ring-buffer logs
  under source `remux:<ingressId>`, exit/crash tracking, HLS-dir cleanup on stop)
  and adds **crash-restart-while-publishing** — a non-zero exit while the ingress
  is still armed re-arms the listener with a capped backoff; a clean end-of-publish
  re-arms fast; an exit after teardown does not restart.

## Enable it

Server (`.env`), then rebuild/restart core:

```bash
STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on
STREAMHUB_RTMP_PASSTHROUGH_PORT=1937     # base port; NOT LiveKit's :1935
```

Open `:1937` (and successive ports for concurrent channels) to encoders in your
firewall/reverse-proxy, exactly like you expose `:1935`. SRT ingresses draw from
the **same** base port and gate (no extra env) but are **UDP** — open both
protocols if you use both transports.

## Configure an app for passthrough

Passthrough is **mutually exclusive** with any transcode/adaptive path.
`AppsService` enforces the invariant on every config patch, **both directions**:

- turning `rtmp.passthrough` **on** forces `rtmp.transcode`,
  `transcoding.enabled` and `webrtc.adaptive` **off**;
- turning any of those **on** forces `rtmp.passthrough` **off**.

Three ways to set it:

- **Preset:** `POST /apps/:app/presets/rtmp-passthrough/apply`.
- **Config patch:** `PATCH /apps/:app/config { "rtmpPassthrough": true }`.
- **Per-ingress:** the API `mode` below (defaults from `rtmp.passthrough`).

## API

`POST /apps/:app/ingress`

```jsonc
{ "inputType": "rtmp", "room": "ch1", "mode": "passthrough" }
// or an SRT push listener (SRT is passthrough-ONLY — see below):
{ "inputType": "srt", "room": "ch1", "mode": "passthrough" }
```

`mode` defaults to `passthrough` when the app's `rtmp.passthrough` is set, else
`transcode` (the unchanged LiveKit path). For `inputType:'srt'` the mode MUST be
`passthrough` — LiveKit's ingress API has no SRT input type (rtmp|whip|url), so
there is no transcode plane an SRT push could land on (anything else is a 400).
A passthrough create does **not** call `livekit.createIngress`; it mints a
`ptk_` key, arms the remux and returns:

```jsonc
{
  "data": {
    "mode": "passthrough",
    "ingressId": "pti_…",            // SRT ingresses: "pti_srt_…"
    "inputType": "rtmp",             // or "srt"
    "stream_key": "ptk_…",
    "rtmp_url": "rtmp://<RTMP_PUBLIC_HOST>:1937/<app>/<key>",  // rtmp only
    // srt only (rtmp_url absent): push URL — no path, key rides in streamid
    // "srt_url": "srt://<RTMP_PUBLIC_HOST>:<port>?streamid=<key>",
    "hls_url": "/hls/<app>/<room>/index.m3u8",
    "player_url": "/play/<app>/<room>",
    "capabilities": { /* what is LOST — see below; + latencyMs for srt */ }
  }
}
```

`400` if `mode:passthrough` is combined with `enableTranscoding`, a backup key,
audio-only, or a `whip`/`url` input (don't mix planes); also `400` for
`inputType:'srt'` without `mode:'passthrough'`. `503` if the feature is
disabled server-side.

> **Pulling a remote SRT source instead** (the transcode/LiveKit path): use
> `{ "inputType": "url", "url": "srt://source-host:port" }` — LiveKit's URL
> ingress PULLS the source (GStreamer `srtsrc`, caller mode) and transcodes it
> like any rtsp/http pull. The srt:// url passes the same anti-SSRF guard
> (private/loopback/link-local/metadata hosts are 400). CAVEAT: srt:// support
> in URL ingress depends on the LiveKit ingress service version/build (its
> GStreamer needs `srtsrc`); an unsupported server rejects the create, which
> surfaces through the normal `createIngress` error path — nothing hangs.

- `GET /apps/:app/ingress` merges passthrough rows (with live remux status +
  playlist freshness) alongside the LiveKit ingresses.
- `DELETE /apps/:app/ingress/:id` — a `pti_` id stops the remux, cleans the HLS
  dir and drops the key; it never calls `livekit.deleteIngress`.

### Capabilities — what passthrough GIVES UP

The create/list response carries a `capabilities` block so the dashboard can warn
before the operator commits. All OFF because the media never enters LiveKit:

| lost | why |
|---|---|
| WebRTC / sub-second latency | HLS only (~2 segments of latency) |
| adaptive bitrate (ABR) | a single passthrough rendition |
| transcode safety net | the source **must** be H.264/AAC |
| egress recording / VOD | no LiveKit egress |
| room features | no viewer-count / chat / reactions / moderation / snapshots / track plugins |
| backup key, GPU | not applicable to a remux |

SRT ingresses additionally carry `capabilities.latencyMs` (default `120`) — not
a lost capability but a heads-up: SRT trades a configurable receive-latency
budget (retransmission window, encoder-tunable) for loss resilience.

## Playback surfaces

A passthrough channel has **no LiveKit room**, so the WebRTC surfaces would show
an empty stage. Every viewer-facing surface now routes it to its HLS instead
(see [players.md](players.md) for the probe/selection details):

- **Public `/play/<app>/<room>` + `/embed/<app>/<room>`** probe the public
  playlist once on mount (`HEAD /hls/<app>/<room>/index.m3u8`); when it exists
  and is fresh they render `<HlsPlayer access="public">` — which also resolves
  the app's Vidstack/player provider anonymously. `/play` keeps a WebRTC | HLS
  toggle for rooms that have both planes.
- **Dashboard → En vivo tab:** passthrough rows (participant `passthrough`,
  streamId `<room>/passthrough`) open **Ver** / **Ver (HLS)** directly on the
  existing playlist — the tab never calls the LiveKit HLS-egress start/stop for
  them (there is no room), and record/restream/moderation are not offered.
- **Compartir menu (per stream row):** copies the `/play` player URL, the
  `/embed` `<iframe>` snippet, the public `.m3u8` URL and a self-contained
  video.js embed — all work for passthrough since they are plain HLS.

## Dependency decision — why no `node-media-server`

The design allowed a pure-JS RTMP server (`node-media-server`) as the protocol
front. It was evaluated and **rejected**:

- `npm audit --omit=dev` on `node-media-server@4` reports **0 vulnerabilities**
  and it is pure JS (no native deps) — so it would pass the `sca:npm` gate.
- **But** v4 is a full media server (it always starts its own HTTP + record +
  notify servers and pulls ~88 transitive packages incl. `express`,
  `express-jwt`, `jsonwebtoken`), i.e. "heavy" per the design's disqualifier, and
- its `prePublish` event **cannot reject** a publish (auth in v4 is JWT-signed-URL
  only), so the design's "prePublish → findByStreamKey accept/reject before
  ffmpeg" hook does not exist.

So we use the **documented fallback**: `ffmpeg -listen 1` is the RTMP acceptor and
`RemuxManager` owns it. **Zero** new dependencies (the `sca:npm` gate stays green
by construction).

### Tradeoffs of the ffmpeg-listen fallback

- **No single shared port with per-connection auth.** Each active passthrough
  ingress binds its own port (base = `STREAMHUB_RTMP_PASSTHROUGH_PORT`, then the
  next free port; RTMP and SRT share the pool). The auth model is "only a
  registered key has a listener", not a central prePublish check on one port.
- **No in-band password** — the `ptk_` key (URL path for RTMP, `streamid` for
  SRT) is the secret; ffmpeg's srt listener does not verify the streamid, so for
  SRT the per-ingress port is the enforcing half of the capability.
- `-listen 1` (RTMP) / `mode=listener` (SRT) accepts one session; `RemuxManager`
  re-arms after a clean end-of-publish so the channel stays available for
  reconnects.
- Boot re-arm is best-effort across apps (`PassthroughRtmpServer`), so listeners
  survive a core restart.

## Tests

Pure/unit, no network/RTMP/SRT (`streamhub-core-go`):
`internal/passthrough` — `remux_test.go` (incl. the exact SRT-listener argv),
`service_test.go` (incl. SRT create/re-arm), `vectors_test.go`, `hooks_test.go`;
`internal/livekit` — the SRT controller branch, srt-requires-passthrough
validation, the passthrough RTMP/SRT URL builders and the srt:// pull cases. See
[testing/UNIT-TESTS.md](../testing/UNIT-TESTS.md).
